/**
 * Shared utilities for compaction and branch summarization.
 */

import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
const TOOL_ARGUMENT_MAX_CHARS = 2_000;
const ORDINARY_MESSAGE_MAX_CHARS = 64 * 1024;

function boundedText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const kept = Math.floor((maxChars - 80) / 2);
	return `${text.slice(0, kept)}\n\n[... ${text.length - kept * 2} characters elided ...]\n\n${text.slice(-kept)}`;
}

/** Serialize one message. Tool inputs and outputs are bounded independently. */
function serializeMessageForSummary(msg: Message, bounded = false): string | undefined {
	if (msg.role === "user") {
		const content =
			typeof msg.content === "string"
				? msg.content
				: msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("");
		return content ? `[User]: ${bounded ? boundedText(content, ORDINARY_MESSAGE_MAX_CHARS) : content}` : undefined;
	}
	if (msg.role === "assistant") {
		const parts: string[] = [];
		for (const block of msg.content) {
			if (block.type === "text")
				parts.push(`[Assistant]: ${bounded ? boundedText(block.text, ORDINARY_MESSAGE_MAX_CHARS) : block.text}`);
			else if (block.type === "thinking")
				parts.push(
					`[Assistant thinking]: ${bounded ? boundedText(block.thinking, ORDINARY_MESSAGE_MAX_CHARS) : block.thinking}`,
				);
			else if (block.type === "toolCall")
				parts.push(
					`[Assistant tool call]: ${block.name}(${boundedText(JSON.stringify(block.arguments), TOOL_ARGUMENT_MAX_CHARS)})`,
				);
		}
		return parts.join("\n") || undefined;
	}
	if (msg.role === "toolResult") {
		const content = msg.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		return content ? `[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}` : undefined;
	}
	return undefined;
}

/** Serialize messages into a bounded, non-conversational transcript. */
export function serializeConversation(messages: Message[]): string {
	return messages
		.map((message) => serializeMessageForSummary(message))
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}

/**
 * Split a transcript only between complete messages. Oversized individual messages
 * are deterministically elided, so a provider request can never exceed its byte cap.
 */
export function splitConversationForSummary(
	messages: Message[],
	maxBytes: number,
	maxChunks: number = MAX_SUMMARY_CHUNKS,
): string[] {
	if (maxBytes <= 0) throw new Error("Summary byte budget must be positive");
	const chunks: string[] = [];
	let chunk = "";
	for (const message of messages) {
		let part = serializeMessageForSummary(message, true);
		if (!part) continue;
		if (Buffer.byteLength(part, "utf8") > maxBytes) {
			part = `[Elided oversized ${message.role} message: ${Buffer.byteLength(part, "utf8")} UTF-8 bytes]`;
		}
		const candidate = chunk ? `${chunk}\n\n${part}` : part;
		if (chunk && Buffer.byteLength(candidate, "utf8") > maxBytes) {
			chunks.push(chunk);
			chunk = part;
		} else chunk = candidate;
	}
	if (chunk) chunks.push(chunk);
	return capSummaryChunks(chunks, maxChunks);
}

/** Deterministic first line of the middle-elision notice; never model-generated. */
export const COMPACTION_INTEGRITY_MARKER_PREFIX = "[Compaction integrity marker]";

/** True when a chunk is a program-generated notice, not conversation to summarize. */
export function isCompactionIntegrityMarker(chunk: string): boolean {
	return chunk.startsWith(COMPACTION_INTEGRITY_MARKER_PREFIX);
}

/**
 * Append program-generated integrity notices verbatim so the omitted-history record
 * survives regardless of what the summarization model chose to echo.
 */
export function appendCompactionIntegrityNotices(summary: string, notices: string[]): string {
	if (notices.length === 0) return summary;
	const block = notices.join("\n\n");
	return summary ? `${summary}\n\n${block}` : block;
}

/** Hard ceiling on summarization requests for one compaction, bounding cost and latency. */
export const MAX_SUMMARY_CHUNKS = 32;
/**
 * Split-turn compaction summarizes history and turn prefix in parallel. Each side gets
 * half the global ceiling so one compaction still cannot exceed MAX_SUMMARY_CHUNKS
 * summarization requests in total.
 */
export const MAX_SPLIT_SIDE_SUMMARY_CHUNKS = MAX_SUMMARY_CHUNKS / 2;
const HEAD_SUMMARY_CHUNKS = 2;

/**
 * Deterministic, explicitly lossy emergency fallback: a history that would need more
 * than MAX_SUMMARY_CHUNKS requests keeps its opening and its most recent chunks, and
 * replaces the middle with a verifiable integrity marker.
 */
function capSummaryChunks(chunks: string[], maxChunks: number): string[] {
	if (chunks.length <= maxChunks) return chunks;
	const tailCount = maxChunks - HEAD_SUMMARY_CHUNKS - 1;
	const omitted = chunks.slice(HEAD_SUMMARY_CHUNKS, chunks.length - tailCount);
	const hash = createHash("sha256");
	let omittedBytes = 0;
	for (const omittedChunk of omitted) {
		hash.update(omittedChunk, "utf8");
		omittedBytes += Buffer.byteLength(omittedChunk, "utf8");
	}
	const marker = [
		COMPACTION_INTEGRITY_MARKER_PREFIX,
		`Omitted middle chunks: ${omitted.length}`,
		`Omitted UTF-8 bytes: ${omittedBytes}`,
		`SHA-256 of omitted chunks: ${hash.digest("hex")}`,
		"This middle history was not summarized because the session exceeded the maximum",
		`of ${maxChunks} summarization requests. Treat it as permanently lost detail.`,
	].join("\n");
	return [...chunks.slice(0, HEAD_SUMMARY_CHUNKS), marker, ...chunks.slice(chunks.length - tailCount)];
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
