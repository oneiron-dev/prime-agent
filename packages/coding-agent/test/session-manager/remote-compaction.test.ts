import type { AssistantMessage, Model, OpenAIResponsesCompactionItem, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../../ai/src/providers/openai-responses-shared.js";
import {
	canReplayRemoteCompaction,
	hasOversizedSyntheticRemoteCheckpoint,
	isIneffectiveRemoteCompaction,
	prepareCompaction,
	sampleRemotePostCheckpointUsage,
	shouldMigrateRemoteCheckpoint,
	shouldUseRemoteCompaction,
} from "../../src/core/compaction/compaction.js";
import { convertToLlm } from "../../src/core/messages.js";
import {
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	parseSessionEntries,
	type RemoteCompactionState,
	type SessionEntry,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

const usage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const opaqueItems: OpenAIResponsesCompactionItem[] = [
	{ type: "message", role: "user", id: "msg_old", status: "completed", content: [] },
	{
		type: "compaction",
		id: "cmp_1",
		encrypted_content: "opaque-ciphertext",
		future_field: { mustRoundTrip: true },
	},
];

const remoteState: RemoteCompactionState = {
	version: 1,
	provider: "cpa-r",
	api: "openai-responses",
	modelId: "gpt-test",
	items: opaqueItems,
};

const responsesModel: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "test",
	api: "openai-responses",
	provider: "cpa-r",
	baseUrl: "http://localhost/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 350_000,
	maxTokens: 16_384,
	compat: { supportsResponsesCompact: true },
};

function modelEntry(): ModelChangeEntry {
	return {
		type: "model_change",
		id: "model",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		provider: "cpa-r",
		modelId: "gpt-test",
		api: "openai-responses",
	};
}

function user(id: string, parentId: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistant(id: string, parentId: string, content: AssistantMessage["content"]): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content,
			api: "openai-responses",
			provider: "cpa-r",
			model: "gpt-test",
			usage,
			stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
			timestamp: 2,
		},
	};
}

function fixture(): { entries: SessionEntry[]; compaction: CompactionEntry } {
	const entries: SessionEntry[] = [
		modelEntry(),
		user("old-user", "model", "old request"),
		assistant("old-assistant", "old-user", [{ type: "text", text: "old answer" }]),
		user("kept-user", "old-assistant", "kept request"),
		assistant("kept-tool-call", "kept-user", [
			{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "/tmp/a" } },
		]),
		{
			type: "message",
			id: "kept-tool-result",
			parentId: "kept-tool-call",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			},
		},
	];
	const compaction: CompactionEntry = {
		type: "compaction",
		id: "remote-compaction",
		parentId: "kept-tool-result",
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: "Provider-native OpenAI Responses compaction checkpoint (opaque).",
		firstKeptEntryId: "kept-user",
		tokensBefore: 100_000,
		mechanism: "remote",
		remoteCompaction: remoteState,
	};
	entries.push(compaction, user("after", compaction.id, "continue"));
	return { entries, compaction };
}

describe("remote compaction session replay", () => {
	it("round-trips opaque items exactly and keeps tool call/result boundaries", () => {
		const { entries } = fixture();
		const fileEntries = parseSessionEntries(
			[
				JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-01-01", cwd: "/tmp" }),
				...entries.map((entry) => JSON.stringify(entry)),
			].join("\n"),
		);
		const context = buildSessionContext(
			fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session"),
		);
		const remote = context.messages[0];
		expect(remote.role).toBe("openaiResponsesCompaction");
		if (remote.role !== "openaiResponsesCompaction") throw new Error("missing remote checkpoint");
		expect(remote.items).toEqual(opaqueItems);
		expect(JSON.stringify(remote.items)).toContain("opaque-ciphertext");
		expect(context.messages.map((message) => message.role)).toEqual([
			"openaiResponsesCompaction",
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		const llmMessages = convertToLlm(context.messages);
		const nativeInput = convertResponsesMessages(
			responsesModel,
			{ messages: llmMessages },
			new Set(["openai", "openai-codex", "opencode"]),
			{ includeSystemPrompt: false },
		);
		expect(nativeInput.slice(0, 2)).toEqual(opaqueItems);
		expect(nativeInput[2]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "kept request" }],
		});
		expect(nativeInput[3]).toMatchObject({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read",
		});
		expect(nativeInput[4]).toMatchObject({ type: "function_call_output", call_id: "call_1", output: "result" });
		expect(nativeInput[5]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "continue" }],
		});
	});

	it("is branch-path scoped and does not leak the checkpoint onto a pre-compaction branch", () => {
		const { entries, compaction } = fixture();
		const branchAfter = user("branch-after", compaction.id, "alternate continuation");
		const branchBefore = user("branch-before", "old-assistant", "older branch");
		const all = [...entries, branchAfter, branchBefore];

		expect(buildSessionContext(all, branchAfter.id).messages[0]?.role).toBe("openaiResponsesCompaction");
		const beforeMessages = buildSessionContext(all, branchBefore.id).messages;
		expect(beforeMessages.some((message) => message.role === "openaiResponsesCompaction")).toBe(false);
		expect(beforeMessages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
	});

	it("rebuilds raw history instead of replaying opaque items after an API-scope switch", () => {
		const { entries, compaction } = fixture();
		const modelSwitch: ModelChangeEntry = {
			type: "model_change",
			id: "foreign-model",
			parentId: compaction.id,
			timestamp: "2026-01-01T00:00:01.000Z",
			provider: "cpa-r",
			modelId: "gpt-test",
			api: "openai-completions",
		};
		const foreignUser = user("foreign-user", modelSwitch.id, "continue elsewhere");
		const context = buildSessionContext([...entries, modelSwitch, foreignUser], foreignUser.id);

		expect(context.messages.some((message) => message.role === "openaiResponsesCompaction")).toBe(false);
		expect(context.messages[0]?.role).toBe("user");
		expect(context.messages.length).toBeGreaterThan(4);
	});

	it.each([
		{ provider: "cpa-r", modelId: "gpt-other", api: "openai-responses" as const },
		{ provider: "anthropic", modelId: "claude-test", api: "anthropic-messages" as const },
	])("rebuilds normalized raw history for incompatible model scope %#", (target) => {
		const { entries, compaction } = fixture();
		const modelSwitch: ModelChangeEntry = {
			type: "model_change",
			id: `switch-${target.provider}`,
			parentId: compaction.id,
			timestamp: "2026-01-01T00:00:01.000Z",
			provider: target.provider,
			modelId: target.modelId,
			api: target.api,
		};
		const leaf = user(`leaf-${target.provider}`, modelSwitch.id, "continue on switched model");
		const context = buildSessionContext([...entries, modelSwitch, leaf], leaf.id);
		expect(context.messages.some((message) => message.role === "openaiResponsesCompaction")).toBe(false);
		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect(context.messages.some((message) => message.role === "user" && message.content === "old request")).toBe(
			true,
		);
	});

	it.each([
		{ version: 2, provider: "cpa-r", api: "openai-responses", modelId: "gpt-test", items: opaqueItems },
		{ version: 1, provider: "cpa-r", api: "openai-responses", modelId: "gpt-test", items: [] },
		{
			version: 1,
			provider: "cpa-r",
			api: "openai-responses",
			modelId: "gpt-test",
			items: [{ type: "compaction", encrypted_content: "" }],
		},
		{
			version: 1,
			provider: "cpa-r",
			api: "openai-responses",
			modelId: "gpt-test",
			items: [{ type: "compaction_summary", encrypted_content: "" }],
		},
		{
			version: 1,
			provider: "cpa-r",
			api: "openai-responses",
			modelId: "gpt-test",
			items: [{ type: "message", role: "user", id: "msg_only" }],
		},
	])("fails closed to raw history for malformed remote state %#", (malformed) => {
		const { entries, compaction } = fixture();
		compaction.remoteCompaction = malformed as RemoteCompactionState;
		const context = buildSessionContext(entries);
		expect(context.messages.some((message) => message.role === "openaiResponsesCompaction")).toBe(false);
		expect(context.messages[0]?.role).toBe("user");
		expect(JSON.stringify(context.messages)).not.toContain("opaque-ciphertext");
	});

	it("accepts CPA compaction_summary checkpoints and preserves companion items exactly", () => {
		const summaryItems: OpenAIResponsesCompactionItem[] = [
			{ type: "message", role: "user", id: "msg_old", status: "completed", content: [] },
			{
				type: "compaction_summary",
				id: "cmp_summary_1",
				encrypted_content: "cpa-opaque-ciphertext",
				future_field: { mustRoundTrip: true },
			},
			{ type: "unknown_companion", id: "uc_1", keep: true },
		];
		const { entries, compaction } = fixture();
		compaction.remoteCompaction = {
			version: 1,
			provider: "cpa-r",
			api: "openai-responses",
			modelId: "gpt-test",
			items: summaryItems,
		};
		const context = buildSessionContext(entries);
		const remote = context.messages[0];
		expect(remote.role).toBe("openaiResponsesCompaction");
		if (remote.role !== "openaiResponsesCompaction") throw new Error("missing remote checkpoint");
		expect(remote.items).toEqual(summaryItems);
		expect(JSON.stringify(remote.items)).toContain("cpa-opaque-ciphertext");
		const nativeInput = convertResponsesMessages(
			responsesModel,
			{ messages: convertToLlm(context.messages) },
			new Set(["openai", "openai-codex", "opencode"]),
			{ includeSystemPrompt: false },
		);
		expect(nativeInput.slice(0, 3)).toEqual(summaryItems);
	});

	it("keeps an exact tool pair when the retained boundary starts at the function call", () => {
		const { entries, compaction } = fixture();
		compaction.firstKeptEntryId = "kept-tool-call";
		const context = buildSessionContext(entries);
		const input = convertResponsesMessages(
			responsesModel,
			{ messages: convertToLlm(context.messages) },
			new Set(["openai", "openai-codex", "opencode"]),
			{ includeSystemPrompt: false },
		);
		expect(input.at(-3)).toMatchObject({ type: "function_call", id: "fc_1", call_id: "call_1" });
		expect(input.at(-2)).toMatchObject({ type: "function_call_output", call_id: "call_1" });
		expect(input.at(-1)).toMatchObject({ role: "user" });
		const outputCallIds = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
		const callIds = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
		expect(outputCallIds).toEqual(callIds);
	});

	it("carries the prior remote checkpoint into repeated compaction preparation", () => {
		const { entries } = fixture();
		const more = user("more", "after", "x".repeat(2_000));
		const final = assistant("final", more.id, [{ type: "text", text: "y".repeat(2_000) }]);
		const preparation = prepareCompaction([...entries, more, final], {
			enabled: true,
			mode: "auto",
			reserveTokens: 16_384,
			keepRecentTokens: 100,
		});

		expect(preparation?.previousRemoteCompaction).toEqual(remoteState);
		expect(preparation?.previousSummary).toBeUndefined();
		expect(preparation?.messagesToSummarize.length).toBeGreaterThan(0);
	});

	it("selects remote mode only by explicit mode or declared compatibility", () => {
		const base = {
			id: "gpt-test",
			name: "test",
			api: "openai-responses" as const,
			provider: "cpa-r",
			baseUrl: "http://localhost/v1",
			reasoning: true,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 350_000,
			maxTokens: 16_384,
		};
		expect(shouldUseRemoteCompaction({ ...base, compat: { supportsResponsesCompact: true } }, "auto")).toBe(true);
		expect(shouldUseRemoteCompaction(base, "auto")).toBe(false);
		expect(shouldUseRemoteCompaction(base, "remote")).toBe(false);
		expect(shouldUseRemoteCompaction({ ...base, compat: { supportsResponsesCompact: false } }, "remote")).toBe(false);
		expect(shouldUseRemoteCompaction({ ...base, api: "openai-completions" }, "remote")).toBe(false);
		expect(canReplayRemoteCompaction(remoteState, { ...base, id: "gpt-other" })).toBe(false);
		expect(canReplayRemoteCompaction(remoteState, { ...base, provider: "other-provider" })).toBe(false);
	});
	it("rejects synthetic oversized remote checkpoints and ineffective near-window shrink", () => {
		const state = {
			...remoteState,
			items: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: `<ipython_state>${"x".repeat(230_000)}</ipython_state>` }],
				},
			],
		} as RemoteCompactionState;
		expect(hasOversizedSyntheticRemoteCheckpoint(state)).toBe(true);
		expect(isIneffectiveRemoteCompaction(370_512, 341_945, 400_000)).toBe(true);
		expect(isIneffectiveRemoteCompaction(370_512, 180_000, 400_000)).toBe(false);
		expect(shouldMigrateRemoteCheckpoint(remoteState, 370_512, 341_945, 400_000)).toBe(true);
		expect(shouldMigrateRemoteCheckpoint(remoteState, 370_512, 180_000, 400_000)).toBe(false);
	});
	it("selects post-checkpoint evidence that actually proves checkpoint size", () => {
		const contextWindow = 400_000;
		function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
			return {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "cpa-r",
				model: "gpt-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
				...overrides,
			} as AssistantMessage;
		}
		const zeroUsageError = assistant({
			stopReason: "error",
			errorMessage: "WebSocket closed before response.completed",
		});
		const incidentUsage = assistant({
			usage: {
				input: 334_265,
				output: 0,
				cacheRead: 7_680,
				cacheWrite: 0,
				totalTokens: 341_945,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});

		// A zero-usage generic error proves nothing; the next real usage row decides.
		const skipped = sampleRemotePostCheckpointUsage([zeroUsageError, incidentUsage], contextWindow);
		expect(skipped).toEqual({ overflow: false, postTokens: 341_945 });
		expect(shouldMigrateRemoteCheckpoint(remoteState, 370_512, skipped.postTokens, contextWindow)).toBe(true);

		// An explicit context overflow is decisive even with zero usage.
		const overflow = sampleRemotePostCheckpointUsage(
			[assistant({ stopReason: "error", errorMessage: "400 invalid_request_error: context_too_large" })],
			contextWindow,
		);
		expect(overflow.overflow).toBe(true);
		expect(overflow.postTokens).toBeUndefined();

		// A healthy checkpoint that halved the context stays on the remote path.
		const healthy = sampleRemotePostCheckpointUsage(
			[
				zeroUsageError,
				assistant({
					usage: {
						input: 180_000,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 180_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			],
			contextWindow,
		);
		expect(healthy).toEqual({ overflow: false, postTokens: 180_000 });
		expect(shouldMigrateRemoteCheckpoint(remoteState, 370_512, healthy.postTokens, contextWindow)).toBe(false);

		// No post-checkpoint evidence at all leaves the remote path untouched.
		expect(sampleRemotePostCheckpointUsage([], contextWindow)).toEqual({ overflow: false });
		expect(sampleRemotePostCheckpointUsage([zeroUsageError], contextWindow)).toEqual({ overflow: false });
	});
});
