import { describe, expect, it } from "vitest";
import type { SessionBeforeCompactEvent } from "../src/core/extensions/index.js";
import { createHarness } from "./suite/harness.js";

const SENTINEL = "opaque-ciphertext-must-not-leak-to-extensions";

describe("remote compaction extension-event opacity", () => {
	it("redacts remoteCompaction from session_before_compact while retaining it internally", async () => {
		let capturedEvent: SessionBeforeCompactEvent | undefined;

		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1, mode: "local" } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
						capturedEvent = event;
						return {
							compaction: {
								summary: "extension summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});

		try {
			const model = harness.getModel();
			harness.sessionManager.appendModelChange(model.provider, model.id, model.api);
			const oldId = harness.sessionManager.appendMessage({
				role: "user",
				content: "old work that will be compacted",
				timestamp: 1,
			});
			harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "openai-responses",
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			harness.sessionManager.appendCompaction(
				"Provider-native OpenAI Responses compaction checkpoint (opaque).",
				oldId,
				2,
				{ readFiles: [], modifiedFiles: [] },
				false,
				undefined,
				{
					mechanism: "remote",
					remoteCompaction: {
						version: 1,
						provider: model.provider,
						api: "openai-responses",
						modelId: model.id,
						items: [{ type: "compaction", id: "cmp_1", encrypted_content: SENTINEL }],
					},
				},
			);

			// Grow past the keep-recent window so prepareCompaction succeeds.
			await harness.session.prompt("fresh user turn after remote compaction");
			await harness.session.prompt("second fresh turn");

			const internalBefore = harness.sessionManager.buildSessionContext();
			expect(JSON.stringify(internalBefore)).toContain(SENTINEL);

			const branchBefore = harness.sessionManager.getBranch();
			expect(JSON.stringify(branchBefore)).toContain("remoteCompaction");
			expect(JSON.stringify(branchBefore)).toContain(SENTINEL);

			await harness.session.compact();

			expect(capturedEvent).toBeDefined();
			const payloadJson = JSON.stringify(capturedEvent);
			expect(payloadJson).not.toContain(SENTINEL);
			expect(payloadJson).not.toContain("remoteCompaction");
			expect(payloadJson).not.toContain("previousRemoteCompaction");
			expect(capturedEvent?.preparation).not.toHaveProperty("previousRemoteCompaction");
			for (const entry of capturedEvent?.branchEntries ?? []) {
				if (entry.type === "compaction") {
					expect(entry).not.toHaveProperty("remoteCompaction");
					expect(entry).not.toHaveProperty("mechanism");
					expect(entry).not.toHaveProperty("fallback");
				}
			}

			// Internal session state still retains opaque remote compaction for model replay.
			const internalAfter = harness.sessionManager.getBranch();
			expect(JSON.stringify(internalAfter)).toContain(SENTINEL);
			expect(JSON.stringify(internalAfter)).toContain("remoteCompaction");
		} finally {
			harness.cleanup();
		}
	});
});
