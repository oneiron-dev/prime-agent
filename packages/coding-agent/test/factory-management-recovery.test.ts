import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FactoryEngine } from "../src/factory/engine.js";
import type { ManagementPacket, ManagementReconciliation, ManagementRequest } from "../src/factory/management.js";
import { type ManagementCallerFactory, manageFactoryWake } from "../src/factory/management-dispatch.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryAdapter, FactoryPlan } from "../src/factory/types.js";

const directories: string[] = [];
const stores: FactoryStore[] = [];
const adapter: FactoryAdapter = {
	async launch(context) {
		return {
			kind: "terminal",
			receipt: {
				attemptId: context.attempt.id,
				sourceFingerprint: context.action.sourceFingerprint,
				exitCode: context.action.id === "bad" ? 1 : 0,
				finishedAt: "2026-09-05T00:00:00Z",
			},
		};
	},
	async inspect() {
		throw new Error("No process inspections expected");
	},
};
const evidence = [{ ref: "review", content: "Exact-head independent review passed." }];
const attestation = {
	actor: "fixture-operator",
	reason: "Reconciled supervisor, request and output receipts",
	ref: "fixture:reconciliation",
};
async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "factory-recovery-"));
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
		actions: ["a", "b", "bad", "repair"].map((id) => ({
			id,
			ticketId: "ticket",
			dependencies: [],
			kind: id === "bad" || id === "repair" ? "process" : "decision",
			acceptanceCriteria: ["Exact review passed"],
			sourceFingerprint: id,
			command: { argv: ["fixture"], cwd: directory },
			requirements: {},
		})),
		roles: { ticketOwner: { provider: "mock", model: "mock" } },
	};
	engine.applyPlan(plan, 0);
	await engine.tick();
	return { directory, path, store, engine, plan, pauseFile };
}
const changedPlan: FactoryPlan = {
	version: 1,
	tickets: [{ id: "ticket", owner: "coordinator" }],
	slots: [],
	actions: [],
};
function model(decision: "accept" | "defer", pending?: Promise<void>): ManagementCallerFactory {
	return (checkCurrent) => async (_system, serialized) => {
		checkCurrent();
		await pending;
		const packet = JSON.parse(serialized) as ManagementPacket;
		return {
			model: "mock",
			text: JSON.stringify({
				version: 1,
				actionId: packet.action.id,
				attemptId: packet.attempt?.id,
				planRevision: packet.planRevision,
				decision,
				reason: "Reviewed proof",
				evidenceRefs: decision === "defer" ? [] : [packet.evidence[0].ref],
			}),
		};
	};
}
function proof(directory: string, name: string, contents: unknown) {
	const ref = join(directory, name);
	const bytes = JSON.stringify(contents);
	writeFileSync(ref, bytes);
	return { ref, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function reconcileProof(directory: string, request: ManagementRequest, noSubmission = false): ManagementReconciliation {
	const actor = proof(directory, "actor.json", {
		version: 1,
		requestId: request.id,
		actorIdentity: "fixture:boot:pid:start",
		stopped: true,
		authorityRevoked: true,
	});
	const disposition = noSubmission ? "not-submitted" : "completed";
	const provider = proof(directory, "provider.json", { version: 1, requestId: request.id, disposition });
	return {
		version: 1,
		requestId: request.id,
		wakeId: request.wakeId,
		attemptId: request.attemptId,
		planRevision: request.planRevision,
		priorActor: { identity: "fixture:boot:pid:start", stopped: true, authorityRevoked: true, ...actor },
		providerRequest: { disposition, ...provider },
		artifacts: noSubmission ? [] : [proof(directory, "preserved-request.json", request)],
	};
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("serializes actual global mutations against CLAIMED and latest unresolved PROPOSED judgments", async () => {
	const f = await fixture();
	let release!: () => void;
	const pending = new Promise<void>((resolveReady) => {
		release = resolveReady;
	});
	const first = manageFactoryWake(
		f.engine,
		{ directory: f.directory, actionId: "a", evidence },
		model("accept", pending),
	);
	const otherStore = new FactoryStore(f.path);
	stores.push(otherStore);
	const other = new FactoryEngine(otherStore, adapter, { enabled: true });
	try {
		expect(() => other.applyPlan(changedPlan, 1)).toThrow("unconsumed management");
		expect(() => other.supersede("bad", "repair", attestation, 1)).toThrow("unconsumed management");
		expect(other.applyPlan(f.plan, 1)).toBe(1);
		expect((await other.tick()).launched).toEqual([]);
	} finally {
		release();
	}
	expect((await first).kind).toBe("proposed");
	expect(() => other.applyPlan(changedPlan, 1)).toThrow("unconsumed management");
	expect(otherStore.managementMutationBlockers()).toHaveLength(1);
	expect(
		(
			await manageFactoryWake(
				other,
				{ directory: f.directory, actionId: "a", evidence, apply: true },
				model("accept"),
			)
		).kind,
	).toBe("applied");
	expect(other.applyPlan(changedPlan, 1, "next-stage")).toBe(2);
	const event = f.store
		.events(0, 100)
		.find((item) => item.kind === "plan_applied" && item.detail.mutationId === "next-stage")!;
	expect(event.detail.previousRevision).toBe(1);
	expect(event.detail.invalidatedWakeIds).toEqual(
		f.store
			.wakes()
			.filter((wake) => !wake.resolvedAt)
			.map((wake) => wake.id),
	);
});

test("records exactly-once import receipts and no-op imports do not bump revisions", async () => {
	const f = await fixture();
	expect(f.engine.applyPlan(f.plan, 1)).toBe(1);
	expect(f.engine.applyPlan(changedPlan, 1, "outbox-1")).toBe(2);
	const reopened = new FactoryStore(f.path);
	stores.push(reopened);
	expect(reopened.applyPlan(changedPlan, 1, "outbox-1")).toBe(2);
	expect(reopened.status().planRevision).toBe(2);
	expect(reopened.planMutation("outbox-1")).toMatchObject({ id: "outbox-1", previousRevision: 1, revision: 2 });
	expect(() => reopened.applyPlan(changedPlan, 2, "outbox-1")).toThrow("different payload");
	expect(() => reopened.applyPlan(f.plan, 1, "outbox-1")).toThrow("different payload");
	expect(() => reopened.applyPlan(changedPlan, undefined, "no-cas")).toThrow("explicit expected");
	f.engine.pause("owner");
	expect(reopened.planMutation("outbox-1")?.revision).toBe(2);
	expect(() => f.engine.applyPlan(changedPlan, 1, "outbox-1")).toThrow("paused");
});

test("reconciles an interrupted actor without deleting or replaying its context; late response cannot apply", async () => {
	const f = await fixture();
	let release!: () => void;
	const pending = new Promise<void>((resolveReady) => {
		release = resolveReady;
	});
	const first = manageFactoryWake(
		f.engine,
		{ directory: f.directory, actionId: "a", evidence, apply: true },
		model("accept", pending),
	);
	const claimed = f.store.managementRequests()[0];
	const reconciliation = reconcileProof(f.directory, claimed);
	f.engine.reconcileManagement(claimed.id, reconciliation, attestation, 1);
	try {
		expect(f.store.managementRequests()[0]).toMatchObject({ ...claimed, state: "RECONCILED" });
		expect(
			(await manageFactoryWake(f.engine, { directory: f.directory, actionId: "a", evidence }, model("accept"))).kind,
		).toBe("consumed");
		expect(() => f.store.assertManagementCurrent(claimed)).toThrow("authority");
	} finally {
		release();
	}
	expect((await first).kind).toBe("error");
	expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	expect(f.store.managementRequests()[0].state).toBe("RECONCILED");
	expect(f.engine.applyPlan(changedPlan, 1)).toBe(2);
	expect(
		(await manageFactoryWake(f.engine, { directory: f.directory, actionId: "a", evidence }, model("accept"))).kind,
	).toBe("consumed");
	expect(readFileSync(join(f.directory, "decisions", claimed.id, "response.json"), "utf8")).toContain("mock");
	expect(
		(
			await manageFactoryWake(
				f.engine,
				{
					directory: f.directory,
					actionId: "a",
					evidence: [{ ref: "new", content: "Reconciled prior request and new proof" }],
					apply: true,
				},
				model("accept"),
			)
		).kind,
	).toBe("applied");
	expect(f.store.managementRequests()).toHaveLength(2);
});

test("requires verified exact recovery receipts and honors local/external pause", async () => {
	const f = await fixture();
	await manageFactoryWake(f.engine, { directory: f.directory, actionId: "a", evidence }, model("accept"));
	const request = f.store.managementRequests()[0];
	const reconciliation = reconcileProof(f.directory, request);
	expect(() =>
		f.engine.reconcileManagement(
			request.id,
			{
				...reconciliation,
				providerRequest: { ...reconciliation.providerRequest, disposition: "unknown" },
			} as unknown as ManagementReconciliation,
			attestation,
			1,
		),
	).toThrow("UNKNOWN");
	expect(() =>
		f.engine.reconcileManagement(
			request.id,
			{ ...reconciliation, priorActor: { ...reconciliation.priorActor, sha256: "0".repeat(64) } },
			attestation,
			1,
		),
	).toThrow("hash mismatch");
	expect(() =>
		f.engine.reconcileManagement(request.id, { ...reconciliation, attemptId: "other-attempt" }, attestation, 1),
	).toThrow("original request");
	expect(() => f.engine.reconcileManagement(request.id, reconciliation, attestation, 0)).toThrow("revision changed");
	f.engine.pause("owner");
	expect(() => f.engine.reconcileManagement(request.id, reconciliation, attestation, 1)).toThrow("paused");
	f.engine.resume();
	writeFileSync(f.pauseFile, "owner");
	expect(() => f.engine.reconcileManagement(request.id, reconciliation, attestation, 1)).toThrow("paused");
	rmSync(f.pauseFile);
	f.engine.reconcileManagement(request.id, reconciliation, attestation, 1);
	expect(f.store.managementRequests()[0]).toMatchObject({ state: "RECONCILED", result: request.result });
	expect(f.engine.applyPlan(changedPlan, 1)).toBe(2);
});

test("handles proven no-submission recovery without fabricated output and permits evidence-backed decide", async () => {
	const f = await fixture();
	const wake = f.store.wakes()[0];
	const claim = {
		id: randomUUID(),
		wakeId: wake.id,
		actionId: wake.actionId,
		attemptId: wake.attemptId!,
		planRevision: 1,
		evidenceSha256: "0".repeat(64),
	};
	expect(f.store.claimManagement(claim)).toBe(true);
	const request = f.store.managementRequests()[0];
	const reconciliation = reconcileProof(f.directory, request, true);
	f.engine.reconcileManagement(request.id, reconciliation, attestation, 1);
	f.engine.decide("a", "accept", attestation, 1, request.attemptId, request.wakeId);
	expect(f.store.actions()[0].state).toBe("ACCEPTED");
	expect(f.store.attempts()).toHaveLength(4);
	expect(f.store.managementRequests()).toHaveLength(1);
	expect(
		f.store
			.events(0, 100)
			.some((event) => event.kind === "management_reconciled" && event.detail.previousState === "CLAIMED"),
	).toBe(true);
});

test.each(["defer", "error"])(
	"an unrelated ticket import and refreshed binding cannot replay unchanged %s evidence",
	async (outcome) => {
		const f = await fixture();
		const firstModel: ManagementCallerFactory =
			outcome === "defer"
				? model("defer")
				: () => async () => {
						throw new Error("provider error");
					};
		await manageFactoryWake(f.engine, { directory: f.directory, actionId: "a", evidence }, firstModel);
		const request = f.store.managementRequests()[0];
		const foreign: FactoryPlan = {
			version: 1,
			tickets: [{ id: "unrelated", owner: "another-owner" }],
			slots: [],
			actions: [{ ...f.plan.actions[0], id: "foreign", ticketId: "unrelated", kind: "process" }],
		};
		expect(f.engine.applyPlan(foreign, 1, "unrelated-outbox")).toBe(2);
		expect(f.store.tickets()).toHaveLength(2);
		mkdirSync(join(f.directory, "management-evidence"));
		const path = join(f.directory, "management-evidence", `${request.wakeId}.json`);
		const writeBinding = (content: string) =>
			writeFileSync(
				path,
				JSON.stringify({
					version: 1,
					wakeId: request.wakeId,
					actionId: request.actionId,
					attemptId: request.attemptId,
					planRevision: 2,
					evidence: [
						{ ref: evidence[0].ref, content, sha256: createHash("sha256").update(content).digest("hex") },
					],
				}),
			);
		writeBinding(evidence[0].content);
		let calls = 0;
		const counted: ManagementCallerFactory =
			(checkCurrent) =>
			async (...args) => {
				calls++;
				return model("defer")(checkCurrent)(...args);
			};
		expect((await manageFactoryWake(f.engine, { directory: f.directory, automatic: true }, counted)).kind).toBe(
			"consumed",
		);
		expect(calls).toBe(0);
		writeBinding("New substantive exact-head evidence, not merely a new revision");
		expect((await manageFactoryWake(f.engine, { directory: f.directory, automatic: true }, counted)).kind).toBe(
			"deferred",
		);
		expect(calls).toBe(1);
	},
);
