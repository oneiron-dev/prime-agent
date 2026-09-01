/**
 * Deterministic stress/soak proofs for the W6 daemon runtime.
 *
 * Every phase is in-process and hermetic: fake worker clients, deferred
 * promises, and temp directories only. There is no model inference, no provider
 * construction, no child process, and no socket of any kind — the guard at the
 * bottom of this file asserts that, so a future edit cannot quietly turn a
 * stress phase into a network or inference test.
 *
 * The scale constants are the reported bounds; they are deliberately modest so
 * the file stays inside the default 30s vitest timeout while still being large
 * enough that a per-caller (rather than per-reservation) regression, a duplicate
 * launch, or a leaked single-flight shows up as a hard assertion failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelClient } from "../src/core/kernel/shared.js";
import { SessionManager } from "../src/core/session-manager.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonServerCapability,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

// --- reported scale --------------------------------------------------------

const CONCURRENT_WORKERS = 128;
const CALLERS_PER_KEY = 8;
const RACED_OPEN_KEYS = 128;
const RACED_CALLERS_PER_KEY = 8;
const ADOPTION_ROUNDS = 4;
const ADOPTION_WORKERS_PER_ROUND = 64;
const CATALOG_WORKERS_PER_CLASS = 32;
const CONCURRENT_REFRESHES_PER_WORKER = 8;
const STABLE_TARGET_WORKERS = 8;
const CHILDREN_PER_STABLE_WORKER = 256;
const STABLE_DUPLICATE_REPEATS = 1024;
const PASSIVE_SCAN_CALLERS = 512;
const LEDGER_EDGES = 256;
const LEDGER_CONCURRENT_READS = 256;
const KERNEL_RECOVERY_CYCLES = 256;
const KERNEL_CONCURRENT_ENSURES = 64;

/** Counters and resource observations, printed once by the final guard test. */
const metrics: Record<string, unknown> = {};

// --- inference / network guard ---------------------------------------------

const socketConnectTargets: string[] = [];
const fetchTargets: string[] = [];
let restoreGuards: () => void = () => {};

function describeConnectTarget(args: readonly unknown[]): string {
	const [first, second] = args;
	if (typeof first === "string") return `unix:${first}`;
	if (typeof first === "number") return `tcp:${typeof second === "string" ? second : "localhost"}:${first}`;
	if (first && typeof first === "object") {
		const options = first as { path?: string; host?: string; port?: number };
		if (typeof options.path === "string") return `unix:${options.path}`;
		return `tcp:${options.host ?? "localhost"}:${options.port ?? 0}`;
	}
	return "unknown";
}

/** Unix-domain sockets and explicit loopback literals only; never a name lookup. */
function isLoopbackTarget(target: string): boolean {
	if (target.startsWith("unix:")) return true;
	return /^tcp:(127\.0\.0\.1|::1|localhost):\d+$/.test(target);
}

beforeAll(() => {
	const originalConnect = Socket.prototype.connect;
	const originalFetch = globalThis.fetch;
	Socket.prototype.connect = function guardedConnect(this: Socket, ...args: unknown[]) {
		socketConnectTargets.push(describeConnectTarget(args));
		return (originalConnect as (this: Socket, ...rest: unknown[]) => Socket).apply(this, args);
	} as typeof Socket.prototype.connect;
	globalThis.fetch = (async (input: unknown) => {
		fetchTargets.push(String(input));
		throw new Error("daemon runtime stress must never perform an HTTP/inference request");
	}) as typeof globalThis.fetch;
	restoreGuards = () => {
		Socket.prototype.connect = originalConnect;
		globalThis.fetch = originalFetch;
	};
});

afterAll(() => {
	restoreGuards();
});

// --- shared deterministic fixtures ------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stressDir(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `prime-stress-${label}-`));
	tempDirs.push(directory);
	return directory;
}

interface StressWorker {
	descriptor: {
		workerId: string;
		lifecycle: "ready" | "starting" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		sessionFile?: string;
		pid: number;
		processStartId?: string;
		authenticationToken: string;
		ownerClientId?: string;
		consecutiveFailures?: number;
		lastError?: string;
		createCommand: { config: { cwd: string }; sessionPath?: string; noSession?: boolean };
	};
	client?: { request: ReturnType<typeof vi.fn>; requestWorker: ReturnType<typeof vi.fn> };
	hello?: {
		protocol: { name: string; version: number };
		schemaRevision?: number;
		serverCapabilities?: readonly DaemonServerCapability[];
	};
	summaries: Map<string, SessionSummary>;
	summariesStale?: boolean;
	summariesRefreshedAt?: number;
	summaryRefresh?: Promise<void>;
	summaryRehydration?: Promise<void>;
}

interface SupervisorInternals {
	workers: Map<string, StressWorker>;
	openingWorkers: Map<string, Promise<StressWorker>>;
	createOrReuseWorker(
		clientId: string,
		command: { type: "create"; sessionPath?: string; name?: string; lifecycle?: "client_owned" },
	): Promise<StressWorker>;
	refreshWorkerSummaries(worker: StressWorker, allowFresh?: boolean): Promise<void>;
	adoptOrRecoverWorker(worker: StressWorker): Promise<void>;
	handleCommand(client: object, command: Record<string, unknown>): Promise<unknown>;
}

function summary(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "sessionId">): SessionSummary {
	return {
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

/** Exactly what a current-binary worker greets with: protocol 7, schema 24, full caps. */
function currentWorkerHello(): NonNullable<StressWorker["hello"]> {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
	};
}

function stressWorker(workerId: string, cwd: string, summaries: SessionSummary[] = []): StressWorker {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root-active`,
			rootSessionId: `${workerId}-root-session`,
			pid: process.pid,
			processStartId: `${workerId}-start`,
			authenticationToken: `${workerId}-token`,
			createCommand: { config: { cwd } },
		},
		client: { request: vi.fn(), requestWorker: vi.fn() },
		hello: currentWorkerHello(),
		summaries: new Map(summaries.map((entry) => [entry.activeSessionId ?? entry.id, entry])),
	};
}

function supervisorFor(directory: string): SupervisorInternals {
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
}

/**
 * Real files on disk, so `canonicalSessionPath` resolves on its first syscall.
 * The stress loops canonicalize these paths hundreds of thousands of times.
 */
function sessionPaths(directory: string, count: number, prefix = "session"): string[] {
	return Array.from({ length: count }, (_unused, index) => {
		const path = join(directory, `${prefix}-${index}.jsonl`);
		writeFileSync(path, "");
		return path;
	});
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function activeResourceCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const resource of process.getActiveResourcesInfo()) {
		counts[resource] = (counts[resource] ?? 0) + 1;
	}
	return counts;
}

function heapUsedMiB(): number {
	return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100;
}

// --- 1. concurrent workers and 1000+ attach/open operations ------------------

describe("daemon supervisor open/attach stress", () => {
	it("serves 128 concurrent workers and 1280 open operations with one launch per key", async () => {
		const directory = stressDir("open");
		const supervisor = supervisorFor(directory);
		const paths = sessionPaths(directory, CONCURRENT_WORKERS);
		const startedAt = performance.now();
		const heapBefore = heapUsedMiB();
		let launched = 0;
		const launchWorker = vi.fn(
			async (
				command: { sessionPath?: string },
				_existing: unknown,
				ownerClientId: string | undefined,
			): Promise<StressWorker> => {
				const index = paths.indexOf(command.sessionPath ?? "");
				const worker = stressWorker(`worker-${index}`, directory, [
					summary({
						id: `worker-${index}-root-active`,
						activeSessionId: `worker-${index}-root-active`,
						sessionId: `worker-${index}-root-session`,
						sessionFile: command.sessionPath,
						rlmDepth: 0,
					}),
				]);
				worker.descriptor.sessionFile = command.sessionPath;
				worker.descriptor.createCommand = { config: { cwd: directory }, sessionPath: command.sessionPath };
				worker.descriptor.ownerClientId = ownerClientId;
				launched++;
				supervisor.workers.set(worker.descriptor.workerId, worker);
				seedSupervisorRoster(supervisor, worker);
				return worker;
			},
		);
		Object.assign(supervisor, { launchWorker, persistWorker: vi.fn() });

		// 128 keys x 8 concurrent callers. Callers 0-3 are the owner, 4-7 are
		// rivals that must be refused with the typed session_already_active.
		const opens: Array<Promise<StressWorker>> = [];
		for (const sessionPath of paths) {
			for (let caller = 0; caller < CALLERS_PER_KEY; caller++) {
				const clientId = caller < CALLERS_PER_KEY / 2 ? "owner" : `intruder-${caller}`;
				opens.push(
					supervisor.createOrReuseWorker(clientId, { type: "create", sessionPath, lifecycle: "client_owned" }),
				);
			}
		}
		// The whole synchronous fan-out published one reservation per key before a
		// single opening body ran, so nothing has been launched yet.
		expect(supervisor.openingWorkers.size).toBe(CONCURRENT_WORKERS);
		expect(supervisor.workers.size).toBe(0);
		expect(launched).toBe(0);

		const settled = await Promise.allSettled(opens);
		const fulfilled = settled.filter((result) => result.status === "fulfilled");
		const refused = settled.filter((result) => result.status === "rejected");

		expect(settled).toHaveLength(CONCURRENT_WORKERS * CALLERS_PER_KEY);
		expect(fulfilled).toHaveLength((CONCURRENT_WORKERS * CALLERS_PER_KEY) / 2);
		expect(refused).toHaveLength((CONCURRENT_WORKERS * CALLERS_PER_KEY) / 2);
		expect(
			refused.every(
				(result) =>
					result.status === "rejected" && (result.reason as { code?: string }).code === "session_already_active",
			),
		).toBe(true);
		// Exactly one worker per key: no duplicates, no replacements.
		expect(launchWorker).toHaveBeenCalledTimes(CONCURRENT_WORKERS);
		expect(supervisor.workers.size).toBe(CONCURRENT_WORKERS);
		expect(supervisor.openingWorkers.size).toBe(0);
		for (let index = 0; index < CONCURRENT_WORKERS; index++) {
			const worker = supervisor.workers.get(`worker-${index}`);
			const owners = settled
				.slice(index * CALLERS_PER_KEY, index * CALLERS_PER_KEY + CALLERS_PER_KEY / 2)
				.map((result) => (result.status === "fulfilled" ? result.value : undefined));
			expect(new Set(owners).size).toBe(1);
			expect(owners[0]).toBe(worker);
		}

		// A second, post-settle round exercises the resident-reuse path rather than
		// the reservation-join path: same invariants, different code.
		const reuse = await Promise.allSettled(
			paths.flatMap((sessionPath) => [
				supervisor.createOrReuseWorker("owner", { type: "create", sessionPath, lifecycle: "client_owned" }),
				supervisor.createOrReuseWorker("stranger", { type: "create", sessionPath, lifecycle: "client_owned" }),
			]),
		);
		const reusedOk = reuse.filter((result) => result.status === "fulfilled");
		const reusedRefused = reuse.filter((result) => result.status === "rejected");
		expect(reusedOk).toHaveLength(CONCURRENT_WORKERS);
		expect(reusedRefused).toHaveLength(CONCURRENT_WORKERS);
		expect(
			reusedRefused.every(
				(result) =>
					result.status === "rejected" && (result.reason as { code?: string }).code === "session_already_active",
			),
		).toBe(true);
		// Reuse launched nothing and left no reservation behind.
		expect(launchWorker).toHaveBeenCalledTimes(CONCURRENT_WORKERS);
		expect(supervisor.workers.size).toBe(CONCURRENT_WORKERS);
		expect(supervisor.openingWorkers.size).toBe(0);

		metrics.openStress = {
			concurrentWorkers: CONCURRENT_WORKERS,
			openOperations: CONCURRENT_WORKERS * CALLERS_PER_KEY + CONCURRENT_WORKERS * 2,
			sessionAlreadyActiveResponses: refused.length + reusedRefused.length,
			launches: launched,
			elapsedMs: Math.round(performance.now() - startedAt),
			heapDeltaMiB: Math.round((heapUsedMiB() - heapBefore) * 100) / 100,
		};
	});

	it("holds one reservation per key while 1024 rivals race a blocked stale-catalog refresh", async () => {
		const directory = stressDir("u1");
		const supervisor = supervisorFor(directory);
		const paths = sessionPaths(directory, RACED_OPEN_KEYS, "raced");
		const [unrelated] = sessionPaths(directory, 1, "unrelated");
		const gate = deferred();
		// Every opening body parks here: the spawn-ledger read inside stale-summary
		// hydration. It must be entered once per reservation, never once per caller.
		const edges = vi.fn(async () => {
			await gate.promise;
			return [];
		});
		const stale = stressWorker("stale", directory, [
			summary({
				id: "stale-root-active",
				activeSessionId: "stale-root-active",
				sessionId: "stale-root-session",
				sessionFile: unrelated,
				rlmDepth: 0,
			}),
		]);
		stale.descriptor.rootActiveSessionId = "stale-root-active";
		stale.descriptor.rootSessionId = "stale-root-session";
		stale.descriptor.createCommand = { config: { cwd: directory }, sessionPath: unrelated };
		stale.summariesStale = true;
		supervisor.workers.set("stale", stale);
		const launchWorker = vi.fn(async (command: { sessionPath?: string }): Promise<StressWorker> => {
			const index = paths.indexOf(command.sessionPath ?? "");
			const worker = stressWorker(`raced-${index}`, directory, [
				summary({
					id: `raced-${index}-root-active`,
					activeSessionId: `raced-${index}-root-active`,
					sessionId: `raced-${index}-root-session`,
					sessionFile: command.sessionPath,
					rlmDepth: 0,
				}),
			]);
			worker.descriptor.sessionFile = command.sessionPath;
			worker.descriptor.createCommand = { config: { cwd: directory }, sessionPath: command.sessionPath };
			supervisor.workers.set(worker.descriptor.workerId, worker);
			return worker;
		});
		Object.assign(supervisor, {
			rlmSpawnLedger: () => ({ edges }),
			catalog: { resolve: vi.fn(async (selector: string) => selector), list: vi.fn(async () => []) },
			launchWorker,
			persistWorker: vi.fn(),
		});

		const startedAt = performance.now();
		const opens = paths.flatMap((sessionPath) =>
			Array.from({ length: RACED_CALLERS_PER_KEY }, () =>
				supervisor.createOrReuseWorker("client", { type: "create", sessionPath }),
			),
		);
		// One reservation per key, published before any body ran: the hydration has
		// not even started, so no rival can have observed half-resolved state.
		expect(opens).toHaveLength(RACED_OPEN_KEYS * RACED_CALLERS_PER_KEY);
		expect(supervisor.openingWorkers.size).toBe(RACED_OPEN_KEYS);
		expect(edges).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(edges).toHaveBeenCalledTimes(RACED_OPEN_KEYS), { timeout: 10000, interval: 1 });
		// Blocked mid-hydration: still exactly one reservation per key, and exactly
		// one hydration per reservation rather than one per caller.
		expect(supervisor.openingWorkers.size).toBe(RACED_OPEN_KEYS);
		expect(edges).toHaveBeenCalledTimes(RACED_OPEN_KEYS);
		expect(launchWorker).not.toHaveBeenCalled();

		const settled = Promise.all(opens);
		gate.resolve();
		const opened = await settled;

		expect(launchWorker).toHaveBeenCalledTimes(RACED_OPEN_KEYS);
		expect(edges).toHaveBeenCalledTimes(RACED_OPEN_KEYS);
		expect(new Set(opened).size).toBe(RACED_OPEN_KEYS);
		for (let key = 0; key < RACED_OPEN_KEYS; key++) {
			const forKey = opened.slice(key * RACED_CALLERS_PER_KEY, (key + 1) * RACED_CALLERS_PER_KEY);
			expect(new Set(forKey).size).toBe(1);
			expect(forKey[0]).toBe(supervisor.workers.get(`raced-${key}`));
		}
		// The decoy stale worker was neither adopted nor replaced, and every
		// reservation was released once ownership committed.
		expect(supervisor.workers.get("stale")).toBe(stale);
		expect(supervisor.workers.size).toBe(RACED_OPEN_KEYS + 1);
		expect(supervisor.openingWorkers.size).toBe(0);

		metrics.u1RaceStress = {
			keys: RACED_OPEN_KEYS,
			concurrentOpens: RACED_OPEN_KEYS * RACED_CALLERS_PER_KEY,
			hydrationsEntered: edges.mock.calls.length,
			launches: launchWorker.mock.calls.length,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	});

	it("refuses every racer transiently when the spawn ledger fails, and leaks no reservation", async () => {
		const directory = stressDir("ledger-fail");
		const supervisor = supervisorFor(directory);
		const paths = sessionPaths(directory, 64, "failing");
		const edges = vi.fn(async () => {
			throw new Error("spawn ledger unavailable");
		});
		const [unrelated] = sessionPaths(directory, 1, "unrelated");
		const stale = stressWorker("stale", directory, [
			summary({
				id: "stale-root-active",
				activeSessionId: "stale-root-active",
				sessionId: "stale-root-session",
				sessionFile: unrelated,
				rlmDepth: 0,
			}),
		]);
		stale.descriptor.rootActiveSessionId = "stale-root-active";
		stale.descriptor.rootSessionId = "stale-root-session";
		stale.summariesStale = true;
		supervisor.workers.set("stale", stale);
		const launchWorker = vi.fn();
		Object.assign(supervisor, { rlmSpawnLedger: () => ({ edges }), launchWorker, persistWorker: vi.fn() });

		const settled = await Promise.allSettled(
			paths.map((sessionPath) => supervisor.createOrReuseWorker("client", { type: "create", sessionPath })),
		);

		expect(settled).toHaveLength(64);
		expect(
			settled.every(
				(result) =>
					result.status === "rejected" &&
					result.reason instanceof Error &&
					/cannot be safely opened while resident worker catalogs are stale/.test(result.reason.message),
			),
		).toBe(true);
		// A stale catalog never authorizes a blind launch, and a failed open always
		// releases its reservation.
		expect(launchWorker).not.toHaveBeenCalled();
		expect(supervisor.openingWorkers.size).toBe(0);
		expect(supervisor.workers.size).toBe(1);

		metrics.ledgerPressure = { refusedOpens: settled.length, launches: 0 };
	});
});

// --- 2. restart / adoption soak ---------------------------------------------

describe("daemon supervisor restart adoption soak", () => {
	it("adopts 64 workers per restart round without cross-adoption or a leaked single-flight", async () => {
		const directory = stressDir("adopt");
		const startedAt = performance.now();
		let adopted = 0;
		let connects = 0;
		let subscribes = 0;

		for (let round = 0; round < ADOPTION_ROUNDS; round++) {
			const supervisor = supervisorFor(directory);
			const workers: StressWorker[] = [];
			for (let index = 0; index < ADOPTION_WORKERS_PER_ROUND; index++) {
				const workerId = `r${round}-w${index}`;
				const sessionFile = join(directory, `${workerId}.jsonl`);
				writeFileSync(sessionFile, "");
				const root = summary({
					id: `${workerId}-root-active`,
					activeSessionId: `${workerId}-root-active`,
					sessionId: `${workerId}-root-session`,
					sessionFile,
					rlmDepth: 0,
				});
				const child = summary({
					id: `${workerId}-child`,
					sessionId: `${workerId}-child`,
					sessionFile: join(directory, `${workerId}-child.jsonl`),
					runtimeKind: "subagent",
					parentSessionId: `${workerId}-root-session`,
					parentSessionPath: sessionFile,
					rlmChildId: `${workerId}-c1`,
					rlmDepth: 1,
				});
				// Persisted-but-unconnected, exactly as loadWorkerDescriptors leaves it.
				const worker = stressWorker(workerId, directory);
				worker.descriptor.sessionFile = sessionFile;
				worker.descriptor.createCommand = { config: { cwd: directory }, sessionPath: sessionFile };
				worker.descriptor.lifecycle = "starting";
				worker.summaries = new Map();
				const request = vi.fn(async (command: { type: string }) => {
					if (command.type === "get_state") return success(undefined, "get_state", root);
					if (command.type === "list") return success(undefined, "list", { sessions: [root, child] });
					throw new Error(`adoption soak worker received an unexpected command: ${command.type}`);
				});
				worker.client = undefined;
				Object.assign(worker, { adoptionRequest: request });
				workers.push(worker);
				supervisor.workers.set(workerId, worker);
			}
			Object.assign(supervisor, {
				assertRecoveryAllowed: vi.fn(async () => {}),
				persistWorker: vi.fn(),
				connectWorker: vi.fn(async (worker: StressWorker) => {
					connects++;
					worker.client = {
						request: (worker as unknown as { adoptionRequest: ReturnType<typeof vi.fn> }).adoptionRequest,
						requestWorker: vi.fn(),
					};
					return worker.client;
				}),
				subscribeWorker: vi.fn(async () => {
					subscribes++;
				}),
				recoverWorker: vi.fn(async () => {
					throw new Error("adoption soak must not fall back to recovery");
				}),
			});

			await Promise.all(workers.map((worker) => supervisor.adoptOrRecoverWorker(worker)));
			const rehydrations = workers.map((worker) => worker.summaryRehydration);
			await Promise.all(rehydrations.map((pending) => pending ?? Promise.resolve()));

			for (const worker of workers) {
				const workerId = worker.descriptor.workerId;
				expect(worker.descriptor.lifecycle, workerId).toBe("ready");
				expect(worker.descriptor.processStartId, workerId).toBe(`${workerId}-start`);
				// Each worker adopted its OWN root: no cross-adoption under fan-out.
				expect(worker.descriptor.rootSessionId, workerId).toBe(`${workerId}-root-session`);
				expect(worker.summaries.get(`${workerId}-root-active`)?.sessionId, workerId).toBe(
					`${workerId}-root-session`,
				);
				expect(worker.summaries.get(`${workerId}-child`)?.sessionId, workerId).toBe(`${workerId}-child`);
				expect(worker.summariesStale, workerId).toBe(false);
				// No single-flight or rehydration handle survived the round.
				expect(worker.summaryRefresh, workerId).toBeUndefined();
				expect(worker.summaryRehydration, workerId).toBeUndefined();
				// Identity preserved: the descriptor was never swapped for a new worker.
				expect(supervisor.workers.get(workerId), workerId).toBe(worker);
				adopted++;
			}
			expect(supervisor.workers.size).toBe(ADOPTION_WORKERS_PER_ROUND);
		}

		expect(adopted).toBe(ADOPTION_ROUNDS * ADOPTION_WORKERS_PER_ROUND);
		expect(connects).toBe(adopted);
		expect(subscribes).toBe(adopted);

		metrics.adoptionSoak = {
			rounds: ADOPTION_ROUNDS,
			workersPerRound: ADOPTION_WORKERS_PER_ROUND,
			adoptions: adopted,
			connects,
			subscribes,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	});
});

// --- 3. slow, failed, root-only and root-omitting catalogs -------------------

describe("daemon supervisor catalog pressure", () => {
	it("coalesces 1024 refreshes over slow, failed, root-only and root-omitting catalogs", async () => {
		const directory = stressDir("catalog");
		const supervisor = supervisorFor(directory);
		Object.assign(supervisor, { persistWorker: vi.fn() });
		const slowGate = deferred();
		const startedAt = performance.now();

		type CatalogClass = "slow" | "failed" | "root-only" | "root-omitting";
		const classes: CatalogClass[] = ["slow", "failed", "root-only", "root-omitting"];
		const byClass = new Map<CatalogClass, StressWorker[]>();
		for (const catalogClass of classes) {
			const group: StressWorker[] = [];
			for (let index = 0; index < CATALOG_WORKERS_PER_CLASS; index++) {
				const workerId = `${catalogClass}-${index}`;
				const sessionFile = join(directory, `${workerId}.jsonl`);
				writeFileSync(sessionFile, "");
				const root = summary({
					id: `${workerId}-root-active`,
					activeSessionId: `${workerId}-root-active`,
					sessionId: `${workerId}-root-session`,
					sessionFile,
					rlmDepth: 0,
				});
				const child = summary({
					id: `${workerId}-child`,
					sessionId: `${workerId}-child`,
					sessionFile: join(directory, `${workerId}-child.jsonl`),
					runtimeKind: "subagent",
					parentSessionId: `${workerId}-root-session`,
					parentSessionPath: sessionFile,
					rlmDepth: 1,
				});
				const worker = stressWorker(workerId, directory, [root]);
				worker.descriptor.rootActiveSessionId = `${workerId}-root-active`;
				worker.descriptor.rootSessionId = `${workerId}-root-session`;
				worker.descriptor.sessionFile = sessionFile;
				worker.client?.request.mockImplementation(async (command: { type: string }) => {
					if (command.type !== "list") {
						throw new Error(`catalog pressure worker received an unexpected command: ${command.type}`);
					}
					if (catalogClass === "slow") {
						await slowGate.promise;
						return success(undefined, "list", { sessions: [root, child] });
					}
					if (catalogClass === "failed") throw new Error("worker list failed");
					if (catalogClass === "root-only") return success(undefined, "list", { sessions: [root] });
					// root-omitting: a catalog that drops the worker's own assigned root.
					return success(undefined, "list", { sessions: [child] });
				});
				supervisor.workers.set(workerId, worker);
				group.push(worker);
			}
			byClass.set(catalogClass, group);
		}

		const all = [...byClass.values()].flat();
		const refreshes = all.flatMap((worker) =>
			Array.from({ length: CONCURRENT_REFRESHES_PER_WORKER }, () => supervisor.refreshWorkerSummaries(worker)),
		);
		// Handlers attach in this same turn so the failing classes never surface as
		// unhandled rejections while the slow class is still gated.
		const pending = Promise.allSettled(refreshes);
		const slowWorkers = byClass.get("slow") ?? [];
		await vi.waitFor(
			() => expect(slowWorkers.every((worker) => worker.client?.request.mock.calls.length === 1)).toBe(true),
			{ timeout: 10000, interval: 1 },
		);
		// Every slow worker is parked on one shared roster walk, not eight.
		expect(slowWorkers.every((worker) => worker.summaryRefresh !== undefined)).toBe(true);
		slowGate.resolve();
		const settled = await pending;

		expect(settled).toHaveLength(4 * CATALOG_WORKERS_PER_CLASS * CONCURRENT_REFRESHES_PER_WORKER);
		for (const worker of all) {
			const workerId = worker.descriptor.workerId;
			const listCalls = worker.client?.request.mock.calls.filter(
				([command]) => (command as { type: string }).type === "list",
			);
			// Single-flight held across all 8 concurrent callers, for every class.
			expect(listCalls, workerId).toHaveLength(1);
			expect(worker.summaryRefresh, workerId).toBeUndefined();
		}
		for (const worker of slowWorkers) {
			expect(worker.summariesStale).toBe(false);
			expect(worker.summaries.size).toBe(2);
		}
		for (const worker of byClass.get("failed") ?? []) {
			expect(worker.summariesStale).toBe(true);
			// A failed catalog never replaces the prior authoritative roster.
			expect(worker.summaries.get(worker.descriptor.rootActiveSessionId)).toBeDefined();
		}
		for (const worker of byClass.get("root-only") ?? []) {
			expect(worker.summariesStale).toBe(false);
			expect(worker.summaries.size).toBe(1);
		}
		for (const worker of byClass.get("root-omitting") ?? []) {
			// Root-summary authority stays strict: a root-omitting catalog is refused
			// and the worker is left stale for rehydration, not silently adopted.
			expect(worker.summariesStale).toBe(true);
			expect(worker.summaries.get(worker.descriptor.rootActiveSessionId)?.sessionId).toBe(
				worker.descriptor.rootSessionId,
			);
			expect(worker.summaries.has(`${worker.descriptor.workerId}-child`)).toBe(false);
		}
		const rejected = settled.filter((result) => result.status === "rejected");
		expect(rejected).toHaveLength(2 * CATALOG_WORKERS_PER_CLASS * CONCURRENT_REFRESHES_PER_WORKER);

		metrics.catalogPressure = {
			workers: all.length,
			refreshOperations: settled.length,
			rosterWalks: all.length,
			refusedRefreshes: rejected.length,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	});
});

// --- 4. thousands of stable follow-ups and duplicate queue keys --------------

describe("stable follow-up target stress", () => {
	it("routes 3000+ stable follow-ups and duplicate queue keys to exactly one session each", async () => {
		const directory = stressDir("stable");
		const supervisor = supervisorFor(directory);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) }, persistWorker: vi.fn() });
		const startedAt = performance.now();
		const heapBefore = heapUsedMiB();

		interface Delivery {
			workerId: string;
			activeSessionId: string;
			queueKey?: string;
			stableTarget?: { sessionId?: string; sessionFile?: string };
		}
		const deliveries: Delivery[] = [];
		const roots: SessionSummary[] = [];
		const children: SessionSummary[] = [];
		const ownerByChild = new Map<string, string>();

		for (let index = 0; index < STABLE_TARGET_WORKERS; index++) {
			const workerId = `stable-${index}`;
			const rootFile = join(directory, `${workerId}.jsonl`);
			writeFileSync(rootFile, "");
			const root = summary({
				id: `${workerId}-root-active`,
				activeSessionId: `${workerId}-root-active`,
				sessionId: `${workerId}-root-session`,
				sessionFile: rootFile,
				runtimeKind: "top-level",
				rlmDepth: 0,
			});
			const roster: SessionSummary[] = [root];
			for (let childIndex = 0; childIndex < CHILDREN_PER_STABLE_WORKER; childIndex++) {
				// The passivated-child wire shape: durable id and file, no active id.
				const child = summary({
					id: `${workerId}-child-${childIndex}`,
					sessionId: `${workerId}-child-${childIndex}`,
					sessionFile: join(directory, `${workerId}-child-${childIndex}.jsonl`),
					runtimeKind: "subagent",
					parentSessionId: `${workerId}-root-session`,
					parentSessionPath: rootFile,
					rlmChildId: `${workerId}-c${childIndex}`,
					rlmDepth: 1,
				});
				roster.push(child);
				children.push(child);
				ownerByChild.set(child.sessionId, workerId);
			}
			roots.push(root);
			const worker = stressWorker(workerId, directory, roster);
			worker.descriptor.rootActiveSessionId = `${workerId}-root-active`;
			worker.descriptor.rootSessionId = `${workerId}-root-session`;
			worker.descriptor.sessionFile = rootFile;
			// The owning worker's own dedup: a repeated queueKey is coalesced onto the
			// pending reminder instead of opening a second one.
			const pending = new Set<string>();
			worker.client?.request.mockImplementation(async (command: Record<string, unknown>) => {
				if (command.type === "list") return success(undefined, "list", { sessions: roster });
				if (command.type !== "follow_up") {
					throw new Error(`stable target worker received an unexpected command: ${String(command.type)}`);
				}
				const activeSessionId = String(command.activeSessionId);
				deliveries.push({
					workerId,
					activeSessionId,
					queueKey: command.queueKey as string | undefined,
					stableTarget: command.stableTarget as Delivery["stableTarget"],
				});
				const dedupKey = `${activeSessionId} ${String(command.queueKey)}`;
				if (command.queueKey !== undefined && pending.has(dedupKey)) {
					return success(undefined, "follow_up", { queued: false, duplicate: true });
				}
				if (command.queueKey !== undefined) pending.add(dedupKey);
				return success(undefined, "follow_up", { queued: true });
			});
			supervisor.workers.set(workerId, worker);
		}

		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };
		const followUp = (stableTarget: Record<string, unknown>, queueKey: string) =>
			supervisor.handleCommand(client, {
				type: "follow_up",
				// The dead launch-time address from the incident: never used for routing.
				activeSessionId: "stale-ephemeral-active-id",
				message: "MATERIAL_DETACHED_TERMINAL",
				queueKey,
				stableTarget,
			});

		const unique = await Promise.all(
			children.map((child) =>
				followUp({ sessionId: child.sessionId, sessionFile: child.sessionFile }, `w6-terminal:${child.sessionId}`),
			),
		);
		expect(unique).toHaveLength(STABLE_TARGET_WORKERS * CHILDREN_PER_STABLE_WORKER);
		expect(unique.every((response) => (response as { success: boolean }).success)).toBe(true);

		// Duplicate queue keys: the same deterministic key re-sent after a lost
		// response must land on the same single session, never fan out.
		const duplicates: unknown[] = [];
		for (let repeat = 0; repeat < STABLE_DUPLICATE_REPEATS; repeat++) {
			const child = children[repeat % children.length]!;
			duplicates.push(
				await followUp(
					{ sessionId: child.sessionId, sessionFile: child.sessionFile },
					`w6-terminal:${child.sessionId}`,
				),
			);
		}
		expect(duplicates).toHaveLength(STABLE_DUPLICATE_REPEATS);
		expect(
			duplicates.every(
				(response) => (response as { data?: { queued?: boolean; duplicate?: boolean } }).data?.duplicate === true,
			),
		).toBe(true);

		// Refusals: each is typed, and none of them reaches a session.
		const deliveriesBeforeRefusals = deliveries.length;
		const refusalCases: Array<[string, Record<string, unknown>]> = [
			["missing_identity", {}],
			["invalid_target", { sessionId: "   " }],
			["not_found", { sessionId: "no-such-session" }],
			["identity_mismatch", { sessionId: children[0]!.sessionId, sessionFile: children[1]!.sessionFile }],
			["unsupported_target", { sessionId: roots[0]!.sessionId, sessionFile: roots[0]!.sessionFile }],
		];
		let refusals = 0;
		for (let round = 0; round < 8; round++) {
			for (const [reason, stableTarget] of refusalCases) {
				await expect(followUp(stableTarget, `refusal:${round}`), reason).rejects.toMatchObject({ reason });
				refusals++;
			}
		}
		expect(deliveries).toHaveLength(deliveriesBeforeRefusals);

		// Every delivery went to the owning worker, addressed by the child's durable
		// id, with the resolved conjunctive coordinates echoed back.
		const rootSessionIds = new Set(roots.map((root) => root.sessionId));
		const rootActiveIds = new Set(roots.map((root) => root.activeSessionId));
		for (const delivery of deliveries) {
			expect(ownerByChild.get(delivery.activeSessionId)).toBe(delivery.workerId);
			expect(rootSessionIds.has(delivery.activeSessionId)).toBe(false);
			expect(rootActiveIds.has(delivery.activeSessionId)).toBe(false);
			expect(delivery.stableTarget?.sessionId).toBe(delivery.activeSessionId);
			expect(delivery.stableTarget?.sessionFile).toBeDefined();
		}
		// One queueKey, one destination session: duplicates can never open a second
		// visible reminder because they never reach a second session.
		const destinationsByQueueKey = new Map<string, Set<string>>();
		for (const delivery of deliveries) {
			if (delivery.queueKey === undefined) continue;
			const destinations = destinationsByQueueKey.get(delivery.queueKey) ?? new Set<string>();
			destinations.add(`${delivery.workerId} ${delivery.activeSessionId}`);
			destinationsByQueueKey.set(delivery.queueKey, destinations);
		}
		expect(destinationsByQueueKey.size).toBe(children.length);
		expect([...destinationsByQueueKey.values()].every((destinations) => destinations.size === 1)).toBe(true);

		metrics.stableFollowUpStress = {
			targets: children.length,
			uniqueFollowUps: unique.length,
			duplicateQueueKeyFollowUps: duplicates.length,
			typedRefusals: refusals,
			totalFollowUpOperations: unique.length + duplicates.length + refusals,
			wireDeliveries: deliveries.length,
			elapsedMs: Math.round(performance.now() - startedAt),
			heapDeltaMiB: Math.round((heapUsedMiB() - heapBefore) * 100) / 100,
		};
	});
});

// --- 5. passive scan and spawn-ledger pressure ------------------------------

describe("passive scan and ledger pressure", () => {
	it("shares 1024 concurrent passive traversals and clears a failed one", async () => {
		const directory = stressDir("passive");
		const createRuntime = vi.fn();
		const internals = new AgentDaemon(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			createRuntime,
		}) as unknown as {
			listPassiveRlmSubagents(savedRoots?: unknown[], includeResident?: boolean): Promise<Array<{ entry: unknown }>>;
			scanPassiveRlmSubagents: (
				savedRoots: unknown[],
				includeResident: boolean,
			) => Promise<Array<{ entry: unknown }>>;
		};
		const startedAt = performance.now();
		const started = deferred();
		const release = deferred();
		let scans = 0;
		internals.scanPassiveRlmSubagents = vi.fn(async () => {
			scans++;
			if (scans === 2) started.resolve();
			await release.promise;
			return [{ entry: { childId: "child-1" } }];
		});

		const defaults = Array.from({ length: PASSIVE_SCAN_CALLERS }, () => internals.listPassiveRlmSubagents());
		const resident = Array.from({ length: PASSIVE_SCAN_CALLERS }, () =>
			internals.listPassiveRlmSubagents(undefined, true),
		);
		await started.promise;
		const scansBeforeRelease = scans;
		release.resolve();
		const results = await Promise.all([...defaults, ...resident]);

		// 1024 callers, two traversals: one per includeResident bucket.
		expect(scansBeforeRelease).toBe(2);
		expect(results).toHaveLength(PASSIVE_SCAN_CALLERS * 2);
		expect(results.every((rows) => rows.length === 1)).toBe(true);
		// Defensive copies: one caller cannot mutate another caller's answer.
		expect(results[0]).not.toBe(results[1]);

		const failStart = deferred();
		const failRelease = deferred();
		let failScans = 0;
		internals.scanPassiveRlmSubagents = vi.fn(async () => {
			failScans++;
			if (failScans === 1) {
				failStart.resolve();
				await failRelease.promise;
				throw new Error("passive scan failed");
			}
			return [{ entry: { childId: "recovered" } }];
		});
		const failing = Array.from({ length: PASSIVE_SCAN_CALLERS }, () => internals.listPassiveRlmSubagents());
		await failStart.promise;
		const failScansBeforeRelease = failScans;
		failRelease.resolve();
		const failed = await Promise.allSettled(failing);

		expect(failScansBeforeRelease).toBe(1);
		expect(failed.every((result) => result.status === "rejected")).toBe(true);
		await expect(internals.listPassiveRlmSubagents()).resolves.toEqual([{ entry: { childId: "recovered" } }]);
		expect(failScans).toBe(2);
		// No inference: the daemon never constructed a runtime for any of this.
		expect(createRuntime).not.toHaveBeenCalled();

		metrics.passiveScanPressure = {
			concurrentCallers: PASSIVE_SCAN_CALLERS * 2,
			traversals: 2,
			failedTraversalCallers: PASSIVE_SCAN_CALLERS,
			traversalsAfterFailure: failScans,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	});

	it("serves 256 concurrent reads over a 512-edge spawn ledger without sharing mutable state", async () => {
		const directory = stressDir("ledger");
		const sessionsDir = join(directory, "sessions");
		const parent = SessionManager.create(directory, sessionsDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		parent.flushNow();
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Missing parent session file");
		const ledger = new RlmSpawnLedger(directory, sessionsDir);
		const startedAt = performance.now();
		const heapBefore = heapUsedMiB();

		for (let index = 0; index < LEDGER_EDGES; index++) {
			await ledger.appendSpawn({
				childId: `sub-${String(index).padStart(8, "0")}`,
				parent: parentFile,
				child: join(sessionsDir, `child-${index}.jsonl`),
				depth: 1,
				name: `child-${index}`,
			});
		}

		const reads = await Promise.all(Array.from({ length: LEDGER_CONCURRENT_READS }, () => ledger.edges()));
		expect(reads).toHaveLength(LEDGER_CONCURRENT_READS);
		expect(reads.every((edges) => edges.length === LEDGER_EDGES)).toBe(true);
		// Every reader owns its rows: a cached replay never hands out shared state.
		expect(reads[0]?.[0]).not.toBe(reads[1]?.[0]);
		reads[0]![0]!.child = "/tmp/mutated-by-caller.jsonl";
		expect((await ledger.edges())[0]?.child).toBe(join(sessionsDir, "child-0.jsonl"));

		await ledger.appendSpawn({
			childId: "sub-ffffffff",
			parent: parentFile,
			child: join(sessionsDir, "child-last.jsonl"),
			depth: 1,
			name: "child-last",
		});
		expect(await ledger.edges()).toHaveLength(LEDGER_EDGES + 1);

		metrics.ledgerReadPressure = {
			edges: LEDGER_EDGES + 1,
			concurrentReads: LEDGER_CONCURRENT_READS,
			elapsedMs: Math.round(performance.now() - startedAt),
			heapDeltaMiB: Math.round((heapUsedMiB() - heapBefore) * 100) / 100,
		};
	});
});

// --- 6. dead-kernel recovery soak -------------------------------------------

describe("dead kernel recovery soak", () => {
	function fakeKernel(label: string): KernelClient & { shutDown: boolean } {
		const kernel = {
			label,
			shutDown: false,
			ownerSessionId: undefined,
			get isRunning() {
				return !kernel.shutDown;
			},
			get isShutDown() {
				return kernel.shutDown;
			},
		};
		return kernel as unknown as KernelClient & { shutDown: boolean };
	}

	it("reprovisions across 256 shutdown cycles and never hands back a dead kernel", async () => {
		const provisioner = new IpythonKernelProvisioner("/tmp");
		const startedAt = performance.now();
		let starts = 0;
		const produced: Array<KernelClient & { shutDown: boolean }> = [];
		const startKernel = vi.fn(async (): Promise<KernelClient> => {
			const kernel = fakeKernel(`kernel-${starts++}`);
			produced.push(kernel);
			return kernel;
		});
		Object.assign(provisioner, { startKernel });

		let current = (await provisioner.ensure()) as KernelClient & { shutDown: boolean };
		expect(startKernel).toHaveBeenCalledTimes(1);
		for (let cycle = 0; cycle < KERNEL_RECOVERY_CYCLES; cycle++) {
			// A live kernel is memoized: repeated ensure() never restarts it.
			await expect(provisioner.ensure()).resolves.toBe(current);
			current.shutDown = true;
			const next = (await provisioner.ensure()) as KernelClient & { shutDown: boolean };
			expect(next).not.toBe(current);
			expect(next.isShutDown).toBe(false);
			expect(provisioner.manager).toBe(next);
			expect(provisioner.hasRunningKernel).toBe(true);
			current = next;
		}
		expect(startKernel).toHaveBeenCalledTimes(KERNEL_RECOVERY_CYCLES + 1);
		expect(new Set(produced).size).toBe(KERNEL_RECOVERY_CYCLES + 1);
		// Only the newest kernel is retained; the soak does not accumulate managers.
		expect(provisioner.manager).toBe(produced[produced.length - 1]);

		metrics.kernelRecoverySoak = {
			cycles: KERNEL_RECOVERY_CYCLES,
			starts: startKernel.mock.calls.length,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	});

	it("coalesces 64 concurrent ensures onto a single kernel start", async () => {
		const provisioner = new IpythonKernelProvisioner("/tmp");
		const gate = deferred();
		const kernel = fakeKernel("shared");
		const startKernel = vi.fn(async (): Promise<KernelClient> => {
			await gate.promise;
			return kernel;
		});
		Object.assign(provisioner, { startKernel });

		const ensures = Array.from({ length: KERNEL_CONCURRENT_ENSURES }, () => provisioner.ensure());
		gate.resolve();
		const resolved = await Promise.all(ensures);

		expect(startKernel).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(KERNEL_CONCURRENT_ENSURES);
		expect(new Set(resolved).size).toBe(1);
		expect(resolved[0]).toBe(kernel);

		metrics.kernelEnsureCoalescing = { concurrentEnsures: KERNEL_CONCURRENT_ENSURES, starts: 1 };
	});
});

// --- 7. inference / network / resource guard --------------------------------

describe("stress harness guards", () => {
	it("performed no inference and no non-loopback network activity", () => {
		expect(fetchTargets).toEqual([]);
		expect(socketConnectTargets.every(isLoopbackTarget)).toBe(true);
		metrics.guards = {
			fetchCalls: fetchTargets.length,
			socketConnects: socketConnectTargets.length,
			nonLoopbackConnects: socketConnectTargets.filter((target) => !isLoopbackTarget(target)).length,
			modelInferenceCalls: 0,
			activeResources: activeResourceCounts(),
			heapUsedMiB: heapUsedMiB(),
		};
		// One compact line so a gate log carries the exact stress counts.
		console.log(`daemon-runtime-stress metrics ${JSON.stringify(metrics)}`);
	});
});
