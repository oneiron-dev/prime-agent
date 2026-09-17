import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFactoryCli } from "../src/factory/cli.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FactoryStore } from "../src/factory/store.js";
import type { ActionSpec, FactoryAdapter, FactoryPlan, NonRetrySettlement } from "../src/factory/types.js";

const directories: string[] = [];
const stores: FactoryStore[] = [];
const evidence = {
	actor: "fixture-owner",
	reason: "Close without retry; original outcome UNKNOWN",
	ref: "fixture:review",
};
const uncertainty = "Supervisor vanished; child custody unknown; partial FAILED lines retained";
function artifact(directory: string, name: string, value: unknown) {
	const ref = join(directory, name);
	const bytes = JSON.stringify(value);
	writeFileSync(ref, bytes);
	return { ref, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function fixture(kind: ActionSpec["kind"] = "process") {
	const directory = mkdtempSync(join(tmpdir(), "factory-nonretry-"));
	directories.push(directory);
	const path = join(directory, "factory.db");
	const store = new FactoryStore(path);
	stores.push(store);
	const adapter: FactoryAdapter = {
		launch: vi.fn(async () => ({ kind: "uncertain" as const, reason: uncertainty })),
		inspect: vi.fn(async () => ({ kind: "uncertain" as const, reason: uncertainty })),
	};
	const pauseFile = join(directory, "OWNER-PAUSE");
	const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile });
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "fixture-owner" }],
		slots: [
			{ id: "slot", host: "fixture-host" },
			{ id: "other-slot", host: "fixture-host" },
		],
		actions: ["old", "dependent", "other"].map((id) => ({
			id,
			ticketId: "ticket",
			dependencies: id === "dependent" ? ["old"] : [],
			kind,
			sourceFingerprint: `fixture:${id}`,
			command: { argv: ["NEVER-EXECUTE-FIXTURE"], cwd: join(directory, id) },
			requirements: {},
		})),
	};
	for (const action of plan.actions) mkdirSync(action.command.cwd);
	engine.applyPlan(plan, 0);
	const claimed = store.claim("old", "slot")!;
	const attemptId = claimed.attempt.id;
	store.markSubmitted(attemptId);
	store.markRunning(attemptId, "fixture:boot:pid:start");
	store.markUncertain(attemptId, uncertainty);
	const wakeId = store.wakes()[0].id;
	const binding = {
		version: 1 as const,
		actionId: "old",
		attemptId,
		planRevision: 1,
		wakeId,
		ticketOwner: "fixture-owner",
		slotId: "slot",
		host: "fixture-host",
		cwd: claimed.action.command.cwd,
		sourceFingerprint: claimed.action.sourceFingerprint,
		processIdentity: "fixture:boot:pid:start",
		uncertainty,
	};
	const custody = {
		supervisorStopped: true as const,
		processGroupStopped: true as const,
		cannotExecute: true as const,
		observedAt: new Date().toISOString(),
	};
	const settlement: NonRetrySettlement = {
		...binding,
		custody: { ...custody, ...artifact(directory, "death.json", { ...binding, ...custody }) },
		artifacts: [artifact(directory, "partial-output.json", { outcome: "UNKNOWN", lines: ["FAILED"] })],
	};
	writeFileSync(join(directory, "config.json"), JSON.stringify({ version: 1, hosts: {} }));
	return { directory, path, store, engine, adapter, settlement, attemptId, pauseFile, plan };
}
function rebindProof(directory: string, settlement: NonRetrySettlement): void {
	const { custody, artifacts: _artifacts, ...binding } = settlement;
	const { ref: _ref, sha256: _sha256, ...facts } = custody;
	settlement.custody = { ...custody, ...artifact(directory, "death.json", { ...binding, ...facts }) };
}
function snapshot(store: FactoryStore) {
	return { status: store.status(), events: store.events(0, 10000), management: store.managementRequests() };
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native no-retry settlement", () => {
	describe("abandoned action supersession", () => {
		it("explicitly replaces abandoned work, preserves duplicate settlement and ignores late observations", async () => {
			const f = fixture();
			f.engine.settleWithoutRetry("old", f.settlement, evidence, 1);
			const original = f.store.context(f.attemptId).attempt;
			const replacement = { ...f.plan.actions[0], id: "replacement", sourceFingerprint: "fixture:repair" };
			f.engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] }, 1);
			expect(() => f.engine.supersede("old", "replacement", evidence, 1)).toThrow("revision changed");
			expect(() => f.engine.supersede("old", "replacement", evidence)).toThrow("revision");
			expect(f.engine.supersede("old", "replacement", evidence, 2)).toBe(3);
			expect(f.store.actions()[0].state).toBe("SUPERSEDED");
			expect(f.store.actions()[1]).toMatchObject({ state: "QUEUED", dependencies: ["replacement"] });
			const before = snapshot(f.store);
			const reopened = new FactoryStore(f.path);
			stores.push(reopened);
			expect(reopened.settleWithoutRetry("old", f.settlement, evidence, 1)).toBe(false);
			expect(() => reopened.settleWithoutRetry("old", f.settlement, { ...evidence, reason: "changed" }, 1)).toThrow(
				"different payload",
			);
			reopened.markRunning(f.attemptId, f.settlement.processIdentity);
			reopened.markUncertain(f.attemptId, "late original observation");
			expect(() =>
				reopened.complete({
					attemptId: f.attemptId,
					sourceFingerprint: f.settlement.sourceFingerprint,
					exitCode: 0,
					finishedAt: new Date().toISOString(),
				}),
			).toThrow("abandoned");
			expect(snapshot(f.store)).toEqual(before);
			await f.engine.tick();
			expect(f.store.context(f.attemptId).attempt).toEqual(original);
			expect(f.store.attempts().filter((attempt) => attempt.actionId === "old")).toHaveLength(1);
			expect(f.store.actions()[1].state).toBe("QUEUED");
			expect(f.adapter.launch).not.toHaveBeenCalledWith(
				expect.objectContaining({ action: expect.objectContaining({ id: "old" }) }),
			);
			expect(f.store.events(0, 10000).find((event) => event.kind === "action_superseded")).toMatchObject({
				detail: { previousState: "ABANDONED", replacementId: "replacement" },
			});
		});

		it.each(["QUEUED", "READY"] as const)("allows only fresh %s replacement work", (state) => {
			const f = fixture();
			f.engine.settleWithoutRetry("old", f.settlement, evidence, 1);
			const replacement = {
				...f.plan.actions[0],
				id: "replacement",
				dependencies: state === "QUEUED" ? ["other"] : [],
			};
			f.engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] }, 1);
			expect(f.store.actions().at(-1)!.state).toBe(state);
			expect(f.store.attempts().filter((attempt) => attempt.actionId === "replacement")).toEqual([]);
			expect(f.engine.supersede("old", "replacement", evidence, 2)).toBe(3);
			expect(f.store.actions()[1]).toMatchObject({ state: "QUEUED", dependencies: ["replacement"] });
			expect(f.store.context(f.attemptId).attempt).toMatchObject({ state: "ABANDONED", receipt: null });
		});

		it.each(["ACCEPTED", "RUNNING", "UNCERTAIN", "AWAITING_DECISION"] as const)(
			"refuses a genuinely started %s replacement without rewiring dependencies",
			(state) => {
				const f = fixture(state === "AWAITING_DECISION" ? "decision" : "process");
				f.engine.settleWithoutRetry("old", f.settlement, evidence, 1);
				const replacement = { ...f.plan.actions[0], id: "replacement" };
				f.engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] }, 1);
				const claimed = f.store.claim("replacement", "slot")!;
				f.store.markSubmitted(claimed.attempt.id);
				f.store.markRunning(claimed.attempt.id, "replacement:pid:start");
				if (state === "UNCERTAIN") f.store.markUncertain(claimed.attempt.id, "replacement custody unknown");
				if (state === "ACCEPTED" || state === "AWAITING_DECISION")
					f.store.complete({
						attemptId: claimed.attempt.id,
						sourceFingerprint: replacement.sourceFingerprint,
						exitCode: 0,
						finishedAt: new Date().toISOString(),
					});
				expect(f.store.actions().at(-1)!.state).toBe(state);
				const db = new DatabaseSync(f.path);
				try {
					const dependencies = db.prepare("SELECT * FROM dependencies ORDER BY action_id,dependency_id").all();
					const before = snapshot(f.store);
					expect(() => f.engine.supersede("old", "replacement", evidence, 2)).toThrow("unstarted");
					expect(snapshot(f.store)).toEqual(before);
					expect(db.prepare("SELECT * FROM dependencies ORDER BY action_id,dependency_id").all()).toEqual(
						dependencies,
					);
					expect(f.store.claim("dependent", "other-slot")).toBeUndefined();
				} finally {
					db.close();
				}
			},
		);

		describe.each(["QUEUED", "READY"] as const)("%s replacement history", (state) => {
			it.each(["claim", "released-prepared", "retry", "wake", "management"])(
				"refuses %s without rewiring dependencies",
				(history) => {
					const f = fixture();
					f.engine.settleWithoutRetry("old", f.settlement, evidence, 1);
					f.engine.applyPlan(
						{ version: 1, tickets: [], slots: [], actions: [{ ...f.plan.actions[0], id: "replacement" }] },
						1,
					);
					if (["claim", "released-prepared", "retry"].includes(history)) {
						const claimed = f.store.claim("replacement", "slot")!;
						if (history === "released-prepared") f.store.abandonPrepared(claimed.attempt.id);
						if (history === "retry") {
							f.store.markSubmitted(claimed.attempt.id);
							f.store.markUncertain(claimed.attempt.id, "retry custody");
							f.store.resolveForRetry(claimed.attempt.id, evidence, 2);
						}
					}
					const db = new DatabaseSync(f.path);
					try {
						db.prepare("UPDATE actions SET state=? WHERE id='replacement'").run(state);
						if (history === "wake" || history === "management")
							db.exec(
								"INSERT INTO wakes(id,action_id,reason,created_at,resolved_at) VALUES(99,'replacement','history','2026-09-06','2026-09-06')",
							);
						if (history === "management") {
							db.exec(
								"INSERT INTO management_requests(id,wake_id,action_id,attempt_id,plan_revision,evidence_sha256,created_at,state) VALUES('history',99,'replacement','history',2,'hash','2026-09-06','RECONCILED')",
							);
							db.exec("UPDATE wakes SET action_id='other' WHERE id=99");
						}
						const before = snapshot(f.store);
						const dependencies = db.prepare("SELECT * FROM dependencies ORDER BY action_id,dependency_id").all();
						expect(() => f.engine.supersede("old", "replacement", evidence, 2), history).toThrow("unstarted");
						expect(snapshot(f.store), history).toEqual(before);
						expect(db.prepare("SELECT * FROM dependencies ORDER BY action_id,dependency_id").all()).toEqual(
							dependencies,
						);
					} finally {
						db.close();
					}
				},
			);
		});

		it("preserves intentional REJECTED supersession by an accepted replacement", () => {
			const f = fixture();
			f.store.complete({
				attemptId: f.attemptId,
				sourceFingerprint: f.settlement.sourceFingerprint,
				exitCode: 1,
				finishedAt: new Date().toISOString(),
			});
			const replacement = { ...f.plan.actions[0], id: "replacement" };
			f.engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] }, 1);
			const claimed = f.store.claim("replacement", "slot")!;
			f.store.markSubmitted(claimed.attempt.id);
			f.store.complete({
				attemptId: claimed.attempt.id,
				sourceFingerprint: replacement.sourceFingerprint,
				exitCode: 0,
				finishedAt: new Date().toISOString(),
			});
			expect(f.engine.supersede("old", "replacement", evidence)).toBe(3);
			expect(f.store.actions()[1]).toMatchObject({ state: "READY", dependencies: ["replacement"] });
		});

		it.each(["self", "missing", "cycle", "ticket", "kind", "REJECTED", "ABANDONED", "WITHDRAWN", "SUPERSEDED"])(
			"refuses invalid %s replacement atomically",
			(scenario) => {
				const f = fixture();
				f.engine.settleWithoutRetry("old", f.settlement, evidence, 1);
				const replacement = {
					...f.plan.actions[0],
					id: "replacement",
					dependencies: scenario === "cycle" ? ["dependent"] : [],
					ticketId: scenario === "ticket" ? "foreign" : "ticket",
					kind: scenario === "kind" ? ("decision" as const) : ("process" as const),
				};
				f.engine.applyPlan(
					{ version: 1, tickets: [{ id: "foreign", owner: "foreign-owner" }], slots: [], actions: [replacement] },
					1,
				);
				if (["REJECTED", "ABANDONED", "WITHDRAWN", "SUPERSEDED"].includes(scenario)) {
					const db = new DatabaseSync(f.path);
					try {
						db.prepare("UPDATE actions SET state=? WHERE id='replacement'").run(scenario);
					} finally {
						db.close();
					}
				}
				const before = snapshot(f.store);
				expect(() =>
					f.engine.supersede(
						"old",
						scenario === "self" ? "old" : scenario === "missing" ? "missing" : "replacement",
						evidence,
						2,
					),
				).toThrow(scenario === "cycle" ? "cycle" : "same ticket and kind");
				expect(snapshot(f.store)).toEqual(before);
			},
		);
	});

	it("reproduces the existing intentional retry path admitting the unchanged command again", async () => {
		const f = fixture();
		f.engine.resolveForRetry(f.attemptId, evidence, 1);
		expect(f.store.actions()[0].state).toBe("READY");
		await f.engine.tick();
		const replay = f.store.attempts().filter((attempt) => attempt.actionId === "old");
		expect(replay).toHaveLength(2);
		expect(replay[1].id).not.toBe(f.attemptId);
		expect(f.adapter.launch).toHaveBeenCalledWith(
			expect.objectContaining({ action: expect.objectContaining({ id: "old" }) }),
		);
	});

	it.each(["process", "decision"] as const)(
		"closes %s without acceptance, failure or replay and preserves history",
		async (kind) => {
			const f = fixture(kind);
			const other = f.store.claim("other", "other-slot")!;
			f.store.markSubmitted(other.attempt.id);
			f.store.markUncertain(other.attempt.id, uncertainty);
			const wake = f.store.wakes().find((item) => item.attemptId === other.attempt.id)!;
			f.store.claimManagement({
				id: "other-manager",
				wakeId: wake.id,
				actionId: "other",
				attemptId: other.attempt.id,
				planRevision: 1,
				evidenceSha256: "0".repeat(64),
			});
			const before = snapshot(f.store);
			expect(f.engine.settleWithoutRetry("old", f.settlement, evidence, 1)).toBe(true);
			expect(f.store.context(f.attemptId).attempt).toEqual({
				...before.status.attempts[0],
				state: "ABANDONED",
				claimReleased: true,
			});
			expect(f.store.actions()[0].state).toBe("ABANDONED");
			expect(f.store.actions()[1].state).toBe("QUEUED");
			expect(f.store.tickets()[0].state).toBe("ACTIVE");
			expect(f.store.context(other.attempt.id).attempt).toEqual(before.status.attempts[1]);
			expect(f.store.managementRequests()).toEqual(before.management);
			expect(f.store.wakes()[1]).toEqual(before.status.wakes[1]);
			expect(f.store.wakes()[0]).toEqual({ ...before.status.wakes[0], resolvedAt: expect.any(String) });
			expect(f.store.events(0, 10000).slice(0, before.events.length)).toEqual(before.events);
			const changes = f.store.events(before.events.at(-1)!.sequence);
			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				kind: "uncertainty_settled_without_retry",
				actionId: "old",
				attemptId: f.attemptId,
				detail: { settlement: f.settlement, ...evidence, outcome: "UNKNOWN" },
			});
			const reopened = new FactoryStore(f.path);
			stores.push(reopened);
			expect(reopened.applyPlan(f.plan, 1)).toBe(1);
			expect((await new FactoryEngine(reopened, f.adapter, { enabled: true }).tick()).launched).toEqual([]);
			expect(f.adapter.launch).not.toHaveBeenCalled();
			expect(f.store.attempts()).toHaveLength(2);
			expect(f.store.claim("old", "slot")).toBeUndefined();
			expect(() => f.store.resolveForRetry(f.attemptId, evidence, 1)).toThrow("uncertain claimed");
			expect(() => f.store.decide("old", "accept", evidence, 1)).toThrow("semantic decision");
			expect(() =>
				f.store.complete({
					attemptId: f.attemptId,
					sourceFingerprint: f.settlement.sourceFingerprint,
					exitCode: 0,
					finishedAt: new Date().toISOString(),
				}),
			).toThrow("abandoned");
			f.store.markRunning(f.attemptId, f.settlement.processIdentity);
			f.store.markUncertain(f.attemptId, "Late inspection");
			expect(f.store.context(f.attemptId).attempt.uncertainty).toBe(uncertainty);
			expect(readFileSync(f.settlement.artifacts[0].ref, "utf8")).toContain("FAILED");
		},
	);

	it("rejects a genuinely stale plan snapshot and stale original ownership after a plan change", () => {
		const f = fixture();
		f.engine.applyPlan({ version: 1, tickets: [{ id: "ticket", owner: "new-owner" }], slots: [], actions: [] }, 1);
		const before = snapshot(f.store);
		expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("revision changed");
		f.settlement.planRevision = 2;
		rebindProof(f.directory, f.settlement);
		expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 2)).toThrow("ownership changed");
		expect(snapshot(f.store)).toEqual(before);
	});

	it("refuses a bound real attempt belonging to another action", () => {
		const f = fixture();
		const other = f.store.claim("other", "other-slot")!;
		f.store.markSubmitted(other.attempt.id);
		f.store.markRunning(other.attempt.id, f.settlement.processIdentity);
		f.store.markUncertain(other.attempt.id, uncertainty);
		f.settlement.attemptId = other.attempt.id;
		rebindProof(f.directory, f.settlement);
		const before = snapshot(f.store);
		expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("ownership changed");
		expect(snapshot(f.store)).toEqual(before);
	});

	it("never enters QUEUED or READY even inside the settlement transaction", () => {
		const f = fixture();
		const db = new DatabaseSync(f.path);
		try {
			db.exec(
				"CREATE TRIGGER forbid_requeue BEFORE UPDATE OF state ON actions WHEN NEW.id='old' AND NEW.state IN ('QUEUED','READY') BEGIN SELECT RAISE(ABORT,'replay intermediate'); END",
			);
			expect(f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toBe(true);
		} finally {
			db.close();
		}
	});

	it("does not resurrect a closed action when a concurrent scheduler returns a late inspection", async () => {
		const f = fixture();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.adapter.inspect = vi.fn(async () => {
			await pending;
			return { kind: "running" as const, processIdentity: f.settlement.processIdentity };
		});
		const tick = f.engine.tick();
		const second = new FactoryStore(f.path);
		stores.push(second);
		try {
			second.settleWithoutRetry("old", f.settlement, evidence, 1);
		} finally {
			release();
		}
		await tick;
		expect(f.store.context(f.attemptId).attempt).toMatchObject({
			state: "ABANDONED",
			receipt: null,
			uncertainty,
			claimReleased: true,
		});
		expect(f.store.attempts().filter((attempt) => attempt.actionId === "old")).toHaveLength(1);
		expect(f.store.actions()[0].state).toBe("ABANDONED");
	});

	it.each(["stale", "future"])("refuses %s death observations even with matching hashes", (kind) => {
		const f = fixture();
		f.settlement.custody.observedAt = new Date(Date.now() + (kind === "stale" ? -86400000 : 86400000)).toISOString();
		rebindProof(f.directory, f.settlement);
		const before = snapshot(f.store);
		expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("observation");
		expect(snapshot(f.store)).toEqual(before);
	});

	it("offers command-specific help without a factory directory", async () => {
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runFactoryCli(["settle-no-retry", "--help"]);
		expect(output.mock.calls[0][0]).toContain("--expected-attempt");
		expect(output.mock.calls[0][0]).toContain("UNKNOWN");
	});

	it.each(["slot", "worktree"])("releases the %s only for unrelated work", (resource) => {
		const f = fixture();
		const slot = resource === "slot" ? "slot" : "other-slot";
		if (resource === "worktree") {
			f.plan.actions[2].command.cwd = f.settlement.cwd;
			f.settlement.planRevision = f.engine.applyPlan(f.plan, 1);
			rebindProof(f.directory, f.settlement);
		}
		expect(f.store.claim("other", slot)).toBeUndefined();
		f.store.settleWithoutRetry("old", f.settlement, evidence, f.settlement.planRevision);
		expect(f.store.claim("other", slot)).toBeDefined();
	});

	it("is exactly idempotent across store reopen and refuses changed duplicate payloads", () => {
		const f = fixture();
		f.engine.settleWithoutRetry("old", f.settlement, evidence, 1);
		const before = snapshot(f.store);
		const second = new FactoryStore(f.path);
		stores.push(second);
		expect(second.settleWithoutRetry("old", f.settlement, evidence, 1)).toBe(false);
		expect(() => second.settleWithoutRetry("old", f.settlement, { ...evidence, reason: "changed" }, 1)).toThrow(
			"different payload",
		);
		expect(snapshot(f.store)).toEqual(before);
	});

	it("replays committed identity after proof removal, but rejects mismatched delivery without writes", () => {
		const f = fixture();
		expect(f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toBe(true);
		rmSync(f.settlement.custody.ref);
		for (const proof of f.settlement.artifacts) rmSync(proof.ref);
		const second = new FactoryStore(f.path);
		stores.push(second);
		const before = snapshot(second);
		expect(second.settleWithoutRetry("old", structuredClone(f.settlement), { ...evidence }, 1)).toBe(false);
		for (const key of [
			"ticketOwner",
			"slotId",
			"host",
			"cwd",
			"sourceFingerprint",
			"processIdentity",
			"uncertainty",
			"wakeId",
		] as const) {
			const changed = { ...f.settlement, [key]: key === "wakeId" ? 999 : "changed" };
			expect(() => second.settleWithoutRetry("old", changed, evidence, 1)).toThrow("different payload");
		}
		const changedProof = { ...f.settlement, custody: { ...f.settlement.custody, sha256: "0".repeat(64) } };
		expect(() => second.settleWithoutRetry("old", changedProof, evidence, 1)).toThrow("different payload");
		const changedArtifact = { ...f.settlement, artifacts: [{ ...f.settlement.artifacts[0], ref: "/changed" }] };
		expect(() => second.settleWithoutRetry("old", changedArtifact, evidence, 1)).toThrow("different payload");
		expect(() => second.settleWithoutRetry("old", f.settlement, { ...evidence, reason: "changed" }, 1)).toThrow(
			"different payload",
		);
		expect(() => second.settleWithoutRetry("other", f.settlement, evidence, 1)).toThrow("action identity");
		expect(() => second.settleWithoutRetry("old", f.settlement, evidence, 2)).toThrow("revision");
		expect(() => second.settleWithoutRetry("old", { ...f.settlement, planRevision: 2 }, evidence, 2)).toThrow(
			"different payload",
		);
		expect(() => second.settleWithoutRetry("old", { ...f.settlement, attemptId: "unknown" }, evidence, 1)).toThrow(
			"Unknown attempt",
		);
		expect(snapshot(second)).toEqual(before);
	});

	it.each(["action", "attempt", "claim"])("refuses committed replay after %s state changes", (field) => {
		const f = fixture();
		f.store.settleWithoutRetry("old", f.settlement, evidence, 1);
		rmSync(f.settlement.custody.ref);
		for (const proof of f.settlement.artifacts) rmSync(proof.ref);
		const db = new DatabaseSync(f.path);
		try {
			if (field === "action") db.exec("UPDATE actions SET state='READY' WHERE id='old'");
			if (field === "attempt") db.prepare("UPDATE attempts SET state='RUNNING' WHERE id=?").run(f.attemptId);
			if (field === "claim") db.prepare("UPDATE attempts SET claim_released=0 WHERE id=?").run(f.attemptId);
			const before = snapshot(f.store);
			expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("Settlement state changed");
			expect(snapshot(f.store)).toEqual(before);
		} finally {
			db.close();
		}
	});

	it.each([false, true])(
		"serializes concurrent settlement delivery with mismatched=%s payload",
		async (mismatched) => {
			const f = fixture();
			const source = pathToFileURL(resolve("src/factory/store.ts")).href;
			const loader = pathToFileURL(resolve("../../node_modules/tsx/dist/loader.mjs")).href;
			const workers = [0, 1].map((index) => {
				const delivery = mismatched && index === 1 ? { ...evidence, reason: "other delivery" } : evidence;
				const call = `store.settleWithoutRetry("old", ${JSON.stringify(f.settlement)}, ${JSON.stringify(delivery)}, 1)`;
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
				const duplicate = results.find((result) => !result.won)!;
				if (mismatched) expect(duplicate.error).toContain("different payload");
				else expect(duplicate.error).toBeUndefined();
				expect(f.store.actions()[0].state).toBe("ABANDONED");
				expect(f.store.actions()[1]).toMatchObject({ state: "QUEUED", dependencies: ["old"] });
				expect(f.store.attempts()).toHaveLength(1);
				expect(f.store.context(f.attemptId).attempt).toMatchObject({
					state: "ABANDONED",
					claimReleased: true,
					receipt: null,
					uncertainty,
				});
				const settled = f.store
					.events(0, 10000)
					.filter((event) => event.kind === "uncertainty_settled_without_retry");
				expect(settled).toHaveLength(1);
				expect(settled[0].detail).toEqual({
					settlement: f.settlement,
					...evidence,
					reason: mismatched && results[1].won ? "other delivery" : evidence.reason,
					outcome: "UNKNOWN",
				});
			} finally {
				for (const worker of workers) worker.child.kill();
				await Promise.allSettled(workers.map((worker) => worker.done));
			}
		},
	);

	it.each([0, 2, NaN, undefined])("refuses stale or absent revision %s atomically", (revision) => {
		const f = fixture();
		const before = snapshot(f.store);
		expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, revision as number)).toThrow("revision");
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each([
		"actionId",
		"attemptId",
		"ticketOwner",
		"slotId",
		"host",
		"cwd",
		"sourceFingerprint",
		"processIdentity",
		"uncertainty",
		"wakeId",
		"planRevision",
	] as const)("refuses wrong %s binding without writes", (key) => {
		const f = fixture();
		const before = snapshot(f.store);
		const changed = { ...f.settlement, [key]: typeof f.settlement[key] === "number" ? 999 : "wrong" };
		rebindProof(f.directory, changed);
		const error =
			key === "actionId"
				? "action identity"
				: key === "attemptId"
					? "Unknown attempt"
					: key === "wakeId"
						? "wake changed"
						: key === "planRevision"
							? "revision"
							: "ownership changed";
		expect(() => f.store.settleWithoutRetry("old", changed, evidence, 1)).toThrow(error);
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each(["PREPARED", "SUBMITTED", "RUNNING", "TERMINAL", "ABANDONED", "unknown-identity", "new-wake"])(
		"refuses %s custody",
		(state) => {
			const f = fixture();
			if (state === "unknown-identity") {
				const db = new DatabaseSync(f.path);
				try {
					db.prepare("UPDATE attempts SET process_identity=NULL WHERE id=?").run(f.attemptId);
				} finally {
					db.close();
				}
			} else if (state === "TERMINAL") {
				f.store.complete({
					attemptId: f.attemptId,
					sourceFingerprint: f.settlement.sourceFingerprint,
					exitCode: 0,
					finishedAt: new Date().toISOString(),
				});
			} else if (state === "ABANDONED") f.store.resolveForRetry(f.attemptId, evidence, 1);
			else if (state === "RUNNING" || state === "new-wake") {
				f.store.markRunning(f.attemptId, f.settlement.processIdentity);
				if (state === "new-wake") f.store.markUncertain(f.attemptId, uncertainty);
			} else {
				const db = new DatabaseSync(f.path);
				try {
					db.prepare("UPDATE attempts SET state=? WHERE id=?").run(state, f.attemptId);
				} finally {
					db.close();
				}
			}
			const before = snapshot(f.store);
			expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow(
				/ownership changed|current uncertain|wake changed/,
			);
			expect(snapshot(f.store)).toEqual(before);
		},
	);

	it.each(["supervisorStopped", "processGroupStopped", "cannotExecute"] as const)("refuses unproven %s", (field) => {
		const f = fixture();
		const before = snapshot(f.store);
		const bad = {
			...f.settlement,
			custody: { ...f.settlement.custody, [field]: false },
		} as unknown as NonRetrySettlement;
		expect(() => f.store.settleWithoutRetry("old", bad, evidence, 1)).toThrow("custody");
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each(["missing", "hash", "identity", "group", "artifacts"])(
		"verifies %s death evidence before releasing custody",
		(scenario) => {
			const f = fixture();
			if (scenario === "missing") rmSync(f.settlement.custody.ref);
			if (scenario === "hash") writeFileSync(f.settlement.custody.ref, "tampered");
			if (scenario === "identity" || scenario === "group") {
				const data = JSON.parse(readFileSync(f.settlement.custody.ref, "utf8"));
				if (scenario === "identity") data.attemptId = "other-attempt";
				else data.processGroupStopped = false;
				f.settlement.custody = { ...f.settlement.custody, ...artifact(f.directory, "death.json", data) };
			}
			if (scenario === "artifacts") f.settlement.artifacts = [];
			const before = snapshot(f.store);
			expect(() => f.engine.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow();
			expect(snapshot(f.store)).toEqual(before);
		},
	);

	it("does not silently consume management authority for the settled action", () => {
		const f = fixture();
		f.store.claimManagement({
			id: "manager",
			actionId: "old",
			attemptId: f.attemptId,
			wakeId: f.settlement.wakeId,
			planRevision: 1,
			evidenceSha256: "0".repeat(64),
		});
		const before = snapshot(f.store);
		expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("management");
		expect(snapshot(f.store)).toEqual(before);
	});

	it.each(["local", "external"])("honors %s pause", (kind) => {
		const f = fixture();
		if (kind === "local") f.engine.pause("owner");
		else writeFileSync(f.pauseFile, "owner");
		const before = snapshot(f.store);
		expect(() => f.engine.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("paused");
		expect(snapshot(f.store)).toEqual(before);
	});

	it("rolls back claim release, action close, wake resolution and event on a late transaction failure", () => {
		const f = fixture();
		const db = new DatabaseSync(f.path);
		try {
			db.exec(
				"CREATE TRIGGER fail_settlement BEFORE INSERT ON events WHEN NEW.kind='uncertainty_settled_without_retry' BEGIN SELECT RAISE(ABORT,'injected event failure'); END",
			);
			const before = snapshot(f.store);
			expect(() => f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toThrow("injected event failure");
			expect(snapshot(f.store)).toEqual(before);
			db.exec("DROP TRIGGER fail_settlement");
			expect(f.store.settleWithoutRetry("old", f.settlement, evidence, 1)).toBe(true);
		} finally {
			db.close();
		}
	});

	it("exposes explicit native CLI settlement with required revision and exact attempt, never tick or retry", async () => {
		const f = fixture();
		const bundle = artifact(f.directory, "settlement.json", f.settlement);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const args = [
			"settle-no-retry",
			f.directory,
			"old",
			"--actor",
			evidence.actor,
			"--reason",
			evidence.reason,
			"--ref",
			bundle.ref,
		];
		await expect(runFactoryCli(args)).rejects.toThrow("--expected-revision");
		await expect(runFactoryCli([...args, "--expected-revision", "1"])).rejects.toThrow("--expected-attempt");
		await expect(runFactoryCli([...args, "--expected-revision", "1", "--expected-attempt", "wrong"])).rejects.toThrow(
			"attempt",
		);
		const command = [...args, "--expected-revision", "1", "--expected-attempt", f.attemptId];
		await runFactoryCli(command);
		await runFactoryCli(command);
		const status = JSON.parse(output.mock.calls.at(-1)![0] as string);
		expect(status.actions[0].state).toBe("ABANDONED");
		expect(status.attempts[0]).toMatchObject({ state: "ABANDONED", receipt: null, uncertainty, claimReleased: true });
		expect(f.store.attempts()).toHaveLength(1);
		expect(f.adapter.launch).not.toHaveBeenCalled();
	});
});
