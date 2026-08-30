import type OpenAI from "openai";
import type { ResponseCompactParams, ResponseInputItem } from "openai/resources/responses/responses.js";
import type { Context, Model, OpenAIResponsesCompactionItem, OpenAIResponsesCompactionMessage } from "../types.js";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.js";
import { convertResponsesMessages } from "./openai-responses-shared.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface OpenAIResponsesCompactOptions {
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	sessionId?: string;
	customInstructions?: string;
	timeoutMs?: number;
	maxRetries?: number;
}

export interface OpenAIResponsesCompactResult {
	items: OpenAIResponsesCompactionItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompactionCheckpointItem(item: Record<string, unknown>): boolean {
	return (
		(item.type === "compaction" || item.type === "compaction_summary") &&
		typeof item.encrypted_content === "string" &&
		item.encrypted_content.length > 0
	);
}

/**
 * Deep-clone provider output items for durable replay.
 * Requires at least one checkpoint item (`compaction` or `compaction_summary`) with
 * nonempty encrypted_content. Preserves every item's original type/IDs/order/fields.
 */
function cloneCompactionItems(output: unknown): OpenAIResponsesCompactionItem[] {
	if (!Array.isArray(output) || output.length === 0) {
		throw new Error("Remote Responses compaction returned no output items");
	}
	const serialized = JSON.stringify(output);
	const cloned: unknown = JSON.parse(serialized);
	if (
		!Array.isArray(cloned) ||
		cloned.some((item) => !isRecord(item) || typeof item.type !== "string") ||
		!cloned.some((item) => isRecord(item) && isCompactionCheckpointItem(item))
	) {
		throw new Error("Remote Responses compaction returned invalid output items");
	}
	return cloned as OpenAIResponsesCompactionItem[];
}

async function createClient(model: Model<"openai-responses">, options: OpenAIResponsesCompactOptions): Promise<OpenAI> {
	const { default: OpenAI } = await import("openai");
	const headers: Record<string, string> = { ...model.headers, ...options.headers };
	if (options.sessionId) {
		if (model.compat?.sendSessionIdHeader !== false) {
			headers.session_id = options.sessionId;
		}
		headers["x-client-request-id"] = options.sessionId;
	}
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

function buildInstructions(context: Context, customInstructions?: string): string | undefined {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(context.systemPrompt);
	if (customInstructions) {
		parts.push(`<compaction-instructions>
${customInstructions}
</compaction-instructions>`);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Compact an OpenAI Responses context through the unary HTTP endpoint.
 * This function never uses the streaming transport or a WebSocket.
 */
export async function compactOpenAIResponses(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesCompactOptions,
): Promise<OpenAIResponsesCompactResult> {
	const input = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});
	const params: ResponseCompactParams = {
		model: model.id,
		input: input as ResponseInputItem[],
		instructions: buildInstructions(context, options.customInstructions),
		prompt_cache_key: options.sessionId,
	};
	const requestOptions = {
		...(options.signal ? { signal: options.signal } : {}),
		...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
	};
	const client = await createClient(model, options);
	const { data } = await client.responses.compact(params, requestOptions).withResponse();
	return { items: cloneCompactionItems(data.output) };
}

/** Concrete endpoint/model unsupported behavior that permits local fallback. */
export function getResponsesCompactFallbackReason(error: unknown): string | undefined {
	const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
	const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
	const message = error instanceof Error ? error.message : String(error);
	if (status === 404 || status === 405 || status === 501) {
		return `HTTP ${status} compact endpoint unavailable`;
	}
	if (status === 502 || status === 503 || status === 504) {
		if (/(?:auth_unavailable|no auth available)/i.test(`${code ?? ""} ${message}`)) {
			return undefined;
		}
		return `HTTP ${status} compact endpoint temporarily unavailable`;
	}
	// The compact endpoint is unary HTTP (never WebSocket), so an oversized request here
	// is a concrete reason to rebuild locally through the bounded partwise path.
	if (
		(status === 400 || status === 413 || status === 422) &&
		/context_too_large|context[_ ]length[_ ]exceeded|message[_ ]too[_ ]big|request_too_large|total message size|too large/i.test(
			`${code ?? ""} ${message}`,
		)
	) {
		return `HTTP ${status} compact request too large`;
	}
	if (
		(status === 400 || status === 422) &&
		/(?:compact|compaction).*(?:not supported|unsupported|unavailable)|(?:model|endpoint|route).*(?:does not support|unsupported|unknown)/i.test(
			`${code ?? ""} ${message}`,
		)
	) {
		return `HTTP ${status} compact unsupported`;
	}
	return undefined;
}

export function createOpenAIResponsesCompactionMessage(
	provider: string,
	model: string,
	items: OpenAIResponsesCompactionItem[],
	timestamp = Date.now(),
): OpenAIResponsesCompactionMessage {
	return {
		role: "openaiResponsesCompaction",
		version: 1,
		provider,
		api: "openai-responses",
		model,
		items,
		timestamp,
	};
}
