import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FactoryFilePin {
	path: string;
	sha256: string;
}
/** One reviewed release identity shared by scheduler, manager, coordinator and project actuators. */
export interface FactoryRuntimeIdentity {
	version: 1;
	cliArgv: [string, string];
	files: FactoryFilePin[];
	capabilities: string[];
}
// Same-host start checks allow two seconds for filesystem timestamp precision; remote identity checks use hashes only.
export const FACTORY_RUNTIME_START_TOLERANCE_SECONDS = 2;
export class FactoryRuntimeMismatch extends Error {}
export function factoryRuntimeMismatchCheck(reason: string): string {
	return (
		reason.match(/(?:^|runtime_mismatch: )(runtime_identity|local_start_time|delivery_integrity):/)?.[1] ??
		"runtime_identity"
	);
}
export interface FactoryRuntimeProcess {
	executable: string;
	module: string;
	startedAt: number;
}
const processStartedAt = Date.now() - process.uptime() * 1000;
export function factoryRuntimeProcess(): FactoryRuntimeProcess {
	return { executable: process.execPath, module: fileURLToPath(import.meta.url), startedAt: processStartedAt };
}
export function verifyFactoryRuntimeAdmission(pin: FactoryFilePin, live: FactoryRuntimeProcess): void {
	try {
		const runtime = readFactoryRuntime(pin, (expected) => {
			check(expected && isAbsolute(expected.path) && /^[a-f0-9]{64}$/.test(expected.sha256), "Missing runtime pin");
			const bytes = readFileSync(expected.path);
			check(createHash("sha256").update(bytes).digest("hex") === expected.sha256, "Runtime identity hash mismatch");
			return bytes.toString("utf8");
		});
		check(
			realpathSync(runtime.cliArgv[0]) === realpathSync(live.executable) &&
				runtime.files.some((file) => realpathSync(file.path) === realpathSync(live.module)),
			"Executing process is outside the pinned runtime",
		);
		// The identity document is created at init; only executable components must predate the process.
		for (const file of runtime.files) {
			const info = statSync(file.path);
			check(
				Number.isFinite(live.startedAt) &&
					live.startedAt > 0 &&
					live.startedAt <= Date.now() + FACTORY_RUNTIME_START_TOLERANCE_SECONDS * 1000 &&
					live.startedAt + FACTORY_RUNTIME_START_TOLERANCE_SECONDS * 1000 >= Math.max(info.mtimeMs, info.ctimeMs),
				"local_start_time: Daemon start time is invalid or predates the runtime bundle",
			);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new FactoryRuntimeMismatch(reason.startsWith("local_start_time:") ? reason : `runtime_identity: ${reason}`);
	}
}
export function recordFactoryRuntime(directory: string, filename = "runtime.json"): FactoryFilePin {
	const live = factoryRuntimeProcess();
	let root = dirname(live.module);
	if (basename(root) === "factory") root = dirname(root);
	while (!existsSync(join(root, "cli.js")) && !existsSync(join(root, "cli.ts"))) {
		const parent = dirname(root);
		check(parent !== root, "Cannot locate the initializing runtime CLI");
		root = parent;
	}
	const cli = join(root, existsSync(join(root, "cli.js")) ? "cli.js" : "cli.ts");
	const paths = new Set([live.executable, live.module, cli]);
	const pending = [root];
	while (pending.length) {
		for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
			check(!entry.isSymbolicLink(), "Factory bundle symlinks require a sealed explicit deployment");
			const path = join(entry.parentPath, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (/\.(?:js|mjs|cjs|ts)$/.test(entry.name)) paths.add(path);
			check(paths.size <= 4096, "Factory runtime requires a narrower deployment");
		}
	}
	const identity: FactoryRuntimeIdentity = {
		version: 1,
		cliArgv: [live.executable, cli],
		files: [...paths].sort().map((path) => ({ path, sha256: hashFactoryRuntimeFile(path) })),
		capabilities: ["provider-response-model-v1", "factory-completed-json-v1"],
	};
	const path = join(directory, filename);
	writeFileSync(path, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
	const pin = { path, sha256: hashFactoryRuntimeFile(path) };
	verifyFactoryRuntimeAdmission(pin, live);
	return pin;
}
export function hashFactoryRuntimeFile(path: string): string {
	const descriptor = openSync(path, "r");
	const hash = createHash("sha256");
	const buffer = Buffer.alloc(128 * 1024);
	try {
		while (true) {
			const size = readSync(descriptor, buffer);
			if (size === 0) break;
			hash.update(buffer.subarray(0, size));
		}
	} finally {
		closeSync(descriptor);
	}
	return hash.digest("hex");
}
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
/** Verify once at a bounded actor's admission/launch. Do not rehash the release for every Git operation. */
export function readFactoryRuntime(
	pin: FactoryFilePin,
	readPin: (pin: FactoryFilePin) => string,
): FactoryRuntimeIdentity {
	const runtime = JSON.parse(readPin(pin)) as FactoryRuntimeIdentity;
	check(
		runtime.version === 1 &&
			Array.isArray(runtime.cliArgv) &&
			runtime.cliArgv.length === 2 &&
			runtime.cliArgv.every((path) => typeof path === "string" && isAbsolute(path)) &&
			Array.isArray(runtime.capabilities) &&
			runtime.capabilities.every((capability) => typeof capability === "string") &&
			runtime.capabilities.includes("provider-response-model-v1") &&
			Array.isArray(runtime.files) &&
			runtime.files.length > 1 &&
			runtime.files.length <= 4096,
		"Factory requires a pinned metadata-capable Node/CLI runtime, not PATH selection",
	);
	const paths = new Set(runtime.files.map((entry) => entry.path));
	check(
		paths.size === runtime.files.length && runtime.cliArgv.every((path) => paths.has(path)),
		"Factory runtime must uniquely pin both Node and CLI files",
	);
	for (const entry of runtime.files)
		check(
			isAbsolute(entry.path) &&
				/^[0-9a-f]{64}$/.test(entry.sha256) &&
				statSync(entry.path).isFile() &&
				hashFactoryRuntimeFile(entry.path) === entry.sha256,
			"Factory native runtime component changed",
		);
	// Bundled CLI imports sibling chunks lazily; pinning cli.js alone does not pin its providers.
	const pending = [dirname(runtime.cliArgv[1])];
	const visited = new Set<string>();
	while (pending.length) {
		const directory = pending.pop()!;
		const real = realpathSync(directory);
		check(
			!visited.has(real) && visited.size < 4096,
			"Factory bundle directory aliases or size require a narrower deployment",
		);
		visited.add(real);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			check(!entry.isSymbolicLink(), "Factory bundle symlinks require a sealed explicit deployment");
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (/\.(?:js|mjs|cjs)$/.test(entry.name))
				check(paths.has(path), "Factory runtime omitted a lazy bundle module");
		}
	}
	return runtime;
}

export const FACTORY_JSON_EVENT_PROFILE = "factory-completed";

/** New model launches need this profile. Historical runtime/proof reads do not. */
export function requireFactoryJsonEventProfile(runtime: FactoryRuntimeIdentity): void {
	check(
		runtime.capabilities.includes("factory-completed-json-v1"),
		"Factory model launch requires runtime capability factory-completed-json-v1 (--json-event-profile factory-completed)",
	);
}

export const FACTORY_ONLY_API_KEYS = [
	"FACTORY_CAPSULE_API_KEY",
	"TYPESAFE_JEV_API_KEY",
	"FACTORY_ADVISOR_API_KEY",
] as const;

/** Native owned frontend, not a daemon-free CLI flag. Clear worker authority and factory-only credentials. */
export function factoryOwnedEnvironment(): Record<string, string> {
	return {
		FACTORY_CAPSULE_API_KEY: "",
		TYPESAFE_JEV_API_KEY: "",
		FACTORY_ADVISOR_API_KEY: "",
		PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
		PRIME_AGENT_INTERNAL_OWNED_WORKER: "",
		PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR: "",
		PRIME_AGENT_INTERNAL_OWNED_PROFILE: "",
		PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "",
		PRIME_AGENT_INTERNAL_SESSION_LEASES: "",
		PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID: "",
		PRIME_AGENT_INTERNAL_DAEMON_WORKER: "",
		PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "",
		PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID: "",
		PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "",
		PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: "",
		PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL: "",
		PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD: "",
		PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "",
	};
}
