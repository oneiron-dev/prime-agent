import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createTestResourceLoader } from "../../utilities.js";
import { conversationMessages, createHarness } from "../harness.js";

describe("#858 SDK persisted profile authorization", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		try {
			while (cleanups.length > 0) cleanups.pop()?.();
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});

	it("uses normal authorized fallback for a configured but catalog-excluded persisted private model", async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_API_KEY", undefined);
		vi.stubEnv("PRIME_TEAM_ID", undefined);
		const fetchCatalog = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchCatalog);
		const harness = await createHarness({
			provider: "sdk-profile-fallback",
			models: [{ id: "authorized-fallback", reasoning: true }],
			settings: {
				defaultProvider: "sdk-profile-fallback",
				defaultModel: "authorized-fallback",
				defaultThinkingLevel: "low",
				autoRefine: { enabled: false },
				compaction: { enabled: false },
				retry: { enabled: false },
				agentTraces: { enabled: false },
				telemetry: { enabled: false },
			},
		});
		cleanups.push(() => harness.cleanup());
		const { authStorage, settingsManager, tempDir } = harness;
		authStorage.set("prime-inference", {
			type: "api_key",
			key: "faux-prime-key",
			primeTeam: { teamId: "excluded-team", name: "Excluded Team" },
		});
		const modelRegistry = harness.session.modelRegistry;
		const persistedModel = modelRegistry.find("prime-inference", "internal/glm-5.2-fast")!;
		expect(persistedModel).toBeDefined();
		expect(modelRegistry.hasConfiguredAuth(persistedModel)).toBe(true);
		expect(await modelRegistry.canUseModel(persistedModel)).toBe(false);

		const sessionDir = join(tempDir, "saved-session");
		const saved = SessionManager.create(tempDir, sessionDir);
		saved.appendModelChange(persistedModel.provider, persistedModel.id, persistedModel.api);
		saved.appendThinkingLevelChange("high");
		saved.appendMessage({ role: "user", content: "saved task", timestamp: 1 });
		saved.flushNow();
		const defaultsBefore = settingsManager.getGlobalSettings();
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.open(saved.getSessionFile()!, sessionDir),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
			prewarmIpythonKernel: false,
		});
		cleanups.push(() => session.dispose());

		expect(session.model).toMatchObject({ provider: "sdk-profile-fallback", id: "authorized-fallback" });
		expect(await modelRegistry.canUseModel(session.model!)).toBe(true);
		expect(modelFallbackMessage).toBe(
			"Could not restore model prime-inference/internal/glm-5.2-fast. Using sdk-profile-fallback/authorized-fallback",
		);
		expect(session.thinkingLevel).toBe("high");
		expect(session.sessionId).toBe(saved.getSessionId());
		expect(session.sessionFile).toBe(saved.getSessionFile());
		expect(conversationMessages(session)).toEqual(saved.buildSessionContext().messages);
		expect(fetchCatalog).toHaveBeenCalledWith("https://api.pinference.ai/api/v1/models", {
			headers: {
				Authorization: "Bearer faux-prime-key",
				"X-Prime-Team-ID": "excluded-team",
				accept: "application/json",
			},
			signal: expect.any(AbortSignal),
		});
		await settingsManager.flush();
		expect(settingsManager.getGlobalSettings()).toEqual(defaultsBefore);
	});
});
