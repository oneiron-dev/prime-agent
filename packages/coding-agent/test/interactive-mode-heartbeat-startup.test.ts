import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionHeartbeat,
} from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface HeartbeatHarness {
	isInitialized: boolean;
	heartbeatCatalog: AgentConnectionHeartbeat[];
	heartbeatRefreshPromise?: Promise<void>;
	refreshHeartbeatCatalog(): Promise<void>;
	refreshHeartbeatCatalogInBackground(): void;
	subscribeToAgent(): void;
	rebindCurrentSession(): Promise<void>;
	stop(): void;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function heartbeat(id: string): AgentConnectionHeartbeat {
	return {
		job: {
			id,
			status: "active",
			source: "heartbeat",
			activeSessionId: "active-session",
			sessionId: "session",
			sessionFile: "/tmp/heartbeat-startup/session.jsonl",
			cwd: "/tmp/heartbeat-startup",
			prompt: "check for follow-up work",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: "2026-09-05T00:00:00.000Z",
			updatedAt: "2026-09-05T00:00:00.000Z",
			nextRunAt: "2026-09-05T00:05:00.000Z",
			runCount: 0,
		},
	};
}

function createHarness() {
	let listener: AgentConnectionEventListener | undefined;
	const listHeartbeats = vi.fn<() => Promise<AgentConnectionHeartbeat[]>>();
	const showError = vi.fn();
	const showStatus = vi.fn();
	const requestRender = vi.fn();
	const scheduleHeartbeatManagerRefresh = vi.fn();
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
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		heartbeatCatalog: [heartbeat("retained")],
		heartbeatRefreshRequested: false,
		heartbeatRefreshEpoch: {},
		heartbeatRetryAttempt: 0,
		heartbeatCatalogWaiting: false,
		agentConnection: {
			listHeartbeats,
			subscribe: (callback: AgentConnectionEventListener) => {
				listener = callback;
				return vi.fn();
			},
			getState: async () => ({ sessionActions: { queuedCount: 0, steering: [], followUps: [] } }),
		},
		showError,
		showStatus,
		scheduleHeartbeatManagerRefresh,
		updateSubagentSummaryLine: vi.fn(),
		ui: { requestRender, stop: vi.fn() },
		...Object.fromEntries(cleanupNames.map((name) => [name, vi.fn()])),
		uiServices: { settingsManager: { getShowTerminalProgress: () => false } },
		footer: { dispose: vi.fn() },
		footerDataProvider: { dispose: vi.fn() },
		toolDefinitionCache: new Map(),
		applyRuntimeSettings: vi.fn(),
		bindLocalSessionExtensions: true,
		bindCurrentSessionExtensions: vi.fn(async () => {}),
		subscribeToRosterBar: vi.fn(async () => {}),
		patchConnectionState: vi.fn(),
		refreshQueueSelectionFromState: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateAvailableProviderCount: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		updateTerminalTitle: vi.fn(),
		setGoalAnnouncementBaseline: vi.fn(),
		getGoalState: vi.fn(() => ({})),
		syncGoalTray: vi.fn(),
		syncWorkingLoader: vi.fn(),
	}) as HeartbeatHarness;
	mode.subscribeToAgent();
	return {
		mode,
		listHeartbeats,
		showError,
		showStatus,
		requestRender,
		scheduleHeartbeatManagerRefresh,
		emit: async (event: AgentConnectionEvent = { type: "heartbeats_changed" }) => {
			if (!listener) throw new Error("Agent listener was not subscribed");
			await listener(event);
		},
	};
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("InteractiveMode background heartbeat startup", () => {
	it("shares a burst request and makes one follow-up fetch for changes received in flight", async () => {
		const harness = createHarness();
		const first = deferred<AgentConnectionHeartbeat[]>();
		harness.listHeartbeats.mockReturnValueOnce(first.promise).mockResolvedValue([heartbeat("latest")]);
		await harness.emit({ type: "connection_status", status: "connected" });
		for (let index = 0; index < 100; index++) await harness.emit();
		expect(harness.listHeartbeats).toHaveBeenCalledOnce();
		first.resolve([heartbeat("first")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.listHeartbeats).toHaveBeenCalledTimes(2);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("latest")]);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("refreshes an event arriving after the raw request settles but before background ownership clears", async () => {
		const harness = createHarness();
		const first = deferred<AgentConnectionHeartbeat[]>();
		harness.listHeartbeats.mockReturnValueOnce(first.promise).mockResolvedValue([heartbeat("latest")]);
		await harness.emit();
		const rawRefresh = harness.mode.heartbeatRefreshPromise;
		if (!rawRefresh) throw new Error("Heartbeat refresh did not start");
		const changeAtCompletion = rawRefresh.then(() => harness.emit());
		first.resolve([heartbeat("first")]);
		await changeAtCompletion;
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.listHeartbeats).toHaveBeenCalledTimes(2);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("latest")]);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("retains the catalog during exact worker transients and bounds retries even under event bursts", async () => {
		const harness = createHarness();
		const statuses = ["starting", "recovering", "disconnected"];
		let attempts = 0;
		harness.listHeartbeats.mockImplementation(async () => {
			throw new Error(`Cannot list heartbeats while session worker is ${statuses[attempts++ % statuses.length]}`);
		});
		await harness.emit();
		await vi.advanceTimersByTimeAsync(0);
		for (const [index, delay] of [1000, 2000, 4000, 8000, 15000].entries()) {
			for (let event = 0; event < 20; event++) await harness.emit();
			expect(harness.listHeartbeats).toHaveBeenCalledTimes(index + 1);
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(harness.listHeartbeats).toHaveBeenCalledTimes(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(harness.listHeartbeats).toHaveBeenCalledTimes(index + 2);
			expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("retained")]);
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledExactlyOnceWith("Waiting for session workers to load heartbeats…");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.listHeartbeats).toHaveBeenCalledTimes(6);
		await harness.emit();
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.listHeartbeats).toHaveBeenCalledTimes(7);
		expect(vi.getTimerCount()).toBe(0);
		harness.listHeartbeats.mockResolvedValue([heartbeat("recovered")]);
		await harness.emit();
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("recovered")]);
		expect(harness.showStatus.mock.calls.filter(([message]) => message === "Heartbeats loaded")).toHaveLength(1);
		expect(harness.requestRender).toHaveBeenCalledOnce();
	});

	it("reports one shared unknown failure and does not classify a similar message as transient", async () => {
		const harness = createHarness();
		const first = deferred<AgentConnectionHeartbeat[]>();
		harness.listHeartbeats.mockReturnValue(first.promise);
		for (let index = 0; index < 100; index++) await harness.emit();
		const message = "Cannot list heartbeats while session worker is recovering: catalog corrupted";
		first.reject(new Error(message));
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.listHeartbeats).toHaveBeenCalledOnce();
		expect(harness.showError).toHaveBeenCalledExactlyOnceWith(message);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("retained")]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps explicit catalog refresh failures visible to the caller", async () => {
		const harness = createHarness();
		const error = new Error("Cannot list heartbeats while session worker is starting");
		harness.listHeartbeats.mockRejectedValue(error);
		await expect(harness.mode.refreshHeartbeatCatalog()).rejects.toBe(error);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("retained")]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels a pending retry on stop and ignores later notifications", async () => {
		const harness = createHarness();
		harness.listHeartbeats.mockRejectedValue(new Error("Cannot list heartbeats while session worker is starting"));
		await harness.emit();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
		harness.mode.stop();
		expect(vi.getTimerCount()).toBe(0);
		await harness.emit();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.listHeartbeats).toHaveBeenCalledOnce();
		expect(harness.mode.isInitialized).toBe(false);
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("cancels retries and discards an in-flight catalog when the connection closes", async () => {
		const harness = createHarness();
		const pending = deferred<AgentConnectionHeartbeat[]>();
		harness.listHeartbeats
			.mockRejectedValueOnce(new Error("Cannot list heartbeats while session worker is starting"))
			.mockReturnValue(pending.promise);
		await harness.emit();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
		const explicitRefresh = harness.mode.refreshHeartbeatCatalog();
		await harness.emit({ type: "closed", error: "Session closed" });
		expect(vi.getTimerCount()).toBe(0);
		pending.resolve([heartbeat("closed-session")]);
		await explicitRefresh;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.listHeartbeats).toHaveBeenCalledTimes(2);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("retained")]);
		expect(harness.requestRender).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledExactlyOnceWith("Session closed");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not publish an old in-flight catalog after rebinding the same connection", async () => {
		const harness = createHarness();
		const first = deferred<AgentConnectionHeartbeat[]>();
		harness.listHeartbeats.mockReturnValueOnce(first.promise).mockResolvedValue([heartbeat("new-session")]);
		await harness.emit();
		await harness.mode.rebindCurrentSession();
		expect(harness.listHeartbeats).toHaveBeenCalledTimes(2);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("new-session")]);
		first.resolve([heartbeat("old-session")]);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.mode.heartbeatCatalog).toEqual([heartbeat("new-session")]);
		expect(harness.scheduleHeartbeatManagerRefresh).toHaveBeenCalledOnce();
		expect(harness.showError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not report an old in-flight failure after stop", async () => {
		const harness = createHarness();
		const first = deferred<AgentConnectionHeartbeat[]>();
		harness.listHeartbeats.mockReturnValue(first.promise);
		await harness.emit();
		harness.mode.stop();
		first.reject(new Error("old connection failed"));
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();
		expect(harness.requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
