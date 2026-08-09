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
});
