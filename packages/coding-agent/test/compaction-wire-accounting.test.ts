import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	registerApiProvider,
	type StreamOptions,
	type Usage,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	compactMapReduce,
	DEFAULT_COMPACTION_SETTINGS,
	DeepCompactionCache,
	type SummaryCallRunner,
} from "../src/core/compaction/index.js";
import { createFileOps } from "../src/core/compaction/utils.js";
import { IDEMPOTENCY_KEY_HEADER, MODEL_REQUEST_ID_HEADER } from "../src/core/semantic-edges.js";

interface WireCall {
	ordinal: number;
	prompt: string;
	headers: Record<string, string> | undefined;
}

// Distinct, nonzero fields expose dropped slices and cache/cost accounting errors.
function usageFor(weight: number): Usage {
	return {
		input: 11 * weight,
		output: 7 * weight,
		cacheRead: 3 * weight,
		cacheWrite: 5 * weight,
		totalTokens: 26 * weight,
		cost: { input: weight, output: 2 * weight, cacheRead: 3 * weight, cacheWrite: 4 * weight, total: 10 * weight },
	};
}

function preparation(isSplitTurn = false): CompactionPreparation {
	const messages: AgentMessage[] = Array.from({ length: 12 }, (_unused, index) => ({
		role: "user",
		content: `turn-${index}-${"a".repeat(4_000)}`,
		timestamp: 1,
	}));
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: messages,
		turnPrefixMessages: isSplitTurn ? messages : [],
		isSplitTurn,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 8_000 },
	};
}

describe("compaction wire identity and usage", () => {
	const providerIds: string[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const id of providerIds.splice(0)) unregisterApiProviders(id);
		for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	function setup() {
		const api = `compaction-wire-${randomUUID()}`;
		providerIds.push(api);
		const model: Model<string> = {
			id: "summary",
			name: "In-memory summary provider",
			api,
			provider: api,
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64_000,
			maxTokens: 16_384,
		};
		const calls: WireCall[] = [];
		const issuedIds: string[] = [];
		const stream = (_model: Model<string>, context: Context, options?: StreamOptions) => {
			const message = context.messages[0];
			const content = message.role === "user" ? message.content : "";
			const prompt =
				typeof content === "string"
					? content
					: content.map((block) => (block.type === "text" ? block.text : "")).join("");
			const ordinal = calls.length + 1;
			calls.push({ ordinal, prompt, headers: options?.headers });
			const response = {
				...fauxAssistantMessage(`summary ${ordinal}`),
				api,
				provider: api,
				model: model.id,
				usage: usageFor(ordinal),
			};
			const events = createAssistantMessageEventStream();
			events.push({ type: "done", reason: "stop", message: response });
			return events;
		};
		registerApiProvider({ api, stream, streamSimple: stream }, api);
		const summaryCall: SummaryCallRunner = async (call) => {
			const requestId = `summary-request-${issuedIds.length + 1}`;
			issuedIds.push(requestId);
			return call({
				"x-summary-sentinel": "keep-me",
				[MODEL_REQUEST_ID_HEADER]: requestId,
				[IDEMPOTENCY_KEY_HEADER]: requestId,
			});
		};
		return { model, calls, issuedIds, summaryCall };
	}

	function expectWireIdentities(calls: WireCall[], issuedIds: string[]) {
		expect(calls).toHaveLength(issuedIds.length);
		const wireIds = calls.map((call) => call.headers?.[MODEL_REQUEST_ID_HEADER]);
		expect(wireIds).toEqual(issuedIds);
		expect(new Set(wireIds).size).toBe(calls.length);
		for (const call of calls) {
			expect(call.headers?.[IDEMPOTENCY_KEY_HEADER]).toBe(call.headers?.[MODEL_REQUEST_ID_HEADER]);
			expect(call.headers?.["x-summary-sentinel"]).toBe("keep-me");
		}
	}

	it.each([false, true])("accounts for every rolling wire call (split turn: %s)", async (split) => {
		const { model, calls, issuedIds, summaryCall } = setup();

		const result = await compact(
			preparation(split),
			model,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			summaryCall,
		);

		expect(calls.length).toBeGreaterThan(split ? 2 : 1);
		expectWireIdentities(calls, issuedIds);
		expect(result.usage).toEqual(usageFor(calls.reduce((total, call) => total + call.ordinal, 0)));
		expect(result.summary).toContain("summary");
		if (split) expect(result.summary).toContain("Turn Context (split turn)");
	});

	it("bills only fresh map and merge calls when resuming cached deep partials", async () => {
		const { model, calls, issuedIds, summaryCall } = setup();
		const dir = await mkdtemp(join(tmpdir(), "compaction-wire-"));
		tempDirs.push(dir);
		const cache = new DeepCompactionCache(dir);
		const prep = preparation();
		const options = { cache, sessionId: "wire-accounting", summaryCall };
		const first = await compactMapReduce(prep, model, "test-key", options);
		const metadata = first.details?.mapReduce;
		expect(metadata).toBeDefined();
		if (!metadata) throw new Error("Expected deep compaction metadata");
		expect(metadata.chunks).toBeGreaterThan(1);
		expect(first.usage).toEqual(usageFor(calls.reduce((total, call) => total + call.ordinal, 0)));

		// Simulate a retry with one missing map result; all other durable partials survive.
		await rm(join(cache.runDir(metadata.runId), "00000.json"));
		const previousCallCount = calls.length;
		const result = await compactMapReduce(prep, model, "test-key", options);
		const freshCalls = calls.slice(previousCallCount);

		expect(result.details?.mapReduce?.runId).toBe(metadata.runId);
		expect(result.details?.mapReduce?.resumedChunks).toBe(metadata.chunks - 1);
		expect(freshCalls).toHaveLength(2);
		expect(freshCalls[0].prompt).toMatch(/Part 1 of \d+\./);
		expect(freshCalls[1].prompt).toContain('<partial-summary index="1">');
		expectWireIdentities(calls, issuedIds);
		expect(result.usage).toEqual(usageFor(freshCalls.reduce((total, call) => total + call.ordinal, 0)));
	});
});
