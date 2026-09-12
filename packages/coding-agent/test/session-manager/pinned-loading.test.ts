import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentsViewStatePath } from "../../src/config.js";
import { readPinnedSessionIds } from "../../src/core/session-list-priority.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { handleCatalogRequest } from "../../src/modes/daemon/daemon-catalog-process.js";
import * as fileLines from "../../src/utils/file-lines.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return { ...actual, open: vi.fn(actual.open) };
});

const originalReadLines = fileLines.readLinesAsBuffers;
const originalOpen = vi.mocked(fsPromises.open).getMockImplementation()!;
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "prime-pinned-loading-"));
	directories.push(path);
	return path;
}
function writeSession(dir: string, name: string, id = name, cwd = dir, day = 1): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: `2026-01-0${day}T00:00:00.000Z`, cwd })}\n`,
	);
	return file;
}
function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function recordFullReads(): string[] {
	const reads: string[] = [];
	vi.spyOn(fileLines, "readLinesAsBuffers").mockImplementation(async function* (file, range) {
		reads.push(basename(file));
		yield* originalReadLines(file, range);
	});
	return reads;
}

describe("pinned saved-session metadata loading", () => {
	it("streams pinned metadata in pin order before an unrelated blocked transcript", async () => {
		const dir = directory();
		vi.stubEnv(ENV_AGENT_DIR, dir);
		writeFileSync(
			getAgentsViewStatePath(dir),
			JSON.stringify({ version: 1, pinnedRootSessionIds: ["z-pin", "y-pin", "z-pin"] }),
		);
		writeSession(dir, "a-background", "a-background", dir, 3);
		writeSession(dir, "y-pin", "y-pin", dir, 2);
		writeSession(dir, "z-pin");
		const backgroundStarted = deferred();
		const releaseBackground = deferred();
		const fullReads: string[] = [];
		vi.spyOn(fileLines, "readLinesAsBuffers").mockImplementation(async function* (file, range) {
			fullReads.push(basename(file));
			if (basename(file) === "a-background.jsonl") {
				backgroundStarted.resolve();
				await releaseBackground.promise;
			}
			yield* originalReadLines(file, range);
		});
		const discovered: string[] = [];
		const progress: number[] = [];
		let finalIds: string[] = [];
		const request = handleCatalogRequest(
			{ type: "request", id: "test", command: "list", stream: true, sessionDir: dir },
			(message) => {
				if (message.type === "session") discovered.push(message.session.id);
				if (message.type === "progress") progress.push(message.loaded);
				if (message.type === "response" && message.success)
					finalIds = (message.data as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id);
			},
		);
		try {
			await backgroundStarted.promise;
			expect(fullReads).toEqual(["z-pin.jsonl", "y-pin.jsonl", "a-background.jsonl"]);
			expect(discovered).toEqual(["z-pin", "y-pin"]);
			expect(progress).toEqual([1, 2]);
		} finally {
			releaseBackground.resolve();
			await request;
		}
		expect(progress).toEqual([1, 2, 3]);
		expect(finalIds).toEqual(["a-background", "y-pin", "z-pin"]);
	});

	it("starts known pins before a missing-pin header search and keeps aliases ahead of unpinned bodies", async () => {
		const dir = directory();
		const background = writeSession(dir, "a-background");
		writeSession(dir, "custom-name", "alias-pin");
		writeSession(dir, "z-pin");
		const fullReads = recordFullReads();
		const opened: string[] = [];
		const backgroundOpenedAfterKnownPin: boolean[] = [];
		vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
			opened.push(String(args[0]));
			if (String(args[0]) === background) backgroundOpenedAfterKnownPin.push(fullReads.includes("z-pin.jsonl"));
			return originalOpen(...args);
		});
		const discovered: string[] = [];
		const sessions = await SessionManager.listAll(
			{
				prioritySessionIds: ["missing", "alias-pin", "z-pin", "z-pin"],
				onSession: (session) => discovered.push(session.id),
			},
			dir,
		);
		expect(fullReads).toEqual(["z-pin.jsonl", "custom-name.jsonl", "a-background.jsonl"]);
		expect(discovered).toEqual(["z-pin", "alias-pin", "a-background"]);
		expect(sessions).toHaveLength(3);
		expect(opened).not.toContain(join(dir, "missing.jsonl"));
		expect(backgroundOpenedAfterKnownPin.length).toBeGreaterThan(0);
		expect(backgroundOpenedAfterKnownPin.every(Boolean)).toBe(true);
	});

	it("uses header IDs, preserves cwd filtering, and ignores missing or unreadable pins", async () => {
		const dir = directory();
		const cwd = join(dir, "project");
		mkdirSync(cwd);
		writeSession(dir, "a-ordinary", "ordinary", cwd);
		writeSession(dir, "forged-pin", "actual-id", cwd);
		writeSession(dir, "z-other-cwd", "z-other-cwd", dir);
		mkdirSync(join(dir, "unreadable.jsonl"));
		const reads = recordFullReads();
		const discovered: string[] = [];
		const progress: Array<[number, number]> = [];
		const sessions = await SessionManager.list(cwd, dir, {
			prioritySessionIds: ["missing", "unreadable", "forged-pin", "actual-id", "z-other-cwd"],
			onSession: (session) => discovered.push(session.id),
			onProgress: (loaded, total) => progress.push([loaded, total]),
		});
		expect(reads.slice(0, 2)).toEqual(["forged-pin.jsonl", "z-other-cwd.jsonl"]);
		expect(discovered).toEqual(["actual-id", "ordinary"]);
		expect(sessions.map((session) => session.id).sort()).toEqual(["actual-id", "ordinary"]);
		expect(progress).toEqual([
			[1, 4],
			[2, 4],
			[3, 4],
			[4, 4],
		]);
	});

	it("reads normalized pin preferences without creating locks or changing files", async () => {
		const dir = directory();
		const path = getAgentsViewStatePath(dir);
		expect(await readPinnedSessionIds(path)).toEqual([]);
		const contents = JSON.stringify({ version: 1, pinnedRootSessionIds: ["b", "a", "b", 1, "", null] });
		writeFileSync(path, contents);
		expect(await readPinnedSessionIds(path)).toEqual(["b", "a"]);
		expect(await fsPromises.readFile(path, "utf8")).toBe(contents);
		expect(await fsPromises.readdir(dir)).toEqual(["agents-view-state.json"]);
		for (const malformed of ["{", '{"version":2,"pinnedRootSessionIds":["a"]}', "null"]) {
			writeFileSync(path, malformed);
			expect(await readPinnedSessionIds(path)).toEqual([]);
		}
		rmSync(path);
		mkdirSync(path);
		expect(await readPinnedSessionIds(path)).toEqual([]);
	});
});
