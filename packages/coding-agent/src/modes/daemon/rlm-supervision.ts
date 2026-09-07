import { canonicalSessionPath } from "../../core/session-lease.js";
import type { RlmLedgerEdge } from "./rlm-ledger.js";

export const MAX_SUPERVISION_BATCH_MOVES = 256;
export const MAX_SUPERVISION_DEPTH = 64;

export interface RlmSupervisionMove {
	childId: string;
	child: string;
	expectedParent: string;
	parent: string;
}

export interface RlmSupervisionRequest {
	operationId: string;
	expectedRevision: string;
	ownerRoot: string;
	moves: RlmSupervisionMove[];
}

export interface RlmSupervisionChange {
	before: RlmLedgerEdge;
	after: RlmLedgerEdge;
}

export interface RlmSupervisionReceipt {
	operationId: string;
	previousRevision: string;
	revision: string;
	changes: RlmSupervisionChange[];
}

/** Internal trust boundary, not a wire-supplied authorization assertion. */
export interface RlmSupervisionOptions {
	/** Must check owner authority AND hold the live runtime custody fence. Throw if either is unavailable. */
	authorize(request: Readonly<RlmSupervisionRequest>): boolean;
	/** Effective persisted/runtime limits, supplied by the host, never chosen by the request. */
	maxDepthBySession: ReadonlyMap<string, number>;
	/** Synchronous preflight returns a no-I/O, non-throwing resident commit. */
	prepareRuntime?(changes: readonly RlmSupervisionChange[]): () => void;
}

export function normalizeSupervisionRequest(input: RlmSupervisionRequest): RlmSupervisionRequest {
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.operationId !== "string" ||
		!/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationId) ||
		typeof input.expectedRevision !== "string" ||
		!input.expectedRevision ||
		typeof input.ownerRoot !== "string" ||
		!input.ownerRoot ||
		!Array.isArray(input.moves) ||
		input.moves.length < 1 ||
		input.moves.length > MAX_SUPERVISION_BATCH_MOVES
	) {
		throw new Error("Invalid supervision adoption request");
	}
	const moves = input.moves.map((move) => {
		if (
			!move ||
			[move.childId, move.child, move.expectedParent, move.parent].some(
				(value) => typeof value !== "string" || !value,
			)
		) {
			throw new Error("Invalid supervision adoption move");
		}
		return {
			childId: move.childId,
			child: canonicalSessionPath(move.child),
			expectedParent: canonicalSessionPath(move.expectedParent),
			parent: canonicalSessionPath(move.parent),
		};
	});
	return {
		operationId: input.operationId,
		expectedRevision: input.expectedRevision,
		ownerRoot: canonicalSessionPath(input.ownerRoot),
		moves,
	};
}

/** Validate the complete final graph before publishing any edge. Paths and child IDs remain unchanged. */
export function planSupervisionAdoption(
	request: RlmSupervisionRequest,
	edges: readonly RlmLedgerEdge[],
	roots: ReadonlySet<string>,
	maxDepthBySession: ReadonlyMap<string, number>,
): RlmSupervisionChange[] {
	const byChild = new Map<string, RlmLedgerEdge>();
	for (const edge of edges) {
		if (edge.deleted) continue;
		const child = canonicalSessionPath(edge.child);
		if (byChild.has(child)) throw new Error("Ambiguous supervision child identity");
		byChild.set(child, { ...edge, child, parent: canonicalSessionPath(edge.parent) });
	}
	if (!roots.has(request.ownerRoot) || byChild.has(request.ownerRoot))
		throw new Error("Supervision owner must be a known root");
	const trace = (path: string, graph: ReadonlyMap<string, RlmLedgerEdge>): { root: string; depth: number } => {
		const seen = new Set<string>();
		let cursor = path;
		let depth = 0;
		while (graph.has(cursor)) {
			if (seen.has(cursor)) throw new Error("Supervision adoption creates a cycle");
			seen.add(cursor);
			cursor = graph.get(cursor)!.parent;
			if (++depth > MAX_SUPERVISION_DEPTH) throw new Error("Supervision depth exceeds hard bound");
		}
		if (!roots.has(cursor)) throw new Error("Supervision parent is missing or outside this ledger");
		return { root: cursor, depth };
	};
	const final = new Map([...byChild].map(([path, edge]) => [path, { ...edge }]));
	const moved = new Set<string>();
	for (const move of request.moves) {
		if (moved.has(move.child)) throw new Error("Duplicate supervision adoption child");
		moved.add(move.child);
		const existing = byChild.get(move.child);
		if (!existing || existing.childId !== move.childId)
			throw new Error("Cannot adopt a root, deleted, or unknown child");
		if (existing.parent !== move.expectedParent) throw new Error("Supervision old-parent CAS failed");
		if (move.child === move.parent) throw new Error("Cannot adopt an agent under itself");
		if (
			trace(move.child, byChild).root !== request.ownerRoot ||
			trace(move.parent, byChild).root !== request.ownerRoot
		) {
			throw new Error("Cross-root supervision adoption is not authorized");
		}
		for (const endpoint of [move.child, move.parent]) {
			let cursor = endpoint;
			while (byChild.has(cursor)) {
				const ancestor = byChild.get(cursor)!;
				if (ancestor.depth !== trace(cursor, byChild).depth)
					throw new Error("Existing supervision depth is inconsistent");
				cursor = ancestor.parent;
			}
		}
		final.get(move.child)!.parent = move.parent;
	}
	const children = new Map<string, string[]>();
	for (const [path, edge] of byChild) {
		const siblings = children.get(edge.parent) ?? [];
		siblings.push(path);
		children.set(edge.parent, siblings);
	}
	const affected = new Set(moved);
	for (const path of affected) {
		for (const child of children.get(path) ?? []) affected.add(child);
	}
	const affectedParents = new Set([...affected].map((path) => final.get(path)!.parent));
	const names = new Set<string>();
	const childIds = new Set<string>();
	for (const edge of final.values()) {
		if (!affectedParents.has(edge.parent)) continue;
		const nameKey = JSON.stringify([edge.parent, edge.name]);
		const idKey = JSON.stringify([edge.parent, edge.childId]);
		if (names.has(nameKey) || childIds.has(idKey))
			throw new Error("Supervision adoption creates a sibling name or child ID collision");
		names.add(nameKey);
		childIds.add(idKey);
	}
	const changes: RlmSupervisionChange[] = [];
	for (const [path, edge] of final) {
		if (!affected.has(path)) continue;
		const result = trace(path, final);
		if (result.root !== request.ownerRoot) throw new Error("Cross-root supervision adoption is not authorized");
		const before = byChild.get(path)!;
		const original = trace(path, byChild);
		if (before.depth !== original.depth) throw new Error("Existing supervision depth is inconsistent");
		edge.depth = result.depth;
		if (before.parent !== edge.parent || before.depth !== edge.depth) {
			const maxDepth = maxDepthBySession.get(path);
			if (
				maxDepth === undefined ||
				!Number.isSafeInteger(maxDepth) ||
				maxDepth < 0 ||
				maxDepth > MAX_SUPERVISION_DEPTH
			) {
				throw new Error("Missing or invalid effective session depth limit");
			}
			if (edge.depth > maxDepth) throw new Error("Supervision adoption exceeds a session depth limit");
			changes.push({ before: { ...before }, after: { ...edge } });
		}
	}
	return changes;
}
