import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionInfo } from "../src/core/session-manager.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function contents(name: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id: "identity-test", timestamp: "2026-09-05T00:00:00.000Z", cwd: "/tmp" })}\n${JSON.stringify({ type: "session_info", name })}\n`;
}

describe("session metadata cache file identity", () => {
	it("reloads a same-length atomic replacement preserving mtime and continues caching and appending", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-session-identity-"));
		directories.push(directory);
		const file = join(directory, "session.jsonl");
		const replacement = join(directory, "replacement.jsonl");
		const timestamp = new Date("2026-09-05T00:00:00.000Z");
		writeFileSync(file, contents("before"));
		utimesSync(file, timestamp, timestamp);
		const originalStat = statSync(file);
		const before = await readSessionInfo(file);
		expect(before?.name).toBe("before");
		expect(await readSessionInfo(file)).toBe(before);

		writeFileSync(replacement, contents("after!"));
		utimesSync(replacement, timestamp, timestamp);
		renameSync(replacement, file);
		const replacedStat = statSync(file);
		expect(replacedStat.size).toBe(originalStat.size);
		expect(replacedStat.mtimeMs).toBe(originalStat.mtimeMs);
		expect(replacedStat.ino).not.toBe(originalStat.ino);
		const after = await readSessionInfo(file);
		expect(after?.name).toBe("after!");
		expect(await readSessionInfo(file)).toBe(after);

		appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "appended" })}\n`);
		expect((await readSessionInfo(file))?.name).toBe("appended");
		rmSync(file);
		expect(await readSessionInfo(file)).toBeNull();
	});
});
