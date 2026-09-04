import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { emptyGoalState } from "../src/core/goals.js";
import type {
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionEvent,
	AgentConnectionSnapshot,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";
import { AgentsViewRosterStore } from "../src/modes/agents-view/roster-store.js";
import type { AgentRosterEntry } from "../src/modes/daemon/agent-roster.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type Child = AgentConnectionRlmChildAgentSnapshot;

interface ScalingHarness {
	subagentSnapshots: Map<string, Child>;
	connectionState: AgentConnectionState;
	rosterBar?: AgentsViewRosterStore;
	subagentSummaryLine: SubagentSummaryLine;
	renderInitialMessages(): Promise<void>;
	replaceSubagentSummary(children: readonly Child[]): void;
	handleEvent(event: AgentConnectionSessionEvent): Promise<void>;
}

function connectionState(): AgentConnectionState {
	return {
		activeSessionId: "active-root",
		cwd: "/tmp/prime-children-scaling",
		thinkingLevel: "low",
		serviceTier: "default",
		availableThinkingLevels: ["low"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "root",
		leafId: null,
		autoCompactionEnabled: false,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
	};
}

function children(count: number, nested: boolean): Child[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `child-${index}`,
		label: `Child ${index}`,
		status: "done",
		sessionDir: `/tmp/prime-children-scaling/child-${index}`,
		...(nested && index > 0 ? { parentId: `child-${Math.floor((index - 1) / 4)}` } : {}),
	}));
}

function createHarness(initialChildren: Child[]): ScalingHarness {
	const state = connectionState();
	const snapshot: AgentConnectionSnapshot = { state, messages: [], children: initialChildren };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		connectionState: state,
		subagentSnapshots: new Map<string, Child>(),
		rlmNodeId: undefined,
		subagentSummaryLine: new SubagentSummaryLine(),
		agentConnection: { getInitialSnapshot: vi.fn(async () => snapshot) },
		applyConnectionStateSnapshot: vi.fn(),
		restoreTurnStartFromMessages: vi.fn(),
		renderSessionContext: vi.fn(async () => {}),
		restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
		scheduleHeartbeatManagerRefresh: vi.fn(),
		updateWorkingPulse: vi.fn(),
		syncWorkingLoader: vi.fn(),
		updateWorkingLoaderMessage: vi.fn(),
		updateConnectionStateFromEvent: vi.fn(),
		activityTracker: { handleEvent: vi.fn() },
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
	}) as ScalingHarness;
	return mode;
}

function createRoster(childrenToProject: Child[]): AgentsViewRosterStore {
	const roster = new AgentsViewRosterStore();
	// Populate only the in-memory store; never attach a transport or schedule updates.
	const entries = Reflect.get(roster, "entries") as Map<string, AgentRosterEntry>;
	for (const child of [undefined, ...childrenToProject]) {
		const id = child?.id ?? "root";
		entries.set(id, {
			agentId: id,
			status: "inactive",
			summary: {
				id,
				sessionId: id,
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				cwd: "/tmp/prime-children-scaling",
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 0,
				runtimeKind: child ? "subagent" : "top-level",
				...(child ? { parentSessionId: child.parentId ?? "root", rlmChildId: id } : {}),
			},
		});
	}
	return roster;
}

class CountingSnapshotMap extends Map<string, Child> {
	valueScans = 0;
	entriesScanned = 0;

	override values(): ReturnType<Map<string, Child>["values"]> {
		this.valueScans += 1;
		this.entriesScanned += this.size;
		return super.values();
	}
}

function elapsed(start: number): number {
	return Number((performance.now() - start).toFixed(3));
}

// These fixtures begin after the attach reply. They do not reproduce the reported
// 30-second response-to-attach timeout, which happens before TUI initialization.
describe("InteractiveMode child scaling after attach", () => {
	beforeAll(() => initTheme("dark"));

	it.each([50, 300, 1000])("measures real child paths with %i children without live services", async (count) => {
		const mode = createHarness(children(count, false));
		const counts = vi.spyOn(mode.subagentSummaryLine, "setSubagentCounts");
		let start = performance.now();
		await mode.renderInitialMessages();
		const seedMs = elapsed(start);
		expect(mode.subagentSnapshots.size).toBe(count);
		expect(counts).toHaveBeenLastCalledWith({ total: count, running: 0, idle: 0, inactive: count });

		start = performance.now();
		const rendered = mode.subagentSummaryLine.render(120);
		const trayRenderMs = elapsed(start);
		expect(rendered).toHaveLength(3);

		const nested = children(count, true);
		start = performance.now();
		mode.replaceSubagentSummary(nested);
		const replaceMs = elapsed(start);
		expect(mode.subagentSnapshots.size).toBe(count);
		expect(counts).toHaveBeenLastCalledWith({ total: 1, running: 0, idle: 0, inactive: 1 });

		mode.rosterBar = createRoster(nested);
		const summaries = vi.spyOn(mode.rosterBar, "summaries");
		start = performance.now();
		for (const child of nested) {
			await mode.handleEvent({ type: "rlm_child_update", child: { ...child, tokenCount: 100 } });
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		const burstMs = elapsed(start);
		const rosterProjections = summaries.mock.calls.length;
		expect(rosterProjections).toBe(1);
		expect([...mode.subagentSnapshots.values()].every((child) => child.tokenCount === 100)).toBe(true);
		expect(counts).toHaveBeenLastCalledWith({ total: 1, running: 0, idle: 0, inactive: 1 });

		const snapshots = new CountingSnapshotMap(mode.subagentSnapshots);
		mode.subagentSnapshots = snapshots;
		start = performance.now();
		await mode.handleEvent({ type: "rlm_child_update", child: { ...nested[0], status: "cancelled" } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const subtreeRemovalMs = elapsed(start);
		expect(snapshots.entriesScanned).toBe(count);
		expect(mode.subagentSnapshots.size).toBe(0);

		console.log(
			JSON.stringify({
				fixture: "post-attach-child-paths",
				children: count,
				seedMs,
				trayRenderMs,
				replaceMs,
				burstMs,
				rosterProjections,
				projectedRosterRows: rosterProjections * (count + 1),
				subtreeRemovalMs,
				subtreeMapScans: snapshots.valueScans,
				subtreeEntriesScanned: snapshots.entriesScanned,
			}),
		);
	});
});
