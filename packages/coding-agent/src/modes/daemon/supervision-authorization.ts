import { verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSupervisionRequest, type RlmSupervisionRequest } from "./rlm-supervision.js";

/** Owner keeps the Ed25519 private key outside agent custody. No key is accepted from the request. */
export function authorizeSupervision(agentDir: string, request: RlmSupervisionRequest, signature: string): boolean {
	if (typeof signature !== "string" || signature.length > 256) return false;
	const publicKey = readFileSync(join(agentDir, "supervision-owner.pub"), "utf8");
	return verify(
		null,
		Buffer.from(JSON.stringify(normalizeSupervisionRequest(request))),
		publicKey,
		Buffer.from(signature, "base64"),
	);
}
