import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createJevTypedDecisionCaller, type JevTypedCaller } from "./adapters/jev-typed-decision.js";
import { save } from "./decision-receipt.js";
import {
	codeDecisionBase,
	type DecisionOf,
	type DecisionReceipt,
	type FactoryDecision,
	recordDecision,
	validateDecision,
} from "./decisions.js";
import type { FactoryEngine } from "./engine.js";
import { assertByteLimit, FACTORY_EVIDENCE_LIMITS, validateManagementEvidence } from "./evidence.js";
import {
	createManagementPacket,
	type ManagementCaller,
	type ManagementClaim,
	type ManagementEvidence,
	type ManagementEvidenceBinding,
	type ManagementModelResult,
	type ManagementPacket,
	type ManagementResult,
	managementCallCost,
	parseManagementProposal,
	proposeManagementDecision,
} from "./management.js";
import type { WakeRecord } from "./types.js";

export interface ManageWakeOptions {
	directory: string;
	typedDecision?: FactoryDecision;
	role?: string;
	actionId?: string;
	evidence?: ManagementEvidence[];
	/** Automatic mode requires an exact, hash-validated per-wake evidence binding. */
	automatic?: boolean;
	evidenceDirectory?: string;
	apply?: boolean;
	stopped?: () => boolean;
}
interface ManageWakeBase {
	/** Counts admissions, including errors, not successful model responses. */
	admitted: boolean;
	requestId?: string;
	evidenceDirectory?: string;
	result?: ManagementResult;
	typedDecision?: DecisionReceipt;
	error?: string;
}
export type ManageWakeResult = ManageWakeBase &
	(
		| { kind: "idle" | "paused" | "consumed" | "proposed" | "applied" | "deferred" | "error" }
		| { kind: "drift"; requestId: string; wakeId: number; requestedProfile: string; servedProfile: string }
	);
class ProfileDrift extends Error {}
export type ManagementCallerFactory = (beforeRequest: () => void) => ManagementCaller;
const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

function boundEvidence(directory: string, wake: WakeRecord, planRevision: number): ManagementEvidence[] | undefined {
	const path = join(directory, `${wake.id}.json`);
	if (!existsSync(path)) return undefined;
	const info = statSync(path);
	if (!info.isFile()) throw new Error(`binding: expected a regular file: ${path}`);
	assertByteLimit("binding", info.size, FACTORY_EVIDENCE_LIMITS.bindingBytes);
	const bytes = readFileSync(path);
	assertByteLimit("binding", bytes.length, FACTORY_EVIDENCE_LIMITS.bindingBytes);
	const binding = JSON.parse(bytes.toString("utf8")) as ManagementEvidenceBinding;
	if (!binding || binding.version !== 1)
		throw new Error(`binding: expected a version 1 management evidence binding: ${path}`);
	if (!Array.isArray(binding.evidence)) throw new Error("binding.evidence: expected an array");
	if (
		binding.wakeId !== wake.id ||
		binding.actionId !== wake.actionId ||
		binding.attemptId !== wake.attemptId ||
		binding.planRevision !== planRevision
	)
		return undefined;
	validateManagementEvidence(binding.evidence, "binding.evidence", 1);
	return binding.evidence.map((item, index) => {
		if (item.sha256 !== sha256(item.content))
			throw new Error(`binding.evidence[${index}].sha256: content hash mismatch: ${path}`);
		return { ref: item.ref, content: item.content };
	});
}

/** One bounded wake. No launch, reconciliation, retry, polling, or SDK dependency lives here. */
export async function manageFactoryWake(
	engine: FactoryEngine,
	options: ManageWakeOptions,
	createCaller: ManagementCallerFactory,
	createTypedCaller: (requireCurrent: () => void) => JevTypedCaller = createJevTypedDecisionCaller,
): Promise<ManageWakeResult> {
	const typed = options.typedDecision === undefined ? undefined : validateDecision(options.typedDecision);
	if (typed && (options.automatic || options.apply || !options.actionId))
		throw new Error("Typed management requires one action and records only; apply later through decide-typed");
	const observedSequence = engine.store.ledgerSequence();
	if (typed && typed.ledger_sequence !== observedSequence) throw new Error("Typed decision ledger_sequence changed");
	const status = engine.status();
	if (status.paused || options.stopped?.()) return { kind: "paused", admitted: false };
	if (options.automatic && (options.evidence !== undefined || options.actionId !== undefined))
		throw new Error("Automatic management uses per-wake evidence bindings, not shared evidence or an action filter");
	let consumed = false;
	for (const wake of status.wakes) {
		if (wake.resolvedAt !== null || (options.actionId && wake.actionId !== options.actionId)) continue;
		const action = status.actions.find((item) => item.id === wake.actionId);
		if (!action || (action.state !== "AWAITING_DECISION" && (options.automatic || action.state !== "UNCERTAIN")))
			continue;
		const supplied = options.automatic
			? boundEvidence(
					options.evidenceDirectory ?? join(options.directory, "management-evidence"),
					wake,
					status.planRevision,
				)
			: (options.evidence ?? []);
		if (!supplied) continue;
		const packet = createManagementPacket(status, action.id, supplied);
		packet.evidence = [...packet.evidence].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
		packet.wakes = [wake];
		if (!packet.attempt || packet.attempt.id !== wake.attemptId) continue;
		const role = options.role ?? "ticketOwner";
		const profile = status.roles?.[role] ?? (typed ? { provider: "typesafe", model: "jev-latest" } : undefined);
		if (!profile) throw new Error(`No model configured for factory role: ${role}`);
		const evidenceHashes = packet.evidence.map((item) => ({ ref: item.ref, sha256: sha256(item.content) }));
		const claim: ManagementClaim = {
			id: randomUUID(),
			wakeId: wake.id,
			actionId: action.id,
			attemptId: packet.attempt.id,
			planRevision: packet.planRevision,
			evidenceSha256: sha256(JSON.stringify(typed ? { evidenceHashes, typed } : evidenceHashes)),
		};
		const requireCurrent = (): void => {
			if (options.stopped?.() || engine.status().paused)
				throw new Error("Factory paused or management stopped; request/application blocked");
			engine.store.assertManagementCurrent(claim);
			if (options.automatic) {
				const current = boundEvidence(
					options.evidenceDirectory ?? join(options.directory, "management-evidence"),
					wake,
					claim.planRevision,
				);
				const hashes = current
					?.map((item) => ({ ref: item.ref, sha256: sha256(item.content) }))
					.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
				if (!hashes || sha256(JSON.stringify(hashes)) !== claim.evidenceSha256)
					throw new Error("Management evidence binding changed");
			}
		};
		requireCurrent();
		if (!engine.store.claimManagement(claim)) {
			consumed = true;
			const requests = engine.store.managementRequests();
			if (requests.some((request) => request.wakeId === claim.wakeId && request.state === "CLAIMED")) continue;
			const previous = requests.find(
				(request) =>
					request.wakeId === claim.wakeId &&
					request.planRevision === claim.planRevision &&
					request.attemptId === claim.attemptId &&
					request.evidenceSha256 === claim.evidenceSha256,
			);
			if (
				options.apply &&
				previous?.state === "PROPOSED" &&
				previous.result &&
				"proposal" in previous.result &&
				[...requests].reverse().find((request) => request.wakeId === claim.wakeId)?.id === previous.id
			) {
				return applyProposal(
					engine,
					options,
					packet,
					{ ...claim, id: previous.id },
					previous.result,
					false,
					requireCurrent,
				);
			}
			continue;
		}
		const output = join(options.directory, "decisions", claim.id);
		let result: ManagementResult;
		let typedDecision: DecisionReceipt | undefined;
		let recordingAttempted = false;
		const recordTurn = (decision: DecisionOf<"writer_terminal_accept">): DecisionReceipt => {
			recordingAttempted = true;
			return recordDecision(engine.store, action.id, decision, { requestId: claim.id, staleCheck: false });
		};
		const ledgerSequence = engine.store.ledgerSequence();
		const terminalDecision = (
			response: ManagementModelResult,
			wallClockMs: number,
			reason: string,
		): DecisionOf<"writer_terminal_accept"> => {
			const cost = managementCallCost(response, wallClockMs);
			return {
				...codeDecisionBase(ledgerSequence, reason),
				type: "writer_terminal_accept",
				decided_by: "advisor",
				requested_profile: profile.model,
				served_profile:
					response.responseModelSource === "provider-response"
						? response.responseModel?.trim() || "unknown"
						: "unknown",
				usage: cost.accounting.usage,
				cost_usd: cost.accounting.cost_usd,
				wall_clock_ms: cost.wall_clock_ms,
				attempt_id: claim.attemptId,
				candidate_fingerprint: action.sourceFingerprint,
				receipt_fingerprint: packet.attempt?.receipt?.sourceFingerprint ?? null,
				exit_code: packet.attempt?.receipt?.exitCode ?? null,
				agent_end: null,
				stop_reason: null,
				changed_paths: null,
				allowed_paths_only: null,
				receipt_ready: !!packet.attempt?.receipt,
				receipt_sha: packet.attempt?.receipt ? sha256(JSON.stringify(packet.attempt.receipt)) : null,
			};
		};
		let observed: ManagementModelResult | undefined;
		let elapsed = 0;
		try {
			mkdirSync(output, { recursive: true, mode: 0o700 });
			save(join(output, "request.json"), {
				claim,
				createdAt: new Date().toISOString(),
				role,
				profile,
				evidenceHashes,
				packet,
				...(typed ? { typedDecision: typed } : {}),
			});
			requireCurrent();
			if (typed) {
				const checkTypedCurrent = () => {
					requireCurrent();
					if (engine.store.ledgerSequence() !== ledgerSequence)
						throw new Error("Typed decision journal moved during call");
				};
				checkTypedCurrent();
				const caller = createTypedCaller(checkTypedCurrent);
				const response = await caller.call(typed);
				checkTypedCurrent();
				save(join(output, "response.json"), response);
				const receipt = recordDecision(engine.store, action.id, response.decision, {
					requestId: claim.id,
					staleCheck: false,
					inference: response.inference,
					accounting: response.accounting,
					requireCurrent: checkTypedCurrent,
				});
				if (response.inference.outcome === "DRIFT") {
					const wakeId = engine.store.openWakeIdForReason(`profile_drift: ${claim.id}`);
					if (wakeId === undefined) throw new Error("Profile drift wake is missing");
					return {
						kind: "drift",
						admitted: true,
						requestId: claim.id,
						evidenceDirectory: output,
						typedDecision: receipt,
						wakeId,
						requestedProfile: receipt.decision.requested_profile,
						servedProfile: receipt.decision.served_profile,
					};
				}
				return {
					kind: receipt.outcome === "DEFERRED" ? "deferred" : "proposed",
					admitted: true,
					requestId: claim.id,
					evidenceDirectory: output,
					typedDecision: receipt,
				};
			}
			const call = createCaller(requireCurrent);
			result = await proposeManagementDecision(
				packet,
				profile,
				async (...parameters) => {
					requireCurrent();
					const started = performance.now();
					const response = await call(...parameters);
					save(join(output, "response.json"), {
						...response,
						...managementCallCost(response, performance.now() - started),
					});
					observed = response;
					elapsed = performance.now() - started;
					const decision = terminalDecision(response, elapsed, "Provider response profile assertion");
					if (decision.requested_profile !== decision.served_profile) {
						typedDecision = recordTurn(decision);
						throw new ProfileDrift(
							`profile_drift: requested ${decision.requested_profile}; served ${decision.served_profile}`,
						);
					}
					return response;
				},
				claim.id,
			);
			if (!observed) throw new Error("No provider response was observed");
			typedDecision = recordTurn(terminalDecision(observed, elapsed, result.proposal.reason));
			result.typedDecision = typedDecision;
			save(join(output, "proposal.json"), result);
			engine.store.finishManagement(claim.id, result);
		} catch (error) {
			let message = error instanceof Error ? error.message : String(error);
			if (error instanceof ProfileDrift && typedDecision) {
				try {
					const wakeId = engine.store.openWakeIdForReason(`profile_drift: ${claim.id}`);
					if (wakeId === undefined) throw new Error("Profile drift wake is missing");
					engine.store.finishManagementDrift(claim.id);
					return {
						kind: "drift",
						admitted: true,
						requestId: claim.id,
						evidenceDirectory: output,
						typedDecision,
						wakeId,
						requestedProfile: typedDecision.decision.requested_profile,
						servedProfile: typedDecision.decision.served_profile,
					};
				} catch (finishError) {
					message += `; drift completion failed: ${finishError instanceof Error ? finishError.message : String(finishError)}`;
				}
			}
			if (observed && !recordingAttempted) {
				try {
					typedDecision = recordTurn(terminalDecision(observed, elapsed, message));
				} catch (recordError) {
					message += `; decision receipt failed: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
				}
			}
			try {
				if (engine.store.managementRequests().find((request) => request.id === claim.id)?.state === "CLAIMED")
					engine.store.finishManagement(claim.id, null, message);
			} catch (finishError) {
				message += `; management completion failed: ${finishError instanceof Error ? finishError.message : String(finishError)}`;
			}
			return { kind: "error", admitted: true, requestId: claim.id, evidenceDirectory: output, error: message };
		}
		if (options.apply && result.proposal.decision !== "defer")
			return applyProposal(engine, options, packet, claim, result, true, requireCurrent);
		return {
			kind: result.proposal.decision === "defer" ? "deferred" : "proposed",
			admitted: true,
			requestId: claim.id,
			evidenceDirectory: output,
			result,
		};
	}
	return { kind: consumed ? "consumed" : "idle", admitted: false };
}

function applyProposal(
	engine: FactoryEngine,
	options: ManageWakeOptions,
	packet: ManagementPacket,
	claim: ManagementClaim,
	result: ManagementResult,
	admitted: boolean,
	requireCurrent: () => void,
): ManageWakeResult {
	const output = join(options.directory, "decisions", claim.id);
	try {
		requireCurrent();
		if (result.packetSha256 !== sha256(JSON.stringify(packet))) throw new Error("Cached management packet changed");
		if (
			!result.typedDecision ||
			result.typedDecision.decision.requested_profile !== result.typedDecision.decision.served_profile
		)
			throw new Error("profile_drift: cached proposal lacks a matching served-profile receipt");
		const proposal = parseManagementProposal(JSON.stringify(result.proposal), packet);
		if (proposal.decision === "defer") throw new Error("Cannot apply a deferred proposal");
		const outcome = proposal.decision;
		const applied = recordDecision(
			engine.store,
			claim.actionId,
			{
				...result.typedDecision.decision,
				...codeDecisionBase(engine.store.ledgerSequence(), proposal.reason),
			},
			{
				sourceRequestId: claim.id,
				apply: () => {
					engine.decide(
						claim.actionId,
						outcome,
						{
							actor: `factory-management:${result.profile.provider}/${result.profile.model}`,
							reason: proposal.reason,
							ref: join(output, "proposal.json"),
						},
						claim.planRevision,
						claim.attemptId,
						claim.wakeId,
						claim.id,
					);
				},
			},
		);
		result = { ...result, typedDecision: applied };
		return { kind: "applied", admitted, requestId: claim.id, evidenceDirectory: output, result };
	} catch (error) {
		return {
			kind: "error",
			admitted,
			requestId: claim.id,
			evidenceDirectory: output,
			result,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface ManagementWatchOptions extends ManageWakeOptions {
	maxRequests: number;
	maxPasses: number;
	intervalMs: number;
	signal?: AbortSignal;
}
/** Finite automatic consumer, run in its own process, never awaited by the scheduling service. */
export async function watchFactoryManagement(
	engine: FactoryEngine,
	options: ManagementWatchOptions,
	createCaller: ManagementCallerFactory,
	emit: (result: ManageWakeResult) => void,
): Promise<{ admitted: number; passes: number }> {
	for (const [name, value, maximum] of [
		["maxRequests", options.maxRequests, 100],
		["maxPasses", options.maxPasses, 10000],
		["intervalMs", options.intervalMs, 60000],
	] as const) {
		if (!Number.isSafeInteger(value) || value < (name === "intervalMs" ? 50 : 1) || value > maximum)
			throw new Error(`Invalid management ${name}`);
	}
	let admitted = 0;
	let passes = 0;
	const stopped = () => options.signal?.aborted === true || options.stopped?.() === true;
	while (!stopped() && admitted < options.maxRequests && passes < options.maxPasses) {
		const result = await manageFactoryWake(engine, { ...options, automatic: true, stopped }, createCaller);
		passes++;
		if (result.admitted) admitted++;
		emit(result);
		if (stopped() || admitted >= options.maxRequests || passes >= options.maxPasses) break;
		await new Promise<void>((resolveWait) => {
			const done = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", done);
				resolveWait();
			};
			const timer = setTimeout(done, options.intervalMs);
			options.signal?.addEventListener("abort", done, { once: true });
			if (options.signal?.aborted) done();
		});
	}
	return { admitted, passes };
}
