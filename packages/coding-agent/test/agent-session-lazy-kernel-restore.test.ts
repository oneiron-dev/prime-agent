import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type Context, createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";
import { snapshotPathIn } from "../src/core/kernel/state-snapshot.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { assistantMsg, createTestResourceLoader } from "./utilities.js";

interface InspectableSession {
	_buildRuntime(options: { activeToolNames?: string[] }): void;
}

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("AgentSession lazy child snapshot restoration", () => {
	let tempDir: string;
	let sessions: AgentSession[];
	let events: string[];
	let contexts: Context[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-lazy-child-restore-"));
		sessions = [];
		events = [];
		contexts = [];
		vi.spyOn(ReplKernelManager.prototype, "start").mockImplementation(async () => {
			events.push("start");
		});
		vi.spyOn(ReplKernelManager.prototype, "restoreState").mockImplementation(async () => {
			events.push("restore");
			return { restored: ["saved_value"], failed: [], path: "unused-stub-path" };
		});
		vi.spyOn(ReplKernelManager.prototype, "execute").mockImplementation(async (code, options) => {
			events.push(options?.internal ? "bootstrap" : code);
			return { stdout: "ok", stderr: "", status: "ok", durationMs: 1 };
		});
		vi.spyOn(ReplKernelManager.prototype, "shutdown").mockResolvedValue(true);
		vi.spyOn(ReplKernelManager.prototype, "isRunning", "get").mockReturnValue(true);
		vi.spyOn(ReplKernelManager.prototype, "isShutDown", "get").mockReturnValue(false);
		vi.spyOn(IpythonKernelProvisioner.prototype, "prewarm");
	});

	afterEach(async () => {
		await Promise.all(sessions.map((session) => session.disposeAsync()));
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(options: { depth: number; snapshot?: boolean; prewarm?: boolean }): AgentSession {
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		if (options.snapshot) {
			const artifactDir = sessionManager.getSessionArtifactDir()!;
			mkdirSync(artifactDir, { recursive: true });
			// An inert marker only: manager methods are stubbed and never deserialize it.
			writeFileSync(snapshotPathIn(artifactDir), "not-a-pickle");
		}
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "stub-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "stub-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: (_model, context) => {
				contexts.push({ ...context, messages: structuredClone(context.messages) });
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMsg("done") }));
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			cwd: tempDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: options.depth,
			prewarmIpythonKernel: options.prewarm,
		});
		sessions.push(session);
		return session;
	}

	it("does not start saved descendant kernels just to observe or hydrate sessions", async () => {
		for (let depth = 1; depth <= 20; depth++) createSession({ depth, snapshot: true });
		await Promise.resolve();

		expect(IpythonKernelProvisioner.prototype.prewarm).not.toHaveBeenCalled();
		expect(ReplKernelManager.prototype.start).not.toHaveBeenCalled();
	});

	it.each([{ snapshot: true }, { prewarm: true }])("retains top-level prewarming for %j", async (options) => {
		createSession({ depth: 0, ...options });
		expect(IpythonKernelProvisioner.prototype.prewarm).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(events).toEqual(["start", "restore", "bootstrap"]));
	});

	it("does not enable descendant prewarming through the top-level option", () => {
		createSession({ depth: 1, prewarm: true });
		expect(IpythonKernelProvisioner.prototype.prewarm).not.toHaveBeenCalled();
	});

	it("tells the first model turn that saved state is pending without starting Python", async () => {
		const session = createSession({ depth: 2, snapshot: true });
		await session.prompt("Only summarize the transcript.");

		expect(events).toEqual([]);
		expect(contexts, JSON.stringify(session.messages)).toHaveLength(1);
		expect(JSON.stringify(contexts[0].messages)).toContain("<ipython_state_restore_pending>");
		expect(JSON.stringify(contexts[0].messages)).not.toContain("<ipython_state_restored>");
	});

	it("restores on first Python use before executing code and preserves the notice across reload", async () => {
		const session = createSession({ depth: 2, snapshot: true });
		(session as unknown as InspectableSession)._buildRuntime({ activeToolNames: ["ipython"] });
		await session.prompt("Only summarize the transcript.");
		expect(contexts, JSON.stringify(session.messages)).toHaveLength(1);
		const firstContext = JSON.stringify(contexts[0].messages);
		expect(firstContext.match(/<ipython_state_restore_pending>/g)).toHaveLength(1);
		expect(events).toEqual([]);

		const tool = session.agent.state.tools.find((candidate) => candidate.name === "ipython")!;
		await tool.execute("test-call", { code: "print(saved_value)" });
		expect(events).toEqual(["start", "restore", "bootstrap", "print(saved_value)"]);

		await session.prompt("Report the restored state.");
		expect(JSON.stringify(contexts.at(-1)!.messages)).toContain("<ipython_state_restored>");
		expect(JSON.stringify(contexts.at(-1)!.messages)).toContain("saved_value");
		expect(ReplKernelManager.prototype.start).toHaveBeenCalledTimes(1);
	});
});
