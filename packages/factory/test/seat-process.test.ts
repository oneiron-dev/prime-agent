import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess, SEAT_IDLE_EXIT_CODE, type SpawnChild } from "../src/adapters/seat-process.js";

/** A child whose streams and exit the test drives; `kill` records the signal and closes like a real child would. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly input: string[] = [];
	readonly stdin = Object.assign(new EventEmitter(), {
		end: (text: string) => {
			this.input.push(text);
		},
	});
	readonly signals: string[] = [];
	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		if (signal === "SIGTERM") this.emit("close", null, signal);
		return true;
	}
	write(stream: "stdout" | "stderr", text: string): void {
		this[stream].emit("data", Buffer.from(text));
	}
}
function spawnFake(child: FakeChild): { spawn: SpawnChild; calls: unknown[][] } {
	const calls: unknown[][] = [];
	const spawn = ((...args: unknown[]) => {
		calls.push(args);
		return child;
	}) as unknown as SpawnChild;
	return { spawn, calls };
}
const options = { cwd: "/work", env: { PATH: "/bin" }, timeoutMs: 300_000 };

afterEach(() => {
	vi.useRealTimers();
});

describe("seat process silence detection", () => {
	it("kills a seat only after idleMs of silence on both streams and reports it as idle", async () => {
		vi.useFakeTimers();
		const child = new FakeChild();
		const { spawn, calls } = spawnFake(child);
		const idle: number[] = [];
		const result = runProcess(["agent", "-p"], { ...options, idleMs: 300, onIdle: (ms) => idle.push(ms) }, spawn);
		// Output on either stream re-arms the deadline: eight chunks 200 ms apart outlive the 300 ms window.
		for (let chunk = 0; chunk < 8; chunk++) {
			await vi.advanceTimersByTimeAsync(200);
			child.write(chunk % 2 ? "stderr" : "stdout", '{"type":"tool_execution_end"}\n');
		}
		expect([child.signals, idle]).toEqual([[], []]);
		await vi.advanceTimersByTimeAsync(299);
		expect(child.signals).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toEqual({
			code: SEAT_IDLE_EXIT_CODE,
			output: `${'{"type":"tool_execution_end"}\n'.repeat(8)}\nIDLE 0s`,
		});
		expect([child.signals, idle]).toEqual([["SIGTERM"], [300]]);
		expect(calls).toEqual([["agent", ["-p"], { cwd: "/work", env: { PATH: "/bin" }, stdio: ["ignore", "pipe", "pipe"] }]]);
	});

	it("keeps a talking seat to its own exit, however long it works", async () => {
		vi.useFakeTimers();
		const child = new FakeChild();
		const { spawn } = spawnFake(child);
		const result = runProcess(["agent"], { ...options, idleMs: 1_000 }, spawn);
		for (let minute = 0; minute < 120; minute++) {
			await vi.advanceTimersByTimeAsync(999);
			child.write("stdout", ".");
		}
		child.emit("close", 0, null);
		expect(await result).toEqual({ code: 0, output: ".".repeat(120) });
		expect(child.signals).toEqual([]);
	});

	it("gives gh and git a wall clock that output does not extend", async () => {
		vi.useFakeTimers();
		const child = new FakeChild();
		const { spawn } = spawnFake(child);
		const result = runProcess(["gh", "pr", "view"], { ...options, timeoutMs: 500 }, spawn);
		await vi.advanceTimersByTimeAsync(400);
		child.write("stdout", "partial");
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toEqual({ code: 124, output: "partial\nTIMEOUT" });
		expect(child.signals).toEqual(["SIGTERM"]);
	});

	it("escalates to SIGKILL when a killed seat ignores SIGTERM", async () => {
		vi.useFakeTimers();
		const child = new FakeChild();
		child.kill = (signal: NodeJS.Signals) => {
			child.signals.push(signal);
			if (signal === "SIGKILL") child.emit("close", null, signal);
			return true;
		};
		const { spawn } = spawnFake(child);
		const result = runProcess(["agent"], { ...options, idleMs: 100 }, spawn);
		await vi.advanceTimersByTimeAsync(100);
		expect(child.signals).toEqual(["SIGTERM"]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toEqual({ code: SEAT_IDLE_EXIT_CODE, output: "\nIDLE 0s" });
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

describe("seat process output", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("writes the prompt to stdin, appends the argv and output to the log and reports a spawn failure as 127", async () => {
		const root = mkdtempSync(join(tmpdir(), "factory-seat-process-"));
		roots.push(root);
		const child = new FakeChild();
		const { spawn, calls } = spawnFake(child);
		const logPath = join(root, "seat.log");
		const result = runProcess(["agent", "-p"], { ...options, input: "the prompt", logPath }, spawn);
		child.write("stdout", "reply");
		child.emit("close", 0, null);
		expect(await result).toEqual({ code: 0, output: "reply" });
		expect([child.input, readFileSync(logPath, "utf8")]).toEqual([["the prompt"], "\n=== agent -p\nreply"]);
		expect((calls[0]![2] as { stdio: string[] }).stdio).toEqual(["pipe", "pipe", "pipe"]);
		const missing = new FakeChild();
		const failed = runProcess(["no-such-agent"], options, spawnFake(missing).spawn);
		missing.emit("error", new Error("spawn no-such-agent ENOENT"));
		expect(await failed).toEqual({ code: 127, output: "\nspawn no-such-agent ENOENT", spawnFailed: true });
		// An error from a child that did start is not a spawn failure.
		const started = Object.assign(new FakeChild(), { pid: 4242 });
		const errored = runProcess(["agent"], options, spawnFake(started).spawn);
		started.emit("error", new Error("kill EPERM"));
		expect(await errored).toEqual({ code: 127, output: "\nkill EPERM" });
	});
});
