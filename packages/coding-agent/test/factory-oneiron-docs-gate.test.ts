import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	bindOneironEvidence,
	executeOneiron,
	inspectOneiron,
	type OneironManifest,
	type OneironPermit,
	type OneironReceipt,
	type OneironRuntime,
	type OneironSource,
	prepareOneiron,
	readOneironPin,
	runOneironForeground,
} from "../src/factory/adapters/oneiron.js";
import { runOneironCapture } from "../src/factory/adapters/oneiron-capture.js";
import {
	ONEIRON_DOCS_ENTRY_ENVIRONMENT,
	ONEIRON_GATE_CAPABILITIES,
	ONEIRON_GATE_LIMITS,
	type OneironDocsGateStage,
	type OneironDocsGeneration,
	type OneironDocsToolchain,
	oneironDocsPlan,
	oneironGateTree,
	requireOneironGateRuntime,
	validateOneironDocsProof,
	validateOneironDocsTerminal,
	validateOneironGateAttempt,
} from "../src/factory/adapters/oneiron-docs-gate.js";
import type * as Interlock from "../src/factory/adapters/oneiron-interlock.js";
import type { OneironPin } from "../src/factory/adapters/oneiron-review.js";
import { type FactoryRuntimeIdentity, hashFactoryRuntimeFile } from "../src/factory/runtime.js";
import type { CompletionReceipt, FactoryStatus } from "../src/factory/types.js";

// UNIT MOCK physical-lock authority only. The real prefix/pinned ELF validator stays active.
// These impossible FD/process markers must never be presented as native lock evidence.
const interlockFault = vi.hoisted(() => ({ held: true, terminalValid: true }));
vi.mock("../src/factory/adapters/oneiron-interlock.js", async (importOriginal) => {
	const actual = await importOriginal<typeof Interlock>();
	return {
		...actual,
		inspectOneironInterlock: vi.fn(
			(
				stage: Parameters<typeof actual.inspectOneironInterlock>[0],
				action: Parameters<typeof actual.inspectOneironInterlock>[1],
				attempt: Parameters<typeof actual.inspectOneironInterlock>[2],
			): Interlock.OneironInterlockProof => {
				if (!interlockFault.held) throw Error("UNIT MOCK physical interlock lost");
				const prefix = actual.oneironInterlockPrefix(stage);
				expect(action.command.argv.slice(0, 4)).toEqual(prefix);
				return {
					version: 1,
					kind: "linux-flock-v1",
					binary: stage.interlock,
					lockPath: prefix[3]!,
					slot: stage.slot,
					pid: -1,
					processIdentity: "UNIT MOCK",
					parentPid: -1,
					parentProcessIdentity: "UNIT MOCK",
					fd: -1,
					device: "UNIT MOCK",
					inode: "UNIT MOCK",
					kernelRecord: "UNIT MOCK — no lock acquired",
					attemptId: attempt.id,
					runnerDirectory: "UNIT MOCK — no Core runner",
				};
			},
		),
		validateOneironInterlockProof: vi.fn(
			(
				proof: Interlock.OneironInterlockProof,
				stage: Parameters<typeof actual.inspectOneironInterlock>[0],
				action: Parameters<typeof actual.inspectOneironInterlock>[1],
				attempt: Parameters<typeof actual.inspectOneironInterlock>[2],
			) => {
				if (!interlockFault.terminalValid) throw Error("UNIT MOCK retained interlock invalid");
				expect(action.command.argv.slice(0, 4)).toEqual(actual.oneironInterlockPrefix(stage));
				expect(proof).toMatchObject({
					binary: stage.interlock,
					slot: stage.slot,
					attemptId: attempt.id,
					kernelRecord: "UNIT MOCK — no lock acquired",
				});
			},
		),
	};
});

// UNIT MOCK: source/status, dependency preparation and generation are policy fixtures, not operator receipts.
// Bun/Node are actual native binaries. Faux Astro builds nonempty fixture HTML; the checker scans real fixture links.
// No installed production Astro/dependencies, full export, CommandAdapter terminal or product proof is claimed.
const BUN = "/home/lexi/.bun/bin/bun";
const NODE = "/usr/bin/node";
const BUN_SHA = "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74";
const NODE_SHA = "9d8258596e68031047c70637ed9ba2f0becea28258763a9cb6934b85e0c5a3b9";
const FLOCK = { path: "/usr/bin/flock", sha256: "50664fb52caf53215f0974d84e40e3d94783ec9b980bbfe8946911f2a628c3fe" };
const MOCK = "UNIT MOCK — not production docs evidence";
const roots: string[] = [];
const EXPORT_SCRIPT =
	"cd site && bun run build && cd .. && node scripts/export-agent-md.mjs && node scripts/emit-spec-manifest.mjs && node scripts/check-doc-links.mjs";
const ASTRO_FIXTURE = `#!/usr/bin/env node
// UNIT MOCK: deliberately small HTML fixture builder, not Astro.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.slice(2).join(" ") !== "build") throw Error("UNIT MOCK supports build only");
const page = readFileSync("src/pages/index.astro", "utf8");
if (!page.includes("<main>") || !page.includes('id="intro"')) throw Error("UNIT MOCK page is empty");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "<!doctype html>\\n" + page);
console.log("UNIT MOCK built nonempty fixture HTML");
`;
const LINKS_FIXTURE = `// UNIT MOCK: substantive local links, not the repository's production checker.
import { readFileSync } from "node:fs";
const html = readFileSync("site/dist/index.html", "utf8");
const source = readFileSync("site/src/pages/index.astro", "utf8");
const markdown = readFileSync("generated/index.md", "utf8");
const mdLinks = [...markdown.matchAll(/\\]\\(([^)]+)\\)/g)].map(m => m[1]);
const hrefs = [...source.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
if (!html.trim() || !mdLinks.length || !hrefs.length) throw Error("UNIT MOCK empty coverage");
for (const link of [...mdLinks, ...hrefs]) {
 const [route, anchor] = link.split("#");
 if (route !== "/" || (anchor && !html.includes('id="' + anchor + '"'))) throw Error("UNIT MOCK broken link: " + link);
}
console.log("UNIT MOCK substantive local link scan");
console.log("valid routes: 1 (1 built dist pages · 1 src/pages .astro · merged)");
console.log("scanned: 1 generated md (" + mdLinks.length + " internal links) · 1 .astro (" + hrefs.length + " internal hrefs) · steal_gate:on");
console.log("PASS  no blocking problems (UNIT MOCK fixture)");
`;
function write(path: string, content: string): OneironPin {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return { path, sha256: hashFactoryRuntimeFile(path) };
}
function json(path: string, value: unknown): OneironPin {
	return write(path, `${JSON.stringify(value)}\n`);
}
function load<T>(pin: OneironPin): T {
	return JSON.parse(readFileSync(pin.path, "utf8")) as T;
}
function mockOperator(
	directory: string,
	name: string,
	command: { argv: string[]; cwd: string },
	input: string,
	output: string,
) {
	const root = join(directory, "UNIT-MOCK-operators", `unit-mock-${name}`);
	const values = {
		PATH: [...new Set([dirname(BUN), dirname(NODE)])].join(":"),
		HOME: join(directory, "operator-home", name),
		TMPDIR: join(directory, "operator-tmp", name),
		CI: "1",
		NO_COLOR: "1",
		ASTRO_TELEMETRY_DISABLED: "1",
		GIT_OPTIONAL_LOCKS: "0",
		...(command.argv[1] === "install" ? { BUN_INSTALL_CACHE_DIR: join(directory, "operator-cache") } : {}),
	};
	const launcher = { path: "/usr/bin/env", sha256: hashFactoryRuntimeFile("/usr/bin/env") };
	const nativeCommand = {
		...command,
		argv: [
			launcher.path,
			"--ignore-environment",
			...Object.entries(values)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => `${key}=${value}`),
			...command.argv,
		],
		env: ONEIRON_DOCS_ENTRY_ENVIRONMENT,
	};
	const receipt: CompletionReceipt = {
		attemptId: `unit-mock-${name}`,
		sourceFingerprint: input,
		exitCode: 0,
		finishedAt: new Date().toISOString(),
		artifact: { ref: MOCK, sourceFingerprint: output },
	};
	const terminal = json(join(root, "terminal.json"), receipt);
	const status: FactoryStatus = {
		schemaVersion: 1,
		planRevision: 1,
		paused: false,
		pauseReason: null,
		roles: {},
		tickets: [],
		slots: [{ id: "unit-mock-slot", host: "arch" }],
		wakes: [],
		actions: [
			{
				id: `unit-mock-${name}-action`,
				ticketId: "UNIT-MOCK-ROOT",
				kind: "process",
				dependencies: [],
				sourceFingerprint: input,
				command: nativeCommand,
				requirements: { host: "arch", slotId: "unit-mock-slot" },
				state: "ACCEPTED",
			},
		],
		attempts: [
			{
				id: receipt.attemptId,
				actionId: `unit-mock-${name}-action`,
				slotId: "unit-mock-slot",
				state: "TERMINAL",
				createdAt: receipt.finishedAt,
				submittedAt: receipt.finishedAt,
				processIdentity: MOCK,
				receipt,
				uncertainty: null,
				claimReleased: true,
			},
		],
	};
	return {
		terminal,
		operator: {
			host: "arch",
			slotId: "unit-mock-slot",
			environment: { launcher, values },
			manifest: json(join(root, "manifest.json"), {
				fixture: MOCK,
				version: 1,
				attemptId: receipt.attemptId,
				sourceFingerprint: input,
				command: nativeCommand,
			}),
			status: json(join(root, "status.json"), status),
			stdout: write(join(root, "stdout.log"), `${MOCK}: operator did not actually run\n`),
			stderr: write(join(root, "stderr.log"), ""),
		},
	};
}
function fixture() {
	// Only this explicitly isolated fixture clears the npm-provided cache override.
	vi.stubEnv("npm_config_cache", undefined);
	vi.stubEnv("NODE_OPTIONS", undefined);
	vi.stubEnv("BUN_INSTALL", undefined);
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "oneiron-docs-UNIT-MOCK-")));
	roots.push(directory);
	const workspace = join(directory, "workspace");
	const source: OneironSource = {
		workspace,
		head: "a".repeat(40),
		tree: "b".repeat(40),
		branch: "UNIT-MOCK-docs",
		remoteUrl: "https://example.invalid/UNIT-MOCK-docs.git",
		fingerprint: `git:${"c".repeat(64)}`,
	};
	const page = write(
		join(workspace, "site/src/pages/index.astro"),
		'<main><h1 id="intro">UNIT MOCK docs</h1><a href="/#intro">Intro</a></main>\n',
	);
	const data = json(join(workspace, "site/src/data/steal-evaluations.json"), {
		fixture: MOCK,
		steal_db: { rows: [{ id: "unit-mock" }] },
		enrollment_index: {},
	});
	const rootPackage = json(join(workspace, "package.json"), {
		private: true,
		description: MOCK,
		scripts: { "check:links": "node scripts/check-doc-links.mjs", "export:agent": EXPORT_SCRIPT },
	});
	const sitePackage = json(join(workspace, "site/package.json"), {
		private: true,
		description: MOCK,
		scripts: { build: "astro build" },
		engines: { node: ">=22.12.0" },
	});
	const checker = write(join(workspace, "scripts/check-doc-links.mjs"), LINKS_FIXTURE);
	const inputs = [page, data, rootPackage, sitePackage, checker];
	const depsRoot = join(workspace, "site/node_modules");
	json(join(depsRoot, "astro/package.json"), {
		name: "astro",
		version: "0.0.0-unit-mock",
		description: MOCK,
		type: "module",
		bin: "astro.mjs",
	});
	const astro = write(join(depsRoot, "astro/astro.mjs"), ASTRO_FIXTURE);
	chmodSync(astro.path, 0o755);
	mkdirSync(join(depsRoot, ".bin"));
	symlinkSync("../astro/astro.mjs", join(depsRoot, ".bin/astro"));
	const lockfile = {
		...write(join(workspace, "site/bun.lock"), '{ "fixture": "UNIT MOCK lock; no install performed" }\n'),
		format: "bun.lock" as const,
	};
	write(join(workspace, "generated/index.md"), "# UNIT MOCK\n[Intro](/#intro)\n");
	json(join(workspace, "generated/docs.json"), {
		fixture: MOCK,
		generated: true,
		pages: [
			{
				source: "site/src/pages/index.astro",
				markdownPath: "generated/index.md",
				url: "/",
				sourceHash: page.sha256,
			},
		],
	});
	json(join(workspace, "generated/oneiron-specs.json"), {
		fixture: MOCK,
		$schema: "oneiron-specs/1",
		generated: true,
		generator: "scripts/emit-spec-manifest.mjs",
		specs: [{ id: "UNIT-MOCK-1", route: "/", filePath: "site/src/pages/index.astro" }],
		counts: { total: 1 },
		skipped: [],
	});
	const clock = { now: Date.now() };
	const expiresAt = new Date(clock.now + 60_000).toISOString();
	const release = json(join(directory, "release.json"), { fixture: MOCK });
	const custody = json(join(directory, "custody.json"), {
		fixture: MOCK,
		version: 1,
		state: "transferred",
		ticketId: "UNIT-MOCK-DOCS",
		owner: "unit-mock-owner",
		sourceFingerprint: source.fingerprint,
		expiresAt,
		priorOwners: [{ id: "unit-mock-prior", release }],
		activeOwners: ["unit-mock-owner"],
		liveProcesses: [],
		duplicateAuthorityDisabled: true,
		sharedGitClear: true,
	});
	const cli = write(join(directory, "runtime/cli.mjs"), 'throw Error("UNIT MOCK runtime CLI must not execute");\n');
	const entry = write(
		join(directory, "runtime/factory/adapters/oneiron-entry.js"),
		'throw Error("UNIT MOCK approved entry; not executed");\n',
	);
	const runtimeIdentity: FactoryRuntimeIdentity = {
		version: 1,
		cliArgv: [NODE, cli.path],
		files: [{ path: NODE, sha256: NODE_SHA }, cli, entry],
		capabilities: ["provider-response-model-v1", ...Object.values(ONEIRON_GATE_CAPABILITIES)],
	};
	const runtimePin = json(join(directory, "runtime.json"), runtimeIdentity);
	const placeholder = { path: join(directory, "placeholder"), sha256: "0".repeat(64) };
	const stage: OneironDocsGateStage = {
		interlock: FLOCK,
		kind: "gate",
		driver: "bun-docs-v1",
		host: "arch",
		slot: 1,
		capacity: placeholder,
		toolchain: placeholder,
		generation: placeholder,
		profile: "build-links-v1",
		linkPolicy: "blocking-only",
	};
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "UNIT-MOCK-DOCS",
		owner: "unit-mock-owner",
		source,
		factoryDirectory: join(directory, "factory"),
		factoryRuntime: runtimePin,
		ownerPauseFile: join(directory, "OWNER-PAUSE"),
		custody,
		outputDirectory: join(directory, "output"),
		stage,
	};
	const nativeTools = {
		bun: { requestedPath: BUN, realpath: realpathSync(BUN), sha256: BUN_SHA, version: "1.3.14" },
		node: { requestedPath: NODE, realpath: realpathSync(NODE), sha256: NODE_SHA, version: "v26.2.0" },
	};
	const preparationOperator = mockOperator(
		directory,
		"preparation",
		{ argv: [nativeTools.bun.realpath, "install", "--frozen-lockfile"], cwd: dirname(lockfile.path) },
		source.fingerprint,
		source.fingerprint,
	);
	const depsHash = oneironGateTree(depsRoot).sha256;
	const preparation = json(join(directory, "UNIT-MOCK-preparation.json"), {
		fixture: MOCK,
		version: 1,
		kind: "oneiron-bun-frozen-install-v1",
		host: stage.host,
		...nativeTools,
		packages: [rootPackage, sitePackage],
		lockfile,
		dependenciesRoot: depsRoot,
		contentSha256: depsHash,
		command: { argv: [nativeTools.bun.realpath, "install", "--frozen-lockfile"], cwd: dirname(lockfile.path) },
		...preparationOperator,
		attemptId: "unit-mock-preparation",
		sourceFingerprint: source.fingerprint,
	});
	const tools: OneironDocsToolchain = {
		interlock: FLOCK,
		version: 1,
		host: stage.host,
		platform: process.platform,
		arch: process.arch,
		...nativeTools,
		packages: [rootPackage, sitePackage],
		lockfile,
		dependencies: { root: depsRoot, contentSha256: depsHash, preparation, astro },
		environment: {},
	};
	tools.environment = oneironDocsPlan(manifest, stage, tools).commands[0]!.environment;
	stage.toolchain = json(join(directory, "toolchain.json"), tools);
	const generation: OneironDocsGeneration = {
		version: 1,
		kind: "oneiron-docs-generation-v1",
		input: { ...source, fingerprint: `git:${"d".repeat(64)}` },
		output: source,
		toolchain: stage.toolchain,
		command: { argv: [tools.bun.realpath, "run", "export:agent"], cwd: workspace },
		...mockOperator(
			directory,
			"export",
			{ argv: [tools.bun.realpath, "run", "export:agent"], cwd: workspace },
			`git:${"d".repeat(64)}`,
			source.fingerprint,
		),
		inputs,
		generatedContentSha256: oneironGateTree(join(workspace, "generated")).sha256,
	};
	stage.generation = json(join(directory, "UNIT-MOCK-generation.json"), { fixture: MOCK, ...generation });
	const capacity = {
		fixture: MOCK,
		status: "PASS",
		sourceFingerprint: source.fingerprint,
		host: stage.host,
		slot: stage.slot,
		duplicateFree: true,
		resourcesPassed: true,
		expiresAt: new Date(clock.now + 1000).toISOString(),
		planSha256: oneironDocsPlan(manifest, stage, tools).planSha256,
	};
	stage.capacity = json(join(directory, "UNIT-MOCK-capacity.json"), capacity);
	const manifestPin = json(join(directory, "manifest.json"), manifest);
	const permit: OneironPermit = {
		version: 1,
		permission: "execute",
		manifestSha256: manifestPin.sha256,
		ticketId: manifest.ticketId,
		stage: "gate",
		sourceFingerprint: source.fingerprint,
		custodySha256: custody.sha256,
		owner: manifest.owner,
		ownerAuthorization: json(join(directory, "UNIT-MOCK-authorization.json"), { fixture: MOCK }),
		expiresAt,
	};
	const permitPin = json(join(directory, "permit.json"), permit);
	const prepared = prepareOneiron(manifest, {
		manifestPath: manifestPin.path,
		adapterArgv: [NODE, entry.path],
		permitPath: permitPin.path,
		host: "arch",
		slotId: "unit-mock-slot",
	});
	if (!prepared.action) throw new Error("UNIT MOCK needs a fresh action");
	const state: FactoryStatus & { ownerPaused: boolean } = {
		schemaVersion: 1,
		planRevision: 1,
		paused: false,
		ownerPaused: false,
		pauseReason: null,
		roles: {},
		tickets: [{ id: manifest.ticketId, owner: manifest.owner, state: "ACTIVE" }],
		slots: [{ id: "unit-mock-slot", host: "arch" }],
		actions: [{ ...prepared.action, state: "RUNNING" }],
		attempts: [
			{
				id: "unit-mock-attempt",
				actionId: prepared.action.id,
				slotId: "unit-mock-slot",
				state: "RUNNING",
				createdAt: new Date(clock.now).toISOString(),
				submittedAt: new Date(clock.now).toISOString(),
				processIdentity: "UNIT-MOCK-no-runner",
				receipt: null,
				uncertainty: null,
				claimReleased: false,
			},
		],
		wakes: [],
	};
	vi.stubEnv("PRIME_FACTORY_ATTEMPT_ID", state.attempts[0]!.id);
	vi.stubEnv("PRIME_FACTORY_SOURCE_FINGERPRINT", source.fingerprint);
	const controls = { afterCapture: (_index: number): void => {}, captures: 0, source: { ...source } };
	const runtime: OneironRuntime = {
		now: () => clock.now,
		status: vi.fn(async () => state),
		source: vi.fn(async () => controls.source),
		call: vi.fn(async () => {
			throw new Error("UNIT MOCK gate must never call a model");
		}),
		run: vi.fn(async (argv, cwd, environment) => {
			if ([BUN, NODE].includes(argv[0]!) && argv.length === 2 && argv[1] === "--version")
				return runOneironForeground(argv, cwd, environment);
			// UNIT MOCK Git metadata: no real source lineage or generation attestation is claimed.
			if (JSON.stringify(argv) === JSON.stringify(["git", "--no-replace-objects", "ls-files", "--cached", "-z"]))
				return `${inputs.map((p) => p.path.slice(workspace.length + 1)).join("\0")}\0`;
			if (JSON.stringify(argv) === JSON.stringify(["git", "check-ignore", "--no-index", "site/dist/index.html"]))
				return "site/dist/index.html\n";
			throw new Error(`UNIT MOCK forbids unexpected command: ${JSON.stringify(argv)}`);
		}),
		capture: vi.fn(async (argv, cwd, options) => {
			const result = await runOneironCapture(argv, cwd, options);
			if (argv[1] === "run") controls.afterCapture(controls.captures++);
			return result;
		}),
	};
	function rebind() {
		Object.assign(manifestPin, json(manifestPin.path, manifest));
		permit.manifestSha256 = manifestPin.sha256;
		permit.custodySha256 = manifest.custody.sha256;
		json(permitPin.path, permit);
		state.actions[0]!.command.argv[state.actions[0]!.command.argv.length - 2] = manifestPin.sha256;
	}
	return {
		directory,
		manifest,
		manifestPin,
		permit,
		permitPin,
		stage,
		tools,
		generation,
		capacity,
		runtimeIdentity,
		state,
		runtime,
		controls,
		clock,
		rebind,
	};
}
type Fixture = ReturnType<typeof fixture>;
function refresh(f: Fixture): void {
	f.stage.toolchain = json(f.stage.toolchain.path, f.tools);
	f.generation.toolchain = f.stage.toolchain;
	f.stage.generation = json(f.stage.generation.path, { fixture: MOCK, ...f.generation });
	f.capacity.planSha256 = oneironDocsPlan(f.manifest, f.stage, f.tools).planSha256;
	f.stage.capacity = json(f.stage.capacity.path, f.capacity);
	f.rebind();
}
function noReceipt(f: Fixture): void {
	expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
	expect(existsSync(join(f.manifest.outputDirectory, "gate-provenance.json"))).toBe(false);
}

async function execute(f: Fixture): Promise<OneironReceipt> {
	const result = await executeOneiron(f.manifestPin.path, f.permitPin.path, true, f.runtime, f.manifestPin.sha256);
	if ("reused" in result) throw new Error("UNIT MOCK expected execution");
	return result;
}
function terminal(f: Fixture): void {
	const attempt = f.state.attempts[0]!;
	const receipt: CompletionReceipt = {
		attemptId: attempt.id,
		sourceFingerprint: f.manifest.source.fingerprint,
		exitCode: 0,
		finishedAt: new Date(f.clock.now).toISOString(),
		artifact: { ref: "UNIT MOCK outer terminal", sourceFingerprint: f.manifest.source.fingerprint },
	};
	Object.assign(attempt, { state: "TERMINAL", claimReleased: true, receipt });
	f.state.actions[0]!.state = "AWAITING_DECISION";
	f.state.wakes = [
		{
			id: 1,
			actionId: attempt.actionId,
			attemptId: attempt.id,
			reason: "UNIT MOCK terminal",
			createdAt: receipt.finishedAt,
			resolvedAt: null,
		},
	];
}
afterEach(() => {
	Object.assign(interlockFault, { held: true, terminalValid: true });
	vi.unstubAllEnvs();
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("typed docs gate with actual Bun/Node and explicit UNIT MOCK dependencies/authority", () => {
	test("runs build then substantive links and requires a separate outer terminal before evidence binding", async () => {
		const f = fixture();
		const receipt = await execute(f);
		const proof = validateOneironDocsProof(receipt, readOneironPin);
		expect(proof.commands.map((c) => c.argv)).toEqual([
			[BUN, "run", "build"],
			[BUN, "run", "check:links"],
		]);
		expect(proof.commands.every((c) => c.exitCode === 0 && c.signal === null)).toBe(true);
		expect(proof.probes).toHaveLength(6);
		for (const [i, probe] of proof.probes.entries()) {
			expect(readFileSync(probe.stdout.path, "utf8").trim()).toBe(i % 2 === 0 ? "1.3.14" : "v26.2.0");
			expect(probe.argv).toEqual([i % 2 === 0 ? BUN : NODE, "--version"]);
		}
		expect(proof.limits).toEqual(ONEIRON_GATE_LIMITS);
		expect(proof.coverage).toMatchObject({
			builtPages: 1,
			generatedPages: 1,
			generatedMarkdown: 1,
			specs: 1,
			linksScanned: 1,
			astroFiles: 1,
			astroHrefs: 1,
		});
		expect(readFileSync(join(f.manifest.source.workspace, "site/dist/index.html"), "utf8")).toContain(
			"UNIT MOCK docs",
		);
		expect(receipt.productAccepted).toBe(false);
		expect(() => validateOneironDocsTerminal(receipt, f.state, readOneironPin)).toThrow(
			/outer CommandAdapter terminal/,
		);
		terminal(f);
		expect(() => validateOneironDocsTerminal(receipt, f.state, readOneironPin, "unit-mock-attempt")).not.toThrow();
		const receiptPin = {
			path: join(f.manifest.outputDirectory, "receipt.json"),
			sha256: hashFactoryRuntimeFile(join(f.manifest.outputDirectory, "receipt.json")),
		};
		const binding = bindOneironEvidence(f.state, f.state.actions[0]!.id, f.manifest, receiptPin);
		expect(binding.attemptId).toBe("unit-mock-attempt");
		expect(binding.evidence[0]!.content).toBe(JSON.stringify(receipt));
		expect(f.runtime.call).not.toHaveBeenCalled();
	});
});

describe("docs gate fail-closed admission with UNIT MOCK authority", () => {
	test("admits only the two typed build/link commands and a native runtime that pins the implementation", () => {
		const f = fixture();
		expect(inspectOneiron(f.manifest).executionAuthorized).toBe(false);
		for (const extra of [
			{ argv: [BUN, "run", "export:agent"] },
			{ environment: { SKIP_BUILD: "1" } },
			{ install: true },
			{ profile: "other" },
			{ linkPolicy: "report-only" },
		]) {
			expect(() =>
				inspectOneiron({ ...f.manifest, stage: { ...f.stage, ...extra } as OneironDocsGateStage }),
			).toThrow(/Only typed/);
		}
		for (const capabilities of [[], [ONEIRON_GATE_CAPABILITIES.capture], [ONEIRON_GATE_CAPABILITIES.docs]]) {
			expect(() => requireOneironGateRuntime({ ...f.runtimeIdentity, capabilities }, true, false, false)).toThrow(
				/capability/,
			);
		}
		expect(() => requireOneironGateRuntime(f.runtimeIdentity, true, false, true)).toThrow(/implementation bytes/);
		const files = [
			"oneiron.ts",
			"oneiron-capture.ts",
			"oneiron-writer.ts",
			"oneiron-docs-gate.ts",
			"oneiron-interlock.ts",
			"oneiron-entry.ts",
		].map((name) => {
			const path = resolve("src/factory/adapters", name);
			return { path, sha256: hashFactoryRuntimeFile(path) };
		});
		expect(() =>
			requireOneironGateRuntime(
				{ ...f.runtimeIdentity, files: [...f.runtimeIdentity.files, ...files] },
				true,
				false,
				true,
			),
		).not.toThrow();
	});

	test("rejects released, stale, competing or differently bound owned attempts", () => {
		const f = fixture();
		const valid = structuredClone(f.state);
		expect(validateOneironGateAttempt(f.manifest, f.manifestPin.sha256, valid, "unit-mock-attempt")).toBe(
			"unit-mock-attempt",
		);
		const mutations: Array<(state: typeof valid) => void> = [
			(s) => {
				s.attempts[0]!.claimReleased = true;
			},
			(s) => {
				s.attempts[0]!.state = "UNCERTAIN";
			},
			(s) => {
				s.attempts[0]!.uncertainty = MOCK;
			},
			(s) => {
				s.actions[0]!.sourceFingerprint = `git:${"e".repeat(64)}`;
			},
			(s) => {
				s.actions[0]!.command.cwd = f.directory;
			},
			(s) => {
				s.actions[0]!.command.argv[0] = "UNIT-MOCK-not-a-runner";
				s.actions[0]!.command.argv.pop();
			},
			(s) => {
				s.actions[0]!.requirements.host = "mini";
			},
			(s) => {
				s.slots[0]!.host = "mini";
			},
			(s) => {
				s.tickets[0]!.owner = "other-unit-mock-owner";
			},
			(s) => {
				s.tickets[0]!.state = "RETIRED";
			},
			(s) => {
				s.attempts.push({ ...s.attempts[0]!, id: "newer-unit-mock-attempt" });
			},
			(s) => {
				s.actions.push({ ...s.actions[0]!, id: "competing-unit-mock-action" });
				s.attempts.push({
					...s.attempts[0]!,
					id: "competing-unit-mock-attempt",
					actionId: "competing-unit-mock-action",
				});
			},
		];
		for (const mutate of mutations) {
			const state = structuredClone(valid);
			mutate(state);
			expect(() => validateOneironGateAttempt(f.manifest, f.manifestPin.sha256, state, "unit-mock-attempt")).toThrow(
				/owned runner|custody/,
			);
		}
		expect(() => validateOneironGateAttempt(f.manifest, f.manifestPin.sha256, valid, undefined)).toThrow(
			/owned runner/,
		);
	});

	test.each(["expired", "wrong-plan", "argv", "resources", "duplicates", "host", "source"])(
		"rejects %s capacity before any subprocess",
		async (kind) => {
			const f = fixture();
			const changes: Record<string, unknown> = {
				expired: { expiresAt: new Date(f.clock.now).toISOString() },
				"wrong-plan": { planSha256: "f".repeat(64) },
				argv: { argv: [BUN, "run", "build"] },
				resources: { resourcesPassed: false },
				duplicates: { duplicateFree: false },
				host: { host: "mini" },
				source: { sourceFingerprint: `git:${"e".repeat(64)}` },
			};
			f.stage.capacity = json(f.stage.capacity.path, { ...f.capacity, ...(changes[kind] as object) });
			f.rebind();
			await expect(execute(f)).rejects.toThrow(/(?:Fresh exact-plan|Exact retained) capacity/);
			expect(f.runtime.capture).not.toHaveBeenCalled();
			noReceipt(f);
		},
	);

	test.each(["NODE_OPTIONS", "BUN_INSTALL", "npm_config_cache", "SKIP_BUILD", "LD_PRELOAD"])(
		"rejects inherited %s instead of silently cleaning production input",
		async (key) => {
			const f = fixture();
			vi.stubEnv(key, "UNIT-MOCK-unapproved");
			await expect(execute(f)).rejects.toThrow(new RegExp(`Unapproved inherited gate environment: ${key}`));
			expect(f.runtime.capture).not.toHaveBeenCalled();
			noReceipt(f);
		},
	);

	test.each([".env", "site/.env.local", "site/bunfig.toml"])("rejects startup config %s", async (path) => {
		const f = fixture();
		write(join(f.manifest.source.workspace, path), "# UNIT MOCK startup config rejection\n");
		await expect(execute(f)).rejects.toThrow(/startup\/config/);
		expect(f.runtime.capture).not.toHaveBeenCalled();
	});

	test.each([
		"native-bytes",
		"lock-bytes",
		"ambiguous-lock",
		"dependency-bytes",
		"generation-input",
		"generation-output",
		"empty-pages",
		"empty-specs",
		"missing-input",
		"operator-terminal",
		"operator-log",
	])("rejects %s input before build", async (kind) => {
		const f = fixture();
		if (kind === "native-bytes") {
			f.tools.bun.sha256 = "f".repeat(64);
			refresh(f);
		}
		if (kind === "lock-bytes") write(f.tools.lockfile.path, "UNIT MOCK lock drift\n");
		if (kind === "ambiguous-lock")
			write(join(dirname(f.tools.lockfile.path), "bun.lockb"), "UNIT MOCK ambiguous lock\n");
		if (kind === "dependency-bytes")
			write(f.tools.dependencies.astro.path, `${ASTRO_FIXTURE}\n// UNIT MOCK dependency drift\n`);
		if (kind === "generation-input") write(f.generation.inputs[0]!.path, "UNIT MOCK source drift\n");
		if (kind === "generation-output")
			write(join(f.manifest.source.workspace, "generated/index.md"), "UNIT MOCK output drift\n");
		if (kind === "empty-pages" || kind === "empty-specs") {
			const path = join(
				f.manifest.source.workspace,
				"generated",
				kind === "empty-pages" ? "docs.json" : "oneiron-specs.json",
			);
			json(
				path,
				kind === "empty-pages"
					? { generated: true, pages: [] }
					: {
							$schema: "oneiron-specs/1",
							generated: true,
							generator: "scripts/emit-spec-manifest.mjs",
							specs: [],
							counts: { total: 0 },
							skipped: [],
						},
			);
			f.generation.generatedContentSha256 = oneironGateTree(join(f.manifest.source.workspace, "generated")).sha256;
			refresh(f);
		}
		if (kind === "missing-input") {
			f.generation.inputs = f.generation.inputs.slice(1);
			refresh(f);
		}
		if (kind === "operator-terminal") {
			const status = load<FactoryStatus>(f.generation.operator.status);
			status.attempts[0]!.claimReleased = false;
			f.generation.operator.status = json(f.generation.operator.status.path, status);
			refresh(f);
		}
		if (kind === "operator-log") write(f.generation.operator.stdout.path, "UNIT MOCK operator log drift\n");
		await expect(execute(f)).rejects.toThrow(
			/bytes changed|Ambiguous|dependency content|input content drift|Generated content|Nonempty real|all tracked|Operator proof|Operator retained log/,
		);
		expect(f.controls.captures).toBe(0);
		noReceipt(f);
	});
});

const seamCases: Array<{ name: string; change: (f: Fixture) => void; error: RegExp }> = [
	{
		name: "UNIT MOCK physical interlock",
		change: () => {
			interlockFault.held = false;
		},
		error: /UNIT MOCK physical interlock lost/,
	},
	{
		name: "source",
		change: (f) => {
			f.controls.source.branch = "UNIT-MOCK-drift";
		},
		error: /Source\/head\/tree\/branch\/remote CAS changed/,
	},
	{
		name: "owner pause",
		change: (f) => {
			write(f.manifest.ownerPauseFile, MOCK);
		},
		error: /Owner pause/,
	},
	{
		name: "factory pause",
		change: (f) => {
			f.state.paused = true;
		},
		error: /Factory pause/,
	},
	{
		name: "attempt custody",
		change: (f) => {
			f.state.attempts[0]!.claimReleased = true;
		},
		error: /owned runner/,
	},
	{
		name: "runtime bytes",
		change: (f) => {
			write(f.runtimeIdentity.cliArgv[1], `// ${MOCK} runtime drift\n`);
		},
		error: /native runtime component changed/,
	},
	{
		name: "toolchain pin",
		change: (f) => {
			write(f.stage.toolchain.path, `${readFileSync(f.stage.toolchain.path, "utf8")} `);
		},
		error: /Artifact hash changed/,
	},
	{
		name: "environment",
		change: () => {
			vi.stubEnv("NODE_OPTIONS", "--no-warnings");
		},
		error: /inherited gate environment/,
	},
	{
		name: "lock",
		change: (f) => {
			write(f.tools.lockfile.path, MOCK);
		},
		error: /lock bytes changed/,
	},
	{
		name: "dependency",
		change: (f) => {
			write(f.tools.dependencies.astro.path, `${ASTRO_FIXTURE}\n// UNIT MOCK drift\n`);
		},
		error: /dependency content changed/,
	},
	{
		name: "generation",
		change: (f) => {
			write(join(f.manifest.source.workspace, "generated/index.md"), MOCK);
		},
		error: /Generated content/,
	},
	{
		name: "manifest",
		change: (f) => {
			write(f.manifestPin.path, `${readFileSync(f.manifestPin.path, "utf8")} `);
		},
		error: /manifest\/permit changed/,
	},
	{
		name: "permit",
		change: (f) => {
			write(f.permitPin.path, `${readFileSync(f.permitPin.path, "utf8")} `);
		},
		error: /manifest\/permit changed/,
	},
];
describe("docs gate rechecks between substantive UNIT MOCK commands", () => {
	test.each(seamCases)("blocks $name drift after build without starting links", async ({ change, error }) => {
		const f = fixture();
		f.controls.afterCapture = (i) => {
			if (i === 0) change(f);
		};
		await expect(execute(f)).rejects.toThrow(error);
		expect(f.controls.captures).toBe(1);
		expect(existsSync(join(f.manifest.outputDirectory, "command-0.json"))).toBe(true);
		expect(existsSync(join(f.manifest.outputDirectory, "command-1.json"))).toBe(false);
		noReceipt(f);
	});

	test("capacity expiry after admission does not interrupt the still-owned stage", async () => {
		const f = fixture();
		f.controls.afterCapture = (i) => {
			if (i === 0) f.clock.now += 2000;
		};
		const receipt = await execute(f);
		expect(Date.parse(f.capacity.expiresAt)).toBeLessThan(f.clock.now);
		expect(f.controls.captures).toBe(2);
		expect(receipt.result.provenancePassed).toBe(true);
	});

	test.each(["permit", "custody"])("%s expiry after admission still blocks the next command", async (kind) => {
		const f = fixture();
		if (kind === "permit") f.permit.expiresAt = new Date(f.clock.now + 1000).toISOString();
		else
			f.manifest.custody = json(f.manifest.custody.path, {
				...load<Record<string, unknown>>(f.manifest.custody),
				expiresAt: new Date(f.clock.now + 1000).toISOString(),
			});
		f.rebind();
		f.controls.afterCapture = (i) => {
			if (i === 0) f.clock.now += 2000;
		};
		await expect(execute(f)).rejects.toThrow(
			kind === "permit" ? /expired or mismatched explicit execution permit/ : /fresh explicit custody transfer/,
		);
		expect(f.controls.captures).toBe(1);
		noReceipt(f);
	});

	test("rejects an empty built surface even after the real fixture builder exits zero", async () => {
		const f = fixture();
		f.controls.afterCapture = (i) => {
			if (i === 0) write(join(f.manifest.source.workspace, "site/dist/index.html"), "");
		};
		await expect(execute(f)).rejects.toThrow(/no nonempty real route surface/);
		expect(f.controls.captures).toBe(1);
		noReceipt(f);
	});

	test("the substantive fixture checker exits nonzero on a broken generated link", async () => {
		const f = fixture();
		write(join(f.manifest.source.workspace, "generated/index.md"), "# UNIT MOCK\n[Missing](/#absent)\n");
		f.generation.generatedContentSha256 = oneironGateTree(join(f.manifest.source.workspace, "generated")).sha256;
		refresh(f);
		await expect(execute(f)).rejects.toThrow(/exited 1/);
		expect(readFileSync(join(f.manifest.outputDirectory, "command-1.stderr"), "utf8")).toContain(
			"UNIT MOCK broken link",
		);
		noReceipt(f);
	});
});

describe("docs proof and terminal consumption from UNIT MOCK authority", () => {
	test("future-dated source blocks links before any implicit third build", async () => {
		const f = fixture();
		f.controls.afterCapture = (index) => {
			if (index === 0) {
				const path = join(f.manifest.source.workspace, "site/src/pages/index.astro");
				const future = new Date(Date.now() + 60_000);
				utimesSync(path, future, future);
			}
		};
		await expect(execute(f)).rejects.toThrow(/implicitly rebuild/);
		expect(f.controls.captures).toBe(1);
		noReceipt(f);
	});
	test.each(["changed", "missing"])("retained %s capacity cannot bind or be consumed", async (kind) => {
		const f = fixture(),
			receipt = await execute(f);
		terminal(f);
		if (kind === "missing") rmSync(f.stage.capacity.path);
		else writeFileSync(f.stage.capacity.path, "{}");
		expect(() => validateOneironDocsProof(receipt, readOneironPin)).toThrow();
		expect(() => validateOneironDocsTerminal(receipt, f.state, readOneironPin)).toThrow();
	});
	test("a real-shaped generic Core terminal cannot substitute native entry, environment, kind, host or slot", async () => {
		const f = fixture(),
			receipt = await execute(f);
		terminal(f);
		for (const change of [
			(a: FactoryStatus["actions"][number]) => {
				a.command.argv[5] = "/UNIT-MOCK-fake-entry.js";
			},
			(a: FactoryStatus["actions"][number]) => {
				a.command.env = { ...a.command.env, NODE_OPTIONS: "--import /UNIT-MOCK-evil.js" };
			},
			(a: FactoryStatus["actions"][number]) => {
				a.command.timeoutMs = 0;
			},
			(a: FactoryStatus["actions"][number]) => {
				a.kind = "process";
			},
			(a: FactoryStatus["actions"][number]) => {
				a.requirements.host = "mini";
			},
			(a: FactoryStatus["actions"][number]) => {
				a.requirements.slotId = "other";
			},
		]) {
			const state = structuredClone(f.state);
			change(state.actions[0]!);
			expect(() => validateOneironDocsTerminal(receipt, state, readOneironPin)).toThrow(/native entry/);
		}
	});
	test.each(["environment", "startup-env", "host", "slot"])(
		"operator %s cannot claim a controlled native preparation",
		async (kind) => {
			const f = fixture();
			const prep = load<{ operator: OneironDocsGeneration["operator"] }>(f.tools.dependencies.preparation);
			if (kind === "environment") prep.operator.environment.values.PATH = "/UNIT-MOCK-other-tools";
			if (kind === "host") prep.operator.host = "mini";
			if (kind === "slot") prep.operator.slotId = "wrong";
			if (kind === "startup-env") {
				const manifest = load<{ command: FactoryStatus["actions"][number]["command"] }>(prep.operator.manifest);
				manifest.command.env!.NODE_OPTIONS = "--import /UNIT-MOCK-evil.js";
				prep.operator.manifest = json(prep.operator.manifest.path, manifest);
				const status = load<FactoryStatus>(prep.operator.status);
				status.actions[0]!.command = manifest.command;
				prep.operator.status = json(prep.operator.status.path, status);
			}
			f.tools.dependencies.preparation = json(f.tools.dependencies.preparation.path, prep);
			refresh(f);
			await expect(execute(f)).rejects.toThrow(/Operator/);
			expect(f.controls.captures).toBe(0);
			noReceipt(f);
		},
	);

	test("publication consumption derives docs driver from the immutable prepared action even when receipt labels and proof are replaced", async () => {
		const f = fixture(),
			receipt = await execute(f);
		terminal(f);
		for (const both of [false, true]) {
			const replaced = structuredClone(receipt);
			delete replaced.result.driver;
			if (both)
				replaced.result.proof = json(join(f.directory, "UNIT-MOCK-fake-cargo-proof.json"), {
					driver: "cargo",
					manifest: f.manifestPin,
					status: "COMPLETED",
					command_rc: 0,
					workspace_root: f.manifest.source.workspace,
					command: ["cargo", "check"],
					provenance: { pass: true },
				});
			const consumer: OneironManifest = {
				...f.manifest,
				outputDirectory: join(f.directory, `consumer-${both}`),
				stage: {
					kind: "publish-ready",
					repo: "unit/mock",
					pr: 1,
					base: "main",
					gates: [json(join(f.directory, `UNIT-MOCK-replaced-${both}.json`), replaced)],
					editorial: json(join(f.directory, "editorial.json"), {}),
				},
			};
			const manifest = json(join(f.directory, `consumer-${both}.json`), consumer);
			const permit = json(join(f.directory, `consumer-permit-${both}.json`), {
				...f.permit,
				stage: consumer.stage.kind,
				manifestSha256: manifest.sha256,
			});
			await expect(executeOneiron(manifest.path, permit.path, true, f.runtime, manifest.sha256)).rejects.toThrow(
				/Docs proof/,
			);
		}
	});

	test("rejects altered binding, empty checks, incomplete probes, command substitution and invented coverage", async () => {
		const f = fixture();
		const receipt = await execute(f);
		const original = validateOneironDocsProof(receipt, readOneironPin);
		const mutations: Array<{ name: string; change: (proof: typeof original) => void }> = [
			{
				name: "physical fd",
				change: (p) => {
					p.interlock.fd = 999;
				},
			},
			{
				name: "physical inode",
				change: (p) => {
					p.interlock.inode = "999";
				},
			},
			{
				name: "physical device",
				change: (p) => {
					p.interlock.device = "999";
				},
			},
			{
				name: "physical pid",
				change: (p) => {
					p.interlock.pid = 999;
				},
			},
			{
				name: "physical runner directory",
				change: (p) => {
					p.interlock.runnerDirectory = "/different";
				},
			},
			{
				name: "physical evidence pin",
				change: (p) => {
					p.interlockEvidence.sha256 = "f".repeat(64);
				},
			},
			{
				name: "manifest hash",
				change: (p) => {
					p.manifestSha256 = "f".repeat(64);
				},
			},
			{
				name: "stage hash",
				change: (p) => {
					p.stageSha256 = "f".repeat(64);
				},
			},
			{
				name: "runtime",
				change: (p) => {
					p.runtime.sha256 = "f".repeat(64);
				},
			},
			{
				name: "source",
				change: (p) => {
					p.output.branch = "UNIT-MOCK-other-source";
				},
			},
			{
				name: "plan",
				change: (p) => {
					p.planSha256 = "f".repeat(64);
				},
			},
			{
				name: "empty checks",
				change: (p) => {
					p.checks = {};
				},
			},
			{
				name: "missing attempt",
				change: (p) => {
					p.attemptId = "";
				},
			},
			{
				name: "empty commands",
				change: (p) => {
					p.commands = [];
				},
			},
			{
				name: "missing probe",
				change: (p) => {
					p.probes.pop();
				},
			},
			{
				name: "wrong probe",
				change: (p) => {
					p.probes[0]!.argv = [NODE, "--version"];
				},
			},
			{
				name: "command override",
				change: (p) => {
					p.commands[1]!.argv = [BUN, "run", "export:agent"];
				},
			},
			{
				name: "environment override",
				change: (p) => {
					p.commands[0]!.environment!.SKIP_BUILD = "1";
				},
			},
			{
				name: "nonzero command",
				change: (p) => {
					p.commands[0]!.exitCode = 2;
				},
			},
			{
				name: "signal",
				change: (p) => {
					p.commands[0]!.signal = "SIGTERM";
				},
			},
			{
				name: "truncated stream",
				change: (p) => {
					p.commands[1]!.stdout.truncated = true;
				},
			},
			{
				name: "unobserved bytes",
				change: (p) => {
					p.commands[1]!.stdout.observedBytes++;
				},
			},
			{
				name: "wrong command order",
				change: (p) => {
					p.commands[1]!.startedAt = new Date(Date.parse(p.commands[0]!.finishedAt) - 1).toISOString();
				},
			},
			{
				name: "empty coverage",
				change: (p) => {
					p.coverage.linksScanned = 0;
					p.coverage.astroHrefs = 0;
				},
			},
			{
				name: "inflated coverage",
				change: (p) => {
					p.coverage.generatedPages++;
				},
			},
			{
				name: "hidden limitations",
				change: (p) => {
					p.coverage.limitations = [];
				},
			},
		];
		for (const { name, change } of mutations) {
			const proof = structuredClone(original);
			change(proof);
			const proofPin = json(join(f.directory, "UNIT-MOCK-tampered-proof.json"), proof);
			expect(
				() =>
					validateOneironDocsProof({ ...receipt, result: { ...receipt.result, proof: proofPin } }, readOneironPin),
				name,
			).toThrow();
		}
		expect(() => validateOneironDocsProof(receipt, readOneironPin)).not.toThrow();
	});

	test("rejects raw logs, dependency, generation and built content changed after execution", async () => {
		const f = fixture();
		const receipt = await execute(f);
		const proof = validateOneironDocsProof(receipt, readOneironPin);
		for (const path of [
			proof.commands[0]!.stderr!.path,
			proof.commands[1]!.stdout.path,
			proof.probes[0]!.stdout.path,
			f.tools.lockfile.path,
			f.tools.dependencies.astro.path,
			f.generation.operator.stdout.path,
			f.generation.inputs[0]!.path,
			join(f.manifest.source.workspace, "generated/index.md"),
			join(f.manifest.source.workspace, "site/dist/index.html"),
		]) {
			const bytes = readFileSync(path);
			try {
				writeFileSync(path, Buffer.concat([bytes, Buffer.from("\nUNIT MOCK post-execution drift\n")]));
				expect(() => validateOneironDocsProof(receipt, readOneironPin), path).toThrow();
			} finally {
				writeFileSync(path, bytes);
			}
		}
		expect(() => validateOneironDocsProof(receipt, readOneironPin)).not.toThrow();
	});

	test("re-derives link coverage rather than trusting rehashed count claims", async () => {
		const f = fixture();
		const receipt = await execute(f);
		const proof = validateOneironDocsProof(receipt, readOneironPin);
		const stream = proof.commands[1]!.stdout;
		const altered = readFileSync(stream.path, "utf8").replace("(1 internal links)", "(2 internal links)");
		writeFileSync(stream.path, altered);
		Object.assign(stream, {
			sha256: hashFactoryRuntimeFile(stream.path),
			bytes: Buffer.byteLength(altered),
			observedBytes: Buffer.byteLength(altered),
			preview: altered,
		});
		const proofPin = json(join(f.directory, "UNIT-MOCK-rehashed-proof.json"), proof);
		expect(() =>
			validateOneironDocsProof({ ...receipt, result: { ...receipt.result, proof: proofPin } }, readOneironPin),
		).toThrow(/durable capture summary/);
		// Also alter the UNIT MOCK summary to reach the independent real-log coverage discriminator.
		json(join(f.manifest.outputDirectory, "command-1.json"), proof.commands[1]);
		expect(() =>
			validateOneironDocsProof({ ...receipt, result: { ...receipt.result, proof: proofPin } }, readOneironPin),
		).toThrow(/coverage differs/);
	});

	test("rejects failed, held, stale and rebound outer terminals despite a valid inner proof", async () => {
		const f = fixture();
		const receipt = await execute(f);
		terminal(f);
		const original = structuredClone(f.state);
		const mutations: Array<(state: typeof original) => void> = [
			(s) => {
				s.attempts[0]!.claimReleased = false;
			},
			(s) => {
				s.attempts[0]!.state = "UNCERTAIN";
			},
			(s) => {
				s.attempts[0]!.uncertainty = MOCK;
			},
			(s) => {
				s.attempts[0]!.receipt!.exitCode = 1;
			},
			(s) => {
				s.attempts[0]!.receipt!.attemptId = "other-unit-mock-attempt";
			},
			(s) => {
				s.attempts[0]!.receipt!.sourceFingerprint = `git:${"f".repeat(64)}`;
			},
			(s) => {
				s.attempts[0]!.receipt!.artifact!.sourceFingerprint = `git:${"f".repeat(64)}`;
			},
			(s) => {
				s.actions[0]!.state = "RUNNING";
			},
			(s) => {
				s.actions[0]!.ticketId = "OTHER-UNIT-MOCK";
			},
			(s) => {
				s.actions[0]!.sourceFingerprint = `git:${"f".repeat(64)}`;
			},
			(s) => {
				const argv = s.actions[0]!.command.argv;
				argv[argv.length - 2] = "f".repeat(64);
			},
			(s) => {
				const argv = s.actions[0]!.command.argv;
				argv[argv.length - 4] = join(f.directory, "other-manifest.json");
			},
			(s) => {
				s.attempts.push({ ...s.attempts[0]!, id: "newer-unit-mock-attempt" });
			},
		];
		for (const change of mutations) {
			const state = structuredClone(original);
			change(state);
			expect(() => validateOneironDocsTerminal(receipt, state, readOneironPin)).toThrow(
				/outer CommandAdapter terminal/,
			);
		}
		expect(() => validateOneironDocsTerminal(receipt, original, readOneironPin, "other-unit-mock-attempt")).toThrow(
			/outer CommandAdapter terminal/,
		);
		expect(() => validateOneironDocsTerminal(receipt, original, readOneironPin)).not.toThrow();
		interlockFault.terminalValid = false;
		expect(() => validateOneironDocsTerminal(receipt, original, readOneironPin)).toThrow(
			/UNIT MOCK retained interlock invalid/,
		);
	});

	test("completed evidence reuse needs its old successful outer terminal and runs no new commands", async () => {
		const f = fixture();
		await execute(f);
		const receiptPath = join(f.manifest.outputDirectory, "receipt.json");
		const receiptPin = { path: receiptPath, sha256: hashFactoryRuntimeFile(receiptPath) };
		const reuse = { ...f.manifest, completed: receiptPin };
		const reusePin = json(join(f.directory, "reuse-manifest.json"), reuse);
		const permitPin = json(join(f.directory, "reuse-permit.json"), { ...f.permit, manifestSha256: reusePin.sha256 });
		await expect(executeOneiron(reusePin.path, permitPin.path, true, f.runtime, reusePin.sha256)).rejects.toThrow(
			/outer CommandAdapter terminal/,
		);
		terminal(f);
		await expect(executeOneiron(reusePin.path, permitPin.path, true, f.runtime, reusePin.sha256)).resolves.toEqual({
			reused: receiptPin,
		});
		expect(f.controls.captures).toBe(2);
	});

	test.each(["empty", "degraded", "rebuilt"])(
		"rejects %s link evidence after the substantive checker ran",
		async (kind) => {
			const f = fixture();
			f.controls.afterCapture = (i) => {
				if (i !== 1) return;
				const stdout = join(f.manifest.outputDirectory, "command-1.stdout");
				if (kind === "empty") write(stdout, "");
				if (kind === "degraded")
					write(stdout, `${readFileSync(stdout, "utf8")}Falling back: UNIT MOCK degraded coverage\n`);
				if (kind === "rebuilt")
					write(join(f.manifest.source.workspace, "site/dist/index.html"), "UNIT MOCK link-time rebuild\n");
			};
			await expect(execute(f)).rejects.toThrow(
				/Nonempty real build\/link checks|degraded\/skipped\/rebuilt|Links rebuilt/,
			);
			noReceipt(f);
		},
	);
});
