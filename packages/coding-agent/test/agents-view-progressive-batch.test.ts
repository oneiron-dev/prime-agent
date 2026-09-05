import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSessionListCallbacks,
} from "../src/modes/agent-connection/types.js";
import { AgentsViewMode, type AgentsViewPersistentState } from "../src/modes/agents-view/agents-view-mode.js";
import type {
	AgentsViewSessionRow,
	UnifiedSessionRecord,
	UnifiedSessionSearchCache,
} from "../src/modes/agents-view/agents-view-state.js";
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
		path: `/tmp/progressive-batch/${id}.jsonl`,
		id,
		cwd: "/tmp/progressive-batch",
		name: id,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "fixture",
		allMessagesText: "fixture",
		usage: { inputTokens: 100, outputTokens: 10, cost },
	};
}

function harness(persistentState: AgentsViewPersistentState = { savedSessions: [] }) {
	const view = Object.create(AgentsViewMode.prototype) as AgentsViewMode;
	const client = { isConnected: true };
	const ui = { requestRender: vi.fn(), stop: vi.fn() };
	Object.assign(view, {
		options: { config: { cwd: "/tmp/progressive-batch" } },
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
		reconnectClient: vi.fn(() => new Promise<void>(() => {})),
	});
	const reconcile = vi.spyOn(view as unknown as { reconcileCatalogs(): void }, "reconcileCatalogs");
	return { view, persistentState, client, ui, reconcile };
}

function scan() {
	const pending = deferred<AgentConnectionSavedSessionInfo[]>();
	let callbacks: AgentConnectionSessionListCallbacks | undefined;
	const list = vi
		.spyOn(savedCatalog, "listDaemonSavedSessions")
		.mockImplementation((_client, _context, _scope, next) => {
			callbacks = next;
			return pending.promise;
		});
	return {
		pending,
		list,
		session: (session: AgentConnectionSavedSessionInfo) => {
			if (!callbacks?.onSession) throw new Error("Progressive session callback was not installed");
			callbacks.onSession(session);
		},
		progress: (loaded: number, total: number) => {
			if (!callbacks?.onProgress) throw new Error("Progress callback was not installed");
			callbacks.onProgress(loaded, total);
		},
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("agents view progressive catalog publication", () => {
	it("coalesces 100 callbacks into one catalog reconciliation on the next turn", async () => {
		const source = scan();
		const { view, persistentState, reconcile } = harness();
		void invoke(view, "refreshSavedSessions");
		for (let index = 0; index < 100; index++) {
			source.session(saved(`session-${index}`));
			await Promise.resolve();
		}
		expect(reconcile).not.toHaveBeenCalled();
		expect(persistentState.savedSessions).toEqual([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(reconcile).toHaveBeenCalledOnce();
		expect(persistentState.savedSessions).toHaveLength(100);
		expect(field<AgentsViewSessionRow[]>(view, "sessionRows")).toHaveLength(100);
	});

	it("publishes a single session on the next turn while the scan remains pending", async () => {
		const source = scan();
		const { view, persistentState, reconcile } = harness();
		void invoke(view, "refreshSavedSessions");
		source.session(saved("single"));
		expect(persistentState.savedSessions).toEqual([]);
		await vi.advanceTimersByTimeAsync(0);
		expect(persistentState.savedSessions).toEqual([saved("single")]);
		expect(reconcile).toHaveBeenCalledOnce();
		expect(field<boolean>(view, "savedCatalogRefreshPending")).toBe(true);
	});

	it("flushes retained partial metadata on failure before the scheduled publication runs", async () => {
		const source = scan();
		const pins = ["wave", "architecture"];
		const { view, persistentState, reconcile } = harness({
			savedSessions: [],
			pinnedRootSessionIds: pins,
			manualOrder: { roots: pins },
			selectedSessionKey: { sessionId: "wave" },
		});
		const refresh = invoke<Promise<boolean>>(view, "refreshSavedSessions", { preserveStatusOnError: true });
		source.session(saved("wave", 42));
		source.session({ ...saved("wave"), name: "renamed", usage: undefined });
		source.session(saved("architecture", 7));
		source.pending.reject(new Error("scan failed"));
		await expect(refresh).resolves.toBe(false);
		expect(reconcile).toHaveBeenCalledOnce();
		expect(persistentState.savedSessions?.[0]).toMatchObject({ name: "renamed", usage: { cost: 42 } });
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
		expect(persistentState.selectedSessionKey?.sessionId).toBe("wave");
		await vi.advanceTimersByTimeAsync(0);
		expect(reconcile).toHaveBeenCalledOnce();
	});

	it("publishes a successful authoritative result without replaying a queued partial snapshot", async () => {
		const source = scan();
		const { view, persistentState, reconcile } = harness();
		const refresh = invoke<Promise<boolean>>(view, "refreshSavedSessions");
		source.session(saved("partial"));
		source.pending.resolve([saved("authoritative")]);
		await expect(refresh).resolves.toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(reconcile).toHaveBeenCalledOnce();
		expect(persistentState.savedSessions).toEqual([saved("authoritative")]);
		expect(persistentState.lastSuccessfulSavedSessions).toEqual([saved("authoritative")]);
		expect(persistentState.savedCatalogLoaded).toBe(true);
	});

	it("retains verified queued rows at supersession and then accepts the new authoritative scan", async () => {
		const source = scan();
		const replacement = deferred<AgentConnectionSavedSessionInfo[]>();
		const { view, persistentState, reconcile } = harness();
		const oldRefresh = invoke<Promise<boolean>>(view, "refreshSavedSessions");
		source.session(saved("verified"));
		source.list.mockReturnValueOnce(replacement.promise);
		const newRefresh = invoke<Promise<boolean>>(view, "refreshSavedSessions");
		expect(persistentState.savedSessions).toEqual([saved("verified")]);
		expect(reconcile).toHaveBeenCalledOnce();
		source.session(saved("late-old-result"));
		source.pending.resolve([saved("late-old-result")]);
		await expect(oldRefresh).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(persistentState.savedSessions).toEqual([saved("verified")]);
		expect(reconcile).toHaveBeenCalledOnce();
		replacement.resolve([saved("current")]);
		await expect(newRefresh).resolves.toBe(true);
		expect(persistentState.savedSessions).toEqual([saved("current")]);
		expect(reconcile).toHaveBeenCalledTimes(2);
	});

	it.each(["finish", "handleDaemonShutdown", "startClientReconnect"])(
		"discards queued publication into the view at %s",
		async (boundary) => {
			const source = scan();
			const { view, persistentState, client, reconcile, ui } = harness();
			const refresh = invoke<Promise<boolean>>(view, "refreshSavedSessions");
			source.session(saved("stale"));
			if (boundary === "finish") invoke(view, boundary, { type: "exit" });
			else invoke(view, boundary, client, new Error("closed"));
			const reconciliationsAtBoundary = reconcile.mock.calls.length;
			const rendersAtBoundary = ui.requestRender.mock.calls.length;
			await vi.advanceTimersByTimeAsync(0);
			expect(reconcile).toHaveBeenCalledTimes(reconciliationsAtBoundary);
			expect(persistentState.savedSessions).toEqual([]);
			source.pending.resolve([saved("stale")]);
			await expect(refresh).resolves.toBe(false);
			expect(field(view, "savedSessions")).toEqual([]);
			expect(reconcile).toHaveBeenCalledTimes(reconciliationsAtBoundary);
			expect(ui.requestRender).toHaveBeenCalledTimes(rendersAtBoundary);
			expect(persistentState.savedSessions).toEqual(boundary === "finish" ? [saved("stale")] : []);
			expect(persistentState.savedCatalogLoaded).toBe(boundary === "finish" ? true : undefined);
		},
	);

	it("keeps physical file progress separate from the number of session records", async () => {
		const source = scan();
		const { view } = harness();
		void invoke(view, "refreshSavedSessions");
		source.progress(7, 10);
		for (let index = 0; index < 20; index++) source.session(saved(`session-${index}`));
		await vi.advanceTimersByTimeAsync(0);
		const counts = invoke<string>(view, "getAgentCountsText");
		expect(counts).toContain("7/10");
		expect(counts).not.toContain("20/10");
		expect(field<AgentConnectionSavedSessionInfo[]>(view, "savedSessions")).toHaveLength(20);
	});
});

describe("agents view filtered catalog cache", () => {
	it("reuses matches across row rebuilds and navigation, invalidates for a new query, and clears on finish", () => {
		const sessions = [saved("alpha-one"), saved("alpha-two"), saved("beta")];
		const { view } = harness({ savedSessions: sessions, savedCatalogLoaded: true });
		let query = "alpha";
		Reflect.set(view, "editor", { getText: () => query });
		Reflect.set(view, "keybindings", new KeybindingsManager());
		invoke(view, "reconcileCatalogs");
		const first = invoke<UnifiedSessionRecord[]>(view, "getFilteredRecords");
		expect(first.map((record) => record.saved?.id)).toEqual(["alpha-one", "alpha-two"]);
		for (let tick = 0; tick < 3; tick++) {
			vi.setSystemTime(Date.now() + 1000);
			// Age refresh uses this same row-rebuild path without changing the catalog.
			invoke(view, "rebuildRows");
			expect(invoke(view, "getFilteredRecords")).toBe(first);
		}
		const filter = vi.spyOn(
			view as unknown as { getFilteredRecords(): UnifiedSessionRecord[] },
			"getFilteredRecords",
		);
		const selectedIndex = field<number>(view, "selectedIndex");
		expect(invoke(view, "handleListNavigation", "\x1b[B")).toBe(true);
		expect(field<number>(view, "selectedIndex")).not.toBe(selectedIndex);
		expect(filter).not.toHaveBeenCalled();
		filter.mockRestore();
		query = "beta";
		invoke(view, "queryChanged");
		const changed = invoke<UnifiedSessionRecord[]>(view, "getFilteredRecords");
		expect(changed).not.toBe(first);
		expect(changed.map((record) => record.saved?.id)).toEqual(["beta"]);
		const searchCache = field<UnifiedSessionSearchCache>(view, "sessionSearchCache");
		expect(searchCache.size).toBe(3);
		invoke(view, "finish", { type: "exit" });
		expect(searchCache.size).toBe(0);
		expect(field(view, "sessionSearchCache")).toBeUndefined();
		expect(field(view, "filteredRecordsCache")).toBeUndefined();
	});

	it("invalidates a cached query when a streamed catalog batch adds a matching row", async () => {
		const source = scan();
		const { view } = harness({ savedSessions: [saved("needle-one"), saved("unrelated")] });
		Reflect.set(view, "editor", { getText: () => '"needle"' });
		invoke(view, "reconcileCatalogs");
		const previousScope = field<UnifiedSessionRecord[]>(view, "scopedRecords");
		const previousMatches = invoke<UnifiedSessionRecord[]>(view, "getFilteredRecords");
		expect(previousMatches.map((record) => record.saved?.id)).toEqual(["needle-one"]);
		void invoke(view, "refreshSavedSessions");
		source.session(saved("needle-two"));
		expect(invoke(view, "getFilteredRecords")).toBe(previousMatches);
		await vi.advanceTimersByTimeAsync(0);
		const matches = invoke<UnifiedSessionRecord[]>(view, "getFilteredRecords");
		expect(field(view, "scopedRecords")).not.toBe(previousScope);
		expect(matches).not.toBe(previousMatches);
		expect(matches.map((record) => record.saved?.id)).toEqual(["needle-one", "needle-two"]);
		expect(field<AgentsViewSessionRow[]>(view, "sessionRows").map((row) => row.sessionId)).toEqual([
			"needle-one",
			"needle-two",
		]);
	});
});
