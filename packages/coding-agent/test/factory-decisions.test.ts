import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runFactoryCli } from "../src/factory/cli.js";
import * as decisionReceipt from "../src/factory/decision-receipt.js";
import { publishAppliedReceipt } from "../src/factory/decision-receipt.js";
import {
	codeDecisionBase,
	type DecisionOf,
	type FactoryDecision,
	mergeGatePredicate,
	recordDecision,
	validateDecision,
} from "../src/factory/decisions.js";
import { FactoryEngine } from "../src/factory/engine.js";
import { FACTORY_EVIDENCE_LIMITS } from "../src/factory/evidence.js";
import type { ManagementPacket } from "../src/factory/management.js";
import { manageFactoryWake } from "../src/factory/management-dispatch.js";
import { FactoryStore } from "../src/factory/store.js";
import type { FactoryAdapter, FactoryPlan } from "../src/factory/types.js";

const roots: string[] = [],
	stores: FactoryStore[] = [];
const base = codeDecisionBase(0, "Exact current facts");
const fixtures = [
	{
		...base,
		type: "writer_terminal_accept",
		attempt_id: "attempt",
		candidate_fingerprint: "source",
		receipt_fingerprint: "source",
		exit_code: 0,
		agent_end: true,
		stop_reason: "stop",
		changed_paths: ["src/a.ts"],
		allowed_paths_only: true,
		receipt_ready: true,
		receipt_sha: "a".repeat(64),
	},
	{
		...base,
		type: "test_gate_accept",
		gate_kind: "unit",
		attempt_id: "attempt",
		candidate_fingerprint: "source",
		receipt_fingerprint: "source",
		exit_code: 0,
		wrapper_rc: 0,
		tests: { run: 2, passed: 2, failed: 0, skipped: 0 },
		provenance_pass: true,
		source_unchanged: true,
		criteria: { min_tests: 1, forbidden_replay_of: null, required_pin: "pin" },
		is_replay: false,
	},
	{
		...base,
		type: "baseline_adoption",
		retained_revision: "head",
		fingerprint: "source",
		dirty_paths_count: 0,
		authority_record: { path: "/owner/record", sha: "a".repeat(64) },
		authorship_proof: "signed",
		known_defects: [],
		prior_green_candidate: null,
	},
	{
		...base,
		type: "attempt_requeue",
		attempt_id: "attempt",
		core_state: "UNCERTAIN",
		claim_released: false,
		receipt_present: false,
		pid: 42,
		boot_id: "boot",
		start_ticks: 5,
		census: { matches: 0, unreadable: false },
		equivalent_job: null,
		successor: null,
		partial_banked: true,
		duplicate_of_event: null,
	},
	{
		...base,
		type: "writer_stop",
		writer_attempt: "attempt",
		pgid: 42,
		task_summary: "Bounded change",
		blueprint_conflict: { present: true, lines: ["Owner hold"] },
		owner_hold: { scope: "ticket" },
		target_repo_allowlist_status: "allowed",
		read_only: false,
		about_to_mutate: true,
	},
	{
		...base,
		type: "executability",
		named_dependency: "none",
		independent_work_available: true,
		authority_covers: true,
		hold_scope: null,
	},
	{
		...base,
		type: "scope",
		target_repo: "org/repo",
		changed_paths: ["src/a.ts"],
		allowlist: { id: "allowlist", sha: "a".repeat(64), verdict_for_repo: true },
		amendment_record: "none",
		blueprint_scope_paths: ["src"],
		delegation_covers_path_expansion: false,
	},
	{
		...base,
		type: "merge_gate_predicate",
		candidate_head: "head",
		reviewed_head_is_tip: true,
		gates: [{ name: "unit", status: "green", head: "head" }],
		review: { provider: "grok", status: "completed", bugs: 0, rules: 0, comment_id: "42", head: "head" },
		open_threads: [],
		provenance: { signed: true, base_main_proof: "signed-base-proof" },
		owner_hold: false,
		owner_waiver: null,
	},
	{
		...base,
		type: "build_host",
		portable: true,
		platform_specific_proof: null,
		candidate_fingerprint: "source",
		hosts: [{ host: "macbook", slot: "1", free: true, staged_workspace: true, warm_cache: true, receipt_age_s: 1 }],
		forbidden_replay_of: null,
	},
	{
		...base,
		type: "review_posting",
		request_command_exit: 0,
		returned_comment_id: "42",
		url: "https://example.test/review/42",
		posted_at: "2026-09-18T00:00:00Z",
		run_status: "completed",
		status_check_vs_comment_contradiction: false,
		manual_request_exists: true,
	},
	{
		...base,
		type: "trivial_fix_eligible",
		changed_files: 1,
		changed_lines: 2,
		hunks: 1,
		compiler_message: "Missing import",
		semantic_categories_touched: [],
		cap_exhausted: false,
		prior_rounds: 0,
	},
	{
		...base,
		type: "review_tier",
		changed_files: 1,
		changed_lines: 2,
		hunks: 1,
		seams_touched: [],
		blueprint_risk_tag: null,
		prior_bot_findings: 0,
		test_delta: { added: 0, removed: 0 },
		docs_only: true,
		choice: "bots_only",
	},
	{
		...base,
		type: "admission_priority",
		lane: "lane",
		ready_actions: [{ id: "a", ticket: "ticket", critical_path_len: 3, blocked_dependents: 2, slot_fit: true }],
		free_slots: [{ host: "macbook", slot: "1" }],
		lane_digest_sha: "a".repeat(64),
	},
] satisfies FactoryDecision[];
function decision<T extends FactoryDecision["type"]>(type: T): DecisionOf<T> {
	return structuredClone(fixtures.find((d) => d.type === type)) as DecisionOf<T>;
}
const adapter: FactoryAdapter = {
	async launch(context) {
		return {
			kind: "terminal",
			receipt: {
				attemptId: context.attempt.id,
				sourceFingerprint: "source",
				exitCode: 0,
				finishedAt: new Date().toISOString(),
			},
		};
	},
	async inspect() {
		return { kind: "uncertain", reason: "No process evidence" };
	},
};
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "factory-typed-"));
	roots.push(directory);
	const path = join(directory, "factory.db"),
		store = new FactoryStore(path);
	stores.push(store);
	writeFileSync(
		join(directory, "config.json"),
		JSON.stringify({ version: 1, hosts: { local: { type: "local", runnerRoot: join(directory, "runner") } } }),
	);
	const plan: FactoryPlan = {
		version: 1,
		tickets: [{ id: "ticket", owner: "owner" }],
		slots: [{ id: "slot", host: "local" }],
		actions: [
			{
				id: "a",
				ticketId: "ticket",
				kind: "decision",
				dependencies: [],
				sourceFingerprint: "source",
				acceptanceCriteria: ["Proof passed"],
				command: { argv: ["true"], cwd: directory },
				requirements: {},
			},
		],
		roles: { ticketOwner: { provider: "fixture", model: "expected", effort: "low" } },
	};
	store.applyPlan(plan);
	return { directory, path, store, plan, engine: new FactoryEngine(store, adapter, { enabled: true }) };
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("typed decision validation", () => {
	test.each([
		["merge_gate_predicate", "gates", { name: "unit", status: "green", head: "head" }, 4096],
		[
			"merge_gate_predicate",
			"open_threads",
			{ id: "1", head: "head", resolved_by: null, covered_by_ticket_regression: null },
			4096,
		],
		[
			"build_host",
			"hosts",
			{ host: "local", slot: "1", free: true, staged_workspace: null, warm_cache: null, receipt_age_s: null },
			4096,
		],
		["trivial_fix_eligible", "semantic_categories_touched", "logic", 7],
		["review_tier", "seams_touched", "custody", 8],
		[
			"admission_priority",
			"ready_actions",
			{ id: "a", ticket: "ticket", critical_path_len: 1, blocked_dependents: 0, slot_fit: true },
			4096,
		],
		["admission_priority", "free_slots", { host: "local", slot: "1" }, 4096],
	] as const)("caps %s.%s", (type, field, item, cap) => {
		expect(() =>
			validateDecision({ ...decision(type), [field]: Array.from({ length: cap + 1 }, () => item) }),
		).toThrow("Invalid factory decision");
	});
	test.each(fixtures)("constructs and validates $type, including all required fields", (value) => {
		expect(validateDecision(value, value.type)).toEqual(value);
		for (const key of Object.keys(value)) {
			const incomplete: Record<string, unknown> = { ...value };
			delete incomplete[key];
			expect(() => validateDecision(incomplete, value.type), key).toThrow("Invalid factory decision");
		}
		expect(() => validateDecision({ ...value, extra: true })).toThrow();
		expect(() => validateDecision({ ...value, probability_or_confidence: 1.1 })).toThrow();
	});
	test("rejects malformed nested values, wrong enums and mismatched types", () => {
		expect(() =>
			validateDecision({ ...decision("test_gate_accept"), tests: { run: -1, passed: 0, failed: 0, skipped: 0 } }),
		).toThrow();
		expect(() => validateDecision({ ...decision("scope"), allowlist: { id: "x" } })).toThrow();
		expect(() => validateDecision({ ...decision("review_tier"), seams_touched: ["guess"] })).toThrow();
		expect(() =>
			validateDecision({ ...decision("trivial_fix_eligible"), semantic_categories_touched: ["cosmetic"] }),
		).toThrow();
		expect(() => validateDecision(decision("scope"), "build_host")).toThrow();
		expect(() => validateDecision({ ...decision("scope"), usage: { input: 1 } })).toThrow();
		expect(() => validateDecision({ ...decision("scope"), cost_usd: -1 })).toThrow();
	});
	test("forces the full review tier for every named seam without mutating the submitted object", () => {
		for (const seam of [
			"custody",
			"auth",
			"persistence",
			"migration",
			"crypto",
			"concurrency",
			"abi",
			"public_api",
		] as const) {
			const d = { ...decision("review_tier"), seams_touched: [seam] };
			expect(validateDecision(d)).toMatchObject({ choice: "grok_plus_muse_plus_opus" });
			expect(d.choice).toBe("bots_only");
		}
	});
});

describe("merge gate predicate", () => {
	test("accepts green gates, completed external comment and provenance on the tip", () => {
		expect(mergeGatePredicate(decision("merge_gate_predicate"))).toEqual({ result: true, failing_clauses: [] });
	});
	test("fails closed when the owner hold is unknown", () => {
		const d = decision("merge_gate_predicate");
		d.owner_hold = null;
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses: ["no_owner_hold"] });
	});
	test("refuses a completed review without its comment id", () => {
		const d = decision("merge_gate_predicate");
		d.review.comment_id = null;
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses: ["review_comment_id"] });
	});
	test("accepts only an explicit matching waiver for missing review and retains review failures", () => {
		const d = decision("merge_gate_predicate");
		d.reviewed_head_is_tip = false;
		d.review = { provider: null, status: "missing", bugs: null, rules: null, comment_id: null, head: "head" };
		const failing_clauses = ["external_review_on_tip", "review_comment_id", "findings_resolved"];
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses });
		d.owner_waiver = { scope: { candidate_head: "head", review_head: "head" }, record: "/owner/waiver" };
		expect(mergeGatePredicate(d)).toEqual({ result: true, failing_clauses });
		d.owner_waiver.scope.candidate_head = "old";
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses });
		d.owner_waiver.scope.candidate_head = "head";
		d.owner_waiver.scope.review_head = "old";
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses });
		d.owner_waiver.scope.review_head = "head";
		d.owner_waiver.record = " ";
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses });
	});
	test("waives stale review and unresolved findings only for the named candidate/review pair", () => {
		const d = decision("merge_gate_predicate");
		d.reviewed_head_is_tip = false;
		d.review.head = "old";
		d.review.bugs = 1;
		d.review.rules = 1;
		d.open_threads = [{ id: "finding", head: "old", resolved_by: null, covered_by_ticket_regression: null }];
		d.owner_waiver = { scope: { candidate_head: "head", review_head: "old" }, record: "/owner/waiver" };
		expect(mergeGatePredicate(d)).toEqual({
			result: true,
			failing_clauses: ["external_review_on_tip", "findings_resolved"],
		});
	});
	test.each([true, null])("does not waive a live or unknown owner hold (%s)", (hold) => {
		const d = decision("merge_gate_predicate");
		d.owner_hold = hold;
		d.owner_waiver = { scope: { candidate_head: "head", review_head: "head" }, record: "/owner/waiver" };
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses: ["no_owner_hold"] });
	});
	test.each([
		{ signed: false, base_main_proof: "signed-base-proof" },
		{ signed: true, base_main_proof: null },
	])("does not waive failed provenance ($signed, $base_main_proof)", (provenance) => {
		const d = decision("merge_gate_predicate");
		d.provenance = provenance;
		d.owner_waiver = { scope: { candidate_head: "head", review_head: "head" }, record: "/owner/waiver" };
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses: ["provenance_bound"] });
	});
	test.each(["missing", "failed", "stale"] as const)("does not waive %s checks", (checks) => {
		const d = decision("merge_gate_predicate");
		if (checks === "missing") d.gates = [];
		else if (checks === "failed") d.gates[0].status = "red";
		else d.gates[0].head = "old";
		d.owner_waiver = { scope: { candidate_head: "head", review_head: "head" }, record: "/owner/waiver" };
		expect(mergeGatePredicate(d)).toEqual({ result: false, failing_clauses: ["gates_on_tip"] });
	});
	test("never infers regression coverage or credits stale checks", () => {
		const d = decision("merge_gate_predicate");
		d.open_threads = [{ id: "finding", head: "head", resolved_by: null, covered_by_ticket_regression: null }];
		expect(mergeGatePredicate(d).failing_clauses).toContain("findings_resolved");
		d.open_threads[0].covered_by_ticket_regression = true;
		expect(mergeGatePredicate(d).result).toBe(true);
		d.gates[0].head = "old";
		expect(mergeGatePredicate(d).failing_clauses).toContain("gates_on_tip");
	});
});

describe("durable typed writer and dispatcher verb", () => {
	test("retains a matching review waiver alongside a blocking hold in the journal and receipt", () => {
		const f = fixture();
		const d = { ...decision("merge_gate_predicate"), ledger_sequence: f.store.ledgerSequence() };
		d.review.status = "missing";
		d.owner_hold = true;
		d.owner_waiver = { scope: { candidate_head: "head", review_head: "head" }, record: "/owner/waiver" };
		const receipt = recordDecision(f.store, "a", d, { requestId: "held-waiver" });
		expect(receipt.predicate).toEqual({
			result: false,
			failing_clauses: ["external_review_on_tip", "no_owner_hold"],
		});
		expect(receipt.decision).toEqual(d);
		expect(f.store.eventsOfKind("decision")[0].detail).toMatchObject({
			owner_waiver: d.owner_waiver,
			predicate: receipt.predicate,
		});
		expect(JSON.parse(readFileSync(join(f.directory, "decisions/held-waiver/decision.json"), "utf8"))).toEqual(
			receipt,
		);
	});
	test.each(["inline", "file"] as const)("rejects an oversized %s object before recording", async (input) => {
		const f = fixture();
		const value = {
			...decision("scope"),
			ledger_sequence: f.store.ledgerSequence(),
			changed_paths: Array<string>(8).fill("x".repeat(16000)),
		};
		expect(validateDecision(value)).toEqual(value);
		const serialized = JSON.stringify(value);
		expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(FACTORY_EVIDENCE_LIMITS.packetBytes);
		const path = join(f.directory, "oversized.json");
		writeFileSync(path, serialized);
		const before = f.store.allEvents();
		await expect(
			runFactoryCli([
				"decide-typed",
				f.directory,
				"a",
				"scope",
				"--object",
				input === "file" ? `@${path}` : serialized,
			]),
		).rejects.toThrow(/decision: actual .* exceeds limit 98304/);
		expect(f.store.allEvents()).toEqual(before);
		expect(f.store.typedDecisions()).toEqual([]);
	});
	test.each(["review_tier", "merge_gate_predicate"] as const)(
		"journals submitted attribution when code normalizes %s",
		async (type) => {
			const f = fixture();
			const value = {
				...(type === "review_tier"
					? { ...decision("review_tier"), seams_touched: ["persistence"] }
					: decision("merge_gate_predicate")),
				ledger_sequence: f.store.ledgerSequence(),
				decided_by: "advisor",
			};
			vi.spyOn(console, "log").mockImplementation(() => {});
			await runFactoryCli(["decide-typed", f.directory, "a", type, "--object", JSON.stringify(value)]);
			expect(f.store.eventsOfKind("decision")[0]?.detail).toMatchObject({
				decided_by: "code",
				submitted_by: "advisor",
			});
			expect(value.decided_by).toBe("advisor");
		},
	);
	test("refuses profile drift, writes a false receipt, journals both profiles and opens a wake", () => {
		const f = fixture(),
			apply = vi.fn();
		const d = {
			...decision("scope"),
			ledger_sequence: f.store.ledgerSequence(),
			requested_profile: "expected",
			served_profile: "fallback",
		};
		const receipt = recordDecision(f.store, "a", d, { requestId: "drift", apply });
		expect(apply).not.toHaveBeenCalled();
		expect(receipt.applied).toBe(false);
		expect(JSON.parse(readFileSync(join(f.directory, "decisions/drift/decision.json"), "utf8"))).toEqual(receipt);
		expect(f.store.eventsOfKind("profile_drift")[0]?.detail).toEqual({
			request_id: "drift",
			requested_profile: "expected",
			served_profile: "fallback",
		});
		expect(f.store.wakes().some((w) => w.reason === "profile_drift: drift" && !w.resolvedAt)).toBe(true);
		const reopened = new FactoryStore(f.path);
		stores.push(reopened);
		expect(reopened.typedDecisions()).toEqual([receipt]);
		expect(reopened.actions()[0].state).toBe("READY");
	});
	test.each(["resume", "retry"])(
		"asserts provider metadata on the first real management turn after %s",
		async (mode) => {
			const f = fixture();
			if (mode === "retry") {
				const c = f.store.claim("a", "slot")!;
				f.store.markSubmitted(c.attempt.id);
				f.store.markUncertain(c.attempt.id, "unreachable");
				f.store.resolveForRetry(c.attempt.id, { actor: "owner", reason: "Stopped process proven", ref: "/proof" });
			} else {
				f.engine.pause("owner");
				f.engine.resume();
			}
			await f.engine.tick();
			const result = await manageFactoryWake(
				f.engine,
				{ directory: f.directory, apply: true, evidence: [{ ref: "proof", content: "Reviewed output" }] },
				() => async (_system, text) => {
					const packet = JSON.parse(text) as ManagementPacket;
					return {
						model: "expected",
						responseModel: "fallback",
						responseModelSource: "provider-response",
						text: JSON.stringify({
							version: 1,
							actionId: "a",
							attemptId: packet.attempt!.id,
							planRevision: packet.planRevision,
							decision: "accept",
							reason: "Proof passed",
							evidenceRefs: ["proof"],
						}),
					};
				},
			);
			expect(result).toMatchObject({ kind: "drift", requestedProfile: "expected", servedProfile: "fallback" });
			if (result.kind !== "drift") throw new Error("Expected profile drift");
			expect(f.store.wakes().find((wake) => wake.id === result.wakeId)).toMatchObject({
				reason: `profile_drift: ${result.requestId}`,
				resolvedAt: null,
			});
			expect(f.store.managementRequests()[0]).toMatchObject({ state: "DRIFT", error: null });
			expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
			expect(f.store.eventsOfKind("profile_drift").length > 0).toBe(true);
			const saved = JSON.parse(readFileSync(join(result.evidenceDirectory!, "decision.json"), "utf8"));
			expect(saved.applied).toBe(false);
			expect(saved.decision.served_profile).toBe("fallback");
			expect(f.store.managementRequests()[0].result).toEqual(saved);
			expect(result.typedDecision).toEqual(saved);
		},
	);
	test("does not accept setter/SDK identity when response metadata is absent", async () => {
		const f = fixture();
		await f.engine.tick();
		const result = await manageFactoryWake(f.engine, { directory: f.directory }, () => async () => ({
			model: "expected",
			text: "{}",
		}));
		expect(result).toMatchObject({ kind: "drift", requestedProfile: "expected", servedProfile: "unknown" });
	});
	test("prints both sequences and refuses stale decide-typed input without a row", async () => {
		const f = fixture(),
			old = f.store.ledgerSequence();
		const d = { ...decision("scope"), ledger_sequence: old };
		await f.engine.tick();
		const last = f.store.ledgerSequence("a"),
			count = f.store.typedDecisions().length;
		await expect(
			runFactoryCli(["decide-typed", f.directory, "a", "scope", "--object", JSON.stringify(d)]),
		).rejects.toThrow(`Decision ledger_sequence ${old}; action last event ${last}`);
		expect(f.store.typedDecisions()).toHaveLength(count);
	});
	test("records @file input without applying, then applies a fresh terminal acceptance", async () => {
		const f = fixture();
		await f.engine.tick();
		const attempt = f.store.attempts()[0];
		const d = {
			...decision("writer_terminal_accept"),
			ledger_sequence: f.store.ledgerSequence(),
			attempt_id: attempt.id,
			receipt_sha: createHash("sha256").update(JSON.stringify(attempt.receipt)).digest("hex"),
		};
		const path = join(f.directory, "decision-input.json");
		writeFileSync(path, JSON.stringify(d));
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		await runFactoryCli(["decide-typed", f.directory, "a", d.type, "--object", `@${path}`]);
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
		d.ledger_sequence = f.store.ledgerSequence();
		await runFactoryCli(["decide-typed", f.directory, "a", d.type, "--object", JSON.stringify(d), "--apply"]);
		expect(f.store.actions()[0].state).toBe("ACCEPTED");
		expect(JSON.parse(String(output.mock.calls.at(-1)![0])).applied).toBe(true);
		expect(f.store.typedDecisions().at(-1)?.applied).toBe(true);
	});
	test("rejects future sequences, false receipt hashes, unsupported apply and unknown types", async () => {
		const f = fixture();
		await f.engine.tick();
		const d = {
			...decision("writer_terminal_accept"),
			ledger_sequence: f.store.ledgerSequence(),
			attempt_id: f.store.attempts()[0].id,
		};
		await expect(
			runFactoryCli(["decide-typed", f.directory, "a", d.type, "--object", JSON.stringify(d), "--apply"]),
		).rejects.toThrow("criteria");
		expect(() => recordDecision(f.store, "a", { ...d, ledger_sequence: d.ledger_sequence + 100 })).toThrow(
			"ledger sequence",
		);
		await expect(
			runFactoryCli([
				"decide-typed",
				f.directory,
				"a",
				"scope",
				"--object",
				JSON.stringify({ ...decision("scope"), ledger_sequence: d.ledger_sequence }),
				"--apply",
			]),
		).rejects.toThrow("No direct state transition");
		await expect(
			runFactoryCli(["decide-typed", f.directory, "a", "unknown", "--object", JSON.stringify(d)]),
		).rejects.toThrow("Invalid factory decision");
		expect(f.store.actions()[0].state).toBe("AWAITING_DECISION");
	});
	test("indexes build-host, terminal and requeue rows without inventing management authority", async () => {
		const f = fixture();
		await f.engine.tick();
		expect(f.store.typedDecisions().map((r) => r.decision.type)).toEqual(["build_host", "writer_terminal_accept"]);
		expect(f.store.managementRequests()).toEqual([]);
		const second = fixture();
		const c = second.store.claim("a", "slot")!;
		second.store.markSubmitted(c.attempt.id);
		second.store.markUncertain(c.attempt.id, "unknown");
		second.store.resolveForRetry(c.attempt.id, { actor: "owner", reason: "Stopped custody", ref: "/proof" });
		expect(second.store.typedDecisions().at(-1)?.decision).toMatchObject({
			type: "attempt_requeue",
			decided_by: "operator",
			requested_profile: "operator",
			served_profile: "operator",
		});
		const process = fixture();
		process.plan.actions[0].kind = "process";
		process.store.applyPlan(process.plan);
		await process.engine.tick();
		expect(process.store.typedDecisions().at(-1)?.decision.type).toBe("test_gate_accept");
	});
	test("migrates the old wake-bound management index without losing rows", () => {
		const f = fixture();
		const db = new DatabaseSync(f.path);
		db.exec(
			"UPDATE metadata SET value='1' WHERE key='schema_version'; ALTER TABLE management_requests RENAME TO old; DROP INDEX management_wake_inflight; CREATE TABLE management_requests (id TEXT PRIMARY KEY,wake_id INTEGER NOT NULL REFERENCES wakes(id),action_id TEXT NOT NULL,attempt_id TEXT NOT NULL,plan_revision INTEGER NOT NULL,evidence_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT,UNIQUE(wake_id,plan_revision,attempt_id,evidence_sha256)); DROP TABLE old; CREATE UNIQUE INDEX management_wake_inflight ON management_requests(wake_id) WHERE state='CLAIMED'; INSERT INTO wakes(action_id,attempt_id,reason,created_at) VALUES('a','attempt','proof','fixture'); INSERT INTO management_requests VALUES('prior',1,'a','attempt',1,'hash','fixture','ERROR',NULL,'interrupted');",
		);
		db.close();
		const reopened = new FactoryStore(f.path);
		stores.push(reopened);
		expect(reopened.managementRequests()[0]).toMatchObject({ id: "prior", state: "ERROR", error: "interrupted" });
		expect(reopened.status().schemaVersion).toBe(2);
		expect(() =>
			recordDecision(reopened, "a", { ...decision("scope"), ledger_sequence: reopened.ledgerSequence() }),
		).not.toThrow();
	});
});

test("rolls back the ledger with only an unapplied file after a post-save journal failure", () => {
	const f = fixture();
	const db = new DatabaseSync(f.path);
	db.exec(
		"CREATE TRIGGER refuse_decision BEFORE INSERT ON events WHEN NEW.kind='decision' BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END;",
	);
	db.close();
	const d = { ...decision("scope"), ledger_sequence: f.store.ledgerSequence() };
	expect(() =>
		recordDecision(f.store, "a", d, { requestId: "rollback", apply: () => f.store.pause("must roll back") }),
	).toThrow("injected journal failure");
	expect(f.store.isPaused()).toBe(false);
	expect(f.store.typedDecisions()).toEqual([]);
	expect(f.store.eventsOfKind("decision").length > 0).toBe(false);
	expect(JSON.parse(readFileSync(join(f.directory, "decisions/rollback/decision.json"), "utf8")).applied).toBe(false);
});

test("does not repeat a failed decision write or escape the bounded management result", async () => {
	const f = fixture();
	await f.engine.tick();
	const write = vi.spyOn(f.store, "commitTypedDecision").mockImplementation(() => {
		throw new Error("storage unavailable");
	});
	const result = await manageFactoryWake(f.engine, { directory: f.directory }, () => async (_system, text) => {
		const packet = JSON.parse(text) as ManagementPacket;
		return {
			model: "expected",
			responseModel: "expected",
			responseModelSource: "provider-response",
			text: JSON.stringify({
				version: 1,
				actionId: "a",
				attemptId: packet.attempt!.id,
				planRevision: packet.planRevision,
				decision: "defer",
				reason: "Need proof",
				evidenceRefs: [],
			}),
		};
	});
	expect(result.kind).toBe("error");
	expect(result.error).toContain("storage unavailable");
	expect(write).toHaveBeenCalledTimes(1);
	expect(f.store.managementRequests()[0].state).toBe("ERROR");
});

test.each([false, true])(
	"records a durable applied management receipt (cached=%s) without double billing",
	async (cached) => {
		const f = fixture();
		await f.engine.tick();
		const options = { directory: f.directory, evidence: [{ ref: "proof", content: "Exact independent review" }] };
		const call = vi.fn(async (_system: string, text: string) => {
			const packet = JSON.parse(text) as ManagementPacket;
			return {
				model: "expected",
				responseModel: "expected",
				responseModelSource: "provider-response" as const,
				text: JSON.stringify({
					version: 1,
					actionId: "a",
					attemptId: packet.attempt!.id,
					planRevision: packet.planRevision,
					decision: "accept",
					reason: "Proof passed",
					evidenceRefs: ["proof"],
				}),
			};
		});
		if (cached) expect((await manageFactoryWake(f.engine, options, () => call)).kind).toBe("proposed");
		const applied = await manageFactoryWake(f.engine, { ...options, apply: true }, () => call);
		expect(applied.kind).toBe("applied");
		expect(call).toHaveBeenCalledTimes(1);
		const indexed = f.store.managementRequests()[0].result;
		if (!indexed || !("proposal" in indexed)) throw new Error("Missing indexed management result");
		const receipt = indexed.typedDecision!;
		expect(receipt.applied).toBe(true);
		expect(receipt.source_request_id).toBe(applied.requestId);
		expect(receipt.accounting).toMatchObject({ calls: 0, cost_usd: 0 });
		expect(
			JSON.parse(readFileSync(join(f.directory, "decisions", receipt.request_id, "decision.json"), "utf8")),
		).toEqual(receipt);
		expect(
			f.store
				.eventsOfKind("decision")
				.some((e) => e.detail.applied === true && e.detail.source_request_id === applied.requestId),
		).toBe(true);
	},
);

test("PR #7: stale applied stages do not block publication or get deleted", () => {
	const f = fixture(),
		path = join(f.directory, "decision.json"),
		stale = `${path}.applied`;
	writeFileSync(path, JSON.stringify({ applied: false }));
	writeFileSync(stale, "retained");
	publishAppliedReceipt(path, { applied: true });
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ applied: true });
	expect(readFileSync(stale, "utf8")).toBe("retained");
});

test.each(["record", "cli"].flatMap((caller) => [false, true].map((late) => ({ caller, late }))))(
	"PR #7 Q4: $caller preserves a committed decision when publication fails (late=$late)",
	async ({ caller, late }) => {
		const f = fixture();
		await f.engine.tick();
		const attempt = f.store.attempts()[0];
		const d = {
			...decision("writer_terminal_accept"),
			ledger_sequence: f.store.ledgerSequence(),
			attempt_id: attempt.id,
			receipt_sha: createHash("sha256").update(JSON.stringify(attempt.receipt)).digest("hex"),
		};
		const publish = decisionReceipt.publishAppliedReceipt;
		vi.spyOn(decisionReceipt, "publishAppliedReceipt").mockImplementation((path, data) => {
			if (late) publish(path, data);
			throw new Error("injected publication failure");
		});
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const receipt =
			caller === "record"
				? recordDecision(f.store, "a", d, {
						apply: () =>
							f.store.decide("a", "accept", { actor: "operator", reason: "Proof passed", ref: "/proof" }),
					})
				: await runFactoryCli([
						"decide-typed",
						f.directory,
						"a",
						d.type,
						"--object",
						JSON.stringify(d),
						"--apply",
					]).then(() => JSON.parse(String(output.mock.calls.at(-1)![0])));
		expect(receipt).toMatchObject({
			applied: false,
			publish_error: expect.stringContaining(
				"Decision committed; receipt unpublished: injected publication failure",
			),
		});
		const path = join(f.directory, "decisions", receipt.request_id, "decision.json");
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ applied: false });
		const reopened = new FactoryStore(f.path);
		stores.push(reopened);
		expect(reopened.actions()[0].state).toBe("ACCEPTED");
		expect(reopened.typedDecisions().at(-1)).toMatchObject({ request_id: receipt.request_id, applied: true });
		expect(reopened.eventsOfKind("decision").at(-1)!.detail.applied).toBe(true);
		expect(reopened.eventsOfKind("decision_receipt_unpublished")).toEqual([
			expect.objectContaining({
				actionId: "a",
				detail: { request_id: receipt.request_id, path, error: receipt.publish_error },
			}),
		]);
	},
);
