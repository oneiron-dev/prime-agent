import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function createModel(provider: string): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider,
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* createFunctionCallEvents(argumentsJson: string, terminal = true): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: '{"path":"README.md"',
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		delta: ',"content":"updated"}',
	} as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.done",
		arguments: argumentsJson,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: argumentsJson,
		},
	} as ResponseStreamEvent;
	if (terminal) yield { type: "response.completed", response: { status: "completed" } } as ResponseStreamEvent;
}

async function* createNestedCpaErrorEvent(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "error",
		status: 401,
		error: {
			type: "authentication_error",
			code: "invalid_api_key",
			message: "Authorization: Bearer cpa-secret-value was rejected",
		},
	} as unknown as ResponseStreamEvent;
}

describe("openai responses partialJson cleanup", () => {
	it("classifies nested CPA error frames without retaining bearer credentials", async () => {
		const model = createModel("cpa-r");
		const result = processResponsesStream(
			createNestedCpaErrorEvent(),
			createOutput(model),
			new AssistantMessageEventStream(),
			model,
		);
		await expect(result).rejects.toThrow(
			"Provider authentication failed (authentication_error, invalid_api_key, 401): Authorization: Bearer [REDACTED] was rejected",
		);
		await result.catch((error: unknown) => {
			expect(error).toMatchObject({
				info: {
					kind: "auth",
					status: 401,
					providerErrorType: "authentication_error",
					providerErrorCode: "invalid_api_key",
					raw: expect.not.stringContaining("cpa-secret-value"),
				},
			});
		});
	});

	it("removes partialJson from persisted tool-call blocks at output_item.done", async () => {
		const model = createModel("openai");
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");
		const argumentsJson = '{"path":"README.md","content":"updated"}';

		await processResponsesStream(createFunctionCallEvents(argumentsJson), output, stream, model);

		expect(output.content).toHaveLength(1);
		const persistedToolCall = output.content[0];
		expect(persistedToolCall?.type).toBe("toolCall");
		if (!persistedToolCall || persistedToolCall.type !== "toolCall") {
			throw new Error("Expected toolCall block");
		}
		expect(persistedToolCall.arguments).toEqual({ path: "README.md", content: "updated" });
		expect("partialJson" in persistedToolCall).toBe(false);

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const toolCallEnd = emittedEvents.find((event) => event.type === "toolcall_end");
		expect(toolCallEnd).toBeDefined();
		if (!toolCallEnd || toolCallEnd.type !== "toolcall_end") {
			throw new Error("Expected toolcall_end event");
		}
		expect(toolCallEnd.toolCall).toBe(persistedToolCall);
		expect("partialJson" in toolCallEnd.toolCall).toBe(false);
	});

	it("rejects a stream that ends before its terminal response event as a retryable stream drop", async () => {
		const model = createModel("cpa-r");
		const result = processResponsesStream(
			createFunctionCallEvents("{}", false),
			createOutput(model),
			new AssistantMessageEventStream(),
			model,
		);
		await expect(result).rejects.toMatchObject({
			info: { kind: "transport", providerErrorType: "stream_drop", transport: { protocol: "sse", cause: "eof" } },
		});
	});
});
