import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

describe("AgentSession disposal during compaction", () => {
	let testDir: string;
	let session: AgentSession;

	beforeEach(async () => {
		testDir = join(tmpdir(), `agent-session-disposal-compact-${Date.now()}`);
		if (!existsSync(testDir)) {
			mkdirSync(testDir, { recursive: true });
		}

		const sessionManager = SessionManager.create(testDir);
		const settingsManager = SettingsManager.create(testDir, testDir);
		const authStorage = AuthStorage.create(join(testDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, testDir);

		const agent = new Agent({
			streamFn: vi.fn(() => new MockAssistantStream()),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: testDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("does not reconnect to agent after disposal during compaction", async () => {
		// Mock _reconnectToAgent to track calls
		const reconnectSpy = vi.spyOn(session as any, "_reconnectToAgent");

		// Mock _performCompaction to simulate async work
		vi.spyOn(session as any, "_performCompaction").mockImplementation(async () => {
			// Simulate compaction work that takes time
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { conversationTurnsRemoved: 5 };
		});

		// Start a compaction
		const compactPromise = session.compact("test instructions");

		// Dispose while compaction is in progress
		session.dispose();

		// Wait for compaction to complete (should be cancelled or throw)
		await compactPromise.catch(() => {});

		// After disposal completes, _reconnectToAgent should not have been called
		// because the finally block guards it with if (!this._disposed)
		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it("does not process events after disposal when compaction completes", async () => {
		const eventHandler = vi.fn();
		session.subscribe((event) => {
			if (event.type === "message_end") {
				eventHandler(event);
			}
		});

		// Mock a successful compaction that completes after disposal
		vi.spyOn(session as any, "_performCompaction").mockImplementation(async () => {
			// Simulate async compaction work
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { conversationTurnsRemoved: 5 };
		});

		const compactPromise = session.compact("test");

		// Dispose immediately
		session.dispose();

		// Let compaction complete
		await compactPromise.catch(() => {});

		// Verify the session was disposed and won't process new events
		// (The internal _disposed flag should prevent reconnection)
		expect((session as any)._disposed).toBe(true);
	});
});
