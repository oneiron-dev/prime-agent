import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { createDeferred } from "./suite/scheduling.js";

describe("AgentDaemon registry read cache", () => {
	it("prevents an invalidated read flight from overwriting the fresh cache", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-registry-revision-race-"));
		const releaseOldRead = createDeferred<void>();
		try {
			const registryPath = join(tempDir, "rlm-subagents.jsonl");
			const parentSessionFile = join(tempDir, "parent.jsonl");
			const runningEntry = {
				type: "rlm_subagent" as const,
				childId: "racing-child",
				sessionName: "racing-child",
				sessionDir: join(tempDir, "child"),
				sessionFile: join(tempDir, "child.jsonl"),
				parentSessionId: "parent-session",
				parentSessionFile,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				status: "running" as const,
				createdAt: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			type RegistryEntry = Omit<typeof runningEntry, "status"> & {
				status: "running" | "completed" | "deleted";
			};
			writeFileSync(registryPath, `${JSON.stringify(runningEntry)}\n`);
			const parentState = {
				runtime: {
					session: {
						sessionId: runningEntry.parentSessionId,
						sessionFile: parentSessionFile,
						sessionManager: { getSessionArtifactDir: () => tempDir },
					},
				},
			};
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: vi.fn(),
			});
			const internals = daemon as unknown as {
				readRlmSubagentRegistryFile(path: string): Promise<string>;
				readLatestRlmSubagentRegistryPath(path: string): Promise<RegistryEntry[]>;
				appendRlmSubagentRegistryEntry(state: unknown, entry: RegistryEntry): boolean;
				rlmSubagentRegistryReadCache: Map<string, { entries: RegistryEntry[] }>;
			};
			const originalRead = internals.readRlmSubagentRegistryFile.bind(daemon);
			const oldReadStarted = createDeferred<void>();
			let readCount = 0;
			const readFile = vi.spyOn(internals, "readRlmSubagentRegistryFile").mockImplementation(async (path) => {
				readCount++;
				if (readCount !== 1) return originalRead(path);
				const staleContents = await originalRead(path);
				oldReadStarted.resolve();
				await releaseOldRead.promise;
				return staleContents;
			});
			try {
				const oldRead = internals.readLatestRlmSubagentRegistryPath(registryPath);
				await oldReadStarted.promise;

				const completedEntry = { ...runningEntry, status: "completed" as const };
				expect(internals.appendRlmSubagentRegistryEntry(parentState, completedEntry)).toBe(true);
				await expect(internals.readLatestRlmSubagentRegistryPath(registryPath)).resolves.toEqual([completedEntry]);
				expect(readFile).toHaveBeenCalledTimes(2);

				releaseOldRead.resolve();
				await expect(oldRead).resolves.toEqual([runningEntry]);
				expect(internals.rlmSubagentRegistryReadCache.get(resolve(registryPath))?.entries).toEqual([
					completedEntry,
				]);
				await expect(internals.readLatestRlmSubagentRegistryPath(registryPath)).resolves.toEqual([completedEntry]);
				expect(readFile).toHaveBeenCalledTimes(2);
			} finally {
				readFile.mockRestore();
			}
		} finally {
			releaseOldRead.resolve();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
