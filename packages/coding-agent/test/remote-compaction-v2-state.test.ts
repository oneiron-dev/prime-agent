import { describe, expect, it } from "vitest";
import { retainedV2Items, shouldUseRemoteCompactionV2 } from "../src/core/compaction/compaction.js";

const checkpoint = {
	type: "compaction",
	encrypted_content: "opaque",
	id: "current-checkpoint",
	unknown: { preserved: true },
};
const model = (compat: Record<string, boolean> = {}) =>
	({ api: "openai-responses", provider: "cpa-r", id: "sol", compat }) as any;

describe("Codex Remote Compaction V2 state", () => {
	it("selects V2 only for an explicit capability and before unary compaction", () => {
		expect(shouldUseRemoteCompactionV2(model(), "auto")).toBe(false);
		expect(shouldUseRemoteCompactionV2(model(), "remote")).toBe(false);
		expect(shouldUseRemoteCompactionV2(model({ supportsResponsesCompact: true }), "remote")).toBe(false);
		expect(shouldUseRemoteCompactionV2(model({ supportsResponsesRemoteCompactionV2: true }), "auto")).toBe(true);
		expect(shouldUseRemoteCompactionV2(model({ supportsResponsesRemoteCompactionV2: true }), "remote")).toBe(true);
		expect(
			shouldUseRemoteCompactionV2(
				model({ supportsResponsesCompact: true, supportsResponsesRemoteCompactionV2: true }),
				"remote",
			),
		).toBe(true);
		expect(shouldUseRemoteCompactionV2(model({ supportsResponsesRemoteCompactionV2: true }), "local")).toBe(false);
		expect(
			shouldUseRemoteCompactionV2(
				{ ...model({ supportsResponsesRemoteCompactionV2: true }), api: "openai-completions" },
				"remote",
			),
		).toBe(false);
	});

	it("normalizes and clones durable roles while replacing all obsolete state with one current checkpoint", () => {
		const input = [
			{ role: "system", content: "system", metadata: { preserved: true } },
			{ type: "message", role: "developer", content: "developer", future: { preserved: true } },
			{ type: "message", role: "assistant", content: "assistant must be dropped" },
			{ type: "function_call_output", call_id: "tool", output: "tool must be dropped" },
			{ type: "compaction", encrypted_content: "obsolete-checkpoint" },
			{
				role: "user",
				content: [
					{ type: "input_text", text: "hello", unknown: "preserved" },
					{ type: "input_image", image_url: "data:image/png;base64,a", detail: "low" },
				],
				unknownMessageField: { preserved: true },
			},
		];
		const currentCheckpoint = { ...checkpoint, unknown: { preserved: true } };
		const result = retainedV2Items(input, currentCheckpoint);

		expect(result.map((item) => item.role).filter(Boolean)).toEqual(["user"]);
		for (const message of result.slice(0, -1)) expect(message.type).toBe("message");
		expect(result[0]).toMatchObject({ unknownMessageField: { preserved: true }, type: "message" });
		expect((result[0] as any).content).toEqual(input[5]?.content);
		expect(result.filter((item) => item.type === "compaction")).toEqual([currentCheckpoint]);
		expect(result.at(-1)).toEqual(currentCheckpoint);

		(input[5]!.unknownMessageField as { preserved: boolean }).preserved = false;
		currentCheckpoint.unknown.preserved = false;
		expect((result[0]!.unknownMessageField as { preserved: boolean }).preserved).toBe(true);
		expect((result.at(-1)!.unknown as { preserved: boolean }).preserved).toBe(true);
	});

	it("keeps newest messages first and applies Codex-style head-tail boundary truncation", () => {
		const result = retainedV2Items(
			[
				{ role: "user", content: "old-message-must-be-dropped" },
				{ role: "user", content: `HEAD-${"m".repeat(299_990)}-TAIL` },
				{ role: "user", content: "new" },
			],
			checkpoint,
		);
		const messages = result.slice(0, -1);
		expect(messages).toHaveLength(2);
		expect(messages[1]?.content).toBe("new");
		const boundary = String(messages[0]?.content);
		expect(boundary).toMatch(/^HEAD-/);
		expect(boundary).toMatch(/-TAIL$/);
		expect(boundary).toMatch(/…\d+ tokens truncated…/);
		expect(JSON.stringify(result)).not.toContain("old-message-must-be-dropped");
		expect(result.at(-1)).toEqual(checkpoint);
	});

	it("preserves image order and truncates a later text part at the 64k boundary", () => {
		const firstText = "a".repeat(255_996); // 63,999 approximate tokens.
		const result = retainedV2Items(
			[
				{
					role: "user",
					content: [
						{ type: "input_text", text: firstText },
						{ type: "input_image", image_url: "data:image/png;base64,a" },
						{ type: "output_text", text: "uvwxyz" },
					],
				},
			],
			checkpoint,
		);
		const content = (result[0] as any).content;
		expect(content).toEqual([
			{ type: "input_text", text: firstText },
			{ type: "input_image", image_url: "data:image/png;base64,a" },
			{ type: "output_text", text: "uv…1 tokens truncated…yz" },
		]);
		expect(result.at(-1)).toEqual(checkpoint);
	});
	it("uses UTF-8 byte budgets and preserves Unicode code points", () => {
		const cjk = retainedV2Items([{ role: "user", content: "中中中abc" }], checkpoint);
		const result = retainedV2Items(
			[
				{ role: "user", content: "中中中abc" },
				{ role: "user", content: "a".repeat(255_992) },
			],
			checkpoint,
		);
		expect(result[0]?.content).toBe("中…1 tokens truncated…abc");
		expect(cjk[0]?.content).toBe("中中中abc");
	});
	it("drops a four-byte emoji rather than retaining half a scalar at a one-token boundary", () => {
		const result = retainedV2Items(
			[
				{ role: "user", content: "😀a" },
				{ role: "user", content: "a".repeat(255_993) },
			],
			checkpoint,
		);
		const text = String(result[0]?.content);
		expect(text).toMatch(/^…1 tokens truncated…a$/);
		expect(text).not.toContain("😀");
		expect([...text]).not.toContain("\ud83d");
	});

	it("never splits a surrogate pair at the UTF-8 truncation boundary", () => {
		const result = retainedV2Items([{ role: "user", content: `😀${"a".repeat(255_992)}` }], checkpoint);
		const text = String(result[0]?.content);
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code >= 0xd800 && code <= 0xdbff) expect(text.charCodeAt(++index)).toBeGreaterThanOrEqual(0xdc00);
			if (code >= 0xdc00 && code <= 0xdfff) expect(text.charCodeAt(index - 1)).toBeGreaterThanOrEqual(0xd800);
		}
	});

	it("drops live prompt and compaction instructions from developer/system items", () => {
		const result = retainedV2Items(
			[
				{ role: "system", content: "PROMPT <compaction-instructions>FOCUS</compaction-instructions>" },
				{ role: "developer", content: "PROMPT <compaction-instructions>FOCUS</compaction-instructions>" },
				{ role: "user", content: "keep" },
			],
			checkpoint,
		);
		expect(result.map((item) => item.role)).toEqual(["user", undefined]);
		expect(JSON.stringify(result)).not.toContain("PROMPT");
	});
	it("keeps image-only items atomically and drops them only with their message", () => {
		const image = { type: "input_image", image_url: "data:image/png;base64,a" };
		const kept = retainedV2Items(
			[
				{ role: "user", content: "a".repeat(256_000) },
				{ role: "user", content: [image] },
			],
			checkpoint,
		);
		expect(kept.some((item) => JSON.stringify(item.content ?? "").includes("input_image"))).toBe(true);
		const dropped = retainedV2Items(
			[
				{ role: "user", content: [image] },
				{ role: "user", content: "a".repeat(256_000) },
			],
			checkpoint,
		);
		expect(dropped.some((item) => JSON.stringify(item.content ?? "").includes("input_image"))).toBe(false);
	});
});
