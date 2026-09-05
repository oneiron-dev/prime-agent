import { existsSync } from "node:fs";
import type { ManagementReconciliation } from "./management.js";
import { verifyManagementReconciliation } from "./management-recovery.js";
import type { FactoryStore } from "./store.js";
import type {
	AttemptContext,
	DecisionEvidence,
	FactoryAdapter,
	FactoryEngineOptions,
	FactoryPlan,
	FactoryStatus,
	Inspection,
	TickResult,
} from "./types.js";

/** Scheduling policy over the durable journal. It never imports Prime or a model SDK. */
export class FactoryEngine {
	constructor(
		readonly store: FactoryStore,
		private readonly adapter: FactoryAdapter,
		private readonly options: FactoryEngineOptions = {},
	) {
		if (
			options.maxLaunchesPerTick !== undefined &&
			(!Number.isSafeInteger(options.maxLaunchesPerTick) || options.maxLaunchesPerTick < 1)
		)
			throw new Error("maxLaunchesPerTick must be a positive integer");
	}
	private externalPause(): boolean {
		return this.options.pauseFile !== undefined && existsSync(this.options.pauseFile);
	}
	private paused(): boolean {
		return this.externalPause() || this.store.isPaused();
	}
	private requireUnpaused(): void {
		if (this.paused()) throw new Error("Factory is paused; changes are blocked");
	}
	applyPlan(plan: FactoryPlan, expectedRevision?: number, mutationId?: string): number {
		this.requireUnpaused();
		return this.store.applyPlan(plan, expectedRevision, mutationId);
	}
	reconcileManagement(
		requestId: string,
		reconciliation: ManagementReconciliation,
		evidence: DecisionEvidence,
		expectedRevision: number,
	): void {
		this.requireUnpaused();
		verifyManagementReconciliation(reconciliation);
		this.requireUnpaused();
		this.store.reconcileManagement(requestId, reconciliation, evidence, expectedRevision);
	}
	pause(reason: string): void {
		this.store.pause(reason);
	}
	resume(): void {
		if (this.externalPause()) throw new Error("External owner pause remains in place");
		this.store.resume();
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
		this.requireUnpaused();
		this.store.decide(
			actionId,
			outcome,
			evidence,
			expectedRevision,
			expectedAttemptId,
			expectedWakeId,
			expectedManagementRequestId,
		);
	}
	supersede(actionId: string, replacementId: string, evidence: DecisionEvidence, expectedRevision?: number): number {
		this.requireUnpaused();
		return this.store.supersede(actionId, replacementId, evidence, expectedRevision);
	}
	resolveForRetry(attemptId: string, evidence: DecisionEvidence, expectedRevision?: number): void {
		this.requireUnpaused();
		this.store.resolveForRetry(attemptId, evidence, expectedRevision);
	}
	status(): FactoryStatus {
		const status = this.store.status();
		if (this.externalPause()) {
			status.paused = true;
			status.pauseReason = `External owner pause: ${this.options.pauseFile}`;
		}
		return status;
	}
	private record(context: AttemptContext, result: Inspection): void {
		if (result.kind === "terminal") {
			if (result.receipt.attemptId !== context.attempt.id) throw new Error("Receipt attempt identity mismatch");
			this.store.complete(result.receipt);
		} else if (result.kind === "running") this.store.markRunning(context.attempt.id, result.processIdentity);
		else if (result.kind === "uncertain") this.store.markUncertain(context.attempt.id, result.reason);
		else throw new Error("Unknown adapter inspection result");
	}
	private async inspect(context: AttemptContext): Promise<void> {
		try {
			this.record(context, await this.adapter.inspect(context));
		} catch (error) {
			this.store.markUncertain(
				context.attempt.id,
				`Inspection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	/** Reconcile even while paused, then fill compatible free slots when explicitly enabled. */
	async tick(): Promise<TickResult> {
		const result: TickResult = { launched: [], reconciled: [], paused: this.paused() };
		const active = this.store.attempts(true);
		for (let offset = 0; offset < active.length; offset += 8) {
			await Promise.all(
				active.slice(offset, offset + 8).map(async (attempt) => {
					if (attempt.state === "PREPARED") {
						// CAS against submission: a concurrent controller can launch only if it wins that CAS first.
						if (!this.paused()) this.store.abandonPrepared(attempt.id);
					} else await this.inspect(this.store.context(attempt.id));
					result.reconciled.push(attempt.id);
				}),
			);
		}
		if (!this.options.enabled || this.paused()) {
			result.paused = this.paused();
			return result;
		}
		const budget = this.options.maxLaunchesPerTick ?? 16;
		for (let count = 0; count < budget && !this.paused(); count++) {
			let claimed: AttemptContext | undefined;
			for (const action of this.store.actions()) {
				if (action.state !== "READY") continue;
				for (const slot of this.store.slots()) {
					if (this.paused()) break;
					claimed = this.store.claim(action.id, slot.id);
					if (claimed) break;
				}
				if (claimed || this.paused()) break;
			}
			if (!claimed) break;
			if (this.paused()) {
				this.store.abandonPrepared(claimed.attempt.id);
				break;
			}
			if (!this.store.markSubmitted(claimed.attempt.id)) continue;
			const submitted = this.store.context(claimed.attempt.id);
			result.launched.push(submitted.attempt.id);
			try {
				this.record(submitted, await this.adapter.launch(submitted));
			} catch (error) {
				this.store.markUncertain(
					submitted.attempt.id,
					`Launch outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		result.paused = this.paused();
		return result;
	}
}
