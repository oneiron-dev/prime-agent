import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentFamilyCatalogEntry,
	assertAgentFamilyReach,
	sessionNameReservationKey,
} from "../src/core/agent-messages.js";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonServerCapability,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	openingWorkers: Map<string, Promise<WorkerFixture>>;
	start(): Promise<void>;
	cleanupSupervisorResources(): Promise<void>;
	refreshWorkerSummaries(worker: WorkerFixture, allowFresh?: boolean): Promise<void>;
	findSummaryInWorker(worker: WorkerFixture, selector: string): SessionSummary | undefined;
	createOrReuseWorker(
		clientId: string,
		command: { type: "create"; name?: string; sessionPath?: string; lifecycle?: "client_owned" },
	): Promise<WorkerFixture>;
	assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void>;
	assertSavedSiblingNameAvailable(
		siblings: Array<Record<string, unknown>>,
		target: Record<string, unknown>,
		name: string,
	): void;
	familyCatalogEntry(summary: SessionSummary): AgentFamilyCatalogEntry;
	handleCommand(client: object, command: Record<string, unknown>): Promise<unknown>;
	seedRosterLedger(): Promise<void>;
}

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "ready" | "starting";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		authenticationToken: string;
		ownerClientId?: string;
		/** Set by the stable-target tests to make the owning worker unavailable. */
		stopRequestedAt?: string;
		createCommand: { config: { cwd: string }; sessionPath?: string };
	};
	client: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
	};
	/** The worker's own capability proof, exactly as connectWorker retains it. */
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

/**
 * What a session worker built from the current binary actually greets the
 * supervisor with: protocol 7, schema 24, and the negotiated capability set.
 */
function currentWorkerHello(): NonNullable<WorkerFixture["hello"]> {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
	};
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

function worker(workerId: string, summaries: SessionSummary[] = []): WorkerFixture {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root-active`,
			rootSessionId: `${workerId}-root-session`,
			pid: 1,
			authenticationToken: `${workerId}-token`,
			createCommand: { config: { cwd: "/tmp/project" } },
		},
		client: {
			request: vi.fn(),
			requestWorker: vi.fn(),
		},
		hello: currentWorkerHello(),
		summaries: new Map(summaries.map((entry) => [entry.activeSessionId ?? entry.id, entry])),
	};
}

describe("daemon supervisor passive subagent topology", () => {
	it("finds a child summary by its displayed session ID suffix", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-suffix-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const child = summary({
			id: "bbbb6666777788889999cccc",
			activeSessionId: "bbbb6666777788889999cccc",
			sessionId: "aaaa6666777788889999dddd",
		});
		const resident = worker("first", [child]);
		seedSupervisorRoster(supervisor, resident);

		expect(supervisor.findSummaryInWorker(resident, "88889999cccc")).toEqual({ ...child, rosterStatus: "idle" });
	});

	it("rejects an explicit root name that collides with a saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});
		await supervisor.seedRosterLedger();

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "duplicate-root" }),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("rejects a forked root name that collides with another saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-forked-root-name-"));
		tempDirs.push(directory);
		const sourceManager = SessionManager.create(directory, join(directory, "sessions"));
		sourceManager.newSession({ rlmDepth: 0 });
		sourceManager.flushNow();
		const sourcePath = sourceManager.getSessionFile();
		if (!sourcePath) throw new Error("Missing source session path");
		const forkedManager = SessionManager.forkFrom(sourcePath, directory, join(directory, "sessions"));
		const forkedPath = forkedManager.getSessionFile();
		if (!forkedPath) throw new Error("Missing forked session path");
		const forkedInfo = await readSessionInfo(forkedPath);
		if (!forkedInfo) throw new Error("Missing forked session info");
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => [forkedInfo]),
				list: vi.fn(async () => [
					{
						id: "other-root",
						name: "duplicate-root",
						path: join(directory, "other.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
						rlmDepth: 0,
					},
				]),
			},
		});
		await supervisor.seedRosterLedger();

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(forkedPath, "duplicate-root")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("normalizes explicit root names before supervisor validation and launch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-normalized-root-name-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			catalog: {
				list: vi.fn(async () => [
					{
						id: "saved-root",
						name: "duplicate-root",
						path: join(directory, "saved.jsonl"),
						cwd: directory,
						created: new Date(0),
						modified: new Date(0),
						messageCount: 0,
						firstMessage: "",
						allMessagesText: "",
					},
				]),
			},
			launchWorker,
		});
		await supervisor.seedRosterLedger();

		await expect(
			supervisor.createOrReuseWorker("client", { type: "create", name: "  duplicate-root  " }),
		).rejects.toThrow('Agent name "duplicate-root" is unavailable');
		await expect(supervisor.createOrReuseWorker("client", { type: "create", name: "   " })).rejects.toThrow(
			"Session name cannot be empty",
		);
		expect(launchWorker).not.toHaveBeenCalled();
	});

	it("checks inactive root renames against every saved root", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-root-rename-"));
		tempDirs.push(directory);
		const targetPath = join(directory, "target.jsonl");
		const duplicatePath = join(directory, "duplicate.jsonl");
		const target = {
			id: "target",
			path: targetPath,
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		const duplicate = { ...target, id: "duplicate", path: duplicatePath, name: "taken" };
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async () => [target]),
			catalog: {
				list: vi.fn(async () => [target, duplicate]),
			},
		});
		await supervisor.seedRosterLedger();

		await expect(supervisor.assertSupervisorSavedSessionNameAvailable(targetPath, "taken")).rejects.toThrow(
			"an agent of that name already exists at depth 0 under this parent",
		);
	});

	it("retains a legacy child's parent edge when its depth is unknown", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-family-"));
		tempDirs.push(directory);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const parentPath = join(directory, "parent.jsonl");
		const child = supervisor.familyCatalogEntry(
			summary({
				id: "legacy-child-active",
				sessionId: "legacy-child",
				parentSessionPath: parentPath,
			}),
		);
		const parent = supervisor.familyCatalogEntry(
			summary({ id: "parent-active", sessionId: "parent", sessionFile: parentPath, rlmDepth: 0 }),
		);
		const unrelated = supervisor.familyCatalogEntry(
			summary({ id: "unrelated-active", sessionId: "unrelated", rlmDepth: 0 }),
		);
		const forkedRoot = supervisor.familyCatalogEntry(
			summary({
				id: "forked-root-active",
				sessionId: "forked-root",
				parentSessionPath: parentPath,
				rlmDepth: 0,
			}),
		);

		expect(child).toMatchObject({ depth: 1, parentSessionPath: parent.sessionPath });
		expect(forkedRoot).not.toHaveProperty("parentSessionPath");
		expect(() => assertAgentFamilyReach(child, parent)).not.toThrow();
		expect(() => assertAgentFamilyReach(child, unrelated)).toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
	});

	it("compares legacy and modern saved siblings at one neutral depth", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-legacy-sibling-name-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const base = {
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		const target = { ...base, id: "target", path: join(directory, "target.jsonl"), parentSessionPath, rlmDepth: 1 };
		const legacy = { ...base, id: "legacy", path: join(directory, "legacy.jsonl"), parentSessionPath, name: "taken" };
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;

		expect(() => supervisor.assertSavedSiblingNameAvailable([target, legacy], target, "taken")).toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);
	});

	it("publishes an opening reservation before named create validation awaits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-named-create-race-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseNameValidation!: () => void;
		const nameValidationGate = new Promise<void>((resolve) => {
			releaseNameValidation = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const resident = worker("opened");
		const launchWorker = vi.fn(async () => resident);
		// Named-create validation reads the family catalog through the catalog
		// client, so gating `list` parks the open inside that validation — which is
		// the window this test is about.
		const listSavedSessions = vi.fn(async () => {
			await nameValidationGate;
			return [];
		});
		Object.assign(supervisor, {
			catalog: {
				resolve: vi.fn(async () => sessionPath),
				siblings: vi.fn(async () => []),
				list: listSavedSessions,
			},
			launchWorker,
		});

		const first = supervisor.createOrReuseWorker("client", { type: "create", name: "named", sessionPath });
		// By the time the named create is awaiting its validation, the opening
		// reservation is already published.
		await vi.waitFor(() => expect(listSavedSessions).toHaveBeenCalled(), { timeout: 5000, interval: 5 });
		expect(supervisor.openingWorkers.size).toBe(1);
		// A rival half-started registration for the same saved path, with an
		// authoritative root catalog of its own. It still cannot serve a create
		// while it is starting, so the live reservation must win.
		const starting = worker("starting", [
			summary({
				id: "starting-root-active",
				activeSessionId: "starting-root-active",
				sessionId: "starting-root-session",
				sessionFile: sessionPath,
				rlmDepth: 0,
			}),
		]);
		starting.descriptor.lifecycle = "starting";
		starting.descriptor.createCommand = { config: { cwd: "/tmp/project" }, sessionPath };
		supervisor.workers.set(starting.descriptor.workerId, starting);
		const second = supervisor.createOrReuseWorker("client", { type: "create", sessionPath });
		releaseNameValidation();
		expect(await Promise.all([first, second])).toEqual([resident, resident]);
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	/**
	 * A resident worker whose catalog is stale, owning some *other* saved path.
	 * Its presence is what forces `createOrReuseWorker` through
	 * `refreshRelevantStaleWorkerSummaries`, whose spawn-ledger read is the slow,
	 * blockable await the opening reservation has to survive.
	 */
	function staleCatalogWorker(directory: string): WorkerFixture {
		const other = join(directory, "other.jsonl");
		const stale = worker("stale", [
			summary({
				id: "stale-root-active",
				activeSessionId: "stale-root-active",
				sessionId: "stale-root-session",
				sessionFile: other,
				rlmDepth: 0,
			}),
		]);
		stale.descriptor.rootActiveSessionId = "stale-root-active";
		stale.descriptor.rootSessionId = "stale-root-session";
		stale.descriptor.createCommand = { config: { cwd: directory }, sessionPath: other };
		stale.summariesStale = true;
		return stale;
	}

	it("holds the opening reservation across a blocked stale-catalog refresh", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stale-refresh-race-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseEdges!: () => void;
		const edgesGate = new Promise<void>((resolve) => {
			releaseEdges = resolve;
		});
		// The spawn-ledger read inside the stale-summary hydration never completes
		// until this test says so: the whole open is parked on it.
		const edges = vi.fn(async () => {
			await edgesGate;
			return [];
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("stale", staleCatalogWorker(directory));
		const resident = worker("opened");
		const launchWorker = vi.fn(async () => {
			supervisor.workers.set(resident.descriptor.workerId, resident);
			return resident;
		});
		Object.assign(supervisor, {
			rlmSpawnLedger: () => ({ edges }),
			catalog: {
				resolve: vi.fn(async () => sessionPath),
				siblings: vi.fn(async () => []),
				list: vi.fn(async () => []),
			},
			launchWorker,
		});

		const create = { type: "create" as const, sessionPath };
		const first = supervisor.createOrReuseWorker("client", create);
		// The reservation is published in the caller's own synchronous turn: before
		// the opening body runs a single statement, so before the first await that
		// could let a rival observe supervisor state.
		expect(supervisor.openingWorkers.size).toBe(1);
		expect(edges).not.toHaveBeenCalled();
		expect(launchWorker).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(edges).toHaveBeenCalled(), { timeout: 5000, interval: 1 });
		// ...and it is still authoritative while the hydration await is blocked.
		expect(supervisor.openingWorkers.size).toBe(1);
		const rivals = Array.from({ length: 64 }, () => supervisor.createOrReuseWorker("client", create));
		// 64 same-key rivals arrived mid-hydration and every one of them joined the
		// single reservation: no second key, and no second hydration walk.
		expect(supervisor.openingWorkers.size).toBe(1);
		expect(edges).toHaveBeenCalledOnce();

		const settled = Promise.all([first, ...rivals]);
		releaseEdges();
		const opened = await settled;

		expect(opened).toHaveLength(65);
		expect(new Set(opened).size).toBe(1);
		expect(opened.every((entry) => entry === resident)).toBe(true);
		expect(launchWorker).toHaveBeenCalledOnce();
		expect(edges).toHaveBeenCalledOnce();
		// Exactly one worker was launched for the key, the decoy-free roster gained
		// nothing else, and the reservation was released once ownership committed.
		expect([...supervisor.workers.keys()].sort()).toEqual(["opened", "stale"]);
		expect(supervisor.openingWorkers.size).toBe(0);
	});

	it("refuses same-key rivals once instead of adopting a worker registered mid-refresh", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stale-refresh-decoy-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseEdges!: () => void;
		const edgesGate = new Promise<void>((resolve) => {
			releaseEdges = resolve;
		});
		const edges = vi.fn(async () => {
			await edgesGate;
			return [];
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("stale", staleCatalogWorker(directory));
		const launchWorker = vi.fn();
		Object.assign(supervisor, {
			rlmSpawnLedger: () => ({ edges }),
			catalog: {
				resolve: vi.fn(async () => sessionPath),
				siblings: vi.fn(async () => []),
				list: vi.fn(async () => []),
			},
			launchWorker,
		});

		const create = { type: "create" as const, sessionPath };
		const first = supervisor.createOrReuseWorker("client", create);
		expect(supervisor.openingWorkers.size).toBe(1);
		await vi.waitFor(() => expect(edges).toHaveBeenCalled(), { timeout: 5000, interval: 1 });

		// A half-started registration for the very same saved path appears while the
		// hydration is blocked, carrying an authoritative root catalog of its own.
		// It cannot serve a create while it is starting, so the reservation holder
		// must refuse — never adopt it, never replace it, never launch beside it.
		const decoy = worker("decoy", [
			summary({
				id: "decoy-root-active",
				activeSessionId: "decoy-root-active",
				sessionId: "decoy-root-session",
				sessionFile: sessionPath,
				rlmDepth: 0,
			}),
		]);
		decoy.descriptor.rootActiveSessionId = "decoy-root-active";
		decoy.descriptor.rootSessionId = "decoy-root-session";
		decoy.descriptor.lifecycle = "starting";
		decoy.descriptor.createCommand = { config: { cwd: directory }, sessionPath };
		supervisor.workers.set("decoy", decoy);
		const rivals = Array.from({ length: 64 }, () => supervisor.createOrReuseWorker("client", create));
		expect(supervisor.openingWorkers.size).toBe(1);

		const settled = Promise.allSettled([first, ...rivals]);
		releaseEdges();
		const results = await settled;

		expect(results).toHaveLength(65);
		// One decision, delivered to every same-key caller as the same typed refusal:
		// every caller rejects, every reason is identical, and the reason is an honest
		// not-ready refusal (half-started or root-not-yet-published), never an adoption.
		const reasons = results.map((result) =>
			result.status === "rejected" && result.reason instanceof Error ? result.reason.message : undefined,
		);
		expect(reasons.every((message) => message !== undefined)).toBe(true);
		expect(new Set(reasons).size).toBe(1);
		expect(/worker is (starting|unavailable for reuse)/.test(reasons[0]!)).toBe(true);
		expect(launchWorker).not.toHaveBeenCalled();
		expect(edges).toHaveBeenCalledOnce();
		// Zero adoption, zero replacement, zero duplicates.
		expect(supervisor.workers.get("decoy")).toBe(decoy);
		expect(decoy.descriptor.lifecycle).toBe("starting");
		expect([...supervisor.workers.keys()].sort()).toEqual(["decoy", "stale"]);
		expect(supervisor.openingWorkers.size).toBe(0);
	});

	it("enforces session ownership when joining an in-flight open", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-pending-owner-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const resident = worker("opened");
		resident.descriptor.ownerClientId = "owner";
		const launchWorker = vi.fn(async () => {
			await launchGate;
			return resident;
		});
		Object.assign(supervisor, { launchWorker });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const sameOwner = supervisor.createOrReuseWorker("owner", create);
		const otherClient = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).resolves.toBe(resident),
			expect(sameOwner).resolves.toBe(resident),
			expect(otherClient).rejects.toMatchObject({ code: "session_already_active" }),
		]);
		releaseLaunch();
		await expectations;
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("rejoins an open registered while reclaiming a stale worker registration", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-reclaim-rejoin-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseReclaim!: () => void;
		const reclaimGate = new Promise<void>((resolve) => {
			releaseReclaim = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const stale = worker("stale");
		stale.descriptor.createCommand = { config: { cwd: directory }, sessionPath };
		supervisor.workers.set(stale.descriptor.workerId, stale);
		const resident = worker("opened");
		resident.descriptor.ownerClientId = "owner";
		const launchWorker = vi.fn(async () => resident);
		const reclaimStaleWorkerRegistration = vi.fn(async () => {
			await reclaimGate;
			supervisor.workers.delete(stale.descriptor.workerId);
			return true;
		});
		Object.assign(supervisor, { launchWorker, reclaimStaleWorkerRegistration });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const second = supervisor.createOrReuseWorker("owner", create);
		const intruder = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).resolves.toBe(resident),
			expect(second).resolves.toBe(resident),
			expect(intruder).rejects.toMatchObject({ code: "session_already_active" }),
		]);
		releaseReclaim();
		await expectations;
		expect(launchWorker).toHaveBeenCalledOnce();
	});

	it("propagates an in-flight open failure to joiners", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-pending-failure-"));
		tempDirs.push(directory);
		const sessionPath = join(directory, "session.jsonl");
		let releaseLaunch!: () => void;
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const launchWorker = vi.fn(async () => {
			await launchGate;
			throw new Error("launch exploded");
		});
		Object.assign(supervisor, { launchWorker });

		const create = { type: "create" as const, sessionPath, lifecycle: "client_owned" as const };
		const first = supervisor.createOrReuseWorker("owner", create);
		const joiner = supervisor.createOrReuseWorker("intruder", create);
		const expectations = Promise.all([
			expect(first).rejects.toThrow("launch exploded"),
			expect(joiner).rejects.toThrow("launch exploded"),
		]);
		releaseLaunch();
		await expectations;
	});

	it("uses injective structural session name reservation keys", () => {
		expect(sessionNameReservationKey({ name: "b:c", depth: 1, parentSessionPath: "/a" })).not.toBe(
			sessionNameReservationKey({ name: "c", depth: 1, parentSessionPath: "/a:b" }),
		);
		expect(sessionNameReservationKey({ name: "worker", depth: 1, parentSessionPath: "/a" })).toBe(
			sessionNameReservationKey({ name: "worker", depth: 1, parentSessionPath: "/a" }),
		);
	});

	it("holds a root rename reservation until the worker commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-root-rename-race-"));
		tempDirs.push(directory);
		const firstSummary = summary({
			id: "first-active",
			activeSessionId: "first-active",
			sessionId: "first-session",
			rlmDepth: 0,
		});
		const secondSummary = summary({
			id: "second-active",
			activeSessionId: "second-active",
			sessionId: "second-session",
			rlmDepth: 0,
		});
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		// Each rename target is a depth-0 root, so it *is* its worker's assigned
		// root session. Say so on the descriptor: the post-commit roster read is
		// only authoritative when the worker returns the root it was assigned.
		const firstWorker = worker("first", [firstSummary]);
		firstWorker.descriptor.rootActiveSessionId = "first-active";
		firstWorker.descriptor.rootSessionId = "first-session";
		firstWorker.client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") return success(undefined, "list", { sessions: [firstSummary] });
			await renameGate;
			return success(undefined, "rename", firstSummary);
		});
		const secondWorker = worker("second", [secondSummary]);
		secondWorker.descriptor.rootActiveSessionId = "second-active";
		secondWorker.descriptor.rootSessionId = "second-session";
		secondWorker.client.request.mockResolvedValue(success(undefined, "rename", secondSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", firstWorker);
		supervisor.workers.set("second", secondWorker);
		seedSupervisorRoster(supervisor, firstWorker, secondWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) }, persistWorker: vi.fn() });
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const first = supervisor.handleCommand(client, {
			type: "rename",
			activeSessionId: "first-active",
			name: "shared-root",
		});
		await vi.waitFor(() =>
			expect(firstWorker.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ type: "rename" }),
				expect.any(Number),
			),
		);
		await expect(
			supervisor.handleCommand(client, {
				type: "rename",
				activeSessionId: "second-active",
				name: "shared-root",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");
		expect(secondWorker.client.request).not.toHaveBeenCalled();
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("allows only a resident worker token to rename a client-owned session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-worker-rename-"));
		tempDirs.push(directory);
		const ownedSummary = summary({
			id: "owned-active",
			activeSessionId: "owned-active",
			sessionId: "owned-session",
			rlmDepth: 0,
		});
		const ownedWorker = worker("owned", [ownedSummary]);
		ownedWorker.descriptor.ownerClientId = "interactive-client";
		ownedWorker.client.request.mockResolvedValue(success(undefined, "set_session_name"));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("owned", ownedWorker);
		seedSupervisorRoster(supervisor, ownedWorker);
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) } });
		const workerClient = { id: "daemon-client:worker", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(workerClient, {
				type: "set_session_name",
				activeSessionId: "owned-active",
				name: "renamed-by-worker",
				workerToken: "owned-token",
			}),
		).resolves.toMatchObject({ success: true });
		expect(ownedWorker.client.request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_session_name", activeSessionId: "owned-active" }),
			expect.any(Number),
		);

		ownedWorker.client.request.mockClear();
		for (const workerToken of [undefined, "foreign-token"]) {
			await expect(
				supervisor.handleCommand(workerClient, {
					type: "set_session_name",
					activeSessionId: "owned-active",
					name: "unauthorized",
					...(workerToken ? { workerToken } : {}),
				}),
			).rejects.toThrow("Unknown active session: owned-active");
		}
		expect(ownedWorker.client.request).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "set_session_name" }),
			expect.any(Number),
		);
	});

	it("serializes active saved-session renames until the worker commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-active-saved-rename-race-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const firstPath = join(directory, "first.jsonl");
		const secondPath = join(directory, "second.jsonl");
		const firstSummary = summary({
			id: "first-active",
			activeSessionId: "first-active",
			sessionId: "first-session",
			sessionFile: firstPath,
			parentSessionPath,
			rlmDepth: 1,
		});
		const secondSummary = summary({
			id: "second-active",
			activeSessionId: "second-active",
			sessionId: "second-session",
			sessionFile: secondPath,
			parentSessionPath,
			rlmDepth: 1,
		});
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const firstWorker = worker("first", [firstSummary]);
		firstWorker.client.request.mockImplementation(async () => {
			await renameGate;
			return success(undefined, "rename_saved_session", firstSummary);
		});
		const secondWorker = worker("second", [secondSummary]);
		secondWorker.client.request.mockResolvedValue(success(undefined, "rename_saved_session", secondSummary));
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", firstWorker);
		supervisor.workers.set("second", secondWorker);
		seedSupervisorRoster(supervisor, firstWorker, secondWorker);
		Object.assign(supervisor, {
			catalog: {
				siblings: vi.fn(async () => []),
				list: vi.fn(async () => []),
			},
		});
		const client = { id: "client", attachedActiveSessionIds: new Set<string>() };

		const first = supervisor.handleCommand(client, {
			type: "rename_saved_session",
			activeSessionId: "first-active",
			sessionPath: firstPath,
			name: "shared",
		});
		await vi.waitFor(() =>
			expect(firstWorker.client.request).toHaveBeenCalledWith(
				expect.objectContaining({ type: "rename_saved_session" }),
				expect.any(Number),
			),
		);
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				activeSessionId: "second-active",
				sessionPath: secondPath,
				name: "shared",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		expect(secondWorker.client.request).not.toHaveBeenCalled();
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("serializes same-scope inactive renames across catalog validation and commit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-saved-rename-race-"));
		tempDirs.push(directory);
		const firstPath = join(directory, "first.jsonl");
		const secondPath = join(directory, "second.jsonl");
		const parentSessionPath = join(directory, "parent.jsonl");
		const saved = [firstPath, secondPath].map((path, index) => ({
			id: `saved-${index}`,
			path,
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			parentSessionPath,
			rlmDepth: 1,
		}));
		let releaseRename: () => void = () => {};
		const renameGate = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		const rename = vi.fn(async () => renameGate);
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async () => saved),
			rlmSpawnLedger: vi.fn(() => ({ appendRenameByChildPath: vi.fn(async () => {}) })),
			catalog: {
				rename,
			},
		});
		const client = {};

		const first = supervisor.handleCommand(client, {
			type: "rename_saved_session",
			sessionPath: firstPath,
			name: "shared",
		});
		await vi.waitFor(() => expect(rename).toHaveBeenCalledOnce());
		await expect(
			supervisor.handleCommand(client, {
				type: "rename_saved_session",
				sessionPath: secondPath,
				name: "shared",
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		releaseRename();
		await expect(first).resolves.toMatchObject({ success: true });
	});

	it("reserves named child creates by parent scope until worker launch completes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-child-create-race-"));
		tempDirs.push(directory);
		const parentSessionPath = join(directory, "parent.jsonl");
		const child = (id: string) => ({
			id,
			path: join(directory, `${id}.jsonl`),
			cwd: directory,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			parentSessionPath,
			rlmDepth: 1,
		});
		const firstChild = child("first-child");
		const secondChild = child("second-child");
		let releaseLaunch: () => void = () => {};
		const launchGate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const launched = worker("opened");
		const launchWorker = vi.fn(async () => {
			await launchGate;
			return launched;
		});
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		Object.assign(supervisor, {
			rlmLedgerSiblings: vi.fn(async (path: string) => [path === firstChild.path ? firstChild : secondChild]),
			catalog: {
				resolve: vi.fn(async (path: string) => path),
			},
			launchWorker,
		});

		const first = supervisor.createOrReuseWorker("client", {
			type: "create",
			name: "shared-child",
			sessionPath: firstChild.path,
		});
		await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledOnce());
		await expect(
			supervisor.createOrReuseWorker("client", {
				type: "create",
				name: "shared-child",
				sessionPath: secondChild.path,
			}),
		).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
		releaseLaunch();
		await expect(first).resolves.toBe(launched);
	});

	it("dispatches authenticated peer queries and excludes disconnected workers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-passive-peers-"));
		tempDirs.push(directory);
		const socketPath = join(directory, "daemon.sock");
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		const client = new DaemonClient(socketPath);
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();

		const passive = summary({
			id: "passive-session",
			sessionId: "passive-session",
			sessionFile: join(directory, "passive.jsonl"),
			sessionName: "passive-worker",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const firstRoot = summary({
			id: "first-root-active",
			activeSessionId: "first-root-active",
			sessionId: "first-root-session",
			runtimeKind: "top-level",
		});
		const secondRoot = summary({
			id: "second-root-active",
			activeSessionId: "second-root-active",
			sessionId: "second-root-session",
		});
		const disconnectedRoot = summary({
			id: "disconnected-root-active",
			activeSessionId: "disconnected-root-active",
			sessionId: "disconnected-root-session",
		});
		const first = worker("first", [firstRoot, passive]);
		const second = worker("second", [secondRoot]);
		const disconnected = worker("disconnected", [disconnectedRoot]);
		Object.assign(disconnected, { client: undefined });

		try {
			await supervisor.start();
			supervisor.workers.set("first", first);
			supervisor.workers.set("second", second);
			supervisor.workers.set("disconnected", disconnected);
			seedSupervisorRoster(supervisor, first, second, disconnected);
			await client.connect();

			await expect(
				client.request({ type: "list_agent_peers", workerToken: "invalid-token" }),
			).resolves.toMatchObject({
				success: false,
				error: "Worker authentication failed",
			});
			const response = await client.request({
				type: "list_agent_peers",
				workerToken: second.descriptor.authenticationToken,
			});
			expect(response).toMatchObject({
				success: true,
				data: {
					peers: [
						expect.objectContaining({
							activeSessionId: "first-root-active",
							sessionId: "first-root-session",
							runtimeKind: "top-level",
						}),
					],
				},
			});
		} finally {
			client.close();
			supervisor.workers.clear();
			await supervisor.cleanupSupervisorResources();
		}
	});
	// --- terminal follow_up addressed by durable session identity --------------------
	//
	// A passivated retained RLM child keeps its durable sessionId/sessionFile on its
	// owning worker's roster row but loses its ephemeral activeSessionId. The
	// supervisor must resolve that row conjunctively and forward the ordinary
	// follow_up command, never selecting a root, the Board, or the newest row.

	function passiveChildRoster(directory: string) {
		const rootSummary = summary({
			id: "root-active",
			activeSessionId: "root-active",
			sessionId: "root-session",
			sessionFile: join(directory, "root.jsonl"),
			runtimeKind: "top-level",
			rlmDepth: 0,
		});
		// Exactly the wire shape daemon-mode publishes for a passivated child: durable
		// identity and path, subagent lineage, and NO activeSessionId.
		const passiveChild = summary({
			id: "child-session",
			sessionId: "child-session",
			sessionFile: join(directory, "sub-1", "child.jsonl"),
			runtimeKind: "subagent",
			parentSessionId: "root-session",
			parentSessionPath: join(directory, "root.jsonl"),
			rlmChildId: "child-1",
			rlmDepth: 1,
		});
		const resident = worker("first", [rootSummary, passiveChild]);
		resident.descriptor.rootActiveSessionId = "root-active";
		resident.descriptor.rootSessionId = "root-session";
		resident.client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") {
				return success(undefined, "list", { sessions: [rootSummary, passiveChild] });
			}
			return success(undefined, "follow_up", { queued: true });
		});
		return { rootSummary, passiveChild, resident };
	}

	function stableTargetSupervisor(directory: string, resident: WorkerFixture): SupervisorInternals {
		const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir: join(directory, "workers"),
		}) as unknown as SupervisorInternals;
		supervisor.workers.set("first", resident);
		// These tests drive roster refreshes against a synthetic worker that owns no
		// descriptor file, so descriptor persistence is stubbed to keep them hermetic.
		Object.assign(supervisor, { catalog: { list: vi.fn(async () => []) }, persistWorker: vi.fn() });
		return supervisor;
	}

	const stableClient = () => ({ id: "client", attachedActiveSessionIds: new Set<string>() });

	it("forwards a stable-target follow_up to the worker owning the passivated child", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stable-follow-up-"));
		tempDirs.push(directory);
		const { passiveChild, resident } = passiveChildRoster(directory);
		const supervisor = stableTargetSupervisor(directory, resident);

		const response = await supervisor.handleCommand(stableClient(), {
			type: "follow_up",
			// The dead launch-time address from the incident.
			activeSessionId: "stale-ephemeral-active-id",
			message: "MATERIAL_DETACHED_TERMINAL event_id=evt-1",
			queueKey: "w6-terminal:0123456789abcdef",
			stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
		});

		const forwarded = resident.client.request.mock.calls
			.map(([command]) => command as Record<string, unknown>)
			.filter((command) => command.type === "follow_up");
		expect(forwarded).toHaveLength(1);
		// Addressed by durable identity, with the resolved coordinates echoed so the
		// worker re-resolves conjunctively instead of trusting the caller's guess.
		expect(forwarded[0]).toMatchObject({
			type: "follow_up",
			activeSessionId: "child-session",
			queueKey: "w6-terminal:0123456789abcdef",
			stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
		});
		expect(response).toMatchObject({ success: true, data: { queued: true } });
		// The follow-up lane only: never the steering/agent-message lane.
		expect(resident.client.requestWorker).not.toHaveBeenCalled();
	});

	it("refuses stable follow_up targets it cannot prove instead of guessing a session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stable-follow-up-refusals-"));
		tempDirs.push(directory);
		const { rootSummary, passiveChild, resident } = passiveChildRoster(directory);
		const supervisor = stableTargetSupervisor(directory, resident);

		const cases: Array<[string, Record<string, unknown>]> = [
			["missing_identity", {}],
			["invalid_target", { sessionId: "" }],
			["not_found", { sessionId: "absent-session" }],
			// The id names the child but the file names the root: conjunction fails.
			["identity_mismatch", { sessionId: "child-session", sessionFile: rootSummary.sessionFile }],
			// A root/Board row is never a terminal-reminder target, even named exactly.
			["unsupported_target", { sessionId: "root-session", sessionFile: rootSummary.sessionFile }],
		];
		for (const [reason, stableTarget] of cases) {
			await expect(
				supervisor.handleCommand(stableClient(), {
					type: "follow_up",
					activeSessionId: "stale-ephemeral-active-id",
					message: "reminder",
					stableTarget,
				}),
				`${reason}: ${JSON.stringify(stableTarget)}`,
			).rejects.toMatchObject({ reason });
		}

		// A stopping worker is unavailable, not a reason to pick a different session.
		resident.descriptor.stopRequestedAt = new Date().toISOString();
		await expect(
			supervisor.handleCommand(stableClient(), {
				type: "follow_up",
				activeSessionId: "stale-ephemeral-active-id",
				message: "reminder",
				stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
			}),
		).rejects.toMatchObject({ reason: "target_unavailable" });

		// Not one refusal reached a session.
		expect(
			resident.client.request.mock.calls.filter(([command]) => (command as { type: string }).type === "follow_up"),
		).toHaveLength(0);
	});

	// --- stable targets against a catalog that is still hydrating ---------------
	//
	// The supervisor now owns bounded summary freshness and background
	// rehydration. A stable follow-up arriving during that window must join the
	// in-flight single-flight rather than walking the roster a second time, and
	// must never turn "not established yet" into the terminal "not_found" that
	// the public helper stops retrying on.

	const followUpCalls = (resident: WorkerFixture) =>
		resident.client.request.mock.calls.filter(([command]) => (command as { type: string }).type === "follow_up");
	const listCalls = (resident: WorkerFixture) =>
		resident.client.request.mock.calls.filter(([command]) => (command as { type: string }).type === "list");

	it("joins in-flight summary hydration instead of reporting a false not_found", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stable-hydration-join-"));
		tempDirs.push(directory);
		const { rootSummary, passiveChild, resident } = passiveChildRoster(directory);
		// The catalog has not yet observed the passivated child: this is exactly
		// the snapshot that used to produce a terminal not_found.
		resident.summaries = new Map([["root-active", rootSummary]]);
		resident.summariesStale = true;

		let completeHydration: () => void = () => {};
		const hydration = new Promise<void>((resolve) => {
			completeHydration = resolve;
		}).then(() => {
			resident.summaries = new Map([
				["root-active", rootSummary],
				["child-session", passiveChild],
			]);
			resident.summariesStale = false;
			resident.summaryRefresh = undefined;
		});
		resident.summaryRefresh = hydration;

		const supervisor = stableTargetSupervisor(directory, resident);
		const pending = supervisor.handleCommand(stableClient(), {
			type: "follow_up",
			activeSessionId: "stale-ephemeral-active-id",
			message: "MATERIAL_DETACHED_TERMINAL event_id=evt-1",
			queueKey: "w6-terminal:0123456789abcdef",
			stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
		});
		completeHydration();

		await expect(pending).resolves.toMatchObject({ success: true, data: { queued: true } });
		// Joined the existing hydration: no parallel roster/list walk was started.
		expect(listCalls(resident)).toHaveLength(0);
		// Matched the authoritative refreshed summaries and forwarded once, to the
		// owning worker, with full re-resolvable coordinates.
		expect(followUpCalls(resident)).toHaveLength(1);
		expect(followUpCalls(resident)[0]?.[0]).toMatchObject({
			activeSessionId: "child-session",
			stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
		});
	});

	it("reports unproven stable-target ownership as retriable target_unavailable, never not_found", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stable-unproven-"));
		tempDirs.push(directory);
		const { rootSummary, passiveChild } = passiveChildRoster(directory);
		const absentChildTarget = { sessionId: "child-session", sessionFile: passiveChild.sessionFile };

		// Each case is a distinct way of failing to *establish* ownership. None of
		// them proves the target is absent, so none may be terminal.
		const cases: Array<[string, (resident: WorkerFixture) => void]> = [
			[
				"authoritative refresh failure",
				(resident) => {
					resident.client.request.mockImplementation(async (command: { type: string }) => {
						if (command.type === "list") throw new Error("worker list failed");
						return success(undefined, "follow_up", { queued: true });
					});
				},
			],
			[
				"root summary omitted from the refreshed catalog",
				(resident) => {
					resident.client.request.mockImplementation(async (command: { type: string }) => {
						if (command.type === "list") return success(undefined, "list", { sessions: [] });
						return success(undefined, "follow_up", { queued: true });
					});
				},
			],
			[
				"stale catalog that the refresh could not clear",
				(resident) => {
					resident.summariesStale = true;
					resident.client.request.mockImplementation(async (command: { type: string }) => {
						if (command.type === "list") throw new Error("worker is still catching up");
						return success(undefined, "follow_up", { queued: true });
					});
				},
			],
			[
				"background rehydration still in flight",
				(resident) => {
					// Never settles: ownership cannot be established during this window.
					resident.summaryRehydration = new Promise<void>(() => {});
					resident.client.request.mockImplementation(async (command: { type: string }) => {
						if (command.type === "list") return success(undefined, "list", { sessions: [rootSummary] });
						return success(undefined, "follow_up", { queued: true });
					});
				},
			],
			[
				"owning worker detached",
				(resident) => {
					resident.summariesStale = true;
					// No live connection at all: ownership cannot be re-established.
					Object.assign(resident, { client: undefined });
				},
			],
		];

		for (const [label, arrange] of cases) {
			const resident = worker("first", [rootSummary]);
			resident.descriptor.rootActiveSessionId = "root-active";
			resident.descriptor.rootSessionId = "root-session";
			resident.client.request.mockImplementation(async () => success(undefined, "follow_up", { queued: true }));
			// Captured before arrangement so a detached case can still be audited.
			const { request, requestWorker } = resident.client;
			arrange(resident);
			const supervisor = stableTargetSupervisor(directory, resident);

			await expect(
				supervisor.handleCommand(stableClient(), {
					type: "follow_up",
					activeSessionId: "stale-ephemeral-active-id",
					message: "reminder",
					stableTarget: absentChildTarget,
				}),
				label,
			).rejects.toMatchObject({ reason: "target_unavailable" });
			// Zero follow-up wire sends while ownership is unproven, and no
			// active-id-only fallback delivery.
			expect(
				request.mock.calls.filter(([command]) => (command as { type: string }).type === "follow_up"),
				label,
			).toHaveLength(0);
			expect(requestWorker, label).not.toHaveBeenCalled();
		}
	});

	it("still proves a genuine absence terminally once the catalog is authoritative", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stable-proven-absence-"));
		tempDirs.push(directory);
		const { rootSummary, resident } = passiveChildRoster(directory);
		// A healthy worker whose refreshed catalog genuinely lacks the coordinates.
		resident.client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") return success(undefined, "list", { sessions: [rootSummary] });
			return success(undefined, "follow_up", { queued: true });
		});
		const supervisor = stableTargetSupervisor(directory, resident);

		await expect(
			supervisor.handleCommand(stableClient(), {
				type: "follow_up",
				activeSessionId: "stale-ephemeral-active-id",
				message: "reminder",
				stableTarget: { sessionId: "absent-session" },
			}),
		).rejects.toMatchObject({ reason: "not_found" });
		expect(listCalls(resident)).toHaveLength(1);
		expect(followUpCalls(resident)).toHaveLength(0);
	});

	it("refuses a schema-23 worker a stable target instead of downgrading to active-id routing", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stable-mixed-version-"));
		tempDirs.push(directory);
		const { passiveChild, resident } = passiveChildRoster(directory);
		// A worker adopted from the previous binary: it still serves its roster, so
		// the target matches, but it never advertised the stable-target capability.
		resident.hello = {
			protocol: DAEMON_PROTOCOL_INFO,
			schemaRevision: DAEMON_SCHEMA_REVISION - 1,
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES.filter(
				(capability) => capability !== "stable_target_follow_up",
			),
		};
		const supervisor = stableTargetSupervisor(directory, resident);

		await expect(
			supervisor.handleCommand(stableClient(), {
				type: "follow_up",
				activeSessionId: "stale-ephemeral-active-id",
				message: "reminder",
				stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
			}),
		).rejects.toMatchObject({ reason: "target_unavailable" });
		// Fail-closed: the stable field was never written to a worker that cannot
		// interpret it, and the request was not retried as an active-id-only send.
		expect(followUpCalls(resident)).toHaveLength(0);
		expect(resident.client.requestWorker).not.toHaveBeenCalled();

		// The supervisor's own schema is 24; that must not be credited to the
		// worker. Only the worker's own hello unlocks the stable route.
		expect(DAEMON_SCHEMA_ID).toContain(`schema-${DAEMON_SCHEMA_REVISION}`);
		resident.hello = currentWorkerHello();
		await expect(
			supervisor.handleCommand(stableClient(), {
				type: "follow_up",
				activeSessionId: "stale-ephemeral-active-id",
				message: "reminder",
				stableTarget: { sessionId: "child-session", sessionFile: passiveChild.sessionFile },
			}),
		).resolves.toMatchObject({ success: true, data: { queued: true } });
		expect(followUpCalls(resident)).toHaveLength(1);
	});

	// --- bounded summary freshness and self-heal (Mac runtime) ------------------

	it("coalesces concurrent summary refreshes and self-heals a root-omitting catalog", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-summary-freshness-"));
		tempDirs.push(directory);
		const { rootSummary, passiveChild, resident } = passiveChildRoster(directory);
		const supervisor = stableTargetSupervisor(directory, resident);

		// Two concurrent refreshes share one roster walk.
		await Promise.all([supervisor.refreshWorkerSummaries(resident), supervisor.refreshWorkerSummaries(resident)]);
		expect(listCalls(resident)).toHaveLength(1);
		expect(resident.summariesStale).toBe(false);
		expect(resident.summaries.get("child-session")).toMatchObject({ sessionId: "child-session" });

		// A fresh catalog is reused rather than re-walked when freshness is allowed.
		await supervisor.refreshWorkerSummaries(resident, true);
		expect(listCalls(resident)).toHaveLength(1);
		// ...and an explicit (non-fresh) refresh always re-reads.
		await supervisor.refreshWorkerSummaries(resident);
		expect(listCalls(resident)).toHaveLength(2);

		// A catalog that drops the worker's own root is not accepted as truth: it
		// is rejected and the worker is marked stale for rehydration.
		resident.client.request.mockImplementation(async (command: { type: string }) => {
			if (command.type === "list") return success(undefined, "list", { sessions: [passiveChild] });
			return success(undefined, "follow_up", { queued: true });
		});
		await expect(supervisor.refreshWorkerSummaries(resident)).rejects.toThrow(/root session/i);
		expect(resident.summariesStale).toBe(true);
		// The prior authoritative catalog was not replaced by the bad one.
		expect(resident.summaries.get("root-active")).toMatchObject({ sessionId: "root-session" });
		expect(rootSummary.sessionId).toBe("root-session");
	});
});
