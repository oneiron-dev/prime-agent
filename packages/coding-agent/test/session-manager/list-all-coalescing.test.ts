import type { PathLike } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReaddirStrings = (path: PathLike) => Promise<string[]>;

const fsPromiseMocks = vi.hoisted(() => ({
	actualReaddir: undefined as ReaddirStrings | undefined,
	readdir: vi.fn<ReaddirStrings>(),
}));

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	fsPromiseMocks.actualReaddir = (path) => actual.readdir(path);
	fsPromiseMocks.readdir.mockImplementation(fsPromiseMocks.actualReaddir);
	return {
		...actual,
		readdir: fsPromiseMocks.readdir,
	};
});

import { SessionManager } from "../../src/core/session-manager.js";

const tempDirs: string[] = [];

beforeEach(() => {
	fsPromiseMocks.readdir.mockReset();
	fsPromiseMocks.readdir.mockImplementation(fsPromiseMocks.actualReaddir!);
});

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("SessionManager.listAll scan coalescing", () => {
	it("shares 100+ concurrent callback-free directory walks per session root and refreshes after settle", async () => {
		const tempDir = createTempDir("session-list-all-coalescing-");
		const firstRoot = join(tempDir, "sessions-a");
		const secondRoot = join(tempDir, "sessions-b");
		mkdirSync(firstRoot);
		mkdirSync(secondRoot);
		const scansStarted = deferred();
		const releaseScans = deferred();
		let scanCount = 0;
		fsPromiseMocks.readdir.mockImplementation(async (path) => {
			scanCount++;
			if (scanCount === 2) scansStarted.resolve();
			await releaseScans.promise;
			return fsPromiseMocks.actualReaddir!(path);
		});

		const firstRootCalls = Array.from({ length: 128 }, () => SessionManager.listAll(undefined, firstRoot));
		const secondRootCalls = Array.from({ length: 128 }, () => SessionManager.listAll(undefined, secondRoot));
		await scansStarted.promise;
		const scansBeforeRelease = fsPromiseMocks.readdir.mock.calls.length;
		releaseScans.resolve();
		const results = await Promise.all([...firstRootCalls, ...secondRootCalls]);

		expect(scansBeforeRelease).toBe(2);
		expect(results.every((sessions) => sessions.length === 0)).toBe(true);
		expect(results[0]).not.toBe(results[1]);

		writeSession(firstRoot, "new-session");
		const refreshed = await SessionManager.listAll(undefined, firstRoot);

		expect(fsPromiseMocks.readdir).toHaveBeenCalledTimes(3);
		expect(refreshed.map((session) => session.id)).toEqual(["new-session"]);
	});

	it("keeps callback-bearing calls independent", async () => {
		const tempDir = createTempDir("session-list-all-callbacks-");
		const sessionRoot = join(tempDir, "sessions");
		mkdirSync(sessionRoot);
		writeSession(sessionRoot, "callback-session");
		const scansStarted = deferred();
		const releaseScans = deferred();
		let scanCount = 0;
		fsPromiseMocks.readdir.mockImplementation(async (path) => {
			scanCount++;
			if (scanCount === 2) scansStarted.resolve();
			await releaseScans.promise;
			return fsPromiseMocks.actualReaddir!(path);
		});
		const firstProgress: Array<[number, number]> = [];
		const secondProgress: Array<[number, number]> = [];
		const firstSessions: string[] = [];
		const secondSessions: string[] = [];

		const first = SessionManager.listAll(
			{
				onProgress: (loaded, total) => firstProgress.push([loaded, total]),
				onSession: (session) => firstSessions.push(session.id),
			},
			sessionRoot,
		);
		const second = SessionManager.listAll(
			{
				onProgress: (loaded, total) => secondProgress.push([loaded, total]),
				onSession: (session) => secondSessions.push(session.id),
			},
			sessionRoot,
		);
		await scansStarted.promise;
		const scansBeforeRelease = fsPromiseMocks.readdir.mock.calls.length;
		releaseScans.resolve();
		await Promise.all([first, second]);

		expect(scansBeforeRelease).toBe(2);
		expect(firstProgress).toEqual([[1, 1]]);
		expect(secondProgress).toEqual([[1, 1]]);
		expect(firstSessions).toEqual(["callback-session"]);
		expect(secondSessions).toEqual(["callback-session"]);
	});

	it("clears a failed callback-free walk so the next call scans again", async () => {
		const tempDir = createTempDir("session-list-all-failure-");
		const sessionRoot = join(tempDir, "sessions");
		mkdirSync(sessionRoot);
		const scanStarted = deferred();
		const releaseScan = deferred();
		fsPromiseMocks.readdir.mockImplementation(async () => {
			scanStarted.resolve();
			await releaseScan.promise;
			throw new Error("directory unavailable");
		});

		const concurrent = Array.from({ length: 128 }, () => SessionManager.listAll(undefined, sessionRoot));
		await scanStarted.promise;
		const scansBeforeRelease = fsPromiseMocks.readdir.mock.calls.length;
		releaseScan.resolve();
		await expect(Promise.all(concurrent)).resolves.toEqual(Array.from({ length: 128 }, () => []));
		expect(scansBeforeRelease).toBe(1);

		writeSession(sessionRoot, "recovered-session");
		fsPromiseMocks.readdir.mockImplementation(fsPromiseMocks.actualReaddir!);
		await expect(SessionManager.listAll(undefined, sessionRoot)).resolves.toEqual([
			expect.objectContaining({ id: "recovered-session" }),
		]);
		expect(fsPromiseMocks.readdir).toHaveBeenCalledTimes(2);
	});
});

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeSession(sessionRoot: string, id: string): void {
	writeFileSync(
		join(sessionRoot, `${id}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: sessionRoot,
		})}
`,
	);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
