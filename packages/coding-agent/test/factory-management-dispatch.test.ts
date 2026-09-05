import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FactoryEngine } from "../src/factory/engine.js";
import type { ManagementEvidenceBinding, ManagementPacket } from "../src/factory/management.js";
import {
	type ManagementCallerFactory,
	manageFactoryWake,
	watchFactoryManagement,
} from "../src/factory/management-dispatch.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryAdapter, FactoryPlan } from "../src/factory/types.js";

const directories: string[] = [];
const stores: FactoryStore[] = [];
const evidence = [{ ref: "review:exact-head", content: "The exact output passed independent review." }];
const adapter: FactoryAdapter = {
	async launch(context) {
		return {
			kind: "terminal",
			receipt: {
				attemptId: context.attempt.id,
				sourceFingerprint: context.action.sourceFingerprint,
				exitCode: 0,
				finishedAt: "2026-09-05T10:00:00Z",
			},
		};
	},
	async inspect() {
		return { kind: "uncertain", reason: "No custody evidence" };
	},
};
async function fixture(count = 1) {
	const directory = mkdtempSync(join(tmpdir(), "factory-management-dispatch-"));
	directories.push(directory);
	const path = join(directory, "factory.db");
	const store = new FactoryStore(path);
	stores.push(store);
	const pauseFile = join(directory, "OWNER-PAUSE");
	const engine = new FactoryEngine(store, adapter, { enabled: true, pauseFile });
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "owner" }],
		slots: [{ id: "slot", host: "local" }],
		actions: Array.from({ length: count }, (_, i) => ({
			id: `a${i}`,
			ticketId: "ticket",
			kind: "decision",
			dependencies: [],
			sourceFingerprint: `source-${i}`,
			acceptanceCriteria: ["Review passed for exact output"],
			command: { argv: ["fixture"], cwd: directory },
			requirements: {},
		})),
		roles: { ticketOwner: { provider: "fixture", model: "mock", effort: "low" } },
	};
	engine.applyPlan(plan);
	await engine.tick();
	return { directory, path, store, engine, pauseFile, plan };
}
function bind(
	f: Awaited<ReturnType<typeof fixture>>,
	index = 0,
	content = evidence[0].content,
): ManagementEvidenceBinding {
	const wake = f.store.wakes().filter((item) => item.resolvedAt === null)[index];
	if (!wake?.attemptId) throw new Error("No fixture wake");
	const binding: ManagementEvidenceBinding = {
		version: 1,
		wakeId: wake.id,
		actionId: wake.actionId,
		attemptId: wake.attemptId,
		planRevision: f.store.status().planRevision,
		evidence: [{ ref: evidence[0].ref, content, sha256: createHash("sha256").update(content).digest("hex") }],
	};
	mkdirSync(join(f.directory, "management-evidence"), { recursive: true });
	writeFileSync(join(f.directory, "management-evidence", `${wake.id}.json`), JSON.stringify(binding));
	return binding;
}
function caller(decision: "accept" | "defer" | "reject" = "defer", during?: () => void | Promise<void>) {
	const invoke = vi.fn(async (packetText: string) => {
		await during?.();
		const packet = JSON.parse(packetText) as ManagementPacket;
		return {
			model: "mock",
			text: JSON.stringify({
				version: 1,
				actionId: packet.action.id,
				attemptId: packet.attempt?.id ?? null,
				planRevision: packet.planRevision,
				decision,
				reason: "Reviewed supplied proof",
				evidenceRefs: decision === "defer" ? [] : [packet.evidence[0].ref],
			}),
		};
	});
	const create: ManagementCallerFactory = (checkCurrent) => async (_system, packet) => {
		checkCurrent();
		return invoke(packet);
	};
	return { create, invoke };
}
afterEach(() => {
	vi.useRealTimers();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bounded factory judgment consumer", () => {
	test("consumes defer durably, including after reopening, and requires changed evidence for another call", async () => {
		const f = await fixture();
		bind(f);
		const model = caller();
		const options = { directory: f.directory, automatic: true, apply: true };
		expect((await manageFactoryWake(f.engine, options, model.create)).kind).toBe("deferred");
		const reopened = new FactoryStore(f.path);
		stores.push(reopened);
		const recovery = new FactoryEngine(reopened, adapter);
		expect((await manageFactoryWake(recovery, options, model.create)).kind).toBe("consumed");
		expect(model.invoke).toHaveBeenCalledTimes(1);
		expect(f.store.wakes()[0].resolvedAt).toBeNull();
		bind(f, 0, "New independent exact-output evidence.");
		expect((await manageFactoryWake(recovery, options, model.create)).admitted).toBe(true);
		expect(model.invoke).toHaveBeenCalledTimes(2);
	});

	test("never calls a model for empty, paused, missing/stale evidence or uncertain automatic wakes", async () => {
		const empty = await fixture(0);
		const f = await fixture();
		const model = caller();
		expect(
			(await manageFactoryWake(empty.engine, { directory: empty.directory, automatic: true }, model.create)).kind,
		).toBe("idle");
		expect((await manageFactoryWake(f.engine, { directory: f.directory, automatic: true }, model.create)).kind).toBe(
			"idle",
		);
		bind(f);
		f.engine.pause("owner");
		expect((await manageFactoryWake(f.engine, { directory: f.directory, evidence }, model.create)).kind).toBe(
			"paused",
		);
		f.engine.resume();
		writeFileSync(f.pauseFile, "owner pause");
		expect((await manageFactoryWake(f.engine, { directory: f.directory, automatic: true }, model.create)).kind).toBe(
			"paused",
		);
		expect(readFileSync(f.pauseFile, "utf8")).toBe("owner pause");
		rmSync(f.pauseFile);
		f.engine.applyPlan({ version: 1, tickets: [{ id: "ticket", owner: "new-owner" }], actions: [], slots: [] });
		expect((await manageFactoryWake(f.engine, { directory: f.directory, automatic: true }, model.create)).kind).toBe(
			"idle",
		);
		const uncertain = await fixture(0);
		uncertain.engine.applyPlan(f.plan);
		const context = uncertain.store.claim("a0", "slot")!;
		uncertain.store.markSubmitted(context.attempt.id);
		uncertain.store.markUncertain(context.attempt.id, "Unreachable host");
		bind(uncertain);
		expect(
			(
				await manageFactoryWake(
					uncertain.engine,
					{ directory: uncertain.directory, automatic: true, apply: true },
					model.create,
				)
			).kind,
		).toBe("idle");
		expect(uncertain.store.attempts(true)).toHaveLength(1);
		expect(model.invoke).not.toHaveBeenCalled();
	});

	test("validates per-wake content hashes and never reuses evidence for another wake", async () => {
		const f = await fixture(2);
		const binding = bind(f);
		const model = caller("accept");
		const options = { directory: f.directory, automatic: true, apply: true };
		writeFileSync(
			join(f.directory, "management-evidence", `${binding.wakeId}.json`),
			JSON.stringify({ ...binding, evidence: [{ ...binding.evidence[0], content: "changed" }] }),
		);
		await expect(manageFactoryWake(f.engine, options, model.create)).rejects.toThrow("hash mismatch");
		expect(model.invoke).not.toHaveBeenCalled();
		bind(f);
		expect((await manageFactoryWake(f.engine, options, model.create)).kind).toBe("applied");
		expect((await manageFactoryWake(f.engine, options, model.create)).kind).toBe("idle");
		expect(f.store.actions().map((action) => action.state)).toEqual(["ACCEPTED", "AWAITING_DECISION"]);
		expect(model.invoke).toHaveBeenCalledTimes(1);
	});

	test("applies a cached proposal with plan/attempt/wake CAS and no duplicate inference", async () => {
		const f = await fixture();
		const model = caller("accept");
		const options = { directory: f.directory, evidence };
		const proposed = await manageFactoryWake(f.engine, options, model.create);
		expect(proposed.kind).toBe("proposed");
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
		const applied = await manageFactoryWake(f.engine, { ...options, apply: true }, model.create);
		expect(applied.kind).toBe("applied");
		expect(applied.admitted).toBe(false);
		expect(applied.requestId).toBe(proposed.requestId);
		expect(model.invoke).toHaveBeenCalledTimes(1);
		expect(f.store.managementRequests()[0].state).toBe("APPLIED");
		const request = JSON.parse(readFileSync(join(proposed.evidenceDirectory!, "request.json"), "utf8"));
		expect(request.evidenceHashes[0].sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	test.each(["local", "external"])(
		"rechecks %s pause immediately before inference and before applying",
		async (pauseKind) => {
			const f = await fixture();
			const pause = () => (pauseKind === "local" ? f.engine.pause("owner") : writeFileSync(f.pauseFile, "owner"));
			const sent = vi.fn();
			const create: ManagementCallerFactory = (checkCurrent) => async () => {
				await Promise.resolve();
				pause();
				checkCurrent();
				sent();
				throw new Error("not reached");
			};
			const first = await manageFactoryWake(f.engine, { directory: f.directory, evidence, apply: true }, create);
			expect(first.kind).toBe("error");
			expect(first.admitted).toBe(true);
			expect(sent).not.toHaveBeenCalled();
			if (pauseKind === "external") rmSync(f.pauseFile);
			else f.engine.resume();
			const model = caller("accept", pause);
			const options = {
				directory: f.directory,
				evidence: [{ ...evidence[0], content: "New evidence" }],
				apply: true,
			};
			expect((await manageFactoryWake(f.engine, options, model.create)).kind).toBe("error");
			expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
			if (pauseKind === "external") rmSync(f.pauseFile);
			else f.engine.resume();
			expect((await manageFactoryWake(f.engine, options, model.create)).kind).toBe("applied");
			expect(model.invoke).toHaveBeenCalledTimes(1);
		},
	);

	test("serializes plan changes against inference and cannot claim an older revision, attempt or resolved wake", async () => {
		const f = await fixture();
		bind(f);
		const changed: FactoryPlan = {
			version: 1,
			tickets: [{ id: "ticket", owner: "new-owner" }],
			slots: [],
			actions: [],
		};
		const model = caller("defer", () => {
			expect(() => f.engine.applyPlan(changed, 1)).toThrow("unconsumed management");
		});
		const result = await manageFactoryWake(
			f.engine,
			{ directory: f.directory, automatic: true, apply: true },
			model.create,
		);
		expect(result.kind).toBe("deferred");
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
		const claim = f.store.managementRequests()[0];
		expect(f.engine.applyPlan(changed, 1)).toBe(2);
		expect(() => f.store.claimManagement({ ...claim, id: "stale-revision" })).toThrow("revision changed");
		expect(() =>
			f.store.claimManagement({ ...claim, id: "stale-attempt", planRevision: 2, attemptId: "old-attempt" }),
		).toThrow("wake changed");
		f.engine.decide(
			"a0",
			"accept",
			{ actor: "owner", ref: "review", reason: "Reviewed proof" },
			2,
			claim.attemptId,
			claim.wakeId,
		);
		expect(() => f.store.claimManagement({ ...claim, id: "resolved", planRevision: 2 })).toThrow("wake changed");
	});

	test("deduplicates concurrent automatic and manual management across store connections, even with changed evidence", async () => {
		const f = await fixture();
		bind(f);
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = caller("defer", () => pending);
		const first = manageFactoryWake(f.engine, { directory: f.directory, automatic: true }, slow.create);
		const secondStore = new FactoryStore(f.path);
		stores.push(secondStore);
		const second = new FactoryEngine(secondStore, adapter);
		const other = caller("accept");
		try {
			expect(
				(await manageFactoryWake(second, { directory: f.directory, evidence, apply: true }, other.create)).kind,
			).toBe("consumed");
			expect(
				(
					await manageFactoryWake(
						second,
						{ directory: f.directory, evidence: [{ ...evidence[0], content: "different" }], apply: true },
						other.create,
					)
				).kind,
			).toBe("consumed");
			expect(other.invoke).not.toHaveBeenCalled();
		} finally {
			release();
		}
		expect((await first).kind).toBe("deferred");
		expect(f.store.managementRequests()).toHaveLength(1);
	});

	test("bounds total watch admissions including errors and defer, rather than successful responses", async () => {
		const f = await fixture(3);
		bind(f, 0);
		bind(f, 1);
		bind(f, 2);
		let calls = 0;
		const deferred = caller();
		const create: ManagementCallerFactory =
			(checkCurrent) =>
			async (...parameters) => {
				checkCurrent();
				calls++;
				if (calls === 1) throw new Error("provider failed");
				return deferred.create(checkCurrent)(...parameters);
			};
		vi.useFakeTimers();
		const results: string[] = [];
		const watching = watchFactoryManagement(
			f.engine,
			{ directory: f.directory, maxRequests: 2, maxPasses: 10, intervalMs: 50 },
			create,
			(result) => results.push(result.kind),
		);
		await vi.runAllTimersAsync();
		expect(await watching).toEqual({ admitted: 2, passes: 2 });
		expect(results).toEqual(["error", "deferred"]);
		expect(calls).toBe(2);
		expect(f.store.wakes().every((wake) => wake.resolvedAt === null)).toBe(true);
		const again = await manageFactoryWake(f.engine, { directory: f.directory, actionId: "a0", evidence }, create);
		expect(again.kind).toBe("consumed");
	});

	test("finite empty watch stops at its pass budget without invoking the model factory", async () => {
		const f = await fixture(0);
		const create = vi.fn<ManagementCallerFactory>();
		vi.useFakeTimers();
		const watching = watchFactoryManagement(
			f.engine,
			{ directory: f.directory, maxRequests: 2, maxPasses: 3, intervalMs: 50 },
			create,
			() => {},
		);
		await vi.runAllTimersAsync();
		expect(await watching).toEqual({ admitted: 0, passes: 3 });
		expect(create).not.toHaveBeenCalled();
	});

	test("a manager process that exits after request admission leaves a consumed crash claim, even for changed evidence", async () => {
		const f = await fixture();
		bind(f);
		const storeUrl = pathToFileURL(resolve("src/factory/store.ts")).href;
		const engineUrl = pathToFileURL(resolve("src/factory/engine.ts")).href;
		const dispatcherUrl = pathToFileURL(resolve("src/factory/management-dispatch.ts")).href;
		const code = `import { FactoryStore } from ${JSON.stringify(storeUrl)};
import { FactoryEngine } from ${JSON.stringify(engineUrl)};
import { manageFactoryWake } from ${JSON.stringify(dispatcherUrl)};
const store = new FactoryStore(${JSON.stringify(f.path)});
const adapter = { launch: async () => { throw Error("not allowed"); }, inspect: async () => { throw Error("not allowed"); } };
void manageFactoryWake(new FactoryEngine(store, adapter), { directory: ${JSON.stringify(f.directory)}, automatic: true }, (check) => async () => { check(); process.stdout.write("admitted\\n"); return new Promise(() => {}); });`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let errors = "";
		child.stdout.on("data", (data) => {
			output += String(data);
		});
		child.stderr.on("data", (data) => {
			errors += String(data);
		});
		const codeResult = await new Promise<number | null>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolveExit(code));
		});
		expect(codeResult, errors).toBe(0);
		expect(output).toBe("admitted\n");
		expect(f.store.managementRequests()[0].state).toBe("CLAIMED");
		const reopened = new FactoryStore(f.path);
		stores.push(reopened);
		const recovery = new FactoryEngine(reopened, adapter);
		const model = caller("accept");
		expect(
			(await manageFactoryWake(recovery, { directory: f.directory, automatic: true, apply: true }, model.create))
				.kind,
		).toBe("consumed");
		bind(f, 0, "Changed evidence does not establish provider request custody.");
		expect(
			(await manageFactoryWake(recovery, { directory: f.directory, automatic: true, apply: true }, model.create))
				.kind,
		).toBe("consumed");
		expect(model.invoke).not.toHaveBeenCalled();
		expect(f.store.managementRequests()).toHaveLength(1);
	});

	test("does not apply a model response after its bound evidence changes during inference", async () => {
		const f = await fixture();
		bind(f);
		const model = caller("accept", () => {
			bind(f, 0, "New contradictory evidence");
		});
		const result = await manageFactoryWake(
			f.engine,
			{ directory: f.directory, automatic: true, apply: true },
			model.create,
		);
		expect(result.kind).toBe("error");
		expect(result.error).toContain("evidence binding changed");
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	});

	test("does not apply an older cached evidence context after newer management began", async () => {
		const f = await fixture();
		const old = caller("accept");
		const original = { directory: f.directory, evidence };
		await manageFactoryWake(f.engine, original, old.create);
		const newer = caller("defer");
		await manageFactoryWake(
			f.engine,
			{ ...original, evidence: [{ ...evidence[0], content: "New finding requires more proof" }] },
			newer.create,
		);
		expect((await manageFactoryWake(f.engine, { ...original, apply: true }, old.create)).kind).toBe("consumed");
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
		expect(old.invoke).toHaveBeenCalledTimes(1);
	});

	test("model latency cannot block a separate scheduling tick and a stop blocks application", async () => {
		const f = await fixture();
		let release!: () => void;
		const pending = new Promise<void>((resolveReady) => {
			release = resolveReady;
		});
		const model = caller("accept", () => pending);
		const controller = new AbortController();
		const watching = watchFactoryManagement(
			f.engine,
			{
				directory: f.directory,
				maxRequests: 1,
				maxPasses: 1,
				intervalMs: 50,
				apply: true,
				signal: controller.signal,
			},
			model.create,
			() => {},
		);
		// No binding: the pass does no work, independent of ready scheduling.
		expect(await watching).toEqual({ admitted: 0, passes: 1 });
		f.engine.applyPlan({
			version: 1,
			tickets: [],
			slots: [],
			actions: [{ ...f.plan.actions[0], id: "independent", kind: "process" }],
		});
		bind(f);
		const result = manageFactoryWake(
			f.engine,
			{ directory: f.directory, automatic: true, apply: true, stopped: () => controller.signal.aborted },
			model.create,
		);
		try {
			expect((await f.engine.tick()).launched).toHaveLength(1);
			controller.abort();
		} finally {
			release();
		}
		expect((await result).kind).toBe("error");
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	});
});
