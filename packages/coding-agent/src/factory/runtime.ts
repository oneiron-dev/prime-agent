import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FactoryFilePin {
	path: string;
	sha256: string;
}
/** The installed release the factory was initialized from: Node, the CLI and every module beside it. */
export interface FactoryRuntimeIdentity {
	version: 1;
	cliArgv: [string, string];
	files: FactoryFilePin[];
}
export interface FactoryRuntimeProcess {
	executable: string;
	module: string;
}
export function factoryRuntimeProcess(): FactoryRuntimeProcess {
	return { executable: process.execPath, module: fileURLToPath(import.meta.url) };
}
function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
/** The CLI entry beside this module: dist/cli.js in a release, src/cli.ts under tsx. */
export function locateFactoryCli(module = factoryRuntimeProcess().module): string {
	let root = dirname(module);
	while (basename(root) === "factory" || basename(root) === "adapters") root = dirname(root);
	while (!existsSync(join(root, "cli.js")) && !existsSync(join(root, "cli.ts"))) {
		const parent = dirname(root);
		check(parent !== root, "Cannot locate the factory runtime CLI");
		root = parent;
	}
	return join(root, existsSync(join(root, "cli.js")) ? "cli.js" : "cli.ts");
}
export function recordFactoryRuntime(directory: string, filename = "runtime.json"): FactoryFilePin {
	const live = factoryRuntimeProcess();
	const cli = locateFactoryCli(live.module);
	const paths = new Set([live.executable, live.module, cli]);
	const pending = [dirname(cli)];
	while (pending.length) {
		for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
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
	};
	const path = join(directory, filename);
	writeFileSync(path, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
	return { path, sha256: hashFactoryRuntimeFile(path) };
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
/** Why the installed runtime no longer matches the pin, or undefined when it still does. Informational only. */
export function factoryRuntimeChange(pin: FactoryFilePin): string | undefined {
	try {
		if (hashFactoryRuntimeFile(pin.path) !== pin.sha256) return `runtime identity file changed: ${pin.path}`;
		const identity = JSON.parse(readFileSync(pin.path, "utf8")) as FactoryRuntimeIdentity;
		for (const file of identity.files) {
			if (!statSync(file.path, { throwIfNoEntry: false })?.isFile()) return `runtime file missing: ${file.path}`;
			if (hashFactoryRuntimeFile(file.path) !== file.sha256) return `runtime file changed: ${file.path}`;
		}
		return undefined;
	} catch (error) {
		return `runtime pin unreadable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export const FACTORY_JSON_EVENT_PROFILE = "factory-completed";

/**
 * The directory holding the factory's own executables, shipped beside this module: `bin/cargo` is the wrapper that
 * sends a worktree's cargo call to a build host. Prepending this directory to PATH is how both the ticket runner
 * and every seat child reach it.
 */
export function factoryCargoBinDirectory(module = factoryRuntimeProcess().module): string {
	return join(dirname(module), "bin");
}

/** Native owned frontend, not a daemon-free CLI flag. Clear worker authority and the launcher's own credentials. */
export function factoryOwnedEnvironment(): Record<string, string> {
	return {
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
