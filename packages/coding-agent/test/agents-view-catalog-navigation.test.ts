import { ProcessTerminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSessionListCallbacks,
} from "../src/modes/agent-connection/types.js";
import { AgentsViewMode, type AgentsViewPersistentState } from "../src/modes/agents-view/agents-view-mode.js";
import * as savedCatalog from "../src/modes/daemon/saved-session-catalog.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

vi.mock("../src/utils/tools-manager.js", () => ({ ensureTool: vi.fn(async () => undefined) }));

const cwd = "/tmp/catalog-navigation-fixture";
const views: AgentsViewMode[] = [];
const states: AgentsViewPersistentState[] = [];

function invoke<T>(view: AgentsViewMode, method: string, ...args: unknown[]): T {
	return Reflect.get(AgentsViewMode.prototype, method).apply(view, args) as T;
}

function field<T>(view: AgentsViewMode, name: string): T {
	return Reflect.get(view, name) as T;
}

function saved(id: string, cost = 1): AgentConnectionSavedSessionInfo {
	return {
		path: `${cwd}/${id}.jsonl`,
		id,
		cwd,
		name: id,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "fixture",
		allMessagesText: "fixture",
		usage: { inputTokens: 100, outputTokens: 10, cost },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function client() {
	return { isConnected: true, reconnect: vi.fn(async () => undefined) };
}

function view(state: AgentsViewPersistentState, transport: ReturnType<typeof client>): AgentsViewMode {
	const result = new AgentsViewMode(
		{
			config: { cwd },
			uiServices: {
				settingsManager: SettingsManager.inMemory({ theme: "dark" }),
				modelRegistry: {} as ModelRegistry,
				getInitialCwd: () => cwd,
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		},
		state,
	);
	// Keep the real view state/constructor and methods; only terminal effects and transport are inert.
	Reflect.set(result, "client", transport);
	Reflect.set(result, "ui", { requestRender: vi.fn(), stop: vi.fn() });
	views.push(result);
	states.push(state);
	return result;
}

function leave(current: AgentsViewMode): void {
	invoke(current, "finish", { type: "open" });
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(ProcessTerminal.prototype, "setTitle").mockImplementation(() => undefined);
	vi.spyOn(KeybindingsManager, "create").mockImplementation(() => new KeybindingsManager());
});

afterEach(() => {
	for (const current of views.splice(0)) invoke(current, "finish", { type: "exit" });
	for (const state of states.splice(0)) state.savedCatalogRequest?.dispose();
	stopThemeWatcher();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("saved catalog ownership across Agents view navigation", () => {
	it("joins a scan across global to scoped navigation and reuses its completed result", async () => {
		const pending = deferred<AgentConnectionSavedSessionInfo[]>();
		let stream: AgentConnectionSessionListCallbacks | undefined;
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementation((_client, _context, _scope, callbacks) => {
				stream = callbacks;
				return pending.promise;
			});
		const root = saved("wave", 42);
		const child = { ...saved("worker", 7), parentSessionPath: root.path, rlmDepth: 1 };
		const state: AgentsViewPersistentState = { pinnedRootSessionIds: [root.id] };
		const transport = client();
		const first = view(state, transport);
		const firstRefresh = invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		stream?.onSession?.(root);
		stream?.onProgress?.(1, 103);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.savedSessions?.map((row) => row.id)).toEqual([root.id]);
		leave(first);
		state.scopeFrames = [{ scope: { sessionId: root.id } }];
		const second = view(state, transport);
		invoke(second, "armSavedSearchFetch");
		expect(list).toHaveBeenCalledTimes(1);
		stream?.onSession?.(child);
		stream?.onProgress?.(2, 103);
		await vi.advanceTimersByTimeAsync(0);
		expect(field<AgentConnectionSavedSessionInfo[]>(second, "savedSessions").map((row) => row.id)).toEqual([
			root.id,
			child.id,
		]);
		expect(field<string>(second, "savedCatalogStatus")).toContain("2/103");
		pending.resolve([root, child]);
		await expect(firstRefresh).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.savedCatalogLoaded).toBe(true);
		expect(field<boolean>(second, "savedCatalogReady")).toBe(true);
		expect(state.savedCatalogRequest).toBeUndefined();
		leave(second);
		state.scopeFrames = [];
		const third = view(state, transport);
		invoke(third, "armSavedSearchFetch");
		expect(list).toHaveBeenCalledTimes(1);
		expect(field<AgentConnectionSavedSessionInfo[]>(third, "savedSessions")).toEqual([root, child]);
	});

	it("rehydrates completion received while the successor awaits roster attachment", async () => {
		const pending = deferred<AgentConnectionSavedSessionInfo[]>();
		const attachStarted = deferred<void>();
		const attachDone = deferred<boolean>();
		const list = vi.spyOn(savedCatalog, "listDaemonSavedSessions").mockReturnValue(pending.promise);
		const state: AgentsViewPersistentState = {};
		const transport = { ...client(), onClose: vi.fn(() => () => {}), onMessage: vi.fn(() => () => {}) };
		const first = view(state, transport);
		const refresh = invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		leave(first);
		const second = view(state, transport);
		Reflect.set(state, "rosterClient", transport);
		Reflect.set(state, "rosterStore", {
			attach: vi.fn(() => {
				attachStarted.resolve();
				return attachDone.promise;
			}),
			summaries: () => [],
			onUpdate: () => () => {},
		});
		Reflect.set(second, "ui", {
			requestRender: vi.fn(),
			stop: vi.fn(),
			addChild: vi.fn(),
			setFocus: vi.fn(),
			start: vi.fn(),
			enterFullscreen: vi.fn(),
			invalidate: vi.fn(),
		});
		Reflect.set(
			second,
			"loadAgentsViewState",
			vi.fn(() => true),
		);
		Reflect.set(second, "loadStartupNotices", vi.fn());
		Reflect.set(
			second,
			"refreshHeartbeats",
			vi.fn(async () => true),
		);
		const running = second.run();
		await attachStarted.promise;
		const complete = [saved("wave", 42), saved("worker", 7)];
		pending.resolve(complete);
		await expect(refresh).resolves.toBe(false);
		expect(state.savedCatalogLoaded).toBe(true);
		attachDone.resolve(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(field<AgentConnectionSavedSessionInfo[]>(second, "savedSessions")).toEqual(complete);
		expect(field<boolean>(second, "savedCatalogReady")).toBe(true);
		expect(list).toHaveBeenCalledTimes(1);
		invoke(second, "finish", { type: "exit" });
		await expect(running).resolves.toEqual({ type: "exit" });
	});

	it("refreshes a completed catalog when the same client disconnected during chat", async () => {
		const before = saved("before reconnect");
		const after = saved("after reconnect");
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockResolvedValueOnce([before])
			.mockResolvedValueOnce([before, after]);
		const state: AgentsViewPersistentState = {};
		const transport = { ...client(), onClose: vi.fn(() => () => {}), onMessage: vi.fn(() => () => {}) };
		transport.reconnect.mockImplementation(async () => {
			transport.isConnected = true;
		});
		const first = view(state, transport);
		await invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		expect(state.savedCatalogLoaded).toBe(true);
		leave(first);
		transport.isConnected = false;
		const second = view(state, transport);
		Reflect.set(state, "rosterClient", transport);
		Reflect.set(state, "rosterStore", {
			attach: vi.fn(async () => true),
			summaries: () => [],
			onUpdate: () => () => {},
		});
		Reflect.set(second, "ui", {
			requestRender: vi.fn(),
			stop: vi.fn(),
			addChild: vi.fn(),
			setFocus: vi.fn(),
			start: vi.fn(),
			enterFullscreen: vi.fn(),
			invalidate: vi.fn(),
		});
		Reflect.set(
			second,
			"loadAgentsViewState",
			vi.fn(() => true),
		);
		Reflect.set(second, "loadStartupNotices", vi.fn());
		Reflect.set(
			second,
			"refreshHeartbeats",
			vi.fn(async () => true),
		);
		const running = second.run();
		await vi.advanceTimersByTimeAsync(0);
		expect(transport.reconnect).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledTimes(2);
		expect(state.savedSessions).toEqual([before, after]);
		expect(field<AgentConnectionSavedSessionInfo[]>(second, "savedSessions")).toEqual([before, after]);
		expect(state.savedCatalogLoaded).toBe(true);
		invoke(second, "finish", { type: "exit" });
		await expect(running).resolves.toEqual({ type: "exit" });
	});

	it("finishes while chat is open and preserves usage through metadata-only replay", async () => {
		const pending = deferred<AgentConnectionSavedSessionInfo[]>();
		let stream: AgentConnectionSessionListCallbacks | undefined;
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementation((_client, _context, _scope, callbacks) => {
				stream = callbacks;
				return pending.promise;
			});
		const state: AgentsViewPersistentState = {};
		const transport = client();
		const first = view(state, transport);
		const refresh = invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		stream?.onSession?.(saved("wave", 42));
		leave(first);
		stream?.onSession?.({ ...saved("wave"), name: "renamed", usage: undefined });
		const second = view(state, transport);
		invoke(second, "armSavedSearchFetch");
		await vi.advanceTimersByTimeAsync(0);
		expect(field<AgentConnectionSavedSessionInfo[]>(second, "savedSessions")[0]).toMatchObject({
			name: "renamed",
			usage: { cost: 42 },
		});
		leave(second);
		const final = { ...saved("wave", 42), name: "renamed" };
		pending.resolve([final]);
		await expect(refresh).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.savedCatalogLoaded).toBe(true);
		const third = view(state, transport);
		invoke(third, "armSavedSearchFetch");
		expect(list).toHaveBeenCalledTimes(1);
		expect(state.savedSessions).toEqual([final]);
	});

	it("replaces an in-flight scan for a fresh client and ignores the old producer", async () => {
		const old = deferred<AgentConnectionSavedSessionInfo[]>();
		const current = deferred<AgentConnectionSavedSessionInfo[]>();
		let oldStream: AgentConnectionSessionListCallbacks | undefined;
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementationOnce((_client, _context, _scope, callbacks) => {
				oldStream = callbacks;
				return old.promise;
			})
			.mockReturnValueOnce(current.promise);
		const state: AgentsViewPersistentState = {};
		const first = view(state, client());
		const firstRefresh = invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		leave(first);
		const second = view(state, client());
		const replacement = invoke<Promise<boolean>>(second, "refreshSavedSessions", { reuseInFlight: true });
		expect(list).toHaveBeenCalledTimes(2);
		oldStream?.onSession?.(saved("stale"));
		old.resolve([saved("stale")]);
		await expect(firstRefresh).resolves.toBe(false);
		expect(state.savedCatalogLoaded).not.toBe(true);
		expect(state.savedSessions?.some((row) => row.id === "stale")).not.toBe(true);
		current.resolve([saved("current")]);
		await expect(replacement).resolves.toBe(true);
		expect(state.savedSessions?.map((row) => row.id)).toEqual(["current"]);
	});

	it("retains a partial shared failure and starts exactly one retry in its successor", async () => {
		const pending = deferred<AgentConnectionSavedSessionInfo[]>();
		let stream: AgentConnectionSessionListCallbacks | undefined;
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementationOnce((_client, _context, _scope, callbacks) => {
				stream = callbacks;
				return pending.promise;
			})
			.mockResolvedValueOnce([saved("wave", 42), saved("later")]);
		const state: AgentsViewPersistentState = {};
		const transport = client();
		const first = view(state, transport);
		const firstRefresh = invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		leave(first);
		stream?.onSession?.(saved("wave", 42));
		const second = view(state, transport);
		invoke(second, "armSavedSearchFetch");
		expect(list).toHaveBeenCalledTimes(1);
		pending.reject(new Error("incomplete catalog"));
		await expect(firstRefresh).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.savedSessions?.[0]).toMatchObject({ id: "wave", usage: { cost: 42 } });
		expect(state.savedCatalogLoaded).not.toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(list).toHaveBeenCalledTimes(2);
		expect(state.savedCatalogLoaded).toBe(true);
		expect(state.savedSessions?.map((row) => row.id)).toEqual(["wave", "later"]);
	});

	it("explicit mutation refresh supersedes the shared request without stale overwrites", async () => {
		const old = deferred<AgentConnectionSavedSessionInfo[]>();
		let stream: AgentConnectionSessionListCallbacks | undefined;
		const list = vi
			.spyOn(savedCatalog, "listDaemonSavedSessions")
			.mockImplementationOnce((_client, _context, _scope, callbacks) => {
				stream = callbacks;
				return old.promise;
			})
			.mockResolvedValueOnce([{ ...saved("wave"), name: "after rename" }]);
		const state: AgentsViewPersistentState = {};
		const transport = client();
		const first = view(state, transport);
		const firstRefresh = invoke<Promise<boolean>>(first, "refreshSavedSessions", { reuseInFlight: true });
		leave(first);
		const second = view(state, transport);
		await invoke<Promise<boolean>>(second, "refreshSavedSessions");
		stream?.onSession?.(saved("stale"));
		old.resolve([saved("stale")]);
		await expect(firstRefresh).resolves.toBe(false);
		expect(list).toHaveBeenCalledTimes(2);
		expect(state.savedSessions).toEqual([{ ...saved("wave"), name: "after rename" }]);
		expect(state.savedCatalogLoaded).toBe(true);
	});
});
