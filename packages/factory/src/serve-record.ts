import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProcessStartId } from "./process-identity.js";

/**
 * How the watchdog knows a factory's `serve` (or `run`) is up: each scheduling process records its own identity in
 * the factory's `serve/` directory, one file per process, and a record counts only while that exact process (pid
 * and start identity) lives and runs this package's entry. No command line is parsed, and one scheduler starting or
 * stopping never touches another's record.
 */
export interface ServeRecord {
	version: 1;
	pid: number;
	startId: string;
	/** The canonical path of the package entry the process runs. */
	entry: string;
}

function records(directory: string): Array<{ path: string; record: Partial<ServeRecord> }> {
	const root = join(directory, "serve");
	let names: string[];
	try {
		names = readdirSync(root).filter((name) => /^\d+\.json$/.test(name));
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const path = join(root, name);
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			return value && typeof value === "object" ? [{ path, record: value as Partial<ServeRecord> }] : [];
		} catch {
			return [];
		}
	});
}

/** A Linux process that exited but was not reaped yet keeps its start identity; it is not running. */
function zombie(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return false;
	}
}

/** Whether the process a record names is still that process. */
function live(record: Partial<ServeRecord>): boolean {
	if (record.version !== 1 || typeof record.pid !== "number" || typeof record.startId !== "string") return false;
	return getProcessStartId(record.pid) === record.startId && !zombie(record.pid);
}

/**
 * Record this process as one of the factory's schedulers, dropping records of schedulers that no longer run. The
 * returned function removes this process's record while it is still this process's.
 */
export function recordServe(directory: string, entry: string): () => void {
	const startId = getProcessStartId(process.pid);
	if (!startId) return () => undefined;
	for (const { path, record } of records(directory)) if (!live(record)) rmSync(path, { force: true });
	const record: ServeRecord = { version: 1, pid: process.pid, startId, entry };
	const root = join(directory, "serve");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = join(root, `${process.pid}.json`);
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	return () => {
		const current = records(directory).find((candidate) => candidate.path === path)?.record;
		if (current?.pid === record.pid && current.startId === record.startId) rmSync(path, { force: true });
	};
}

/** Whether a recorded scheduler of the factory is alive: the same process, still running the package entry `entry`. */
export function serveRunning(directory: string, entry: string): boolean {
	return records(directory).some(({ record }) => record.entry === entry && live(record));
}
