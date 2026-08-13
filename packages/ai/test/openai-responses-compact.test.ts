import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compactOpenAIResponses,
	createOpenAIResponsesCompactionMessage,
	getResponsesCompactFallbackReason,
} from "../src/providers/openai-responses-compact.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import type { Context, Model } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "cpa-r",
	baseUrl: "http://provider.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 350_000,
	maxTokens: 16_384,
	compat: { supportsResponsesCompact: true },
};

const compactionItem = {
	type: "compaction",
	id: "cmp_1",
	encrypted_content: "opaque-ciphertext",
	extra_future_field: { preserved: true },
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("OpenAI Responses remote compaction", () => {
	it("uses unary POST /responses/compact and preserves opaque output items", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			expect(url).toBe("http://provider.test/v1/responses/compact");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body.model).toBe("gpt-test");
			expect(body.instructions).toContain("system instruction");
			expect(body.instructions).toContain("focus on exact paths");
			expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "old context" }] }]);
			return new Response(
				JSON.stringify({
					id: "resp_compact_1",
					object: "response.compaction",
					created_at: 1,
					output: [
						{ type: "message", role: "user", id: "msg_1", status: "completed", content: [] },
						compactionItem,
					],
					usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor() {
					throw new Error("compact must not construct a WebSocket");
				}
			},
		);

		const result = await compactOpenAIResponses(
			model,
			{ systemPrompt: "system instruction", messages: [{ role: "user", content: "old context", timestamp: 1 }] },
			{ apiKey: "test-key", customInstructions: "focus on exact paths", maxRetries: 0 },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.items.at(-1)).toEqual(compactionItem);
	});

	it("replays matching opaque items natively and drops foreign scope", () => {
		const matching = createOpenAIResponsesCompactionMessage("cpa-r", "gpt-test", [compactionItem], 1);
		const foreign = createOpenAIResponsesCompactionMessage("other", "gpt-test", [compactionItem], 1);
		const convert = (messages: Context["messages"]) =>
			convertResponsesMessages(model, { messages }, new Set(["openai", "openai-codex", "opencode"]), {
				includeSystemPrompt: false,
			});

		expect(convert([matching])).toEqual([compactionItem]);
		expect(convert([foreign])).toEqual([]);
	});

	it("only classifies concrete unsupported endpoint behavior for local fallback", () => {
		expect(getResponsesCompactFallbackReason(Object.assign(new Error("not found"), { status: 404 }))).toContain(
			"HTTP 404",
		);
		expect(
			getResponsesCompactFallbackReason(
				Object.assign(new Error("model does not support compaction"), { status: 400 }),
			),
		).toContain("HTTP 400");
		expect(
			getResponsesCompactFallbackReason(
				Object.assign(new Error("upstream echoed opaque-ciphertext"), { status: 503 }),
			),
		).toBe("HTTP 503 compact endpoint temporarily unavailable");
		expect(
			getResponsesCompactFallbackReason(
				Object.assign(new Error("no auth available"), { status: 503, code: "auth_unavailable" }),
			),
		).toBeUndefined();
		expect(
			getResponsesCompactFallbackReason(
				Object.assign(new Error("compact unsupported opaque-ciphertext"), { status: 400 }),
			),
		).toBe("HTTP 400 compact unsupported");
		expect(
			getResponsesCompactFallbackReason(Object.assign(new Error("unauthorized"), { status: 401 })),
		).toBeUndefined();
		expect(
			getResponsesCompactFallbackReason(Object.assign(new Error("server error"), { status: 500 })),
		).toBeUndefined();
	});

	const compactionSummaryItem = {
		type: "compaction_summary",
		id: "cmp_summary_1",
		encrypted_content: "cpa-opaque-ciphertext",
		extra_future_field: { preserved: true },
	};

	async function compactWithOutput(output: unknown[]) {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					id: "resp_compact_1",
					object: "response.compaction",
					created_at: 1,
					output,
					usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const result = await compactOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "old context", timestamp: 1 }] },
			{ apiKey: "test-key", maxRetries: 0 },
		);
		return { result, fetchMock };
	}

	it("accepts CPA compaction_summary checkpoints with nonempty encrypted_content", async () => {
		const output = [
			{ type: "message", role: "user", id: "msg_1", status: "completed", content: [] },
			compactionSummaryItem,
		];
		const { result } = await compactWithOutput(output);
		expect(result.items).toEqual(output);
		expect(result.items.at(-1)).toEqual(compactionSummaryItem);
	});

	it("accepts OpenAI compaction checkpoints and preserves companion item order/types/fields", async () => {
		const output = [
			{ type: "message", role: "assistant", id: "msg_a", status: "completed", content: [], future_a: 1 },
			compactionItem,
			{ type: "unknown_companion", id: "uc_1", payload: { keep: true } },
		];
		const { result } = await compactWithOutput(output);
		expect(result.items).toEqual(output);
		expect(result.items.map((item) => item.type)).toEqual(["message", "compaction", "unknown_companion"]);
	});

	it("fail-closes when checkpoint encrypted_content is empty or missing", async () => {
		await expect(
			compactWithOutput([
				{ type: "message", role: "user", id: "msg_1", status: "completed", content: [] },
				{ type: "compaction_summary", id: "cmp_empty", encrypted_content: "" },
			]),
		).rejects.toThrow(/invalid output items/);
		await expect(
			compactWithOutput([
				{ type: "compaction", id: "cmp_missing" },
				{ type: "message", role: "user", id: "msg_1", status: "completed", content: [] },
			]),
		).rejects.toThrow(/invalid output items/);
		await expect(
			compactWithOutput([{ type: "message", role: "user", id: "msg_1", status: "completed", content: [] }]),
		).rejects.toThrow(/invalid output items/);
	});

	it("replays compaction and compaction_summary items repeatedly without mutation", () => {
		const withSummary = createOpenAIResponsesCompactionMessage(
			"cpa-r",
			"gpt-test",
			[{ type: "message", role: "user", id: "msg_1", status: "completed", content: [] }, compactionSummaryItem],
			1,
		);
		const withCompaction = createOpenAIResponsesCompactionMessage("cpa-r", "gpt-test", [compactionItem], 1);
		const convert = (messages: Context["messages"]) =>
			convertResponsesMessages(model, { messages }, new Set(["openai", "openai-codex", "opencode"]), {
				includeSystemPrompt: false,
			});

		const firstSummary = convert([withSummary]);
		const secondSummary = convert([withSummary]);
		expect(firstSummary).toEqual(withSummary.items);
		expect(secondSummary).toEqual(withSummary.items);
		expect(firstSummary).toEqual(secondSummary);

		const firstCompaction = convert([withCompaction]);
		const secondCompaction = convert([withCompaction]);
		expect(firstCompaction).toEqual([compactionItem]);
		expect(secondCompaction).toEqual([compactionItem]);
		// Source message items remain untouched across repeated replays
		expect(withSummary.items.at(-1)).toEqual(compactionSummaryItem);
		expect(withCompaction.items.at(-1)).toEqual(compactionItem);
	});
});
