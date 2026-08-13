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
	setOpenAIResponsesWebSocketConstructorLoaderForTesting,
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

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// This manual socket controls the connect race entirely through the public constructor seam.
class ManualSocket {
	static instances: ManualSocket[] = [];
	static pendingOpens: Array<() => void> = [];
	readonly listeners = new Map<string, Set<Listener>>();
	readonly sent: Record<string, unknown>[] = [];
	readyState = 0;
	closed = false;
	closeReason: string | undefined;
	constructor(
		readonly url: string,
		readonly options?: string | string[] | { headers?: Record<string, string> },
	) {
		ManualSocket.instances.push(this);
		ManualSocket.pendingOpens.push(() => {
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
	}
	close(_code?: number, reason?: string) {
		this.readyState = 3;
		this.closed = true;
		this.closeReason = reason;
	}
	emit(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
	message(event: ResponseStreamEvent) {
		this.emit("message", { data: JSON.stringify(event) });
	}
}

async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function complete(socket: ManualSocket, id: string) {
	socket.message({ type: "response.created", response: { id } } as ResponseStreamEvent);
	socket.message({
		type: "response.completed",
		response: {
			id,
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
		},
	} as ResponseStreamEvent);
}

function concurrentRequest(headers: Headers, content: string, onOpen?: () => void | Promise<void>) {
	return processOpenAIResponsesWebSocket({
		url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
		headers,
		body: { model: model.id, stream: true, store: false, input: [{ role: "user", content }] as ResponseInput },
		output: output(),
		stream: new AssistantMessageEventStream(),
		model,
		sessionId: "concurrency",
		cached: true,
		onFirstEvent: () => {},
		onOpen,
	});
}

afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	MockWebSocket.instances = [];
	ManualSocket.instances = [];
	ManualSocket.pendingOpens = [];
	vi.useRealTimers();
	sdk.calls = 0;
	setOpenAIResponsesWebSocketConstructorForTesting(undefined);
	setOpenAIResponsesWebSocketConstructorLoaderForTesting(undefined);
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
	it.each([
		["authorization", "Bearer old", "Bearer new"],
		["url", "https://cpa.test/v1/responses", "https://other.test/v1/responses"],
	])("does not reuse a session when %s changes", async (_kind, first, second) => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const input = [{ role: "user", content: "first" }];
		const headers = new Headers({ Authorization: "Bearer key" });
		await processOpenAIResponsesWebSocket({
			url: _kind === "url" ? String(first) : resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
			headers: _kind === "authorization" ? new Headers({ Authorization: String(first) }) : headers,
			body: { model: model.id, stream: true, store: false, input: input as unknown as ResponseInput },
			output: output(),
			stream: new AssistantMessageEventStream(),
			model,
			sessionId: "mismatch",
			cached: true,
			onFirstEvent: () => {},
		});
		await processOpenAIResponsesWebSocket({
			url: _kind === "url" ? String(second) : resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
			headers: _kind === "authorization" ? new Headers({ Authorization: String(second) }) : headers,
			body: {
				model: model.id,
				stream: true,
				store: false,
				input: [{ role: "user", content: "second" }] as unknown as ResponseInput,
			},
			output: output(),
			stream: new AssistantMessageEventStream(),
			model,
			sessionId: "mismatch",
			cached: true,
			onFirstEvent: () => {},
		});
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(MockWebSocket.instances[0]!.sent).toHaveLength(1);
		expect(MockWebSocket.instances[0]!.sent[0]).not.toMatchObject({ input: [{ role: "user", content: "second" }] });
	});
	it("reuses exact identity when only header name casing differs", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const make = (headers: Headers, body: unknown) =>
			processOpenAIResponsesWebSocket({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers,
				body: { model: model.id, stream: true, store: false, input: body as ResponseInput },
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				sessionId: "case",
				cached: true,
				onFirstEvent: () => {},
			});
		await make(new Headers({ Authorization: "Bearer key", "X-Test-Header": "same" }), [
			{ role: "user", content: "one" },
		]);
		await make(new Headers({ authorization: "Bearer key", "x-test-header": "same" }), [
			{ role: "user", content: "two" },
		]);
		expect(MockWebSocket.instances).toHaveLength(1);
	});

	it.each([false, true, "leftover"] as const)(
		"generation safety keeps the newer cached socket (%s)",
		async (settle) => {
			setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
			await request([{ role: "user", content: "old" }]);
			const old = MockWebSocket.instances[0]!;
			await processOpenAIResponsesWebSocket({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers: new Headers({ Authorization: "Bearer new" }),
				body: {
					model: model.id,
					stream: true,
					store: false,
					input: [{ role: "user", content: "new" }] as unknown as ResponseInput,
				},
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				sessionId: "session",
				cached: true,
				onFirstEvent: () => {},
			});
			if (settle === "leftover") old.readyState = 1;
			await processOpenAIResponsesWebSocket({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers: new Headers({ Authorization: "Bearer new" }),
				body: {
					model: model.id,
					stream: true,
					store: false,
					input: [{ role: "user", content: "third" }] as unknown as ResponseInput,
				},
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				sessionId: "session",
				cached: true,
				onFirstEvent: () => {},
			});
			expect(MockWebSocket.instances).toHaveLength(2);
			expect(MockWebSocket.instances[1]!.sent.at(-1)).toMatchObject({ input: [{ role: "user", content: "third" }] });
		},
	);
	it("rejects a pre-aborted exact-identity acquire without disturbing a warm owner", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		await request([{ role: "user", content: "owner" }]);
		const owner = MockWebSocket.instances[0]!;
		const controller = new AbortController();
		controller.abort();
		await expect(
			processOpenAIResponsesWebSocket({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers: new Headers({ Authorization: "Bearer key" }),
				body: { model: model.id, stream: true, input: [] as unknown as ResponseInput },
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				sessionId: "session",
				cached: true,
				signal: controller.signal,
				onFirstEvent: () => {},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(owner.readyState).toBe(1);
		expect(owner.sent).toHaveLength(1);
		await request([{ role: "user", content: "still owner" }]);
		expect(MockWebSocket.instances).toHaveLength(1);
	});

	it("rejects a pre-aborted acquire before cache reuse or identity replacement", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		await request([{ role: "user", content: "owner" }]);
		const owner = MockWebSocket.instances[0]!;
		const controller = new AbortController();
		controller.abort();
		await expect(
			processOpenAIResponsesWebSocket({
				url: "wss://different.test/v1/responses",
				headers: new Headers({ Authorization: "Bearer different" }),
				body: { model: model.id, stream: true, input: [] as unknown as ResponseInput },
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				sessionId: "session",
				cached: true,
				signal: controller.signal,
				onFirstEvent: () => {},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(owner.readyState).toBe(1);
		expect(owner.sent).toHaveLength(1);
		await request([{ role: "user", content: "still owner" }]);
		expect(MockWebSocket.instances).toHaveLength(1);
	});
	it("aborts while the constructor loader is pending without constructing or falling back", async () => {
		const controller = new AbortController();
		const loader = deferred<typeof MockWebSocket>();
		setOpenAIResponsesWebSocketConstructorLoaderForTesting(() => loader.promise as never);
		const pending = processOpenAIResponsesWebSocket({
			url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
			headers: new Headers(),
			body: { model: model.id, stream: true, input: [] as unknown as ResponseInput },
			output: output(),
			stream: new AssistantMessageEventStream(),
			model,
			cached: false,
			signal: controller.signal,
			onFirstEvent: () => {},
		});
		controller.abort();
		loader.resolve(MockWebSocket);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(MockWebSocket.instances).toHaveLength(0);
		expect(sdk.calls).toBe(0);
	});

	it("aborts a pending socket open and clears its session claim", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const controller = new AbortController();
		const pending = processOpenAIResponsesWebSocket({
			url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
			headers: new Headers({ Authorization: "Bearer connect-abort" }),
			body: { model: model.id, stream: true, store: false, input: [] as unknown as ResponseInput },
			output: output(),
			stream: new AssistantMessageEventStream(),
			model,
			sessionId: "connect-abort",
			cached: true,
			signal: controller.signal,
			onFirstEvent: () => {},
		});
		await flush();
		expect(ManualSocket.instances).toHaveLength(1);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(ManualSocket.instances[0]!.closed).toBe(true);
		expect(ManualSocket.instances[0]!.sent).toHaveLength(0);
		const next = processOpenAIResponsesWebSocket({
			url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
			headers: new Headers({ Authorization: "Bearer connect-abort" }),
			body: { model: model.id, stream: true, store: false, input: [] as unknown as ResponseInput },
			output: output(),
			stream: new AssistantMessageEventStream(),
			model,
			sessionId: "connect-abort",
			cached: true,
			onFirstEvent: () => {},
		});
		await flush();
		expect(ManualSocket.instances).toHaveLength(2);
		ManualSocket.pendingOpens[1]!();
		await flush();
		complete(ManualSocket.instances[1]!, "next");
		await next;
		expect(ManualSocket.instances[1]!.closed).toBe(false);
	});

	it("invalidates a pending claim during all-session cleanup", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const pending = concurrentRequest(new Headers({ Authorization: "Bearer pending" }), "pending");
		await flush();
		expect(ManualSocket.instances).toHaveLength(1);
		closeOpenAIResponsesWebSocketSessions();
		ManualSocket.pendingOpens[0]!();
		await flush();
		complete(ManualSocket.instances[0]!, "ephemeral");
		await pending;
		expect(ManualSocket.instances[0]!.closed).toBe(true);
		const next = concurrentRequest(new Headers({ Authorization: "Bearer pending" }), "next");
		await flush();
		expect(ManualSocket.instances).toHaveLength(2);
		ManualSocket.pendingOpens[1]!();
		await flush();
		complete(ManualSocket.instances[1]!, "next");
		await next;
	});

	it("does not send when onOpen aborts before collection", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(MockWebSocket);
		const controller = new AbortController();
		await expect(
			processOpenAIResponsesWebSocket({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers: new Headers(),
				body: { model: model.id, stream: true, input: [] as unknown as ResponseInput },
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				cached: false,
				signal: controller.signal,
				onFirstEvent: () => {},
				onOpen: () => controller.abort(),
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(MockWebSocket.instances[0]?.sent).toHaveLength(0);
	});
	it("closes without sending when construction aborts before listener registration", async () => {
		const controller = new AbortController();
		class ConstructorAbortSocket extends MockWebSocket {
			closed = false;
			override close() {
				this.closed = true;
				super.close();
			}
			constructor(url: string, protocols?: string | string[] | { headers?: Record<string, string> }) {
				super(url, protocols);
				controller.abort();
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(ConstructorAbortSocket);
		await expect(
			processOpenAIResponsesWebSocket({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers: new Headers(),
				body: { model: model.id, stream: true, input: [] as unknown as ResponseInput },
				output: output(),
				stream: new AssistantMessageEventStream(),
				model,
				cached: false,
				signal: controller.signal,
				onFirstEvent: () => {},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect((MockWebSocket.instances[0] as ConstructorAbortSocket | undefined)?.closed).toBe(true);
		expect(MockWebSocket.instances[0]?.sent).toHaveLength(0);
	});

	it.each([
		["same", new Headers({ Authorization: "Bearer same" }), new Headers({ Authorization: "Bearer same" })],
		["changed", new Headers({ Authorization: "Bearer A" }), new Headers({ Authorization: "Bearer B" })],
	] as const)("keeps the forward-open newest %s claim and reuses it", async (_kind, headersA, headersB) => {
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const older = concurrentRequest(headersA, "A");
		const newer = concurrentRequest(headersB, "B");
		await flush();
		expect(ManualSocket.instances).toHaveLength(2);
		ManualSocket.pendingOpens[0]!();
		await flush();
		ManualSocket.pendingOpens[1]!();
		await flush();
		complete(ManualSocket.instances[1]!, "new");
		complete(ManualSocket.instances[0]!, "old");
		await Promise.all([older, newer]);
		const [stale, winner] = ManualSocket.instances;
		expect(stale!.closed).toBe(true);
		expect(winner!.closed).toBe(false);
		const third = concurrentRequest(headersB, "C");
		await flush();
		complete(winner!, "third");
		await third;
		expect(ManualSocket.instances).toHaveLength(2);
		expect(winner!.closed).toBe(false);
	});

	it("keeps the reverse-open same-identity winner and reuses it", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const headers = new Headers({ Authorization: "Bearer same" });
		const gateA = deferred();
		const gateB = deferred();
		const older = concurrentRequest(headers, "A", () => gateA.promise);
		const newer = concurrentRequest(headers, "B", () => gateB.promise);
		await flush();
		expect(ManualSocket.instances).toHaveLength(2);
		ManualSocket.pendingOpens[1]!();
		await flush();
		ManualSocket.pendingOpens[0]!();
		await flush();
		gateB.resolve();
		await flush();
		complete(ManualSocket.instances[1]!, "new");
		await newer;
		gateA.resolve();
		await flush();
		complete(ManualSocket.instances[0]!, "old");
		await older;
		const [stale, winner] = ManualSocket.instances;
		expect(stale!.closed).toBe(true);
		expect(winner!.closed).toBe(false);
		const third = concurrentRequest(headers, "C");
		await flush();
		complete(winner!, "third");
		await third;
		expect(ManualSocket.instances).toHaveLength(2);
		expect(winner!.closed).toBe(false);
	});

	it("keeps the reverse-open changed-identity winner and reuses it", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const gateA = deferred();
		const gateB = deferred();
		const older = concurrentRequest(new Headers({ Authorization: "Bearer A" }), "A", () => gateA.promise);
		const newer = concurrentRequest(new Headers({ Authorization: "Bearer B" }), "B", () => gateB.promise);
		await flush();
		expect(ManualSocket.instances).toHaveLength(2);
		ManualSocket.pendingOpens[1]!();
		await flush();
		ManualSocket.pendingOpens[0]!();
		await flush();
		gateB.resolve();
		await flush();
		complete(ManualSocket.instances[1]!, "new");
		await newer;
		gateA.resolve();
		await flush();
		complete(ManualSocket.instances[0]!, "old");
		await older;
		const [stale, winner] = ManualSocket.instances;
		expect(stale!.closed).toBe(true);
		expect(winner!.closed).toBe(false);
		const third = concurrentRequest(new Headers({ Authorization: "Bearer B" }), "C");
		await flush();
		complete(winner!, "third");
		await third;
		expect(ManualSocket.instances).toHaveLength(2);
		expect(winner!.closed).toBe(false);
	});

	it.each([false, true])("preserves a new busy-owner replacement when old releases %s", async (oldSucceeds) => {
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const gateOld = deferred();
		const oldRequest = concurrentRequest(new Headers({ Authorization: "Bearer A" }), "old", () => gateOld.promise);
		await flush();
		expect(ManualSocket.instances).toHaveLength(1);
		ManualSocket.pendingOpens[0]!();
		await flush();
		const newRequest = concurrentRequest(new Headers({ Authorization: "Bearer B" }), "new");
		await flush();
		expect(ManualSocket.instances[0]!.closed).toBe(true);
		expect(ManualSocket.instances).toHaveLength(2);
		ManualSocket.pendingOpens[1]!();
		await flush();
		complete(ManualSocket.instances[1]!, "new");
		await newRequest;
		gateOld.resolve();
		await flush();
		if (oldSucceeds) complete(ManualSocket.instances[0]!, "old");
		else ManualSocket.instances[0]!.emit("error", { message: "old failed" });
		if (oldSucceeds) await oldRequest;
		else await expect(oldRequest).rejects.toThrow("old failed");
		const [, winner] = ManualSocket.instances;
		expect(winner!.closed).toBe(false);
		const third = concurrentRequest(new Headers({ Authorization: "Bearer B" }), "third");
		await flush();
		complete(winner!, "third");
		await third;
		expect(ManualSocket.instances).toHaveLength(2);
		expect(winner!.closed).toBe(false);
	});

	it("ignores a cleared stale idle timer after identity replacement", async () => {
		vi.useFakeTimers();
		setOpenAIResponsesWebSocketConstructorForTesting(ManualSocket as never);
		const timerSpy = vi.spyOn(globalThis, "setTimeout");
		const oldRequest = concurrentRequest(new Headers({ Authorization: "Bearer A" }), "old");
		await flush();
		ManualSocket.pendingOpens[0]!();
		await flush();
		complete(ManualSocket.instances[0]!, "old");
		await oldRequest;
		const staleTimer = timerSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined;
		expect(staleTimer).toBeTypeOf("function");
		const newRequest = concurrentRequest(new Headers({ Authorization: "Bearer B" }), "new");
		await flush();
		ManualSocket.pendingOpens[1]!();
		await flush();
		complete(ManualSocket.instances[1]!, "new");
		await newRequest;
		staleTimer!();
		const [, winner] = ManualSocket.instances;
		expect(winner!.closed).toBe(false);
		const third = concurrentRequest(new Headers({ Authorization: "Bearer B" }), "third");
		await flush();
		complete(winner!, "third");
		await third;
		expect(ManualSocket.instances).toHaveLength(2);
		expect(winner!.closed).toBe(false);
		timerSpy.mockRestore();
	});
});
