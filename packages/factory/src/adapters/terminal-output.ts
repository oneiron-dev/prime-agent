import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * What a seat's JSON event stream and its saved session say about how a turn ended. The stream is the agent
 * binary's `--mode json` output (one event per line); the session is its persisted JSONL file.
 */
export type ContentBlock = { type?: unknown; text?: unknown };
export function contentText(content: ContentBlock[]): string {
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

/**
 * The text of the last assistant reply of a turn that ended. A reply that called a tool, was cut off or errored
 * leaves nothing, and so does a stream without `agent_end`: earlier commentary is never reused as the final.
 */
export function finalAssistantText(jsonl: string): string {
	let final = "";
	let ended = false;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const record = event as { type?: unknown; message?: Record<string, unknown> };
		// Compaction and harness metadata can arrive after agent_end; it is not a new turn.
		if ((record.type === "message_start" || record.type === "message_end") && record.message?.role === "custom")
			continue;
		if (record.type === "agent_start" || record.type === "message_start") {
			ended = false;
			final = "";
		}
		if (record.type === "agent_end") {
			ended = true;
			continue;
		}
		if (record.type !== "message_end") continue;
		ended = false;
		final = "";
		const message = record.message;
		if (
			message?.role !== "assistant" ||
			message.stopReason !== "stop" ||
			!Array.isArray(message.content) ||
			(message.content as ContentBlock[]).some((block) => block?.type === "toolCall")
		)
			continue;
		final = contentText(message.content as ContentBlock[]);
	}
	return ended ? final : "";
}

/** Lines of `text` that sit outside fenced code blocks; fence markers themselves are dropped. */
function unfencedLines(text: string): { lines: string[]; open: boolean } {
	const lines: string[] = [];
	let fence: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			lines.push("");
			continue;
		}
		lines.push(fence ? "" : line);
	}
	return { lines, open: fence !== undefined };
}

export type WriterTerminal = { kind: "done"; line: string } | { kind: "blocked"; line: string; why: string };
/**
 * A writer reply is terminal only when its last non-empty line, outside any code fence, is exactly `DONE <key>` or
 * `BLOCKED <key>: <why>`. The same words anywhere else, inside a fence or with other text on the line are not.
 */
export function writerTerminal(final: string, key: string): WriterTerminal | undefined {
	const { lines, open } = unfencedLines(final);
	if (open) return undefined;
	const raw = final.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		if (!raw[index]!.trim()) continue;
		const line = lines[index]!.trimEnd();
		if (line === `DONE ${key}`) return { kind: "done", line };
		const blocked = `BLOCKED ${key}: `;
		if (line.startsWith(blocked) && line.slice(blocked.length).trim())
			return { kind: "blocked", line, why: line.slice(blocked.length).trim() };
		return undefined;
	}
	return undefined;
}

/**
 * The one standalone `VERDICT: LANDABLE|DEFECTS` line of a reviewer's final reply, outside code fences. None, or
 * two that disagree, is no verdict. Only terminal assistant text is inspected, never a raw event stream.
 */
export function reviewVerdict(final: string): "LANDABLE" | "DEFECTS" | undefined {
	const verdicts = new Set<"LANDABLE" | "DEFECTS">();
	for (const line of unfencedLines(final).lines) {
		const match = line.match(/^VERDICT:[ \t]*(LANDABLE|DEFECTS)[ \t]*$/)?.[1];
		if (match) verdicts.add(match as "LANDABLE" | "DEFECTS");
	}
	return verdicts.size === 1 ? [...verdicts][0] : undefined;
}

/** One line of a saved session file: the header (`type: "session"`) or an entry. */
export interface SessionEntry {
	type?: string;
	id?: string;
	cwd?: string;
	timestamp?: string;
	rlmDepth?: number;
	git?: { commit?: string };
	message?: {
		role?: string;
		stopReason?: string;
		content?: ContentBlock[];
		responseId?: string;
		provider?: string;
		model?: string;
		usage?: unknown;
		errorMessage?: string;
	};
}
export function sessionEntries(path: string): SessionEntry[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as SessionEntry);
}
/** Whether a session directory already holds a session file, i.e. a later seat call continues it. */
export function hasSessionFile(directory: string): boolean {
	return existsSync(directory) && readdirSync(directory).some((file) => file.endsWith(".jsonl"));
}
