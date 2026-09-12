import type * as NodeFs from "node:fs";
import { fsyncSync, ftruncateSync, mkdtempSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/event-log.js";

const repairRace = vi.hoisted(() => ({ beforeOpen: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		readSync: vi.fn(actual.readSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		ftruncateSync: vi.fn(actual.ftruncateSync),
		openSync: (...args: Parameters<typeof NodeFs.openSync>) => {
			if (args[1] === "r+" && repairRace.beforeOpen) {
				const beforeOpen = repairRace.beforeOpen;
				repairRace.beforeOpen = undefined;
				beforeOpen();
			}
			return actual.openSync(...args);
		},
	};
});

describe("event log substrate", () => {
	let dir: string;

	beforeEach(() => {
		repairRace.beforeOpen = undefined;
		vi.clearAllMocks();
		dir = mkdtempSync(join(tmpdir(), "prime-event-log-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws for an unserializable event before any byte reaches the log", () => {
		const log = new EventLog(join(dir, "log.jsonl"));
		log.appendSync([{ ok: 1 }]);
		const before = readFileSync(log.path, "utf8");
		expect(() => log.appendSync([{ ok: 2 }, undefined])).toThrow(TypeError);
		expect(readFileSync(log.path, "utf8")).toBe(before);
	});

	it("truncates an unterminated tail even when it parses as JSON, keeping strict replays clean", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, keep: true }]);
		// Tail rule: uncommitted append — see the EventLog module doc.
		writeFileSync(path, `${readFileSync(path, "utf8")}{"not":"a valid record"}`);
		expect(new EventLog(path).replaySync((line) => JSON.parse(line) as { v?: number })).toEqual([
			{ v: 1, keep: true },
		]);
		log.appendSync([{ v: 1, second: true }]);
		const strict = new EventLog(path).replaySync((line, index) => {
			const value = JSON.parse(line) as { v?: number };
			if (value.v !== 1) throw new Error(`invalid record on line ${index + 1}`);
			return value;
		});
		expect(strict).toEqual([
			{ v: 1, keep: true },
			{ v: 1, second: true },
		]);
	});

	it("fails closed on an oversized log through the descriptor without a full allocation", () => {
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${"x".repeat(64)}\n`.repeat(4));
		const log = new EventLog(path, { maxBytes: 100 });
		expect(() => log.replaySync((line) => line)).toThrow("bytes");
		expect(() => log.appendSync([{ v: 1 }])).toThrow("bytes");
	});
	it("reads only the last byte of a healthy log and keeps durable appends fsynced", () => {
		const path = join(dir, "log.jsonl");
		const prefix = `${JSON.stringify({ keep: "x".repeat(1024 * 1024) })}\n`;
		writeFileSync(path, prefix);
		const log = new EventLog(path);
		log.appendSync([{ second: true }], { durable: true });
		expect(readSync).toHaveBeenCalledExactlyOnceWith(
			expect.any(Number),
			expect.any(Buffer),
			0,
			1,
			Buffer.byteLength(prefix) - 1,
		);
		expect(ftruncateSync).not.toHaveBeenCalled();
		expect(fsyncSync).toHaveBeenCalledOnce();
		expect(readFileSync(path, "utf8")).toBe(`${prefix}{"second":true}\n`);
	});

	it.each(["grow", "shrink"] as const)("repairs the opened log after a %s between path stat and open", (change) => {
		const path = join(dir, "log.jsonl");
		const prefix = '{"keep":true}\n';
		const initial = change === "grow" ? prefix : `${prefix}${JSON.stringify({ old: "x".repeat(1024) })}\n`;
		writeFileSync(path, initial);
		repairRace.beforeOpen = () => writeFileSync(path, `${prefix}{"torn":`);
		new EventLog(path).appendSync([{ second: true }], { durable: true });
		expect(new EventLog(path).replaySync((line) => JSON.parse(line))).toEqual([{ keep: true }, { second: true }]);
		expect(fsyncSync).toHaveBeenCalledOnce();
	});

	it("enforces the opened descriptor's byte bound before probing or appending", () => {
		const path = join(dir, "log.jsonl");
		writeFileSync(path, '{"keep":true}\n');
		const oversized = `${JSON.stringify({ keep: "x".repeat(128) })}\n`;
		repairRace.beforeOpen = () => writeFileSync(path, oversized);
		expect(() => new EventLog(path, { maxBytes: 64 }).appendSync([{ second: true }])).toThrow("bytes");
		expect(readSync).not.toHaveBeenCalled();
		expect(ftruncateSync).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(oversized);
	});
	it("does not append when repair cannot open the existing log", () => {
		const path = join(dir, "log.jsonl");
		const prefix = '{"keep":true}\n';
		writeFileSync(path, prefix);
		const error = Object.assign(new Error("read access denied"), { code: "EACCES" });
		repairRace.beforeOpen = () => {
			throw error;
		};
		expect(() => new EventLog(path, { maxBytes: 64 }).appendSync([{ second: true }])).toThrow(error);
		expect(readFileSync(path, "utf8")).toBe(prefix);
	});
});
