import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ManagementClaim, ManagementReconciliation, ManagementRequest, ManagementResult } from "./management.js";
import type {
	ActionRecord,
	ActionSpec,
	ActionWithdrawal,
	AttemptContext,
	AttemptRecord,
	CompletionReceipt,
	DecisionEvidence,
	FactoryEvent,
	FactoryPlan,
	FactoryStatus,
	NonRetrySettlement,
	PlanMutationReceipt,
	SlotSpec,
	TicketRecord,
	WakeRecord,
} from "./types.js";

type Row = Record<string, unknown>;
const SCHEMA_VERSION = 1;
const now = (): string => new Date().toISOString();
function decode<T>(value: unknown): T {
	return JSON.parse(String(value)) as T;
}
function required(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
}
function evidenceValid(evidence: DecisionEvidence): void {
	required(evidence.actor, "evidence.actor");
	required(evidence.reason, "evidence.reason");
	required(evidence.ref, "evidence.ref");
}
function settlementProof(proof: { ref: string; sha256: string }): string {
	if (!proof || typeof proof.ref !== "string" || !isAbsolute(proof.ref) || !/^[a-f0-9]{64}$/.test(proof.sha256))
		throw new Error("Settlement proof requires an absolute artifact path and SHA-256");
	const stat = statSync(proof.ref);
	if (!stat.isFile() || stat.size > 1000000)
		throw new Error("Settlement artifacts must be regular files of at most 1000000 bytes");
	const bytes = readFileSync(proof.ref);
	if (bytes.length > 1000000 || createHash("sha256").update(bytes).digest("hex") !== proof.sha256)
		throw new Error(`Settlement artifact hash mismatch: ${proof.ref}`);
	return bytes.toString("utf8");
}
/** Checks operator-supplied evidence, not remote process liveness. Missing PID or timeout alone is not proof. */
function verifySettlement(settlement: NonRetrySettlement): void {
	if (!settlement || settlement.version !== 1) throw new Error("Invalid no-retry settlement");
	for (const key of [
		"actionId",
		"attemptId",
		"ticketOwner",
		"slotId",
		"host",
		"cwd",
		"sourceFingerprint",
		"processIdentity",
		"uncertainty",
	] as const)
		required(settlement[key], `settlement.${key}`);
	const { custody, artifacts, ...binding } = settlement;
	if (
		!custody ||
		custody.supervisorStopped !== true ||
		custody.processGroupStopped !== true ||
		custody.cannotExecute !== true ||
		typeof custody.observedAt !== "string" ||
		!Number.isFinite(Date.parse(custody.observedAt))
	)
		throw new Error("Settlement requires proven stopped execution custody; UNKNOWN is not safe");
	const receipt = decode<Record<string, unknown>>(settlementProof(custody));
	const { ref: _ref, sha256: _sha256, ...facts } = custody;
	if (!isDeepStrictEqual(receipt, { ...binding, ...facts }))
		throw new Error("Settlement custody receipt does not match the exact attempt and ownership");
	if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 8)
		throw new Error("Preserve one to eight settlement evidence artifacts");
	if (new Set(artifacts.map((artifact) => artifact.ref)).size !== artifacts.length)
		throw new Error("Settlement artifact refs must be unique");
	for (const artifact of artifacts) settlementProof(artifact);
}
function actionSpec(action: ActionSpec): ActionSpec {
	return {
		id: action.id,
		description: action.description,
		acceptanceCriteria: action.acceptanceCriteria ? [...action.acceptanceCriteria] : undefined,
		ticketId: action.ticketId,
		dependencies: [...action.dependencies],
		sourceFingerprint: action.sourceFingerprint,
		kind: action.kind,
		command: {
			...action.command,
			argv: [...action.command.argv],
			cwd: resolve(action.command.cwd),
			env: action.command.env ? { ...action.command.env } : undefined,
		},
		requirements: { ...action.requirements },
	};
}
function validatePlan(plan: FactoryPlan): void {
	if (plan.version !== 1 || !Array.isArray(plan.tickets) || !Array.isArray(plan.actions) || !Array.isArray(plan.slots))
		throw new Error("Invalid factory plan version or collections");
	for (const [name, entries] of [
		["ticket", plan.tickets],
		["action", plan.actions],
		["slot", plan.slots],
	] as const) {
		const ids = new Set<string>();
		for (const entry of entries) {
			required(entry.id, `${name}.id`);
			if (ids.has(entry.id)) throw new Error(`Duplicate ${name}: ${entry.id}`);
			ids.add(entry.id);
		}
	}
	for (const ticket of plan.tickets) required(ticket.owner, "ticket.owner");
	for (const slot of plan.slots) {
		required(slot.host, "slot.host");
		if (
			slot.capabilities !== undefined &&
			(!Array.isArray(slot.capabilities) || slot.capabilities.some((c) => typeof c !== "string"))
		)
			throw new Error("Invalid slot capabilities");
	}
	for (const action of plan.actions) {
		if (
			action.description !== undefined &&
			(typeof action.description !== "string" || !action.description.trim() || action.description.length > 16000)
		)
			throw new Error("Invalid action description");
		if (
			action.acceptanceCriteria !== undefined &&
			(!Array.isArray(action.acceptanceCriteria) ||
				action.acceptanceCriteria.length > 64 ||
				action.acceptanceCriteria.some(
					(criterion) => typeof criterion !== "string" || !criterion.trim() || criterion.length > 4000,
				))
		)
			throw new Error("Invalid acceptance criteria");
		required(action.ticketId, "action.ticketId");
		required(action.sourceFingerprint, "action.sourceFingerprint");
		if (action.kind !== "process" && action.kind !== "decision") throw new Error("Invalid action kind");
		if (!Array.isArray(action.dependencies) || action.dependencies.some((d) => typeof d !== "string"))
			throw new Error("Invalid action dependencies");
		if (new Set(action.dependencies).size !== action.dependencies.length)
			throw new Error("Duplicate action dependency");
		if (!action.command || !Array.isArray(action.command.argv) || !action.command.argv.length)
			throw new Error("Command argv is required");
		for (const arg of action.command.argv)
			if (typeof arg !== "string") throw new Error("Command argv must contain strings");
		required(action.command.argv[0], "command executable");
		required(action.command.cwd, "command.cwd");
		if (!isAbsolute(action.command.cwd)) throw new Error("command.cwd must be absolute");
		if (
			action.command.timeoutMs !== undefined &&
			(!Number.isSafeInteger(action.command.timeoutMs) || action.command.timeoutMs <= 0)
		)
			throw new Error("Invalid command timeoutMs");
		if (
			action.command.env !== undefined &&
			(!action.command.env ||
				typeof action.command.env !== "object" ||
				Array.isArray(action.command.env) ||
				Object.entries(action.command.env).some(
					([name, value]) =>
						!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0"),
				))
		)
			throw new Error("Invalid command env: expected variable names and string values without NUL");
		if (!action.requirements || typeof action.requirements !== "object")
			throw new Error("Action requirements are required");
		if (action.requirements.host !== undefined) required(action.requirements.host, "requirements.host");
		if (action.requirements.slotId !== undefined) required(action.requirements.slotId, "requirements.slotId");
		if (
			action.requirements.capabilities !== undefined &&
			(!Array.isArray(action.requirements.capabilities) ||
				action.requirements.capabilities.some((c) => typeof c !== "string"))
		)
			throw new Error("Invalid action capabilities");
	}
}

/** A short-transaction journal. No process, session, model or transport is owned here. */
export class FactoryStore {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
		);
		try {
			this.transaction(() => {
				this.db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
				const version = this.meta("schema_version");
				if (version !== undefined && Number(version) !== SCHEMA_VERSION)
					throw new Error(`Unsupported factory schema version ${version}`);
				this.db.exec(`
					CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL);
					CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, spec TEXT NOT NULL);
					CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), spec TEXT NOT NULL, state TEXT NOT NULL);
					CREATE TABLE IF NOT EXISTS dependencies (action_id TEXT NOT NULL REFERENCES actions(id), dependency_id TEXT NOT NULL REFERENCES actions(id), PRIMARY KEY(action_id,dependency_id));
					CREATE INDEX IF NOT EXISTS dependencies_reverse ON dependencies(dependency_id);
					CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), slot_id TEXT NOT NULL REFERENCES slots(id), state TEXT NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT, process_identity TEXT, receipt TEXT, uncertainty TEXT, claim_released INTEGER NOT NULL DEFAULT 0);
					CREATE UNIQUE INDEX IF NOT EXISTS attempts_action_claim ON attempts(action_id) WHERE claim_released=0;
					CREATE UNIQUE INDEX IF NOT EXISTS attempts_slot_claim ON attempts(slot_id) WHERE claim_released=0;
					CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, action_id TEXT, attempt_id TEXT, detail TEXT NOT NULL);
					CREATE TABLE IF NOT EXISTS wakes (id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, attempt_id TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
					CREATE UNIQUE INDEX IF NOT EXISTS wakes_attempt_open ON wakes(attempt_id) WHERE resolved_at IS NULL;
					CREATE TABLE IF NOT EXISTS management_requests (id TEXT PRIMARY KEY, wake_id INTEGER NOT NULL REFERENCES wakes(id), action_id TEXT NOT NULL, attempt_id TEXT NOT NULL, plan_revision INTEGER NOT NULL, evidence_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT, UNIQUE(wake_id,plan_revision,attempt_id,evidence_sha256));
					CREATE UNIQUE INDEX IF NOT EXISTS management_wake_inflight ON management_requests(wake_id) WHERE state='CLAIMED';
					CREATE TABLE IF NOT EXISTS plan_mutations (id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL, previous_revision INTEGER NOT NULL, revision INTEGER NOT NULL);
				`);
				this.setMeta("schema_version", String(SCHEMA_VERSION));
				if (this.meta("plan_revision") === undefined) this.setMeta("plan_revision", "0");
				if (this.meta("paused") === undefined) this.setMeta("paused", "false");
			});
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	close(): void {
		this.db.close();
	}
	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = fn();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private meta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key);
		return row ? String(row.value) : undefined;
	}
	private setMeta(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, value);
	}
	private event(
		kind: string,
		actionId: string | null,
		attemptId: string | null,
		detail: Record<string, unknown> = {},
	): void {
		this.db
			.prepare("INSERT INTO events(at,kind,action_id,attempt_id,detail) VALUES(?,?,?,?,?)")
			.run(now(), kind, actionId, attemptId, JSON.stringify(detail));
	}
	isPaused(): boolean {
		return this.meta("paused") === "true";
	}
	pause(reason: string): void {
		required(reason, "pause reason");
		this.transaction(() => {
			this.setMeta("paused", "true");
			this.setMeta("pause_reason", reason);
			this.event("paused", null, null, { reason });
		});
	}
	resume(): void {
		this.transaction(() => {
			this.setMeta("paused", "false");
			this.setMeta("pause_reason", "");
			this.event("resumed", null, null);
		});
	}
	/** Add/upsert a plan; omitted records remain. Started actions and all source fingerprints are immutable. */
	applyPlan(plan: FactoryPlan, expectedRevision?: number, mutationId?: string): number {
		validatePlan(plan);
		if (mutationId !== undefined) {
			required(mutationId, "mutationId");
			if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0)
				throw new Error("A mutationId requires an explicit expected plan revision");
		}
		const payloadSha256 = createHash("sha256").update(JSON.stringify({ plan, expectedRevision })).digest("hex");
		return this.transaction(() => {
			if (mutationId !== undefined) {
				const prior = this.planMutation(mutationId);
				if (prior) {
					if (prior.payloadSha256 !== payloadSha256)
						throw new Error("Plan mutation identity reused for a different payload");
					return prior.revision;
				}
			}
			if (this.isPaused()) throw new Error("Factory is paused; plan changes are blocked");
			const revision = Number(this.meta("plan_revision"));
			if (expectedRevision !== undefined && revision !== expectedRevision)
				throw new Error("Factory plan revision changed");
			const existing = this.actions();
			const unchanged =
				revision > 0 &&
				plan.actions.every((action) =>
					existing.some((old) => isDeepStrictEqual(actionSpec(old), actionSpec(action))),
				) &&
				plan.tickets.every((ticket) =>
					this.tickets().some((old) => old.id === ticket.id && old.owner === ticket.owner),
				) &&
				plan.slots.every((slot) => this.slots().some((old) => isDeepStrictEqual(old, slot))) &&
				(plan.roles === undefined ||
					isDeepStrictEqual(plan.roles, decode<FactoryPlan["roles"]>(this.meta("roles") ?? "{}")));
			const recordMutation = (nextRevision: number): void => {
				if (mutationId !== undefined)
					this.db
						.prepare("INSERT INTO plan_mutations(id,payload_sha256,previous_revision,revision) VALUES(?,?,?,?)")
						.run(mutationId, payloadSha256, revision, nextRevision);
			};
			if (unchanged) {
				recordMutation(revision);
				return revision;
			}
			this.requireManagementDrained();
			const invalidatedWakeIds = this.wakes()
				.filter((wake) => wake.resolvedAt === null)
				.map((wake) => wake.id);
			const superseded = new Set(
				existing.filter((action) => action.state === "SUPERSEDED").map((action) => action.id),
			);
			const combined = new Map(existing.map((a) => [a.id, actionSpec(a)]));
			for (const action of plan.actions) combined.set(action.id, actionSpec(action));
			const tickets = new Set([...this.tickets().map((t) => t.id), ...plan.tickets.map((t) => t.id)]);
			const visiting = new Set<string>();
			const visited = new Set<string>();
			const visit = (id: string): void => {
				if (visiting.has(id)) throw new Error("Factory dependencies contain a cycle");
				if (visited.has(id)) return;
				const action = combined.get(id);
				if (!action) throw new Error(`Unknown dependency ${id}`);
				if (!tickets.has(action.ticketId)) throw new Error(`Unknown ticket ${action.ticketId}`);
				visiting.add(id);
				for (const dependency of action.dependencies) {
					if (superseded.has(dependency))
						throw new Error(`Dependency ${dependency} is superseded; reference its replacement`);
					visit(dependency);
				}
				visiting.delete(id);
				visited.add(id);
			};
			for (const id of combined.keys()) visit(id);
			for (const action of plan.actions) {
				const old = existing.find((a) => a.id === action.id);
				if (!old) continue;
				if (old.sourceFingerprint !== action.sourceFingerprint)
					throw new Error(`Source fingerprint is immutable: ${action.id}`);
				if (!isDeepStrictEqual(actionSpec(old), actionSpec(action))) {
					const submitted = this.db
						.prepare("SELECT id FROM attempts WHERE action_id=? AND submitted_at IS NOT NULL LIMIT 1")
						.get(action.id);
					if ((old.state !== "QUEUED" && old.state !== "READY") || submitted)
						throw new Error(`Started action is immutable: ${action.id}`);
				}
			}
			for (const ticket of plan.tickets)
				this.db
					.prepare(
						"INSERT INTO tickets(id,owner,state) VALUES(?,?,'ACTIVE') ON CONFLICT(id) DO UPDATE SET owner=excluded.owner",
					)
					.run(ticket.id, ticket.owner);
			for (const slot of plan.slots) {
				const old = this.db.prepare("SELECT spec FROM slots WHERE id=?").get(slot.id);
				if (
					old &&
					!isDeepStrictEqual(decode<SlotSpec>(old.spec), slot) &&
					this.db.prepare("SELECT id FROM attempts WHERE slot_id=? AND claim_released=0").get(slot.id)
				)
					throw new Error(`Claimed slot is immutable: ${slot.id}`);
				this.db
					.prepare("INSERT INTO slots(id,spec) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec")
					.run(slot.id, JSON.stringify(slot));
			}
			for (const action of plan.actions)
				this.db
					.prepare(
						"INSERT INTO actions(id,ticket_id,spec,state) VALUES(?,?,?,'QUEUED') ON CONFLICT(id) DO UPDATE SET ticket_id=excluded.ticket_id,spec=excluded.spec",
					)
					.run(action.id, action.ticketId, JSON.stringify(actionSpec(action)));
			for (const action of plan.actions) {
				this.db.prepare("DELETE FROM dependencies WHERE action_id=?").run(action.id);
				for (const dependency of action.dependencies)
					this.db
						.prepare("INSERT INTO dependencies(action_id,dependency_id) VALUES(?,?)")
						.run(action.id, dependency);
			}
			if (plan.roles !== undefined) this.setMeta("roles", JSON.stringify(plan.roles));
			this.setMeta("plan_revision", String(revision + 1));
			this.refreshReadiness();
			recordMutation(revision + 1);
			this.event("plan_applied", null, null, {
				previousRevision: revision,
				revision: revision + 1,
				actions: plan.actions.length,
				invalidatedWakeIds,
				mutationId: mutationId ?? null,
			});
			return revision + 1;
		});
	}
	private refreshReadiness(): void {
		const pending = this.db.prepare("SELECT id,state FROM actions WHERE state IN ('QUEUED','READY')").all();
		for (const action of pending) {
			const blocked = this.db
				.prepare(
					"SELECT 1 FROM dependencies d JOIN actions a ON a.id=d.dependency_id WHERE d.action_id=? AND a.state!='ACCEPTED' LIMIT 1",
				)
				.get(String(action.id));
			const state = blocked ? "QUEUED" : "READY";
			if (action.state !== state) {
				this.db.prepare("UPDATE actions SET state=? WHERE id=?").run(state, String(action.id));
				this.event("action_ready_changed", String(action.id), null, { state });
			}
		}
		// Recompute downstream readiness first. Retiring an owner never removes dependency records.
		for (const ticket of this.tickets()) {
			const hasWork = this.db.prepare("SELECT 1 FROM actions WHERE ticket_id=? LIMIT 1").get(ticket.id);
			const pendingWork = this.db
				.prepare("SELECT 1 FROM actions WHERE ticket_id=? AND state NOT IN ('ACCEPTED','SUPERSEDED') LIMIT 1")
				.get(ticket.id);
			const state = hasWork && !pendingWork ? "RETIRED" : "ACTIVE";
			if (ticket.state !== state) {
				this.db.prepare("UPDATE tickets SET state=? WHERE id=?").run(state, ticket.id);
				this.event("ticket_state_changed", null, null, { ticketId: ticket.id, state });
			}
		}
	}
	actions(): ActionRecord[] {
		return this.db
			.prepare("SELECT spec,state FROM actions ORDER BY rowid")
			.all()
			.map((r) => ({ ...decode<ActionSpec>(r.spec), state: String(r.state) as ActionRecord["state"] }));
	}
	tickets(): TicketRecord[] {
		return this.db
			.prepare("SELECT id,owner,state FROM tickets ORDER BY rowid")
			.all()
			.map((r) => ({ id: String(r.id), owner: String(r.owner), state: String(r.state) as TicketRecord["state"] }));
	}
	slots(): SlotSpec[] {
		return this.db
			.prepare("SELECT spec FROM slots ORDER BY rowid")
			.all()
			.map((r) => decode<SlotSpec>(r.spec));
	}
	private attemptRecord(r: Row): AttemptRecord {
		return {
			id: String(r.id),
			actionId: String(r.action_id),
			slotId: String(r.slot_id),
			state: String(r.state) as AttemptRecord["state"],
			createdAt: String(r.created_at),
			submittedAt: r.submitted_at === null ? null : String(r.submitted_at),
			processIdentity: r.process_identity === null ? null : String(r.process_identity),
			receipt: r.receipt === null ? null : decode<CompletionReceipt>(r.receipt),
			uncertainty: r.uncertainty === null ? null : String(r.uncertainty),
			claimReleased: Number(r.claim_released) === 1,
		};
	}
	attempts(activeOnly = false): AttemptRecord[] {
		return this.db
			.prepare(`SELECT * FROM attempts ${activeOnly ? "WHERE claim_released=0" : ""} ORDER BY rowid`)
			.all()
			.map((r) => this.attemptRecord(r));
	}
	private action(id: string): ActionRecord | undefined {
		const row = this.db.prepare("SELECT spec,state FROM actions WHERE id=?").get(id);
		return row ? { ...decode<ActionSpec>(row.spec), state: String(row.state) as ActionRecord["state"] } : undefined;
	}
	private slot(id: string): SlotSpec | undefined {
		const row = this.db.prepare("SELECT spec FROM slots WHERE id=?").get(id);
		return row ? decode<SlotSpec>(row.spec) : undefined;
	}
	context(attemptId: string): AttemptContext {
		const row = this.db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId);
		if (!row) throw new Error(`Unknown attempt ${attemptId}`);
		const attempt = this.attemptRecord(row);
		const action = this.action(attempt.actionId);
		const slot = this.slot(attempt.slotId);
		if (!action || !slot) throw new Error("Corrupt factory attempt references");
		return { attempt, action, slot };
	}
	/** Atomically claims action, slot and declared host/cwd. Paths are lexical identities, not symlink resolution. */
	claim(actionId: string, slotId: string): AttemptContext | undefined {
		return this.transaction(() => {
			if (this.isPaused()) return undefined;
			const action = this.action(actionId);
			const slot = this.slot(slotId);
			if (!action || !slot || action.state !== "READY") return undefined;
			if (
				(action.requirements.host && action.requirements.host !== slot.host) ||
				(action.requirements.slotId && action.requirements.slotId !== slot.id) ||
				action.requirements.capabilities?.some((c) => !slot.capabilities?.includes(c))
			)
				return undefined;
			if (
				this.db
					.prepare("SELECT id FROM attempts WHERE (action_id=? OR slot_id=?) AND claim_released=0 LIMIT 1")
					.get(actionId, slotId)
			)
				return undefined;
			if (
				this.db
					.prepare(`
				SELECT 1 FROM attempts p JOIN actions a ON a.id=p.action_id JOIN slots s ON s.id=p.slot_id
				WHERE p.claim_released=0 AND json_extract(s.spec,'$.host')=? AND json_extract(a.spec,'$.command.cwd')=? LIMIT 1
			`)
					.get(slot.host, action.command.cwd)
			)
				return undefined;
			const id = randomUUID();
			this.db
				.prepare("INSERT INTO attempts(id,action_id,slot_id,state,created_at) VALUES(?,?,?,'PREPARED',?)")
				.run(id, actionId, slotId, now());
			this.db.prepare("UPDATE actions SET state='RUNNING' WHERE id=?").run(actionId);
			this.event("attempt_prepared", actionId, id, { slotId });
			return this.context(id);
		});
	}
	markSubmitted(attemptId: string): boolean {
		return this.transaction(() => {
			if (this.isPaused()) return false;
			const result = this.db
				.prepare(
					"UPDATE attempts SET state='SUBMITTED',submitted_at=? WHERE id=? AND state='PREPARED' AND claim_released=0",
				)
				.run(now(), attemptId);
			if (!result.changes) return false;
			this.event("attempt_submitted", this.context(attemptId).action.id, attemptId);
			return true;
		});
	}
	/** Only an intent which was never submitted can be abandoned without external evidence. */
	abandonPrepared(attemptId: string): boolean {
		return this.transaction(() => {
			const result = this.db
				.prepare(
					"UPDATE attempts SET state='ABANDONED',claim_released=1 WHERE id=? AND state='PREPARED' AND submitted_at IS NULL AND claim_released=0",
				)
				.run(attemptId);
			if (!result.changes) return false;
			const { action } = this.context(attemptId);
			this.db.prepare("UPDATE actions SET state='QUEUED' WHERE id=?").run(action.id);
			this.event("prepared_abandoned", action.id, attemptId);
			this.refreshReadiness();
			return true;
		});
	}
	markRunning(attemptId: string, processIdentity: string): void {
		required(processIdentity, "process identity");
		this.transaction(() => {
			const { attempt, action } = this.context(attemptId);
			if (attempt.claimReleased || attempt.state === "PREPARED") return;
			if (attempt.processIdentity && attempt.processIdentity !== processIdentity) {
				this.uncertainInternal(attemptId, "Process identity changed during reconciliation");
				return;
			}
			if (attempt.state === "RUNNING" && attempt.processIdentity === processIdentity) return;
			this.db
				.prepare("UPDATE attempts SET state='RUNNING',process_identity=?,uncertainty=NULL WHERE id=?")
				.run(processIdentity, attemptId);
			this.db.prepare("UPDATE actions SET state='RUNNING' WHERE id=?").run(action.id);
			this.resolveWakes(attemptId);
			this.event("attempt_running", action.id, attemptId, { processIdentity });
		});
	}
	private uncertainInternal(attemptId: string, reason: string): void {
		const { attempt, action } = this.context(attemptId);
		if (attempt.claimReleased || attempt.state === "PREPARED") return;
		if (attempt.state === "UNCERTAIN" && attempt.uncertainty === reason) return;
		this.db.prepare("UPDATE attempts SET state='UNCERTAIN',uncertainty=? WHERE id=?").run(reason, attemptId);
		this.db.prepare("UPDATE actions SET state='UNCERTAIN' WHERE id=?").run(action.id);
		this.db
			.prepare("INSERT OR IGNORE INTO wakes(action_id,attempt_id,reason,created_at) VALUES(?,?,?,?)")
			.run(action.id, attemptId, reason, now());
		this.event("attempt_uncertain", action.id, attemptId, { reason });
	}
	markUncertain(attemptId: string, reason: string): void {
		required(reason, "uncertainty reason");
		this.transaction(() => this.uncertainInternal(attemptId, reason));
	}
	private resolveWakes(attemptId: string): void {
		this.db
			.prepare("UPDATE wakes SET resolved_at=? WHERE attempt_id=? AND resolved_at IS NULL")
			.run(now(), attemptId);
	}
	complete(receipt: CompletionReceipt): boolean {
		let conflict = false;
		const changed = this.transaction(() => {
			const { attempt, action } = this.context(receipt.attemptId);
			if (attempt.state === "TERMINAL" && !isDeepStrictEqual(attempt.receipt, receipt)) {
				const reason = "Conflicting terminal receipt";
				this.event("terminal_receipt_conflict", action.id, attempt.id, { reason, receipt });
				this.db
					.prepare("INSERT OR IGNORE INTO wakes(action_id,attempt_id,reason,created_at) VALUES(?,?,?,?)")
					.run(action.id, attempt.id, reason, now());
				this.setMeta("paused", "true");
				this.setMeta("pause_reason", `${reason}: ${attempt.id}`);
				conflict = true;
				return false;
			}
			if (receipt.sourceFingerprint !== action.sourceFingerprint)
				throw new Error("Receipt source fingerprint mismatch");
			required(receipt.finishedAt, "receipt.finishedAt");
			if (
				Number.isNaN(Date.parse(receipt.finishedAt)) ||
				(receipt.exitCode !== null && !Number.isInteger(receipt.exitCode))
			)
				throw new Error("Invalid terminal receipt");
			if (receipt.artifact) {
				required(receipt.artifact.ref, "artifact.ref");
				required(receipt.artifact.sourceFingerprint, "artifact.sourceFingerprint");
			}
			if (attempt.state === "TERMINAL") {
				if (!isDeepStrictEqual(attempt.receipt, receipt)) throw new Error("Conflicting terminal receipt");
				return false;
			}
			if (attempt.claimReleased || attempt.state === "PREPARED")
				throw new Error("Cannot complete an unsubmitted or abandoned attempt");
			this.db
				.prepare("UPDATE attempts SET state='TERMINAL',receipt=?,claim_released=1,uncertainty=NULL WHERE id=?")
				.run(JSON.stringify(receipt), attempt.id);
			const state =
				action.kind === "decision" ? "AWAITING_DECISION" : receipt.exitCode === 0 ? "ACCEPTED" : "REJECTED";
			this.db.prepare("UPDATE actions SET state=? WHERE id=?").run(state, action.id);
			this.resolveWakes(attempt.id);
			this.event("attempt_terminal", action.id, attempt.id, {
				exitCode: receipt.exitCode,
				state,
				artifactRef: receipt.artifact?.ref ?? null,
			});
			if (state !== "ACCEPTED")
				this.db
					.prepare("INSERT INTO wakes(action_id,attempt_id,reason,created_at) VALUES(?,?,?,?)")
					.run(
						action.id,
						attempt.id,
						state === "AWAITING_DECISION" ? "Semantic decision required" : "Process gate failed",
						now(),
					);
			this.refreshReadiness();
			return true;
		});
		if (conflict) throw new Error("Conflicting terminal receipt; factory paused for review");
		return changed;
	}
	decide(
		actionId: string,
		outcome: "accept" | "reject",
		evidence: DecisionEvidence,
		expectedRevision?: number,
		expectedAttemptId?: string,
		expectedWakeId?: number,
		expectedManagementRequestId?: string,
	): void {
		evidenceValid(evidence);
		this.transaction(() => {
			if (this.isPaused()) throw new Error("Factory is paused; decisions are blocked");
			if (expectedRevision !== undefined && Number(this.meta("plan_revision")) !== expectedRevision)
				throw new Error("Factory plan revision changed");
			const action = this.action(actionId);
			if (!action || action.state !== "AWAITING_DECISION" || action.kind !== "decision")
				throw new Error("Action is not awaiting a semantic decision");
			const latest = this.db
				.prepare("SELECT id,state FROM attempts WHERE action_id=? ORDER BY rowid DESC LIMIT 1")
				.get(actionId);
			if (
				!latest ||
				latest.state !== "TERMINAL" ||
				(expectedAttemptId !== undefined && latest.id !== expectedAttemptId)
			)
				throw new Error("Decision attempt changed");
			if (
				expectedWakeId !== undefined &&
				!this.db
					.prepare("SELECT 1 FROM wakes WHERE id=? AND action_id=? AND attempt_id=? AND resolved_at IS NULL")
					.get(expectedWakeId, actionId, String(latest.id))
			)
				throw new Error("Decision wake changed");
			if (expectedManagementRequestId !== undefined) {
				const request = this.db
					.prepare("SELECT id,state FROM management_requests WHERE wake_id=? ORDER BY rowid DESC LIMIT 1")
					.get(expectedWakeId ?? -1);
				if (request?.id !== expectedManagementRequestId || request.state !== "PROPOSED")
					throw new Error("Management evidence context changed");
				this.db
					.prepare("UPDATE management_requests SET state='APPLIED' WHERE id=?")
					.run(expectedManagementRequestId);
				this.event("management_applied", actionId, String(latest.id), { id: expectedManagementRequestId });
			}
			if (outcome !== "accept" && outcome !== "reject") throw new Error("Invalid decision outcome");
			this.db
				.prepare("UPDATE actions SET state=? WHERE id=?")
				.run(outcome === "accept" ? "ACCEPTED" : "REJECTED", actionId);
			this.db
				.prepare("UPDATE wakes SET resolved_at=? WHERE action_id=? AND resolved_at IS NULL")
				.run(now(), actionId);
			this.event("action_decided", actionId, String(latest.id), { outcome, ...evidence });
			this.refreshReadiness();
		});
	}
	/** Replace rejected or deliberately abandoned work explicitly, retaining history and updating only future dependencies. */
	supersede(actionId: string, replacementId: string, evidence: DecisionEvidence, expectedRevision?: number): number {
		evidenceValid(evidence);
		return this.transaction(() => {
			if (this.isPaused()) throw new Error("Factory is paused; supersession is blocked");
			const revision = Number(this.meta("plan_revision"));
			if (expectedRevision !== undefined && revision !== expectedRevision)
				throw new Error("Factory plan revision changed");
			this.requireManagementDrained();
			const invalidatedWakeIds = this.wakes()
				.filter((wake) => wake.resolvedAt === null && wake.actionId !== actionId)
				.map((wake) => wake.id);
			const old = this.action(actionId);
			const replacement = this.action(replacementId);
			if (!old || (old.state !== "REJECTED" && old.state !== "ABANDONED"))
				throw new Error("Only rejected or abandoned work may be superseded");
			if (old.state === "ABANDONED" && !Number.isSafeInteger(expectedRevision))
				throw new Error("An exact expected plan revision is required for abandoned supersession");
			if (
				!replacement ||
				replacement.id === old.id ||
				replacement.ticketId !== old.ticketId ||
				replacement.kind !== old.kind ||
				["REJECTED", "ABANDONED", "WITHDRAWN", "SUPERSEDED"].includes(replacement.state)
			)
				throw new Error("Replacement must be a distinct current action of the same ticket and kind");
			const actions = this.actions();
			const changed: ActionSpec[] = [];
			for (const action of actions) {
				if (!action.dependencies.includes(actionId)) continue;
				if (
					(action.state !== "QUEUED" && action.state !== "READY") ||
					this.db
						.prepare("SELECT 1 FROM attempts WHERE action_id=? AND submitted_at IS NOT NULL LIMIT 1")
						.get(action.id)
				)
					throw new Error("Cannot rewire a started dependent");
				action.dependencies = [...new Set(action.dependencies.map((id) => (id === actionId ? replacementId : id)))];
				changed.push(actionSpec(action));
			}
			const graph = new Map(actions.map((action) => [action.id, action]));
			const visiting = new Set<string>();
			const visited = new Set<string>();
			const visit = (id: string): void => {
				if (visiting.has(id)) throw new Error("Supersession would create a dependency cycle");
				if (visited.has(id)) return;
				visiting.add(id);
				for (const dependency of graph.get(id)?.dependencies ?? []) visit(dependency);
				visiting.delete(id);
				visited.add(id);
			};
			for (const id of graph.keys()) visit(id);
			for (const action of changed) {
				this.db.prepare("UPDATE actions SET spec=? WHERE id=?").run(JSON.stringify(action), action.id);
				this.db.prepare("DELETE FROM dependencies WHERE action_id=?").run(action.id);
				for (const dependency of action.dependencies)
					this.db
						.prepare("INSERT INTO dependencies(action_id,dependency_id) VALUES(?,?)")
						.run(action.id, dependency);
			}
			this.db.prepare("UPDATE actions SET state='SUPERSEDED' WHERE id=?").run(actionId);
			this.db
				.prepare("UPDATE wakes SET resolved_at=? WHERE action_id=? AND resolved_at IS NULL")
				.run(now(), actionId);
			this.setMeta("plan_revision", String(revision + 1));
			this.event("action_superseded", actionId, null, {
				replacementId,
				previousState: old.state,
				previousRevision: revision,
				revision: revision + 1,
				invalidatedWakeIds,
				...evidence,
			});
			this.refreshReadiness();
			return revision + 1;
		});
	}
	/** Operator attests the prior attempt cannot still execute. A deadline or missing PID is insufficient evidence. */
	resolveForRetry(attemptId: string, evidence: DecisionEvidence, expectedRevision?: number): void {
		evidenceValid(evidence);
		this.transaction(() => {
			if (this.isPaused()) throw new Error("Factory is paused; resolution is blocked");
			if (expectedRevision !== undefined && Number(this.meta("plan_revision")) !== expectedRevision)
				throw new Error("Factory plan revision changed");
			const { attempt, action } = this.context(attemptId);
			if (attempt.state !== "UNCERTAIN" || attempt.claimReleased)
				throw new Error("Only an uncertain claimed attempt may be resolved for retry");
			this.db.prepare("UPDATE attempts SET state='ABANDONED',claim_released=1 WHERE id=?").run(attemptId);
			this.db.prepare("UPDATE actions SET state='QUEUED' WHERE id=?").run(action.id);
			this.resolveWakes(attemptId);
			this.event("uncertainty_resolved_for_retry", action.id, attemptId, { ...evidence });
			this.refreshReadiness();
		});
	}
	/** Close uncertain work without retry or judgment. The attempt ID is the exactly-once settlement identity. */
	settleWithoutRetry(
		actionId: string,
		settlement: NonRetrySettlement,
		evidence: DecisionEvidence,
		expectedRevision: number,
	): boolean {
		evidenceValid(evidence);
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			settlement?.planRevision !== expectedRevision
		)
			throw new Error("An exact expected plan revision is required for settlement");
		if (settlement.actionId !== actionId) throw new Error("Settlement action identity mismatch");
		verifySettlement(settlement);
		const detail = { settlement, ...evidence, outcome: "UNKNOWN" };
		return this.transaction(() => {
			if (this.isPaused()) throw new Error("Factory is paused; settlement is blocked");
			const { attempt, action, slot } = this.context(settlement.attemptId);
			const prior = this.db
				.prepare("SELECT detail FROM events WHERE kind='uncertainty_settled_without_retry' AND attempt_id=?")
				.get(attempt.id);
			if (prior) {
				if (!isDeepStrictEqual(decode(prior.detail), detail))
					throw new Error("Settlement identity reused for a different payload");
				const superseded =
					action.state === "SUPERSEDED" &&
					this.db
						.prepare(
							"SELECT 1 FROM events WHERE kind='action_superseded' AND action_id=? AND json_extract(detail,'$.previousState')='ABANDONED'",
						)
						.get(actionId);
				if (
					(!superseded && action.state !== "ABANDONED") ||
					attempt.state !== "ABANDONED" ||
					!attempt.claimReleased
				)
					throw new Error("Settlement state changed");
				return false;
			}
			if (Number(this.meta("plan_revision")) !== expectedRevision) throw new Error("Factory plan revision changed");
			if (
				action.id !== actionId ||
				attempt.slotId !== settlement.slotId ||
				slot.host !== settlement.host ||
				action.command.cwd !== settlement.cwd ||
				action.sourceFingerprint !== settlement.sourceFingerprint ||
				this.tickets().find((ticket) => ticket.id === action.ticketId)?.owner !== settlement.ticketOwner ||
				!attempt.processIdentity ||
				attempt.processIdentity !== settlement.processIdentity ||
				attempt.uncertainty !== settlement.uncertainty
			)
				throw new Error("Settlement attempt or ownership changed");
			const latest = this.db
				.prepare("SELECT id FROM attempts WHERE action_id=? ORDER BY rowid DESC LIMIT 1")
				.get(actionId);
			if (
				attempt.state !== "UNCERTAIN" ||
				action.state !== "UNCERTAIN" ||
				attempt.claimReleased ||
				!attempt.submittedAt ||
				attempt.receipt !== null ||
				latest?.id !== attempt.id
			)
				throw new Error("Only the current uncertain claimed attempt and action may be settled without retry");
			if (!Number.isSafeInteger(settlement.wakeId) || settlement.wakeId < 1)
				throw new Error("Settlement wake changed");
			const wake = this.db
				.prepare("SELECT created_at FROM wakes WHERE id=? AND action_id=? AND attempt_id=? AND resolved_at IS NULL")
				.get(settlement.wakeId, actionId, attempt.id);
			if (!wake) throw new Error("Settlement wake changed");
			const observedAt = Date.parse(settlement.custody.observedAt);
			if (observedAt < Date.parse(String(wake.created_at)) || observedAt > Date.now())
				throw new Error("Settlement custody observation must follow the current wake and not be in the future");
			if (this.managementMutationBlockers().some((request) => request.actionId === actionId))
				throw new Error("Settlement blocked by unconsumed management requests for this action");
			this.db.prepare("UPDATE attempts SET state='ABANDONED',claim_released=1 WHERE id=?").run(attempt.id);
			this.db.prepare("UPDATE actions SET state='ABANDONED' WHERE id=?").run(actionId);
			this.resolveWakes(attempt.id);
			this.event("uncertainty_settled_without_retry", actionId, attempt.id, detail);
			return true;
		});
	}
	/** Atomically close never-claimed work. No attempt, receipt, wake or management authority is manufactured. */
	withdrawUnstarted(
		actionId: string,
		withdrawal: ActionWithdrawal,
		evidence: DecisionEvidence,
		expectedRevision: number,
	): boolean {
		evidenceValid(evidence);
		if (!withdrawal || withdrawal.version !== 1) throw new Error("Invalid action withdrawal");
		if (
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			withdrawal.planRevision !== expectedRevision
		)
			throw new Error("An exact expected plan revision is required for withdrawal");
		for (const key of ["actionId", "ticketId", "ticketOwner", "sourceFingerprint", "cwd"] as const)
			required(withdrawal[key], `withdrawal.${key}`);
		if (withdrawal.actionId !== actionId) throw new Error("Withdrawal action identity mismatch");
		return this.transaction(() => {
			if (this.isPaused()) throw new Error("Factory is paused; withdrawal is blocked");
			const action = this.action(actionId);
			const prior = this.db
				.prepare("SELECT detail FROM events WHERE kind='action_withdrawn' AND action_id=?")
				.get(actionId);
			if (prior) {
				const { previousState: _previousState, ...payload } = decode<Record<string, unknown>>(prior.detail);
				if (!isDeepStrictEqual(payload, { withdrawal, ...evidence, outcome: "NOT_EXECUTED" }))
					throw new Error("Withdrawal identity reused for a different payload");
				if (action?.state !== "WITHDRAWN") throw new Error("Withdrawal state changed");
				return false;
			}
			if (Number(this.meta("plan_revision")) !== expectedRevision) throw new Error("Factory plan revision changed");
			if (
				!action ||
				action.ticketId !== withdrawal.ticketId ||
				action.command.cwd !== withdrawal.cwd ||
				action.sourceFingerprint !== withdrawal.sourceFingerprint ||
				this.tickets().find((ticket) => ticket.id === action.ticketId)?.owner !== withdrawal.ticketOwner
			)
				throw new Error("Withdrawal action or ownership changed");
			if (
				(action.state !== "QUEUED" && action.state !== "READY") ||
				this.db.prepare("SELECT 1 FROM attempts WHERE action_id=? LIMIT 1").get(actionId)
			)
				throw new Error("Only unstarted QUEUED or READY actions with zero attempts may be withdrawn");
			if (this.db.prepare("SELECT 1 FROM management_requests WHERE action_id=? LIMIT 1").get(actionId))
				throw new Error("Withdrawal requires zero management history for this action");
			if (this.db.prepare("SELECT 1 FROM wakes WHERE action_id=? LIMIT 1").get(actionId))
				throw new Error("Withdrawal requires unstarted work without wake history");
			this.db.prepare("UPDATE actions SET state='WITHDRAWN' WHERE id=?").run(actionId);
			this.event("action_withdrawn", actionId, null, {
				withdrawal,
				...evidence,
				outcome: "NOT_EXECUTED",
				previousState: action.state,
			});
			return true;
		});
	}
	planMutation(id: string): PlanMutationReceipt | undefined {
		const row = this.db.prepare("SELECT * FROM plan_mutations WHERE id=?").get(id);
		return row
			? {
					id: String(row.id),
					payloadSha256: String(row.payload_sha256),
					previousRevision: Number(row.previous_revision),
					revision: Number(row.revision),
				}
			: undefined;
	}
	managementMutationBlockers(): ManagementRequest[] {
		const requests = this.managementRequests();
		const openWakes = new Set(
			this.wakes()
				.filter((wake) => wake.resolvedAt === null)
				.map((wake) => wake.id),
		);
		const latest = new Map(requests.map((request) => [request.wakeId, request.id]));
		return requests.filter(
			(request) =>
				request.state === "CLAIMED" ||
				(request.state === "PROPOSED" &&
					openWakes.has(request.wakeId) &&
					latest.get(request.wakeId) === request.id),
		);
	}
	private requireManagementDrained(): void {
		const blockers = this.managementMutationBlockers();
		if (blockers.length)
			throw new Error(
				`Plan mutation blocked by unconsumed management requests: ${blockers.map((request) => request.id).join(", ")}`,
			);
	}
	/** Explicit evidence-backed release of judgment authority, never a model retry or process-custody resolution. */
	reconcileManagement(
		requestId: string,
		reconciliation: ManagementReconciliation,
		evidence: DecisionEvidence,
		expectedRevision: number,
	): void {
		evidenceValid(evidence);
		this.transaction(() => {
			if (this.isPaused()) throw new Error("Factory is paused; management reconciliation is blocked");
			if (!Number.isSafeInteger(expectedRevision) || Number(this.meta("plan_revision")) !== expectedRevision)
				throw new Error("Factory plan revision changed");
			const request = this.managementRequests().find((item) => item.id === requestId);
			if (!request || (request.state !== "CLAIMED" && request.state !== "PROPOSED"))
				throw new Error("Only an unconsumed management request may be reconciled");
			if (
				reconciliation.version !== 1 ||
				reconciliation.requestId !== requestId ||
				reconciliation.wakeId !== request.wakeId ||
				reconciliation.attemptId !== request.attemptId ||
				reconciliation.planRevision !== request.planRevision
			)
				throw new Error("Management reconciliation does not match the original request");
			if (
				reconciliation.priorActor?.stopped !== true ||
				reconciliation.priorActor.authorityRevoked !== true ||
				!["completed", "cancelled", "not-submitted"].includes(reconciliation.providerRequest?.disposition)
			)
				throw new Error("Actor and provider request custody must be reconciled first");
			this.db.prepare("UPDATE management_requests SET state='RECONCILED' WHERE id=?").run(requestId);
			this.event("management_reconciled", request.actionId, request.attemptId, {
				id: requestId,
				previousState: request.state,
				reconciliation,
				...evidence,
			});
		});
	}
	/** Claims never expire. An interrupted model request must not be replayed on timeout or process death. */
	claimManagement(claim: ManagementClaim): boolean {
		return this.transaction(() => {
			this.assertManagementCurrent(claim);
			if (
				this.db
					.prepare(
						"SELECT id FROM management_requests WHERE wake_id=? AND attempt_id=? AND evidence_sha256=? LIMIT 1",
					)
					.get(claim.wakeId, claim.attemptId, claim.evidenceSha256)
			)
				return false;
			const result = this.db
				.prepare(
					"INSERT OR IGNORE INTO management_requests(id,wake_id,action_id,attempt_id,plan_revision,evidence_sha256,created_at,state) VALUES(?,?,?,?,?,?,?,'CLAIMED')",
				)
				.run(
					claim.id,
					claim.wakeId,
					claim.actionId,
					claim.attemptId,
					claim.planRevision,
					claim.evidenceSha256,
					now(),
				);
			if (!result.changes) return false;
			this.event("management_claimed", claim.actionId, claim.attemptId, { ...claim });
			return true;
		});
	}
	assertManagementCurrent(claim: ManagementClaim): void {
		const request = this.db.prepare("SELECT state FROM management_requests WHERE id=?").get(claim.id);
		if (request && request.state !== "CLAIMED" && request.state !== "PROPOSED")
			throw new Error("Management request authority is no longer active");
		if (this.isPaused()) throw new Error("Factory is paused; management is blocked");
		if (Number(this.meta("plan_revision")) !== claim.planRevision) throw new Error("Factory plan revision changed");
		const wake = this.db.prepare("SELECT * FROM wakes WHERE id=? AND resolved_at IS NULL").get(claim.wakeId);
		if (!wake || wake.action_id !== claim.actionId || wake.attempt_id !== claim.attemptId)
			throw new Error("Management wake changed");
		const action = this.action(claim.actionId);
		const latest = this.db
			.prepare("SELECT id FROM attempts WHERE action_id=? ORDER BY rowid DESC LIMIT 1")
			.get(claim.actionId);
		if (
			!action ||
			(action.state !== "AWAITING_DECISION" && action.state !== "UNCERTAIN") ||
			latest?.id !== claim.attemptId
		)
			throw new Error("Management action or attempt changed");
	}
	managementRequests(): ManagementRequest[] {
		return this.db
			.prepare("SELECT * FROM management_requests ORDER BY rowid")
			.all()
			.map((row) => ({
				id: String(row.id),
				wakeId: Number(row.wake_id),
				actionId: String(row.action_id),
				attemptId: String(row.attempt_id),
				planRevision: Number(row.plan_revision),
				evidenceSha256: String(row.evidence_sha256),
				createdAt: String(row.created_at),
				state: String(row.state) as ManagementRequest["state"],
				result: row.result === null ? null : decode<ManagementResult>(row.result),
				error: row.error === null ? null : String(row.error),
			}));
	}
	finishManagement(id: string, result: ManagementResult | null, error: string | null = null): void {
		this.transaction(() => {
			const state = error !== null ? "ERROR" : result?.proposal.decision === "defer" ? "DEFERRED" : "PROPOSED";
			const changed = this.db
				.prepare("UPDATE management_requests SET state=?,result=?,error=? WHERE id=? AND state='CLAIMED'")
				.run(state, result ? JSON.stringify(result) : null, error, id);
			if (!changed.changes) throw new Error("Management claim is no longer active");
			this.event("management_finished", null, null, { id, state, error });
		});
	}
	events(afterSequence = 0, limit = 100): FactoryEvent[] {
		if (
			!Number.isSafeInteger(afterSequence) ||
			afterSequence < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 10000
		)
			throw new Error("Invalid event range");
		return this.db
			.prepare("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?")
			.all(afterSequence, limit)
			.map((r) => ({
				sequence: Number(r.sequence),
				at: String(r.at),
				kind: String(r.kind),
				actionId: r.action_id === null ? null : String(r.action_id),
				attemptId: r.attempt_id === null ? null : String(r.attempt_id),
				detail: decode<Record<string, unknown>>(r.detail),
			}));
	}
	wakes(): WakeRecord[] {
		return this.db
			.prepare("SELECT * FROM wakes ORDER BY id")
			.all()
			.map((r) => ({
				id: Number(r.id),
				actionId: String(r.action_id),
				attemptId: r.attempt_id === null ? null : String(r.attempt_id),
				reason: String(r.reason),
				createdAt: String(r.created_at),
				resolvedAt: r.resolved_at === null ? null : String(r.resolved_at),
			}));
	}
	status(): FactoryStatus {
		return {
			schemaVersion: SCHEMA_VERSION,
			planRevision: Number(this.meta("plan_revision")),
			paused: this.isPaused(),
			pauseReason: this.meta("pause_reason") || null,
			tickets: this.tickets(),
			actions: this.actions(),
			slots: this.slots(),
			attempts: this.attempts(),
			wakes: this.wakes(),
			roles: decode<FactoryPlan["roles"]>(this.meta("roles") ?? "{}"),
		};
	}
}
