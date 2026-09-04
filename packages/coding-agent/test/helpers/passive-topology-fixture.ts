import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionInfo } from "../../src/core/session-manager.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../src/modes/agent-connection/types.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import type { DaemonSessionSnapshot } from "../../src/modes/daemon/daemon-protocol.js";
import { type RlmLedgerEdge, RlmSpawnLedger } from "../../src/modes/daemon/rlm-ledger.js";
export interface PassiveRow {
	entry: {
		childId: string;
		status: string;
		sessionFile: string;
		sessionDir: string;
		parentSessionId: string;
		prompt?: string;
	};
	rootParentState?: ActiveSessionState;
	rootInfo?: SessionInfo;
	info: SessionInfo;
}
export interface Internals {
	sessions: Map<string, ActiveSessionState>;
	createSessionSnapshotOnce(state: ActiveSessionState): Promise<DaemonSessionSnapshot>;
	listPassiveRlmSubagents(savedRoots?: SessionInfo[], includeResident?: boolean): Promise<PassiveRow[]>;
	scanPassiveRlmSubagents(
		savedRoots: SessionInfo[],
		includeResident: boolean,
		residentStates?: Iterable<ActiveSessionState>,
	): Promise<PassiveRow[]>;
	walkPassiveRlmSubagents(
		savedRoots: SessionInfo[],
		includeResident: boolean,
		residentStates?: Iterable<ActiveSessionState>,
	): Promise<{ result: PassiveRow[] }>;
	passiveRlmInputStatsUnchanged(stats: Map<string, string>): Promise<boolean>;
	passiveRlmStatString(path: string): Promise<string>;
	passiveRlmSubagentEntryForEdge(
		edge: RlmLedgerEdge,
		parent: { sessionId: string; sessionFile: string },
		cache?: Map<string, Promise<unknown[]>>,
		readHealth?: unknown,
	): Promise<unknown>;
	legacyRlmSubagentRegistryPath(path: string, id: string): string;
}
export interface Scenario {
	name: string;
	children: number;
	depth: number;
	residentIndices?: number[];
	unrelated?: number;
	workerSibling?: boolean;
}
const tempDirectories: string[] = [];
const at = "2026-09-05T00:00:00.000Z";
export function cleanupTopologyFixtures(): void {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
}
export function topologyState(
	id: string,
	path: string,
	cwd: string,
	children: AgentConnectionRlmChildAgentSnapshot[] = [],
	childId?: string,
): ActiveSessionState {
	return {
		activeSessionId: `active-${id}`,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "fixture",
		lastEventSequence: 0,
		runtime: {
			metadata: {
				kind: childId ? "subagent" : "top-level",
				createdAt: 1,
				...(childId ? { rlmChildId: childId } : {}),
			},
			diagnostics: [],
			session: {
				sessionId: id,
				sessionFile: path,
				sessionName: id,
				messages: [],
				model: undefined,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				isSessionActive: false,
				rlmDepth: 0,
				retryAttempt: 0,
				steeringMode: "all",
				followUpMode: "all",
				autoCompactionEnabled: false,
				unfinishedActionCount: 0,
				scopedModels: [],
				state: { pendingToolCalls: new Set() },
				sessionManager: {
					getCwd: () => cwd,
					getSessionDir: () => dirname(path),
					getLeafId: () => null,
					getEntries: () => [],
					getHeader: () => ({ timestamp: at }),
				},
				getAvailableThinkingLevels: () => ["off"],
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				getActiveToolNames: () => [],
				getContextUsage: () => undefined,
				getRlmChildSnapshots: () => children,
				hasRunningRlmChildren: () => false,
			},
		},
	} as unknown as ActiveSessionState;
}
export function writeTopologySession(path: string, id: string, cwd: string, parent?: string, depth = 0): void {
	mkdirSync(dirname(path), { recursive: true });
	const rows = [
		{
			type: "session",
			version: 3,
			id,
			timestamp: at,
			cwd,
			...(parent ? { parentSession: parent } : {}),
			rlmDepth: depth,
		},
		{ type: "session_info", id: `${id}-name`, parentId: null, timestamp: at, name: id },
		{
			type: "message",
			id: `${id}-prompt`,
			parentId: null,
			timestamp: at,
			message: { role: "user", content: `Task ${id} ${"x".repeat(2048)}`, timestamp: 1 },
		},
	];
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
export function topologyFixture(scenario: Scenario): {
	internals: Internals;
	root: ActiveSessionState;
	familyStates: ActiveSessionState[];
	allEdges: number;
	childIds: string[];
	directory: string;
	ledger: RlmSpawnLedger;
	files: Map<string, string>;
} {
	const directory = mkdtempSync(join(tmpdir(), "prime-passive-topology-"));
	tempDirectories.push(directory);
	const sessionsDir = join(directory, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const records: Array<Record<string, unknown>> = [];
	const states: ActiveSessionState[] = [];
	function family(
		prefix: string,
		count: number,
		depth: number,
		residentIndices: number[] = [],
	): { root: ActiveSessionState; familyStates: ActiveSessionState[]; childIds: string[] } {
		const rootFile = scenario.workerSibling
			? join(directory, "branches", prefix, `${prefix}.jsonl`)
			: join(sessionsDir, `${prefix}.jsonl`);
		const workerFile = join(sessionsDir, "worker.jsonl");
		writeTopologySession(
			rootFile,
			prefix,
			directory,
			scenario.workerSibling ? workerFile : undefined,
			scenario.workerSibling ? 1 : 0,
		);
		const children: Array<{ id: string; file: string; depth: number; parentId?: string }> = [];
		for (let i = 0; i < count; i++) {
			const id = `${prefix}-child-${i}`;
			const file = join(directory, "children", id, `${id}.jsonl`);
			const parentIndex = depth === 0 ? -1 : i < depth ? i - 1 : i % depth;
			const parent = parentIndex < 0 ? undefined : children[parentIndex];
			const parentFile = parent?.file ?? rootFile;
			const childDepth = (parent?.depth ?? (scenario.workerSibling ? 1 : 0)) + 1;
			writeTopologySession(file, id, directory, parentFile, childDepth);
			children.push({ id, file, depth: childDepth, parentId: parent?.id });
			writeFileSync(
				join(dirname(file), "rlm-subagent.json"),
				JSON.stringify({
					type: "rlm_subagent",
					childId: id,
					sessionName: id,
					sessionDir: dirname(file),
					sessionFile: file,
					status: "completed",
					createdAt: 1,
					updatedAt: at,
					prompt: `task ${id}`,
				}),
			);
			records.push({
				v: 1,
				op: "spawn",
				at,
				childId: id,
				parent: parentFile,
				child: file,
				depth: childDepth,
				name: id,
			});
		}
		const residentChildren = residentIndices.map((i) => children[i]).filter((child) => child !== undefined);
		const snapshots: AgentConnectionRlmChildAgentSnapshot[] = residentChildren.map((child) => ({
			id: child.id,
			sessionName: child.id,
			status: "done",
			label: child.id,
			sessionDir: dirname(child.file),
			...(child.parentId ? { parentId: child.parentId } : {}),
		}));
		const root = topologyState(
			prefix,
			rootFile,
			directory,
			snapshots,
			scenario.workerSibling ? `${prefix}-branch` : undefined,
		);
		const familyStates = [
			root,
			...residentChildren.map((child) => topologyState(child.id, child.file, directory, [], child.id)),
		];
		states.push(...familyStates);
		return { root, familyStates, childIds: children.map((child) => child.id) };
	}
	if (scenario.unrelated) family("unrelated", scenario.unrelated, 0);
	const target = family("target", scenario.children, scenario.depth, scenario.residentIndices);
	if (scenario.workerSibling) {
		const workerFile = join(sessionsDir, "worker.jsonl");
		writeTopologySession(workerFile, "worker", directory);
		const branches = states.filter((resident) => resident.runtime.metadata.rlmChildId?.endsWith("-branch"));
		for (const branch of branches) {
			const file = branch.runtime.session.sessionFile;
			const childId = branch.runtime.metadata.rlmChildId;
			if (!file || !childId) throw new Error("Missing synthetic branch identity");
			branch.runtime.metadata.parentActiveSessionId = "active-worker";
			records.push({ v: 1, op: "spawn", at, childId, parent: workerFile, child: file, depth: 1, name: childId });
			writeFileSync(
				join(dirname(file), "rlm-subagent.json"),
				JSON.stringify({
					type: "rlm_subagent",
					childId,
					sessionName: childId,
					sessionDir: dirname(file),
					sessionFile: file,
					status: "completed",
					createdAt: 1,
					updatedAt: at,
				}),
			);
		}
		const residentSnapshots = states.map((resident) => ({
			id: resident.runtime.metadata.rlmChildId ?? "",
			sessionName: resident.runtime.session.sessionId,
			label: "resident",
			status: "done" as const,
			sessionDir: dirname(resident.runtime.session.sessionFile ?? directory),
		}));
		states.unshift(topologyState("worker", workerFile, directory, residentSnapshots));
	}
	const ledger = new RlmSpawnLedger(directory, sessionsDir);
	mkdirSync(dirname(ledger.ledgerPath), { recursive: true });
	writeFileSync(ledger.ledgerPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	const daemon = new AgentDaemon(join(directory, "unused.sock"), {
		defaultSessionConfig: { agentDir: directory, sessionDir: sessionsDir, cwd: directory },
		createRuntime: async () => {
			throw new Error("Audit must not create runtimes");
		},
	});
	const internals = daemon as unknown as Internals;
	for (const resident of states) internals.sessions.set(resident.activeSessionId, resident);

	return {
		internals,
		...target,
		allEdges: records.length,
		directory,
		ledger,
		files: new Map(records.map((record) => [String(record.childId), String(record.child)])),
	};
}
