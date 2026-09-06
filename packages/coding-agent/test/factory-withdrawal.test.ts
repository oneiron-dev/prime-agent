import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFactoryCli } from "../src/factory/cli.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FactoryStore } from "../src/factory/store.js";
import type { ActionWithdrawal, FactoryAdapter, FactoryPlan } from "../src/factory/types.js";

const directories: string[] = [];
const stores: FactoryStore[] = [];
const evidence = {
	actor: "owner",
	reason: "Owner deferred this check; do not execute",
	ref: "fixture:owner-directive",
};
function fixture(queued = false) {
	const directory = mkdtempSync(join(tmpdir(), "factory-withdraw-"));
	directories.push(directory);
	const path = join(directory, "factory.db");
	const store = new FactoryStore(path);
	stores.push(store);
	const adapter: FactoryAdapter = {
		launch: vi.fn(async () => ({ kind: "uncertain" as const, reason: "fixture only" })),
		inspect: vi.fn(async () => ({ kind: "uncertain" as const, reason: "fixture only" })),
	};
	const pauseFile = join(directory, "OWNER-PAUSE");
	const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile });
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "owner" }],
		slots: [{ id: "slot", host: "fixture" }],
		actions: ["old", "dependent", "other"].map((id) => ({
			id,
			ticketId: "ticket",
			kind: "process",
			dependencies: id === "dependent" ? ["old"] : id === "old" && queued ? ["other"] : [],
			sourceFingerprint: `fixture:${id}`,
			command: { argv: ["NEVER-EXECUTE-FIXTURE"], cwd: join(directory, id) },
			requirements: {},
		})),
	};
	engine.applyPlan(plan, 0);
	const withdrawal: ActionWithdrawal = {
		version: 1,
		actionId: "old",
		planRevision: 1,
		ticketId: "ticket",
		ticketOwner: "owner",
		sourceFingerprint: "fixture:old",
		cwd: join(directory, "old"),
	};
	writeFileSync(join(directory, "config.json"), JSON.stringify({ version: 1, hosts: {} }));
	return { directory, path, store, engine, adapter, plan, withdrawal, pauseFile };
}
function snapshot(store: FactoryStore) {
	return { status: store.status(), events: store.events(0, 10000), management: store.managementRequests() };
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("explicit unstarted action withdrawal", () => {
	it.each([false, true])(
		"closes unstarted queued=%s work with NOT_EXECUTED, no attempt or dependency acceptance",
		async (queued) => {
			const f = fixture(queued);
			const other = f.store.claim("other", "slot")!;
			f.store.markSubmitted(other.attempt.id);
			f.store.markUncertain(other.attempt.id, "unrelated custody");
			f.store.claimManagement({
				id: "unrelated-manager",
				wakeId: f.store.wakes()[0].id,
				actionId: "other",
				attemptId: other.attempt.id,
				planRevision: 1,
				evidenceSha256: "0".repeat(64),
			});
			const before = snapshot(f.store);
			expect(f.engine.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toBe(true);
			expect(f.store.actions()[0]).toEqual({ ...before.status.actions[0], state: "WITHDRAWN" });
			expect(f.store.actions().slice(1)).toEqual(before.status.actions.slice(1));
			expect(f.store.attempts()).toEqual(before.status.attempts);
			expect(f.store.wakes()).toEqual(before.status.wakes);
			expect(f.store.managementRequests()).toEqual(before.management);
			expect(f.store.status().planRevision).toBe(1);
			expect(f.store.tickets()[0].state).toBe("ACTIVE");
			expect(f.store.events(before.events.at(-1)!.sequence)).toEqual([
				expect.objectContaining({
					kind: "action_withdrawn",
					actionId: "old",
					attemptId: null,
					detail: {
						withdrawal: f.withdrawal,
						...evidence,
						outcome: "NOT_EXECUTED",
						previousState: queued ? "QUEUED" : "READY",
					},
				}),
			]);
			const reopened = new FactoryStore(f.path);
			stores.push(reopened);
			expect(reopened.applyPlan(f.plan, 1)).toBe(1);
			await new FactoryEngine(reopened, f.adapter, { enabled: true }).tick();
			expect(f.adapter.launch).not.toHaveBeenCalled();
			expect(reopened.claim("old", "slot")).toBeUndefined();
			expect(reopened.actions()[0].state).toBe("WITHDRAWN");
			expect(() => reopened.decide("old", "accept", evidence, 1)).toThrow("semantic decision");
		},
	);

	it.each([false, true])("keeps withdrawn queued=%s work immutable across reopen", (queued) => {
		const f = fixture(queued);
		expect(f.engine.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toBe(true);
		const reopened = new FactoryStore(f.path);
		stores.push(reopened);
		expect(reopened.applyPlan(f.plan, 1)).toBe(1);
		expect(reopened.actions()[0].state).toBe("WITHDRAWN");
		expect(reopened.managementRequests()).toEqual([]);
		const before = snapshot(reopened);
		const changed = structuredClone(f.plan);
		changed.actions[0].command.argv = ["changed"];
		expect(() => reopened.applyPlan(changed, 1)).toThrow("immutable");
		expect(snapshot(reopened)).toEqual(before);
	});

	it("preserves exact idempotence across reopen and later plan revision, refuses changed payloads", () => {
		const f = fixture();
		f.engine.withdrawUnstarted("old", f.withdrawal, evidence, 1);
		f.engine.applyPlan({ version: 1, tickets: [{ id: "ticket", owner: "new-owner" }], slots: [], actions: [] }, 1);
		const before = snapshot(f.store);
		const second = new FactoryStore(f.path);
		stores.push(second);
		expect(second.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toBe(false);
		expect(() => second.withdrawUnstarted("old", f.withdrawal, { ...evidence, reason: "changed" }, 1)).toThrow(
			"different payload",
		);
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each(["actionId", "ticketId", "ticketOwner", "sourceFingerprint", "cwd", "planRevision", "version"] as const)(
		"refuses wrong %s binding atomically",
		(key) => {
			const f = fixture();
			const before = snapshot(f.store);
			expect(() =>
				f.store.withdrawUnstarted(
					"old",
					{ ...f.withdrawal, [key]: typeof f.withdrawal[key] === "number" ? 99 : "wrong" },
					evidence,
					1,
				),
			).toThrow();
			expect(snapshot(f.store)).toEqual(before);
		},
	);

	it("refuses stale current revision, owner and action definition", () => {
		const f = fixture();
		f.plan.tickets[0].owner = "new-owner";
		f.plan.actions[0].command.argv = ["different"];
		f.engine.applyPlan(f.plan, 1);
		const before = snapshot(f.store);
		expect(() => f.store.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toThrow("revision changed");
		expect(() => f.store.withdrawUnstarted("old", { ...f.withdrawal, planRevision: 2 }, evidence, 2)).toThrow(
			"ownership changed",
		);
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each([undefined, NaN, -1, 0, 2])("requires exact revision %s", (revision) => {
		const f = fixture();
		const before = snapshot(f.store);
		expect(() => f.store.withdrawUnstarted("old", f.withdrawal, evidence, revision as number)).toThrow("revision");
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each(["PREPARED", "SUBMITTED", "RUNNING", "UNCERTAIN", "TERMINAL", "released-prepared", "retry-ready"])(
		"refuses %s attempt history even if no current claim",
		(state) => {
			const f = fixture();
			const attempt = f.store.claim("old", "slot")!.attempt;
			if (state === "released-prepared") f.store.abandonPrepared(attempt.id);
			else if (state !== "PREPARED") {
				f.store.markSubmitted(attempt.id);
				if (state === "RUNNING") f.store.markRunning(attempt.id, "fixture:pid:start");
				if (state === "UNCERTAIN" || state === "retry-ready") f.store.markUncertain(attempt.id, "unknown");
				if (state === "retry-ready") f.store.resolveForRetry(attempt.id, evidence, 1);
				if (state === "TERMINAL")
					f.store.complete({
						attemptId: attempt.id,
						sourceFingerprint: "fixture:old",
						exitCode: 0,
						finishedAt: new Date().toISOString(),
					});
			}
			const before = snapshot(f.store);
			expect(() => f.store.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toThrow("unstarted");
			expect(snapshot(f.store)).toEqual(before);
		},
	);

	it("refuses management authority even in an inconsistent unstarted fixture", () => {
		const f = fixture();
		const db = new DatabaseSync(f.path);
		try {
			db.exec(
				"INSERT INTO wakes(id,action_id,attempt_id,reason,created_at) VALUES(1,'old','unexpected','fixture','2026-09-06'); INSERT INTO management_requests(id,wake_id,action_id,attempt_id,plan_revision,evidence_sha256,created_at,state) VALUES('unexpected',1,'old','unexpected',1,'hash','2026-09-06','CLAIMED')",
			);
			const before = snapshot(f.store);
			expect(() => f.store.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toThrow("management");
			expect(snapshot(f.store)).toEqual(before);
		} finally {
			db.close();
		}
	});

	it.each(["local", "external"])("honors %s pause", (kind) => {
		const f = fixture();
		if (kind === "local") f.store.pause("owner");
		else writeFileSync(f.pauseFile, "owner");
		const before = snapshot(f.store);
		expect(() => f.engine.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toThrow("paused");
		expect(snapshot(f.store)).toEqual(before);
	});

	it("rolls back closure if journaling fails", () => {
		const f = fixture();
		const db = new DatabaseSync(f.path);
		try {
			db.exec(
				"CREATE TRIGGER fail_withdrawal BEFORE INSERT ON events WHEN NEW.kind='action_withdrawn' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END",
			);
			const before = snapshot(f.store);
			expect(() => f.store.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toThrow("injected journal failure");
			expect(snapshot(f.store)).toEqual(before);
			db.exec("DROP TRIGGER fail_withdrawal");
			expect(f.store.withdrawUnstarted("old", f.withdrawal, evidence, 1)).toBe(true);
		} finally {
			db.close();
		}
	});

	it("serializes concurrent scheduler claim and withdrawal in separate processes", async () => {
		const f = fixture();
		const source = pathToFileURL(resolve("src/factory/store.ts")).href;
		const loader = pathToFileURL(resolve("../../node_modules/tsx/dist/loader.mjs")).href;
		const workers = ["claim", "withdraw"].map((operation) => {
			const call =
				operation === "claim"
					? `Boolean(store.claim("old", "slot"))`
					: `store.withdrawUnstarted("old", ${JSON.stringify(f.withdrawal)}, ${JSON.stringify(evidence)}, 1)`;
			const code = `import { FactoryStore } from ${JSON.stringify(source)}; const store = new FactoryStore(${JSON.stringify(f.path)}); process.stdout.write(${JSON.stringify("ready\n")}); process.stdin.once('data', () => { try { console.log(JSON.stringify({ won: ${call} })); } catch(error) { console.log(JSON.stringify({ won: false, error: error.message })); } finally { store.close(); process.stdin.destroy(); } });`;
			const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", code], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "";
			let stderr = "";
			const ready = new Promise<void>((done, reject) => {
				child.stdout.on("data", (data) => {
					output += String(data);
					if (output.includes("ready\n")) done();
				});
				child.once("error", reject);
				child.once("close", () => {
					if (!output.includes("ready\n")) reject(new Error(stderr || "Worker closed before ready"));
				});
			});
			child.stderr.on("data", (data) => {
				stderr += String(data);
			});
			const done = new Promise<{ won: boolean; error?: string }>((done, reject) => {
				child.once("error", reject);
				child.stdin.on("error", reject);
				child.once("close", (exit) => {
					if (exit !== 0) reject(new Error(stderr || `Worker closed with code ${exit}`));
					else {
						try {
							done(JSON.parse(output.trim().split("\n").at(-1)!));
						} catch (error) {
							reject(error);
						}
					}
				});
			});
			return { child, ready, done };
		});
		try {
			const [, results] = await Promise.all([
				Promise.all(workers.map((worker) => worker.ready)).then(() => {
					for (const worker of workers) worker.child.stdin.write("go\n");
				}),
				Promise.all(workers.map((worker) => worker.done)),
			]);
			expect(results.filter((result) => result.won)).toHaveLength(1);
			if (results[0].won) {
				expect(results[1].error).toContain("unstarted");
				expect(f.store.actions()[0].state).toBe("RUNNING");
				expect(f.store.attempts()).toHaveLength(1);
				expect(f.store.events().some((event) => event.kind === "action_withdrawn")).toBe(false);
			} else {
				expect(f.store.actions()[0].state).toBe("WITHDRAWN");
				expect(f.store.attempts()).toHaveLength(0);
			}
		} finally {
			for (const worker of workers) worker.child.kill();
			await Promise.allSettled(workers.map((worker) => worker.done));
		}
	});

	it("exposes explicit CLI withdrawal and command help without running a scheduler", async () => {
		const f = fixture();
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runFactoryCli(["withdraw", "--help"]);
		expect(output.mock.calls.at(-1)![0]).toContain("NOT_EXECUTED");
		const bundle = join(f.directory, "withdrawal.json");
		writeFileSync(bundle, JSON.stringify(f.withdrawal));
		const args = [
			"withdraw",
			f.directory,
			"old",
			"--actor",
			evidence.actor,
			"--reason",
			evidence.reason,
			"--ref",
			bundle,
		];
		await expect(runFactoryCli(args)).rejects.toThrow("--expected-revision");
		await expect(runFactoryCli([...args, "extra", "--expected-revision", "1"])).rejects.toThrow(
			"exactly one action-id",
		);
		await expect(
			runFactoryCli([...args, "--expected-revision", "1", "--expected-attempt", "fabricated"]),
		).rejects.toThrow("unstarted");
		await runFactoryCli([...args, "--expected-revision", "1"]);
		await runFactoryCli([...args, "--expected-revision", "1"]);
		expect(JSON.parse(output.mock.calls.at(-1)![0]).actions[0].state).toBe("WITHDRAWN");
		expect(f.store.attempts()).toHaveLength(0);
		expect(f.adapter.launch).not.toHaveBeenCalled();
	});
});
