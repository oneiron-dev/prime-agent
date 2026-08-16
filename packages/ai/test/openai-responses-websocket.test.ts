import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ calls: 0 }));
vi.mock("openai", () => ({
	default: class {
		responses = {
			create: () => {
				sdk.calls++;
				return {
					withResponse: async () => ({
						data: (async function* () {
							yield {
								type: "response.completed",
								response: {
									id: "sse",
									status: "completed",
									usage: {
										input_tokens: 1,
										output_tokens: 1,
										total_tokens: 2,
										input_tokens_details: { cached_tokens: 0 },
									},
								},
							};
						})(),
						response: new Response(null, { status: 200 }),
					}),
				};
			},
		};
	},
}));

import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import {
	closeOpenAIResponsesWebSocketSessions,
	processOpenAIResponsesWebSocket,
	resolveOpenAIResponsesWebSocketUrl,
	setOpenAIResponsesWebSocketConstructorForTesting,
} from "../src/providers/openai-responses-websocket.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

type Listener = (event: unknown) => void;
class MockWebSocket {
	static instances: MockWebSocket[] = [];
	readonly listeners = new Map<string, Set<Listener>>();
	readonly sent: Record<string, unknown>[] = [];
	readyState = 0;
	readonly options?: { headers?: Record<string, string> };
	constructor(
		readonly url: string,
		protocols?: string | string[] | { headers?: Record<string, string> },
	) {
		this.options =
			typeof protocols === "object" && protocols !== null && !Array.isArray(protocols) ? protocols : undefined;
		MockWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.emit("open", {});
		});
	}
	addEventListener(type: string, listener: Listener) {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, listener: Listener) {
		this.listeners.get(type)?.delete(listener);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
		const id = `resp_${this.sent.length}`;
		queueMicrotask(() => {
			this.message({ type: "response.created", response: { id } } as ResponseStreamEvent);
			this.message({
				type: "response.completed",
				response: {
					id,
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			} as ResponseStreamEvent);
		});
	}
	close() {
		this.readyState = 3;
	}
	protected message(event: ResponseStreamEvent) {
		this.emit("message", { data: JSON.stringify(event) });
	}
	protected emit(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}
const model: Model<"openai-responses"> = {
	id: "test",
	name: "test",
	api: "openai-responses",
	provider: "cpa",
	compat: { supportsWebSocket: true },
	baseUrl: "https://cpa.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
function output(): AssistantMessage {
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
async function request(input: Array<Record<string, unknown>>) {
	const result = output();
	let starts = 0;
	await processOpenAIResponsesWebSocket({
		url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
		headers: new Headers({ Authorization: "Bearer key" }),
		body: { model: model.id, stream: true, store: false, input: input as unknown as ResponseInput },
		output: result,
		stream: new AssistantMessageEventStream(),
		model,
		sessionId: "session",
		cached: true,
		onFirstEvent: () => {
			starts++;
		},
	});
	return { result, starts };
}
afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	MockWebSocket.instances = [];
	sdk.calls = 0;
	setOpenAIResponsesWebSocketConstructorForTesting(undefined);
});
describe("generic OpenAI Responses WebSocket transport", () => {
	it("resolves the standard responses WebSocket endpoint", () => {
		expect(resolveOpenAIResponsesWebSocketUrl("https://cpa.test/v1")).toBe("wss://cpa.test/v1/responses");
	});
	it("uses bearer auth, reuses a session socket, and appends only the input delta", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const firstInput = [{ role: "user", content: "one" }];
		expect((await request(firstInput)).starts).toBe(1);
		expect((await request([...firstInput, { role: "user", content: "two" }])).starts).toBe(1);
		expect(MockWebSocket.instances).toHaveLength(1);
		const socket = MockWebSocket.instances[0]!;
		expect(socket.options?.headers?.authorization).toBe("Bearer key");
		expect(socket.sent[0]).toMatchObject({ type: "response.create", input: firstInput });
		expect(socket.sent[1]).toMatchObject({
			type: "response.create",
			previous_response_id: "resp_1",
			input: [{ role: "user", content: "two" }],
		});
	});
	it("falls back to SSE only when the WebSocket fails before its first event", async () => {
		class FailingWebSocket extends MockWebSocket {
			override send() {
				queueMicrotask(() => this.emit("error", { message: "connect failed" }));
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(FailingWebSocket);
		const events = [];
		for await (const event of streamOpenAIResponses(model, { messages: [] }, { apiKey: "key", transport: "auto" }))
			events.push(event.type);
		expect(sdk.calls).toBe(1);
		expect(events).toEqual(["start", "done"]);
	});
	it("does not fall back or duplicate output after the first WebSocket event", async () => {
		class StartedThenFailingWebSocket extends MockWebSocket {
			override send() {
				queueMicrotask(() => {
					this.message({ type: "response.created", response: { id: "ws" } } as ResponseStreamEvent);
					this.emit("error", { message: "stream failed" });
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(StartedThenFailingWebSocket);
		const events = [];
		for await (const event of streamOpenAIResponses(model, { messages: [] }, { apiKey: "key", transport: "auto" }))
			events.push(event.type);
		expect(sdk.calls).toBe(0);
		expect(events).toEqual(["start", "error"]);
	});

	it("never opens a WebSocket when transport is sse", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		for await (const _event of streamOpenAIResponses(model, { messages: [] }, { apiKey: "key", transport: "sse" })) {
		}
		expect(MockWebSocket.instances).toHaveLength(0);
		expect(sdk.calls).toBe(1);
	});
	it("clears stale continuation before the next request", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		await request([{ role: "user", content: "one" }]);
		await request([{ role: "user", content: "unrelated" }]);
		await request([{ role: "user", content: "third" }]);
		const sent = MockWebSocket.instances[0]!.sent;
		expect(sent[1]).not.toHaveProperty("previous_response_id");
		expect(sent[2]).not.toHaveProperty("previous_response_id");
	});
	it("treats a failed completed response as a terminal WebSocket error", async () => {
		class FailedResponseWebSocket extends MockWebSocket {
			override send() {
				queueMicrotask(() => {
					this.message({ type: "response.created", response: { id: "failed" } } as ResponseStreamEvent);
					this.message({
						type: "response.completed",
						response: { id: "failed", status: "failed" },
					} as ResponseStreamEvent);
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(FailedResponseWebSocket);
		const events = [];
		for await (const event of streamOpenAIResponses(model, { messages: [] }, { apiKey: "key", transport: "auto" }))
			events.push(event.type);
		expect(sdk.calls).toBe(0);
		expect(events).toEqual(["start", "error"]);
	});
	it("reports the synthetic 101 WebSocket handshake response", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const onResponse = vi.fn();
		for await (const _event of streamOpenAIResponses(
			model,
			{ messages: [] },
			{ apiKey: "key", transport: "auto", onResponse },
		)) {
		}
		expect(onResponse).toHaveBeenCalledOnce();
		expect(onResponse).toHaveBeenCalledWith({ status: 101, headers: {} }, model);
	});
	it("keeps auto on SSE when authenticated WebSocket headers are unavailable", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(null);
		for await (const _event of streamOpenAIResponses(model, { messages: [] }, { apiKey: "key", transport: "auto" })) {
		}
		expect(MockWebSocket.instances).toHaveLength(0);
		expect(sdk.calls).toBe(1);
	});
	it("keeps auto on SSE when the model does not advertise WebSocket support", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const sseOnlyModel = { ...model, compat: { supportsWebSocket: false } };
		for await (const _event of streamOpenAIResponses(
			sseOnlyModel,
			{ messages: [] },
			{ apiKey: "key", transport: "auto" },
		)) {
		}
		expect(MockWebSocket.instances).toHaveLength(0);
		expect(sdk.calls).toBe(1);
	});

	it("mirrors SSE session-affinity headers when caching is enabled", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const wsModel = {
			...model,
			headers: { "x-model-header": "from-model" },
			compat: { supportsWebSocket: true, sendSessionIdHeader: true },
		};
		for await (const _event of streamOpenAIResponses(
			wsModel,
			{ messages: [] },
			{ apiKey: "key", transport: "websocket", sessionId: "sess-123", cacheRetention: "short" },
		)) {
		}
		expect(MockWebSocket.instances).toHaveLength(1);
		const headers = MockWebSocket.instances[0]!.options?.headers ?? {};
		expect(headers.authorization ?? headers.Authorization).toBe("Bearer key");
		expect(headers["x-model-header"] ?? headers["X-Model-Header"]).toBe("from-model");
		expect(headers.session_id ?? headers.Session_id).toBe("sess-123");
		expect(headers["x-client-request-id"] ?? headers["X-Client-Request-Id"]).toBe("sess-123");
	});

	it("omits session_id when sendSessionIdHeader is false but still sets x-client-request-id", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const wsModel = {
			...model,
			compat: { supportsWebSocket: true, sendSessionIdHeader: false },
		};
		for await (const _event of streamOpenAIResponses(
			wsModel,
			{ messages: [] },
			{ apiKey: "key", transport: "websocket", sessionId: "sess-456", cacheRetention: "short" },
		)) {
		}
		const headers = MockWebSocket.instances[0]!.options?.headers ?? {};
		expect(headers.session_id ?? headers.Session_id).toBeUndefined();
		expect(headers["x-client-request-id"] ?? headers["X-Client-Request-Id"]).toBe("sess-456");
	});

	it("does not set session-affinity headers when cache retention is none", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		for await (const _event of streamOpenAIResponses(
			model,
			{ messages: [] },
			{ apiKey: "key", transport: "websocket", sessionId: "sess-none", cacheRetention: "none" },
		)) {
		}
		const headers = MockWebSocket.instances[0]!.options?.headers ?? {};
		expect(headers.session_id ?? headers.Session_id).toBeUndefined();
		expect(headers["x-client-request-id"] ?? headers["X-Client-Request-Id"]).toBeUndefined();
		expect(headers.authorization ?? headers.Authorization).toBe("Bearer key");
	});

	it("lets explicit user headers override session-affinity defaults like SSE createClient", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const wsModel = {
			...model,
			headers: { "x-model-header": "from-model" },
			compat: { supportsWebSocket: true, sendSessionIdHeader: true },
		};
		for await (const _event of streamOpenAIResponses(
			wsModel,
			{ messages: [] },
			{
				apiKey: "key",
				transport: "websocket",
				sessionId: "sess-default",
				cacheRetention: "short",
				headers: {
					session_id: "user-session",
					"x-client-request-id": "user-request",
					"x-model-header": "from-user",
				},
			},
		)) {
		}
		const headers = MockWebSocket.instances[0]!.options?.headers ?? {};
		expect(headers.session_id ?? headers.Session_id).toBe("user-session");
		expect(headers["x-client-request-id"] ?? headers["X-Client-Request-Id"]).toBe("user-request");
		expect(headers["x-model-header"] ?? headers["X-Model-Header"]).toBe("from-user");
		expect(headers.authorization ?? headers.Authorization).toBe("Bearer key");
	});
	it("preserves an upstream error event when the socket closes afterwards", async () => {
		class ErrorThenCloseWebSocket extends MockWebSocket {
			override send() {
				queueMicrotask(() => {
					this.message({
						type: "error",
						message: "context_too_large",
						code: "context_too_large",
					} as unknown as ResponseStreamEvent);
					this.emit("close", { code: 1011, reason: "proxy close" });
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(ErrorThenCloseWebSocket);
		await expect(request([])).rejects.toThrow("context_too_large");
	});

	it("reports typed bare closes with the server close code and reason", async () => {
		class BareCloseWebSocket extends MockWebSocket {
			override send() {
				queueMicrotask(() => this.emit("close", { code: 1011, reason: "upstream rejected" }));
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(BareCloseWebSocket);
		try {
			await request([]);
			throw new Error("expected close");
		} catch (error) {
			expect(error).toMatchObject({ name: "WebSocketTransportError" });
			expect(String(error)).toContain("1011 upstream rejected");
		}
	});
});
