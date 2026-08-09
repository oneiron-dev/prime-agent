import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentObserveMessagePreview } from "../src/core/agent-observe.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { projectSessionJsonlForExternalUse } from "../src/core/agent-traces.js";
import { exportSessionToHtml } from "../src/core/export-html/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createAgentConnectionSnapshot } from "../src/modes/agent-connection/snapshot.js";
import { createHarness } from "./suite/harness.js";

const SENTINEL = "opaque-ciphertext-must-not-leak";

describe("remote compaction external projections", () => {
	it("keeps opaque state internal while removing it from snapshots, exports, observe, and traces", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "cpa-r",
			persistSession: true,
		});
		try {
			const model = harness.getModel();
			harness.sessionManager.appendModelChange(model.provider, model.id, model.api);
			const oldId = harness.sessionManager.appendMessage({ role: "user", content: "old", timestamp: 1 });
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
			const internalContext = harness.sessionManager.buildSessionContext();
			harness.session.agent.state.messages = internalContext.messages;
			expect(JSON.stringify(internalContext)).toContain(SENTINEL);

			const snapshot = createAgentConnectionSnapshot({ session: harness.session } as AgentSessionRuntime);
			const snapshotJson = JSON.stringify(snapshot);
			expect(snapshotJson).not.toContain(SENTINEL);
			expect(snapshotJson).not.toContain("modelApi");
			expect(snapshotJson).not.toContain("remoteCompaction");
			expect(snapshotJson).not.toContain('"mechanism"');
			expect(snapshot.messages.some((message) => message.role === "openaiResponsesCompaction")).toBe(false);

			const remoteMessage = internalContext.messages[0];
			if (!remoteMessage) throw new Error("missing remote message");
			const preview = createAgentObserveMessagePreview(remoteMessage, 0, 800);
			expect(JSON.stringify(preview)).not.toContain(SENTINEL);
			expect(preview.text).toBe("[remote compaction checkpoint]");

			const sessionFile = harness.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("missing session file");
			const rawJsonl = readFileSync(sessionFile, "utf8");
			expect(rawJsonl).toContain(SENTINEL);
			expect(projectSessionJsonlForExternalUse(rawJsonl)).not.toContain(SENTINEL);

			const htmlPath = join(harness.tempDir, "session.html");
			await exportSessionToHtml(harness.sessionManager, harness.session.state, { outputPath: htmlPath });
			const html = readFileSync(htmlPath, "utf8");
			const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			if (!encoded) throw new Error("missing exported session data");
			const exportedData = Buffer.from(encoded, "base64").toString("utf8");
			expect(exportedData).not.toContain(SENTINEL);

			const jsonlPath = join(harness.tempDir, "export.jsonl");
			harness.session.exportToJsonl(jsonlPath);
			expect(readFileSync(jsonlPath, "utf8")).not.toContain(SENTINEL);
			const reopened = SessionManager.open(jsonlPath).buildSessionContext();
			expect(reopened.messages.some((message) => message.role === "user" && message.content === "old")).toBe(true);
			expect(reopened.messages.some((message) => message.role === "openaiResponsesCompaction")).toBe(false);
		} finally {
			harness.cleanup();
		}
	});
});
