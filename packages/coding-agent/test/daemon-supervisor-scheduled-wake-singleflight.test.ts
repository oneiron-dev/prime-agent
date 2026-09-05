import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import { getSessionArtifactPathForFile, type SessionInfo } from "../src/core/session-manager.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { createDeferred } from "./suite/scheduling.js";

interface ScheduledCandidate {
	rootSessionFile: string;
	job: AgentCronJob;
	info: SessionInfo;
}

interface WakeHarness {
	shuttingDown: boolean;
	updateRestartPhase?: "draining" | "fencing" | "prepared";
	scheduledWakeTimer?: ReturnType<typeof setTimeout>;
	scheduledWakeRecompute?: Promise<void>;
	scheduledWakeRecomputeQueued: boolean;
	scheduledWakeRevision: number;
	scheduledWakeDrain?: Promise<void>;
	scheduledWakeFailures: Map<string, number>;
	collectPassiveScheduledJobs: ReturnType<
		typeof vi.fn<(...args: [boolean?, string?]) => Promise<ScheduledCandidate[]>>
	>;
	createOrReuseWorker: ReturnType<
		typeof vi.fn<(clientId: string, command: { type: "create"; sessionPath: string }) => Promise<object>>
	>;
	findWorkerBySessionFile: ReturnType<typeof vi.fn<(sessionPath: string) => object | undefined>>;
	log: ReturnType<typeof vi.fn>;
	scheduleScheduledSessionWakeRecompute(): void;
	recomputeScheduledSessionWake(): Promise<void>;
	wakeDueScheduledSessions(now?: number): Promise<void>;
}

const now = Date.parse("2026-08-01T12:00:00.000Z");
const harnesses: WakeHarness[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});

afterEach(async () => {
	for (const supervisor of harnesses.splice(0)) {
		supervisor.shuttingDown = true;
		if (supervisor.scheduledWakeTimer) clearTimeout(supervisor.scheduledWakeTimer);
		await supervisor.scheduledWakeRecompute;
	}
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

function candidate(id: string, nextRunAt = now - 60_000): ScheduledCandidate {
	const path = `/tmp/prime-scheduled-singleflight/${id}.jsonl`;
	return {
		rootSessionFile: path,
		job: {
			id: `job-${id}`,
			status: "active",
			source: "heartbeat",
			activeSessionId: `active-${id}`,
			sessionId: id,
			sessionFile: path,
			cwd: "/tmp/project",
			prompt: "scheduled test tick",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: new Date(now - 600_000).toISOString(),
			updatedAt: new Date(now - 600_000).toISOString(),
			nextRunAt: new Date(nextRunAt).toISOString(),
			runCount: 0,
		},
		info: {
			path,
			id,
			cwd: "/tmp/project",
			rlmDepth: 0,
			created: new Date(now - 600_000),
			modified: new Date(now - 600_000),
			messageCount: 1,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

function createHarness(records: ScheduledCandidate[]): { supervisor: WakeHarness; resident: Set<string> } {
	const resident = new Set<string>();
	// Bypass construction so scheduler races require no catalog, socket, or files.
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		shuttingDown: false,
		updateRestartPhase: undefined,
		scheduledWakeTimer: undefined,
		scheduledWakeRecompute: undefined,
		scheduledWakeRecomputeQueued: false,
		scheduledWakeRevision: 0,
		scheduledWakeDrain: undefined,
		scheduledWakeFailures: new Map<string, number>(),
		collectPassiveScheduledJobs: vi.fn(async (_includeInactive?: boolean, rootKey?: string) =>
			records
				.filter(
					(record) =>
						!resident.has(record.rootSessionFile) &&
						(rootKey === undefined || resolve(record.rootSessionFile) === rootKey),
				)
				.map((record) => ({ ...record, job: { ...record.job }, info: { ...record.info } })),
		),
		findWorkerBySessionFile: vi.fn((sessionPath: string) => (resident.has(sessionPath) ? {} : undefined)),
		createOrReuseWorker: vi.fn(async (_clientId: string, command: { type: "create"; sessionPath: string }) => {
			resident.add(command.sessionPath);
			return {};
		}),
		log: vi.fn(),
	}) as WakeHarness;
	harnesses.push(supervisor);
	return { supervisor, resident };
}

describe("daemon supervisor scheduled wake single flight", () => {
	it("drains 33 roots once with one active create despite ready broadcasts and concurrent wake calls", async () => {
		const records = Array.from({ length: 33 }, (_, index) => candidate(`root-${index}`));
		const duplicate = candidate("second-job-in-root-0");
		duplicate.rootSessionFile = records[0]!.rootSessionFile;
		const { supervisor, resident } = createHarness([...records, duplicate]);
		const gates = records.map(() => createDeferred());
		const entered = records.map(() => createDeferred());
		let active = 0;
		let peakActive = 0;
		supervisor.createOrReuseWorker.mockImplementation(async (_clientId, command) => {
			const index = records.findIndex((record) => record.rootSessionFile === command.sessionPath);
			active++;
			peakActive = Math.max(peakActive, active);
			entered[index]!.resolve();
			try {
				for (let broadcast = 0; broadcast < 3; broadcast++) {
					supervisor.scheduleScheduledSessionWakeRecompute();
				}
				await gates[index]!.promise;
				resident.add(command.sessionPath);
				return {};
			} finally {
				active--;
			}
		});

		const first = supervisor.wakeDueScheduledSessions(now);
		const second = supervisor.wakeDueScheduledSessions(now);
		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});
		try {
			expect(second).toBe(first);
			for (let index = 0; index < records.length; index++) {
				await entered[index]!.promise;
				await flushMicrotasks();
				expect(supervisor.scheduledWakeTimer).toBeUndefined();
				expect(vi.getTimerCount()).toBe(0);
				await vi.advanceTimersByTimeAsync(1);
				expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(index + 1);
				expect(active).toBe(1);
				expect(secondSettled).toBe(false);
				expect(supervisor.wakeDueScheduledSessions()).toBe(first);
				gates[index]!.resolve();
			}
			await Promise.all([first, second]);
			await supervisor.scheduledWakeRecompute;
			expect(peakActive).toBe(1);
			expect(active).toBe(0);
			expect(supervisor.createOrReuseWorker.mock.calls.map(([, command]) => command.sessionPath)).toEqual(
				records.map((record) => record.rootSessionFile),
			);
			expect(supervisor.scheduledWakeTimer).toBeUndefined();
		} finally {
			supervisor.shuttingDown = true;
			for (const gate of gates) gate.resolve();
			await Promise.all([first, second]);
		}
	});

	it("does not arm a timer from a recompute that began before the active drain", async () => {
		const records = [candidate("root")];
		const { supervisor, resident } = createHarness(records);
		const enumeration = createDeferred<ScheduledCandidate[]>();
		const creation = createDeferred();
		const entered = createDeferred();
		supervisor.collectPassiveScheduledJobs.mockImplementationOnce(() => enumeration.promise);
		supervisor.createOrReuseWorker.mockImplementation(async (_clientId, command) => {
			entered.resolve();
			await creation.promise;
			resident.add(command.sessionPath);
			return {};
		});
		supervisor.scheduleScheduledSessionWakeRecompute();
		const recompute = supervisor.scheduledWakeRecompute;
		const drain = supervisor.wakeDueScheduledSessions(now);
		try {
			await entered.promise;
			enumeration.resolve(records);
			await recompute;
			await flushMicrotasks();
			expect(supervisor.scheduledWakeTimer).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
		} finally {
			enumeration.resolve(records);
			creation.resolve();
			await drain;
		}
	});

	it("discards a stale recompute after a completed failed drain without erasing its retry floor", async () => {
		const failed = candidate("failed");
		const { supervisor } = createHarness([failed]);
		const enumeration = createDeferred<ScheduledCandidate[]>();
		supervisor.collectPassiveScheduledJobs.mockImplementationOnce(() => enumeration.promise);
		supervisor.createOrReuseWorker.mockRejectedValue(new Error("synthetic create failure"));
		supervisor.scheduleScheduledSessionWakeRecompute();
		const staleRecompute = supervisor.scheduledWakeRecompute;

		await supervisor.wakeDueScheduledSessions(now);
		expect(supervisor.scheduledWakeFailures.get(resolve(failed.rootSessionFile))).toBe(now);
		enumeration.resolve([]);
		await staleRecompute;
		await supervisor.scheduledWakeRecompute;
		expect(supervisor.scheduledWakeFailures.get(resolve(failed.rootSessionFile))).toBe(now);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(2);
	});

	it.each(["paused", "cancelled", "claimed", "rescheduled", "removed"] as const)(
		"rechecks a queued root that becomes %s while an earlier create is pending",
		async (change) => {
			const records = [candidate("first"), candidate("next")];
			const next = records[1]!;
			const { supervisor, resident } = createHarness(records);
			const creation = createDeferred();
			const entered = createDeferred();
			supervisor.createOrReuseWorker.mockImplementation(async (_clientId, command) => {
				entered.resolve();
				await creation.promise;
				resident.add(command.sessionPath);
				return {};
			});
			const drain = supervisor.wakeDueScheduledSessions(now);
			await entered.promise;
			if (change === "paused" || change === "cancelled") next.job.status = change;
			if (change === "claimed") resident.add(next.rootSessionFile);
			if (change === "rescheduled") next.job.nextRunAt = new Date(now + 300_000).toISOString();
			if (change === "removed") records.splice(1, 1);
			creation.resolve();
			await drain;

			expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
			expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith("scheduled-wake", {
				type: "create",
				sessionPath: records[0]!.rootSessionFile,
			});
		},
	);

	it("rereads durable job changes between launches while loading the family only once per drain", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-scheduled-singleflight-"));
		tempDirs.push(directory);
		const sessionDir = join(directory, "sessions");
		mkdirSync(sessionDir);
		const records = [candidate("first"), candidate("next")];
		const stores = records.map((record) => {
			const sessionFile = join(sessionDir, `${record.info.id}.jsonl`);
			writeFileSync(sessionFile, "");
			record.rootSessionFile = sessionFile;
			record.info.path = sessionFile;
			const store = AgentCronJobStore.forSessionArtifacts();
			store.registerSessionArtifact(record.info.id, getSessionArtifactPathForFile(sessionFile, record.info.id));
			store.createHeartbeat({
				activeSessionId: record.job.activeSessionId,
				sessionId: record.info.id,
				sessionFile,
				cwd: "/tmp/project",
				scheduleText: "every 5m",
				prompt: "scheduled test tick",
				now: new Date(now - 600_000),
			});
			return store;
		});
		const { supervisor, resident } = createHarness(records);
		Reflect.deleteProperty(supervisor, "collectPassiveScheduledJobs");
		const family = vi.fn(async () => records.map((record) => record.info));
		Object.assign(supervisor, {
			defaultSessionConfig: { agentDir: directory },
			rlmSpawnLedgerInstance: { family },
			collectEphemeralCancelIntents: vi.fn(() => []),
		});
		const creation = createDeferred();
		const entered = createDeferred();
		supervisor.createOrReuseWorker.mockImplementation(async (_clientId, command) => {
			stores[1]!.pauseHeartbeat(records[1]!.job.activeSessionId);
			entered.resolve();
			await creation.promise;
			resident.add(command.sessionPath);
			return {};
		});

		const drain = supervisor.wakeDueScheduledSessions(now);
		try {
			await entered.promise;
			expect(family).toHaveBeenCalledOnce();
			expect(stores[1]!.list()[0]?.status).toBe("paused");
		} finally {
			creation.resolve();
			await drain;
		}
		await supervisor.scheduledWakeRecompute;
		expect(family).toHaveBeenCalledTimes(2);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith("scheduled-wake", {
			type: "create",
			sessionPath: records[0]!.rootSessionFile,
		});
		expect(supervisor.scheduledWakeTimer).toBeUndefined();
	});

	it("keeps a failed root on its retry floor while waking healthy roots on time", async () => {
		const failed = candidate("failed");
		const healthy = candidate("healthy");
		const upcoming = candidate("upcoming", now + 1000);
		const { supervisor, resident } = createHarness([failed, healthy, upcoming]);
		let failedAttempts = 0;
		supervisor.createOrReuseWorker.mockImplementation(async (_clientId, command) => {
			if (command.sessionPath === failed.rootSessionFile && ++failedAttempts === 1) {
				throw new Error("synthetic create failure");
			}
			resident.add(command.sessionPath);
			return {};
		});

		await supervisor.wakeDueScheduledSessions(now);
		await supervisor.scheduledWakeRecompute;
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(2);
		expect(resident.has(healthy.rootSessionFile)).toBe(true);
		await supervisor.wakeDueScheduledSessions(now);
		expect(failedAttempts).toBe(1);
		await vi.advanceTimersByTimeAsync(999);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(resident.has(upcoming.rootSessionFile)).toBe(true);
		expect(failedAttempts).toBe(1);
		await supervisor.wakeDueScheduledSessions();
		expect(failedAttempts).toBe(1);
		await vi.advanceTimersByTimeAsync(58_999);
		expect(failedAttempts).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(failedAttempts).toBe(2);
		expect(resident.has(failed.rootSessionFile)).toBe(true);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledTimes(4);
		expect(supervisor.scheduledWakeFailures.size).toBe(0);
	});

	it.each(["shutdown", "draining", "fencing", "prepared"] as const)(
		"stops new launches when %s begins during an active create",
		async (phase) => {
			const { supervisor, resident } = createHarness([candidate("first"), candidate("next")]);
			const creation = createDeferred();
			const entered = createDeferred();
			supervisor.createOrReuseWorker.mockImplementation(async (_clientId, command) => {
				entered.resolve();
				await creation.promise;
				resident.add(command.sessionPath);
				return {};
			});
			const drain = supervisor.wakeDueScheduledSessions(now);
			await entered.promise;
			if (phase === "shutdown") supervisor.shuttingDown = true;
			else supervisor.updateRestartPhase = phase;
			supervisor.scheduleScheduledSessionWakeRecompute();
			creation.resolve();
			await drain;
			await supervisor.wakeDueScheduledSessions();
			await supervisor.scheduledWakeRecompute;
			expect(supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
			expect(supervisor.scheduledWakeTimer).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
