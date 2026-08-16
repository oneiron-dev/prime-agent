import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.js";
import { createFileOps } from "../src/core/compaction/utils.js";

/**
 * Split-turn prefix summarization must be bounded exactly like history summarization:
 * every request inside the byte budget, request count capped, integrity notice retained.
 */
describe("split-turn prefix summarization bounds", () => {
	const registrations: Array<{ unregister: () => void }> = [];

	afterEach(() => {
		while (registrations.length > 0) registrations.pop()?.unregister();
	});

	const reserveTokens = 8_000;

	function setup() {
		const requests: string[] = [];
		const faux = registerFauxProvider({
			models: [{ id: "bounded", contextWindow: 64_000, maxTokens: 16_384 }],
		});
		registrations.push(faux);
		const respond = Array.from({ length: 64 }, () => (context: Context, _options: StreamOptions | undefined) => {
			const content = (context.messages[0] as { content?: unknown }).content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? (content as Array<{ type: string; text?: string }>).map((block) => block.text ?? "").join("")
						: "";
			requests.push(text);
			return fauxAssistantMessage(`## Original Request\nprefix summary ${requests.length}`);
		});
		faux.setResponses(respond);
		return { faux, requests, model: faux.getModel() as Model<string> };
	}

	function user(text: string): AgentMessage {
		return { role: "user", content: text, timestamp: 1 };
	}

	function preparation(turnPrefixMessages: AgentMessage[]): CompactionPreparation {
		return {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages,
			isSplitTurn: true,
			tokensBefore: 370_512,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens },
		};
	}

	// maxTokens for the prefix pass is 0.5 * reserveTokens, matching compaction.ts.
	const requestLimit = Math.max(
		1,
		Math.min(1_000_000, Math.max(0, 64_000 - reserveTokens - Math.floor(0.5 * reserveTokens)) - 16_384),
	);

	it("chunks an incident-sized split-turn prefix and bounds every request", async () => {
		const { faux, requests, model } = setup();
		const prefix = Array.from({ length: 400 }, (_unused, index) => user(`prefix-${index}-${"a".repeat(4_000)}`));

		const result = await compact(preparation(prefix), model, "key");

		expect(requests.length).toBeGreaterThan(1);
		expect(faux.state.callCount).toBe(requests.length);
		for (const request of requests) {
			expect(Buffer.byteLength(request, "utf8")).toBeLessThanOrEqual(requestLimit);
		}
		expect(result.summary).toContain("Turn Context (split turn)");
	});

	it("caps prefix summarization requests and keeps the integrity notice", async () => {
		const { faux, requests, model } = setup();
		// Enough CJK/emoji messages to exceed the 32-chunk ceiling. Each stays under the
		// per-message bound so chunks are formed by real content, not elision markers.
		const prefix = Array.from({ length: 12_000 }, (_unused, index) => user(`前缀-${index}-😀${"漢字".repeat(200)}`));

		const result = await compact(preparation(prefix), model, "key");

		expect(faux.state.callCount).toBeLessThanOrEqual(31);
		for (const request of requests) {
			expect(Buffer.byteLength(request, "utf8")).toBeLessThanOrEqual(requestLimit);
		}
		expect(result.summary).toContain("[Compaction integrity marker]");
		expect(result.summary).toMatch(/SHA-256 of omitted chunks: [0-9a-f]{64}/);
	});

	it("keeps a small split-turn prefix on a single request", async () => {
		const { faux, model } = setup();

		const result = await compact(preparation([user("please refactor the parser")]), model, "key");

		expect(faux.state.callCount).toBe(1);
		expect(result.summary).toContain("Turn Context (split turn)");
	});
	it("shares one global request budget when both history and prefix are huge", async () => {
		const { faux, requests, model } = setup();
		const bulk = (label: string) =>
			Array.from({ length: 12_000 }, (_unused, index) => user(`${label}-${index}-😀${"漢字".repeat(200)}`));
		const prep = preparation(bulk("prefix"));
		prep.messagesToSummarize = bulk("history");

		const result = await compact(prep, model, "key");

		// Both sides are capped at half the ceiling, so the parallel pair cannot exceed 32.
		expect(faux.state.callCount).toBeLessThanOrEqual(32);
		expect(faux.state.callCount).toBe(requests.length);
		for (const request of requests) {
			expect(Buffer.byteLength(request, "utf8")).toBeLessThanOrEqual(requestLimit);
		}
		// One exact integrity notice per capped side survives in the merged summary.
		const notices = result.summary.match(/\[Compaction integrity marker\]/g) ?? [];
		expect(notices).toHaveLength(2);
		expect(result.summary.match(/SHA-256 of omitted chunks: [0-9a-f]{64}/g) ?? []).toHaveLength(2);
		expect(result.summary).toContain("Turn Context (split turn)");
	});
});
