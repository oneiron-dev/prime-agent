import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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

/** Native owned frontend, not a daemon-free CLI flag. Clear only inherited native worker authority in the child. */
export function factoryOwnedEnvironment(): Record<string, string> {
	return {
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
