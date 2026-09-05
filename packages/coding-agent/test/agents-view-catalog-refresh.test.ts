import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSessionListCallbacks,
} from "../src/modes/agent-connection/types.js";
import { AgentsViewMode, type AgentsViewPersistentState } from "../src/modes/agents-view/agents-view-mode.js";
import type { AgentsViewSessionRow } from "../src/modes/agents-view/agents-view-state.js";
import * as heartbeatCatalog from "../src/modes/daemon/heartbeat-catalog.js";
import * as savedCatalog from "../src/modes/daemon/saved-session-catalog.js";

function invoke<T>(view: AgentsViewMode, method: string, ...args: unknown[]): T {
	return Reflect.get(AgentsViewMode.prototype, method).apply(view, args) as T;
}

function field<T>(view: AgentsViewMode, name: string): T {
	return Reflect.get(view, name) as T;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function saved(id: string, cost = 1): AgentConnectionSavedSessionInfo {
	return {
		path: `/tmp/catalog-fixture/${id}.jsonl`,
		id,
		cwd: "/tmp/catalog-fixture",
		name: id,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "fixture",
		allMessagesText: "fixture",
		usage: { inputTokens: 100, outputTokens: 10, cost },
	};
}

function harness(persistentState: AgentsViewPersistentState = {}) {
	const view = Object.create(AgentsViewMode.prototype) as AgentsViewMode;
	const client = { isConnected: true, reconnect: vi.fn(async () => undefined) };
	const ui = { requestRender: vi.fn(), stop: vi.fn() };
	Object.assign(view, {
		options: { config: { cwd: "/tmp/catalog-fixture" } },
		persistentState,
		client,
		ui,
		editor: { getText: () => "" },
		lastListedSummaries: [],
		lastVisibleSummaries: [],
		savedSessions: persistentState.savedSessions ?? [],
		lastSuccessfulSavedSessions: persistentState.lastSuccessfulSavedSessions ?? [],
		heartbeats: [],
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		savedCatalogReady: persistentState.savedCatalogLoaded === true,
		savedCatalogRefreshPending: false,
		savedSearchFetchStarted: false,
		heartbeatRefreshQueued: false,
		heartbeatRetryAttempt: 0,
		scopeKey: persistentState.scopeFrames?.at(-1)?.scope,
		rows: [],
		sessionRows: [],
		selectedIndex: 0,
		expandedSubagentParents: new Set(),
		programShownParents: new Set(),
		inactiveAgentIdentities: new Set(),
		stopped: false,
		daemonShutdownReceived: false,
		statusMessageSticky: false,
		rosterStore: { attach: vi.fn(async () => true), summaries: () => [] },
	});
	return { view, persistentState, client, ui };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("agents view saved catalog", () => {
	it("keeps progressive pinned rows and cost metadata after a failed initial scan", async () => {
		const pending = deferred<AgentConnectionSavedSessionInfo[]>();
		let callbacks: AgentConnectionSessionListCallbacks | undefined;
		vi.spyOn(savedCatalog, "listDaemonSavedSessions").mockImplementation((_client, _context, _scope, next) => {
			callbacks = next;
			return pending.promise;
		});
		const pins = ["wave", "architecture", "cleanup"];
		const { view, persistentState } = harness({ pinnedRootSessionIds: pins, manualOrder: { roots: pins } });
		const refresh = invoke<Promise<boolean>>(view, "refreshSavedSessions", { preserveStatusOnError: true });
		callbacks?.onProgress?.(0, 188);
		callbacks?.onSession?.(saved("wave", 42));
		callbacks?.onSession?.(saved("architecture", 7));
		callbacks?.onProgress?.(73, 188);
		expect(invoke<string>(view, "getAgentCountsText")).toContain("loading saved sessions (73/188)");
		pending.reject(new Error("scan timed out"));
		await expect(refresh).resolves.toBe(false);
		expect(field<AgentConnectionSavedSessionInfo[]>(view, "savedSessions").map((row) => row.id)).toEqual([
			"wave",
			"architecture",
		]);
		expect(
			field<AgentsViewSessionRow[]>(view, "sessionRows")
				.filter((row) => row.kind === "agent")
				.map((row) => [row.displaySection, row.recursiveCost]),
		).toEqual([
			["pinned", 42],
			["pinned", 7],
		]);
		expect(persistentState.pinnedRootSessionIds).toBe(pins);
		expect(persistentState.manualOrder).toEqual({ roots: pins });
		expect(persistentState.savedSessions).toHaveLength(2);
		expect(persistentState.savedCatalogLoaded).not.toBe(true);
		expect(field<boolean>(view, "savedCatalogReady")).toBe(false);
		expect(invoke<string>(view, "getAgentCountsText")).toContain("saved sessions incomplete; retry 1/5 in 1s");
	});

	it("keeps missing scope through failure and drops it only after a successful full scan", async () => {
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce([]);
		const frame = { scope: { sessionId: "not-yet-scanned" } };
		const { view, persistentState } = harness({ scopeFrames: [frame] });
		await invoke(view, "refreshSavedSessions", { preserveStatusOnError: true });
		expect(persistentState.scopeFrames).toEqual([frame]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(list).toHaveBeenCalledTimes(2);
		expect(persistentState.scopeFrames).toEqual([]);
		expect(persistentState.savedCatalogLoaded).toBe(true);
	});

	it("preserves restored selection while searching between a failed scan and a successful retry", async () => {
		const fallback = saved("fallback");
		const target = saved("target");
		vi.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementationOnce(async (_client, _context, _scope, callbacks) => {
				callbacks?.onSession?.(fallback);
				throw new Error("timeout before target was scanned");
			})
			.mockResolvedValueOnce([fallback, target]);
		const selection = { sessionId: target.id };
		const { view, persistentState } = harness({ selectedSessionKey: selection });
		await invoke(view, "refreshSavedSessions", { preserveStatusOnError: true });
		Reflect.set(view, "editor", { getText: () => "fixture" });
		invoke(view, "queryChanged");
		expect(persistentState.selectedSessionKey).toEqual(selection);
		await vi.advanceTimersByTimeAsync(1000);
		expect(invoke<AgentsViewSessionRow>(view, "getSelectedSessionRow").sessionId).toBe(target.id);
		expect(persistentState.selectedSessionKey?.sessionId).toBe(target.id);
		expect(field<boolean>(view, "selectionAnchorPending")).toBe(false);
	});

	it("retains partial rows across retries while a complete scan remains authoritative", async () => {
		const old = saved("old", 11);
		const first = saved("first", 12);
		const second = saved("second", 13);
		vi.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementationOnce(async (_client, _context, _scope, callbacks) => {
				callbacks?.onSession?.(first);
				throw new Error("first timeout");
			})
			.mockImplementationOnce(async (_client, _context, _scope, callbacks) => {
				callbacks?.onSession?.(second);
				callbacks?.onSession?.({ ...first, name: "renamed", usage: undefined });
				throw new Error("second timeout");
			})
			.mockResolvedValueOnce([second]);
		const { view, persistentState } = harness({
			savedSessions: [old],
			lastSuccessfulSavedSessions: [old],
			savedCatalogLoaded: true,
		});
		await invoke(view, "refreshSavedSessions", { preserveStatusOnError: true });
		await vi.advanceTimersByTimeAsync(1000);
		expect(persistentState.savedSessions?.map((row) => row.id)).toEqual(["old", "first", "second"]);
		expect(persistentState.savedSessions?.[1]).toMatchObject({ name: "renamed", usage: { cost: 12 } });
		expect(persistentState.lastSuccessfulSavedSessions).toEqual([old]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(persistentState.savedSessions).toEqual([second]);
		expect(persistentState.lastSuccessfulSavedSessions).toEqual([second]);
		expect(invoke<string>(view, "getAgentCountsText")).not.toContain("loading");
	});

	it("bounds automatic retries and permits a later search retry", async () => {
		const list = vi.spyOn(savedCatalog, "listDaemonSavedSessions").mockRejectedValue(new Error("timeout"));
		const { view } = harness();
		invoke(view, "armSavedSearchFetch");
		await vi.advanceTimersByTimeAsync(0);
		invoke(view, "armSavedSearchFetch");
		expect(list).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60000);
		expect(list).toHaveBeenCalledTimes(6);
		expect(invoke<string>(view, "getAgentCountsText")).toContain("incomplete; search to retry");
		invoke(view, "armSavedSearchFetch");
		expect(list).toHaveBeenCalledTimes(7);
	});

	it("ignores old progress and results after an explicit superseding refresh", async () => {
		const pending = deferred<AgentConnectionSavedSessionInfo[]>();
		let callbacks: AgentConnectionSessionListCallbacks | undefined;
		vi.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementationOnce((_client, _context, _scope, next) => {
				callbacks = next;
				return pending.promise;
			})
			.mockResolvedValueOnce([saved("current")]);
		const { view, persistentState } = harness();
		const older = invoke<Promise<boolean>>(view, "refreshSavedSessions");
		await invoke(view, "refreshSavedSessions");
		callbacks?.onSession?.(saved("stale"));
		callbacks?.onProgress?.(10, 20);
		pending.reject(new Error("old timeout"));
		await expect(older).resolves.toBe(false);
		expect(persistentState.savedSessions?.map((row) => row.id)).toEqual(["current"]);
		expect(field(view, "savedCatalogRetryTimer")).toBeUndefined();
	});

	it.each(["finish", "handleDaemonShutdown", "startClientReconnect"])(
		"cancels an armed saved retry at %s",
		async (boundary) => {
			const list = vi.spyOn(savedCatalog, "listDaemonSavedSessions").mockRejectedValue(new Error("timeout"));
			const { view, client } = harness();
			await invoke(view, "refreshSavedSessions", { preserveStatusOnError: true });
			expect(field(view, "savedCatalogRetryTimer")).toBeDefined();
			Reflect.set(
				view,
				"reconnectClient",
				vi.fn(() => new Promise<void>(() => {})),
			);
			if (boundary === "finish") invoke(view, boundary, { type: "exit" });
			else invoke(view, boundary, client, new Error("closed"));
			await vi.advanceTimersByTimeAsync(60000);
			expect(list).toHaveBeenCalledTimes(1);
			expect(field(view, "savedCatalogRetryTimer")).toBeUndefined();
		},
	);

	it.each(["finish", "handleDaemonShutdown", "startClientReconnect"])(
		"cancels retries and stale progress at %s",
		async (boundary) => {
			const pending = deferred<AgentConnectionSavedSessionInfo[]>();
			let callbacks: AgentConnectionSessionListCallbacks | undefined;
			const list = vi
				.spyOn(savedCatalog, "listDaemonSavedSessions")
				.mockRejectedValueOnce(new Error("timeout"))
				.mockImplementationOnce((_client, _context, _scope, next) => {
					callbacks = next;
					return pending.promise;
				});
			const { view, client, persistentState } = harness();
			await invoke(view, "refreshSavedSessions", { preserveStatusOnError: true });
			const refresh = invoke<Promise<boolean>>(view, "refreshSavedSessions");
			Reflect.set(
				view,
				"reconnectClient",
				vi.fn(() => new Promise<void>(() => {})),
			);
			if (boundary === "finish") invoke(view, boundary, { type: "exit" });
			else invoke(view, boundary, client, new Error("closed"));
			callbacks?.onSession?.(saved("stale"));
			pending.resolve([saved("stale")]);
			await expect(refresh).resolves.toBe(false);
			await vi.advanceTimersByTimeAsync(60000);
			expect(list).toHaveBeenCalledTimes(2);
			expect(persistentState.savedSessions).toEqual([]);
			expect(field(view, "savedCatalogRetryTimer")).toBeUndefined();
		},
	);
});

describe("agents view heartbeat catalog", () => {
	it("coalesces an event burst into one request plus one trailing refresh", async () => {
		const pending = deferred<[]>();
		const list = vi
			.spyOn(heartbeatCatalog, "listDaemonHeartbeats")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue([]);
		const { view } = harness();
		const first = invoke<Promise<boolean>>(view, "refreshHeartbeats");
		for (let i = 0; i < 100; i++) void invoke(view, "refreshHeartbeats");
		await vi.advanceTimersByTimeAsync(0);
		expect(list).toHaveBeenCalledTimes(1);
		pending.resolve([]);
		await first;
		await vi.advanceTimersByTimeAsync(0);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("does not replay a burst after an unknown failure", async () => {
		const pending = deferred<[]>();
		const list = vi.spyOn(heartbeatCatalog, "listDaemonHeartbeats").mockReturnValue(pending.promise);
		const { view } = harness();
		const first = invoke<Promise<boolean>>(view, "refreshHeartbeats");
		for (let i = 0; i < 100; i++) void invoke(view, "refreshHeartbeats");
		pending.reject(new Error("malformed catalog"));
		await expect(first).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(60000);
		expect(list).toHaveBeenCalledTimes(1);
		expect(field(view, "heartbeatRefreshQueued")).toBe(false);
	});

	it("retains the previous catalog and bounds quiet retries for a recovering worker", async () => {
		const list = vi
			.spyOn(heartbeatCatalog, "listDaemonHeartbeats")
			.mockRejectedValue(new Error("Cannot list heartbeats while session worker is recovering"));
		const { view } = harness();
		const previous: [] = [];
		Reflect.set(view, "heartbeats", previous);
		const status = vi.spyOn(view as unknown as { setStatusMessage: (message: string) => void }, "setStatusMessage");
		await invoke(view, "refreshHeartbeats");
		for (let i = 0; i < 100; i++) void invoke(view, "refreshHeartbeats");
		await vi.advanceTimersByTimeAsync(60000);
		expect(list).toHaveBeenCalledTimes(6);
		expect(field(view, "heartbeats")).toBe(previous);
		expect(invoke<string>(view, "getAgentCountsText")).toContain("heartbeats temporarily unavailable");
		expect(status).not.toHaveBeenCalled();
		expect(field(view, "heartbeatRetryTimer")).toBeUndefined();
	});

	it("ignores a heartbeat result from before reconnect without disturbing the replacement refresh", async () => {
		const old = deferred<[]>();
		const current = deferred<[]>();
		const list = vi
			.spyOn(heartbeatCatalog, "listDaemonHeartbeats")
			.mockReturnValueOnce(old.promise)
			.mockReturnValueOnce(current.promise);
		const { view, client, persistentState } = harness();
		const first = invoke<Promise<boolean>>(view, "refreshHeartbeats");
		await vi.advanceTimersByTimeAsync(0);
		Reflect.set(
			view,
			"reconnectClient",
			vi.fn(async () => undefined),
		);
		invoke(view, "startClientReconnect", client, new Error("closed"));
		await vi.advanceTimersByTimeAsync(0);
		const replacement = invoke<Promise<boolean>>(view, "refreshHeartbeats");
		await vi.advanceTimersByTimeAsync(0);
		old.reject(new Error("Cannot list heartbeats while session worker is recovering"));
		await expect(first).resolves.toBe(false);
		expect(field(view, "heartbeatRefreshPromise")).toBeDefined();
		expect(field(view, "heartbeatRetryTimer")).toBeUndefined();
		const expected: [] = [];
		current.resolve(expected);
		await expect(replacement).resolves.toBe(true);
		expect(list).toHaveBeenCalledTimes(2);
		expect(persistentState.heartbeats).toBe(expected);
	});

	it("does not start a deferred heartbeat request after finish", async () => {
		const list = vi.spyOn(heartbeatCatalog, "listDaemonHeartbeats").mockResolvedValue([]);
		const { view } = harness();
		const refresh = invoke<Promise<boolean>>(view, "refreshHeartbeats");
		invoke(view, "finish", { type: "exit" });
		await expect(refresh).resolves.toBe(false);
		expect(list).not.toHaveBeenCalled();
	});

	it("shows unknown errors and does not automatically retry them", async () => {
		const list = vi.spyOn(heartbeatCatalog, "listDaemonHeartbeats").mockRejectedValue(new Error("malformed catalog"));
		const { view } = harness();
		await invoke(view, "refreshHeartbeats");
		expect(field<string>(view, "statusMessage")).toContain("Failed to refresh heartbeats: malformed catalog");
		await vi.advanceTimersByTimeAsync(60000);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("completes roster reconnect when the optional heartbeat worker is recovering", async () => {
		const list = vi
			.spyOn(heartbeatCatalog, "listDaemonHeartbeats")
			.mockRejectedValueOnce(new Error("Cannot list heartbeats while session worker is recovering"))
			.mockResolvedValue([]);
		const { view, client, persistentState } = harness({ savedCatalogLoaded: true });
		await invoke(view, "reconnectClient", client, new Error("closed"));
		expect(client.reconnect).toHaveBeenCalledTimes(1);
		expect(persistentState.lastSuccessfulLiveSummaries).toEqual([]);
		expect(field(view, "statusMessage")).toBe("Daemon reconnected");
		await vi.advanceTimersByTimeAsync(1000);
		expect(list).toHaveBeenCalledTimes(2);
	});

	it.each(["finish", "handleDaemonShutdown", "startClientReconnect"])(
		"cancels a heartbeat retry at %s",
		async (boundary) => {
			const list = vi
				.spyOn(heartbeatCatalog, "listDaemonHeartbeats")
				.mockRejectedValue(new Error("Cannot list heartbeats while session worker is starting"));
			const { view, client } = harness();
			await invoke(view, "refreshHeartbeats");
			Reflect.set(
				view,
				"reconnectClient",
				vi.fn(() => new Promise<void>(() => {})),
			);
			if (boundary === "finish") invoke(view, boundary, { type: "exit" });
			else invoke(view, boundary, client, new Error("closed"));
			await vi.advanceTimersByTimeAsync(60000);
			expect(list).toHaveBeenCalledTimes(1);
			expect(field(view, "heartbeatRetryTimer")).toBeUndefined();
		},
	);
});
