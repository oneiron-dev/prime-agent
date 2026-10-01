import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProcessStartId } from "./process-identity.js";

/**
 * How the watchdog knows a factory's `serve` (or `run`) is up: the scheduling process records its own identity in
 * the factory directory, and the record counts only while that exact process (pid and start identity) lives and
 * runs this package's entry. No command line is parsed.
 */
export interface ServeRecord {
	version: 1;
	pid: number;
	startId: string;
	/** The canonical path of the package entry the process runs. */
	entry: string;
}
const RECORD = "serve.json";

/** Record this process as the factory's scheduler; the returned function removes the record while it is still ours. */
export function recordServe(directory: string, entry: string): () => void {
	const startId = getProcessStartId(process.pid);
	if (!startId) return () => undefined;
	const record: ServeRecord = { version: 1, pid: process.pid, startId, entry };
	const path = join(directory, RECORD);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
	return () => {
		const current = readServeRecord(directory);
		if (current?.pid === record.pid && current.startId === record.startId) rmSync(path, { force: true });
	};
}

function readServeRecord(directory: string): Partial<ServeRecord> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(directory, RECORD), "utf8"));
		return value && typeof value === "object" ? (value as Partial<ServeRecord>) : undefined;
	} catch {
		return undefined;
	}
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

/** Whether the factory's recorded scheduler is alive: the same process, still running the package entry `entry`. */
export function serveRunning(directory: string, entry: string): boolean {
	const record = readServeRecord(directory);
	if (record?.version !== 1 || record.entry !== entry || typeof record.pid !== "number") return false;
	if (typeof record.startId !== "string" || getProcessStartId(record.pid) !== record.startId) return false;
	return !zombie(record.pid);
}
