import { readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeConfig } from "../../../src/core/agent-session-config.js";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import type { ExtensionAPI } from "../../../src/index.js";
import { createDefaultRuntimeFactory } from "../../../src/main.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonOutbound } from "../../../src/modes/daemon/daemon-protocol.js";
import { readRlmSubagentDisplayEntry } from "../../../src/modes/daemon/rlm-subagent-display.js";
import { createHarness } from "../harness.js";

type DaemonInternals = {
	sessions: Map<string, ActiveSessionState>;
	createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
	createRlmSubagentRuntime(
		parent: ActiveSessionState,
		options: CreateRlmSubagentRuntimeOptions,
	): Promise<AgentSessionRuntime>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
	passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
	closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void>;
	rehydrateCompletedRlmSubagentOnce(
		parent: ActiveSessionState,
		entry: {
			childId: string;
			sessionName: string;
			sessionDir: string;
			sessionFile: string;
			parentSessionId: string;
			parentSessionFile: string;
			rlmDepth: number;
			model?: { provider: string; modelId: string };
			status: "completed";
			createdAt: number;
		},
	): Promise<ActiveSessionState>;
};

describe("#858 daemon child profile rehydration", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		try {
			while (cleanups.length > 0) await cleanups.pop()?.();
		} finally {
			vi.restoreAllMocks();
		}
	});

	async function createFixture(withPrivateModelAuth = false) {
		const spawn = await createHarness({
			provider: "rehydrate-spawn",
			models: [
				{ id: "spawn-model", reasoning: true },
				{ id: "global-model", reasoning: true },
			],
		});
		cleanups.push(() => spawn.cleanup());
		const latest = await createHarness({
			provider: "rehydrate-latest",
			models: [{ id: "latest-model", reasoning: true }],
		});
		cleanups.push(() => latest.cleanup());

		// Keep auth and catalog discovery local. All provider requests still use the faux streams.
		vi.spyOn(AuthStorage, "create").mockImplementation(() => {
			const authStorage = AuthStorage.inMemory();
			if (withPrivateModelAuth) authStorage.setRuntimeApiKey("prime-inference", "faux-prime-key");
			return authStorage;
		});
		vi.spyOn(ModelRegistry.prototype, "refreshAvailableModels").mockImplementation(
			async function (this: ModelRegistry) {
				return this.getAvailable();
			},
		);
		const settingsPath = join(spawn.tempDir, "settings.json");
		const globalSettings = {
			defaultProvider: spawn.getModel().provider,
			defaultModel: "global-model",
			defaultThinkingLevel: "medium",
			autoRefine: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			agentTraces: { enabled: false },
			telemetry: { enabled: false },
		};
		writeFileSync(settingsPath, JSON.stringify(globalSettings));
		const defaultSessionConfig: AgentSessionRuntimeConfig = {
			cwd: spawn.tempDir,
			agentDir: spawn.tempDir,
			sessionDir: join(spawn.tempDir, "sessions"),
			thinking: "low",
			noTools: true,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			telemetryDisabled: true,
		};
		const factory = createDefaultRuntimeFactory(defaultSessionConfig, [
			(pi: ExtensionAPI) => {
				for (const harness of [spawn, latest]) {
					pi.registerProvider(harness.getModel().provider, {
						baseUrl: harness.getModel().baseUrl,
						apiKey: "faux-key",
						api: harness.faux.api,
						models: harness.models.map((model) => ({
							...model,
							thinkingLevelMap: { xhigh: "xhigh" },
						})),
					});
				}
			},
		]);
		const createRuntime = vi.fn<CreateAgentSessionRuntimeFactory>(factory);
		const daemon = new AgentDaemon(join(spawn.tempDir, "daemon.sock"), { defaultSessionConfig, createRuntime });
		const internals = daemon as unknown as DaemonInternals;
		cleanups.push(async () => {
			for (const state of [...internals.sessions.values()]) {
				if (internals.sessions.has(state.activeSessionId)) await internals.closeSession(state, "shutdown");
			}
		});
		const parent = await internals.createRuntime({ type: "create", name: "parent" });
		return { spawn, latest, internals, parent, createRuntime, settingsPath, defaultSessionConfig };
	}

	it.each(["xhigh", "off"] as const)(
		"uses the latest set_model and %s thinking for the next request after passivation",
		async (thinking) => {
			const fixture = await createFixture();
			const { spawn, latest, internals, parent, settingsPath, createRuntime, defaultSessionConfig } = fixture;
			const parentSession = parent.runtime.session;
			const childId = "sub-profile";
			const childDir = join(parentSession.sessionManager.getSessionArtifactDir()!, childId);
			const runtime = await internals.createRlmSubagentRuntime(parent, {
				parentSession,
				id: childId,
				sessionName: "profile-child",
				sessionDir: childDir,
				prompt: "initial task",
				model: spawn.getModel(),
				thinkingLevel: "high",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				allowedToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmParentNodeId: childId,
			});
			spawn.setResponses([fauxAssistantMessage("initial task done")]);
			await runtime.session.prompt("initial task");
			expect(parentSession.registerRlmChildSession(childId, runtime.session)).toBe(true);
			const child = [...internals.sessions.values()].find((state) => state.runtime === runtime)!;
			const sessionId = runtime.session.sessionId;
			const sessionFile = runtime.session.sessionFile!;
			const header = runtime.session.sessionManager.getHeader();
			const metadata = runtime.metadata;
			const client: DaemonSocketClient = {
				id: "profile-client",
				socket: new Socket(),
				attachedActiveSessionIds: new Set(),
				detachInput: () => {},
				supportsExtensionUi: false,
				capabilities: new Set(),
			};
			cleanups.push(() => {
				client.socket.destroy();
			});
			await expect(
				internals.handleCommand(client, {
					type: "set_model",
					activeSessionId: child.activeSessionId,
					provider: latest.getModel().provider,
					modelId: latest.getModel().id,
				}),
			).resolves.toMatchObject({ success: true });
			await expect(
				internals.handleCommand(client, {
					type: "set_thinking_level",
					activeSessionId: child.activeSessionId,
					level: thinking,
				}),
			).resolves.toMatchObject({ success: true });
			expect(runtime.session.sessionManager.buildSessionContext()).toMatchObject({
				model: { provider: latest.getModel().provider, modelId: latest.getModel().id },
				thinkingLevel: thinking,
			});
			expect((await readRlmSubagentDisplayEntry(childDir))?.model).toEqual({
				provider: spawn.getModel().provider,
				modelId: spawn.getModel().id,
			});

			// set_model intentionally updates defaults. Choose unrelated defaults before the restore.
			await runtime.services.settingsManager.flush();
			const settings = parent.runtime.services.settingsManager;
			settings.setDefaultModelAndProvider(spawn.getModel().provider, "global-model");
			settings.setDefaultThinkingLevel("medium");
			await settings.flush();
			const defaultsBefore = readFileSync(settingsPath, "utf8");
			const configBefore = structuredClone(defaultSessionConfig);
			expect(await internals.passivateIdleChildren(90, Date.now() + 91 * 60_000, 1)).toBe(1);
			expect(internals.sessions.has(child.activeSessionId)).toBe(false);

			const restored = await internals.createRuntime({ type: "create", sessionPath: sessionFile });
			expect(restored.runtime).not.toBe(runtime);
			expect(restored.runtime.session.sessionId).toBe(sessionId);
			expect(restored.runtime.session.sessionFile).toBe(sessionFile);
			expect(restored.runtime.session.sessionManager.getHeader()).toEqual(header);
			expect(restored.runtime.metadata).toMatchObject({
				kind: "subagent",
				createdAt: metadata.createdAt,
				parentActiveSessionId: parent.activeSessionId,
				parentSessionId: parentSession.sessionId,
				parentSessionFile: parentSession.sessionFile,
				rlmChildId: childId,
				rlmParentNodeId: childId,
				rehydratedCompleted: true,
			});
			expect(restored.runtime.session.model).toMatchObject({
				provider: latest.getModel().provider,
				id: latest.getModel().id,
			});
			expect(restored.runtime.session.thinkingLevel).toBe(thinking);
			expect(createRuntime.mock.lastCall?.[0].sessionOptions).toMatchObject({
				model: { provider: latest.getModel().provider, id: latest.getModel().id },
				thinkingLevel: thinking,
			});
			const nextRequest = vi.fn();
			latest.setResponses([
				(_context, options, _state, model) => {
					nextRequest({
						provider: model.provider,
						model: model.id,
						thinking: (options as SimpleStreamOptions)?.reasoning,
					});
					return fauxAssistantMessage("restored task done");
				},
			]);
			await restored.runtime.session.prompt("continue on the restored profile");
			expect(nextRequest).toHaveBeenCalledExactlyOnceWith({
				provider: latest.getModel().provider,
				model: latest.getModel().id,
				thinking,
			});
			await restored.runtime.services.settingsManager.flush();
			expect(readFileSync(settingsPath, "utf8")).toBe(defaultsBefore);
			expect(defaultSessionConfig).toEqual(configBefore);
			expect(parentSession.model?.id).toBe("global-model");
			expect(parentSession.thinkingLevel).toBe("low");
		},
	);

	it.each([
		{
			name: "spawn model when no model is persisted",
			persisted: undefined,
			spawnModel: true,
			expected: "spawn-model",
		},
		{
			name: "defaults when neither model is present",
			persisted: undefined,
			spawnModel: false,
			expected: "global-model",
		},
		{
			name: "normal fallback, not spawn, when the persisted model is unavailable",
			persisted: { provider: "unavailable-provider", modelId: "unavailable-model" },
			spawnModel: true,
			expected: "global-model",
		},
		{
			name: "normal fallback, not spawn, when the configured persisted model is catalog-excluded",
			persisted: { provider: "prime-inference", modelId: "internal/glm-5.2-fast" },
			spawnModel: true,
			expected: "global-model",
		},
	])("keeps $name without changing global defaults", async ({ persisted, spawnModel, expected }) => {
		const withPrivateModelAuth = persisted?.provider === "prime-inference";
		const { spawn, internals, parent, createRuntime, settingsPath } = await createFixture(withPrivateModelAuth);
		if (persisted && withPrivateModelAuth) {
			const registry = parent.runtime.services.modelRegistry;
			const privateModel = registry.find(persisted.provider, persisted.modelId)!;
			expect(privateModel).toBeDefined();
			expect(registry.hasConfiguredAuth(privateModel)).toBe(true);
			expect(await registry.canUseModel(privateModel)).toBe(false);
		}
		const parentSession = parent.runtime.session;
		const sessionDir = join(parentSession.sessionManager.getSessionArtifactDir()!, "sub-fallback");
		const manager = SessionManager.create(spawn.tempDir, sessionDir);
		manager.newSession({ parentSession: parentSession.sessionFile, rlmDepth: 1 });
		manager.appendMessage({ role: "user", content: "saved task", timestamp: 1 });
		if (persisted) manager.appendModelChange(persisted.provider, persisted.modelId);
		manager.flushNow();
		const defaultsBefore = readFileSync(settingsPath, "utf8");
		const restored = await internals.rehydrateCompletedRlmSubagentOnce(parent, {
			childId: "sub-fallback",
			sessionName: "fallback-child",
			sessionDir,
			sessionFile: manager.getSessionFile()!,
			parentSessionId: parentSession.sessionId,
			parentSessionFile: parentSession.sessionFile!,
			rlmDepth: 1,
			model: spawnModel ? { provider: spawn.getModel().provider, modelId: spawn.getModel().id } : undefined,
			status: "completed",
			createdAt: 1,
		});
		expect(restored.runtime.session.model?.id).toBe(expected);
		expect(restored.runtime.session.thinkingLevel).toBe("low");
		expect(restored.runtime.session.sessionId).toBe(manager.getSessionId());
		expect(restored.runtime.metadata.parentSessionId).toBe(parentSession.sessionId);
		const restoredOptions = createRuntime.mock.lastCall?.[0].sessionOptions;
		expect(restoredOptions?.model?.id).toBe(spawnModel && !persisted ? "spawn-model" : undefined);
		expect(restoredOptions?.thinkingLevel).toBeUndefined();
		if (persisted) {
			expect(restored.runtime.modelFallbackMessage).toContain(
				`Could not restore model ${persisted.provider}/${persisted.modelId}`,
			);
		}
		await restored.runtime.services.settingsManager.flush();
		expect(readFileSync(settingsPath, "utf8")).toBe(defaultsBefore);
	});
});
