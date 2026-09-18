import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeDecisionBase, type DecisionReceipt, recordDecision } from "../src/factory/decisions.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FactoryStore } from "../src/factory/store.js";
import type {
	ActionSpec,
	AttemptContext,
	CompletionReceipt,
	FactoryAdapter,
	FactoryPlan,
	Inspection,
} from "../src/factory/types.js";
import { fixtureRuntimePin } from "./factory-runtime-fixture.js";

const directories: string[] = [];
const stores: FactoryStore[] = [];
function fixture(): { directory: string; path: string; store: FactoryStore } {
	const directory = mkdtempSync(join(tmpdir(), "factory-core-"));
	directories.push(directory);
	const path = join(directory, "factory.sqlite");
	const store = new FactoryStore(path);
	stores.push(store);
	return { directory, path, store };
}
function action(id = "a", kind: ActionSpec["kind"] = "process", dependencies: string[] = []): ActionSpec {
	return {
		id,
		ticketId: id,
		dependencies,
		kind,
		sourceFingerprint: `source-${id}`,
		command: { argv: ["true"], cwd: "/tmp" },
		requirements: { runtime: fixtureRuntimePin },
	};
}
function plan(actions: ActionSpec[] = [action()]): FactoryPlan {
	return {
		version: 1,
		tickets: actions.map((a) => ({ id: a.ticketId, owner: "manager-role" })),
		slots: [{ id: "slot", host: "host", capabilities: ["linux"] }],
		actions,
	};
}
function receipt(context: AttemptContext, exitCode: number | null = 0): CompletionReceipt {
	return {
		attemptId: context.attempt.id,
		sourceFingerprint: context.action.sourceFingerprint,
		exitCode,
		finishedAt: "2026-09-05T10:00:00.000Z",
		artifact: { ref: "file:///changed-output", sourceFingerprint: "changed-output-source" },
	};
}
class FakeAdapter implements FactoryAdapter {
	launches: AttemptContext[] = [];
	launchResult: (context: AttemptContext) => Inspection = (context) => ({
		kind: "terminal",
		receipt: receipt(context),
	});
	inspectResult: (context: AttemptContext) => Inspection = () => ({ kind: "uncertain", reason: "Host unreachable" });
	async launch(context: AttemptContext): Promise<Inspection> {
		this.launches.push(context);
		return this.launchResult(context);
	}
	async inspect(context: AttemptContext): Promise<Inspection> {
		return this.inspectResult(context);
	}
}
const evidence = { actor: "owner", reason: "Reviewed exact artifact and required checks", ref: "file:///review.json" };
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("portable factory journal", () => {
	it("does not launch without explicit enablement and preserves role configuration", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		const engine = new FactoryEngine(store, adapter);
		engine.applyPlan({
			...plan(),
			roles: { manager: { provider: "example", model: "configured-model", effort: "low" } },
		});
		await engine.tick();
		expect(adapter.launches).toHaveLength(0);
		expect(store.attempts()).toHaveLength(0);
		expect(engine.status().roles?.manager.model).toBe("configured-model");
	});
	it("separates successful execution and output identity from semantic acceptance, then readies dependents before retirement", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a", "decision"), action("b", "process", ["a"])]));
		await engine.tick();
		expect(adapter.launches).toHaveLength(1);
		expect(store.actions().map((a) => a.state)).toEqual(["AWAITING_DECISION", "QUEUED"]);
		expect(store.tickets()[0].state).toBe("ACTIVE");
		expect(store.attempts()[0].receipt?.artifact?.sourceFingerprint).toBe("changed-output-source");
		engine.decide("a", "accept", evidence, 1);
		const events = store.allEvents();
		const ready = events.find((e) => e.actionId === "b" && e.kind === "action_ready_changed");
		const retired = events.find((e) => e.detail.ticketId === "a" && e.detail.state === "RETIRED");
		expect(ready?.sequence).toBeLessThan(retired?.sequence ?? 0);
		await engine.tick();
		expect(store.actions().map((a) => a.state)).toEqual(["ACCEPTED", "ACCEPTED"]);
	});
	it("requires nonempty evidence and rejects stale decisions", async () => {
		const { store } = fixture();
		const engine = new FactoryEngine(store, new FakeAdapter(), { enabled: true });
		engine.applyPlan(plan([action("a", "decision")]));
		await engine.tick();
		expect(() => engine.decide("a", "accept", { ...evidence, ref: "" })).toThrow("evidence.ref");
		expect(() => engine.decide("a", "accept", evidence, 0)).toThrow("revision changed");
		engine.decide("a", "reject", evidence, 1);
		expect(store.actions()[0].state).toBe("REJECTED");
	});
	it("rejects a stale decision for an earlier attempt even when the plan revision is unchanged", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = () => ({ kind: "uncertain", reason: "Lost submission result" });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a", "decision")]));
		await engine.tick();
		const old = store.attempts()[0];
		engine.resolveForRetry(old.id, evidence, 1);
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c) });
		await engine.tick();
		const current = store.attempts().at(-1);
		expect(current?.id).not.toBe(old.id);
		expect(() => engine.decide("a", "accept", evidence, 1, old.id)).toThrow("Decision attempt changed");
		expect(store.actions()[0].state).toBe("AWAITING_DECISION");
		engine.decide("a", "accept", evidence, 1, current?.id);
		expect(store.actions()[0].state).toBe("ACCEPTED");
	});
	it("records failed process gates without accepting them", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c, 1) });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan());
		await engine.tick();
		expect(store.actions()[0].state).toBe("REJECTED");
		expect(store.wakes().filter((w) => !w.resolvedAt)).toHaveLength(1);
	});
	it("supersedes failed gates with evidence, readies repaired dependents and eventually retires the ticket", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c, c.action.id === "a" ? 1 : 0) });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a"), action("b", "process", ["a"])]));
		await engine.tick();
		const replacement = action("repair");
		replacement.ticketId = "a";
		engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] });
		expect(engine.supersede("a", "repair", evidence, 2)).toBe(3);
		expect(store.actions().find((a) => a.id === "b")?.dependencies).toEqual(["repair"]);
		await engine.tick();
		expect(store.tickets().every((t) => t.state === "RETIRED")).toBe(true);
		expect(store.attempts()[0].receipt?.exitCode).toBe(1);
		expect(store.actions()[0].state).toBe("SUPERSEDED");
		expect(store.wakes().filter((w) => !w.resolvedAt)).toHaveLength(0);
	});
	it("rejects sparse new or stale plans referencing superseded work while retaining valid replacement dependencies", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c, 1) });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a"), action("b", "process", ["a"])]));
		await engine.tick();
		const replacement = { ...action("repair"), ticketId: "a" };
		engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] });
		engine.supersede("a", "repair", evidence, 2);
		const later = { ...action("later", "process", ["a"]), ticketId: "a" };
		expect(() => engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [later] }, 3)).toThrow(
			"Dependency a is superseded",
		);
		expect(() =>
			engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [action("b", "process", ["a"])] }, 3),
		).toThrow("Dependency a is superseded");
		expect(store.status().planRevision).toBe(3);
		expect(store.actions().find((a) => a.id === "later")).toBeUndefined();
		expect(store.actions().find((a) => a.id === "b")?.dependencies).toEqual(["repair"]);
		later.dependencies = ["repair"];
		expect(engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [later] }, 3)).toBe(4);
		expect(store.actions().find((a) => a.id === "later")?.dependencies).toEqual(["repair"]);
	});
	it("rejects cyclic or cross-ticket replacement without changing records", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c, 1) });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan());
		await engine.tick();
		const cyclic = action("repair", "process", ["a"]);
		cyclic.ticketId = "a";
		engine.applyPlan({
			version: 1,
			tickets: [{ id: "foreign", owner: "owner" }],
			slots: [],
			actions: [cyclic, { ...action("foreign"), ticketId: "foreign" }],
		});
		expect(() => engine.supersede("a", "repair", evidence)).toThrow("cycle");
		expect(() => engine.supersede("a", "foreign", evidence)).toThrow("same ticket and kind");
		expect(store.actions()[0].state).toBe("REJECTED");
		expect(store.status().planRevision).toBe(2);
	});
	it("replays identical terminal receipts idempotently and rejects conflicting evidence", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan());
		await engine.tick();
		const terminal = receipt(adapter.launches[0]);
		const count = store.allEvents().length;
		expect(store.complete(terminal)).toBe(false);
		expect(store.allEvents()).toHaveLength(count);
		expect(() => store.complete({ ...terminal, exitCode: 1 })).toThrow("Conflicting terminal");
	});
	it("preserves contradictory terminal evidence from concurrent controllers and pauses downstream dispatch", async () => {
		const { store, path } = fixture();
		store.applyPlan(plan([action("a"), action("b", "process", ["a"])]));
		const context = store.claim("a", "slot");
		if (!context) throw new Error("Missing claim");
		store.markSubmitted(context.attempt.id);
		const second = new FactoryStore(path);
		stores.push(second);
		const adapter = new FakeAdapter();
		adapter.inspectResult = (c) => {
			second.complete(receipt(c));
			return { kind: "terminal", receipt: receipt(c, 1) };
		};
		await new FactoryEngine(store, adapter, { enabled: true }).tick();
		expect(store.isPaused()).toBe(true);
		expect(adapter.launches).toHaveLength(0);
		expect(store.eventsOfKind("terminal_receipt_conflict").length > 0).toBe(true);
		expect(store.wakes().some((w) => !w.resolvedAt && w.reason === "Conflicting terminal receipt")).toBe(true);
	});
	it("retains ambiguous submission claims across restart until evidence authorizes retry", async () => {
		const { store, path } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = () => {
			throw new Error("SSH disconnected after submission");
		};
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a"), action("b")]));
		await engine.tick();
		const first = store.attempts()[0];
		expect(first.state).toBe("UNCERTAIN");
		expect(first.claimReleased).toBe(false);
		const reopened = new FactoryStore(path);
		stores.push(reopened);
		const recovery = new FactoryEngine(reopened, adapter, { enabled: true });
		await recovery.tick();
		expect(adapter.launches).toHaveLength(1);
		expect(reopened.attempts(true)).toHaveLength(1);
		expect(reopened.claim("b", "slot")).toBeUndefined();
		expect(reopened.wakes().filter((w) => !w.resolvedAt)).toHaveLength(1);
		recovery.resolveForRetry(
			first.id,
			{ ...evidence, reason: "Host receipt and process-group evidence prove the old invocation cannot run" },
			1,
		);
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c) });
		await recovery.tick();
		expect(adapter.launches[1].attempt.id).not.toBe(first.id);
		expect(reopened.actions().every((a) => a.state === "ACCEPTED")).toBe(true);
	});
	it("can replace a durable prepared intent which was never submitted", async () => {
		const { store } = fixture();
		store.applyPlan(plan());
		const pending = store.claim("a", "slot");
		expect(pending).toBeDefined();
		const adapter = new FakeAdapter();
		await new FactoryEngine(store, adapter, { enabled: true }).tick();
		expect(store.attempts()[0].state).toBe("ABANDONED");
		expect(adapter.launches).toHaveLength(1);
		expect(store.markSubmitted(pending?.attempt.id ?? "")).toBe(false);
	});
	it("reattaches to a live process and reconciles a receipt after restart without relaunch", async () => {
		const { store } = fixture();
		store.applyPlan(plan());
		const context = store.claim("a", "slot");
		expect(context).toBeDefined();
		store.markSubmitted(context?.attempt.id ?? "");
		const adapter = new FakeAdapter();
		adapter.inspectResult = () => ({ kind: "running", processIdentity: "boot-id:pid:start-time" });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		await engine.tick();
		expect(store.attempts()[0].state).toBe("RUNNING");
		adapter.inspectResult = (c) => ({ kind: "terminal", receipt: receipt(c) });
		await engine.tick();
		expect(adapter.launches).toHaveLength(0);
		expect(store.actions()[0].state).toBe("ACCEPTED");
	});
	it("keeps process identity changes uncertain", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = () => ({ kind: "running", processIdentity: "old" });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan());
		await engine.tick();
		adapter.inspectResult = () => ({ kind: "running", processIdentity: "reused-pid" });
		await engine.tick();
		expect(store.attempts()[0].state).toBe("UNCERTAIN");
		expect(store.attempts()[0].claimReleased).toBe(false);
	});
	it("blocks launches and decisions during pause but still collects terminal receipts", async () => {
		const { directory, store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = () => ({ kind: "running", processIdentity: "pid:start" });
		const pauseFile = join(directory, "OWNER-PAUSE.json");
		const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile });
		engine.applyPlan(plan([action("a", "decision"), action("b")]));
		await engine.tick();
		engine.pause("Owner review");
		adapter.inspectResult = (c) => ({ kind: "terminal", receipt: receipt(c) });
		await engine.tick();
		expect(adapter.launches).toHaveLength(1);
		expect(store.actions()[0].state).toBe("AWAITING_DECISION");
		expect(() => engine.decide("a", "accept", evidence)).toThrow("paused");
		expect(() => engine.applyPlan(plan())).toThrow("paused");
		engine.resume();
		writeFileSync(pauseFile, "{}");
		expect(() => engine.resume()).toThrow("External owner pause");
		await engine.tick();
		expect(adapter.launches).toHaveLength(1);
		expect(engine.status().paused).toBe(true);
		rmSync(pauseFile);
		engine.decide("a", "accept", evidence);
		await engine.tick();
		expect(adapter.launches).toHaveLength(2);
	});
	it("only updates future work, keeps input identity immutable, and validates the dependency graph atomically", () => {
		const { store } = fixture();
		const initial = plan([action("a"), action("b", "process", ["a"])]);
		store.applyPlan(initial);
		const revised = structuredClone(initial);
		revised.actions[1].command.argv = ["updated-command"];
		expect(store.applyPlan(revised, 1)).toBe(2);
		expect(() => store.applyPlan(initial, 1)).toThrow("revision changed");
		const changedSource = structuredClone(revised);
		changedSource.actions[1].sourceFingerprint = "different";
		expect(() => store.applyPlan(changedSource)).toThrow("immutable");
		const cycle = structuredClone(revised);
		cycle.actions[0].dependencies = ["b"];
		expect(() => store.applyPlan(cycle)).toThrow("cycle");
		const context = store.claim("a", "slot");
		store.markSubmitted(context?.attempt.id ?? "");
		const changedRunning = structuredClone(revised);
		changedRunning.actions[0].command.argv = ["different"];
		expect(() => store.applyPlan(changedRunning)).toThrow("Started action is immutable");
		expect(store.status().planRevision).toBe(2);
	});
	it("does not let a receipt for another attempt resolve the inspected claim", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: { ...receipt(c), attemptId: "foreign-attempt" } });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan());
		await engine.tick();
		expect(store.attempts()[0].state).toBe("UNCERTAIN");
		expect(store.attempts()[0].claimReleased).toBe(false);
	});
	it("honors host, slot and capability requirements", () => {
		const { store } = fixture();
		const work = action();
		work.requirements = { runtime: fixtureRuntimePin, host: "other-host", capabilities: ["macos"] };
		store.applyPlan(plan([work]));
		expect(store.claim("a", "slot")).toBeUndefined();
		work.requirements = { runtime: fixtureRuntimePin, host: "host", slotId: "slot", capabilities: ["linux"] };
		store.applyPlan(plan([work]));
		expect(store.claim("a", "slot")).toBeDefined();
	});
	it("requires absolute cwd and releases a normalized worktree only after terminal evidence", () => {
		const { store } = fixture();
		const first = action("a");
		const second = action("b");
		first.command.cwd = "relative/path";
		expect(() => store.applyPlan(plan([first]))).toThrow("must be absolute");
		first.command.cwd = "/tmp/intermediate/../shared/";
		second.command.cwd = "/tmp/shared";
		store.applyPlan({
			...plan([first, second]),
			slots: [
				{ id: "s1", host: "host" },
				{ id: "s2", host: "host" },
			],
		});
		expect(store.actions()[0].command.cwd).toBe("/tmp/shared");
		const context = store.claim("a", "s1");
		if (!context) throw new Error("Missing claim");
		store.markSubmitted(context.attempt.id);
		store.markUncertain(context.attempt.id, "Host unreachable");
		expect(store.claim("b", "s2")).toBeUndefined();
		store.complete(receipt(context));
		expect(store.claim("b", "s2")).toBeDefined();
	});
	it.each(["same slot", "same action", "same worktree", "different hosts", "different directories"])(
		"coordinates competing processes for %s",
		async (scenario) => {
			const { path, store } = fixture();
			const first = action("a");
			const second = action("b");
			first.command.cwd = "/tmp/worktree-a";
			second.command.cwd =
				scenario === "same slot" || scenario === "different directories"
					? "/tmp/worktree-b"
					: "/tmp/old/../worktree-a/";
			const secondHost = scenario === "different hosts" || scenario === "same action" ? "other-host" : "host";
			store.applyPlan({
				...plan([first, second]),
				slots: [
					{ id: "slot", host: "host" },
					{ id: "slot2", host: secondHost },
				],
			});
			const requests = [
				{ id: "a", slotId: "slot" },
				{ id: scenario === "same action" ? "a" : "b", slotId: scenario === "same slot" ? "slot" : "slot2" },
			];
			const expectedClaims = scenario === "different hosts" || scenario === "different directories" ? 2 : 1;
			const source = pathToFileURL(resolve("src/factory/store.ts")).href;
			const loader = pathToFileURL(resolve("../../node_modules/tsx/dist/loader.mjs")).href;
			const pending = requests.map(({ id, slotId }) => {
				const code = `import { FactoryStore } from ${JSON.stringify(source)}; const store = new FactoryStore(${JSON.stringify(path)}); process.stdout.write('ready\\n'); process.stdin.once('data', () => { const claimed = store.claim(${JSON.stringify(id)}, ${JSON.stringify(slotId)}); process.stdout.write(JSON.stringify(Boolean(claimed))+'\\n'); store.close(); process.stdin.destroy(); });`;
				const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "-e", code], {
					stdio: ["pipe", "pipe", "pipe"],
				});
				let output = "";
				let stderr = "";
				const ready = new Promise<void>((resolveReady, reject) => {
					child.stdout.on("data", (data) => {
						output += String(data);
						if (output.includes("ready\n")) resolveReady();
					});
					child.once("error", reject);
					child.once("exit", (exit) => {
						if (!output.includes("ready\n")) reject(new Error(`Claim worker exited ${exit}: ${stderr}`));
					});
				});
				child.stderr.on("data", (data) => {
					stderr += String(data);
				});
				const done = new Promise<boolean>((resolveDone, reject) => {
					child.once("error", reject);
					child.once("exit", (exit) => {
						if (exit !== 0) reject(new Error(stderr));
						else resolveDone(output.trim().split("\n").at(-1) === "true");
					});
				});
				return { child, ready, done };
			});
			await Promise.all(pending.map((p) => p.ready));
			for (const worker of pending) worker.child.stdin.write("go\n");
			const claims = await Promise.all(pending.map((p) => p.done));
			expect(claims.filter(Boolean)).toHaveLength(expectedClaims);
			expect(store.attempts(true)).toHaveLength(expectedClaims);
		},
	);
});

it("pages full decision history without loss, duplication or changing the bounded events API", () => {
	const { store } = fixture();
	store.applyPlan(plan());
	const before = store.ledgerSequence();
	for (let index = 0; index < 205; index++)
		recordDecision(store, "a", {
			...codeDecisionBase(store.ledgerSequence(), `Observation ${index}`),
			type: "executability",
			named_dependency: "none",
			independent_work_available: true,
			authority_covers: true,
			hold_scope: null,
		});
	expect(store.events()).toHaveLength(100);
	const full = store.allEvents();
	expect(full).toHaveLength(before + 205);
	expect(new Set(full.map((event) => event.sequence)).size).toBe(full.length);
	expect(full.map((event) => event.sequence)).toEqual(Array.from({ length: full.length }, (_, index) => index + 1));
	expect(store.allEvents(before)).toEqual(full.slice(before));
	expect(store.eventsOfKind("decision", before)).toHaveLength(205);
	expect(() => store.allEvents(-1)).toThrow("Invalid event range");
});

it("pages only the requested event kind through its entry snapshot", () => {
	const { store } = fixture();
	store.applyPlan(plan());
	store.recordResumed({ old: true });
	const after = store.ledgerSequence();
	for (let index = 0; index < 205; index++) {
		store.pause("unrelated");
		store.recordResumed({ index });
	}
	const expected = store.events(after, 1000).filter((event) => event.kind === "resumed");
	const all = vi.spyOn(store, "allEvents");
	const sequence = store.ledgerSequence.bind(store);
	vi.spyOn(store, "ledgerSequence").mockImplementationOnce(() => {
		const through = sequence();
		store.recordResumed({ afterSnapshot: true });
		return through;
	});
	const actual = store.eventsOfKind("resumed", after);
	expect(actual).toEqual(expected);
	expect(actual).toHaveLength(205);
	expect(new Set(actual.map((event) => event.sequence)).size).toBe(205);
	expect(all).not.toHaveBeenCalled();
	expect(store.eventsOfKind("absent")).toEqual([]);
	expect(store.eventsOfKind("resumed", store.ledgerSequence())).toEqual([]);
	expect(() => store.eventsOfKind("resumed", -1)).toThrow("Invalid event range");
});

it("treats a false receipt file with an applied ledger decision as promotion missing, never as a replay", () => {
	const { directory, path, store } = fixture();
	store.applyPlan(plan());
	const apply = vi.fn();
	vi.spyOn(store, "afterDecisionCommit").mockImplementationOnce(() => {});
	const receipt = recordDecision(
		store,
		"a",
		{
			...codeDecisionBase(store.ledgerSequence(), "Audit authority"),
			type: "executability",
			named_dependency: "none",
			independent_work_available: true,
			authority_covers: true,
			hold_scope: null,
		},
		{ requestId: "promotion-missing", apply },
	);
	const file = join(directory, "decisions", receipt.request_id, "decision.json");
	const before = store.allEvents();
	const reopened = new FactoryStore(path);
	stores.push(reopened);
	const disk = JSON.parse(readFileSync(file, "utf8")) as DecisionReceipt;
	const event = reopened.eventsOfKind("decision").find((e) => e.detail.request_id === receipt.request_id)!;
	expect(disk.applied).toBe(false);
	expect(event.detail.applied).toBe(true);
	expect(reopened.typedDecisions()).toEqual([{ ...disk, applied: event.detail.applied }]);
	expect(reopened.typedDecisions()[0].applied).toBe(true);
	expect(reopened.allEvents()).toEqual(before);
	// A lagging file is promotion missing, not permission to apply the decision again.
	expect(reopened.typedDecisions()[0].applied).not.toBe(disk.applied);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(disk);
	expect(apply).toHaveBeenCalledTimes(1);
});
