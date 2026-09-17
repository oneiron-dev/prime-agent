import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSessionListCallbacks,
} from "../src/modes/agent-connection/types.js";
import { AgentsViewMode, type AgentsViewPersistentState } from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import * as savedCatalog from "../src/modes/daemon/saved-session-catalog.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { BrandSplashHeader } from "../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const emit = (value: unknown) => writeSync(1, `${JSON.stringify(value)}\n`);
const count = Number(process.env.SEARCH_ROWS ?? 300);
const textBytes = Number(process.env.SEARCH_TEXT_BYTES ?? 65536);
const budgetMs = Number(process.env.SEARCH_BUDGET_MS ?? 500);
const invoke = (view: AgentsViewMode, method: string, ...args: unknown[]) =>
	Reflect.get(AgentsViewMode.prototype, method).apply(view, args);

it("keeps actual input responsive while searching or loading nested sessions", async () => {
	initTheme("dark", false);
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const ui = { requestRender() {}, terminal: { rows: 40, columns: 160 } };
	const editor = new CustomEditor(ui as unknown as TUI, getEditorTheme(), keys);
	const phrase = "function verify architecture and tests with nested session ownership. ";
	const corpus = phrase.repeat(Math.ceil(textBytes / phrase.length)).slice(0, textBytes);
	const summaries: SessionSummary[] = [];
	const saved: AgentConnectionSavedSessionInfo[] = [];
	for (let i = 0; i < count; i++) {
		const id = `session-${i}`;
		const parent = i === 0 ? undefined : `session-${Math.floor((i - 1) / 4)}`;
		const path = `/tmp/search-repro/${id}.jsonl`;
		summaries.push({
			id,
			activeSessionId: id,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: id,
			sessionFile: path,
			cwd: "/tmp/search-repro",
			sessionName: id,
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 1,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			...(parent ? { runtimeKind: "subagent", parentSessionId: parent, parentActiveSessionId: parent } : {}),
		});
		saved.push({
			path,
			id,
			cwd: "/tmp/search-repro",
			name: id,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			firstMessage: "synthetic",
			allMessagesText: `${corpus} ${i}`,
			usage: { inputTokens: 10, outputTokens: 10, cost: 0.01 },
		});
	}
	const persistentState: AgentsViewPersistentState = {
		savedCatalogLoaded: true,
		savedSessions: saved,
		lastSuccessfulSavedSessions: saved,
		pinnedRootSessionIds: ["session-0"],
		scopeFrames: process.env.SEARCH_SCOPE ? [{ scope: { sessionId: process.env.SEARCH_SCOPE } }] : [],
	};
	const view = Object.assign(Object.create(AgentsViewMode.prototype), {
		options: { config: { cwd: "/tmp/search-repro" }, uiServices: { getInitialCwd: () => "/tmp/search-repro" } },
		persistentState,
		ui,
		editor,
		keybindings: keys,
		lastListedSummaries: [],
		lastVisibleSummaries: [],
		savedSessions: saved,
		lastSuccessfulSavedSessions: saved,
		heartbeats: [],
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		savedCatalogReady: true,
		savedCatalogRefreshPending: false,
		savedSearchFetchStarted: true,
		rows: [],
		sessionRows: [],
		selectedIndex: 0,
		expandedSubagentParents: new Set(),
		programShownParents: new Set(),
		inactiveAgentIdentities: new Set(),
		stopped: false,
		daemonShutdownReceived: false,
		statusMessageSticky: false,
		workingIconFrame: 0,
		ctrlCExitHintExpiresAt: 0,
		deleteConfirmExpiresAt: 0,
		splash: new BrandSplashHeader("repro", () => "/tmp/search-repro", undefined, {
			getExtraMetadata: () => [{ label: "agents", value: invoke(view, "getAgentCountsText") }],
		}),
	}) as AgentsViewMode;
	const timings: Record<string, number> = {};
	for (const method of ["getFilteredRecords", "rebuildRows"]) {
		Reflect.set(view, method, (...args: unknown[]) => {
			const start = performance.now();
			try {
				return invoke(view, method, ...args);
			} finally {
				timings[method] = (timings[method] ?? 0) + performance.now() - start;
			}
		});
	}
	emit({ phase: "seed-start", count, textBytes, totalMiB: (count * textBytes) / 1048576 });
	const seedStart = performance.now();
	invoke(view, "applySessionList", summaries, true);
	emit({ phase: "seed-complete", ms: performance.now() - seedStart, rssMiB: process.memoryUsage().rss / 1048576 });
	const stormCount = Number(process.env.SEARCH_STORM ?? 100);
	if (stormCount > 0) {
		let callbacks: AgentConnectionSessionListCallbacks | undefined;
		let finish!: (sessions: AgentConnectionSavedSessionInfo[]) => void;
		vi.spyOn(savedCatalog, "listDaemonSavedSessions").mockImplementation((_client, _context, _scope, next) => {
			callbacks = next;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		Reflect.set(view, "client", { isConnected: true });
		Reflect.set(view, "savedCatalogGeneration", 0);
		Reflect.set(view, "savedSearchFetchStarted", false);
		const refresh = invoke(view, "refreshSavedSessions", { preserveStatusOnError: true });
		const start = performance.now();
		const input = new Promise<number>((resolve) =>
			setImmediate(() => {
				view.handleInput("\u001b[B");
				view.render(160);
				resolve(performance.now() - start);
			}),
		);
		emit({
			phase: "storm-start",
			stormCount,
			query: editor.getText(),
			retained: saved.length,
			scope: process.env.SEARCH_SCOPE ?? "global",
		});
		for (let i = 0; i < stormCount; i++) {
			callbacks?.onSession?.({ ...saved[i % saved.length]!, modified: new Date(i + 1) });
			callbacks?.onProgress?.(i + 1, stormCount);
		}
		const deliveryMs = performance.now() - start;
		finish(saved);
		await refresh;
		const inputWaitMs = await input;
		emit({ phase: "storm-complete", deliveryMs, inputWaitMs, rssMiB: process.memoryUsage().rss / 1048576 });
		expect(inputWaitMs, `navigation queued behind ${stormCount} real onSession callbacks`).toBeLessThan(budgetMs);
		return;
	}
	const measurements = [];
	for (const key of ["f", "f"]) {
		timings.getFilteredRecords = 0;
		timings.rebuildRows = 0;
		emit({ phase: "input-start", nextQuery: editor.getText() + key });
		const start = performance.now();
		view.handleInput(key);
		const inputMs = performance.now() - start;
		const renderStart = performance.now();
		const lines = view.render(160);
		const renderMs = performance.now() - renderStart;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const eventLoopMs = performance.now() - start;
		const measurement = {
			query: editor.getText(),
			inputMs,
			renderMs,
			eventLoopMs,
			...timings,
			renderedRows: lines.length,
			rssMiB: process.memoryUsage().rss / 1048576,
		};
		measurements.push(measurement);
		emit(measurement);
	}
	expect(editor.getText()).toBe("ff");
	for (const result of measurements) expect(result.eventLoopMs, JSON.stringify(result)).toBeLessThan(budgetMs);
}, 12000);
