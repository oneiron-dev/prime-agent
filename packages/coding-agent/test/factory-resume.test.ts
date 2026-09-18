import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runFactoryCli } from "../src/factory/cli.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { resumeCatchUp, resumeFactory, resumeFrontier } from "../src/factory/resume.js";
import { type FactoryFilePin, hashFactoryRuntimeFile } from "../src/factory/runtime.js";
import { FactoryStore } from "../src/factory/store.js";
import type { ActionSpec, AttemptContext, Inspection } from "../src/factory/types.js";

const roots: string[] = [],
	stores: FactoryStore[] = [];
function fixture(ids: string[] = []) {
	const directory = mkdtempSync(join(tmpdir(), "factory-resume-"));
	roots.push(directory);
	const component = join(directory, "component.js");
	writeFileSync(component, "// installed component\n");
	const pinPath = join(directory, "runtime.json");
	writeFileSync(
		pinPath,
		JSON.stringify({
			version: 1,
			cliArgv: [process.execPath, component],
			files: [{ path: component, sha256: hashFactoryRuntimeFile(component) }],
		}),
	);
	const pin: FactoryFilePin = { path: pinPath, sha256: hashFactoryRuntimeFile(pinPath) };
	const store = new FactoryStore(join(directory, "factory.db"));
	stores.push(store);
	const actions: ActionSpec[] = ids.map((id) => ({
		id,
		ticketId: id === "rejected" ? "other" : "ticket",
		dependencies: id === "queued" ? ["rejected"] : [],
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
	return { directory, store, engine, pin, component, pauseFile, launch, inspect };
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
function ofKind(store: FactoryStore, kind: string) {
	return store.allEvents().filter((e) => e.kind === kind);
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

it("refuses owner pause before unpausing or writing receipts", async () => {
	const f = fixture(["ready"]);
	f.engine.pause("owner");
	writeFileSync(f.pauseFile, "hold");
	const sequence = f.store.ledgerSequence();
	await expect(runFactoryCli(["resume", f.directory])).rejects.toThrow("External owner pause");
	expect(f.store.ledgerSequence()).toBe(sequence);
	expect(f.store.isPaused()).toBe(true);
	expect(existsSync(f.pauseFile)).toBe(true);
	expect(f.launch).not.toHaveBeenCalled();
	expect(readdirSync(f.directory).filter((n) => n.startsWith("resume-"))).toEqual([]);
});

it("journals a changed installed runtime and continues instead of refusing", async () => {
	const f = fixture();
	f.engine.pause("restart");
	writeFileSync(f.component, "// rebuilt component\n");
	await runFactoryCli(["resume", f.directory]);
	expect(f.store.isPaused()).toBe(false);
	expect(f.store.runtimePin()).not.toEqual(f.pin);
	expect(ofKind(f.store, "runtime_changed")[0]?.detail).toMatchObject({
		previous: f.pin,
		reason: `runtime file changed: ${f.component}`,
	});
	await runFactoryCli(["resume", f.directory]);
	expect(ofKind(f.store, "runtime_changed")).toHaveLength(1);
});

it("groups the full catch-up after the last resumed event", () => {
	const { store } = fixture(["old", "accepted", "rejected", "uncertain"]);
	finish(store, "old");
	store.recordResumed({ fixture: true });
	const after = store.ledgerSequence();
	for (let i = 0; i < 105; i++) store.pause("history padding");
	store.resume();
	finish(store, "accepted");
	finish(store, "rejected", 1);
	const attempt = store.claim("uncertain", "s0")!.attempt;
	store.markSubmitted(attempt.id);
	store.markUncertain(attempt.id, "lost");
	const report = resumeCatchUp(store);
	expect(report.afterSequence).toBe(after);
	expect(report.throughSequence).toBeGreaterThan(after + 100);
	const ticket = report.tickets[0];
	expect(ticket.accepted.map((e) => e.actionId)).toEqual(["accepted"]);
	expect(ticket.uncertain.map((e) => e.actionId)).toEqual(["uncertain"]);
	expect(ticket.openWakes.map((w) => w.reason)).toEqual(["lost"]);
	expect(report.tickets[1].rejected.map((e) => e.actionId)).toEqual(["rejected"]);
	expect(report.tickets[1].openWakes.map((w) => w.reason)).toEqual(["Process failed"]);
});

it("derives each frontier category, abandons only PREPARED and never re-admits UNCERTAIN", async () => {
	const f = fixture(["accepted", "rejected", "uncertain", "prepared", "running", "ready", "queued"]);
	finish(f.store, "accepted");
	finish(f.store, "rejected", 1);
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
	await resumeFactory(f.engine, f.directory);
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
		catch_up_through: report.catch_up_through,
	});
});

it("reports an acceptance settled by the previous resume tick in the next catch-up", async () => {
	const f = fixture(["accepted"]);
	const attempt = f.store.claim("accepted", "s0")!.attempt;
	f.store.markSubmitted(attempt.id);
	f.inspect.mockImplementation(
		async (c): Promise<Inspection> => ({
			kind: "terminal",
			receipt: {
				attemptId: c.attempt.id,
				sourceFingerprint: c.action.sourceFingerprint,
				exitCode: 0,
				finishedAt: new Date().toISOString(),
			},
		}),
	);
	const first = await resumeFactory(f.engine, f.directory);
	expect(f.store.actions()[0].state).toBe("ACCEPTED");
	expect(JSON.parse(readFileSync(first.catchUpPath, "utf8")).tickets[0].accepted).toEqual([]);
	const terminal = ofKind(f.store, "attempt_terminal")[0];
	expect(terminal.sequence).toBeGreaterThan(first.catch_up_through);
	const resumed = ofKind(f.store, "resumed")[0];
	expect(resumed.sequence).toBeGreaterThan(terminal.sequence);
	expect(f.store.lastResumeSequence()).toBe(first.catch_up_through);
	const second = await resumeFactory(f.engine, f.directory);
	const catchUp = JSON.parse(readFileSync(second.catchUpPath, "utf8"));
	expect(catchUp.afterSequence).toBe(first.catch_up_through);
	expect(catchUp.tickets[0].accepted).toEqual([terminal]);
	const third = await resumeFactory(f.engine, f.directory);
	expect(JSON.parse(readFileSync(third.catchUpPath, "utf8")).tickets[0].accepted).toEqual([]);
	expect(f.launch).not.toHaveBeenCalled();
});

it("deduplicates idle wakes across repeated resumes and uses timestamp-only receipt filenames", async () => {
	const f = fixture(["ready"]);
	f.store.applyPlan({
		version: 1,
		tickets: [],
		slots: [],
		actions: [{ ...f.store.actions()[0], requirements: { host: "absent" } }],
	});
	vi.spyOn(Date, "now").mockReturnValue(Date.now());
	for (let i = 0; i < 3; i++) await expect(resumeFactory(f.engine, f.directory)).rejects.toThrow("idle_with_backlog");
	expect(f.store.wakes().filter((w) => w.resolvedAt === null)).toHaveLength(1);
	expect(ofKind(f.store, "idle_with_backlog")).toHaveLength(3);
	expect(ofKind(f.store, "resumed")).toHaveLength(3);
	const receipts = readdirSync(f.directory).filter((n) => n.startsWith("resume-"));
	expect(receipts).toHaveLength(3);
	for (const filename of receipts)
		expect(filename).toMatch(/^resume-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
});

it("final report failure reports the committed unpause and scheduling", async () => {
	const f = fixture(["ready"]);
	f.engine.pause("restart");
	f.launch.mockImplementation(async (context) => {
		const path = join(f.directory, readdirSync(f.directory).find((name) => name.startsWith("resume-"))!);
		expect(JSON.parse(readFileSync(path, "utf8"))).toBeNull();
		rmSync(path);
		mkdirSync(path);
		return { kind: "running", processIdentity: context.attempt.id };
	});
	await expect(resumeFactory(f.engine, f.directory)).rejects.toThrow(
		"Factory is unpaused and scheduled; only the report file failed:",
	);
	expect(f.store.isPaused()).toBe(false);
	expect(f.store.actions()[0].state).toBe("RUNNING");
	expect(ofKind(f.store, "resumed")).toHaveLength(1);
});
