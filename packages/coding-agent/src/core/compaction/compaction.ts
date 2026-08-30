/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
	compactOpenAIResponses,
	compactOpenAIResponsesV2,
	completeSimple,
	createOpenAIResponsesCompactionMessage,
	isContextOverflow,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.js";
import {
	buildSessionContext,
	type CompactionEntry,
	type CompactionFallback,
	type CompactionMechanism,
	isValidRemoteCompactionState,
	projectAgentMessagesForExternalUse,
	type RemoteCompactionState,
	type SessionEntry,
} from "../session-manager.js";
import type { CompactionMode } from "../settings-manager.js";
import {
	appendCompactionIntegrityNotices,
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	isCompactionIntegrityMarker,
	MAX_SPLIT_SIDE_SUMMARY_CHUNKS,
	SUMMARIZATION_SYSTEM_PROMPT,
	splitConversationForSummary,
} from "./utils.js";
/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
/** Preserve file operations recorded by prior compactions and current tool calls. */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		if (entry.mechanism === "remote" && isValidRemoteCompactionState(entry.remoteCompaction)) {
			return createOpenAIResponsesCompactionMessage(
				entry.remoteCompaction.provider,
				entry.remoteCompaction.modelId,
				entry.remoteCompaction.items,
				new Date(entry.timestamp).getTime(),
			);
		}
		return createCompactionSummaryMessage(
			entry.summary,
			entry.tokensBefore,
			entry.timestamp,
			entry.customInstructions,
		);
	}
	return undefined;
}

const SYNTHETIC_COMPACTION_TYPES = new Set([
	"heartbeat_prompt",
	"ipython_state",
	"ipython_state_restored",
	"prime-agent.worker_recovery",
]);

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") return undefined;
	// Synthetic runtime notices are transient state, not conversational history.
	if (entry.type === "custom_message" && SYNTHETIC_COMPACTION_TYPES.has(entry.customType)) return undefined;
	const message = getMessageFromEntry(entry);
	if (message?.role === "custom" && SYNTHETIC_COMPACTION_TYPES.has(message.customType)) return undefined;
	return message;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	mechanism?: CompactionMechanism;
	remoteCompaction?: RemoteCompactionState;
	fallback?: CompactionFallback;
}

export function projectCompactionResultForExternalUse<T>(result: CompactionResult<T>): CompactionResult<T> {
	return {
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		details: result.details,
	};
}

/** Remove provider-opaque remote compaction state from extension-facing preparation. */
export function projectCompactionPreparationForExternalUse(preparation: CompactionPreparation): CompactionPreparation {
	const { previousRemoteCompaction: _previousRemoteCompaction, ...publicPreparation } = preparation;
	return {
		...publicPreparation,
		messagesToSummarize: projectAgentMessagesForExternalUse(preparation.messagesToSummarize),
		turnPrefixMessages: projectAgentMessagesForExternalUse(preparation.turnPrefixMessages),
	};
}
export const COMPACT_SKILL_NAME = "compact";

export interface CompactionSettings {
	enabled: boolean;
	mode?: CompactionMode;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	mode: "auto",
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};
/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 *
 * Includes output: the assistant's response becomes part of the prompt on the next
 * request, so it counts toward the context the next turn will send.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}
/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				chars = content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				chars = message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						chars += block.text.length;
					}
					if (block.type === "image") {
						chars += 4800; // Estimate images as 4000 chars, or 1200 tokens
					}
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
		case "openaiResponsesCompaction":
			return 0;
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function isSyntheticCompactionEntry(entry: SessionEntry): boolean {
	return entry.type === "custom_message" && SYNTHETIC_COMPACTION_TYPES.has(entry.customType);
}

function estimateEntryTokens(entry: SessionEntry): number {
	const message = getMessageFromEntry(entry);
	return message ? estimateTokens(message) : 0;
}

function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
					case "openaiResponsesCompaction":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role turn boundaries, and so valid
		// cut points. Synthetic compaction entries are not: cutting there would drop the
		// summary they belong to.
		if (entry.type === "branch_summary" || (entry.type === "custom_message" && !isSyntheticCompactionEntry(entry))) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		// Include persisted custom messages: otherwise a giant synthetic state notice
		// costs zero and can survive in the retained tail indefinitely.
		accumulatedTokens += estimateEntryTokens(entry);

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction" || isSyntheticCompactionEntry(prevEntry)) {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	// A cut in a non-user turn requires a prefix summary.
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const KERNEL_PERSIST_SUMMARY_NOTE =
	"Note: the Python kernel keeps running after this summary — every Python variable, import, and helper you defined stays available. The cells that defined them won't appear above, so record in the summary any names worth remembering so you reuse them instead of redefining them.";

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Build the instruction portion of the summarization prompt: the initial or
 * update template, optional user instructions, and the kernel persistence note.
 */
export function buildSummarizationPrompt(customInstructions?: string, previousSummary?: string): string {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt += `\n\n<user-instructions>\nThe user provided these instructions for this summary. Follow them with high priority while keeping the section format above: emphasize what they ask to focus on, and preserve verbatim anything they ask to remember.\n${customInstructions}\n</user-instructions>`;
	}
	return `${basePrompt}\n\n${KERNEL_PERSIST_SUMMARY_NOTE}`;
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
/** Largest transcript supplied to one request. Keeps room for framing and provider overhead. */
const MAX_SUMMARY_REQUEST_BYTES = 1_000_000;
const SUMMARY_REQUEST_OVERHEAD_BYTES = 16_384;

function summaryRequestByteLimit(model: Model<any>, reserveTokens: number, maxTokens: number): number {
	// One UTF-8 byte per available token is deliberately tokenizer-independent:
	// CJK and emoji can consume roughly one token per byte, unlike chars/4.
	// Framing/output reserves are removed before admitting transcript bytes.
	const availableInputTokens = Math.max(0, model.contextWindow - reserveTokens - maxTokens);
	return Math.max(1, Math.min(MAX_SUMMARY_REQUEST_BYTES, availableInputTokens - SUMMARY_REQUEST_OVERHEAD_BYTES));
}

function elideSummaryForRequest(summary: string, limit: number): string {
	if (Buffer.byteLength(summary, "utf8") <= limit) return summary;
	const marker = "\n[... prior summary elided for request safety ...]\n";
	let keptChars = Math.max(1, Math.floor((limit - Buffer.byteLength(marker, "utf8")) / 8));
	let result = "";
	// JS slices are character based; reduce until the final UTF-8 request is exact-safe.
	do {
		result = `${summary.slice(0, keptChars)}${marker}${summary.slice(-keptChars)}`;
		keptChars--;
	} while (Buffer.byteLength(result, "utf8") > limit && keptChars > 0);
	return result;
}

/**
 * Prompt templates for one bounded rolling summarization pass. `initial` is used for
 * the first chunk, `update` merges each later chunk into the rolling result, so a
 * caller's own summary semantics survive chunking instead of collapsing to one format.
 */
interface RollingSummaryPrompts {
	initial(): string;
	update(previous: string): string;
}

interface RollingSummaryOptions {
	messages: AgentMessage[];
	model: Model<any>;
	reserveTokens: number;
	maxTokens: number;
	apiKey: string;
	prompts: RollingSummaryPrompts;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	previousSummary?: string;
	emptyResult: string;
	failurePrefix: string;
	/** Chunk ceiling for this pass; split-turn passes share the global budget. */
	maxChunks?: number;
}

/**
 * Single bounded summarization engine: complete-message chunking, exact UTF-8 preflight,
 * capped request count, and deterministic integrity notices. Every summarization path
 * goes through here so none can issue an unbounded single-shot request.
 */
async function runRollingSummary(options: RollingSummaryOptions): Promise<string> {
	const { model, reserveTokens, maxTokens, apiKey, prompts, headers, signal, thinkingLevel } = options;
	const requestLimit = summaryRequestByteLimit(model, reserveTokens, maxTokens);
	const chunks = splitConversationForSummary(
		convertToLlm(options.messages),
		Math.max(1_024, Math.floor(requestLimit / 3)),
		options.maxChunks,
	);
	let rollingSummary = options.previousSummary;
	const integrityNotices: string[] = [];
	for (const conversationText of chunks) {
		// Program-generated notices are facts, not history: never pay a request for them.
		if (isCompactionIntegrityMarker(conversationText)) {
			integrityNotices.push(conversationText);
			continue;
		}
		const instructions = rollingSummary ? prompts.update(rollingSummary) : prompts.initial();
		const fixedBytes = Buffer.byteLength(
			`<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`,
			"utf8",
		);
		const availableSummaryBytes = Math.max(512, requestLimit - fixedBytes - 64);
		const prior = rollingSummary ? elideSummaryForRequest(rollingSummary, availableSummaryBytes) : undefined;
		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (prior) promptText += `<previous-summary>\n${prior}\n</previous-summary>\n\n`;
		promptText += instructions;
		const bytes = Buffer.byteLength(promptText, "utf8");
		if (bytes > requestLimit)
			throw new Error(`Summary request exceeds safe UTF-8 byte budget (${bytes} > ${requestLimit})`);
		const response = await completeSimple(
			model,
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
			},
			model.reasoning && thinkingLevel && thinkingLevel !== "off"
				? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
				: { maxTokens, signal, apiKey, headers },
		);
		if (response.stopReason === "error")
			throw new Error(`${options.failurePrefix}: ${response.errorMessage || "Unknown error"}`);
		rollingSummary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return appendCompactionIntegrityNotices(rollingSummary || options.emptyResult, integrityNotices);
}

/** Generate a summary with byte-bounded, rolling partwise compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	maxChunks?: number,
): Promise<string> {
	return runRollingSummary({
		messages: currentMessages,
		maxChunks,
		model,
		reserveTokens,
		maxTokens: Math.floor(0.8 * reserveTokens),
		apiKey,
		headers,
		signal,
		thinkingLevel,
		previousSummary,
		prompts: {
			initial: () => buildSummarizationPrompt(customInstructions),
			update: (previous) => buildSummarizationPrompt(customInstructions, previous),
		},
		emptyResult: "No compactable conversation content.",
		failurePrefix: "Summarization failed",
	});
}
export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous local compaction, for iterative update. */
	previousSummary?: string;
	/** Opaque checkpoint from the previous remote compaction, for native replay. */
	previousRemoteCompaction?: RemoteCompactionState;
	previousRemoteTokensBefore?: number;
	previousRemoteTimestamp?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: { restartFromRoot?: boolean } = {},
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let previousRemoteCompaction: RemoteCompactionState | undefined;
	let previousRemoteTokensBefore: number | undefined;
	let previousRemoteTimestamp: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0 && !options.restartFromRoot) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		if (prevCompaction.mechanism === "remote") {
			if (isValidRemoteCompactionState(prevCompaction.remoteCompaction)) {
				previousRemoteCompaction = prevCompaction.remoteCompaction;
				previousRemoteTokensBefore = prevCompaction.tokensBefore;
				previousRemoteTimestamp = prevCompaction.timestamp;
				const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
				boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
			}
		} else {
			previousSummary = prevCompaction.summary;
			const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
			boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
		}
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Everything fits in the keep-recent window and there is no previous summary
	// to carry forward — compacting would summarize an empty conversation.
	if (
		messagesToSummarize.length === 0 &&
		turnPrefixMessages.length === 0 &&
		!previousSummary &&
		!previousRemoteCompaction
	) {
		return undefined;
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	// Split turns retain their suffix, but their prefix file operations still belong in the summary.
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousRemoteCompaction,
		previousRemoteTokensBefore,
		previousRemoteTimestamp,
		fileOps,
		settings,
	};
}
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

const TURN_PREFIX_UPDATE_SUMMARIZATION_PROMPT = `The messages above are ADDITIONAL earlier messages from the SAME turn prefix already summarized in <previous-summary> tags. The SUFFIX (recent work) is retained separately.

Update that prefix summary so it still explains the retained suffix. RULES:
- PRESERVE existing information from the previous prefix summary
- ADD new decisions and work found in these messages
- PRESERVE exact file paths, function names, and error messages

Keep this EXACT format:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Both passes run in parallel, so each gets half the global request ceiling:
		// one compaction still issues at most MAX_SUMMARY_CHUNKS summarization requests.
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						MAX_SPLIT_SIDE_SUMMARY_CHUNKS,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				MAX_SPLIT_SIDE_SUMMARY_CHUNKS,
			),
		]);
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
		);
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		mechanism: "local",
	};
}

export function shouldUseRemoteCompactionV2(model: Model<any>, mode: CompactionMode): boolean {
	if (mode === "local" || model.api !== "openai-responses") return false;
	return (model as Model<"openai-responses">).compat?.supportsResponsesRemoteCompactionV2 === true;
}

function isV2Record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal Exported for deterministic persisted-state contract tests. */
export function retainedV2Items(input: readonly unknown[], checkpoint: { type: string; [key: string]: unknown }) {
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	// Only user messages are durable; the live system/developer prompt is re-injected.
	const messages: Array<{ type: string; role?: string; [key: string]: unknown }> = input
		.filter((item): item is Record<string, unknown> => isV2Record(item) && item.role === "user")
		.map((item) => ({ ...clone(item), type: "message" }));
	const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
	const approxTokenCount = (value: string) => Math.ceil(utf8Bytes(value) / 4);
	const approxTokensFromByteCount = (bytes: number) => Math.ceil(bytes / 4);
	const truncateText = (value: unknown, maxTokens: number) => {
		if (typeof value !== "string") return "";
		if (value === "") return "";
		const maxBytes = maxTokens * 4;
		const totalBytes = utf8Bytes(value);
		if (maxBytes === 0) return `…${approxTokensFromByteCount(totalBytes)} tokens truncated…`;
		if (totalBytes <= maxBytes) return value;
		const left = Math.floor(maxBytes / 2);
		const right = maxBytes - left;
		let offset = 0;
		let prefix = "";
		let prefixEnd = 0;
		for (const ch of value) {
			offset += utf8Bytes(ch);
			if (offset <= left) {
				prefix += ch;
				prefixEnd = offset;
			}
		}
		const suffixStartLimit = totalBytes - right;
		let suffix = "";
		offset = 0;
		for (const ch of value) {
			const start = offset;
			offset += utf8Bytes(ch);
			if (start >= Math.max(suffixStartLimit, prefixEnd)) suffix += ch;
		}
		const removed = approxTokensFromByteCount(totalBytes - maxBytes);
		return `${prefix}…${removed} tokens truncated…${suffix}`;
	};
	const tokenCount = (value: unknown) => (typeof value === "string" ? approxTokenCount(value) : 0);
	const messageTokens = (item: (typeof messages)[number]) => {
		const content = item.content;
		if (typeof content === "string") return tokenCount(content);
		return Array.isArray(content)
			? content.reduce(
					(total, part) =>
						total +
						(isV2Record(part) && (part.type === "input_text" || part.type === "output_text")
							? tokenCount(part.text)
							: 0),
					0,
				)
			: 0;
	};
	const truncate = (item: (typeof messages)[number], budget: number) => {
		if (typeof item.content === "string") {
			const content = truncateText(item.content, budget);
			return content ? { ...item, content } : undefined;
		}
		if (!Array.isArray(item.content)) return item;
		let remaining = budget;
		const content = item.content.flatMap((part) => {
			if (!isV2Record(part) || (part.type !== "input_text" && part.type !== "output_text")) return [clone(part)];
			const tokens = tokenCount(part.text);
			if (!remaining) return [];
			if (tokens <= remaining) {
				remaining -= tokens;
				return [clone(part)];
			}
			const text = truncateText(part.text, remaining);
			remaining = 0;
			return text ? [{ ...clone(part), text }] : [];
		});
		return content.length ? { ...item, content } : undefined;
	};
	let remaining = 64_000;
	const kept: typeof messages = [];
	for (const item of [...messages].reverse()) {
		if (!remaining) continue;
		const tokens = Math.max(1, messageTokens(item));
		if (tokens <= remaining) {
			kept.push(item);
			remaining -= tokens;
		} else {
			const boundary = truncate(item, remaining);
			if (boundary) kept.push(boundary);
			remaining = 0;
		}
	}
	return [...kept.reverse(), clone(checkpoint)];
}

export function shouldUseRemoteCompaction(model: Model<any>, mode: CompactionMode): boolean {
	if (mode === "local" || model.api !== "openai-responses") return false;
	return (model as Model<"openai-responses">).compat?.supportsResponsesCompact === true;
}

export function remoteCompactionCompatibilityError(model: Model<any>, mode: CompactionMode): string | undefined {
	if (mode !== "remote" || shouldUseRemoteCompactionV2(model, mode) || shouldUseRemoteCompaction(model, mode))
		return undefined;
	return `Remote compaction is not declared supported for ${model.provider}/${model.id} (${model.api})`;
}

/** Opaque remote checkpoints preserve input verbatim; never replay bulky synthetic state. */
export function hasOversizedSyntheticRemoteCheckpoint(state: RemoteCompactionState, maxBytes = 16 * 1024): boolean {
	const visit = (value: unknown, seen: Set<object>, depth: number): boolean => {
		if (typeof value === "string")
			return Buffer.byteLength(value, "utf8") > maxBytes && /<ipython_state(?:_restored)?|<heartbeat/i.test(value);
		if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return false;
		seen.add(value);
		for (const child of Object.values(value)) if (visit(child, seen, depth + 1)) return true;
		return false;
	};
	return state.items.some((item) => visit(item, new Set(), 0));
}

/** A remote checkpoint that barely reduced a near-window context must migrate locally. */
export function isIneffectiveRemoteCompaction(
	tokensBefore: number,
	postTokens: number,
	contextWindow: number,
): boolean {
	if (tokensBefore <= 0 || contextWindow <= 0) return false;
	return postTokens >= contextWindow * 0.8 && 1 - postTokens / tokensBefore < 0.15;
}

export function shouldMigrateRemoteCheckpoint(
	state: RemoteCompactionState,
	tokensBefore: number,
	firstPostTokens: number | undefined,
	contextWindow: number,
): boolean {
	return (
		hasOversizedSyntheticRemoteCheckpoint(state) ||
		(firstPostTokens !== undefined && isIneffectiveRemoteCompaction(tokensBefore, firstPostTokens, contextWindow))
	);
}

/** Outcome of inspecting the turns that followed a remote checkpoint. */
export interface RemotePostCheckpointSample {
	/** An explicit context overflow was reported; migrate without waiting for usage. */
	overflow: boolean;
	/** Context tokens of the first post-checkpoint turn carrying meaningful usage. */
	postTokens?: number;
}

/**
 * Pick the evidence that judges a remote checkpoint. A zero-usage generic error row
 * proves nothing about checkpoint size, so it is skipped, but an explicit context
 * overflow is decisive even with zero usage.
 */
export function sampleRemotePostCheckpointUsage(
	messages: AssistantMessage[],
	contextWindow: number,
): RemotePostCheckpointSample {
	for (const message of messages) {
		if (isContextOverflow(message, contextWindow)) return { overflow: true };
		const postTokens = calculateContextTokens(message.usage);
		if (postTokens > 0) return { overflow: false, postTokens };
	}
	return { overflow: false };
}

export function canReplayRemoteCompaction(state: RemoteCompactionState, model: Model<any>): boolean {
	return (
		isValidRemoteCompactionState(state) &&
		model.api === "openai-responses" &&
		state.provider === model.provider &&
		state.api === model.api &&
		state.modelId === model.id
	);
}

export async function compactRemote(
	preparation: CompactionPreparation,
	model: Model<"openai-responses">,
	apiKey: string,
	systemPrompt: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	sessionId?: string,
): Promise<CompactionResult<CompactionDetails>> {
	const remoteMessages: AgentMessage[] = [];
	if (preparation.previousSummary) {
		remoteMessages.push(
			createCompactionSummaryMessage(
				preparation.previousSummary,
				preparation.tokensBefore,
				new Date().toISOString(),
			),
		);
	}
	if (preparation.previousRemoteCompaction) {
		remoteMessages.push(
			createOpenAIResponsesCompactionMessage(
				preparation.previousRemoteCompaction.provider,
				preparation.previousRemoteCompaction.modelId,
				preparation.previousRemoteCompaction.items,
			),
		);
	}
	remoteMessages.push(...preparation.messagesToSummarize, ...preparation.turnPrefixMessages);
	const result = await compactOpenAIResponses(
		model,
		{ systemPrompt, messages: convertToLlm(remoteMessages) },
		{ apiKey, headers, signal, sessionId, customInstructions },
	);
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	const summary =
		"Provider-native OpenAI Responses compaction checkpoint (opaque)." +
		formatFileOperations(readFiles, modifiedFiles);
	return {
		summary,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
		mechanism: "remote",
		remoteCompaction: {
			version: 1,
			provider: model.provider,
			api: "openai-responses",
			modelId: model.id,
			items: result.items,
		},
	};
}

export async function compactRemoteV2(
	preparation: CompactionPreparation,
	model: Model<"openai-responses">,
	apiKey: string,
	systemPrompt: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	sessionId?: string,
): Promise<CompactionResult<CompactionDetails>> {
	const remoteMessages: AgentMessage[] = [];
	if (preparation.previousSummary)
		remoteMessages.push(
			createCompactionSummaryMessage(
				preparation.previousSummary,
				preparation.tokensBefore,
				new Date().toISOString(),
			),
		);
	if (preparation.previousRemoteCompaction)
		remoteMessages.push(
			createOpenAIResponsesCompactionMessage(
				preparation.previousRemoteCompaction.provider,
				preparation.previousRemoteCompaction.modelId,
				preparation.previousRemoteCompaction.items,
			),
		);
	remoteMessages.push(...preparation.messagesToSummarize, ...preparation.turnPrefixMessages);
	const result = await compactOpenAIResponsesV2(
		model,
		{ systemPrompt, messages: convertToLlm(remoteMessages) },
		{ apiKey, headers, signal, sessionId, customInstructions },
	);
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	return {
		summary:
			"Provider-native OpenAI Responses compaction checkpoint (opaque)." +
			formatFileOperations(readFiles, modifiedFiles),
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
		mechanism: "remote",
		remoteCompaction: {
			version: 1,
			provider: model.provider,
			api: "openai-responses",
			modelId: model.id,
			items: retainedV2Items(result.input, result.items[0]!),
		},
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	maxChunks?: number,
): Promise<string> {
	return runRollingSummary({
		messages,
		maxChunks,
		model,
		reserveTokens,
		maxTokens: Math.floor(0.5 * reserveTokens), // Smaller budget for turn prefix
		apiKey,
		headers,
		signal,
		thinkingLevel,
		prompts: {
			initial: () => TURN_PREFIX_SUMMARIZATION_PROMPT,
			update: () => TURN_PREFIX_UPDATE_SUMMARIZATION_PROMPT,
		},
		emptyResult: "No turn prefix content.",
		failurePrefix: "Turn prefix summarization failed",
	});
}
