import type OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseInputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { Context, Model, OpenAIResponsesCompactionItem } from "../types.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { convertResponsesMessages } from "./openai-responses-shared.js";
import {
	collectOpenAIResponsesWebSocketEvents,
	hasAuthenticatedOpenAIResponsesWebSocketRuntime,
	resolveOpenAIResponsesWebSocketUrl,
} from "./openai-responses-websocket.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const COMPACTION_TRIGGER = { type: "compaction_trigger" } as const;

export interface OpenAIResponsesRemoteCompactionV2Options {
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	sessionId?: string;
	customInstructions?: string;
	timeoutMs?: number;
	maxRetries?: number;
	transport?: "auto" | "sse" | "websocket";
}
export interface OpenAIResponsesRemoteCompactionV2Result {
	items: OpenAIResponsesCompactionItem[];
	input: ResponseInputItem[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createAbortError(): Error {
	const error = new Error("Request was aborted");
	error.name = "AbortError";
	return error;
}
function isCheckpoint(item: Record<string, unknown>): boolean {
	return (
		(item.type === "compaction" || item.type === "compaction_summary") &&
		typeof item.encrypted_content === "string" &&
		item.encrypted_content.length > 0
	);
}
function cloneCheckpoint(value: unknown): OpenAIResponsesCompactionItem {
	const cloned: unknown = JSON.parse(JSON.stringify(value));
	if (!isRecord(cloned) || !isCheckpoint(cloned))
		throw new Error("Remote Compaction V2 returned an invalid checkpoint");
	return cloned as OpenAIResponsesCompactionItem;
}
function buildHeaders(
	model: Model<"openai-responses">,
	options: OpenAIResponsesRemoteCompactionV2Options,
): Record<string, string> {
	// Preserve beta values from both sources even when their header spelling differs.
	const features = new Set<string>();
	for (const source of [model.headers ?? {}, options.headers ?? {}])
		for (const [key, value] of Object.entries(source))
			if (key.toLowerCase() === "x-codex-beta-features")
				for (const feature of value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean))
					features.add(feature);
	features.add("remote_compaction_v2");
	const headers: Record<string, string> = {};
	const set = (key: string, value: string) => {
		for (const existing of Object.keys(headers))
			if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
		headers[key] = value;
	};
	const apply = (source: Record<string, string>) => {
		for (const [key, value] of Object.entries(source))
			if (key.toLowerCase() !== "x-codex-beta-features") set(key, value);
	};
	apply(model.headers ?? {});
	if (options.sessionId) {
		if (model.compat?.sendSessionIdHeader !== false) set("session_id", options.sessionId);
		set("x-client-request-id", options.sessionId);
	}
	apply(options.headers ?? {}); // Caller headers deliberately override affinity.
	set("x-codex-beta-features", [...features].join(", "));
	return headers;
}
function buildInstructions(context: Context, customInstructions?: string): string | undefined {
	const parts = [
		context.systemPrompt,
		customInstructions ? `<compaction-instructions>\n${customInstructions}\n</compaction-instructions>` : undefined,
	].filter(Boolean);
	return parts.length ? parts.join("\n\n") : undefined;
}
function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesRemoteCompactionV2Options,
): ResponseCreateParamsStreaming {
	const input = convertResponsesMessages(
		model,
		{ ...context, systemPrompt: buildInstructions(context, options.customInstructions) },
		OPENAI_TOOL_CALL_PROVIDERS,
		{ includeSystemPrompt: true },
	);
	return {
		model: model.id,
		input: [...input, COMPACTION_TRIGGER] as ResponseInputItem[],
		stream: true,
		store: false,
		prompt_cache_key: options.sessionId,
	};
}
function streamError(event: ResponseStreamEvent): Error {
	const source = event.type === "response.failed" || event.type === "response.completed" ? event.response : event;
	const details = isRecord(source) && isRecord(source.error) ? source.error : source;
	const error = new Error(
		isRecord(details) && typeof details.message === "string" ? details.message : "Remote Compaction V2 stream failed",
	) as Error & { status?: number; code?: string };
	if (isRecord(details) && typeof details.code === "string") error.code = details.code;
	if (isRecord(details) && typeof details.status === "number") error.status = details.status;
	return error;
}
async function collect(events: AsyncIterable<ResponseStreamEvent>): Promise<OpenAIResponsesCompactionItem[]> {
	const checkpoints: OpenAIResponsesCompactionItem[] = [];
	for await (const event of events) {
		if (event.type === "error" || event.type === "response.failed") throw streamError(event);
		if (event.type === "response.output_item.done") {
			const item = event.item as unknown;
			if (isRecord(item) && (item.type === "compaction" || item.type === "compaction_summary"))
				checkpoints.push(cloneCheckpoint(item));
		}
		if (event.type === "response.completed") {
			if (event.response.status !== "completed") throw streamError(event);
			if (checkpoints.length !== 1)
				throw new Error(`Remote Compaction V2 expected exactly one checkpoint, received ${checkpoints.length}`);
			return checkpoints;
		}
	}
	throw new Error("Remote Compaction V2 stream ended before response.completed");
}
async function createClient(
	model: Model<"openai-responses">,
	options: OpenAIResponsesRemoteCompactionV2Options,
): Promise<OpenAI> {
	const { default: OpenAI } = await import("openai");
	const headers = buildHeaders(model, options);
	const defaultHeaders =
		model.provider === "cloudflare-ai-gateway"
			? {
					...headers,
					Authorization: headers.Authorization ?? null,
					"cf-aig-authorization": `Bearer ${options.apiKey}`,
				}
			: headers;
	return new OpenAI({
		apiKey: options.apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});
}
/** Stream Codex Remote Compaction V2 through ordinary `/responses`, never unary `/responses/compact`. */
export async function compactOpenAIResponsesV2(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesRemoteCompactionV2Options,
): Promise<OpenAIResponsesRemoteCompactionV2Result> {
	const params = buildParams(model, context, options);
	const transport = options.transport ?? "auto";
	const useWebSocket =
		transport === "websocket" ||
		(transport === "auto" &&
			model.compat?.supportsWebSocket === true &&
			(await hasAuthenticatedOpenAIResponsesWebSocketRuntime()));
	const headers = buildHeaders(model, options);
	if (useWebSocket) {
		const websocketHeaders = new Headers(headers);
		websocketHeaders.set("Authorization", `Bearer ${options.apiKey}`);
		let started = false;
		const checkpoints: OpenAIResponsesCompactionItem[] = [];
		try {
			await collectOpenAIResponsesWebSocketEvents({
				url: resolveOpenAIResponsesWebSocketUrl(model.baseUrl),
				headers: websocketHeaders,
				body: params as typeof params & { [key: string]: unknown },
				sessionId: options.sessionId,
				signal: options.signal,
				onFirstEvent: () => {
					started = true;
				},
				onEvent: (event) => {
					if (event.type === "error" || event.type === "response.failed") throw streamError(event);
					if (event.type === "response.output_item.done") {
						const item = event.item as unknown;
						if (isRecord(item) && (item.type === "compaction" || item.type === "compaction_summary"))
							checkpoints.push(cloneCheckpoint(item));
					}
					if (event.type === "response.completed") {
						if (event.response.status !== "completed") throw streamError(event);
						if (checkpoints.length !== 1)
							throw new Error(
								`Remote Compaction V2 expected exactly one checkpoint, received ${checkpoints.length}`,
							);
					}
				},
			});
			if (options.signal?.aborted) throw createAbortError();
			return { items: checkpoints, input: (params.input ?? []).slice(0, -1) as ResponseInputItem[] };
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			if (started) throw error;
		}
	}
	const client = await createClient(model, options);
	const requestOptions = {
		...(options.signal ? { signal: options.signal } : {}),
		...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
	};
	try {
		const { data } = await client.responses.create(params, requestOptions).withResponse();
		const items = await collect(data);
		if (options.signal?.aborted) throw createAbortError();
		return { items, input: (params.input ?? []).slice(0, -1) as ResponseInputItem[] };
	} catch (error) {
		// The OpenAI SDK wraps AbortError as APIUserAbortError without preserving
		// its name. Keep cancellation recognizable to AgentSession and callers.
		if (options.signal?.aborted) throw createAbortError();
		throw error;
	}
}
/** Concrete unsupported V2 transport errors that permit a local compaction fallback. */
export function getResponsesRemoteCompactionV2FallbackReason(error: unknown): string | undefined {
	const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
	const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
	const message =
		error instanceof Error
			? error.message
			: isRecord(error) && typeof error.message === "string"
				? error.message
				: String(error);
	if (status === 404 || status === 405 || status === 501) return `HTTP ${status} remote compaction V2 unavailable`;
	if (status === 502 || status === 503 || status === 504)
		return /(?:auth_unavailable|no auth available)/i.test(`${code ?? ""} ${message}`)
			? undefined
			: `HTTP ${status} remote compaction V2 temporarily unavailable`;
	if (
		(status === 400 || status === 422) &&
		/(?:compaction_trigger|remote_compaction_v2)|(?:compact|compaction).*(?:not supported|unsupported|unavailable)/i.test(
			`${code ?? ""} ${message}`,
		)
	)
		return `HTTP ${status} remote compaction V2 unsupported`;
	return undefined;
}
