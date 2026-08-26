import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	appendCompactionIntegrityNotices,
	isCompactionIntegrityMarker,
	MAX_SUMMARY_CHUNKS,
	serializeConversation,
	splitConversationForSummary,
} from "../src/core/compaction/utils.js";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
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
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
	it("splits serialized context at message boundaries and bounds tool arguments", () => {
		const huge = "x".repeat(8_000);
		const messages: Message[] = [
			{ role: "user", content: "first", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "write", arguments: { payload: huge } }],
				api: "anthropic",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "write",
				content: [{ type: "text", text: huge }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "z".repeat(800), timestamp: 0 },
			{ role: "user", content: "q".repeat(800), timestamp: 0 },
		];
		const chunks = splitConversationForSummary(messages, 1_000);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 1_000)).toBe(true);
		expect(chunks.join("\n")).not.toContain(huge);
	});
	it("keeps CJK, emoji, and an 18MB transcript finite under UTF-8 byte chunking", () => {
		const adversarial = "漢字😀".repeat(300_000);
		const chunks = splitConversationForSummary([{ role: "user", content: adversarial, timestamp: 0 }], 64 * 1024);
		expect(chunks).toHaveLength(1);
		expect(Buffer.byteLength(chunks[0]!, "utf8")).toBeLessThanOrEqual(64 * 1024);
		expect(chunks[0]).toContain("Elided oversized");
		const huge = splitConversationForSummary(
			[{ role: "user", content: "x".repeat(18_950_049), timestamp: 0 }],
			64 * 1024,
		);
		expect(huge).toHaveLength(1);
		expect(huge[0]).not.toBe("");
		expect(Buffer.byteLength(huge[0]!, "utf8")).toBeLessThanOrEqual(64 * 1024);
	});
	it("caps summarization requests with a deterministic integrity marker", () => {
		const messages: Message[] = Array.from({ length: 200 }, (_unused, index) => ({
			role: "user" as const,
			content: `message-${index}-${"a".repeat(900)}`,
			timestamp: index,
		}));
		const chunks = splitConversationForSummary(messages, 1_000);
		expect(chunks.length).toBe(MAX_SUMMARY_CHUNKS);
		expect(chunks[0]).toContain("message-0-");
		expect(chunks[chunks.length - 1]).toContain("message-199-");
		const marker = chunks[2]!;
		expect(marker).toContain("Omitted middle chunks: 169");
		expect(marker).toMatch(/SHA-256 of omitted chunks: [0-9a-f]{64}/);
		expect(splitConversationForSummary(messages, 1_000)).toEqual(chunks);
	});
	it("keeps the integrity notice out of provider calls but inside the final summary", () => {
		const messages: Message[] = Array.from({ length: 200 }, (_unused, index) => ({
			role: "user" as const,
			content: `message-${index}-${"a".repeat(900)}`,
			timestamp: index,
		}));
		const chunks = splitConversationForSummary(messages, 1_000);
		expect(chunks.length).toBe(MAX_SUMMARY_CHUNKS);

		const markers = chunks.filter(isCompactionIntegrityMarker);
		const summarizable = chunks.filter((chunk) => !isCompactionIntegrityMarker(chunk));
		expect(markers).toHaveLength(1);
		expect(summarizable).toHaveLength(MAX_SUMMARY_CHUNKS - 1);
		expect(summarizable.length).toBeLessThanOrEqual(31);

		const finalSummary = appendCompactionIntegrityNotices("## Goal\nmodel summary without the notice", markers);
		expect(finalSummary).toContain("## Goal");
		expect(finalSummary).toContain(markers[0]!);
		expect(finalSummary).toContain("Omitted middle chunks: 169");
		expect(finalSummary).toMatch(/SHA-256 of omitted chunks: [0-9a-f]{64}/);
		expect(appendCompactionIntegrityNotices("## Goal\nmodel summary without the notice", markers)).toBe(finalSummary);
		expect(appendCompactionIntegrityNotices("only summary", [])).toBe("only summary");
	});
});
