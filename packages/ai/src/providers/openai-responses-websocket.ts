import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import NodeWebSocket from "ws";
import { registerSessionResourceCleanup } from "../session-resources.js";
import type { Api, AssistantMessage, Model } from "../types.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import {
	convertResponsesMessages,
	type OpenAIResponsesStreamOptions,
	processResponsesStream,
} from "./openai-responses-shared.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
type Listener = (event: unknown) => void;
interface Socket {
	readyState?: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void;
	removeEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void;
}
type SocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => Socket;
let socketConstructorOverride: SocketConstructor | undefined;
export function setOpenAIResponsesWebSocketConstructorForTesting(ctor?: SocketConstructor): void {
	socketConstructorOverride = ctor;
}

export function hasAuthenticatedOpenAIResponsesWebSocketRuntime(): boolean {
	return (
		socketConstructorOverride !== undefined ||
		(typeof process !== "undefined" && Boolean(process.versions?.node || process.versions?.bun))
	);
}
interface RequestBody {
	input?: ResponseInput | string;
	previous_response_id?: string | null;
	[key: string]: unknown;
}
interface Continuation {
	body: RequestBody;
	responseId: string;
	responseItems: ResponseInput;
}
interface Entry {
	socket: Socket;
	busy: boolean;
	timer?: ReturnType<typeof setTimeout>;
	continuation?: Continuation;
}
const cache = new Map<string, Entry>();

function close(socket: Socket, reason = "done") {
	try {
		socket.close(1000, reason);
	} catch {}
}
export function closeOpenAIResponsesWebSocketSessions(sessionId?: string): void {
	const entries = sessionId ? [[sessionId, cache.get(sessionId)] as const] : [...cache.entries()];
	for (const [id, entry] of entries) {
		if (!entry) continue;
		if (entry.timer) clearTimeout(entry.timer);
		close(entry.socket, "session_cleanup");
		cache.delete(id);
	}
}
registerSessionResourceCleanup(closeOpenAIResponsesWebSocketSessions);

function reusable(socket: Socket) {
	return socket.readyState === undefined || socket.readyState === 1;
}
function errorFromEvent(event: unknown, fallback: string): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message) return new Error(message);
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		if (typeof reason === "string" && reason)
			return new Error(`${fallback}${typeof code === "number" ? ` ${code}` : ""} ${reason}`);
	}
	return new Error(fallback);
}
async function connect(url: string, headers: Headers, signal?: AbortSignal): Promise<Socket> {
	if (signal?.aborted) throw new Error("Request was aborted");
	const isNodeRuntime = typeof process !== "undefined" && Boolean(process.versions?.node || process.versions?.bun);
	const Ctor =
		socketConstructorOverride ?? (isNodeRuntime ? (NodeWebSocket as unknown as SocketConstructor) : undefined);
	if (!Ctor) throw new Error("Authenticated WebSocket transport is not available in this runtime");
	return new Promise((resolve, reject) => {
		let socket: Socket;
		let settled = false;
		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const onOpen: Listener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: Listener = (event) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(errorFromEvent(event, "WebSocket error"));
		};
		const onClose: Listener = (event) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(errorFromEvent(event, "WebSocket closed"));
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			close(socket, "aborted");
			reject(new Error("Request was aborted"));
		};
		try {
			socket = new Ctor(url, { headers: headersToRecord(headers) });
		} catch (error) {
			reject(error);
			return;
		}
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});
}
function expire(sessionId: string, entry: Entry) {
	if (entry.timer) clearTimeout(entry.timer);
	entry.timer = setTimeout(() => {
		if (!entry.busy) {
			close(entry.socket, "idle_timeout");
			cache.delete(sessionId);
		}
	}, CACHE_TTL_MS);
}
async function acquire(url: string, headers: Headers, sessionId: string | undefined, signal?: AbortSignal) {
	if (!sessionId) {
		const socket = await connect(url, headers, signal);
		return {
			socket,
			entry: undefined as Entry | undefined,
			reused: false,
			release: (_keep: boolean) => close(socket),
		};
	}
	const old = cache.get(sessionId);
	if (old?.timer) {
		clearTimeout(old.timer);
		old.timer = undefined;
	}
	if (old && !old.busy && reusable(old.socket)) {
		old.busy = true;
		return {
			socket: old.socket,
			entry: old,
			reused: true,
			release: (keep: boolean) => {
				if (!keep || !reusable(old.socket)) {
					close(old.socket);
					cache.delete(sessionId);
				} else {
					old.busy = false;
					expire(sessionId, old);
				}
			},
		};
	}
	if (old && !old.busy) {
		close(old.socket);
		cache.delete(sessionId);
	}
	const socket = await connect(url, headers, signal);
	if (old?.busy)
		return {
			socket,
			entry: undefined as Entry | undefined,
			reused: false,
			release: (_keep: boolean) => close(socket),
		};
	const entry: Entry = { socket, busy: true };
	cache.set(sessionId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: (keep: boolean) => {
			if (!keep || !reusable(socket)) {
				close(socket);
				if (cache.get(sessionId) === entry) cache.delete(sessionId);
			} else {
				entry.busy = false;
				expire(sessionId, entry);
			}
		},
	};
}
async function decode(data: unknown): Promise<string | undefined> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data))
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	if (data && typeof data === "object" && "arrayBuffer" in data)
		return new TextDecoder().decode(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
}
async function* events(socket: Socket, signal?: AbortSignal): AsyncGenerator<ResponseStreamEvent> {
	const queue: ResponseStreamEvent[] = [];
	let wake: (() => void) | undefined;
	let done = false;
	let failure: Error | undefined;
	let completed = false;
	const notify = () => {
		wake?.();
		wake = undefined;
	};
	const onMessage: Listener = (event) => {
		void (async () => {
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				const text = await decode((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as ResponseStreamEvent;
				queue.push(parsed);
				if (parsed.type === "response.completed" || parsed.type === "response.failed") {
					completed = true;
					done = true;
				}
				notify();
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				done = true;
				notify();
			}
		})();
	};
	const onError: Listener = (event) => {
		failure = errorFromEvent(event, "WebSocket error");
		done = true;
		notify();
	};
	const onClose: Listener = (event) => {
		if (!completed) failure = errorFromEvent(event, "WebSocket closed before response.completed");
		done = true;
		notify();
	};
	const onAbort = () => {
		failure = new Error("Request was aborted");
		done = true;
		notify();
	};
	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);
	try {
		while (true) {
			if (queue.length) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
		if (failure) throw failure;
		if (!completed) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}
function withoutInput(body: RequestBody) {
	const { input: _input, previous_response_id: _previous, ...rest } = body;
	return rest;
}
function cachedBody(entry: Entry, body: RequestBody): RequestBody | undefined {
	const continuation = entry.continuation;
	if (!continuation) return undefined;
	if (
		typeof continuation.body.input === "string" ||
		typeof body.input === "string" ||
		JSON.stringify(withoutInput(continuation.body)) !== JSON.stringify(withoutInput(body))
	) {
		entry.continuation = undefined;
		return undefined;
	}
	const current = body.input ?? [];
	const baseline = [...(continuation.body.input ?? []), ...continuation.responseItems];
	if (
		current.length < baseline.length ||
		JSON.stringify(current.slice(0, baseline.length)) !== JSON.stringify(baseline)
	) {
		entry.continuation = undefined;
		return undefined;
	}
	return { ...body, previous_response_id: continuation.responseId, input: current.slice(baseline.length) };
}

export function resolveOpenAIResponsesWebSocketUrl(baseUrl?: string): string {
	const url = new URL((baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""));
	if (!url.pathname.endsWith("/responses")) url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	return url.toString();
}
export async function processOpenAIResponsesWebSocket<TApi extends Api>(args: {
	url: string;
	headers: Headers;
	body: RequestBody;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<TApi>;
	sessionId?: string;
	cached: boolean;
	signal?: AbortSignal;
	streamOptions?: OpenAIResponsesStreamOptions;
	onFirstEvent(): void;
	onOpen?(): void | Promise<void>;
}): Promise<void> {
	const acquired = await acquire(args.url, args.headers, args.sessionId, args.signal);
	let keep = true;
	const delta = args.cached && acquired.entry ? cachedBody(acquired.entry, args.body) : undefined;
	const request = delta ?? args.body;
	try {
		await args.onOpen?.();
		acquired.socket.send(JSON.stringify({ type: "response.create", ...request }));
		let first = true;
		const marked = (async function* () {
			for await (const event of events(acquired.socket, args.signal)) {
				if (first) {
					first = false;
					args.onFirstEvent();
				}
				yield event;
			}
		})();
		await processResponsesStream(marked, args.output, args.stream, args.model, args.streamOptions);
		if (args.signal?.aborted) keep = false;
		else if (args.cached && acquired.entry && args.output.responseId)
			acquired.entry.continuation = {
				body: args.body,
				responseId: args.output.responseId,
				responseItems: convertResponsesMessages(
					args.model,
					{ messages: [args.output] },
					new Set(["openai", "openai-codex", "opencode"]),
				).filter((item) => item.type !== "function_call_output"),
			};
	} catch (error) {
		if (acquired.entry) acquired.entry.continuation = undefined;
		keep = false;
		throw error;
	} finally {
		acquired.release(keep);
	}
}
