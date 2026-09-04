/** Portable factory contracts. Host, model and UI integrations live outside this module. */
export interface TicketSpec {
	id: string;
	owner: string;
}

export interface SlotSpec {
	id: string;
	host: string;
	capabilities?: string[];
}

export interface ActionSpec {
	id: string;
	description?: string;
	acceptanceCriteria?: string[];
	ticketId: string;
	dependencies: string[];
	/** Immutable identity of the submitted source, e.g. a tree plus patch hash. */
	sourceFingerprint: string;
	/** Only process actions may be accepted by a successful command alone. */
	kind: "process" | "decision";
	command: { argv: string[]; cwd: string; timeoutMs?: number };
	requirements: { host?: string; slotId?: string; capabilities?: string[] };
}

export interface FactoryPlan {
	version: 1;
	tickets: TicketSpec[];
	slots: SlotSpec[];
	actions: ActionSpec[];
	roles?: Record<string, { provider: string; model: string; effort?: string }>;
}

export type ActionState =
	| "QUEUED"
	| "READY"
	| "RUNNING"
	| "UNCERTAIN"
	| "AWAITING_DECISION"
	| "ACCEPTED"
	| "REJECTED"
	| "SUPERSEDED";
export interface ActionRecord extends ActionSpec {
	state: ActionState;
}
export interface TicketRecord extends TicketSpec {
	state: "ACTIVE" | "RETIRED";
}
export interface ArtifactReference {
	ref: string;
	sourceFingerprint: string;
}
export interface CompletionReceipt {
	attemptId: string;
	sourceFingerprint: string;
	exitCode: number | null;
	finishedAt: string;
	artifact?: ArtifactReference;
}
export type AttemptState = "PREPARED" | "SUBMITTED" | "RUNNING" | "UNCERTAIN" | "TERMINAL" | "ABANDONED";
export interface AttemptRecord {
	id: string;
	actionId: string;
	slotId: string;
	state: AttemptState;
	createdAt: string;
	submittedAt: string | null;
	processIdentity: string | null;
	receipt: CompletionReceipt | null;
	uncertainty: string | null;
	claimReleased: boolean;
}
export interface AttemptContext {
	attempt: AttemptRecord;
	action: ActionRecord;
	slot: SlotSpec;
}
export type Inspection =
	| { kind: "running"; processIdentity: string }
	| { kind: "terminal"; receipt: CompletionReceipt }
	| { kind: "uncertain"; reason: string };
export interface FactoryAdapter {
	/** The store records submission intent before calling launch. Launch must use attempt.id as its durable identity. */
	launch(context: AttemptContext): Promise<Inspection>;
	/** Missing receipts, unreachable hosts and vanished runners are uncertain, never proof that nothing ran. */
	inspect(context: AttemptContext): Promise<Inspection>;
}
export interface FactoryEvent {
	sequence: number;
	at: string;
	kind: string;
	actionId: string | null;
	attemptId: string | null;
	detail: Record<string, unknown>;
}
export interface WakeRecord {
	id: number;
	actionId: string;
	attemptId: string | null;
	reason: string;
	createdAt: string;
	resolvedAt: string | null;
}
export interface DecisionEvidence {
	actor: string;
	reason: string;
	ref: string;
}
export interface FactoryStatus {
	schemaVersion: number;
	planRevision: number;
	paused: boolean;
	pauseReason: string | null;
	tickets: TicketRecord[];
	actions: ActionRecord[];
	slots: SlotSpec[];
	attempts: AttemptRecord[];
	wakes: WakeRecord[];
	roles: FactoryPlan["roles"];
}
export interface FactoryEngineOptions {
	/** Explicit opt-in. Merely opening a store never launches work. */
	enabled?: boolean;
	/** Existence blocks launches and plan changes; contents are not interpreted. */
	pauseFile?: string;
	maxLaunchesPerTick?: number;
}
export interface TickResult {
	launched: string[];
	reconciled: string[];
	paused: boolean;
}
