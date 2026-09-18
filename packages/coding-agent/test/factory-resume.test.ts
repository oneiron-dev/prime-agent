import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runFactoryCli } from "../src/factory/cli.js";
import { codeDecisionBase, recordDecision } from "../src/factory/decisions.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { resumeCatchUp, resumeFactory, resumeFrontier } from "../src/factory/resume.js";
import { FactoryStore } from "../src/factory/store.js";
import type { ActionSpec, AttemptContext, Inspection } from "../src/factory/types.js";
import { admitRuntimeFixture, createRuntimeFixture } from "./factory-runtime-fixture.js";

const roots: string[] = [],
	stores: FactoryStore[] = [];
function fixture(ids: string[] = []) {
	const directory = mkdtempSync(join(tmpdir(), "factory-resume-"));
	roots.push(directory);
	const pin = createRuntimeFixture(directory);
	admitRuntimeFixture(pin);
	const store = new FactoryStore(join(directory, "factory.db"));
	stores.push(store);
	const actions: ActionSpec[] = ids.map((id) => ({
		id,
		ticketId: id === "rejected" ? "other" : "ticket",
		dependencies: id === "queued" ? ["rejected"] : [],
		kind: id === "decision" ? "decision" : "process",
		sourceFingerprint: id,
		command: { argv: ["true"], cwd: join(directory, id) },
		requirements: {},
	}));
	store.applyPlan(
		{
			version: 1,
			tickets: [
				{ id: "ticket", owner: "owner" },
				{ id: "other", owner: "owner" },
			],
			slots: [0, 1, 2].map((i) => ({ id: `s${i}`, host: "local" })),
			actions,
		},
		0,
		undefined,
		pin,
	);
	const pauseFile = join(directory, "OWNER-PAUSE");
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({
			version: 1,
			pauseFile,
			hosts: { local: { type: "local", runnerRoot: join(directory, "attempts") } },
		}),
	);
	const launch = vi.fn(
		async (c: AttemptContext): Promise<Inspection> => ({ kind: "running", processIdentity: c.attempt.id }),
	);
	const inspect = vi.fn(
		async (c: AttemptContext): Promise<Inspection> =>
			c.attempt.state === "UNCERTAIN"
				? { kind: "uncertain", reason: "lost" }
				: { kind: "running", processIdentity: c.attempt.id },
	);
	const engine = new FactoryEngine(store, { launch, inspect }, { enabled: true, pauseFile });
	vi.spyOn(console, "log").mockImplementation(() => {});
	return { directory, store, engine, pin, pauseFile, launch };
}
function finish(store: FactoryStore, id: string, exitCode = 0) {
	const claim = store.claim(id, "s0")!;
	store.markSubmitted(claim.attempt.id);
	store.complete({
		attemptId: claim.attempt.id,
		sourceFingerprint: id,
		exitCode,
		finishedAt: new Date().toISOString(),
	});
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

it("refuses owner pause before runtime checking, unpausing or writing receipts", async () => {
	const f = fixture(["ready"]);
	f.engine.pause("owner");
	writeFileSync(f.pauseFile, "hold");
	writeFileSync(f.pin.path, "changed");
	const sequence = f.store.ledgerSequence();
	await expect(runFactoryCli(["resume", f.directory, "--accept-runtime-change", "approved"])).rejects.toThrow(
		"External owner pause",
	);
	expect(f.store.ledgerSequence()).toBe(sequence);
	expect(f.store.isPaused()).toBe(true);
	expect(existsSync(f.pauseFile)).toBe(true);
	expect(f.launch).not.toHaveBeenCalled();
	expect(readdirSync(f.directory).filter((n) => n.startsWith("resume-"))).toEqual([]);
});

it("refuses runtime mismatch, then accepts the flag with a reason and preserves the old pin", async () => {
	const f = fixture();
	f.engine.pause("restart");
	writeFileSync(f.pin.path, "{}");
	await expect(runFactoryCli(["resume", f.directory])).rejects.toThrow("Runtime mismatch");
	await expect(runFactoryCli(["resume", f.directory, "--accept-runtime-change", " "])).rejects.toThrow("nonempty");
	expect(f.store.isPaused()).toBe(true);
	await runFactoryCli(["resume", f.directory, "--accept-runtime-change", "owner approved release"]);
	expect(f.store.runtimePin()).not.toEqual(f.pin);
	expect(readFileSync(f.pin.path, "utf8")).toBe("{}");
	expect(f.store.allEvents().find((e) => e.kind === "runtime_changed")?.detail).toMatchObject({
		previous: f.pin,
		reason: "owner approved release",
	});
	await expect(runFactoryCli(["tick", f.directory, "--accept-runtime-change", "wrong verb"])).rejects.toThrow(
		"only supported for resume",
	);
});

it("groups the full catch-up after the last resumed event, including typed drift/deferred requests", () => {
	const { store } = fixture(["old", "accepted", "rejected", "uncertain", "decision"]);
	finish(store, "old");
	store.recordResumed({ fixture: true });
	const after = store.ledgerSequence();
	for (let i = 0; i < 105; i++) store.pause("history padding");
	store.resume();
	finish(store, "accepted");
	finish(store, "rejected", 1);
	finish(store, "decision");
	const wake = store.wakes().find((w) => w.actionId === "decision")!;
	for (const mode of ["PROPOSED", "DRIFT", "DEFERRED"]) {
		store.claimManagement({
			id: mode,
			wakeId: wake.id,
			actionId: "decision",
			attemptId: wake.attemptId!,
			planRevision: 1,
			evidenceSha256: mode,
		});
		recordDecision(
			store,
			"decision",
			{
				...codeDecisionBase(store.ledgerSequence(), mode),
				served_profile: mode === "DRIFT" ? "other" : "code",
				type: "executability",
				named_dependency: "none",
				independent_work_available: true,
				authority_covers: true,
				hold_scope: null,
			},
			{
				requestId: mode,
				inference: {
					outcome: mode === "DEFERRED" ? "DEFERRED" : "YES",
					question_set: { version: "v8", sha256: "a".repeat(64) },
				},
			},
		);
	}
	const attempt = store.claim("uncertain", "s0")!.attempt;
	store.markSubmitted(attempt.id);
	store.markUncertain(attempt.id, "lost");
	const report = resumeCatchUp(store);
	expect(report.afterSequence).toBe(after);
	expect(report.throughSequence).toBeGreaterThan(after + 100);
	const ticket = report.tickets[0];
	expect(ticket.accepted.map((e) => e.actionId)).toEqual(["accepted"]);
	expect(ticket.uncertain.map((e) => e.actionId)).toEqual(["uncertain"]);
	expect(report.tickets[1].rejected.map((e) => e.actionId)).toEqual(["rejected"]);
	expect(ticket.openWakes.map((w) => w.reason).join(" ")).toMatch(/profile_drift.*typed_decision_deferred.*lost/);
	expect(ticket.managementRequests.map((r) => r.state)).toEqual(["RECORDED", "PROPOSED", "DRIFT", "DEFERRED"]);
});

it("derives each frontier category, abandons only PREPARED and never re-admits UNCERTAIN", async () => {
	const f = fixture(["accepted", "rejected", "decision", "uncertain", "prepared", "running", "ready", "queued"]);
	finish(f.store, "accepted");
	finish(f.store, "rejected", 1);
	finish(f.store, "decision");
	const uncertain = f.store.claim("uncertain", "s0")!.attempt.id;
	f.store.markSubmitted(uncertain);
	f.store.markUncertain(uncertain, "lost");
	const prepared = f.store.claim("prepared", "s1")!.attempt.id;
	const running = f.store.claim("running", "s2")!.attempt.id;
	f.store.markSubmitted(running);
	f.store.markRunning(running, running);
	const frontier = resumeFrontier(f.store);
	expect(frontier.READY.map((a) => a.id)).toEqual(["ready"]);
	expect(frontier.QUEUED.map((a) => a.id)).toEqual(["queued"]);
	expect(frontier.PREPARED.map((a) => a.id)).toEqual([prepared]);
	expect(frontier.operatorWork.map((a) => a.id)).toEqual([uncertain]);
	f.engine.pause("restart");
	await resumeFactory(f.engine);
	expect(f.store.context(prepared).attempt.state).toBe("ABANDONED");
	expect(f.launch.mock.calls.map(([c]) => c.action.id)).toEqual(["prepared"]);
	expect(f.store.context(uncertain).attempt).toMatchObject({ state: "UNCERTAIN", claimReleased: false });
	expect(f.store.attempts().filter((a) => a.actionId === "uncertain")).toHaveLength(1);
});

it("exits nonzero on idle_with_backlog and records counts, wake, resumed event and hashed files", () => {
	const f = fixture(["ready"]);
	f.store.applyPlan({
		version: 1,
		tickets: [],
		slots: [],
		actions: [{ ...f.store.actions()[0], requirements: { host: "absent" } }],
	});
	f.store.pause("restart");
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			resolve("../../node_modules/tsx/dist/loader.mjs"),
			resolve("src/factory/cli-entry.ts"),
			"resume",
			f.directory,
		],
		{ encoding: "utf8" },
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("idle_with_backlog");
	expect(JSON.parse(result.stderr).error).toContain('"READY":1');
	expect(result.stdout).toContain("TICKET\tACCEPTED\tREJECTED");
	const events = f.store.allEvents();
	expect(events.at(-2)?.kind).toBe("idle_with_backlog");
	expect(events.at(-1)?.kind).toBe("resumed");
	expect(f.store.wakes().some((w) => !w.resolvedAt && w.reason.includes("idle_with_backlog"))).toBe(true);
	const report = JSON.parse(
		readFileSync(join(f.directory, readdirSync(f.directory).find((n) => n.startsWith("resume-"))!), "utf8"),
	);
	expect(report.counts).toMatchObject({ READY: 1, RUNNING: 0 });
	expect(report.catch_up_sha).toBe(createHash("sha256").update(readFileSync(report.catchUpPath)).digest("hex"));
	expect(events.at(-1)?.detail).toEqual({
		counts: report.counts,
		runtime_pin: f.pin,
		catch_up_sha: report.catch_up_sha,
		accounting: report.accounting,
	});
	expect(report.accounting).toMatchObject({ calls: 0, cost_usd: 0, priced: true });
	expect(events.at(-1)?.detail).not.toHaveProperty("usage");
});

it("rehydrates cursor requests and their projections without calls, replay or state changes", async () => {
	const f = fixture();
	const db = new DatabaseSync(join(f.directory, "factory.db"));
	db.exec(
		"CREATE TABLE oneiron_continuation_cursor(id TEXT,action_id TEXT); CREATE TABLE oneiron_continuation_requests(id TEXT,cursor_id TEXT,action_id TEXT,state TEXT,packet TEXT,context TEXT,response TEXT); CREATE TABLE oneiron_continuation_supervision(receipt TEXT)",
	);
	for (const state of ["DISPATCHED", "RESPONDED", "WAITING"]) {
		db.prepare("INSERT INTO oneiron_continuation_cursor VALUES(?,?)").run(state, "action");
		db.prepare("INSERT INTO oneiron_continuation_requests VALUES(?,?,?,?,?,?,?)").run(
			state,
			state,
			"action",
			state,
			JSON.stringify({ runnerRoot: f.directory, runtime: f.pin }),
			JSON.stringify({ action: { command: { cwd: f.directory } } }),
			state === "DISPATCHED" ? null : JSON.stringify({ next: { kind: "wait" } }),
		);
	}
	const before = db.prepare("SELECT * FROM oneiron_continuation_requests").all();
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	const report = await resumeFactory(f.engine);
	expect(report.continuation.requests).toHaveLength(3);
	for (const state of ["DISPATCHED", "RESPONDED", "WAITING"])
		expect(existsSync(join(f.directory, "continuation", state, state, "packet.json"))).toBe(true);
	expect(existsSync(join(f.directory, "continuation", "RESPONDED", "RESPONDED", "response.json"))).toBe(true);
	expect(db.prepare("SELECT * FROM oneiron_continuation_requests").all()).toEqual(before);
	expect(f.launch).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
	db.close();
});
