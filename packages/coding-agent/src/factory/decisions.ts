import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Static, type TProperties, Type } from "typebox";
import { Value } from "typebox/value";
import { publishAppliedReceipt, save } from "./decision-receipt.js";
import type { FactoryStore } from "./store.js";
import { FACTORY_USAGE_FIELDS, type FactoryCallCost, sumFactoryCosts } from "./usage.js";

export const DECISION_VERSION = "wave7-v1";
const s = Type.String({ minLength: 1, maxLength: 16000 }),
	b = Type.Boolean();
const n = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullable = <T extends TProperties[string]>(schema: T) => Type.Union([schema, Type.Null()]);
const ns = nullable(s),
	nb = nullable(b),
	nn = nullable(n),
	exit = nullable(Type.Integer());
const strings = Type.Array(s, { maxItems: 4096 });
const obj = <T extends TProperties>(fields: T) => Type.Object(fields, { additionalProperties: false });
const job = nullable(obj({ id: s, state: s }));
const common = {
	version: Type.Literal(DECISION_VERSION),
	ledger_sequence: n,
	requested_profile: s,
	served_profile: s,
	decided_by: Type.Union([
		Type.Literal("none"),
		Type.Literal("jev"),
		Type.Literal("advisor"),
		Type.Literal("operator"),
		Type.Literal("code"),
	]),
	probability_or_confidence: nullable(Type.Number({ minimum: 0, maximum: 1 })),
	reason: s,
	usage: Type.Unsafe<FactoryCallCost["usage"]>(
		nullable(obj(Object.fromEntries(FACTORY_USAGE_FIELDS.map((key) => [key, n])))),
	),
	cost_usd: Type.Unsafe<FactoryCallCost["cost_usd"]>(nullable(Type.Number({ minimum: 0 }))),
	wall_clock_ms: n,
};
const variant = <T extends string, P extends TProperties>(type: T, fields: P) =>
	obj({ type: Type.Literal(type), ...common, ...fields });
export const FactoryDecisionSchema = Type.Union([
	variant("writer_terminal_accept", {
		attempt_id: s,
		candidate_fingerprint: s,
		receipt_fingerprint: ns,
		exit_code: exit,
		agent_end: nb,
		stop_reason: ns,
		changed_paths: nullable(strings),
		allowed_paths_only: nb,
		receipt_ready: b,
		receipt_sha: ns,
	}),
	variant("test_gate_accept", {
		gate_kind: s,
		attempt_id: s,
		candidate_fingerprint: s,
		receipt_fingerprint: ns,
		exit_code: exit,
		wrapper_rc: exit,
		tests: obj({ run: nn, passed: nn, failed: nn, skipped: nn }),
		provenance_pass: nb,
		source_unchanged: nb,
		criteria: obj({ min_tests: nn, forbidden_replay_of: ns, required_pin: ns }),
		is_replay: nb,
	}),
	variant("baseline_adoption", {
		retained_revision: s,
		fingerprint: s,
		dirty_paths_count: n,
		authority_record: obj({ path: s, sha: s }),
		authorship_proof: s,
		known_defects: strings,
		prior_green_candidate: ns,
	}),
	variant("attempt_requeue", {
		attempt_id: s,
		core_state: s,
		claim_released: b,
		receipt_present: b,
		pid: nn,
		boot_id: ns,
		start_ticks: nn,
		census: obj({ matches: nn, unreadable: nb }),
		equivalent_job: job,
		successor: job,
		partial_banked: nb,
		duplicate_of_event: nullable(obj({ id: n, consumed_sha: s })),
	}),
	variant("writer_stop", {
		writer_attempt: s,
		pgid: nn,
		task_summary: s,
		blueprint_conflict: obj({ present: b, lines: strings }),
		owner_hold: obj({ scope: ns }),
		target_repo_allowlist_status: s,
		read_only: b,
		about_to_mutate: b,
	}),
	variant("executability", {
		named_dependency: Type.Union([Type.Literal("none"), obj({ kind: s, id: s, release_route: s })]),
		independent_work_available: b,
		authority_covers: b,
		hold_scope: ns,
	}),
	variant("scope", {
		target_repo: s,
		changed_paths: strings,
		allowlist: obj({ id: s, sha: s, verdict_for_repo: b }),
		amendment_record: Type.Union([Type.Literal("none"), obj({ path: s, owner_quote: s })]),
		blueprint_scope_paths: strings,
		delegation_covers_path_expansion: b,
	}),
	variant("merge_gate_predicate", {
		candidate_head: s,
		reviewed_head_is_tip: b,
		gates: Type.Array(obj({ name: s, status: s, head: s }), { maxItems: 4096 }),
		review: obj({ provider: ns, status: s, bugs: nn, rules: nn, comment_id: ns, head: ns }),
		open_threads: Type.Array(obj({ id: s, head: s, resolved_by: ns, covered_by_ticket_regression: nb }), {
			maxItems: 4096,
		}),
		provenance: obj({ signed: b, base_main_proof: ns }),
		owner_hold: nb,
		owner_waiver: nullable(obj({ scope: obj({ candidate_head: s, review_head: s }), record: s })),
	}),
	variant("build_host", {
		portable: b,
		platform_specific_proof: ns,
		candidate_fingerprint: s,
		hosts: Type.Array(obj({ host: s, slot: s, free: b, staged_workspace: nb, warm_cache: nb, receipt_age_s: nn }), {
			maxItems: 4096,
		}),
		forbidden_replay_of: ns,
	}),
	variant("review_posting", {
		request_command_exit: exit,
		returned_comment_id: ns,
		url: ns,
		posted_at: ns,
		run_status: s,
		status_check_vs_comment_contradiction: nb,
		manual_request_exists: nb,
	}),
	variant("trivial_fix_eligible", {
		changed_files: n,
		changed_lines: n,
		hunks: n,
		compiler_message: ns,
		semantic_categories_touched: Type.Array(
			Type.Union(
				(["logic", "error_semantics", "persistence", "security", "concurrency", "abi", "tests"] as const).map((v) =>
					Type.Literal(v),
				),
			),
			{ maxItems: 7 },
		),
		cap_exhausted: b,
		prior_rounds: n,
	}),
	variant("review_tier", {
		changed_files: n,
		changed_lines: n,
		hunks: n,
		seams_touched: Type.Array(
			Type.Union(
				(
					["custody", "auth", "persistence", "migration", "crypto", "concurrency", "abi", "public_api"] as const
				).map((v) => Type.Literal(v)),
			),
			{ maxItems: 8 },
		),
		blueprint_risk_tag: ns,
		prior_bot_findings: n,
		test_delta: obj({ added: n, removed: n }),
		docs_only: b,
		choice: Type.Union([
			Type.Literal("bots_only"),
			Type.Literal("grok"),
			Type.Literal("grok_plus_muse"),
			Type.Literal("grok_plus_muse_plus_opus"),
		]),
	}),
	variant("admission_priority", {
		lane: s,
		ready_actions: Type.Array(obj({ id: s, ticket: s, critical_path_len: n, blocked_dependents: n, slot_fit: b }), {
			maxItems: 4096,
		}),
		free_slots: Type.Array(obj({ host: s, slot: s }), { maxItems: 4096 }),
		lane_digest_sha: s,
	}),
]);
export type FactoryDecision = Static<typeof FactoryDecisionSchema>;
export type DecisionOf<T extends FactoryDecision["type"]> = Extract<FactoryDecision, { type: T }>;
export type DecisionBase = Pick<FactoryDecision, keyof typeof common>;
export type DecisionRecorder = (decision: FactoryDecision) => void;
export interface AdapterDecisionContext {
	base: DecisionBase;
	attemptId: string;
	record: DecisionRecorder;
}
export interface DecisionInference {
	outcome: string;
	question_set: { version: string; sha256: string };
	jev?: {
		model: string;
		probability?: number;
		confidence?: number;
		probabilities?: Record<string, number>;
		usage: FactoryCallCost["usage"];
		wall_clock_ms: number;
	};
	advisor?: {
		model: string;
		effort: "medium";
		decision: string;
		confidence: number | null;
		reason: string;
		usage: FactoryCallCost["usage"];
		cost_usd: number | null;
		wall_clock_ms: number;
	};
}
export function decisionProfilesMatch(decision: FactoryDecision): boolean {
	return (
		decision.requested_profile === decision.served_profile ||
		(decision.decided_by === "jev" &&
			decision.requested_profile === "jev-latest" &&
			/^jev-\d+\.\d+\.\d+$/.test(decision.served_profile))
	);
}
export interface DecisionReceipt extends Partial<DecisionInference> {
	wall_clock_ms: number;
	request_id: string;
	source_request_id?: string;
	action_id: string;
	decision: FactoryDecision;
	applied: boolean;
	accounting: FactoryCallCost;
	predicate?: ReturnType<typeof mergeGatePredicate>;
}
export function validateDecision(value: unknown, type?: string): FactoryDecision {
	if (!Value.Check(FactoryDecisionSchema, value) || (type !== undefined && value.type !== type))
		throw new Error(`Invalid factory decision object for ${type ?? "unknown type"}`);
	const decision = structuredClone(value);
	if (decision.type === "review_tier" && decision.seams_touched.length) {
		decision.choice = "grok_plus_muse_plus_opus";
		decision.decided_by = "code";
	}
	if (decision.type === "merge_gate_predicate") decision.decided_by = "code";
	return decision;
}
export function codeDecisionBase(ledger_sequence: number, reason: string): DecisionBase {
	return {
		version: DECISION_VERSION,
		ledger_sequence,
		requested_profile: "code",
		served_profile: "code",
		decided_by: "code",
		probability_or_confidence: null,
		reason,
		usage: sumFactoryCosts([]).usage,
		cost_usd: 0,
		wall_clock_ms: 0,
	};
}
export function operatorDecisionBase(ledger_sequence: number, reason: string): DecisionBase {
	return {
		...codeDecisionBase(ledger_sequence, reason),
		requested_profile: "operator",
		served_profile: "operator",
		decided_by: "operator",
	};
}
export function mergeGatePredicate(d: DecisionOf<"merge_gate_predicate">): {
	result: boolean;
	failing_clauses: string[];
} {
	const clauses = {
		gates_on_tip: d.gates.length > 0 && d.gates.every((g) => g.status === "green" && g.head === d.candidate_head),
		external_review_on_tip:
			d.reviewed_head_is_tip &&
			d.review.head === d.candidate_head &&
			d.review.status === "completed" &&
			!!d.review.provider &&
			!["code", "operator"].includes(d.review.provider),
		review_comment_id: !!d.review.comment_id,
		findings_resolved:
			d.review.bugs === 0 &&
			d.review.rules === 0 &&
			d.open_threads.every(
				(t) => t.head === d.candidate_head && (!!t.resolved_by || t.covered_by_ticket_regression === true),
			),
		provenance_bound: d.provenance.signed && !!d.provenance.base_main_proof,
		no_owner_hold: d.owner_hold === false,
	};
	const failing_clauses = Object.entries(clauses)
		.filter(([, pass]) => !pass)
		.map(([name]) => name);
	const waived =
		!!d.owner_waiver?.record.trim() &&
		d.owner_waiver.scope.candidate_head === d.candidate_head &&
		d.owner_waiver.scope.review_head === d.review.head;
	const reviewClauses = ["external_review_on_tip", "review_comment_id", "findings_resolved"];
	return {
		result: failing_clauses.every((clause) => waived && reviewClauses.includes(clause)),
		failing_clauses,
	};
}
export function recordDecision(
	store: FactoryStore,
	actionId: string,
	value: FactoryDecision,
	options: {
		requestId?: string;
		sourceRequestId?: string;
		apply?: () => void;
		applied?: boolean;
		staleCheck?: boolean;
		inference?: DecisionInference;
		accounting?: FactoryCallCost;
		requireCurrent?: () => void;
	} = {},
): DecisionReceipt {
	const decision = validateDecision(value);
	const requestId = options.requestId ?? randomUUID();
	if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) throw new Error("Invalid decision request id");
	return store.commitTypedDecision(
		actionId,
		decision,
		requestId,
		options.staleCheck !== false,
		() => {
			options.requireCurrent?.();
			if (options.inference?.outcome === "DEFERRED" && (options.apply || options.applied))
				throw new Error("A deferred typed decision cannot be applied");
			const drift = !decisionProfilesMatch(decision);
			if (!drift) options.apply?.();
			const receipt: DecisionReceipt = {
				...options.inference,
				wall_clock_ms: decision.wall_clock_ms,
				request_id: requestId,
				...(options.sourceRequestId ? { source_request_id: options.sourceRequestId } : {}),
				action_id: actionId,
				decision,
				applied: !drift && (options.applied === true || !!options.apply),
				accounting: options.accounting ?? {
					calls: ["jev", "advisor"].includes(decision.decided_by) ? 1 : 0,
					usage: decision.usage,
					cost_usd: decision.cost_usd,
					priced: decision.cost_usd !== null,
				},
				...(decision.type === "merge_gate_predicate" ? { predicate: mergeGatePredicate(decision) } : {}),
			};
			const directory = join(store.directory, "decisions", requestId);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const path = join(directory, "decision.json");
			save(path, { ...receipt, applied: false });
			if (receipt.applied) store.afterDecisionCommit(() => publishAppliedReceipt(path, receipt));
			return receipt;
		},
		value.decided_by,
	);
}

export function decideTyped(
	store: FactoryStore,
	actionId: string,
	value: unknown,
	type: string,
	apply = false,
): DecisionReceipt {
	const decision = validateDecision(value, type);
	if (apply && decision.decided_by === "none") throw new Error("An undecided object cannot be applied");
	const transition = () => {
		if (store.isPaused()) throw new Error("Factory is paused; decisions are blocked");
		const attempt = store
			.attempts()
			.filter((a) => a.actionId === actionId)
			.at(-1);
		const evidence = {
			actor: decision.decided_by,
			reason: decision.reason,
			ref: `factory:typed:${actionId}:${decision.ledger_sequence}`,
		};
		if (decision.type === "attempt_requeue") {
			if (
				decision.decided_by !== "operator" ||
				decision.census.matches !== 0 ||
				decision.census.unreadable !== false ||
				decision.equivalent_job ||
				decision.successor ||
				decision.claim_released ||
				decision.receipt_present ||
				decision.core_state !== "UNCERTAIN" ||
				attempt?.id !== decision.attempt_id
			)
				throw new Error(
					"Typed requeue requires operator evidence of stopped custody and no equivalent job or successor",
				);
			store.resolveForRetry(decision.attempt_id, evidence);
		} else if (decision.type === "writer_terminal_accept" || decision.type === "test_gate_accept") {
			const action = store.actions().find((a) => a.id === actionId);
			if (
				attempt?.id !== decision.attempt_id ||
				!attempt.receipt ||
				action?.sourceFingerprint !== decision.candidate_fingerprint ||
				attempt.receipt.sourceFingerprint !== decision.receipt_fingerprint ||
				attempt.receipt.exitCode !== decision.exit_code
			)
				throw new Error("Typed acceptance does not match the current terminal receipt");
			const accepted =
				decision.type === "writer_terminal_accept"
					? decision.exit_code === 0 &&
						decision.agent_end === true &&
						decision.stop_reason === "stop" &&
						decision.allowed_paths_only === true &&
						decision.receipt_ready &&
						decision.receipt_sha === createHash("sha256").update(JSON.stringify(attempt.receipt)).digest("hex")
					: decision.exit_code === 0 &&
						decision.wrapper_rc === 0 &&
						decision.provenance_pass === true &&
						decision.source_unchanged === true &&
						decision.is_replay === false &&
						decision.tests.failed === 0 &&
						decision.tests.run !== null &&
						decision.criteria.min_tests !== null &&
						decision.tests.run >= decision.criteria.min_tests;
			if (!accepted) throw new Error("Typed acceptance criteria are not satisfied");
			store.decide(actionId, "accept", evidence, undefined, attempt.id);
		} else throw new Error(`No direct state transition for ${decision.type}`);
	};
	return recordDecision(store, actionId, value as FactoryDecision, { ...(apply ? { apply: transition } : {}) });
}
