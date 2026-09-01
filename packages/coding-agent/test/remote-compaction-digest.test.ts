import { describe, expect, it } from "vitest";
import { extractRemoteCompactionDigest } from "../src/core/compaction/index.js";
import type { RemoteCompactionState } from "../src/core/session-manager.js";

function state(items: unknown[]): RemoteCompactionState {
	return {
		version: 1,
		provider: "cpa-r",
		api: "openai-responses",
		modelId: "gpt-5.6-sol",
		items,
	} as RemoteCompactionState;
}

describe("extractRemoteCompactionDigest", () => {
	it("extracts readable message text and skips encrypted checkpoint markers", () => {
		const digest = extractRemoteCompactionDigest(
			state([
				{ type: "message", role: "user", content: [{ type: "input_text", text: "board digest one" }] },
				{ type: "compaction", encrypted_content: "opaque-blob" },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "digest two" }] },
			]),
		);
		expect(digest).toBe("board digest one\n\ndigest two");
	});

	it("accepts string content and text/output_text blocks", () => {
		const digest = extractRemoteCompactionDigest(
			state([
				{ type: "message", role: "user", content: "plain string content" },
				{
					type: "message",
					role: "assistant",
					content: [
						{ type: "output_text", text: "assistant text" },
						{ type: "image", data: "ignored" },
					],
				},
			]),
		);
		expect(digest).toBe("plain string content\n\nassistant text");
	});

	it("returns undefined when nothing readable exists", () => {
		expect(extractRemoteCompactionDigest(state([{ type: "compaction", encrypted_content: "x" }]))).toBeUndefined();
		expect(extractRemoteCompactionDigest(state([]))).toBeUndefined();
	});

	it("ignores unknown companion item types and malformed entries", () => {
		const digest = extractRemoteCompactionDigest(
			state([
				{ type: "reasoning", encrypted_content: "blob" },
				"not-a-record",
				null,
				{ type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] },
			]),
		);
		expect(digest).toBe("kept");
	});
});
