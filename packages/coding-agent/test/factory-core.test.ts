import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function action(id = "a", dependencies: string[] = []): ActionSpec {
	return {
		id,
		ticketId: id,
		dependencies,
		sourceFingerprint: `source-${id}`,
		command: { argv: ["true"], cwd: "/tmp" },
		requirements: {},
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
	it("accepts a successful process, readies its dependents before retirement and keeps the output identity", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a"), action("b", ["a"])]));
		await engine.tick();
		// One tick drains the frontier: accepting a readies b, which launches in the same tick.
		expect(adapter.launches.map((c) => c.action.id)).toEqual(["a", "b"]);
		expect(store.attempts()[0].receipt?.artifact?.sourceFingerprint).toBe("changed-output-source");
		const events = store.allEvents();
		const ready = events.find((e) => e.actionId === "b" && e.kind === "action_ready_changed");
		const retired = events.find((e) => e.detail.ticketId === "a" && e.detail.state === "RETIRED");
		expect(ready?.sequence).toBeLessThan(retired?.sequence ?? 0);
		expect(store.actions().map((a) => a.state)).toEqual(["ACCEPTED", "ACCEPTED"]);
		expect(store.tickets().every((t) => t.state === "RETIRED")).toBe(true);
	});
	it("admits one selected action while paused, commits its claim before launch and never relaunches a replay", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = () => ({ kind: "running", processIdentity: "pid:1" });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a"), action("b")]));
		engine.pause("sequential shipping");
		const empty: FactoryPlan = { version: 1, tickets: [], slots: [], actions: [] };
		const options = { select: "b", expectedRevision: 1, mutationId: "admit-b", evidence };
		const admitted = await engine.recoverAdmit(empty, options);
		expect(admitted).toMatchObject({ actionId: "b", replayed: false, attemptState: "RUNNING", paused: true });
		expect(await engine.recoverAdmit(empty, options)).toMatchObject({
			attemptId: admitted.attemptId,
			replayed: true,
		});
		expect(adapter.launches.map((c) => c.action.id)).toEqual(["b"]);
		await expect(engine.recoverAdmit(empty, { ...options, select: "a" })).rejects.toThrow("Mutation identity reused");
		await expect(engine.recoverAdmit(empty, { ...options, select: "a", mutationId: "admit-a" })).rejects.toThrow(
			"a live, uncertain, or unreleased claim remains",
		);
		expect(store.isPaused()).toBe(true);
		// After a resume the replay still answers with its first receipt and launches nothing.
		engine.resume();
		expect(await engine.recoverAdmit(empty, options)).toMatchObject({
			attemptId: admitted.attemptId,
			replayed: true,
		});
		expect(adapter.launches).toHaveLength(1);
		await expect(engine.recoverAdmit(empty, { ...options, mutationId: "admit-b-2" })).rejects.toThrow(
			"requires the durable factory pause",
		);
	});
	it("records failed processes without accepting them", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c, 1) });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan());
		await engine.tick();
		expect(store.actions()[0].state).toBe("REJECTED");
		expect(store.wakes().filter((w) => !w.resolvedAt)).toHaveLength(1);
	});
	it("supersedes failed work with evidence, readies repaired dependents and eventually retires the ticket", async () => {
		const { store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = (c) => ({ kind: "terminal", receipt: receipt(c, c.action.id === "a" ? 1 : 0) });
		const engine = new FactoryEngine(store, adapter, { enabled: true });
		engine.applyPlan(plan([action("a"), action("b", ["a"])]));
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
		engine.applyPlan(plan([action("a"), action("b", ["a"])]));
		await engine.tick();
		const replacement = { ...action("repair"), ticketId: "a" };
		engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [replacement] });
		engine.supersede("a", "repair", evidence, 2);
		const later = { ...action("later", ["a"]), ticketId: "a" };
		expect(() => engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [later] }, 3)).toThrow(
			"Dependency a is superseded",
		);
		expect(() => engine.applyPlan({ version: 1, tickets: [], slots: [], actions: [action("b", ["a"])] }, 3)).toThrow(
			"Dependency a is superseded",
		);
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
		const cyclic = action("repair", ["a"]);
		cyclic.ticketId = "a";
		engine.applyPlan({
			version: 1,
			tickets: [{ id: "foreign", owner: "owner" }],
			slots: [],
			actions: [cyclic, { ...action("foreign"), ticketId: "foreign" }],
		});
		expect(() => engine.supersede("a", "repair", evidence)).toThrow("cycle");
		expect(() => engine.supersede("a", "foreign", evidence)).toThrow("same ticket");
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
		store.applyPlan(plan([action("a"), action("b", ["a"])]));
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
		expect(store.allEvents().some((e) => e.kind === "terminal_receipt_conflict")).toBe(true);
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
	it("blocks launches and plan changes during pause but still collects terminal receipts", async () => {
		const { directory, store } = fixture();
		const adapter = new FakeAdapter();
		adapter.launchResult = () => ({ kind: "running", processIdentity: "pid:start" });
		const pauseFile = join(directory, "OWNER-PAUSE.json");
		const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile });
		engine.applyPlan(plan([action("a"), action("b", ["a"])]));
		await engine.tick();
		engine.pause("Owner review");
		adapter.inspectResult = (c) => ({ kind: "terminal", receipt: receipt(c) });
		await engine.tick();
		expect(adapter.launches).toHaveLength(1);
		expect(store.actions().map((a) => a.state)).toEqual(["ACCEPTED", "READY"]);
		expect(() => engine.applyPlan(plan())).toThrow("paused");
		engine.resume();
		writeFileSync(pauseFile, "{}");
		expect(() => engine.resume()).toThrow("External owner pause");
		await engine.tick();
		expect(adapter.launches).toHaveLength(1);
		expect(engine.status().paused).toBe(true);
		rmSync(pauseFile);
		await engine.tick();
		expect(adapter.launches).toHaveLength(2);
	});
	it("only updates future work, keeps input identity immutable, and validates the dependency graph atomically", () => {
		const { store } = fixture();
		const initial = plan([action("a"), action("b", ["a"])]);
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
		work.requirements = { host: "other-host", capabilities: ["macos"] };
		store.applyPlan(plan([work]));
		expect(store.claim("a", "slot")).toBeUndefined();
		work.requirements = { host: "host", slotId: "slot", capabilities: ["linux"] };
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
