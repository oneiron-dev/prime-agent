import { resolve } from "node:path";
import { canonicalSessionPath } from "../../core/session-lease.js";
import { looksLikeSessionPath } from "../../core/session-resolver.js";
import type { DaemonStableSessionTarget, DaemonStableTargetFailureReason } from "./daemon-protocol.js";
import type { SessionSummary } from "./daemon-session-list.js";

/**
 * Durable addressing for the terminal `follow_up` lane.
 *
 * A retained RLM child that the daemon has passivated keeps its durable
 * sessionId and sessionFile but loses its ephemeral activeSessionId, so an
 * active-id-only follow_up answers "Unknown active session" and the reminder is
 * dropped. These helpers give the supervisor and the session host one shared,
 * strictly conjunctive matching rule so neither layer can fall back to a root,
 * the Board, the newest row, or any other session.
 */

/** Upper bound on a durable coordinate. Keeps refusals cheap and wire-bounded. */
const MAX_STABLE_COORDINATE_CHARS = 4096;

/** A typed refusal of a stable follow-up target. Never an opaque success. */
export class StableFollowUpTargetError extends Error {
	constructor(
		readonly reason: DaemonStableTargetFailureReason,
		readonly target: DaemonStableSessionTarget,
		message: string,
	) {
		super(message);
		this.name = "StableFollowUpTargetError";
	}
}

export interface NormalizedStableSessionTarget {
	sessionId?: string;
	sessionFile?: string;
}

/**
 * Two paths denote the same session file.
 *
 * The passive registry keys by `resolve()` while the supervisor roster keys by
 * realpath, so a match on either canonicalization is the same target. A missing
 * path never matches: an unproven coordinate must not satisfy a conjunction.
 */
export function sessionFilePathsMatch(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	if (resolve(left) === resolve(right)) return true;
	return canonicalSessionPath(left) === canonicalSessionPath(right);
}

/** Validate the caller's coordinates before any lookup, roster read, or delivery. */
export function normalizeStableSessionTarget(target: DaemonStableSessionTarget): NormalizedStableSessionTarget {
	const echo: DaemonStableSessionTarget = {
		...(typeof target?.sessionId === "string" ? { sessionId: target.sessionId.slice(0, 256) } : {}),
		...(typeof target?.sessionFile === "string" ? { sessionFile: target.sessionFile.slice(0, 1024) } : {}),
	};
	if (target === null || typeof target !== "object") {
		throw new StableFollowUpTargetError("invalid_target", {}, "Stable follow-up target must be an object");
	}
	for (const field of ["sessionId", "sessionFile"] as const) {
		const value = target[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_STABLE_COORDINATE_CHARS) {
			throw new StableFollowUpTargetError(
				"invalid_target",
				echo,
				`Stable follow-up target ${field} must be a bounded non-empty string`,
			);
		}
	}
	const sessionId = target.sessionId?.trim();
	const sessionFile = target.sessionFile?.trim();
	if (!sessionId && !sessionFile) {
		throw new StableFollowUpTargetError(
			"missing_identity",
			echo,
			"Stable follow-up target requires a sessionId, a sessionFile, or both",
		);
	}
	if (sessionFile !== undefined && !looksLikeSessionPath(sessionFile)) {
		throw new StableFollowUpTargetError(
			"invalid_target",
			echo,
			`Stable follow-up target sessionFile is not a session path: ${sessionFile}`,
		);
	}
	return {
		...(sessionId ? { sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
	};
}

/** Does this candidate satisfy every supplied coordinate? Conjunctive by construction. */
export function matchesStableSessionTarget(
	candidate: { sessionId?: string; sessionFile?: string },
	target: NormalizedStableSessionTarget,
): boolean {
	if (target.sessionId !== undefined && candidate.sessionId !== target.sessionId) return false;
	if (target.sessionFile !== undefined && !sessionFilePathsMatch(candidate.sessionFile, target.sessionFile)) {
		return false;
	}
	return true;
}

/**
 * Distinguish "these coordinates describe different sessions" from "no such
 * session". Only meaningful when the caller supplied both coordinates: a single
 * coordinate cannot disagree with itself.
 */
export function isStableTargetIdentityMismatch(
	candidates: readonly { sessionId?: string; sessionFile?: string }[],
	target: NormalizedStableSessionTarget,
): boolean {
	if (target.sessionId === undefined || target.sessionFile === undefined) return false;
	const byId = candidates.some((candidate) => candidate.sessionId === target.sessionId);
	const byFile = candidates.some((candidate) => sessionFilePathsMatch(candidate.sessionFile, target.sessionFile));
	return byId || byFile;
}

/**
 * A stable follow-up target must be a retained child, proven by durable
 * metadata rather than by current residency: a child hydrated as a top-level
 * runtime is still a child. Roots — including the owner-facing Board — carry no
 * spawn lineage and are refused, so this lane can never deliver a lane reminder
 * to a root even when a caller passes root coordinates explicitly.
 */
export function isStableFollowUpChildTarget(
	summary: Pick<SessionSummary, "runtimeKind" | "parentSessionPath" | "parentSessionId" | "rlmChildId" | "rlmDepth">,
): boolean {
	return (
		summary.runtimeKind === "subagent" ||
		summary.rlmChildId !== undefined ||
		summary.parentSessionPath !== undefined ||
		summary.parentSessionId !== undefined ||
		(summary.rlmDepth ?? 0) > 0
	);
}

/**
 * Reject a matched row whose durable metadata is unusable. A row that cannot
 * prove both coordinates cannot satisfy a conjunctive target, and a row with no
 * spawn lineage is a root.
 */
export function assertStableFollowUpTargetUsable(
	summary: Pick<
		SessionSummary,
		"runtimeKind" | "parentSessionPath" | "parentSessionId" | "rlmChildId" | "rlmDepth" | "sessionId" | "sessionFile"
	>,
	target: NormalizedStableSessionTarget,
): void {
	if (typeof summary.sessionId !== "string" || summary.sessionId.length === 0 || !summary.sessionFile) {
		throw new StableFollowUpTargetError(
			"invalid_target",
			target,
			"Stable follow-up target has corrupt session metadata: no durable session id and file",
		);
	}
	if (!isStableFollowUpChildTarget(summary)) {
		throw new StableFollowUpTargetError(
			"unsupported_target",
			target,
			"Stable follow-up targets a root session; this lane addresses retained child sessions only",
		);
	}
}
