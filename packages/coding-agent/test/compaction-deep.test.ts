/**
 * Deep compaction (`/compact-deep`): checkpoint seeding, resumable map partials,
 * bounded parallelism, and cache lifetime.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compactMapReduce,
	computeDeepRunId,
	DEEP_MAP_CONCURRENCY,
	DEFAULT_COMPACTION_SETTINGS,
	DeepCompactionCache,
	deepChunkDigest,
	prepareCompaction,
} from "../src/core/compaction/index.js";
import { createFileOps } from "../src/core/compaction/utils.js";
import type { CompactionEntry, RemoteCompactionState, SessionEntry } from "../src/core/session-manager.js";
import { createHarness, type Harness } from "./suite/harness.js";

const REMOTE_STATE: RemoteCompactionState = {
	version: 1,
	provider: "openai",
	api: "openai-responses",
	modelId: "gpt-5",
	items: [{ type: "compaction", encrypted_content: "opaque-checkpoint" }],
};

let entryCounter = 0;

function messageEntry(text: string): SessionEntry {
	const id = `m${entryCounter++}`;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() } satisfies AgentMessage,
	};
}

function compactionEntry(summary: string, firstKeptEntryId: string, mechanism: "local" | "remote"): CompactionEntry {
	return {
		type: "compaction",
		id: `c${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10_000,
		mechanism,
		...(mechanism === "remote" ? { remoteCompaction: REMOTE_STATE } : {}),
	};
}

function texts(messages: AgentMessage[]): string[] {
	return messages.map((message) =>
		typeof (message as { content: unknown }).content === "string"
			? String((message as { content: string }).content)
			: "",
	);
}

/**
 * Branch shape: ancient history, a readable local checkpoint, more raw turns, an
 * opaque remote checkpoint, then the newest raw turns.
 */
function branchWithLocalThenRemoteCheckpoints() {
	const ancient = [messageEntry("ancient-1"), messageEntry("ancient-2")];
	const localTail = [messageEntry("local-tail-1"), messageEntry("local-tail-2")];
	const local = compactionEntry("LOCAL CHECKPOINT SUMMARY", localTail[0].id, "local");
	const afterLocal = [messageEntry("after-local-1"), messageEntry("after-local-2")];
	const remoteTail = [messageEntry("remote-tail-1")];
	const remote = compactionEntry("Provider-native checkpoint (opaque).", remoteTail[0].id, "remote");
	const afterRemote = [messageEntry("after-remote-1")];
	return [...ancient, ...localTail, local, ...afterLocal, ...remoteTail, remote, ...afterRemote];
}

const SETTINGS = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

describe("deep compaction seeding", () => {
	it("seeds from the newest readable local checkpoint even when a newer remote checkpoint exists", () => {
		const entries = branchWithLocalThenRemoteCheckpoints();

		const preparation = prepareCompaction(entries, SETTINGS, { seed: "newest-readable-summary" });

		expect(preparation).toBeDefined();
		expect(preparation?.previousSummary).toBe("LOCAL CHECKPOINT SUMMARY");
		expect(preparation?.previousRemoteCompaction).toBeUndefined();
		const summarized = texts(preparation?.messagesToSummarize ?? []);
		// The checkpoint's retained tail and everything after it — including the raw
		// turns the opaque remote checkpoint covered — are re-summarized.
		expect(summarized).toContain("local-tail-1");
		expect(summarized).toContain("after-local-1");
		expect(summarized).toContain("remote-tail-1");
		// History before the checkpoint is carried by its summary, not re-read.
		expect(summarized).not.toContain("ancient-1");
	});

	it("keeps ordinary compaction on the newest checkpoint of any mechanism", () => {
		const entries = branchWithLocalThenRemoteCheckpoints();

		const preparation = prepareCompaction(entries, SETTINGS, {});

		expect(preparation?.previousSummary).toBeUndefined();
		expect(preparation?.previousRemoteCompaction).toEqual(REMOTE_STATE);
		expect(texts(preparation?.messagesToSummarize ?? [])).not.toContain("local-tail-1");
	});

	it("falls back to the branch root when no readable checkpoint is usable", () => {
		const entries = [messageEntry("root-1"), messageEntry("root-2")];
		const orphan = compactionEntry("summary with a missing tail", "not-on-this-branch", "local");
		const withOrphan = [...entries, orphan, messageEntry("newest")];

		const preparation = prepareCompaction(withOrphan, SETTINGS, { seed: "newest-readable-summary" });

		expect(preparation?.previousSummary).toBeUndefined();
		expect(texts(preparation?.messagesToSummarize ?? [])).toContain("root-1");
	});
});

describe("deep compaction map-reduce", () => {
	const registrations: Array<{ unregister: () => void }> = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (registrations.length > 0) registrations.pop()?.unregister();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) await rm(dir, { recursive: true, force: true });
		}
	});

	const reserveTokens = 8_000;

	async function cacheDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "deep-compaction-"));
		tempDirs.push(dir);
		return dir;
	}

	function partOf(prompt: string): number | undefined {
		const match = prompt.match(/Part (\d+) of \d+\./);
		return match ? Number(match[1]) : undefined;
	}

	/**
	 * One faux registration per test. The responder is swappable so a resumed run
	 * keeps the exact model identity of the run it resumes.
	 */
	function setup(initialRespond: (prompt: string) => Promise<string> | string) {
		const prompts: string[] = [];
		let respond = initialRespond;
		const faux = registerFauxProvider({ models: [{ id: "deep", contextWindow: 64_000, maxTokens: 16_384 }] });
		registrations.push(faux);
		faux.setResponses(
			Array.from({ length: 512 }, () => async (context: Context, _options: StreamOptions | undefined) => {
				const content = (context.messages[0] as { content?: unknown }).content;
				const prompt = Array.isArray(content)
					? (content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("")
					: String(content ?? "");
				prompts.push(prompt);
				return fauxAssistantMessage(await respond(prompt));
			}),
		);
		return {
			faux,
			prompts,
			model: faux.getModel() as Model<string>,
			setRespond(next: (prompt: string) => Promise<string> | string) {
				respond = next;
			},
		};
	}

	/** Enough distinct bulk to split into several map chunks. */
	function preparation(messageCount = 24, previousSummary?: string): CompactionPreparation {
		return {
			firstKeptEntryId: "kept",
			messagesToSummarize: Array.from({ length: messageCount }, (_unused, index) => ({
				role: "user",
				content: `turn-${index}-${"a".repeat(4_000)}`,
				timestamp: 1,
			})) as AgentMessage[],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 400_000,
			previousSummary,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens },
		};
	}

	it("resumes completed map chunks after a cancelled run instead of restarting at chunk 1", async () => {
		const dir = await cacheDir();
		const cache = new DeepCompactionCache(dir);
		const controller = new AbortController();
		const prep = preparation();

		const first = setup(async (prompt) => {
			const part = partOf(prompt);
			if (part === undefined) return "merged";
			if (part <= 2) return `partial ${part}`;
			// Cancel only once the first two partials are durably stored, so the
			// resumable state under test is exact rather than timing-dependent.
			await vi.waitFor(() => expect(readdirSync(join(dir, runId)).length).toBeGreaterThanOrEqual(2));
			controller.abort();
			return "unreachable";
		});
		const runId = computeDeepRunId({
			sessionId: "session-1",
			firstKeptEntryId: prep.firstKeptEntryId,
			previousSummary: undefined,
			chunkDigests: await chunkDigestsFor(prep, first.model),
			model: first.model,
			thinkingLevel: undefined,
			customInstructions: undefined,
			settings: prep.settings,
		});

		await expect(
			compactMapReduce(prep, first.model, "key", {
				signal: controller.signal,
				cache,
				sessionId: "session-1",
			}),
		).rejects.toThrow(/cancelled/i);
		expect(first.prompts.map(partOf)).toContain(1);
		expect(readdirSync(join(dir, runId))).toHaveLength(2);

		// Second attempt: unchanged preparation and model identity, resumed partials.
		first.prompts.length = 0;
		first.setRespond((prompt) => {
			const part = partOf(prompt);
			return part === undefined ? "merged summary" : `partial ${part}`;
		});
		const result = await compactMapReduce(prep, first.model, "key", { cache, sessionId: "session-1" });

		const resumedParts = first.prompts.map(partOf).filter((part): part is number => part !== undefined);
		expect(resumedParts).not.toContain(1);
		expect(resumedParts).not.toContain(2);
		expect(result.details?.mapReduce?.resumedChunks).toBe(2);
		expect(result.details?.mapReduce?.runId).toBe(runId);
		expect(result.summary).toContain("2 chunk(s) resumed from cache");
	});

	it("rejects partials whose chunk content, model, or instructions no longer match", async () => {
		const dir = await cacheDir();
		const cache = new DeepCompactionCache(dir);
		const prep = preparation();
		const { model, prompts } = setup((prompt) => {
			const part = partOf(prompt);
			return part === undefined ? "merged summary" : `partial ${part}`;
		});
		const first = await compactMapReduce(prep, model, "key", { cache, sessionId: "session-1" });
		const runId = first.details?.mapReduce?.runId as string;
		expect(readdirSync(join(dir, runId)).length).toBeGreaterThan(0);

		// A different custom instruction is a different summary: nothing may be reused.
		prompts.length = 0;
		const second = await compactMapReduce(prep, model, "key", {
			cache,
			sessionId: "session-1",
			customInstructions: "focus on the parser",
		});
		expect(second.details?.mapReduce?.runId).not.toBe(runId);
		expect(second.details?.mapReduce?.resumedChunks).toBe(0);
		expect(prompts.map(partOf)).toContain(1);

		// A record whose digest no longer describes its chunk is stale, not a hit.
		const digests = await chunkDigestsFor(prep, model);
		expect((await cache.loadPartials(runId, digests)).get(0)).toBeDefined();
		await cache.savePartial(runId, 0, "0".repeat(64), "poisoned partial");
		expect((await cache.loadPartials(runId, digests)).get(0)).toBeUndefined();

		// So is a record written under a different run identity.
		writeFileSync(
			join(dir, runId, "00001.json"),
			JSON.stringify({ version: 1, runId: "other-run", index: 1, digest: digests[1], summary: "foreign" }),
		);
		expect((await cache.loadPartials(runId, digests)).get(1)).toBeUndefined();
	});

	it("runs missing chunks with bounded parallelism and merges them in chronological order", async () => {
		const dir = await cacheDir();
		const cache = new DeepCompactionCache(dir);
		let inFlight = 0;
		let peakInFlight = 0;
		const { model, prompts } = setup(async (prompt) => {
			const part = partOf(prompt);
			if (part === undefined) return "merged summary";
			inFlight++;
			peakInFlight = Math.max(peakInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return `partial ${part}`;
		});

		const result = await compactMapReduce(preparation(40), model, "key", { cache, sessionId: "session-1" });

		const chunkCount = result.details?.mapReduce?.chunks ?? 0;
		expect(chunkCount).toBeGreaterThan(DEEP_MAP_CONCURRENCY);
		expect(peakInFlight).toBeGreaterThan(1);
		expect(peakInFlight).toBeLessThanOrEqual(DEEP_MAP_CONCURRENCY);
		// The merge sees the partials in chunk order regardless of completion order.
		const mergePrompt = prompts.find((prompt) => prompt.includes('<partial-summary index="1">'));
		expect(mergePrompt).toBeDefined();
		const positions = Array.from({ length: chunkCount }, (_unused, index) =>
			(mergePrompt as string).indexOf(`partial ${index + 1}\n`),
		);
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it("carries a seeded checkpoint summary into the merge as the oldest partial", async () => {
		const { model, prompts } = setup((prompt) => {
			const part = partOf(prompt);
			return part === undefined ? "merged summary" : `partial ${part}`;
		});

		const result = await compactMapReduce(preparation(24, "PRIOR CHECKPOINT BODY"), model, "key", {
			sessionId: "session-1",
		});

		const mergePrompt = prompts.find((prompt) => prompt.includes("PRIOR CHECKPOINT BODY"));
		expect(mergePrompt).toBeDefined();
		expect((mergePrompt as string).indexOf("PRIOR CHECKPOINT BODY")).toBeLessThan(
			(mergePrompt as string).indexOf("partial 1\n"),
		);
		expect(result.details?.mapReduce?.seededFromCheckpoint).toBe(true);
		expect(result.summary).toContain("seeded from the prior checkpoint summary");
	});

	it("reports completed/total map progress without touching the session branch", async () => {
		const progress: Array<{ phase: string; completed: number; total: number }> = [];
		const { model } = setup((prompt) => (partOf(prompt) === undefined ? "merged summary" : "partial"));

		const result = await compactMapReduce(preparation(24), model, "key", {
			sessionId: "session-1",
			onProgress: (update) => progress.push({ ...update }),
		});

		const total = result.details?.mapReduce?.chunks ?? 0;
		const map = progress.filter((update) => update.phase === "map");
		expect(map[0]).toEqual({ phase: "map", completed: 0, total });
		expect(map[map.length - 1]).toEqual({ phase: "map", completed: total, total });
	});

	/** Chunk digests as the driver computes them, for identity assertions. */
	async function chunkDigestsFor(prep: CompactionPreparation, model: Model<string>): Promise<string[]> {
		const { convertToLlm } = await import("../src/core/messages.js");
		const { splitConversationForSummary } = await import("../src/core/compaction/utils.js");
		const { summaryRequestByteLimit, MAP_REDUCE_MAX_CHUNKS } = await import("../src/core/compaction/index.js");
		const maxTokens = Math.floor(0.8 * prep.settings.reserveTokens);
		const requestLimit = summaryRequestByteLimit(model, prep.settings.reserveTokens, maxTokens);
		const chunks = splitConversationForSummary(
			convertToLlm([...prep.messagesToSummarize, ...prep.turnPrefixMessages]),
			Math.max(1_024, Math.floor(requestLimit / 3)),
			MAP_REDUCE_MAX_CHUNKS,
		);
		return chunks.map(deepChunkDigest);
	}
});

describe("deep compaction cache lifetime", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createDeepSession() {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 8_000 } },
			models: [{ id: "deep", contextWindow: 64_000, maxTokens: 16_384 }],
		});
		harnesses.push(harness);
		for (let index = 0; index < 12; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: `turn-${index}-${"a".repeat(4_000)}`,
				timestamp: Date.now(),
			});
		}
		harness.setResponses(
			Array.from({ length: 256 }, () => () => fauxAssistantMessage("## Goal\ndeep summary\n\n## Next Steps\n1. go")),
		);
		const artifactDir = harness.sessionManager.getSessionArtifactDir() as string;
		return { harness, cacheRoot: join(artifactDir, "deep-compaction") };
	}

	it("keeps map partials when the session commit fails and removes them once it succeeds", async () => {
		const { harness, cacheRoot } = await createDeepSession();
		const appendSpy = vi.spyOn(harness.sessionManager, "appendCompaction").mockImplementationOnce(() => {
			throw new Error("session write failed");
		});

		await expect(harness.session.compact(undefined, { deep: true })).rejects.toThrow("session write failed");

		// The summary was generated but never committed: the partials must survive.
		expect(existsSync(cacheRoot)).toBe(true);
		const pendingRuns = readdirSync(cacheRoot);
		expect(pendingRuns).toHaveLength(1);
		expect(readdirSync(join(cacheRoot, pendingRuns[0])).length).toBeGreaterThan(0);

		appendSpy.mockRestore();
		const result = await harness.session.compact(undefined, { deep: true });

		expect(result.summary).toContain("Deep map-reduce compaction");
		expect(existsSync(join(cacheRoot, pendingRuns[0]))).toBe(false);
		expect(harness.eventsOfType("compaction_progress").length).toBeGreaterThan(0);
	});
});
