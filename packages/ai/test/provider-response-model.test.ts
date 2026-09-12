import type Anthropic from "@anthropic-ai/sdk";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, test } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const base = {
	name: "Fixture",
	baseUrl: "https://fixture.invalid",
	reasoning: true,
	input: ["text"] as ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 1000,
};
const anthropic: Model<"anthropic-messages"> = {
	...base,
	id: "claude-fable-5-1-exp",
	provider: "cpa-a",
	api: "anthropic-messages",
};
const responses: Model<"openai-responses"> = { ...base, id: "gpt-6-astra", provider: "cpa-r", api: "openai-responses" };
function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		model: responses.id,
		provider: responses.provider,
		api: responses.api,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}
async function* events(values: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const value of values) yield value as ResponseStreamEvent;
}
function anthropicClient(model?: string): Anthropic {
	const frames = [
		{
			type: "message_start",
			message: {
				id: "msg_wire",
				...(model === undefined ? {} : { model }),
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return {
		messages: {
			create: () => ({
				asResponse: async () =>
					new Response(
						frames.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			}),
		},
	} as unknown as Anthropic;
}

describe("transport-derived model identity (not an upstream attestation)", () => {
	test.each(["claude-fable-5.1", "gpt-6-astra", "claude-fable-5-1-exp", "unapproved-model"])(
		"preserves requested Anthropic selector and separately captures wire %s",
		async (wire) => {
			const result = await streamAnthropic(anthropic, { messages: [] }, { client: anthropicClient(wire) }).result();
			expect(result.model).toBe("claude-fable-5-1-exp");
			expect(result.responseModel).toBe(wire);
			expect(result.responseModelSource).toBe("provider-response");
			expect(result.responseId).toBe("msg_wire");
			expect(JSON.parse(JSON.stringify(result)).responseModel).toBe(wire);
		},
	);
	test("does not invent an observed Anthropic model when wire identity is missing", async () => {
		const result = await streamAnthropic(anthropic, { messages: [] }, { client: anthropicClient() }).result();
		expect(result.responseModel).toBeUndefined();
		expect(result.responseModelSource).toBeUndefined();
	});
	test("Responses uses terminal model, never the gateway-synthesized created selector", async () => {
		const result = output();
		await processResponsesStream(
			events([
				{ type: "response.created", response: { id: "resp_wire", model: "requested-alias" } },
				{ type: "response.completed", response: { id: "resp_wire", model: "gpt-6-astra", status: "completed" } },
			]),
			result,
			new AssistantMessageEventStream(),
			responses,
		);
		expect(result.model).toBe("gpt-6-astra");
		expect(result.responseModel).toBe("gpt-6-astra");
		expect(result.responseModelSource).toBe("provider-response");
	});
	test("missing terminal model stays unknown even if created contains one", async () => {
		const result = output();
		await processResponsesStream(
			events([
				{ type: "response.created", response: { id: "resp_wire", model: "gpt-6-astra" } },
				{ type: "response.completed", response: { id: "resp_wire", status: "completed" } },
			]),
			result,
			new AssistantMessageEventStream(),
			responses,
		);
		expect(result.responseModel).toBeUndefined();
		expect(result.responseModelSource).toBeUndefined();
	});
	test("incomplete terminal preserves observed identity but remains unsuccessful output", async () => {
		const result = output();
		await processResponsesStream(
			events([
				{ type: "response.incomplete", response: { id: "resp_wire", model: "gpt-6-astra", status: "incomplete" } },
			]),
			result,
			new AssistantMessageEventStream(),
			responses,
		);
		expect(result.responseModel).toBe("gpt-6-astra");
		expect(result.stopReason).toBe("length");
	});
});
