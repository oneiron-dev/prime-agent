import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type Child = AgentConnectionRlmChildAgentSnapshot;

interface RefreshHarness {
	isInitialized: boolean;
	subagentSnapshots: Map<string, Child>;
	subagentSummaryRefresh?: NodeJS.Immediate;
	seedSubagentSummary(children: readonly Child[]): void;
	replaceSubagentSummary(children: readonly Child[]): void;
	updateSubagentSummary(child: Child): void;
	resetSubagentSummary(): void;
	rebindCurrentSession(): Promise<void>;
	subscribeToRosterBar(): Promise<void>;
	stop(): void;
}

function child(id: string, overrides: Partial<Child> = {}): Child {
	return { id, label: id, status: "done", sessionDir: `/tmp/child-refresh/${id}`, ...overrides };
}

function createHarness(overrides: Record<string, unknown> = {}) {
	const setSubagentCounts = vi.fn();
	const requestRender = vi.fn();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		subagentSnapshots: new Map<string, Child>(),
		rlmNodeId: undefined,
		subagentSummaryLine: { setSubagentCounts, isSelectable: () => false, focused: false },
		scheduleHeartbeatManagerRefresh: vi.fn(),
		updateWorkingPulse: vi.fn(),
		syncWorkingLoader: vi.fn(),
		updateWorkingLoaderMessage: vi.fn(),
		ui: { requestRender, stop: vi.fn() },
		...overrides,
	}) as RefreshHarness;
	return { mode, setSubagentCounts, requestRender };
}

function rosterSummary(id: string, parentSessionId?: string): SessionSummary {
	return {
		id,
		sessionId: id,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/child-refresh",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		runtimeKind: parentSessionId ? "subagent" : "top-level",
		parentSessionId,
	};
}

async function createRosterHarness() {
	let listener: (() => void) | undefined;
	const summaries = vi.fn(() => [rosterSummary("root"), rosterSummary("worker", "root")]);
	const heartbeat = vi.fn();
	const pulse = vi.fn();
	const loader = vi.fn();
	const loaderMessage = vi.fn();
	const showError = vi.fn();
	const harness = createHarness({
		connectionState: { sessionId: "root" },
		scheduleHeartbeatManagerRefresh: heartbeat,
		updateWorkingPulse: pulse,
		syncWorkingLoader: loader,
		updateWorkingLoaderMessage: loaderMessage,
		showError,
		agentConnection: {
			subscribeAgentRoster: async (callback: () => void) => {
				listener = callback;
				return { summaries, dispose: async () => {} };
			},
		},
	});
	await harness.mode.subscribeToRosterBar();
	harness.setSubagentCounts.mockClear();
	summaries.mockClear();
	return {
		...harness,
		summaries,
		heartbeat,
		pulse,
		loader,
		loaderMessage,
		showError,
		emitRoster: () => {
			if (!listener) throw new Error("Roster listener was not subscribed");
			listener();
		},
	};
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] }));
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("InteractiveMode child refresh scheduling", () => {
	it("applies a burst immediately and refreshes counts once on the next turn", async () => {
		const { mode, setSubagentCounts, requestRender } = createHarness();
		for (let index = 0; index < 1000; index++) {
			mode.updateSubagentSummary(child(`child-${index}`));
			// Model the serialized async event chain without advancing to the next turn.
			await Promise.resolve();
		}
		expect(mode.subagentSnapshots.size).toBe(1000);
		expect(setSubagentCounts).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({
			total: 1000,
			running: 0,
			idle: 0,
			inactive: 1000,
		});
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it("shows a single child update on the next turn", () => {
		const { mode, setSubagentCounts } = createHarness();
		mode.updateSubagentSummary(child("worker", { status: "running" }));
		expect(mode.subagentSnapshots.get("worker")?.status).toBe("running");
		expect(setSubagentCounts).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({ total: 1, running: 1, idle: 0, inactive: 0 });
	});

	it("uses the latest rename and terminal status from a queued burst", () => {
		const { mode, setSubagentCounts } = createHarness();
		mode.updateSubagentSummary(child("worker", { status: "running", activeSessionId: "active-worker" }));
		mode.updateSubagentSummary(child("worker", { status: "running", label: "renamed" }));
		mode.updateSubagentSummary(child("worker", { label: "finished" }));
		vi.runAllTimers();
		expect(mode.subagentSnapshots.get("worker")).toMatchObject({ label: "finished", status: "done" });
		expect(mode.subagentSnapshots.get("worker")?.activeSessionId).toBeUndefined();
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({ total: 1, running: 0, idle: 0, inactive: 1 });
	});

	it("seeds immediately without overwriting an early live child update", () => {
		const { mode, setSubagentCounts } = createHarness();
		mode.updateSubagentSummary(child("worker", { status: "running", label: "live" }));
		mode.seedSubagentSummary([child("worker", { label: "older snapshot" }), child("other")]);
		expect(mode.subagentSnapshots.get("worker")?.label).toBe("live");
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({ total: 2, running: 1, idle: 0, inactive: 1 });
		vi.runAllTimers();
		expect(setSubagentCounts).toHaveBeenCalledOnce();
	});

	it("replaces with the authoritative snapshot and cancels the pending refresh", () => {
		const { mode, setSubagentCounts } = createHarness();
		mode.updateSubagentSummary(child("old", { status: "running" }));
		mode.replaceSubagentSummary([child("new")]);
		expect([...mode.subagentSnapshots.keys()]).toEqual(["new"]);
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({ total: 1, running: 0, idle: 0, inactive: 1 });
		vi.runAllTimers();
		expect(setSubagentCounts).toHaveBeenCalledOnce();
	});

	it("reset clears the pending refresh and leaves an empty summary", () => {
		const { mode, setSubagentCounts } = createHarness();
		mode.updateSubagentSummary(child("old", { status: "running" }));
		mode.resetSubagentSummary();
		expect(mode.subagentSnapshots.size).toBe(0);
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({ total: 0, running: 0, idle: 0, inactive: 0 });
		vi.runAllTimers();
		expect(setSubagentCounts).toHaveBeenCalledOnce();
	});

	it("does not paint a queued update after the UI becomes uninitialized", () => {
		const { mode, setSubagentCounts, requestRender } = createHarness();
		mode.updateSubagentSummary(child("old"));
		mode.isInitialized = false;
		vi.runAllTimers();
		expect(setSubagentCounts).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(mode.subagentSummaryRefresh).toBeUndefined();
	});

	it("cancels old child refreshes before waiting for a session rebind", async () => {
		let releaseBinding = () => {};
		const binding = new Promise<void>((resolve) => {
			releaseBinding = resolve;
		});
		const { mode, setSubagentCounts } = createHarness({
			toolDefinitionCache: new Map(),
			applyRuntimeSettings: vi.fn(),
			bindLocalSessionExtensions: true,
			bindCurrentSessionExtensions: () => binding,
			subscribeToAgent: vi.fn(),
			subscribeToRosterBar: vi.fn(async () => {}),
			agentConnection: {
				getState: async () => ({ sessionActions: { queuedCount: 0, steering: [], followUps: [] } }),
			},
			patchConnectionState: vi.fn(),
			refreshQueueSelectionFromState: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			refreshHeartbeatCatalog: vi.fn(async () => {}),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => ({})),
			syncGoalTray: vi.fn(),
		});
		mode.updateSubagentSummary(child("old"));
		const rebind = mode.rebindCurrentSession();
		vi.runAllTimers();
		expect(setSubagentCounts).not.toHaveBeenCalled();
		expect(mode.subagentSummaryRefresh).toBeUndefined();
		releaseBinding();
		await rebind;
	});

	it("stop cancels the pending refresh without painting after teardown", () => {
		const cleanupNames = [
			"unregisterSignalHandlers",
			"clearCtrlCExitHint",
			"clearEscapeRepeat",
			"stopWorkingLoader",
			"discardRefineLoader",
			"endFeatureHintRun",
			"stopWorkingPulse",
			"stopGoalTrayTimer",
			"closeHeartbeatManager",
			"clearExtensionTerminalInputListeners",
		];
		const { mode, setSubagentCounts, requestRender } = createHarness({
			...Object.fromEntries(cleanupNames.map((name) => [name, vi.fn()])),
			uiServices: { settingsManager: { getShowTerminalProgress: () => false } },
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
		});
		mode.updateSubagentSummary(child("old"));
		mode.stop();
		expect(mode.isInitialized).toBe(false);
		expect(mode.subagentSummaryRefresh).toBeUndefined();
		vi.runAllTimers();
		expect(setSubagentCounts).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("removes a cyclic child subtree and retains unrelated children", () => {
		const { mode, setSubagentCounts } = createHarness();
		const root = child("root", { parentId: "grandchild" });
		mode.seedSubagentSummary([
			root,
			child("child", { parentId: "root" }),
			child("grandchild", { parentId: "child" }),
			child("unrelated"),
		]);
		setSubagentCounts.mockClear();
		mode.updateSubagentSummary({ ...root, status: "cancelled" });
		expect([...mode.subagentSnapshots.keys()]).toEqual(["unrelated"]);
		vi.runAllTimers();
		expect(setSubagentCounts).toHaveBeenCalledExactlyOnceWith({ total: 1, running: 0, idle: 0, inactive: 1 });
	});
});

describe("InteractiveMode roster refresh scheduling", () => {
	it("coalesces roster-only callbacks without heartbeat or loader refreshes", async () => {
		const harness = await createRosterHarness();
		for (let index = 0; index < 100; index++) {
			harness.emitRoster();
			await Promise.resolve();
		}
		expect(harness.summaries).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(harness.summaries).toHaveBeenCalledOnce();
		expect(harness.setSubagentCounts).toHaveBeenCalledExactlyOnceWith({
			total: 1,
			running: 0,
			idle: 0,
			inactive: 1,
		});
		expect(harness.requestRender).toHaveBeenCalledOnce();
		for (const refresh of [harness.heartbeat, harness.pulse, harness.loader, harness.loaderMessage]) {
			expect(refresh).not.toHaveBeenCalled();
		}
	});

	it.each(["child-first", "roster-first"])("fully refreshes mixed callbacks once when %s", async (order) => {
		const harness = await createRosterHarness();
		const updateChild = () => harness.mode.updateSubagentSummary(child("worker", { status: "running" }));
		if (order === "child-first") {
			updateChild();
			harness.emitRoster();
		} else {
			harness.emitRoster();
			updateChild();
		}
		vi.runAllTimers();
		expect(harness.summaries).toHaveBeenCalledOnce();
		expect(harness.setSubagentCounts).toHaveBeenCalledOnce();
		expect(harness.requestRender).toHaveBeenCalledOnce();
		for (const refresh of [harness.heartbeat, harness.pulse, harness.loader, harness.loaderMessage]) {
			expect(refresh).toHaveBeenCalledOnce();
		}
	});

	it("reports a child-triggered projection failure and permits a later refresh", async () => {
		const harness = await createRosterHarness();
		harness.summaries.mockImplementationOnce(() => {
			throw new Error("child projection failed");
		});
		harness.mode.updateSubagentSummary(child("worker"));
		expect(() => vi.runAllTimers()).not.toThrow();
		expect(harness.showError).toHaveBeenCalledExactlyOnceWith("child projection failed");
		expect(harness.setSubagentCounts).not.toHaveBeenCalled();
		harness.mode.updateSubagentSummary(child("worker", { label: "retry" }));
		vi.runAllTimers();
		expect(harness.setSubagentCounts).toHaveBeenCalledOnce();
	});

	it("isolates a roster-only projection failure without reporting or escaping", async () => {
		const harness = await createRosterHarness();
		harness.summaries.mockImplementationOnce(() => {
			throw new Error("roster projection failed");
		});
		harness.emitRoster();
		expect(() => vi.runAllTimers()).not.toThrow();
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.requestRender).not.toHaveBeenCalled();
		harness.emitRoster();
		vi.runAllTimers();
		expect(harness.setSubagentCounts).toHaveBeenCalledOnce();
		for (const refresh of [harness.heartbeat, harness.pulse, harness.loader, harness.loaderMessage]) {
			expect(refresh).not.toHaveBeenCalled();
		}
	});

	it("reset clears child activity dirtiness before a later roster callback", async () => {
		const harness = await createRosterHarness();
		harness.mode.updateSubagentSummary(child("old", { status: "running" }));
		harness.mode.resetSubagentSummary();
		for (const refresh of [harness.heartbeat, harness.pulse, harness.loader, harness.loaderMessage]) {
			refresh.mockClear();
		}
		harness.setSubagentCounts.mockClear();
		harness.requestRender.mockClear();
		harness.summaries.mockClear();
		harness.emitRoster();
		vi.runAllTimers();
		expect(harness.setSubagentCounts).toHaveBeenCalledOnce();
		expect(harness.summaries).toHaveBeenCalledOnce();
		expect(harness.requestRender).toHaveBeenCalledOnce();
		for (const refresh of [harness.heartbeat, harness.pulse, harness.loader, harness.loaderMessage]) {
			expect(refresh).not.toHaveBeenCalled();
		}
	});
});
