import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FactoryEngine } from "./engine.js";
import { assertByteLimit, FACTORY_EVIDENCE_LIMITS, validateManagementEvidence } from "./evidence.js";
import {
	createManagementPacket,
	type ManagementCaller,
	type ManagementClaim,
	type ManagementEvidence,
	type ManagementEvidenceBinding,
	type ManagementPacket,
	type ManagementResult,
	parseManagementProposal,
	proposeManagementDecision,
} from "./management.js";
import type { WakeRecord } from "./types.js";

export interface ManageWakeOptions {
	directory: string;
	role?: string;
	actionId?: string;
	evidence?: ManagementEvidence[];
	/** Automatic mode requires an exact, hash-validated per-wake evidence binding. */
	automatic?: boolean;
	evidenceDirectory?: string;
	apply?: boolean;
	stopped?: () => boolean;
}
export interface ManageWakeResult {
	kind: "idle" | "paused" | "consumed" | "proposed" | "applied" | "deferred" | "error";
	/** Counts admissions, including errors, not successful model responses. */
	admitted: boolean;
	requestId?: string;
	evidenceDirectory?: string;
	result?: ManagementResult;
	error?: string;
}
export type ManagementCallerFactory = (beforeRequest: () => void) => ManagementCaller;
const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

function save(path: string, data: unknown): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

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
): Promise<ManageWakeResult> {
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
		const profile = status.roles?.[role];
		if (!profile) throw new Error(`No model configured for factory role: ${role}`);
		const evidenceHashes = packet.evidence.map((item) => ({ ref: item.ref, sha256: sha256(item.content) }));
		const claim: ManagementClaim = {
			id: randomUUID(),
			wakeId: wake.id,
			actionId: action.id,
			attemptId: packet.attempt.id,
			planRevision: packet.planRevision,
			evidenceSha256: sha256(JSON.stringify(evidenceHashes)),
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
		try {
			mkdirSync(output, { recursive: true, mode: 0o700 });
			save(join(output, "request.json"), {
				claim,
				createdAt: new Date().toISOString(),
				role,
				profile,
				evidenceHashes,
				packet,
			});
			requireCurrent();
			const call = createCaller(requireCurrent);
			result = await proposeManagementDecision(
				packet,
				profile,
				async (...parameters) => {
					requireCurrent();
					const response = await call(...parameters);
					save(join(output, "response.json"), response);
					return response;
				},
				claim.id,
			);
			save(join(output, "proposal.json"), result);
			engine.store.finishManagement(claim.id, result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (engine.store.managementRequests().find((request) => request.id === claim.id)?.state === "CLAIMED")
				engine.store.finishManagement(claim.id, null, message);
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
		const proposal = parseManagementProposal(JSON.stringify(result.proposal), packet);
		if (proposal.decision === "defer") throw new Error("Cannot apply a deferred proposal");
		engine.decide(
			claim.actionId,
			proposal.decision,
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
