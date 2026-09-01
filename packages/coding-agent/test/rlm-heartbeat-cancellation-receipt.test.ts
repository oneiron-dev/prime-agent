import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore, AgentCronScheduler } from "../src/core/cron-jobs.js";

const start = new Date("2026-01-01T12:34:00.000Z");
const cancelledAt = new Date("2026-01-01T12:34:10.000Z");
const owner = {
	activeSessionId: "child-active-1",
	sessionId: "child-session-1",
	sessionFile: "/tmp/child-session.jsonl",
	cwd: "/tmp/project",
	runtimeKind: "subagent" as const,
};

describe("RLM heartbeat cancellation receipts", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns and persists an immutable receipt for an unrun owned heartbeat", () => {
		const storePath = makeStorePath(tempDirs);
		const store = new AgentCronJobStore(storePath);
		const heartbeat = createHeartbeat(store);

		const receipt = store.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id, cancelledAt);

		expect(receipt).toEqual({
			id: heartbeat.id,
			source: "rlm_heartbeat",
			status: "cancelled",
			ownerActiveSessionId: owner.activeSessionId,
			ownerSessionId: owner.sessionId,
			ownerSessionFile: owner.sessionFile,
			ownerRuntimeKind: "subagent",
			runCount: 0,
			cancelledAt: cancelledAt.toISOString(),
		});
		expect(store.listRlmHeartbeats(owner.activeSessionId)).toEqual([]);
		expect(store.listRlmHeartbeats(owner.activeSessionId, { includeInactive: true })[0]).toMatchObject({
			id: heartbeat.id,
			status: "cancelled",
			cancellationReceipt: receipt,
		});
	});

	it("records run_count 0 and null last_run when the first firing deletes itself", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = createHeartbeat(store);
		let receipt: ReturnType<AgentCronJobStore["deleteRlmHeartbeat"]>;
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:34:30.000Z"),
			runJob: async () => {
				receipt = store.deleteRlmHeartbeat(
					owner.activeSessionId,
					heartbeat.id,
					new Date("2026-01-01T12:34:30.100Z"),
				);
				return undefined;
			},
		});

		expect(await scheduler.runDue(new Date("2026-01-01T12:34:30.000Z"))).toBe(1);
		expect(receipt).toMatchObject({
			id: heartbeat.id,
			status: "cancelled",
			runCount: 0,
			cancelledAt: "2026-01-01T12:34:30.100Z",
		});
		expect(receipt).not.toHaveProperty("lastRunAt");
		expect(store.listRlmHeartbeats(owner.activeSessionId)).toEqual([]);
	});

	it("snapshots the run count and last run after a heartbeat has fired", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = createHeartbeat(store);
		store.recordRunResult(heartbeat.id, { now: new Date("2026-01-01T12:34:30.000Z") });

		const receipt = store.deleteRlmHeartbeat(
			owner.activeSessionId,
			heartbeat.id,
			new Date("2026-01-01T12:34:40.000Z"),
		);

		expect(receipt).toMatchObject({
			id: heartbeat.id,
			status: "cancelled",
			runCount: 1,
			lastRunAt: "2026-01-01T12:34:30.000Z",
			cancelledAt: "2026-01-01T12:34:40.000Z",
		});
	});

	it("keeps the receipt when session shutdown cancels the heartbeat first", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = createHeartbeat(store);

		store.cancelRlmHeartbeatsForSession(owner.activeSessionId, cancelledAt);
		const receipt = store.deleteRlmHeartbeat(
			owner.activeSessionId,
			heartbeat.id,
			new Date("2026-01-02T00:00:00.000Z"),
		);

		expect(receipt).toMatchObject({
			id: heartbeat.id,
			status: "cancelled",
			runCount: 0,
			cancelledAt: cancelledAt.toISOString(),
		});
	});

	it("fails closed for an unknown id or a heartbeat owned by another session", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = createHeartbeat(store);

		expect(store.deleteRlmHeartbeat(owner.activeSessionId, "missing", cancelledAt)).toBeUndefined();
		expect(store.deleteRlmHeartbeat("other-active-session", heartbeat.id, cancelledAt)).toBeUndefined();
		expect(store.listRlmHeartbeats(owner.activeSessionId)).toEqual([
			expect.objectContaining({ id: heartbeat.id, status: "active" }),
		]);
	});

	it("keeps prior owner identity immutable when the session gets a new active id", () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = createHeartbeat(store);
		const receipt = store.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id, cancelledAt);
		store.rebindSessionJobs({
			activeSessionId: "child-active-2",
			sessionId: owner.sessionId,
			sessionFile: owner.sessionFile,
			cwd: owner.cwd,
		});

		expect(store.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id)).toBeUndefined();
		expect(store.deleteRlmHeartbeat("child-active-2", heartbeat.id)).toEqual(receipt);
		expect(receipt).toMatchObject({
			ownerActiveSessionId: owner.activeSessionId,
			ownerSessionId: owner.sessionId,
		});
	});

	it("returns the same receipt after the authoritative session artifact store is reopened", () => {
		const artifactDir = makeTempDir(tempDirs);
		const firstStore = AgentCronJobStore.forSessionArtifacts();
		firstStore.registerSessionArtifact(owner.sessionId, artifactDir);
		const heartbeat = createHeartbeat(firstStore);
		const firstReceipt = firstStore.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id, cancelledAt);

		const reopenedStore = AgentCronJobStore.forSessionArtifacts();
		reopenedStore.registerSessionArtifact(owner.sessionId, artifactDir);
		const reopenedReceipt = reopenedStore.deleteRlmHeartbeat(
			owner.activeSessionId,
			heartbeat.id,
			new Date("2026-01-02T00:00:00.000Z"),
		);

		expect(reopenedReceipt).toEqual(firstReceipt);
		expect(reopenedReceipt).toMatchObject({ cancelledAt: cancelledAt.toISOString() });
	});

	it("promotes a persisted cancelled entry into a receipt without replaying it", () => {
		const storePath = makeStorePath(tempDirs);
		const initialStore = new AgentCronJobStore(storePath);
		const heartbeat = createHeartbeat(initialStore);
		const { nextRunAt: _nextRunAt, ...cancelledHeartbeat } = heartbeat;
		writeFileSync(
			storePath,
			`${JSON.stringify(
				{
					jobs: [
						{
							...cancelledHeartbeat,
							status: "cancelled",
							updatedAt: cancelledAt.toISOString(),
						},
					],
					dispatches: [],
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		const reopenedStore = new AgentCronJobStore(storePath);
		const receipt = reopenedStore.deleteRlmHeartbeat(
			owner.activeSessionId,
			heartbeat.id,
			new Date("2026-01-02T00:00:00.000Z"),
		);

		expect(receipt).toMatchObject({
			id: heartbeat.id,
			status: "cancelled",
			runCount: 0,
			cancelledAt: cancelledAt.toISOString(),
		});
		expect(reopenedStore.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id)).toEqual(receipt);
	});

	it("never executes a heartbeat after its cancellation receipt is committed", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = createHeartbeat(store);
		const receipt = store.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id, cancelledAt);
		const prompts: string[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async (job) => {
				prompts.push(job.prompt);
				return undefined;
			},
		});

		expect(await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"))).toBe(0);
		expect(prompts).toEqual([]);
		expect(store.deleteRlmHeartbeat(owner.activeSessionId, heartbeat.id)).toEqual(receipt);
	});
});

function createHeartbeat(store: AgentCronJobStore) {
	return store.createRlmHeartbeat({
		...owner,
		label: "terminal-consumer",
		scheduleText: "every 30s",
		prompt: "consume the terminal result once",
		now: start,
	});
}

function makeStorePath(tempDirs: string[]): string {
	return join(makeTempDir(tempDirs), "scheduled-jobs.json");
}

function makeTempDir(tempDirs: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-rlm-heartbeat-receipt-"));
	tempDirs.push(dir);
	return dir;
}
