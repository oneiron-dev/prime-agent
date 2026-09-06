import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statfsSync,
	statSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { availableParallelism, freemem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { CommandAdapter, type CommandHost, fingerprintCommand } from "../src/factory/adapters/command.js";
import {
	bindOneironEvidence,
	type OneironManifest,
	type OneironPermit,
	type OneironReceipt,
	type OneironSource,
	prepareOneiron,
	readOneironPin,
} from "../src/factory/adapters/oneiron.js";
import {
	ONEIRON_DOCS_ENTRY_ENVIRONMENT,
	ONEIRON_GATE_CAPABILITIES,
	ONEIRON_GATE_LIMITS,
	type OneironDocsGateStage,
	type OneironDocsGeneration,
	type OneironDocsToolchain,
	oneironDocsPlan,
	oneironGateTree,
	validateOneironDocsProof,
	validateOneironDocsTerminal,
} from "../src/factory/adapters/oneiron-docs-gate.js";
import type { OneironPin } from "../src/factory/adapters/oneiron-review.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { type FactoryRuntimeIdentity, hashFactoryRuntimeFile } from "../src/factory/runtime.js";
import { FactoryStore } from "../src/factory/store.js";
import type { CompletionReceipt, FactoryStatus } from "../src/factory/types.js";

// Native source-loader fixture only, NOT installed-runtime or production docs proof.
// Real Git, transferred fixture custody, live isolated FactoryStore, default CommandAdapter,
// actual Oneiron entry/runtime, Bun/Node and own-FD/kernel flock authority.
// ONLY the faux Astro/dependencies and prior preparation/export operator inputs are UNIT MOCK.
// No model/network/install/export command is run; no shared live slot or database is touched.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const SELF = fileURLToPath(import.meta.url);
const TSX_API = fileURLToPath(import.meta.resolve("tsx/esm/api"));
const VITEST = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "vitest.mjs");
const MARKER = "PRIME_TEST_PRIVATE_DOCS_NAMESPACE";
const BUN = "/home/lexi/.bun/bin/bun";
const NODE = "/usr/bin/node";
const BUN_SHA = "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74";
const NODE_SHA = "9d8258596e68031047c70637ed9ba2f0becea28258763a9cb6934b85e0c5a3b9";
const FLOCK = { path: "/usr/bin/flock", sha256: "50664fb52caf53215f0974d84e40e3d94783ec9b980bbfe8946911f2a628c3fe" };
const MOCK = "UNIT MOCK — not production docs evidence";
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
	const environment: { launcher: OneironPin; values: Record<string, string> } = {
		launcher: { path: "/usr/bin/env", sha256: hashFactoryRuntimeFile("/usr/bin/env") },
		values: {
			PATH: [dirname(realpathSync(BUN)), dirname(realpathSync(NODE))].join(":"),
			HOME: join(root, "home"),
			TMPDIR: join(root, "tmp"),
			CI: "1",
			NO_COLOR: "1",
			ASTRO_TELEMETRY_DISABLED: "1",
			GIT_OPTIONAL_LOCKS: "0",
			...(name === "preparation" ? { BUN_INSTALL_CACHE_DIR: join(root, "cache") } : {}),
		},
	};
	const recordedCommand = {
		argv: [
			environment.launcher.path,
			"--ignore-environment",
			...Object.entries(environment.values)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => `${key}=${value}`),
			...command.argv,
		],
		cwd: command.cwd,
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
				command: recordedCommand,
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
			environment,
			manifest: json(join(root, "manifest.json"), {
				fixture: MOCK,
				version: 1,
				attemptId: receipt.attemptId,
				sourceFingerprint: input,
				command: recordedCommand,
			}),
			status: json(join(root, "status.json"), status),
			stdout: write(join(root, "stdout.log"), `${MOCK}: operator did not actually run\n`),
			stderr: write(join(root, "stderr.log"), ""),
		},
	};
}

async function fixture(directory: string, hangBuild = false) {
	const workspace = join(directory, "workspace");
	mkdirSync(workspace);
	const host: CommandHost = { type: "local", runnerRoot: join(directory, "runner"), python: "/usr/bin/python3" };
	const git = (...args: string[]) =>
		execFileSync("/usr/bin/git", ["-C", workspace, ...args], {
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
		}).trim();
	git("init", "-q", "-b", "native-docs-fixture");
	git("remote", "add", "origin", "https://example.invalid/native-docs-fixture.git");
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
	const ignore = write(join(workspace, ".gitignore"), "site/node_modules/\nsite/dist/\n");
	const depsRoot = join(workspace, "site/node_modules");
	json(join(depsRoot, "astro/package.json"), {
		name: "astro",
		version: "0.0.0-unit-mock",
		description: MOCK,
		type: "module",
		bin: "astro.mjs",
	});
	const astro = write(
		join(depsRoot, "astro/astro.mjs"),
		ASTRO_FIXTURE +
			(hangBuild
				? `
// UNIT MOCK forced watchdog: actual native builder deliberately stays alive.
writeFileSync(${JSON.stringify(join(directory, "forced-build-ready.json"))}, JSON.stringify({pid:process.pid, purpose:"forced native Core watchdog fixture"}));
setInterval(()=>{},1000);
`
				: ""),
	);
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

	git("add", ".");
	git(
		"-c",
		"user.name=Native Docs Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"isolated faux docs source",
	);
	const source: OneironSource = {
		workspace,
		head: git("rev-parse", "HEAD"),
		tree: git("rev-parse", "HEAD^{tree}"),
		branch: git("rev-parse", "--abbrev-ref", "HEAD"),
		remoteUrl: git("remote", "get-url", "origin"),
		fingerprint: await fingerprintCommand(host, workspace),
	};
	const inputs = [page, data, rootPackage, sitePackage, checker, ignore, lockfile];
	const expiresAt = new Date(Date.now() + 300_000).toISOString();
	const ownerAuthorization = json(join(directory, "authorization.json"), {
		fixtureOnly: true,
		permission: "execute this isolated deterministic gate once; no product acceptance",
	});
	const release = json(join(directory, "release.json"), {
		fixtureOnly: true,
		owner: "fixture-prior",
		released: true,
		sourceFingerprint: source.fingerprint,
	});
	const custody = json(join(directory, "custody.json"), {
		version: 1,
		state: "transferred",
		ticketId: "NATIVE-DOCS-FIXTURE",
		owner: "fixture-owner",
		sourceFingerprint: source.fingerprint,
		expiresAt,
		priorOwners: [{ id: "fixture-prior", release }],
		activeOwners: ["fixture-owner"],
		liveProcesses: [],
		duplicateAuthorityDisabled: true,
		sharedGitClear: true,
	});
	// Loader frontdoors have no substitute gate/status logic and cannot launch an installed runtime.
	const runtimeRoot = join(directory, "source-loader-runtime");
	json(join(runtimeRoot, "package.json"), {
		type: "module",
		description: "test source-loader only; not an installed release",
	});
	const entrySource = join(PACKAGE_ROOT, "src/factory/adapters/oneiron-entry.ts");
	const cliSource = join(PACKAGE_ROOT, "src/factory/cli.ts");
	const loaderHeader = `// Test-only source loader. Not installed-runtime proof.\nimport { register } from ${JSON.stringify(pathToFileURL(TSX_API).href)};\nregister({ tsconfig: ${JSON.stringify(join(REPO_ROOT, "tsconfig.json"))} });\n`;
	const entry = write(
		join(runtimeRoot, "factory/adapters/oneiron-entry.js"),
		loaderHeader +
			`const { runOneironCli } = await import(${JSON.stringify(pathToFileURL(entrySource).href)});\ntry { console.log(JSON.stringify(await runOneironCli(process.argv.slice(2)), null, 2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }\n`,
	);
	const cli = write(
		join(runtimeRoot, "cli.js"),
		loaderHeader +
			`const { runFactoryCli } = await import(${JSON.stringify(pathToFileURL(cliSource).href)});\nif (process.argv[2] !== "factory") throw Error("test frontdoor supports native factory CLI only");\ntry { await runFactoryCli(process.argv.slice(3)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }\n`,
	);
	const sourceModules = (root: string): string[] =>
		readdirSync(root, { withFileTypes: true }).flatMap((item) => {
			const path = join(root, item.name);
			return item.isDirectory() ? sourceModules(path) : /\.(?:ts|py)$/.test(item.name) ? [path] : [];
		});
	const runtimeIdentity: FactoryRuntimeIdentity = {
		version: 1,
		cliArgv: [NODE, cli.path],
		files: [
			NODE,
			cli.path,
			entry.path,
			TSX_API,
			join(REPO_ROOT, "tsconfig.json"),
			join(REPO_ROOT, "package-lock.json"),
			...sourceModules(join(PACKAGE_ROOT, "src/factory")),
		].map((path) => ({ path, sha256: hashFactoryRuntimeFile(path) })),
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
		ticketId: "NATIVE-DOCS-FIXTURE",
		owner: "fixture-owner",
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
	const isolation = JSON.parse(readFileSync(join(directory, "namespace.json"), "utf8"));
	const resources = {
		cpus: availableParallelism(),
		freeMemoryBytes: freemem(),
		privateTmpFreeBytes: statfsSync("/tmp").bavail * statfsSync("/tmp").bsize,
	};
	const duplicateFree =
		readlinkSync("/proc/self/ns/mnt") === isolation.namespace &&
		isolation.namespace !== isolation.parentNamespace &&
		!existsSync("/tmp/oneiron-wave6-cargo-slot-1.lock");
	const resourcesPassed =
		resources.cpus > 0 &&
		resources.freeMemoryBytes > 64 * 1024 * 1024 &&
		resources.privateTmpFreeBytes > 16 * 1024 * 1024;
	expect(duplicateFree && resourcesPassed).toBe(true);
	const capacity = {
		fixture: "actual isolated fixture capacity; not production docs evidence",
		isolation,
		resources,
		status: "PASS",
		sourceFingerprint: source.fingerprint,
		host: stage.host,
		slot: stage.slot,
		duplicateFree,
		resourcesPassed,
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		planSha256: oneironDocsPlan(manifest, stage, tools).planSha256,
	};
	stage.capacity = json(join(directory, "fixture-capacity.json"), capacity);
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
		ownerAuthorization,
		expiresAt,
	};
	const permitPin = json(join(directory, "permit.json"), permit);
	const prepared = prepareOneiron(manifest, {
		manifestPath: manifestPin.path,
		adapterArgv: [NODE, entry.path],
		permitPath: permitPin.path,
		host: "arch",
		slotId: "native-docs-slot",
	});
	if (!prepared.action) throw new Error("UNIT MOCK needs a fresh action");

	expect(prepared.action.command.timeoutMs).toBe(3600000); // Keep the production command contract; test watchdog is separate.
	json(join(manifest.factoryDirectory, "config.json"), {
		version: 1,
		hosts: { arch: host },
		pauseFile: manifest.ownerPauseFile,
	});
	const store = new FactoryStore(join(manifest.factoryDirectory, "factory.db"));
	const adapter = new CommandAdapter({ arch: host }, { pauseFile: manifest.ownerPauseFile });
	const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile: manifest.ownerPauseFile });
	engine.applyPlan({
		version: 1,
		tickets: [{ id: manifest.ticketId, owner: manifest.owner }],
		slots: [{ id: "native-docs-slot", host: "arch" }],
		actions: [prepared.action],
	});
	return {
		directory,
		manifest,
		manifestPin,
		permitPin,
		stage,
		tools,
		runtimeIdentity,
		entry,
		host,
		store,
		engine,
		action: prepared.action,
		git,
	};
}

function awaitTerminal(directory: string): Promise<void> {
	const path = join(directory, "terminal.json");
	if (existsSync(path)) return Promise.resolve();
	return new Promise((resolveReady, reject) => {
		const watcher = watch(directory, () => {
			if (existsSync(path)) finish();
		});
		const timer = setTimeout(() => finish(new Error(`No native terminal: ${directory}`)), 70_000);
		const finish = (error?: Error) => {
			watcher.close();
			clearTimeout(timer);
			if (error) reject(error);
			else resolveReady();
		};
		watcher.once("error", finish);
		if (existsSync(path)) finish();
	});
}

async function directEntryWithoutCore(f: Awaited<ReturnType<typeof fixture>>) {
	const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveExit, reject) => {
		const child = spawn(NODE, f.action.command.argv.slice(5), {
			cwd: f.manifest.source.workspace,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				...ONEIRON_DOCS_ENTRY_ENVIRONMENT,
				PRIME_FACTORY_ATTEMPT_ID: "",
				PRIME_FACTORY_SOURCE_FINGERPRINT: "",
			},
		});
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("direct entry timed out"));
		}, 15_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolveExit({ code, stdout, stderr });
		});
	});
	json(join(f.directory, "direct-no-Core-result.json"), result);
	expect(result.code, result.stderr).toBe(1);
	expect(result.stderr).toMatch(/current owned runner/);
	expect(f.store.attempts()).toEqual([]);
	expect(existsSync(join(f.manifest.source.workspace, "site/dist"))).toBe(false);
	expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
}

async function busyPrivateSlot(directory: string, isolation: unknown) {
	const busyDirectory = join(directory, "busy-private-slot");
	json(join(busyDirectory, "namespace.json"), isolation);
	const f = await fixture(busyDirectory);
	const holder = spawn(
		"/usr/bin/flock",
		[
			"--nonblock",
			"--no-fork",
			"/tmp/oneiron-wave6-cargo-slot-1.lock",
			NODE,
			"-e",
			"process.stdout.write('held\\n'); process.stdin.resume()",
		],
		{
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const holderClosed = new Promise<number | null>((resolveExit, reject) => {
		holder.once("close", resolveExit);
		holder.once("error", reject);
	});
	try {
		await new Promise<void>((ready, reject) => {
			const timer = setTimeout(() => reject(new Error("private holder did not acquire lock")), 10_000);
			holder.stdout.once("data", (chunk: Buffer) => {
				clearTimeout(timer);
				if (chunk.toString() === "held\n") ready();
				else reject(new Error("unexpected holder output"));
			});
			holder.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			holder.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`private holder exited early: ${code}`));
			});
		});
		await directEntryWithoutCore(f);
		const tick = await f.engine.tick();
		expect(tick.launched).toHaveLength(1);
		const runnerDirectory = join(f.host.runnerRoot, tick.launched[0]!);
		await awaitTerminal(runnerDirectory);
		await f.engine.tick();
		const attempt = f.store.attempts()[0]!;
		expect(attempt.state).toBe("TERMINAL");
		expect(attempt.receipt?.exitCode).toBe(1);
		expect(attempt.claimReleased).toBe(true);
		expect(existsSync(join(f.manifest.source.workspace, "site/dist"))).toBe(false);
		expect(existsSync(join(f.manifest.outputDirectory, "receipt.json"))).toBe(false);
		expect(existsSync(join(f.manifest.outputDirectory, "gate-provenance.json"))).toBe(false);
		expect(readFileSync(join(runnerDirectory, "stdout.log"), "utf8")).toBe("");
		json(join(busyDirectory, "busy-result.json"), {
			result: "BUSY private physical slot denied before Bun",
			holderPid: holder.pid,
			namespace: isolation,
			status: f.engine.status(),
			runnerDirectory,
		});
	} finally {
		holder.stdin.end();
		expect(await holderClosed).toBe(0);
		f.store.close();
	}
}

function requirePrivateFixtureNamespace(directory: string) {
	const isolation = JSON.parse(readFileSync(join(directory, "namespace.json"), "utf8"));
	expect(readlinkSync("/proc/self/ns/mnt")).toBe(isolation.namespace);
	expect(isolation.namespace).not.toBe(isolation.parentNamespace);
	expect(isolation.privateTmp).toMatch(/ - tmpfs oneiron-native-docs-fixture /);
	expect(isolation.privateTmp).not.toMatch(/ shared:/);
	expect(statSync("/tmp").dev).not.toBe(isolation.parentTmpDevice);
	expect(readlinkSync("/proc/self/ns/pid")).toBe(isolation.pidNamespace);
	expect(isolation.pidNamespace).not.toBe(isolation.parentPidNamespace);
	const actualTmp = readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")
		.filter((line) => line.split(" ")[4] === "/tmp")
		.at(-1);
	expect(actualTmp).toBe(isolation.privateTmp);
	expect(readFileSync("/proc/1/cmdline", "utf8").split("\0").filter(Boolean)).toEqual([
		NODE,
		join(directory, "namespace-bootstrap.mjs"),
	]);
	// This is the first fixture operation that can reach fixed physical lock paths.
	expect(existsSync("/tmp/oneiron-wave6-cargo-slot-1.lock")).toBe(false);
	return isolation;
}

async function nativeGate(directory: string) {
	const isolation = requirePrivateFixtureNamespace(directory);
	const f = await fixture(directory);
	try {
		await busyPrivateSlot(directory, isolation);
		expect(f.action.command.argv).toEqual([
			"/usr/bin/flock",
			"--nonblock",
			"--no-fork",
			"/tmp/oneiron-wave6-cargo-slot-1.lock",
			NODE,
			f.entry.path,
			"execute",
			f.manifestPin.path,
			f.permitPin.path,
			f.manifestPin.sha256,
			"--execute",
		]);
		expect(f.action.command.env).toEqual(ONEIRON_DOCS_ENTRY_ENVIRONMENT);
		const tick = await f.engine.tick();
		expect(tick.launched, JSON.stringify(f.engine.status())).toHaveLength(1);
		const attemptId = tick.launched[0]!;
		const runnerDirectory = join(f.host.runnerRoot, attemptId);
		await awaitTerminal(runnerDirectory);
		expect((await f.engine.tick()).launched).toEqual([]);
		const state = f.engine.status();
		const attempt = state.attempts[0]!;
		const stdout = readFileSync(join(runnerDirectory, "stdout.log"), "utf8");
		const stderr = readFileSync(join(runnerDirectory, "stderr.log"), "utf8");
		console.log(
			JSON.stringify({
				namespace: isolation,
				action: f.action,
				attempt,
				runnerStdout: stdout,
				runnerStderr: stderr,
			}),
		);
		expect(attempt.state).toBe("TERMINAL");
		expect(attempt.claimReleased).toBe(true);
		expect(attempt.receipt?.exitCode, stderr).toBe(0);
		expect(attempt.receipt?.artifact?.sourceFingerprint).toBe(f.manifest.source.fingerprint);
		const receiptPin = {
			path: join(f.manifest.outputDirectory, "receipt.json"),
			sha256: hashFactoryRuntimeFile(join(f.manifest.outputDirectory, "receipt.json")),
		};
		const receipt = load<OneironReceipt>(receiptPin);
		const proof = validateOneironDocsProof(receipt, readOneironPin);
		expect(() => validateOneironDocsTerminal(receipt, state, readOneironPin, attemptId)).not.toThrow();
		expect(bindOneironEvidence(state, f.action.id, f.manifest, receiptPin).attemptId).toBe(attemptId);
		expect(receipt.productAccepted).toBe(false);
		expect(receipt.input).toEqual(f.manifest.source);
		expect(receipt.output).toEqual(f.manifest.source);
		expect(proof.commands.map((command) => command.argv)).toEqual([
			[BUN, "run", "build"],
			[BUN, "run", "check:links"],
		]);
		expect(proof.commands.every((command) => command.exitCode === 0 && command.signal === null)).toBe(true);
		expect(proof.probes).toHaveLength(6);
		for (const [index, probe] of proof.probes.entries()) {
			expect(readFileSync(probe.stdout.path, "utf8").trim()).toBe(index % 2 === 0 ? "1.3.14" : "v26.2.0");
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
		const held = proof.interlock;
		const started = JSON.parse(readFileSync(join(runnerDirectory, "started.json"), "utf8"));
		const child = JSON.parse(readFileSync(join(runnerDirectory, "child.json"), "utf8"));
		const runnerManifest = JSON.parse(readFileSync(join(runnerDirectory, "manifest.json"), "utf8"));
		const lock = statSync(held.lockPath, { bigint: true });
		expect(held).toMatchObject({
			version: 1,
			kind: "linux-flock-v1",
			binary: FLOCK,
			slot: 1,
			attemptId,
			runnerDirectory,
			pid: child.pid,
			processIdentity: child.processIdentity,
			parentPid: started.pid,
			parentProcessIdentity: started.processIdentity,
			device: String(lock.dev),
			inode: String(lock.ino),
		});
		expect(held.fd).toBeGreaterThanOrEqual(0);
		expect(held.pid).toBeGreaterThan(0);
		expect(held.kernelRecord).toMatch(new RegExp(`^lock:.*FLOCK\\s+ADVISORY\\s+WRITE\\s+${child.pid} `));
		expect(runnerManifest.command).toEqual(f.action.command);
		expect(started.processIdentity).toBe(attempt.processIdentity);
		expect(f.git("status", "--porcelain")).toBe("");
		expect(await fingerprintCommand(f.host, f.manifest.source.workspace)).toBe(f.manifest.source.fingerprint);
		// The original no-fork owner has terminated, so another native flock can acquire this private inode.
		expect(execFileSync("/usr/bin/flock", ["--nonblock", held.lockPath, "/usr/bin/true"]).length).toBe(0);
		json(join(directory, "native-result.json"), {
			proofScope: "source-loader-only; no productioninstalledproof or productiondocsproof",
			unitMockInputs: ["faux Astro/dependencies", "preparation", "generation"],
			namespace: isolation,
			receipt,
			proof,
			status: state,
			runtime: f.runtimeIdentity,
		});
		console.log(
			JSON.stringify({
				result: "PASS",
				proofScope: "source-loader-only",
				interlock: held,
				coverage: proof.coverage,
				artifactDirectory: directory,
			}),
		);
	} finally {
		f.store.close();
	}
}

async function nativeForcedTimeout(directory: string) {
	requirePrivateFixtureNamespace(directory);
	const f = await fixture(directory, true);
	try {
		const tick = await f.engine.tick();
		expect(tick.launched).toHaveLength(1);
		const runnerDirectory = join(f.host.runnerRoot, tick.launched[0]!);
		json(join(directory, "forced-Core-started.json"), {
			scope: "forced teardown fixture, not a completed gate",
			runnerDirectory,
			action: f.action,
			status: f.engine.status(),
		});
		await awaitTerminal(runnerDirectory);
		throw Error("Forced hanging builder must be torn down by the outer watchdog, not complete");
	} finally {
		f.store.close();
	}
}

// Host-side evidence, after native unshare closes. PID1 exit in the private PID namespace
// kills even detached Core descendants. A failed/ambiguous scan must retain all artifacts.
function processStart(pid: string) {
	const text = readFileSync(`/proc/${pid}/stat`, "utf8");
	const start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
	if (!start || !/^\d+$/.test(start)) throw Error(`invalid process identity ${pid}`);
	return start;
}
function preexistingProcessStarts() {
	const starts = new Map<string, string>();
	const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	if (pids.length > 32768) throw Error("host /proc baseline bound exceeded");
	for (const pid of pids) {
		try {
			if (statSync(`/proc/${pid}`).uid === process.getuid?.()) starts.set(pid, processStart(pid));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return starts;
}
function namespaceMembers(namespace: string, preexisting: Map<string, string>) {
	const live: number[] = [],
		errors: string[] = [],
		excludedPreexisting: { pid: string; start: string }[] = [];
	const pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	if (pids.length > 32768) return { live, errors: ["host /proc inspection bound exceeded"], excludedPreexisting };
	for (const pid of pids) {
		try {
			if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
			if (readlinkSync(`/proc/${pid}/ns/pid`) === namespace) live.push(Number(pid));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") continue;
			// A process's own PID namespace cannot change during its lifetime. An exact
			// pre-fork identity cannot belong to this newly created PID namespace, even
			// if unrelated host security policy makes its namespace link unreadable.
			if (code === "EACCES") {
				try {
					const start = processStart(pid);
					if (preexisting.get(pid) === start) {
						excludedPreexisting.push({ pid, start });
						continue;
					}
				} catch (identityError) {
					if ((identityError as NodeJS.ErrnoException).code === "ENOENT") continue;
				}
			}
			errors.push(`${pid}:${String(error)}`);
		}
	}
	return { live, errors, excludedPreexisting };
}

async function privateNamespace(forceTimeout = false) {
	const reports = process.env.ONEIRON_NATIVE_DOCS_REPORT_DIRECTORY;
	if (reports) mkdirSync(reports, { recursive: true });
	// The worker's files must remain visible after its private tmpfs hides host /tmp.
	const requestedRoot = realpathSync(tmpdir()); // Keep all Git/build/DB fixture bytes in the caller's HDD TMPDIR, not the report spool.
	const root = requestedRoot === "/tmp" || requestedRoot.startsWith("/tmp/") ? "/var/tmp" : requestedRoot;
	const directory = realpathSync(mkdtempSync(join(root, "native-default-docs-artifacts-")));
	const parentNamespace = readlinkSync("/proc/self/ns/mnt");
	const parentPidNamespace = readlinkSync("/proc/self/ns/pid");
	const preexisting = preexistingProcessStarts();
	json(join(directory, "pre-fork-process-identities.json"), Object.fromEntries(preexisting));
	const parentTmpDevice = statSync("/tmp").dev;
	const bootstrap = write(
		join(directory, "namespace-bootstrap.mjs"),
		`
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
const directory = ${JSON.stringify(directory)};
const parentNamespace = ${JSON.stringify(parentNamespace)};
const parentTmpDevice = ${JSON.stringify(parentTmpDevice)};
const parentPidNamespace=${JSON.stringify(parentPidNamespace)};
const pidNamespace=readlinkSync("/proc/self/ns/pid");
if(process.pid!==1 || pidNamespace===parentPidNamespace) throw Error("refusing non-private PID1");
const namespace = readlinkSync("/proc/self/ns/mnt");
if (namespace === parentNamespace) throw Error("refusing host mount namespace");
execFileSync("/usr/bin/mount", ["--make-rprivate", "/"]);
execFileSync("/usr/bin/mount", ["-t", "tmpfs", "-o", "mode=1777,size=128m,nosuid,nodev", "oneiron-native-docs-fixture", "/tmp"]);
const privateTmp = readFileSync("/proc/self/mountinfo", "utf8").split("\\n").filter(line => line.split(" ")[4] === "/tmp").at(-1);
if (!privateTmp?.includes(" - tmpfs oneiron-native-docs-fixture ") || privateTmp.includes(" shared:") || statSync("/tmp").dev === parentTmpDevice) throw Error("refusing nonprivate /tmp");
const isolation = { parentNamespace, namespace, parentPidNamespace,pidNamespace, parentTmpDevice, privateTmp, pid: process.pid, proofBeforeLock: true };
writeFileSync(directory + "/namespace.json", JSON.stringify(isolation));
console.log("PRIVATE NAMESPACE BEFORE LOCK " + JSON.stringify(isolation));
const child = spawn(${JSON.stringify(NODE)}, [${JSON.stringify(VITEST)}, "run", ${JSON.stringify(SELF)}, "--maxWorkers=1", "--no-file-parallelism"], {
 cwd: ${JSON.stringify(PACKAGE_ROOT)}, stdio: "inherit", env: { ...process.env, ${MARKER}: directory, PRIME_TEST_DOCS_FORCED_WATCHDOG:${JSON.stringify(forceTimeout ? "1" : "0")} }
});
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? 1; if (signal) console.error(signal); });
`,
	);
	let output = "",
		forced = false,
		verifiedClosed = false,
		passed = false,
		watchdogFiredAt: number | null = null,
		closedAt: number | null = null;
	try {
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolveExit, reject) => {
				const child = spawn(
					"/usr/bin/unshare",
					[
						"--user",
						"--map-root-user",
						"--mount",
						"--pid",
						"--mount-proc",
						"--fork",
						"--kill-child=SIGKILL",
						NODE,
						bootstrap.path,
					],
					{
						cwd: PACKAGE_ROOT,
						stdio: ["ignore", "pipe", "pipe"],
						env: {
							...process.env,
							TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"),
							NODE_OPTIONS: "",
							npm_config_cache: "",
							BUN_INSTALL: "",
							GIT_CONFIG_NOSYSTEM: "1",
							GIT_CONFIG_GLOBAL: "/dev/null",
						},
					},
				);
				child.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				child.stderr.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});
				const stop = () => {
					if (forced) return;
					forced = true;
					watchdogFiredAt = performance.now();
					// unshare may mask SIGTERM while waiting. Killing this exact owned
					// wrapper triggers its --kill-child PDEATHSIG, then PID1 teardown.
					child.kill("SIGKILL");
				};
				const timer = setTimeout(stop, 100_000);
				let watcher: ReturnType<typeof watch> | undefined;
				child.once("error", (error) => {
					clearTimeout(timer);
					watcher?.close();
					reject(error);
				});
				child.once("close", (code, signal) => {
					closedAt = performance.now();
					clearTimeout(timer);
					watcher?.close();
					resolveExit({ code, signal });
				});
				// Attach close/error ownership before the optional watcher can fail.
				if (forceTimeout) {
					try {
						watcher = watch(directory, () => {
							if (existsSync(join(directory, "forced-build-ready.json"))) {
								watcher?.close();
								stop();
							}
						});
					} catch (error) {
						output += `forced watchdog setup failed: ${String(error)}\n`;
						stop();
					}
				}
			},
		);
		write(join(directory, "namespace-output.log"), output);
		if (reports) write(join(reports, `native-default-docs-${Date.now()}.log`), output);
		const isolation = JSON.parse(readFileSync(join(directory, "namespace.json"), "utf8"));
		expect(isolation.pid).toBe(1);
		expect(isolation.pidNamespace).not.toBe(parentPidNamespace);
		const remaining = namespaceMembers(isolation.pidNamespace, preexisting);
		verifiedClosed = remaining.live.length === 0 && remaining.errors.length === 0;
		json(join(directory, "teardown.json"), {
			scope: "private test PID namespace teardown; not production proof",
			result,
			forced,
			forceTimeout,
			watchdogFiredAt,
			closedAt,
			privatePidNamespace: isolation.pidNamespace,
			verifiedClosed,
			remaining,
		});
		expect(verifiedClosed, JSON.stringify(remaining)).toBe(true);
		if (forceTimeout) {
			expect(forced).toBe(true);
			expect(result.signal).toBe("SIGKILL");
			expect(watchdogFiredAt).not.toBeNull();
			expect(closedAt).not.toBeNull();
			expect(closedAt! - watchdogFiredAt!).toBeLessThan(10_000);
			expect(existsSync(join(directory, "forced-build-ready.json"))).toBe(true);
			const started = JSON.parse(readFileSync(join(directory, "forced-Core-started.json"), "utf8"));
			expect(started.action.command.timeoutMs).toBe(3600000);
			expect(existsSync(join(started.runnerDirectory, "child.json"))).toBe(true);
			expect(existsSync(join(directory, "output/receipt.json"))).toBe(false);
			expect(existsSync(join(directory, "output/gate-provenance.json"))).toBe(false);
		} else {
			expect(forced).toBe(false);
			expect(result.code, output).toBe(0);
			expect(
				load<{ proofScope: string }>({ path: join(directory, "native-result.json"), sha256: "" }).proofScope,
			).toBe("source-loader-only; no productioninstalledproof or productiondocsproof");
		}
		expect(readlinkSync("/proc/self/ns/mnt")).toBe(parentNamespace);
		expect(readlinkSync("/proc/self/ns/pid")).toBe(parentPidNamespace);
		expect(statSync("/tmp").dev).toBe(parentTmpDevice);
		passed = true;
	} finally {
		// Never erase failed/uncertain evidence or a directory still owned by a live namespace.
		if (!reports && passed && verifiedClosed && !forced) rmSync(directory, { recursive: true, force: true });
		else console.log(`RETAINED native fixture: ${directory}; verifiedClosed=${verifiedClosed}; forced=${forced}`);
	}
}

test.skipIf(process.platform !== "linux")(
	"default Core runner completes native docs in a private physical slot with real terminal/source custody",
	async () => {
		const directory = process.env[MARKER];
		if (directory) {
			if (process.env.PRIME_TEST_DOCS_FORCED_WATCHDOG === "1") await nativeForcedTimeout(directory);
			else await nativeGate(directory);
		} else {
			await privateNamespace();
			await privateNamespace(true);
		}
	},
	220_000,
);
