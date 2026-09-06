import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryRuntimeIdentity, hashFactoryRuntimeFile, readFactoryRuntime } from "../runtime.js";
import type { ActionRecord, AttemptRecord, CompletionReceipt, FactoryStatus, SlotSpec } from "../types.js";
import type { OneironManifest, OneironReceipt, OneironRuntime, OneironSource } from "./oneiron.js";
import { type ForegroundCapture, ForegroundCaptureError } from "./oneiron-capture.js";
import {
	inspectOneironInterlock,
	type OneironInterlockProof,
	oneironInterlockPrefix,
	validateOneironInterlockProof,
} from "./oneiron-interlock.js";
import { type OneironPin, oneironSha } from "./oneiron-review.js";
import type { OneironWriterStatus } from "./oneiron-writer.js";

export const ONEIRON_GATE_LIMITS = Object.freeze({
	streamBytes: 16 * 1024 * 1024,
	maxDocsCommands: 2,
	rawBytes: 64 * 1024 * 1024,
	summaryBytes: 65536,
	proofBytes: 262144,
	previewBytes: 4096,
});
export const ONEIRON_GATE_CAPABILITIES = Object.freeze({
	capture: "oneiron-native-gate-capture-v1",
	cargo: "oneiron-cargo-nextest-doc-v1",
	docs: "oneiron-bun-docs-gate-v1",
});
export interface OneironDocsGateStage {
	kind: "gate";
	driver: "bun-docs-v1";
	interlock: OneironPin;
	host: "arch" | "macbook" | "mini";
	slot: number;
	capacity: OneironPin;
	toolchain: OneironPin;
	generation: OneironPin;
	profile: "build-links-v1";
	linkPolicy: "blocking-only";
}
interface NativeTool {
	requestedPath: string;
	realpath: string;
	sha256: string;
	version: string;
}
export interface OneironDocsToolchain {
	version: 1;
	host: string;
	platform: string;
	arch: string;
	interlock: OneironPin;
	bun: NativeTool;
	node: NativeTool;
	packages: OneironPin[];
	lockfile: OneironPin & { format: "bun.lock" | "bun.lockb" };
	dependencies: { root: string; contentSha256: string; preparation: OneironPin; astro: OneironPin };
	environment: Record<string, string>;
}
interface OperatorEvidence {
	host: string;
	slotId: string;
	environment: { launcher: OneironPin; values: Record<string, string> };
	manifest: OneironPin;
	status: OneironPin;
	stdout: OneironPin;
	stderr: OneironPin;
}
/** Root's separate actual operator run; output fingerprint is not the later signed source fingerprint. */
export interface OneironDocsGeneration {
	version: 1;
	kind: "oneiron-docs-generation-v1";
	input: OneironSource;
	output: OneironSource;
	toolchain: OneironPin;
	command: { argv: string[]; cwd: string };
	terminal: OneironPin;
	operator: OperatorEvidence;
	inputs: OneironPin[];
	generatedContentSha256: string;
}
export interface OneironGateStatus extends OneironWriterStatus {
	slots?: SlotSpec[];
	tickets?: FactoryStatus["tickets"];
}
type Read = (pin: OneironPin, limit?: number, field?: string) => string;
type Plan = ReturnType<typeof oneironDocsPlan>;
interface DocsCoverage {
	build: true;
	links: true;
	builtPages: number;
	builtContentSha256: string;
	generatedPages: number;
	generatedMarkdown: number;
	specs: number;
	linksScanned: number;
	astroFiles: number;
	astroHrefs: number;
	warnings: string[];
	skips: unknown[];
	limitations: string[];
}
interface DocsProof {
	version: 1;
	driver: "bun-docs-v1";
	profile: "build-links-v1";
	linkPolicy: "blocking-only";
	attemptId: string;
	manifest: OneironPin;
	manifestSha256: string;
	stageSha256: string;
	runtime: OneironPin;
	input: OneironSource;
	output: OneironSource;
	capacity: OneironPin;
	toolchain: OneironPin;
	generation: OneironPin;
	planSha256: string;
	commands: ForegroundCapture[];
	probes: ForegroundCapture[];
	interlock: OneironInterlockProof;
	interlockEvidence: OneironPin;
	coverage: DocsCoverage;
	checks: Record<string, true>;
	limits: typeof ONEIRON_GATE_LIMITS;
	status: "PASS";
}
function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function equal(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function sameSource(a: OneironSource, b: OneironSource): boolean {
	return ["workspace", "head", "tree", "branch", "remoteUrl", "fingerprint"].every(
		(key) => a?.[key as keyof OneironSource] === b?.[key as keyof OneironSource],
	);
}
function jsonFile(path: string) {
	regular(path);
	check(statSync(path).size <= 16 * 1024 * 1024, "Gate JSON input exceeds 16 MiB input limit");
	const bytes = readFileSync(path);
	check(bytes.length <= 16 * 1024 * 1024, "Gate JSON input grew beyond limit");
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function pin(path: string): OneironPin {
	return { path, sha256: hashFactoryRuntimeFile(path) };
}
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function regular(path: string): void {
	check(
		isAbsolute(path) && realpathSync(path) === path && lstatSync(path).isFile(),
		`Expected canonical regular file: ${path}`,
	);
}
/** Stable content identity, including symlink text and target bytes. No external or cyclic dependency aliases. */
export function oneironGateTree(root: string): { sha256: string; files: number; paths: string[] } {
	check(realpathSync(root) === root && lstatSync(root).isDirectory(), "Gate tree must be a canonical directory");
	const records: string[][] = [],
		paths: string[] = [];
	let entriesSeen = 0;
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(directory, entry.name),
				rel = relative(root, path);
			check(++entriesSeen <= 250000 && rel.length < 4096, "Gate tree exceeds bounded inventory");
			if (entry.isDirectory()) walk(path);
			else if (entry.isSymbolicLink()) {
				const target = realpathSync(path);
				check(
					inside(root, target) && statSync(target).isFile(),
					"Gate tree has external/directory dependency alias",
				);
				records.push([rel, "link", readlinkSync(path), hashFactoryRuntimeFile(target)]);
				paths.push(path);
			} else {
				check(entry.isFile(), "Gate tree has nonregular input");
				records.push([rel, "file", String(statSync(path).mode & 0o777), hashFactoryRuntimeFile(path)]);
				paths.push(path);
			}
		}
	};
	walk(root);
	check(records.length > 0, "Gate tree is empty");
	return { sha256: oneironSha(JSON.stringify(records)), files: records.length, paths };
}
export function inspectOneironDocsStage(stage: OneironDocsGateStage): void {
	check(
		equal(
			Object.keys(stage).sort(),
			[
				"kind",
				"driver",
				"interlock",
				"host",
				"slot",
				"capacity",
				"toolchain",
				"generation",
				"profile",
				"linkPolicy",
			].sort(),
		) &&
			stage.driver === "bun-docs-v1" &&
			stage.profile === "build-links-v1" &&
			stage.linkPolicy === "blocking-only",
		"Only typed bun-docs-v1 build-links-v1 blocking-only is admitted; no argv/environment/install/export override",
	);
	oneironInterlockPrefix(stage);
}
export function requireOneironGateRuntime(
	runtime: FactoryRuntimeIdentity | undefined,
	docs: boolean,
	extendedCargo: boolean,
	native: boolean,
): void {
	check(
		runtime && runtime.capabilities.includes(ONEIRON_GATE_CAPABILITIES.capture),
		`Gate launch requires runtime capability ${ONEIRON_GATE_CAPABILITIES.capture}`,
	);
	if (docs)
		check(
			runtime.capabilities.includes(ONEIRON_GATE_CAPABILITIES.docs),
			`Gate launch requires runtime capability ${ONEIRON_GATE_CAPABILITIES.docs}`,
		);
	if (extendedCargo)
		check(
			runtime.capabilities.includes(ONEIRON_GATE_CAPABILITIES.cargo),
			`Gate launch requires runtime capability ${ONEIRON_GATE_CAPABILITIES.cargo}`,
		);
	if (native) {
		for (const name of [
			"./oneiron.js",
			"./oneiron-capture.js",
			"./oneiron-writer.js",
			"./oneiron-docs-gate.js",
			"./oneiron-interlock.js",
			"./oneiron-entry.js",
		]) {
			const path = fileURLToPath(
				new URL(import.meta.url.endsWith(".ts") ? name.replace(/\.js$/, ".ts") : name, import.meta.url),
			);
			check(
				runtime.files.some((p) => p.path === path && p.sha256 === hashFactoryRuntimeFile(path)),
				"Gate runtime omitted actual gate/capture implementation bytes",
			);
		}
	}
}
export const ONEIRON_DOCS_ENTRY_ENVIRONMENT = Object.freeze({
	NODE_OPTIONS: "",
	NODE_PATH: "",
	LD_PRELOAD: "",
	LD_AUDIT: "",
	LD_LIBRARY_PATH: "",
	GLIBC_TUNABLES: "",
	DYLD_INSERT_LIBRARIES: "",
	DYLD_LIBRARY_PATH: "",
});
export function oneironDocsEntry(runtime: FactoryRuntimeIdentity): string[] {
	const entries = runtime.files.filter((file) => file.path.endsWith("/factory/adapters/oneiron-entry.js"));
	check(entries.length === 1, "Docs needs exactly one approved native oneiron-entry.js runtime pin");
	return [runtime.cliArgv[0], entries[0]!.path];
}
function readPlanPin(pin: OneironPin): string {
	regular(pin.path);
	const bytes = readFileSync(pin.path);
	check(bytes.length <= 16 * 1024 * 1024 && oneironSha(bytes) === pin.sha256, "Docs plan runtime pin changed");
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function oneironDocsPlan(m: OneironManifest, stage: OneironDocsGateStage, tools: OneironDocsToolchain) {
	const environment = {
		PATH: [...new Set([dirname(tools.bun.realpath), dirname(tools.node.realpath)])].join(":"),
		HOME: join(m.outputDirectory, "home"),
		TMPDIR: join(m.outputDirectory, "tmp"),
		CI: "1",
		NO_COLOR: "1",
		ASTRO_TELEMETRY_DISABLED: "1",
		STRICT_SMELLS: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
	const commands = [
		{ argv: [tools.bun.realpath, "run", "build"], cwd: join(m.source.workspace, "site"), environment },
		{ argv: [tools.bun.realpath, "run", "check:links"], cwd: m.source.workspace, environment },
	];
	const identity = {
		runtime: m.factoryRuntime,
		entryArgv: oneironDocsEntry(readFactoryRuntime(m.factoryRuntime!, readPlanPin)),
		entryEnvironment: ONEIRON_DOCS_ENTRY_ENVIRONMENT,
		entryTimeoutMs: 3600000,
		interlock: stage.interlock,
		launchPrefix: oneironInterlockPrefix(stage),
		driver: stage.driver,
		profile: stage.profile,
		linkPolicy: stage.linkPolicy,
		source: m.source,
		toolchain: stage.toolchain,
		generation: stage.generation,
		commands,
	};
	return { ...identity, planSha256: oneironSha(JSON.stringify(identity)) };
}
function validateDocsCommand(
	m: OneironManifest,
	manifest: OneironPin,
	action: ActionRecord,
	attempt: AttemptRecord,
	state: OneironGateStatus | FactoryStatus,
	read: Read,
): void {
	check(m.stage.kind === "gate" && m.stage.driver === "bun-docs-v1", "Native command needs typed docs stage");
	const stage = m.stage;
	const expected = [
		...oneironInterlockPrefix(stage),
		...oneironDocsEntry(readFactoryRuntime(m.factoryRuntime!, read)),
		"execute",
		manifest.path,
		action.command.argv.at(-3)!,
		manifest.sha256,
		"--execute",
	];
	check(
		action.kind === "decision" &&
			action.command.cwd === m.source.workspace &&
			action.sourceFingerprint === m.source.fingerprint &&
			action.ticketId === m.ticketId &&
			equal(action.command.argv, expected) &&
			equal(action.command.env, ONEIRON_DOCS_ENTRY_ENVIRONMENT) &&
			action.command.timeoutMs === 3600000 &&
			equal(Object.keys(action.command).sort(), ["argv", "cwd", "env", "timeoutMs"]) &&
			action.requirements.host === stage.host &&
			action.requirements.slotId === attempt.slotId &&
			state.slots?.some((slot) => slot.id === attempt.slotId && slot.host === stage.host),
		"Docs command is not the exact pinned native entry/environment/host/slot",
	);
}
export function validateOneironGateAttempt(
	m: OneironManifest,
	manifestSha256: string,
	state: OneironGateStatus | FactoryStatus,
	attemptId: string | undefined,
): string {
	check(m.stage.kind === "gate", "Gate ownership requires gate stage");
	const host = m.stage.host;
	const attempt = state.attempts?.find((a) => a.id === attemptId),
		action = state.actions?.find((a) => a.id === attempt?.actionId);
	const slot = state.slots?.find((s) => s.id === attempt?.slotId);
	check(
		attempt &&
			["SUBMITTED", "RUNNING"].includes(attempt.state) &&
			!attempt.claimReleased &&
			attempt.receipt === null &&
			attempt.uncertainty === null &&
			action?.state === "RUNNING" &&
			action.kind === "decision" &&
			action.ticketId === m.ticketId &&
			action.sourceFingerprint === m.source.fingerprint &&
			action.command.cwd === m.source.workspace &&
			action.command.argv.at(-5) === "execute" &&
			action.command.argv.at(-1) === "--execute" &&
			action.command.argv.at(-2) === manifestSha256 &&
			action.requirements.slotId === attempt.slotId &&
			action.requirements.host === m.stage.host &&
			slot?.host === m.stage.host &&
			state.attempts?.filter((a) => a.actionId === action.id).at(-1)?.id === attempt.id,
		"Gate requires its current owned runner attempt/action/slot/source",
	);
	if (m.stage.driver === "bun-docs-v1")
		validateDocsCommand(
			m,
			{ path: action.command.argv.at(-4)!, sha256: manifestSha256 },
			action,
			attempt,
			state,
			readPlanPin,
		);
	check(
		equal(JSON.parse(readFileSync(action.command.argv.at(-4)!, "utf8")), m),
		"Gate executing manifest path mismatch",
	);
	check(
		state.tickets?.some((t) => t.id === m.ticketId && t.owner === m.owner && t.state === "ACTIVE"),
		"Gate ticket custody is no longer active",
	);
	check(
		state.attempts?.every((a) => {
			if (a.id === attempt.id || a.claimReleased) return true;
			const other = state.actions?.find((item) => item.id === a.actionId);
			return (
				a.slotId !== attempt.slotId &&
				other?.ticketId !== m.ticketId &&
				!(other?.command.cwd === m.source.workspace && other.requirements.host === host)
			);
		}),
		"Another attempt holds gate process custody",
	);
	return attempt.id;
}
function checkInheritedEnvironment(): void {
	for (const [key, value] of Object.entries(process.env))
		if (
			value &&
			/^(NODE_OPTIONS|NODE_PATH|BUN_.*|SKIP_BUILD|STRICT_SMELLS|LD_.*|DYLD_.*|ENV|BASH_ENV|SHELLOPTS|CDPATH|npm_config_.*)$/i.test(
				key,
			)
		)
			throw new Error(`Unapproved inherited gate environment: ${key}`);
}
function nativeBinary(path: string, sha256: string, name: string, tools: OneironDocsToolchain): void {
	regular(path);
	check(
		(statSync(path).mode & 0o111) !== 0 && hashFactoryRuntimeFile(path) === sha256,
		`Native ${name} bytes changed`,
	);
	const bytes = Buffer.alloc(32);
	const fd = openSync(path, "r");
	try {
		check(readSync(fd, bytes) === bytes.length, "Truncated native executable header");
	} finally {
		closeSync(fd);
	}
	const elf = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
	const mach = bytes.length >= 12 && bytes.readUInt32LE(0) === 0xfeedfacf;
	check(
		(tools.platform === "linux" &&
			elf &&
			bytes[4] === 2 &&
			bytes[5] === 1 &&
			bytes.readUInt16LE(18) === (tools.arch === "x64" ? 62 : 183)) ||
			(tools.platform === "darwin" &&
				mach &&
				bytes.readUInt32LE(4) === (tools.arch === "arm64" ? 0x100000c : 0x1000007)),
		`Expected platform-native ${name}, not a script shim`,
	);
}
function nativeTool(tool: NativeTool, name: "bun" | "node", tools: OneironDocsToolchain): void {
	check(
		isAbsolute(tool.requestedPath) &&
			realpathSync(tool.requestedPath) === tool.realpath &&
			basename(tool.realpath) === name,
		`Pinned native ${name} path mismatch`,
	);
	nativeBinary(tool.realpath, tool.sha256, name, tools);
	check(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(tool.version.replace(/^v/, "")), `Invalid pinned ${name} version`);
	if (name === "node") {
		const [major, minor] = tool.version.replace(/^v/, "").split(".").map(Number);
		check(major! > 22 || (major === 22 && minor! >= 12), "Docs Node must satisfy >=22.12.0");
	}
}
function validateOperator(
	evidence: OperatorEvidence,
	terminalPin: OneironPin,
	command: { argv: string[]; cwd: string },
	sourceFingerprint: string,
	outputFingerprint: string,
	read: Read,
	tools: OneironDocsToolchain,
	workspace: string,
): void {
	check(
		evidence.environment?.launcher.path === "/usr/bin/env",
		"Operator requires pinned native environment replacement launcher",
	);
	nativeBinary(evidence.environment.launcher.path, evidence.environment.launcher.sha256, "env", tools);
	const values = evidence.environment.values;
	const cache = command.argv[1] === "install" ? ["BUN_INSTALL_CACHE_DIR"] : [];
	check(
		equal(
			Object.keys(values).sort(),
			[
				"PATH",
				"HOME",
				"TMPDIR",
				"CI",
				"NO_COLOR",
				"ASTRO_TELEMETRY_DISABLED",
				"GIT_OPTIONAL_LOCKS",
				...cache,
			].sort(),
		) &&
			values.PATH === [...new Set([dirname(tools.bun.realpath), dirname(tools.node.realpath)])].join(":") &&
			values.CI === "1" &&
			values.NO_COLOR === "1" &&
			values.ASTRO_TELEMETRY_DISABLED === "1" &&
			values.GIT_OPTIONAL_LOCKS === "0",
		"Operator effective environment is not the controlled native toolchain",
	);
	for (const key of ["HOME", "TMPDIR", ...cache])
		check(
			isAbsolute(values[key]!) && !inside(workspace, values[key]!) && values[key] !== workspace,
			"Operator mutable home/tmp/cache must be outside product",
		);
	for (const home of [values.HOME!, join(values.HOME!, ".config")])
		if (existsSync(home))
			check(
				!readdirSync(home).some((name) => /^\.env(?:\.|$)|^\.?bunfig\.toml$/.test(name)),
				"Operator home startup/config is unpinned",
			);
	const argv = [
		evidence.environment.launcher.path,
		"--ignore-environment",
		...Object.entries(values)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => `${key}=${value}`),
		...command.argv,
	];
	const manifest = JSON.parse(read(evidence.manifest));
	const terminal = JSON.parse(read(terminalPin)) as CompletionReceipt;
	const status = JSON.parse(read(evidence.status)) as FactoryStatus;
	const attempt = status.attempts.find((a) => a.id === manifest.attemptId),
		action = status.actions.find((a) => a.id === attempt?.actionId);
	check(
		manifest.version === 1 &&
			equal(manifest.command?.argv, argv) &&
			equal(manifest.command?.env, ONEIRON_DOCS_ENTRY_ENVIRONMENT) &&
			manifest.command?.cwd === command.cwd &&
			manifest.sourceFingerprint === sourceFingerprint &&
			manifest.attemptId === terminal.attemptId &&
			terminal.sourceFingerprint === sourceFingerprint &&
			terminal.artifact?.sourceFingerprint === outputFingerprint &&
			terminal.exitCode === 0 &&
			Number.isFinite(Date.parse(terminal.finishedAt)) &&
			attempt?.state === "TERMINAL" &&
			attempt.claimReleased &&
			attempt.uncertainty === null &&
			equal(attempt.receipt, terminal) &&
			action &&
			["ACCEPTED", "AWAITING_DECISION"].includes(action.state) &&
			equal(action.command, manifest.command) &&
			action.sourceFingerprint === sourceFingerprint &&
			evidence.host === tools.host &&
			action.requirements.host === evidence.host &&
			action.requirements.slotId === evidence.slotId &&
			attempt.slotId === evidence.slotId &&
			status.slots.some((slot) => slot.id === evidence.slotId && slot.host === evidence.host) &&
			status.attempts.filter((a) => a.actionId === action.id).at(-1)?.id === attempt.id,
		"Operator proof requires actual exact-command manifest/current successful native terminal, not a generic receipt",
	);
	const root = dirname(evidence.manifest.path);
	check(
		basename(root) === attempt.id &&
			basename(evidence.manifest.path) === "manifest.json" &&
			terminalPin.path === join(root, "terminal.json") &&
			evidence.stdout.path === join(root, "stdout.log") &&
			evidence.stderr.path === join(root, "stderr.log"),
		"Operator logs/manifest/terminal must share the real runner attempt directory",
	);
	for (const stream of [evidence.stdout, evidence.stderr]) {
		regular(stream.path);
		check(hashFactoryRuntimeFile(stream.path) === stream.sha256, "Operator retained log changed");
	}
}
const EXPORT_SCRIPT =
	"cd site && bun run build && cd .. && node scripts/export-agent-md.mjs && node scripts/emit-spec-manifest.mjs && node scripts/check-doc-links.mjs";
function validateTools(
	m: OneironManifest,
	stage: OneironDocsGateStage,
	tools: OneironDocsToolchain,
	plan: Plan,
	read: Read,
): void {
	checkInheritedEnvironment();
	check(equal(tools.interlock, stage.interlock), "Toolchain interlock differs from native plan");
	check(
		tools.version === 1 &&
			tools.host === stage.host &&
			tools.platform === process.platform &&
			tools.arch === process.arch &&
			["x64", "arm64"].includes(tools.arch),
		"Toolchain host/platform/arch mismatch",
	);
	nativeTool(tools.bun, "bun", tools);
	nativeTool(tools.node, "node", tools);
	check(
		equal(tools.environment, plan.commands[0]!.environment),
		"Toolchain effective environment differs from controlled plan",
	);
	for (const name of ["bun", "node"] as const) {
		const found = plan.commands[0]!.environment.PATH.split(":")
			.map((dir) => join(dir, name))
			.find(existsSync);
		check(found && realpathSync(found) === tools[name].realpath, `Controlled PATH resolves unpinned ${name}`);
	}
	for (const dir of [m.source.workspace, join(m.source.workspace, "site"), plan.commands[0]!.environment.HOME]) {
		if (!existsSync(dir)) continue;
		check(
			!readdirSync(dir).some((name) => /^\.env(?:\.|$)|^\.?bunfig\.toml$/.test(name)),
			"Unapproved Bun startup/config file",
		);
	}
	const packagePaths = [join(m.source.workspace, "package.json"), join(m.source.workspace, "site/package.json")];
	check(
		tools.packages.length === 2 && equal(tools.packages.map((p) => p.path).sort(), [...packagePaths].sort()),
		"Exact root/site package pins required",
	);
	for (const pkg of tools.packages) {
		regular(pkg.path);
		read(pkg);
	}
	const root = jsonFile(packagePaths[0]!),
		site = jsonFile(packagePaths[1]!);
	check(
		root.scripts?.["check:links"] === "node scripts/check-doc-links.mjs" &&
			root.scripts?.["export:agent"] === EXPORT_SCRIPT &&
			site.scripts?.build === "astro build" &&
			site.engines?.node === ">=22.12.0",
		"Pinned package script bodies/Node contract changed",
	);
	check(
		!["prebuild", "postbuild", "precheck:links", "postcheck:links"].some(
			(key) => root.scripts?.[key] || site.scripts?.[key],
		),
		"Gate script hooks cannot substitute commands",
	);
	const lock = tools.lockfile;
	check(
		["bun.lock", "bun.lockb"].includes(lock.format) &&
			basename(lock.path) === lock.format &&
			[m.source.workspace, join(m.source.workspace, "site")].includes(dirname(lock.path)),
		"Actual Bun lock path/format required",
	);
	regular(lock.path);
	check(
		statSync(lock.path).size > 0 && hashFactoryRuntimeFile(lock.path) === lock.sha256,
		"Actual lock bytes changed",
	);
	check(
		!existsSync(join(dirname(lock.path), lock.format === "bun.lock" ? "bun.lockb" : "bun.lock")),
		"Ambiguous Bun locks",
	);
	// Bun prepends .bin directories while running scripts. A hashed dependency may not replace Node/Bun.
	let ancestor = join(m.source.workspace, "site");
	while (true) {
		for (const name of ["node", "bun"])
			check(
				!existsSync(join(ancestor, "node_modules/.bin", name)),
				"Bun-added dependency bin shadows pinned native tool",
			);
		if (ancestor !== join(m.source.workspace, "site") && ancestor !== m.source.workspace)
			check(
				!existsSync(join(ancestor, "node_modules")),
				"Ancestor dependencies could shadow the sealed site install",
			);
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	const deps = tools.dependencies;
	check(
		deps.root === join(m.source.workspace, "site/node_modules"),
		"Docs dependencies must be the real site node_modules",
	);
	check(!existsSync(join(m.source.workspace, "node_modules")), "Unknown root dependency shadowing");
	check(oneironGateTree(deps.root).sha256 === deps.contentSha256, "Installed dependency content changed");
	regular(deps.astro.path);
	const astroPackage = jsonFile(join(deps.root, "astro/package.json"));
	const astroBin = typeof astroPackage.bin === "string" ? astroPackage.bin : astroPackage.bin?.astro;
	check(
		astroPackage.name === "astro" &&
			typeof astroBin === "string" &&
			inside(join(deps.root, "astro"), join(deps.root, "astro", astroBin)),
		"Actual Astro package executable required",
	);
	check(
		deps.astro.path === join(deps.root, "astro", astroBin) &&
			hashFactoryRuntimeFile(deps.astro.path) === deps.astro.sha256 &&
			realpathSync(join(deps.root, ".bin/astro")) === deps.astro.path,
		"Actual Astro executable target changed",
	);
	const preparation = JSON.parse(read(deps.preparation));
	check(
		preparation.version === 1 &&
			preparation.kind === "oneiron-bun-frozen-install-v1" &&
			preparation.host === stage.host &&
			equal(preparation.bun, tools.bun) &&
			equal(preparation.node, tools.node) &&
			equal(preparation.packages, tools.packages) &&
			equal(preparation.lockfile, lock) &&
			preparation.dependenciesRoot === deps.root &&
			preparation.contentSha256 === deps.contentSha256 &&
			[[], ["--ignore-scripts"]].some((flags) =>
				equal(preparation.command, {
					argv: [tools.bun.realpath, "install", "--frozen-lockfile", ...flags],
					cwd: dirname(lock.path),
				}),
			),
		"Real frozen-lockfile preparation identity required; install never runs in gate",
	);
	const terminal = JSON.parse(read(preparation.terminal)) as CompletionReceipt;
	check(
		terminal.exitCode === 0 &&
			terminal.attemptId === preparation.attemptId &&
			terminal.sourceFingerprint === preparation.sourceFingerprint &&
			terminal.artifact &&
			Number.isFinite(Date.parse(terminal.finishedAt)),
		"Dependency preparation lacks successful native operator terminal",
	);
	validateOperator(
		preparation.operator,
		preparation.terminal,
		preparation.command,
		preparation.sourceFingerprint,
		preparation.sourceFingerprint,
		read,
		tools,
		m.source.workspace,
	);
}
function readGeneration(m: OneironManifest, stage: OneironDocsGateStage, tools: OneironDocsToolchain, read: Read) {
	const generation = JSON.parse(read(stage.generation)) as OneironDocsGeneration;
	check(
		generation.version === 1 &&
			generation.kind === "oneiron-docs-generation-v1" &&
			equal(generation.toolchain, stage.toolchain) &&
			generation.input.workspace === m.source.workspace &&
			generation.output.workspace === m.source.workspace &&
			generation.input.branch === m.source.branch &&
			generation.output.branch === m.source.branch &&
			generation.input.remoteUrl === m.source.remoteUrl &&
			generation.output.remoteUrl === m.source.remoteUrl &&
			equal(generation.command, { argv: [tools.bun.realpath, "run", "export:agent"], cwd: m.source.workspace }),
		"Generation must be a separate actual full export operator with original source lineage",
	);
	const terminal = JSON.parse(read(generation.terminal)) as CompletionReceipt;
	check(
		terminal.exitCode === 0 &&
			terminal.sourceFingerprint === generation.input.fingerprint &&
			terminal.artifact?.sourceFingerprint === generation.output.fingerprint &&
			terminal.attemptId &&
			Number.isFinite(Date.parse(terminal.finishedAt)),
		"Generation terminal/source lineage mismatch",
	);
	check(
		generation.input.head === generation.output.head &&
			generation.input.tree === generation.output.tree &&
			/^[a-f0-9]{40}$/.test(generation.input.head) &&
			/^[a-f0-9]{40}$/.test(generation.input.tree) &&
			/^git:[a-f0-9]{64}$/.test(generation.input.fingerprint) &&
			/^git:[a-f0-9]{64}$/.test(generation.output.fingerprint),
		"Generation must preserve original uncommitted operator lineage separately from signed source",
	);
	validateOperator(
		generation.operator,
		generation.terminal,
		generation.command,
		generation.input.fingerprint,
		generation.output.fingerprint,
		read,
		tools,
		m.source.workspace,
	);
	return generation;
}
async function generated(
	m: OneironManifest,
	stage: OneironDocsGateStage,
	tools: OneironDocsToolchain,
	runtime: OneironRuntime,
	read: Read,
) {
	const generation = readGeneration(m, stage, tools, read);
	const tracked = (
		await runtime.run(["git", "--no-replace-objects", "ls-files", "--cached", "-z"], m.source.workspace)
	)
		.split("\0")
		.filter(Boolean)
		.filter((path) => !path.startsWith("generated/"));
	check(
		tracked.length > 0 &&
			new Set(generation.inputs.map((p) => p.path)).size === generation.inputs.length &&
			equal(
				generation.inputs.map((p) => p.path).sort(),
				tracked.map((path) => join(m.source.workspace, path)).sort(),
			),
		"Generation must cover all tracked canonical/shared inputs, not per-page hashes only",
	);
	return generatedContent(m, generation);
}
function generatedContent(m: OneironManifest, generation: OneironDocsGeneration) {
	for (const input of generation.inputs) {
		regular(input.path);
		check(hashFactoryRuntimeFile(input.path) === input.sha256, "Generation input content drift");
	}
	const tree = oneironGateTree(join(m.source.workspace, "generated"));
	check(tree.sha256 === generation.generatedContentSha256, "Generated content differs from actual export output");
	const docs = jsonFile(join(m.source.workspace, "generated/docs.json"));
	check(
		docs.generated === true && Array.isArray(docs.pages) && docs.pages.length > 0,
		"Nonempty real generated/docs.json required",
	);
	for (const page of docs.pages) {
		check(
			typeof page.source === "string" &&
				typeof page.markdownPath === "string" &&
				typeof page.url === "string" &&
				/^[a-f0-9]{64}$/.test(page.sourceHash),
			"Generated page lacks manifest-backed coverage",
		);
		const source = join(m.source.workspace, page.source),
			mirror = join(m.source.workspace, page.markdownPath.replace(/^\/+/, ""));
		check(
			inside(join(m.source.workspace, "site/src"), source) && inside(join(m.source.workspace, "generated"), mirror),
			"Generated page escaped canonical paths",
		);
		regular(source);
		regular(mirror);
		check(
			hashFactoryRuntimeFile(source) === page.sourceHash && statSync(mirror).size > 0,
			"Generated mirror/source missing or stale",
		);
	}
	const specs = jsonFile(join(m.source.workspace, "generated/oneiron-specs.json"));
	check(
		specs.$schema === "oneiron-specs/1" &&
			specs.generated === true &&
			specs.generator === "scripts/emit-spec-manifest.mjs" &&
			Array.isArray(specs.specs) &&
			specs.specs.length > 0 &&
			specs.counts?.total === specs.specs.length &&
			Array.isArray(specs.skipped),
		"Nonempty real generated spec inventory required",
	);
	for (const spec of specs.specs)
		check(
			typeof spec.id === "string" &&
				spec.id &&
				typeof spec.route === "string" &&
				generation.inputs.some((p) => p.path === join(m.source.workspace, spec.filePath)),
			"Spec inventory lacks canonical input",
		);
	const db = jsonFile(join(m.source.workspace, "site/src/data/steal-evaluations.json"));
	check(
		Array.isArray(db.steal_db?.rows) &&
			db.steal_db.rows.length > 0 &&
			db.enrollment_index &&
			typeof db.enrollment_index === "object",
		"Missing steal database would degrade link coverage",
	);
	return {
		pages: docs.pages.length as number,
		markdown: tree.paths.filter((p) => p.endsWith(".md") && !/[/](figures|_astro|pagefind|papers-figs)[/]/.test(p))
			.length,
		specs: specs.specs.length as number,
		skips: specs.skipped as unknown[],
	};
}
function built(workspace: string) {
	const root = join(workspace, "site/dist"),
		tree = oneironGateTree(root);
	regular(join(root, "index.html"));
	const pages = tree.paths.filter(
		(p) => basename(p) === "index.html" && !/[/](_astro|pagefind|papers-figs|biz-figs)[/]/.test(relative(root, p)),
	);
	check(pages.length > 0 && pages.every((p) => statSync(p).size > 0), "Build produced no nonempty real route surface");
	return { sha256: tree.sha256, pages: pages.length };
}
function save(path: string, value: unknown, limit: number): OneironPin {
	const bytes = `${JSON.stringify(value)}\n`;
	check(Buffer.byteLength(bytes) <= limit, "Gate structured artifact exceeds bounded limit");
	writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
	return pin(path);
}
export async function captureOneironGate(
	runtime: OneironRuntime,
	argv: string[],
	cwd: string,
	directory: string,
	index: number,
	environment: Record<string, string> = {},
	replaceEnvironment = false,
	probe = false,
): Promise<ForegroundCapture> {
	check(runtime.capture, "Gate requires file-backed foreground stdout/stderr capture");
	const prefix = probe ? "probe" : "command";
	let result: ForegroundCapture | undefined;
	try {
		result = await runtime.capture(argv, cwd, {
			stdoutPath: join(directory, `${prefix}-${index}.stdout`),
			stderrPath: join(directory, `${prefix}-${index}.stderr`),
			limitBytes: probe ? 4096 : ONEIRON_GATE_LIMITS.streamBytes,
			previewBytes: ONEIRON_GATE_LIMITS.previewBytes,
			environment,
			replaceEnvironment,
			label: "Gate",
			signalPath: join(directory, `${prefix}-${index}.interrupted.json`),
		});
		return result;
	} catch (error) {
		if (error instanceof ForegroundCaptureError) result = error.capture;
		throw error;
	} finally {
		save(
			join(directory, `${prefix}-${index}.json`),
			result ?? {
				argv,
				cwd,
				status: "CAPTURE_FAILED",
				stdoutPath: join(directory, `${prefix}-${index}.stdout`),
				stderrPath: join(directory, `${prefix}-${index}.stderr`),
			},
			ONEIRON_GATE_LIMITS.summaryBytes,
		);
	}
}
function coverageFromLogs(
	commands: ForegroundCapture[],
	inputCounts: ReturnType<typeof generatedContent>,
	builtOutput: ReturnType<typeof built>,
): DocsCoverage {
	const stdout = readFileSync(commands[1]!.stdout.path, "utf8"),
		stderr = readFileSync(commands[1]!.stderr!.path, "utf8"),
		logs = `${stdout}\n${stderr}`;
	check(
		!/SKIP_BUILD=|site\/dist missing or stale|Falling back|skipped —|skipping generated|steal_gate:off|report-only until/.test(
			logs,
		),
		"Link checker degraded/skipped/rebuilt required coverage",
	);
	const routes = stdout.match(/valid routes: (\d+) \((\d+) built dist pages · (\d+) src\/pages \.astro · merged\)/);
	const scanned = stdout.match(
		/scanned: (\d+) generated md \((\d+) internal links\) · (\d+) \.astro \((\d+) internal hrefs\) · steal_gate:on/,
	);
	check(
		routes &&
			Number(routes[2]) === builtOutput.pages &&
			Number(routes[3]) > 0 &&
			scanned &&
			Number(scanned[1]) === inputCounts.markdown &&
			Number(scanned[1]) > 0 &&
			Number(scanned[3]) > 0 &&
			Number(scanned[2]) + Number(scanned[4]) > 0 &&
			/^PASS {2}no blocking problems /m.test(stdout),
		"Nonempty real build/link checks and zero blocking problems required",
	);
	return {
		build: true,
		links: true,
		builtPages: builtOutput.pages,
		builtContentSha256: builtOutput.sha256,
		generatedPages: inputCounts.pages,
		generatedMarkdown: inputCounts.markdown,
		specs: inputCounts.specs,
		linksScanned: Number(scanned[2]),
		astroFiles: Number(scanned[3]),
		astroHrefs: Number(scanned[4]),
		warnings: logs.split("\n").filter((line) => / WARN |warning\(s\)|^\s*note:/.test(line)),
		skips: inputCounts.skips,
		limitations: [
			"blocking-only: duplicate IDs/stale mirrors/steal reference drift are warnings",
			"retired checks 2/4; dynamic hrefs, assets and external URLs are outside repository checker coverage",
			"build + links only; not Astro type checking",
		],
	};
}

function validateDocsCapacity(m: OneironManifest, stage: OneironDocsGateStage, plan: Plan, read: Read): number {
	const capacity = JSON.parse(read(stage.capacity));
	check(
		capacity.status === "PASS" &&
			capacity.sourceFingerprint === m.source.fingerprint &&
			capacity.host === stage.host &&
			capacity.slot === stage.slot &&
			capacity.duplicateFree === true &&
			capacity.resourcesPassed === true &&
			capacity.planSha256 === plan.planSha256 &&
			!("argv" in capacity) &&
			Number.isFinite(Date.parse(capacity.expiresAt)),
		"Exact retained capacity/resource/global-duplicate plan identity required",
	);
	return Date.parse(capacity.expiresAt);
}
function requireFreshBuiltRoutes(workspace: string): void {
	const index = join(workspace, "site/dist/index.html");
	regular(index);
	const builtAt = statSync(index).mtimeMs,
		pages = join(workspace, "site/src/pages");
	const tree = oneironGateTree(pages);
	check(tree.files > 0, "No source pages for real link coverage");
	for (const path of tree.paths)
		check(
			statSync(path).mtimeMs <= builtAt,
			"Built routes are stale; links would implicitly rebuild instead of running the admitted plan",
		);
}
export async function executeOneironDocsGate(
	m: OneironManifest,
	stage: OneironDocsGateStage,
	manifestPin: OneironPin,
	runtime: OneironRuntime,
	read: Read,
	seam: () => Promise<void>,
): Promise<Record<string, unknown>> {
	const tools = JSON.parse(read(stage.toolchain)) as OneironDocsToolchain,
		plan = oneironDocsPlan(m, stage, tools);
	// Fresh capacity is checked once; retained identity stays pinned at seams and consumption.
	check(
		validateDocsCapacity(m, stage, plan, read) > runtime.now(),
		"Fresh exact-plan capacity/resource/global-duplicate evidence required",
	);
	const attemptId = validateOneironGateAttempt(
		m,
		manifestPin.sha256,
		await runtime.status(m.factoryDirectory),
		process.env.PRIME_FACTORY_ATTEMPT_ID,
	);
	check(
		process.env.PRIME_FACTORY_SOURCE_FINGERPRINT === m.source.fingerprint,
		"Gate runner source environment mismatch",
	);
	const probes: ForegroundCapture[] = [];
	let interlock: OneironInterlockProof | undefined;
	const finalSeam = async () => {
		await seam();
		const state = await runtime.status(m.factoryDirectory);
		validateOneironGateAttempt(m, manifestPin.sha256, state, attemptId);
		const attempt = state.attempts!.find((a) => a.id === attemptId)!,
			action = state.actions!.find((a) => a.id === attempt.actionId)!;
		const held = inspectOneironInterlock(stage, action, attempt);
		check(!interlock || equal(interlock, held), "Physical slot lock identity changed during owned stage");
		if (!interlock) {
			save(join(m.outputDirectory, "interlock.json"), held, ONEIRON_GATE_LIMITS.summaryBytes);
		}
		interlock = held;
		check(sameSource(await runtime.source(m), m.source), "Gate source changed at command spawn seam");
		check(!existsSync(m.ownerPauseFile), "Owner pause changed at command spawn seam");
		readFactoryRuntime(m.factoryRuntime!, read);
		validateTools(m, stage, tools, plan, read);
		read(stage.capacity);
		read(stage.toolchain);
		read(stage.generation);
	};
	const recheck = async () => {
		await finalSeam();
		for (const name of ["bun", "node"] as const) {
			const probe = await captureOneironGate(
				runtime,
				[tools[name].realpath, "--version"],
				m.source.workspace,
				m.outputDirectory,
				probes.length,
				plan.commands[0]!.environment,
				true,
				true,
			);
			probes.push(probe);
			check(
				readFileSync(probe.stdout.path, "utf8").trim() === tools[name].version,
				`Captured native ${name} --version differs`,
			);
		}
		const counts = await generated(m, stage, tools, runtime, read);
		await finalSeam();
		return counts;
	};
	await recheck();
	for (const path of [plan.commands[0]!.environment.HOME, plan.commands[0]!.environment.TMPDIR])
		mkdirSync(path, { mode: 0o700 });
	const dist = join(m.source.workspace, "site/dist");
	check(
		(await runtime.run(["git", "check-ignore", "--no-index", "site/dist/index.html"], m.source.workspace)).trim() ===
			"site/dist/index.html",
		"Build output must be ignored, not canonical source",
	);
	if (existsSync(dist)) {
		check(realpathSync(dist) === dist && lstatSync(dist).isDirectory(), "Build output alias rejected");
		renameSync(dist, join(m.outputDirectory, "prior-dist"));
	}
	const commands: ForegroundCapture[] = [];
	const build = plan.commands[0]!;
	await finalSeam();
	commands.push(
		await captureOneironGate(runtime, build.argv, build.cwd, m.outputDirectory, 0, build.environment, true),
	);
	const builtOutput = built(m.source.workspace);
	await recheck();
	const links = plan.commands[1]!;
	requireFreshBuiltRoutes(m.source.workspace);
	commands.push(
		await captureOneironGate(runtime, links.argv, links.cwd, m.outputDirectory, 1, links.environment, true),
	);
	const inputCounts = await recheck();
	check(equal(built(m.source.workspace), builtOutput), "Links rebuilt or changed the captured build surface");
	const coverage = coverageFromLogs(commands, inputCounts, builtOutput);
	const proof: DocsProof = {
		version: 1,
		driver: stage.driver,
		profile: stage.profile,
		linkPolicy: stage.linkPolicy,
		attemptId,
		manifest: manifestPin,
		manifestSha256: manifestPin.sha256,
		stageSha256: oneironSha(JSON.stringify(stage)),
		runtime: m.factoryRuntime!,
		input: m.source,
		output: await runtime.source(m),
		capacity: stage.capacity,
		toolchain: stage.toolchain,
		generation: stage.generation,
		planSha256: plan.planSha256,
		commands,
		probes,
		interlock: interlock!,
		interlockEvidence: pin(join(m.outputDirectory, "interlock.json")),
		coverage,
		checks: {
			nativeTools: true,
			dependencies: true,
			lock: true,
			scripts: true,
			generation: true,
			unchangedSource: true,
		},
		limits: ONEIRON_GATE_LIMITS,
		status: "PASS",
	};
	check(sameSource(proof.output, m.source), "Docs gate changed source");
	check(
		[...commands, ...probes].reduce((total, c) => total + c.stdout.bytes + (c.stderr?.bytes ?? 0), 0) <=
			ONEIRON_GATE_LIMITS.rawBytes,
		"Docs raw capture aggregate exceeds limit",
	);
	const proofPin = save(join(m.outputDirectory, "gate-provenance.json"), proof, ONEIRON_GATE_LIMITS.proofBytes);
	return { driver: stage.driver, commandRc: 0, provenancePassed: true, proof: proofPin, capacity: stage.capacity };
}
/** Typed candidate validation. Terminal custody is checked separately, never inferred from this inner PASS. */
export function validateOneironDocsProof(receipt: OneironReceipt, read: Read): DocsProof {
	const proof = JSON.parse(
		read(receipt.result.proof as OneironPin, ONEIRON_GATE_LIMITS.proofBytes, "gate.proof"),
	) as DocsProof;
	const manifest = JSON.parse(read(proof.manifest)) as OneironManifest;
	check(
		manifest.stage.kind === "gate" && "driver" in manifest.stage && manifest.stage.driver === "bun-docs-v1",
		"Docs proof requires original typed native manifest",
	);
	const stage = manifest.stage;
	inspectOneironDocsStage(stage);
	const tools = JSON.parse(read(stage.toolchain)) as OneironDocsToolchain,
		plan = oneironDocsPlan(manifest, stage, tools);
	check(
		receipt.result.driver === "bun-docs-v1" &&
			receipt.result.commandRc === 0 &&
			receipt.result.provenancePassed === true &&
			equal(receipt.result.capacity, stage.capacity) &&
			proof.version === 1 &&
			proof.status === "PASS" &&
			proof.driver === stage.driver &&
			proof.profile === stage.profile &&
			proof.linkPolicy === stage.linkPolicy &&
			proof.manifestSha256 === proof.manifest.sha256 &&
			proof.manifestSha256 === receipt.manifestSha256 &&
			proof.stageSha256 === receipt.stageSha256 &&
			proof.stageSha256 === oneironSha(JSON.stringify(stage)) &&
			receipt.ticketId === manifest.ticketId &&
			equal(receipt.custody, manifest.custody) &&
			equal(proof.runtime, manifest.factoryRuntime) &&
			equal(proof.capacity, stage.capacity) &&
			equal(proof.toolchain, stage.toolchain) &&
			equal(proof.generation, stage.generation) &&
			sameSource(proof.input, manifest.source) &&
			sameSource(proof.output, manifest.source) &&
			sameSource(receipt.input, manifest.source) &&
			sameSource(receipt.output, manifest.source) &&
			proof.planSha256 === plan.planSha256 &&
			equal(proof.limits, ONEIRON_GATE_LIMITS),
		"Docs proof binding/source/plan/runtime mismatch",
	);
	requireOneironGateRuntime(readFactoryRuntime(proof.runtime, read), true, false, false);
	check(
		equal(proof.checks, {
			nativeTools: true,
			dependencies: true,
			lock: true,
			scripts: true,
			generation: true,
			unchangedSource: true,
		}) &&
			proof.commands.length === 2 &&
			proof.attemptId,
		"Docs proof missing substantive checks/attempt",
	);
	for (const [i, command] of proof.commands.entries()) {
		const expected = plan.commands[i]!;
		check(
			equal(
				command,
				JSON.parse(
					read(
						pin(join(manifest.outputDirectory, `command-${i}.json`)),
						ONEIRON_GATE_LIMITS.summaryBytes,
						"gate.command",
					),
				),
			),
			"Docs command differs from durable capture summary",
		);
		check(
			equal(command.argv, expected.argv) &&
				command.cwd === expected.cwd &&
				equal(command.environment, expected.environment) &&
				command.exitCode === 0 &&
				command.signal === null &&
				!command.failure &&
				Number.isFinite(Date.parse(command.startedAt)) &&
				Date.parse(command.finishedAt) >= Date.parse(command.startedAt),
			"Docs command proof mismatch/failure",
		);
		for (const name of ["stdout", "stderr"] as const) {
			const stream = command[name];
			check(
				stream &&
					stream.path === join(manifest.outputDirectory, `command-${i}.${name}`) &&
					!stream.truncated &&
					stream.bytes === stream.observedBytes &&
					stream.bytes <= ONEIRON_GATE_LIMITS.streamBytes &&
					statSync(stream.path).size === stream.bytes &&
					hashFactoryRuntimeFile(stream.path) === stream.sha256 &&
					Buffer.byteLength(stream.preview) <= ONEIRON_GATE_LIMITS.previewBytes,
				"Docs log changed/truncated/out of bound",
			);
		}
	}
	check(
		Date.parse(proof.commands[0]!.finishedAt) <= Date.parse(proof.commands[1]!.startedAt),
		"Docs command order mismatch",
	);
	check(proof.probes?.length === 6, "Docs proof must retain native tool version probes at all three seams");
	for (const [i, probe] of proof.probes.entries()) {
		const name = i % 2 === 0 ? "bun" : "node";
		check(
			equal(
				probe,
				JSON.parse(
					read(
						pin(join(manifest.outputDirectory, `probe-${i}.json`)),
						ONEIRON_GATE_LIMITS.summaryBytes,
						"gate.probe",
					),
				),
			),
			"Native tool probe differs from durable capture summary",
		);
		check(
			equal(probe.argv, [tools[name].realpath, "--version"]) &&
				probe.cwd === manifest.source.workspace &&
				equal(probe.environment, plan.commands[0]!.environment) &&
				probe.exitCode === 0 &&
				probe.signal === null &&
				!probe.failure,
			"Native tool probe identity mismatch",
		);
		for (const streamName of ["stdout", "stderr"] as const) {
			const stream = probe[streamName];
			check(
				stream &&
					stream.path === join(manifest.outputDirectory, `probe-${i}.${streamName}`) &&
					stream.bytes <= 4096 &&
					stream.bytes === stream.observedBytes &&
					!stream.truncated &&
					statSync(stream.path).size === stream.bytes &&
					hashFactoryRuntimeFile(stream.path) === stream.sha256,
				"Native tool probe log changed/truncated",
			);
		}
		check(
			readFileSync(probe.stdout.path, "utf8").trim() === tools[name].version,
			"Native tool captured version mismatch",
		);
	}
	check(
		[...proof.commands, ...proof.probes].reduce((total, c) => total + c.stdout.bytes + (c.stderr?.bytes ?? 0), 0) <=
			ONEIRON_GATE_LIMITS.rawBytes,
		"Docs raw capture aggregate exceeds limit",
	);
	validateDocsCapacity(manifest, stage, plan, read);
	const generation = readGeneration(manifest, stage, tools, read);
	validateTools(manifest, stage, tools, plan, read);
	const actualCoverage = coverageFromLogs(
		proof.commands,
		generatedContent(manifest, generation),
		built(manifest.source.workspace),
	);
	check(equal(proof.coverage, actualCoverage), "Docs proof coverage differs from retained real inputs/logs");

	check(
		proof.interlockEvidence?.path === join(manifest.outputDirectory, "interlock.json") &&
			equal(
				proof.interlock,
				JSON.parse(read(proof.interlockEvidence, ONEIRON_GATE_LIMITS.summaryBytes, "gate.interlock")),
			),
		"Docs physical lock differs from durable native snapshot",
	);
	check(
		proof.interlock?.kind === "linux-flock-v1" &&
			proof.interlock.attemptId === proof.attemptId &&
			equal(proof.interlock.binary, stage.interlock) &&
			proof.interlock.lockPath === plan.launchPrefix[3] &&
			proof.interlock.slot === stage.slot,
		"Docs proof omitted physical lock identity",
	);
	return proof;
}
export function validateOneironDocsTerminal(
	receipt: OneironReceipt,
	state: OneironGateStatus | FactoryStatus,
	read: Read,
	expectedAttempt?: string,
): void {
	const proof = validateOneironDocsProof(receipt, read),
		attempt = state.attempts?.find((a) => a.id === proof.attemptId),
		action = state.actions?.find((a) => a.id === attempt?.actionId);
	check(
		(!expectedAttempt || expectedAttempt === proof.attemptId) &&
			attempt?.state === "TERMINAL" &&
			attempt.claimReleased &&
			attempt.uncertainty === null &&
			attempt.receipt?.attemptId === attempt.id &&
			attempt.receipt.exitCode === 0 &&
			attempt.receipt.sourceFingerprint === proof.input.fingerprint &&
			attempt.receipt.artifact?.sourceFingerprint === proof.output.fingerprint &&
			action &&
			["AWAITING_DECISION", "ACCEPTED"].includes(action.state) &&
			action.ticketId === receipt.ticketId &&
			action.command.argv.at(-2) === proof.manifestSha256 &&
			action.command.argv.at(-4) === proof.manifest.path &&
			action.sourceFingerprint === proof.input.fingerprint &&
			state.attempts?.filter((a) => a.actionId === action.id).at(-1)?.id === attempt.id,
		"Docs gate needs current successful outer CommandAdapter terminal, not an unbound inner PASS",
	);
	const manifest = JSON.parse(read(proof.manifest)) as OneironManifest;
	check(
		manifest.stage.kind === "gate" && manifest.stage.driver === "bun-docs-v1",
		"Interlock needs typed docs manifest",
	);
	validateDocsCommand(manifest, proof.manifest, action, attempt, state, read);
	validateOneironInterlockProof(proof.interlock, manifest.stage, action, attempt);
}
