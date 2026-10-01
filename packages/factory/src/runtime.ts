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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The factory's own installation: where its entry lives, how to run it again, and the pin that tells a resume
 * whether the installed bytes changed. The agent binary the seats run is pinned separately (see `agent-command`).
 */
export interface FactoryFilePin {
	path: string;
	sha256: string;
}
/** The installed factory a store was initialized from: Node, the package entry and every module beside it. */
export interface FactoryRuntimeIdentity {
	version: 2;
	factoryArgv: [string, string];
	files: FactoryFilePin[];
}
/** How to run this package's CLI: Node, its exec arguments (the tsx loader in development) and the entry. */
export interface FactoryEntrypoint {
	node: string;
	execArgv: readonly string[];
	entry: string;
}

/** Node 22.13 is the first release with node:sqlite unflagged; Bun's node:sqlite is not the same module. */
export function supportsFactoryRuntime(versions: { node?: string; bun?: string }): boolean {
	if (versions.bun || !versions.node) return false;
	const [major = 0, minor = 0] = versions.node.split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 13);
}

/** The CLI entry beside this module: dist/cli-entry.js in a build, src/cli-entry.ts under tsx. */
export function locateFactoryEntrypoint(moduleUrl = import.meta.url): FactoryEntrypoint {
	const directory = dirname(fileURLToPath(moduleUrl));
	const entry = ["cli-entry.js", "cli-entry.ts"].map((name) => join(directory, name)).find((path) => existsSync(path));
	if (!entry) throw new Error(`Cannot locate the factory CLI entry beside ${directory}`);
	return { node: process.execPath, execArgv: process.execArgv, entry };
}

/**
 * Whether the module at `moduleUrl` is the script this process was started with. Node resolves a symlinked entry
 * for import.meta.url but not for argv[1], so both sides are compared canonically; a mismatch would exit 0 unseen.
 */
export function invokedDirectly(moduleUrl: string): boolean {
	try {
		return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

export function recordFactoryRuntime(
	directory: string,
	filename = "runtime.json",
	entrypoint = locateFactoryEntrypoint(),
): FactoryFilePin {
	const paths = new Set([entrypoint.node, entrypoint.entry]);
	const pending = [dirname(entrypoint.entry)];
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
		version: 2,
		factoryArgv: [entrypoint.node, entrypoint.entry],
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

/**
 * The directory holding the factory's own executables, shipped beside this module: `bin/cargo` is the wrapper that
 * sends a worktree's cargo call to a build host. Prepending this directory to PATH is how both the ticket runner
 * and every seat child reach it.
 */
export function factoryCargoBinDirectory(moduleUrl = import.meta.url): string {
	return join(dirname(fileURLToPath(moduleUrl)), "bin");
}
