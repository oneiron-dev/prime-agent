import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordServe, serveRunning } from "../src/serve-record.js";

// Two schedulers interleave exactly here: the start identity each pid reports is set by the test, and work can run
// the moment a scheduler has read a serve record, before it acts on what it read.
const steer = vi.hoisted(() => ({
	startIds: new Map<number, string>(),
	afterRecordRead: undefined as (() => void) | undefined,
}));

vi.mock("../src/process-identity.js", () => ({
	getProcessStartId: (pid: number) => steer.startIds.get(pid),
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
		const content = fs.readFileSync(...args);
		const after = steer.afterRecordRead;
		if (after && /[\\/]serve[\\/][^\\/]+\.json$/.test(String(args[0]))) {
			steer.afterRecordRead = undefined;
			after();
		}
		return content;
	}) as typeof fs.readFileSync;
	return { ...fs, readFileSync };
});

const roots: string[] = [];
afterEach(() => {
	steer.startIds.clear();
	steer.afterRecordRead = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run `register` as the process `pid`: every scheduler here lives in this test process, each under its own pid. */
function asProcess<T>(pid: number, register: () => T): T {
	const own = Object.getOwnPropertyDescriptor(process, "pid")!;
	Object.defineProperty(process, "pid", { ...own, value: pid });
	try {
		return register();
	} finally {
		Object.defineProperty(process, "pid", own);
	}
}

it("never prunes a registration published under a reused pid after the stale record was read", () => {
	const factory = mkdtempSync(join(tmpdir(), "factory-serve-race-"));
	roots.push(factory);
	const entry = "/opt/prime-agent-factory/dist/cli-entry.js";
	const observe = () => ({
		running: serveRunning(factory, entry),
		records: readdirSync(join(factory, "serve"))
			.map((name) => JSON.parse(readFileSync(join(factory, "serve", name), "utf8")) as { pid: number })
			.sort((left, right) => left.pid - right.pid),
	});
	// No process can hold this pid (Linux caps pids below 2^22), so only the identities set here describe it.
	const reused = 2 ** 22 + 1;
	steer.startIds.set(process.pid, "proc:a");
	// A scheduler under that pid registered and died without forgetting its record.
	steer.startIds.set(reused, "proc:first");
	asProcess(reused, () => recordServe(factory, entry));
	// The pid now names scheduler B. Scheduler A starts and reads the stale record; before A prunes it, B publishes.
	steer.startIds.set(reused, "proc:second");
	let forgetB: () => void = () => undefined;
	steer.afterRecordRead = () => {
		forgetB = asProcess(reused, () => recordServe(factory, entry));
	};
	const forgetA = recordServe(factory, entry);
	const registered = observe();
	forgetA();
	const afterA = observe();
	forgetB();
	const a = { version: 1, pid: process.pid, startId: "proc:a", entry };
	const b = { version: 1, pid: reused, startId: "proc:second", entry };
	expect([registered, afterA, observe()]).toEqual([
		{ running: true, records: [a, b] },
		{ running: true, records: [b] },
		{ running: false, records: [] },
	]);
});
