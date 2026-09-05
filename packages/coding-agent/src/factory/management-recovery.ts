import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ManagementReconciliation } from "./management.js";

function readProof(proof: { ref: string; sha256: string }): string {
	if (!proof || typeof proof.ref !== "string" || !isAbsolute(proof.ref) || !/^[a-f0-9]{64}$/.test(proof.sha256))
		throw new Error("Recovery proof requires an absolute artifact path and SHA-256");
	const stat = statSync(proof.ref);
	if (!stat.isFile() || stat.size > 1000000)
		throw new Error("Recovery artifacts must be regular files of at most 1000000 bytes");
	const bytes = readFileSync(proof.ref);
	if (bytes.length > 1000000 || createHash("sha256").update(bytes).digest("hex") !== proof.sha256)
		throw new Error(`Recovery artifact hash mismatch: ${proof.ref}`);
	return bytes.toString("utf8");
}
/** Validates operator-supplied receipts, not cryptographic proof of remote process termination. */
export function verifyManagementReconciliation(reconciliation: ManagementReconciliation): void {
	if (
		!reconciliation ||
		reconciliation.version !== 1 ||
		typeof reconciliation.requestId !== "string" ||
		!reconciliation.requestId.trim()
	)
		throw new Error("Invalid management reconciliation");
	const actor = reconciliation.priorActor;
	const provider = reconciliation.providerRequest;
	if (
		!actor ||
		typeof actor.identity !== "string" ||
		!actor.identity.trim() ||
		actor.stopped !== true ||
		actor.authorityRevoked !== true ||
		!provider ||
		!["completed", "cancelled", "not-submitted"].includes(provider.disposition)
	)
		throw new Error("Reconcile exact actor authority and provider request custody first; UNKNOWN is not safe");
	const actorReceipt = JSON.parse(readProof(actor)) as Record<string, unknown>;
	const providerReceipt = JSON.parse(readProof(provider)) as Record<string, unknown>;
	if (
		actorReceipt?.version !== 1 ||
		actorReceipt.requestId !== reconciliation.requestId ||
		actorReceipt.actorIdentity !== actor.identity ||
		actorReceipt.stopped !== true ||
		actorReceipt.authorityRevoked !== true
	)
		throw new Error("Actor receipt does not prove the declared request-bound authority revocation");
	if (
		providerReceipt?.version !== 1 ||
		providerReceipt.requestId !== reconciliation.requestId ||
		providerReceipt.disposition !== provider.disposition
	)
		throw new Error("Provider receipt does not match the reconciled request disposition");
	if (
		!Array.isArray(reconciliation.artifacts) ||
		reconciliation.artifacts.length > 8 ||
		(reconciliation.artifacts.length === 0 && provider.disposition !== "not-submitted")
	)
		throw new Error("Preserve one to eight request/output artifacts, or prove no request was submitted");
	if (new Set(reconciliation.artifacts.map((artifact) => artifact.ref)).size !== reconciliation.artifacts.length)
		throw new Error("Recovery artifact refs must be unique");
	for (const artifact of reconciliation.artifacts) readProof(artifact);
}
