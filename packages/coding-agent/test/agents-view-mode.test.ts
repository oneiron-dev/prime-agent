import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsViewStateStore } from "../src/core/agents-view-state-store.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import {
	AgentsViewMode,
	type AgentsViewPersistentState,
	combineAgentsViewStartupNotices,
	createInitialAgentsViewPersistentState,
	runAgentsViewMode,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	resolveAgentsViewLeftResult,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";

const modeMocks = vi.hoisted(() => ({
	interactiveRun: vi.fn<() => Promise<never>>(),
	teardownSessionUi: vi.fn(async () => undefined),
	dispose: vi.fn(async () => undefined),
	connectionPrompt: vi.fn(async () => undefined),
	clientRequest: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.js")>();
	return { ...actual, appendRotatingLog: vi.fn() };
});

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		connect = vi.fn(async () => undefined);
		close = vi.fn();
		request = modeMocks.clientRequest;
	},
	getDaemonSocketCloseReason: vi.fn(),
}));

vi.mock("../src/modes/agent-connection/daemon-agent-connection.js", () => ({
	DaemonAgentConnection: Object.assign(function DaemonAgentConnection() {}, {
		attach: vi.fn(async () => ({ prompt: modeMocks.connectionPrompt, dispose: modeMocks.dispose })),
	}),
}));

vi.mock("../src/modes/interactive/interactive-mode.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/interactive-mode.js")>();
	return {
		...actual,
		InteractiveMode: class {
			run = modeMocks.interactiveRun;
			teardownSessionUi = modeMocks.teardownSessionUi;
		},
	};
});

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "scope-active",
		activeSessionId: "scope-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "scope-session",
		sessionFile: "/tmp/scope.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

const settingsManager = {
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
	getEditorPaddingX: () => 0,
	getAutocompleteMaxVisible: () => 5,
};

describe("AgentsViewMode", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));
	beforeEach(() => vi.clearAllMocks());

	it("keeps the selection chosen by row rebuilding when the query changes", () => {
		const self = {
			editor: { getText: () => "matching query" },
			persistentState: { query: "" },
			selectedIndex: 4,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		invoke("queryChanged", self);

		expect(self.persistentState.query).toBe("matching query");
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.selectedIndex).toBe(4);
	});

	it("wraps normal navigation across selectable pinned and nested rows", () => {
		const self = {
			rows: [
				{ kind: "heading", selectable: false, identity: "pinned-heading" },
				{ kind: "agent", selectable: true, identity: "pinned-agent" },
				{ kind: "heading", selectable: false, identity: "running-heading" },
				{ kind: "agent", selectable: true, identity: "filtered-agent" },
				{ kind: "code", selectable: false, identity: "spawn-code" },
				{ kind: "subagent", selectable: true, identity: "nested-agent" },
			],
			selectedIndex: 5,
			replyTarget: undefined,
			getSelectableRowIndexes() {
				return this.rows.flatMap((row, index) => (row.selectable ? [index] : []));
			},
			syncSelectedRowState: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		invoke("moveSelection", self, 1, { wrap: true });
		expect(self.selectedIndex).toBe(1);

		invoke("moveSelection", self, -1, { wrap: true });
		expect(self.selectedIndex).toBe(5);
		expect(self.syncSelectedRowState).toHaveBeenCalledTimes(2);
		expect(self.clearDeleteConfirmation).toHaveBeenCalledTimes(2);
		expect(self.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	it("re-resolves subagent state before choosing stop or delete intent", async () => {
		const child = summary({
			id: "passive-child-session",
			activeSessionId: undefined,
			sessionId: "passive-child-session",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const request = vi.fn(async (command: { type: string }) => ({
			success: true as const,
			data: command.type === "cancel_rlm_child" ? { cancelled: false } : { deleted: true },
		}));
		const client = { request, supportsServerCapability: vi.fn(() => true) };
		const self = {
			rows: [
				{
					kind: "subagent",
					section: "running",
					summary: child,
					selectable: true,
					identity: "child-row",
					parentIdentity: "root-row",
				},
				{
					kind: "agent",
					section: "idle",
					summary: summary({ id: "root-active", activeSessionId: "root-active", sessionId: "root-session" }),
					selectable: true,
					identity: "root-row",
				},
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			pendingKillSubagent: undefined,
			deleteConfirmExpiresAt: 0,
			deleteConfirmTimer: undefined,
			ui: { requestRender: vi.fn() },
			requireClient: () => client,
			setStatusMessage: vi.fn(),
			applyAgentsViewStateOperation: vi.fn((_operation: unknown) => false),
			removeDeletedSessionPreferences(sessionId: string) {
				return this.applyAgentsViewStateOperation({ type: "removeSession", sessionId });
			},
			refreshSessions: vi.fn(async () => false),
			handleKillSubagentSelected(row: unknown) {
				return invoke("handleKillSubagentSelected", self, row);
			},
			findSubagentRootRow(row: unknown) {
				return invoke("findSubagentRootRow", self, row);
			},
			isDeleteConfirmationVisible() {
				return invoke("isDeleteConfirmationVisible", self);
			},
			showDeleteConfirmation() {
				return invoke("showDeleteConfirmation", self);
			},
			clearDeleteConfirmation(_options: unknown) {
				return invoke("clearDeleteConfirmation", self, _options);
			},
			killSubagent(pending: unknown, row: unknown) {
				return invoke("killSubagent", self, pending, row);
			},
		};

		await invoke("handleDeleteSelected", self);
		expect(request).not.toHaveBeenCalled();

		// The child finishes during confirmation. The second keypress must use the
		// current row state rather than the original running state.
		self.rows[0]!.section = "inactive";
		await invoke("handleDeleteSelected", self);
		expect(request).toHaveBeenCalledWith({
			type: "delete_rlm_subagent",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancel_rlm_child" }));
		expect(self.setStatusMessage).toHaveBeenCalledWith(
			"Subagent deleted; pin/order cleanup did not persist; refresh failed",
			{
				render: false,
			},
		);
		expect(self.applyAgentsViewStateOperation).toHaveBeenCalledWith({
			type: "removeSession",
			sessionId: "passive-child-session",
		});
	});

	it("uses cancel when an inactive subagent starts running during confirmation", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self = {
			applyAgentsViewStateOperation: vi.fn(),
			requireClient: () => ({ request, supportsServerCapability: () => true }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{
				identity: "child-row",
				rootActiveSessionId: "root-active",
				childId: "passive-child",
				sessionId: "child-session",
			},
			{ section: "running", activitySection: "running" },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
		expect(self.applyAgentsViewStateOperation).not.toHaveBeenCalled();
	});

	it("falls back to cancel-only when subagent deletion is unsupported", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: false } }));
		const self = {
			applyAgentsViewStateOperation: vi.fn(),
			requireClient: () => ({ request, supportsServerCapability: () => false }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{
				identity: "child-row",
				rootActiveSessionId: "root-active",
				childId: "passive-child",
				sessionId: "child-session",
			},
			{ section: "inactive" },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(self.setStatusMessage).toHaveBeenCalledWith("The daemon cannot delete subagents; it was left unchanged", {
			render: false,
			tone: "warning",
		});
		expect(self.applyAgentsViewStateOperation).not.toHaveBeenCalled();
	});

	it("checks telemetry policy before replying from an opted-out agents view", async () => {
		const client = { close: vi.fn() };
		const connectDedicatedClient = vi.fn(async () => client);
		const self = {
			options: {
				config: { telemetryDisabled: true },
				recoverDaemon: vi.fn(async () => undefined),
				reconnectTimeoutMs: 1234,
			},
			connectDedicatedClient,
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "followUp");

		expect(connectDedicatedClient).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(client, "active-1", {
			closeClientOnDispose: true,
			supportsExtensionUi: false,
			recoverDaemon: self.options.recoverDaemon,
			reconnectTimeoutMs: 1234,
			telemetryDisabled: true,
		});
		expect(modeMocks.connectionPrompt).toHaveBeenCalledWith("private prompt", {
			streamingBehavior: "followUp",
		});
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
	});

	it("keeps direct agents-view replies when telemetry is enabled", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: undefined }));
		const self = {
			options: { config: {} },
			requireClient: () => ({ request }),
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "steer");

		expect(request).toHaveBeenCalledWith({
			type: "prompt",
			activeSessionId: "active-1",
			message: "private prompt",
			streamingBehavior: "steer",
		});
		expect(DaemonAgentConnection.attach).not.toHaveBeenCalled();
	});

	it("uses the opened session as the crash-path back target", async () => {
		const opened = summary({ sessionName: "opened" });
		const previous = summary({ id: "previous", activeSessionId: "previous", sessionId: "previous" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockResolvedValueOnce({ type: "open", summary: opened })
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.backSession).toMatchObject({ sessionId: opened.sessionId });
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockRejectedValueOnce(new Error("post-attach crash"));

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp", telemetryDisabled: true } as never,
			initialSession: previous,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		expect(modeMocks.teardownSessionUi).toHaveBeenCalledWith({ preserveAltScreen: true });
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(
			expect.anything(),
			opened.activeSessionId,
			expect.objectContaining({ telemetryDisabled: true }),
		);
		runView.mockRestore();
	});

	it("invalidates the persisted scope root after popping a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [
					{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } },
					{ scope: { sessionId: child.sessionId, activeSessionId: child.activeSessionId } },
				];
				state.scopeRootSummary = child;
				return Promise.resolve({
					type: "scope_back",
					selection: child,
					expandedAncestorSessionIds: [],
					hasChildren: false,
				});
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(1);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});

		await runAgentsViewMode({
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("invalidates the persisted scope root after pushing a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } }];
				state.scopeRootSummary = parent;
				return Promise.resolve({ type: "open", summary: child });
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(2);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockResolvedValueOnce({
			type: "scoped_agents_view",
			source: {
				activeSessionId: child.activeSessionId,
				sessionFile: child.sessionFile,
				sessionId: child.sessionId,
				sessionName: child.sessionName,
				cwd: child.cwd,
			},
		} as never);

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("does not discard scope while the saved-session refresh is in flight", async () => {
		let finishRefresh: ((value: { success: true; data: { sessions: unknown[] } }) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: { sessions: unknown[] } }>((resolve) => {
					finishRefresh = resolve;
				}),
		);
		const scopeSummary = summary();
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: scopeSummary.sessionId, activeSessionId: scopeSummary.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			options: { config: { cwd: "/tmp" } },
			persistentState,
			savedCatalogGeneration: 0,
			savedCatalogReady: true,
			savedCatalogRefreshPending: false,
			lastSuccessfulSavedSessions: [],
			savedSessions: [],
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp" }),
			reconcileCatalogs: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
		};

		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
		expect(self.savedCatalogReady).toBe(false);

		Object.assign(self, {
			lastListedSummaries: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			liveCatalogReady: true,
			liveCatalogRefreshPending: false,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		});
		self.reconcileCatalogs = () => invoke("reconcileCatalogs", self);
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeFrames).toHaveLength(1);

		const saved: AgentConnectionSavedSessionInfo = {
			path: "/tmp/scope.jsonl",
			id: "scope-session",
			cwd: "/tmp",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-01T00:00:00Z"),
			messageCount: 1,
			firstMessage: "scope",
			allMessagesText: "scope",
		};
		finishRefresh?.({
			success: true,
			data: {
				sessions: [
					{
						...saved,
						created: saved.created.toISOString(),
						modified: saved.modified.toISOString(),
					},
				],
			},
		});
		await expect(refresh).resolves.toBe(true);
		expect(persistentState.scopeFrames).toHaveLength(1);
	});

	it("carries the resolved scope root across view remounts", () => {
		const root = summary({ sessionName: "Scoped root" });
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			persistentState,
			lastListedSummaries: [root],
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			liveCatalogReady: true,
			savedCatalogReady: true,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		};
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeRootSummary).toMatchObject({ sessionId: root.sessionId });

		const remount = new AgentsViewMode(
			{
				config: { cwd: "/tmp" } as never,
				uiServices: {
					settingsManager: settingsManager as never,
					modelRegistry: {} as never,
					getInitialCwd: () => "/tmp",
					getInitialSessionName: () => undefined,
					getThemes: () => [],
				},
			},
			persistentState,
		) as AgentsViewMode & Record<string, unknown>;
		const remountedRoot = Reflect.get(remount, "scopeRootSummary") as SessionSummary;
		expect(remountedRoot).toMatchObject({ sessionName: "Scoped root" });
		expect(resolveAgentsViewLeftResult(remountedRoot)).toMatchObject({
			type: "scope_back",
			selection: { sessionId: root.sessionId },
		});
	});

	it("restores expanded subagent lists across view remounts", () => {
		const persistentState: AgentsViewPersistentState = {};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		try {
			(Reflect.get(view, "expandedSubagentParents") as Set<string>).add("file:/tmp/root.jsonl");
			(Reflect.get(view, "programShownParents") as Set<string>).add("file:/tmp/root.jsonl");

			const remount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect((Reflect.get(remount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(
				true,
			);
			expect((Reflect.get(remount, "programShownParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(true);

			// A collapsed-back list persists that way too.
			(Reflect.get(remount, "expandedSubagentParents") as Set<string>).delete("file:/tmp/root.jsonl");
			const collapsedRemount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect(
				(Reflect.get(collapsedRemount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl"),
			).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps subagent expansion across the active-to-persisted identity flip", () => {
		const rowsOf = (self: Record<string, unknown>) => Reflect.get(self, "rows") as AgentsViewRow[];
		const buildView = (expand: boolean) => {
			const parent = summary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionFile: undefined,
				runtimeKind: "top-level",
			});
			const child = summary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: undefined,
				runtimeKind: "subagent",
				parentSessionId: "root-session",
				parentActiveSessionId: "root-active",
			});
			const expandedSubagentParents = new Set<string>();
			const self: Record<string, unknown> = {
				persistentState: {},
				lastListedSummaries: [parent, child],
				savedSessions: [],
				heartbeats: [],
				inactiveAgentIdentities: new Set(),
				pendingDeleteAgent: undefined,
				liveCatalogReady: true,
				savedCatalogReady: true,
				expandedSubagentParents,
				programShownParents: new Set(),
				editor: { getText: () => "" },
				getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
				applyPendingAncestorExpansion: vi.fn(),
				restoreSelection: vi.fn(),
				ui: { requestRender: vi.fn() },
				setStatusMessage: vi.fn(),
				withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
			};
			invoke("reconcileCatalogs", self);
			if (expand) {
				const parentRow = rowsOf(self).find(
					(row) => row.kind === "agent" && row.summary.sessionId === "root-session",
				);
				expect(parentRow?.identity).toBe("session:root-session");
				expandedSubagentParents.add(parentRow!.identity);
				invoke("reconcileCatalogs", self);
				expect(rowsOf(self).some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(true);
			}
			// The runtime flushes the session file; the record identity flips to file:.
			self.lastListedSummaries = [{ ...parent, sessionFile: "/tmp/root.jsonl" }, child];
			invoke("reconcileCatalogs", self);
			return { self, expandedSubagentParents };
		};

		const expandedView = buildView(true);
		const expandedRows = rowsOf(expandedView.self);
		expect(
			expandedRows.find((row) => row.kind === "agent" && row.summary.sessionId === "root-session")?.identity,
		).toBe("file:/tmp/root.jsonl");
		expect(expandedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(true);
		expect(expandedRows.some((row) => row.kind === "subagent" && row.summary.sessionId === "child-session")).toBe(
			true,
		);
		expect([...expandedView.expandedSubagentParents]).toEqual(["file:/tmp/root.jsonl"]);

		const collapsedView = buildView(false);
		const collapsedRows = rowsOf(collapsedView.self);
		expect(collapsedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(false);
		expect(collapsedRows.some((row) => row.kind === "subagent")).toBe(false);
		expect(collapsedView.expandedSubagentParents.size).toBe(0);
	});

	it("toggles subagent list expansion from the summary row", () => {
		const expandedSubagentParents = new Set(["root-row"]);
		const programShownParents = new Set(["root-row"]);
		const persistentState: AgentsViewPersistentState = {
			expandedSubagentParents,
			programShownParents,
		};
		const self: Record<string, unknown> = {
			persistentState,
			expandedSubagentParents,
			programShownParents,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const summaryRow = { kind: "subagent-summary", parentIdentity: "root-row", expanded: true };

		invoke("toggleSubagentList", self, summaryRow);
		expect(expandedSubagentParents.size).toBe(0);
		// Collapsing the list hides its revealed program too.
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(1);

		invoke("toggleSubagentList", self, { ...summaryRow, expanded: false });
		expect(expandedSubagentParents).toEqual(new Set(["root-row"]));
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(2);
	});
});

function createUiServices(): InteractiveModeUiServices {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentsViewMode persistent catalog state", () => {
	it("keeps an initial handoff scope when the first live poll fails after both catalogs settle", async () => {
		const root = summary();
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		const persistentState = createInitialAgentsViewPersistentState({
			initialScopeKey: scope,
			initialSession: root,
		});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(Reflect.get(view, "liveCatalogReady")).toBe(true);
			expect(Reflect.get(view, "savedCatalogReady")).toBe(true);
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: root }]);
			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([root]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope after a fresh instance's first live poll fails", async () => {
		const root = summary({
			id: "root-active",
			activeSessionId: "root-active",
			isSessionActive: true,
			runtimeKind: "top-level",
			sessionId: "root-session",
			cwd: process.cwd(),
		});
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(persistentState.scopeFrames).toEqual([
				{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } },
			]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope through reconnect timeout and settles it on the next successful list", async () => {
		vi.useFakeTimers();
		const root = summary();
		const frame = { scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } };
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [frame],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode(
			{ config: {}, uiServices: createUiServices(), reconnectTimeoutMs: 0 },
			persistentState,
		);
		const client = { isConnected: false, reconnect: vi.fn() };
		Reflect.set(view, "client", client);
		Reflect.set(view, "liveCatalogReady", true);
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("reconnectClient", view, client, new Error("disconnected"))).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([frame]);
			expect(Reflect.get(view, "lastListedSummaries")).toEqual([root]);

			Reflect.set(view, "client", {
				isConnected: true,
				request: vi.fn(async () => ({ success: true, data: { sessions: [] } })),
			});
			await expect(invoke("refreshSessions", view)).resolves.toBe(true);
			expect(persistentState.scopeFrames).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a newly pushed scope and the existing live cache when its first poll fails", async () => {
		const root = summary();
		const other = summary({ id: "other-active", activeSessionId: "other-active", sessionId: "other-session" });
		const returnedRoot = { ...root, sessionName: "Updated root" };
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			const persistentState = Reflect.get(this, "persistentState") as AgentsViewPersistentState;
			if (runs === 1) {
				persistentState.lastSuccessfulLiveSummaries = [other];
				persistentState.lastSuccessfulSavedSessions = [];
				return { type: "open", summary: root, hasChildren: false };
			}

			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([other, returnedRoot]);
			Reflect.set(this, "client", {
				isConnected: true,
				request: vi.fn(async () => {
					throw new Error("transient list failure");
				}),
			});
			await expect(invoke("refreshSessions", this, { preserveStatusOnError: true })).resolves.toBe(false);
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: returnedRoot }]);
			return { type: "exit" };
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "scoped_agents_view",
			source: {
				activeSessionId: root.activeSessionId!,
				sessionId: root.sessionId,
				sessionName: returnedRoot.sessionName,
				cwd: root.cwd,
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});

describe("agents view startup notices", () => {
	it("combines the open fallback and cwd fallback without dropping either notice", () => {
		expect(combineAgentsViewStartupNotices("Child unavailable", "Original directory is missing")).toBe(
			"Child unavailable · Original directory is missing",
		);
		expect(combineAgentsViewStartupNotices("Child unavailable", undefined)).toBe("Child unavailable");
		expect(combineAgentsViewStartupNotices(undefined, "Original directory is missing")).toBe(
			"Original directory is missing",
		);
	});

	it("persists the combined open and cwd fallback notices after returning to agents view", async () => {
		const root = summary({
			activeSessionId: undefined,
			cwd: "/definitely/not/a/real/dir/for/this/test",
			lifecycle: "archived",
			sessionFile: "/tmp/root.jsonl",
		});
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) {
				return {
					type: "open",
					summary: root,
					hasChildren: false,
					statusMessage: "Child unavailable",
				};
			}
			expect(Reflect.get(this, "persistentState")).toMatchObject({
				statusMessage: `Child unavailable · Original directory is missing (${root.cwd}); opened in ${process.cwd()} instead.`,
			});
			return { type: "exit" };
		});
		modeMocks.clientRequest.mockResolvedValue({
			type: "response",
			command: "create",
			success: true,
			data: { ...root, cwd: process.cwd(), activeSessionId: "resumed-active", lifecycle: "live" },
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "agents_view",
			source: {
				activeSessionId: "resumed-active",
				sessionId: root.sessionId,
				cwd: process.cwd(),
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});

	it("pins a selectable subagent summary through its root", () => {
		const summaryRow = {
			kind: "subagent-summary",
			selectable: true,
			rootSessionId: "root-session",
		};
		const self = {
			rows: [summaryRow],
			selectedIndex: 0,
			persistentState: { pinnedRootSessionIds: [] as string[] },
			rebuildRows: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		invoke("togglePinSelection", self);
		expect(self.persistentState.pinnedRootSessionIds).toEqual(["root-session"]);
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.ui.requestRender).toHaveBeenCalledOnce();

		invoke("togglePinSelection", self);
		expect(self.persistentState.pinnedRootSessionIds).toEqual([]);
		expect(self.rebuildRows).toHaveBeenCalledTimes(2);
		expect(self.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	it("reorders filtered root peers without dropping hidden peers", () => {
		const roots = ["A", "B", "C", "D"].map((sessionId) =>
			summary({ id: sessionId, activeSessionId: sessionId, sessionId, created: "2026-01-01T00:00:00Z" }),
		);
		const rows = buildAgentsViewRows([roots[0]!, roots[2]!]);
		const self = {
			rows,
			selectedIndex: rows.findIndex((row) => row.sessionId === "A"),
			persistentState: { manualOrder: { roots: ["A", "B", "C", "D"] } },
			scopedRecords: roots,
			expandedSubagentParents: new Set<string>(),
			programShownParents: new Set<string>(),
			scopeKey: undefined,
			getRowBuildOptions: () => ({ manualOrder: { roots: ["A", "B", "C", "D"] } }),
			rebuildRows: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		invoke("reorderSelection", self, 1);
		expect(self.persistentState.manualOrder.roots).toEqual(["C", "B", "A", "D"]);
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(rows[self.selectedIndex]?.identity).toBe(rows.find((row) => row.sessionId === "A")?.identity);

		invoke("reorderSelection", self, -1);
		expect(self.rebuildRows).toHaveBeenCalledOnce();
	});

	it("dispatches pin and reorder bindings while searching but not while replying or renaming", () => {
		const bindings = {
			"app.agents.togglePin": "\u0014",
			"app.agents.reorderUp": "\u001b[1;2A",
			"app.agents.reorderDown": "\u001b[1;2B",
		};
		const self = {
			replyTarget: undefined as object | undefined,
			renameTarget: undefined as object | undefined,
			editor: { getText: () => "active filter", handleInput: vi.fn() },
			keybindings: { matches: (data: string, action: string) => bindings[action as keyof typeof bindings] === data },
			clearStickyStatusMessage: vi.fn(),
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			togglePinSelection: vi.fn(),
			reorderSelection: vi.fn(),
			handleListNavigation: () => false,
			queryChanged: vi.fn(),
		};

		invoke("handleInput", self, "\u0014");
		invoke("handleInput", self, "\u001b[1;2A");
		invoke("handleInput", self, "\u001b[1;2B");
		expect(self.togglePinSelection).toHaveBeenCalledOnce();
		expect(self.reorderSelection).toHaveBeenNthCalledWith(1, -1);
		expect(self.reorderSelection).toHaveBeenNthCalledWith(2, 1);

		self.replyTarget = {};
		invoke("handleInput", self, "\u0014");
		expect(self.togglePinSelection).toHaveBeenCalledOnce();
		self.replyTarget = undefined;
		self.renameTarget = {};
		invoke("handleInput", self, "\u001b[1;2A");
		expect(self.reorderSelection).toHaveBeenCalledTimes(2);
	});
});

describe("Agents View deletion preference cleanup", () => {
	it("returns deletion-cleanup persistence status", () => {
		const applyAgentsViewStateOperation = vi.fn(() => false);
		expect(invoke("removeDeletedSessionPreferences", { applyAgentsViewStateOperation }, "durable-root-session")).toBe(
			false,
		);
		expect(applyAgentsViewStateOperation).toHaveBeenCalledWith({
			type: "removeSession",
			sessionId: "durable-root-session",
		});
	});
});

describe("Agents View root deletion persistence", () => {
	function rootDeleteSelf(deleteResult: { ok: boolean; method?: "trash" | "delete"; error?: string }, cleanup = true) {
		const row = {
			selectable: true,
			kind: "agent",
			identity: "file:/tmp/root.jsonl",
			summary: summary({ activeSessionId: undefined, sessionFile: "/tmp/root.jsonl", sessionId: "root" }),
		};
		const deleteSavedSession = vi.fn(async () => deleteResult);
		const self = {
			rows: [row],
			selectedIndex: 0,
			pendingKillSubagent: undefined,
			pendingDeleteAgent: { identity: "file:/tmp/root.jsonl" },
			deleteConfirmExpiresAt: Date.now() + 1000,
			options: { deleteSavedSession },
			requireClient: vi.fn(() => ({ request: vi.fn(async () => ({ success: true, data: { sessions: [] } })) })),
			getSavedSessionCatalogContext: vi.fn(() => ({ cwd: "/tmp" })),
			lastListedSummaries: [],
			removeDeletedSessionPreferences: vi.fn(() => cleanup),
			refreshSavedSessions: vi.fn(async () => true),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(),
			stopAgentForDeletion: vi.fn(),
			deactivatePendingAgent: vi.fn(),
			isDeleteConfirmationVisible() {
				return true;
			},
			showDeleteConfirmation: vi.fn(),
			clearDeleteConfirmation(_options: unknown) {},
		};
		return { self, deleteSavedSession };
	}

	it("gates root preference cleanup on an actual saved delete and retains delete success when cleanup queues", async () => {
		const succeeded = rootDeleteSelf({ ok: true, method: "delete" }, false);
		await invoke("handleDeleteSelected", succeeded.self);
		expect(succeeded.deleteSavedSession).toHaveBeenCalledOnce();
		expect(succeeded.self.removeDeletedSessionPreferences).toHaveBeenCalledWith("root");
		expect(succeeded.self.setStatusMessage).toHaveBeenCalledWith(
			"Session deleted; pin/order cleanup did not persist",
		);

		const failed = rootDeleteSelf({ ok: false, error: "nope" });
		await invoke("handleDeleteSelected", failed.self);
		expect(failed.self.removeDeletedSessionPreferences).not.toHaveBeenCalled();
		expect(failed.self.setStatusMessage).toHaveBeenCalledWith("Failed to delete session: nope", { tone: "error" });
	});
});

describe("Agents View durable operation recovery", () => {
	function storePath(): string {
		return join(mkdtempSync(join(tmpdir(), "agents-view-mode-")), "state.json");
	}
	it("appends a newer desired pin behind a failed head and drains FIFO", () => {
		const store = new AgentsViewStateStore(storePath());
		const realApply = store.apply.bind(store);
		let healthy = false;
		(store as unknown as { apply: typeof store.apply }).apply = ((op) =>
			healthy
				? realApply(op)
				: {
						state: { version: 1, pinnedRootSessionIds: [], manualOrder: Object.create(null) },
						persistenceError: new Error("locked"),
					}) as typeof store.apply;
		const self = {
			stateStore: store,
			persistentState: { pinnedRootSessionIds: [], manualOrder: {} } as AgentsViewPersistentState,
			agentsViewStateDirty: false,
			markAgentsViewStateDirty: vi.fn(),
			flushAgentsViewStateOperations() {
				return invoke("flushAgentsViewStateOperations", self);
			},
		};
		invoke("applyAgentsViewStateOperation", self, { type: "setPin", sessionId: "x", pinned: true });
		healthy = true;
		invoke("applyAgentsViewStateOperation", self, { type: "setPin", sessionId: "x", pinned: false });
		expect(self.persistentState.pendingAgentsViewStateOperations).toEqual([]);
		expect(store.load().state.pinnedRootSessionIds).toEqual([]);
		expect(self.persistentState.pinnedRootSessionIds).toEqual([]);
	});

	it("does not clobber another client while replaying a queued operation", () => {
		const path = storePath(),
			store = new AgentsViewStateStore(path),
			other = new AgentsViewStateStore(path);
		const realApply = store.apply.bind(store);
		let fail = true;
		(store as unknown as { apply: typeof store.apply }).apply = ((op) =>
			fail
				? {
						state: { version: 1, pinnedRootSessionIds: [], manualOrder: {} },
						persistenceError: new Error("locked"),
					}
				: realApply(op)) as typeof store.apply;
		const self = {
			stateStore: store,
			persistentState: { pinnedRootSessionIds: ["x"], manualOrder: {} },
			agentsViewStateDirty: false,
			markAgentsViewStateDirty: vi.fn(),
		};
		invoke("applyAgentsViewStateOperation", self, { type: "setPin", sessionId: "x", pinned: true });
		other.apply({ type: "setPin", sessionId: "y", pinned: true });
		fail = false;
		invoke("flushAgentsViewStateOperations", self);
		expect(other.load().state.pinnedRootSessionIds).toEqual(["y", "x"]);
	});

	it("retains optimistic full-tail state after a partial prefix then adopts authority only after drain", () => {
		const store = new AgentsViewStateStore(storePath());
		const realApply = store.apply.bind(store);
		let failSecond = true,
			calls = 0;
		(store as unknown as { apply: typeof store.apply }).apply = ((op) => {
			calls++;
			if (calls === 2 && failSecond)
				return {
					state: { version: 1, pinnedRootSessionIds: ["a"], manualOrder: Object.create(null) },
					persistenceError: new Error("locked"),
				};
			return realApply(op);
		}) as typeof store.apply;
		const self = {
			stateStore: store,
			persistentState: {
				pinnedRootSessionIds: ["optimistic-a", "optimistic-b"],
				manualOrder: { sentinel: ["keep"] },
				pendingAgentsViewStateOperations: [
					{ type: "setPin" as const, sessionId: "a", pinned: true },
					{ type: "setPin" as const, sessionId: "b", pinned: true },
				],
			},
			agentsViewStateDirty: false,
			markAgentsViewStateDirty: vi.fn(),
		};
		expect(invoke("flushAgentsViewStateOperations", self)).toBe(false);
		expect(self.persistentState.pinnedRootSessionIds).toEqual(["optimistic-a", "optimistic-b"]);
		expect(self.persistentState.manualOrder).toEqual({ sentinel: ["keep"] });
		expect(self.persistentState.pendingAgentsViewStateOperations).toEqual([
			{ type: "setPin", sessionId: "b", pinned: true },
		]);
		failSecond = false;
		expect(invoke("flushAgentsViewStateOperations", self)).toBe(true);
		expect(self.persistentState.pinnedRootSessionIds).toEqual(["a", "b"]);
	});

	it("does not adopt loaded disk state while a remounted queue cannot flush", () => {
		const stateStore = {
			load: vi.fn(() => ({
				state: { version: 1 as const, pinnedRootSessionIds: ["disk"], manualOrder: { disk: ["disk"] } },
			})),
			apply: vi.fn(() => ({
				state: { version: 1 as const, pinnedRootSessionIds: ["disk"], manualOrder: {} },
				persistenceError: new Error("locked"),
			})),
		};
		const self = {
			stateStore,
			persistentState: {
				pinnedRootSessionIds: ["optimistic"],
				manualOrder: { keep: ["optimistic"] },
				pendingAgentsViewStateOperations: [{ type: "setPin" as const, sessionId: "optimistic", pinned: true }],
			},
			agentsViewStateDirty: false,
			markAgentsViewStateDirty: vi.fn(),
			flushAgentsViewStateOperations() {
				return invoke("flushAgentsViewStateOperations", self);
			},
		};
		expect(invoke("loadAgentsViewState", self)).toBe(false);
		expect(self.persistentState.pinnedRootSessionIds).toEqual(["optimistic"]);
		expect(self.persistentState.manualOrder).toEqual({ keep: ["optimistic"] });
		expect(self.persistentState.pendingAgentsViewStateOperations).toHaveLength(1);
	});

	it("finish retains a failed queue", () => {
		const store = {
			apply: vi.fn(() => ({
				state: { version: 1, pinnedRootSessionIds: [], manualOrder: {} },
				persistenceError: new Error("locked"),
			})),
		};
		const self = {
			stopped: false,
			agentsViewStateDirty: true,
			stateStore: store,
			persistentState: {
				pendingAgentsViewStateOperations: [{ type: "setPin" as const, sessionId: "x", pinned: true }],
			},
			markAgentsViewStateDirty: vi.fn(),
			savedCatalogGeneration: 0,
			liveCatalogGeneration: 0,
			heartbeatCatalogGeneration: 0,
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			setStatusMessage: vi.fn(),
			ui: { stop: vi.fn() },
			unsubscribeClientClose: undefined,
			unsubscribeClientMessage: undefined,
			client: undefined,
			resolveRun: undefined,
		};
		invoke("finish", self, { type: "exit" });
		expect(self.persistentState.pendingAgentsViewStateOperations).toHaveLength(1);
	});
});
