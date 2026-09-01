import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compactOpenAIResponsesV2,
	getResponsesRemoteCompactionV2FallbackReason,
} from "../src/providers/openai-responses-remote-compaction-v2.js";
import {
	closeOpenAIResponsesWebSocketSessions,
	setOpenAIResponsesWebSocketConstructorForTesting,
} from "../src/providers/openai-responses-websocket.js";
import type { Model } from "../src/types.js";

const model: Model<"openai-responses"> = {
	id: "sol",
	name: "Sol",
	api: "openai-responses",
	provider: "cpa-r",
	baseUrl: "http://provider.test/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 350000,
	reasoning: false,
	maxTokens: 16000,
	compat: { supportsResponsesRemoteCompactionV2: true },
};

class V2MockWebSocket {
	static instances: V2MockWebSocket[] = [];
	readonly listeners = new Map<string, Set<(event: unknown) => void>>();
	readonly sent: Record<string, unknown>[] = [];
	readyState = 0;
	readonly options: { headers?: Record<string, string> };
	constructor(
		readonly url: string,
		protocols?: { headers?: Record<string, string> },
	) {
		this.options = protocols ?? {};
		V2MockWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.emit("open", {});
		});
	}
	addEventListener(type: string, listener: (event: unknown) => void) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: (event: unknown) => void) {
		this.listeners.get(type)?.delete(listener);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
		const id = `v2_${this.sent.length}`;
		queueMicrotask(() => {
			this.emit("message", { data: JSON.stringify({ type: "response.output_item.done", item: checkpoint }) });
			this.emit("message", {
				data: JSON.stringify({ type: "response.completed", response: { id, status: "completed" } }),
			});
		});
	}
	close() {
		this.readyState = 3;
	}
	emit(type: string, event: unknown) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

const checkpoint = { type: "compaction", id: "cmp", encrypted_content: "cipher", future: { kept: true } };
afterEach(() => {
	closeOpenAIResponsesWebSocketSessions();
	setOpenAIResponsesWebSocketConstructorForTesting(undefined);
	V2MockWebSocket.instances = [];
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
function stream(items: unknown[]) {
	return items
		.map((item) => `event: ${(item as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(item)}\n\n`)
		.join("");
}

const DEADLINE = Symbol("deadline");
/** Bounded settlement probe: a lifecycle defect must fail as "never settled", never as a hung test. */
function deadline(ms: number): Promise<typeof DEADLINE> {
	return new Promise((resolve) => setTimeout(() => resolve(DEADLINE), ms));
}
async function flushMicrotasks() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
/** A context whose last exchange is a tool call answered by its tool result. */
function postToolContext() {
	return {
		systemPrompt: "system",
		messages: [
			{ role: "user" as const, content: "old", timestamp: 1 },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "assistant-text" },
					{ type: "toolCall" as const, id: "call_1|fc_1", name: "probe", arguments: { value: 1 } },
				],
				api: "openai-responses" as const,
				provider: "cpa-r",
				model: "sol",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: 2,
			},
			{
				role: "toolResult" as const,
				toolCallId: "call_1|fc_1",
				toolName: "probe",
				content: [{ type: "text" as const, text: "tool-output" }],
				isError: false,
				timestamp: 3,
			},
		],
	};
}
describe("Codex Remote Compaction V2", () => {
	it("uses streaming /responses with the trigger and preserves opaque fields", async () => {
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			expect(url).toBe("http://provider.test/v1/responses");
			const headers = new Headers(init?.headers);
			expect(headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
			const body = JSON.parse(String(init?.body));
			expect(body.stream).toBe(true);
			expect(body.store).toBe(false);
			expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
			expect(body.tools).toBeUndefined();
			return new Response(
				stream([
					{ type: "response.output_item.done", item: checkpoint },
					{ type: "response.completed", response: { status: "completed" } },
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const result = await compactOpenAIResponsesV2(
			model,
			{
				systemPrompt: "system",
				messages: [
					{ role: "user", content: "old", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "assistant-text" },
							{ type: "toolCall", id: "call_1|fc_1", name: "probe", arguments: { value: 1 } },
						],
						api: "openai-responses",
						provider: "cpa-r",
						model: "sol",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "call_1|fc_1",
						toolName: "probe",
						content: [{ type: "text", text: "tool-output" }],
						isError: false,
						timestamp: 3,
					},
					{
						role: "openaiResponsesCompaction",
						version: 1,
						provider: "cpa-r",
						api: "openai-responses",
						model: "sol",
						items: [{ type: "compaction", encrypted_content: "previous-cipher" }],
						timestamp: 4,
					},
				],
			},
			{ apiKey: "key", transport: "sse" },
		);
		expect(result.items).toEqual([checkpoint]);
		expect(JSON.stringify(result.input)).toContain("assistant-text");
		expect(JSON.stringify(result.input)).toContain("tool-output");
		expect(JSON.stringify(result.input)).toContain("previous-cipher");
		expect(fetch.mock.calls[0]![0]).not.toContain("/compact");
	});
	it.each([
		[[], "zero"],
		[[checkpoint, checkpoint], "two"],
		[[{ ...checkpoint, encrypted_content: "" }], "empty"],
	])("fails closed with %s checkpoints", async (items) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						stream([
							...items.map((item) => ({ type: "response.output_item.done", item })),
							{ type: "response.completed", response: { status: "completed" } },
						]),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);
		await expect(
			compactOpenAIResponsesV2(model, { messages: [] }, { apiKey: "key", transport: "sse" }),
		).rejects.toThrow();
	});
	it("fails closed when the stream ends before response.completed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(stream([{ type: "response.output_item.done", item: checkpoint }]), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			),
		);
		await expect(
			compactOpenAIResponsesV2(model, { messages: [] }, { apiKey: "key", transport: "sse" }),
		).rejects.toThrow("before response.completed");
	});
	it("fails closed when response.completed is not completed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						stream([
							{ type: "response.output_item.done", item: checkpoint },
							{
								type: "response.completed",
								response: { status: "failed", error: { message: "terminal failure", code: "failed" } },
							},
						]),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);
		await expect(
			compactOpenAIResponsesV2(model, { messages: [] }, { apiKey: "key", transport: "sse" }),
		).rejects.toThrow("terminal failure");
	});
	it("uses authenticated persistent WebSocket requests without continuation state", async () => {
		setOpenAIResponsesWebSocketConstructorForTesting(V2MockWebSocket as never);
		const wsModel = {
			...model,
			headers: { "X-Codex-Beta-Features": "model_feature", Authorization: "model-auth" },
			compat: { supportsResponsesRemoteCompactionV2: true, supportsWebSocket: true, sendSessionIdHeader: false },
		};
		const context = { messages: [{ role: "user" as const, content: "old", timestamp: 1 }] };
		await compactOpenAIResponsesV2(wsModel, context, {
			apiKey: "key",
			sessionId: "sess",
			transport: "websocket",
			headers: {
				"x-codex-beta-features": "caller_feature",
				session_id: "caller-session",
				"x-client-request-id": "caller-request",
			},
		});
		await compactOpenAIResponsesV2(wsModel, context, {
			apiKey: "key",
			sessionId: "sess",
			transport: "websocket",
			headers: {
				"x-codex-beta-features": "caller_feature",
				session_id: "caller-session",
				"x-client-request-id": "caller-request",
			},
		});
		expect(V2MockWebSocket.instances).toHaveLength(1);
		const socket = V2MockWebSocket.instances[0]!;
		expect(socket.options.headers?.authorization).toBe("Bearer key");
		expect(socket.options.headers?.session_id).toBe("caller-session");
		expect(socket.options.headers?.["x-client-request-id"]).toBe("caller-request");
		expect(socket.options.headers?.["x-codex-beta-features"]).toEqual(expect.stringContaining("model_feature"));
		expect(socket.options.headers?.["x-codex-beta-features"]).toEqual(expect.stringContaining("caller_feature"));
		expect(socket.sent).toHaveLength(2);
		for (const request of socket.sent) {
			expect(request).toMatchObject({ type: "response.create" });
			expect(request.previous_response_id).toBeUndefined();
			expect((request.input as unknown[]).at(-1)).toEqual({ type: "compaction_trigger" });
		}
		expect(socket.readyState).toBe(1);
		const noCallerModel = { ...wsModel, compat: { ...wsModel.compat, sendSessionIdHeader: false } };
		await compactOpenAIResponsesV2(noCallerModel, context, {
			apiKey: "key",
			sessionId: "sess-2",
			transport: "websocket",
		});
		const noCallerSocket = V2MockWebSocket.instances[1]!;
		expect(noCallerSocket.options.headers?.session_id).toBeUndefined();
		expect(noCallerSocket.options.headers?.["x-client-request-id"]).toBe("sess-2");
	});
	it.each(["error", "close"])(
		"falls back exactly once when WebSocket emits %s before its first event",
		async (kind) => {
			class BeforeEventFailure extends V2MockWebSocket {
				override send() {
					queueMicrotask(() => this.emit(kind, { message: "socket failed", code: 1011 }));
				}
			}
			setOpenAIResponsesWebSocketConstructorForTesting(BeforeEventFailure as never);
			const fetch = vi.fn(
				async () =>
					new Response(
						stream([
							{ type: "response.output_item.done", item: checkpoint },
							{ type: "response.completed", response: { status: "completed" } },
						]),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			);
			vi.stubGlobal("fetch", fetch);
			await compactOpenAIResponsesV2(
				model,
				{ messages: [], systemPrompt: "" },
				{ apiKey: "key", transport: "websocket" },
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["error", "response.failed"])("throws after first WebSocket event without SSE (%s)", async (kind) => {
		class AfterEventFailure extends V2MockWebSocket {
			override send() {
				queueMicrotask(() => {
					this.emit("message", {
						data: JSON.stringify({ type: "response.created", response: { id: "started" } }),
					});
					this.emit("message", {
						data: JSON.stringify(
							kind === "error"
								? { type: "error", message: "failed" }
								: { type: "response.failed", response: { status: "failed", error: { message: "failed" } } },
						),
					});
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(AfterEventFailure as never);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			compactOpenAIResponsesV2(model, { messages: [], systemPrompt: "" }, { apiKey: "key", transport: "websocket" }),
		).rejects.toThrow("failed");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("canonicalizes WebSocket aborts and never falls back to SSE", async () => {
		class AbortWebSocket extends V2MockWebSocket {
			override send() {}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(AbortWebSocket as never);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();
		const promise = compactOpenAIResponsesV2(
			model,
			{ messages: [] },
			{ apiKey: "key", sessionId: "abort", transport: "websocket", signal: controller.signal },
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).not.toHaveBeenCalled();
		expect(V2MockWebSocket.instances[0]?.readyState).toBe(3);
	});
	it("aborts after a valid terminal checkpoint before accepting the result", async () => {
		const controller = new AbortController();
		class PostSuccessAbortSocket extends V2MockWebSocket {
			override send(data: string) {
				this.sent.push(JSON.parse(data));
				queueMicrotask(() => {
					this.emit("message", { data: JSON.stringify({ type: "response.output_item.done", item: checkpoint }) });
					this.emit("message", {
						data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
					});
					queueMicrotask(() => controller.abort());
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(PostSuccessAbortSocket as never);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			compactOpenAIResponsesV2(
				model,
				{ messages: [] },
				{
					apiKey: "key",
					transport: "websocket",
					signal: controller.signal,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("aborts a stalled post-tool response and releases its session socket", async () => {
		// The provider answers the tool round-trip and then stalls: no response.completed,
		// no response.failed, and no EOF. Only session disposal can settle this collector.
		class StalledPostToolSocket extends V2MockWebSocket {
			override send(data: string) {
				this.sent.push(JSON.parse(data));
				queueMicrotask(() => {
					this.emit("message", {
						data: JSON.stringify({ type: "response.created", response: { id: "stalled" } }),
					});
					this.emit("message", {
						data: JSON.stringify({
							type: "response.output_item.done",
							item: {
								type: "function_call",
								id: "fc_1",
								call_id: "call_1|fc_1",
								name: "probe",
								arguments: "{}",
							},
						}),
					});
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(StalledPostToolSocket as never);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();
		const promise = compactOpenAIResponsesV2(model, postToolContext(), {
			apiKey: "key",
			sessionId: "stalled-post-tool",
			transport: "websocket",
			signal: controller.signal,
		});
		const settled = promise.then(
			() => "resolved" as const,
			(error: unknown) => error,
		);
		await flushMicrotasks();
		const socket = V2MockWebSocket.instances[0]!;
		expect(socket.sent).toHaveLength(1);
		expect(JSON.stringify(socket.sent[0]!.input)).toContain("tool-output");
		expect((socket.sent[0]!.input as unknown[]).at(-1)).toEqual({ type: "compaction_trigger" });
		expect(socket.readyState).toBe(1);

		// Dispose the exact owning session while the stalled response is still in flight.
		closeOpenAIResponsesWebSocketSessions("stalled-post-tool");

		const outcome = await Promise.race([settled, deadline(500)]);
		expect(outcome, "the disposed session's compaction collector never settled").not.toBe(DEADLINE);
		expect(outcome).toMatchObject({ name: "AbortError" });
		// The abort reached the collector through session ownership, not the caller's signal.
		expect(controller.signal.aborted).toBe(false);
		// No SSE/provider replay after the tool event.
		expect(fetch).not.toHaveBeenCalled();
		expect(socket.readyState).toBe(3);

		// The claim, cache entry, and socket were released: the next compaction builds a fresh socket.
		setOpenAIResponsesWebSocketConstructorForTesting(V2MockWebSocket as never);
		await expect(
			compactOpenAIResponsesV2(
				model,
				{ messages: [] },
				{
					apiKey: "key",
					sessionId: "stalled-post-tool",
					transport: "websocket",
				},
			),
		).resolves.toMatchObject({ items: [checkpoint] });
		expect(V2MockWebSocket.instances).toHaveLength(2);
		expect(V2MockWebSocket.instances[1]).not.toBe(socket);
	});

	it("distinguishes a provider EOF after a tool event from session disposal", async () => {
		class EofAfterToolSocket extends V2MockWebSocket {
			override send(data: string) {
				this.sent.push(JSON.parse(data));
				queueMicrotask(() => {
					this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "eof" } }) });
					this.emit("message", {
						data: JSON.stringify({
							type: "response.output_item.done",
							item: {
								type: "function_call",
								id: "fc_1",
								call_id: "call_1|fc_1",
								name: "probe",
								arguments: "{}",
							},
						}),
					});
					this.emit("close", { code: 1006, reason: "upstream vanished" });
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(EofAfterToolSocket as never);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const outcome = await Promise.race([
			compactOpenAIResponsesV2(model, postToolContext(), {
				apiKey: "key",
				sessionId: "eof-post-tool",
				transport: "websocket",
			}).then(
				() => "resolved" as const,
				(error: unknown) => error,
			),
			deadline(500),
		]);
		expect(outcome, "the provider EOF never settled the collector").not.toBe(DEADLINE);
		// Provider EOF stays a transport failure; it is never canonicalized as a session abort.
		expect(outcome).toMatchObject({ name: "WebSocketTransportError" });
		expect(fetch).not.toHaveBeenCalled();
		expect(V2MockWebSocket.instances[0]!.readyState).toBe(3);
	});

	it("rejects an SSE result when abort follows terminal stream completion", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(streamController) {
					streamController.enqueue(
						encoder.encode(
							stream([
								{ type: "response.output_item.done", item: checkpoint },
								{ type: "response.completed", response: { status: "completed" } },
							]),
						),
					);
					streamController.close();
					queueMicrotask(() => controller.abort());
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		vi.stubGlobal("fetch", fetch);
		await expect(
			compactOpenAIResponsesV2(
				model,
				{ messages: [] },
				{
					apiKey: "key",
					transport: "sse",
					signal: controller.signal,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("only classifies concrete unsupported errors for fallback", () => {
		expect(getResponsesRemoteCompactionV2FallbackReason({ status: 404 })).toContain("404");
		expect(
			getResponsesRemoteCompactionV2FallbackReason({ status: 503, message: "auth_unavailable" }),
		).toBeUndefined();
		expect(getResponsesRemoteCompactionV2FallbackReason(new Error("missing completed"))).toBeUndefined();
	});
	it.each([
		["headers", { session_id: "one" }, { session_id: "two" }],
		["apiKey", "old", "new"],
		["baseUrl", "http://provider.test/v1", "http://other.test/v1"],
	])("does not reuse V2 sockets when %s changes", async (_kind, first, second) => {
		setOpenAIResponsesWebSocketConstructorForTesting(V2MockWebSocket as never);
		const opts = (value: unknown) => ({
			apiKey: _kind === "apiKey" ? String(value) : "key",
			sessionId: "sess",
			transport: "websocket" as const,
			headers: _kind === "headers" ? (value as Record<string, string>) : undefined,
		});
		const firstModel =
			_kind === "baseUrl"
				? { ...model, baseUrl: String(first), compat: { ...model.compat, supportsWebSocket: true } }
				: { ...model, compat: { ...model.compat, supportsWebSocket: true } };
		const secondModel =
			_kind === "baseUrl"
				? { ...model, baseUrl: String(second), compat: { ...model.compat, supportsWebSocket: true } }
				: firstModel;
		await compactOpenAIResponsesV2(firstModel, { messages: [] }, opts(first));
		await compactOpenAIResponsesV2(secondModel, { messages: [] }, opts(second));
		expect(V2MockWebSocket.instances).toHaveLength(2);
		expect(V2MockWebSocket.instances[0]!.sent).toHaveLength(1);
	});
	it("accepts synchronous WebSocket send completion", async () => {
		class SyncSocket extends V2MockWebSocket {
			override send(data: string) {
				this.sent.push(JSON.parse(data));
				this.emit("message", { data: JSON.stringify({ type: "response.output_item.done", item: checkpoint }) });
				this.emit("message", {
					data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
				});
			}
		}
		setOpenAIResponsesWebSocketConstructorForTesting(SyncSocket as never);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			compactOpenAIResponsesV2(model, { messages: [] }, { apiKey: "key", transport: "websocket" }),
		).resolves.toMatchObject({ items: [checkpoint] });
		expect(fetch).not.toHaveBeenCalled();
	});
	it("classifies non-auth gateway failures for fallback", () => {
		expect(
			getResponsesRemoteCompactionV2FallbackReason({ status: 502, message: "auth_unavailable" }),
		).toBeUndefined();
		expect(getResponsesRemoteCompactionV2FallbackReason({ status: 504, code: "auth_unavailable" })).toBeUndefined();
		for (const status of [502, 503, 504])
			expect(getResponsesRemoteCompactionV2FallbackReason({ status, message: "gateway timeout" })).toContain(
				String(status),
			);
	});

	it.each([
		["zero", []],
		["two", [checkpoint, checkpoint]],
		["empty", [{ ...checkpoint, encrypted_content: "" }]],
		["failed-completed", [checkpoint], "failed"],
		["missing-completed", [checkpoint], "missing"],
	] as const)(
		"rejects malformed WebSocket terminal stream: %s",
		async (_name, outputs, terminal: "failed" | "missing" | "completed" = "completed") => {
			class Malformed extends V2MockWebSocket {
				override send(data: string) {
					this.sent.push(JSON.parse(data));
					queueMicrotask(() => {
						this.emit("message", {
							data: JSON.stringify({ type: "response.created", response: { id: "started" } }),
						});
						for (const item of outputs)
							this.emit("message", { data: JSON.stringify({ type: "response.output_item.done", item }) });
						if (terminal === "completed")
							this.emit("message", {
								data: JSON.stringify({ type: "response.completed", response: { status: "completed" } }),
							});
						else if (terminal === "failed")
							this.emit("message", {
								data: JSON.stringify({ type: "response.completed", response: { status: "failed" } }),
							});
						else this.emit("close", {});
					});
				}
			}
			setOpenAIResponsesWebSocketConstructorForTesting(Malformed as never);
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			await expect(
				compactOpenAIResponsesV2(model, { messages: [] }, { apiKey: "key", transport: "websocket" }),
			).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("merges mixed-case SSE beta headers while caller affinity wins", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("x-codex-beta-features")).toContain("model-feature");
			expect(headers.get("x-codex-beta-features")).toContain("caller-feature");
			expect(headers.get("x-codex-beta-features")).toContain("remote_compaction_v2");
			expect(headers.get("session_id")).toBe("caller-session");
			expect(headers.get("x-client-request-id")).toBe("caller-request");
			return new Response(
				stream([
					{ type: "response.output_item.done", item: checkpoint },
					{ type: "response.completed", response: { status: "completed" } },
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		});
		vi.stubGlobal("fetch", fetch);
		await compactOpenAIResponsesV2(
			{ ...model, headers: { "X-Codex-Beta-Features": "model-feature" } },
			{ messages: [] },
			{
				apiKey: "key",
				sessionId: "default",
				transport: "sse",
				headers: {
					"x-codex-beta-features": "caller-feature",
					SESSION_ID: "caller-session",
					"X-Client-Request-Id": "caller-request",
				},
			},
		);
		expect(fetch).toHaveBeenCalledOnce();
	});
});
