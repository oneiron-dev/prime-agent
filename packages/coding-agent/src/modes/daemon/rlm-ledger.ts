import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { EventLog } from "../../core/event-log.js";
import { canonicalSessionPath } from "../../core/session-lease.js";
import { getSessionArtifactPathForFile, readSessionInfo, type SessionInfo } from "../../core/session-manager.js";
import { readFirstLineSync } from "../../utils/file-lines.js";
import {
	MAX_SUPERVISION_DEPTH,
	normalizeSupervisionRequest,
	planSupervisionAdoption,
	type RlmSupervisionChange,
	type RlmSupervisionOptions,
	type RlmSupervisionReceipt,
	type RlmSupervisionRequest,
} from "./rlm-supervision.js";

/**
 * Daemon-owned RLM spawn ledger.
 *
 * One append-only JSONL file per sessions dir, written by daemon processes at
 * the moments they admit a spawn, perform a rename, or record a deletion.
 * Family topology (parent/child edges, depths, names) is read back from this
 * file instead of being re-derived from writer-owned session headers,
 * registries, and bodies at read time.
 *
 * The supervisor and session workers share this file. Writers take a common
 * filesystem guard; adoption publishes a complete replacement by atomic rename.
 * Readers cache only while file identity and metadata are unchanged. Adoption
 * requires every writer/reader to understand v2 records before activation.
 */

export const RLM_LEDGER_DIR = "rlm-ledger";

/** Bounded read: a ledger beyond these limits fails closed loudly. */
export const RLM_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const RLM_LEDGER_MAX_RECORDS = 100_000;

export type RlmLedgerDeleteReason = "user" | "parent-teardown" | "revoked" | "gc";

interface RlmLedgerMetaRecord {
	v: 1;
	op: "meta";
	at: string;
	sessionsDir: string;
}

export interface RlmLedgerSpawnRecord {
	v: 1;
	op: "spawn";
	at: string;
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
}

export interface RlmLedgerRenameRecord {
	v: 1;
	op: "rename";
	at: string;
	childId: string;
	child: string;
	name: string;
}

export interface RlmLedgerDeleteRecord {
	v: 1;
	op: "delete";
	at: string;
	childId: string;
	child: string;
	reason: RlmLedgerDeleteReason;
}

// Version 2 deliberately fails closed in old readers; unknown v1 ops would silently retain stale permissions.
export interface RlmLedgerAdoptionRecord {
	v: 2;
	op: "adopt";
	at: string;
	request: RlmSupervisionRequest;
	changes: RlmSupervisionChange[];
}

export type RlmLedgerRecord =
	| RlmLedgerSpawnRecord
	| RlmLedgerRenameRecord
	| RlmLedgerDeleteRecord
	| RlmLedgerAdoptionRecord;

/** A live edge after replaying the ledger (last-writer-wins per childId+child). */
export interface RlmLedgerEdge {
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
	deleted?: RlmLedgerDeleteReason;
}

/** Minimal registry-entry shape the seeder consumes (matches the daemon writer). */
export interface RlmLedgerSeedRegistryEntry {
	childId: string;
	sessionName: string;
	sessionFile: string;
	rlmDepth?: number;
	status: "running" | "completed" | "deleted";
}

export interface LegacyRlmSubagentRegistryEntry extends RlmLedgerSeedRegistryEntry {
	type: "rlm_subagent";
	sessionDir: string;
	parentSessionId: string;
	parentSessionFile?: string;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	createdAt: number;
	updatedAt: string;
}

export interface RlmLedgerSeedSource {
	readRegistryForSessionFile(sessionFile: string): Promise<RlmLedgerSeedRegistryEntry[]>;
}

export async function readLegacyRlmSubagentRegistry(
	path: string,
	options: { throwOnReadError?: boolean; log?: (message: string) => void } = {},
): Promise<LegacyRlmSubagentRegistryEntry[]> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			options.log?.(
				`failed to read RLM subagent registry: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (options.throwOnReadError) throw error;
		}
		return [];
	}
	const latest = new Map<string, LegacyRlmSubagentRegistryEntry>();
	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as Partial<LegacyRlmSubagentRegistryEntry>;
			if (
				entry.type !== "rlm_subagent" ||
				typeof entry.childId !== "string" ||
				typeof entry.sessionName !== "string" ||
				typeof entry.sessionFile !== "string" ||
				(entry.status !== "running" && entry.status !== "completed" && entry.status !== "deleted") ||
				(entry.rlmDepth !== undefined && (!Number.isSafeInteger(entry.rlmDepth) || entry.rlmDepth < 0))
			) {
				continue;
			}
			latest.set(entry.childId, {
				...entry,
				sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : dirname(entry.sessionFile),
				// rlmMaxDepth is optional hydration metadata the ledger seeder never
				// reads; a damaged value must not discard the child's topology edge,
				// so it is dropped instead of rejecting the whole entry.
				rlmMaxDepth:
					entry.rlmMaxDepth !== undefined && Number.isSafeInteger(entry.rlmMaxDepth) && entry.rlmMaxDepth >= 0
						? entry.rlmMaxDepth
						: undefined,
			} as LegacyRlmSubagentRegistryEntry);
		} catch (error) {
			options.log?.(
				`ignored malformed RLM subagent registry entry: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return [...latest.values()];
}

export function createRlmLedgerRegistrySeedSource(): RlmLedgerSeedSource {
	return {
		readRegistryForSessionFile: async (sessionFile) => {
			let headerId: string | undefined;
			try {
				const firstLine = readFirstLineSync(sessionFile);
				if (firstLine) {
					const header = JSON.parse(firstLine) as { id?: unknown };
					if (typeof header.id === "string") headerId = header.id;
				}
			} catch {
				return [];
			}
			if (!headerId) return [];
			return readLegacyRlmSubagentRegistry(
				join(getSessionArtifactPathForFile(sessionFile, headerId), "rlm-subagents.jsonl"),
			);
		},
	};
}

/** Canonicalize a directory: realpath when it exists, plain resolve otherwise. */
function canonicalizeDirPath(dir: string): string {
	const resolved = resolve(dir);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function rlmLedgerPath(agentDir: string, sessionsDir: string): string {
	const canonical = canonicalizeDirPath(sessionsDir);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return join(agentDir, RLM_LEDGER_DIR, `${hash}.jsonl`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isDeleteReason(value: unknown): value is RlmLedgerDeleteReason {
	return value === "user" || value === "parent-teardown" || value === "revoked" || value === "gc";
}

/**
 * Parse one ledger line. Returns undefined for a well-formed v:1 record with
 * an unknown op (readers skip them). Version 2 is accepted only for atomic
 * adoption, which intentionally breaks old readers rather than letting them
 * silently authorize requests using stale topology. All other versions fail.
 */
function parseLedgerLine(line: string, index: number): RlmLedgerRecord | RlmLedgerMetaRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(
			`Malformed RLM ledger line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const record = parsed as {
		v?: unknown;
		op?: unknown;
		at?: unknown;
		sessionsDir?: unknown;
		childId?: unknown;
		parent?: unknown;
		child?: unknown;
		depth?: unknown;
		name?: unknown;
		reason?: unknown;
	};
	if (record.v === 2 && record.op === "adopt" && typeof record.at === "string") {
		const adoption = parsed as RlmLedgerAdoptionRecord;
		normalizeSupervisionRequest(adoption.request);
		if (
			!Array.isArray(adoption.changes) ||
			adoption.changes.some(
				(change) =>
					!change ||
					[change.before, change.after].some(
						(edge) =>
							!edge ||
							typeof edge.childId !== "string" ||
							typeof edge.child !== "string" ||
							typeof edge.parent !== "string" ||
							typeof edge.name !== "string" ||
							!Number.isSafeInteger(edge.depth) ||
							edge.depth < 1 ||
							edge.deleted !== undefined,
					) ||
					change.before.child !== change.after.child ||
					change.before.childId !== change.after.childId ||
					change.before.name !== change.after.name,
			)
		) {
			throw new Error(`Malformed RLM ledger line ${index + 1}: invalid adoption record`);
		}
		return adoption;
	}
	if (record.v !== 1 || typeof record.at !== "string") {
		throw new Error(`Malformed RLM ledger line ${index + 1}: missing v/at`);
	}
	switch (record.op) {
		case "meta":
			if (typeof record.sessionsDir !== "string") {
				throw new Error(`Malformed RLM ledger line ${index + 1}: meta without sessionsDir`);
			}
			return record as unknown as RlmLedgerMetaRecord;
		case "spawn":
			if (
				typeof record.childId !== "string" ||
				typeof record.parent !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string" ||
				typeof record.depth !== "number" ||
				!Number.isSafeInteger(record.depth) ||
				record.depth < 1
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid spawn record`);
			}
			return record as unknown as RlmLedgerSpawnRecord;
		case "rename":
			if (
				typeof record.childId !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string"
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid rename record`);
			}
			return record as unknown as RlmLedgerRenameRecord;
		case "delete":
			if (typeof record.childId !== "string" || typeof record.child !== "string" || !isDeleteReason(record.reason)) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid delete record`);
			}
			return record as unknown as RlmLedgerDeleteRecord;
		default:
			return undefined;
	}
}

function edgeKey(childId: string, child: string): string {
	return `${childId}\u0000${canonicalSessionPath(child)}`;
}

interface RlmLedgerReplayCache {
	ino: number;
	size: number;
	mtimeMs: number;
	edges: ReadonlyMap<string, RlmLedgerEdge>;
	revision: string;
	adoptions: ReadonlyMap<string, { fingerprint: string; receipt: RlmSupervisionReceipt }>;
	admissionParents: ReadonlyMap<string, string>;
}

/**
 * Per-sessions-dir spawn ledger. All operations are serialized on an internal
 * queue; the first operation lazily seeds a missing ledger from the existing
 * per-parent registries (memoized; a seeding failure degrades to an empty
 * ledger and is never fail-closed).
 */
export class RlmSpawnLedger {
	private readonly path: string;
	private readonly eventLog: EventLog;
	private readonly canonicalSessionsDir: string;
	private queue: Promise<unknown> = Promise.resolve();
	private seedAttempted = false;
	private replayCache: RlmLedgerReplayCache | undefined;

	constructor(
		agentDir: string,
		sessionsDir: string,
		private readonly seedSource?: RlmLedgerSeedSource,
		private readonly log: (message: string) => void = () => {},
	) {
		this.canonicalSessionsDir = canonicalizeDirPath(sessionsDir);
		this.path = rlmLedgerPath(agentDir, sessionsDir);
		this.eventLog = new EventLog(this.path, {
			maxBytes: RLM_LEDGER_MAX_BYTES,
			maxRecords: RLM_LEDGER_MAX_RECORDS,
			log: (message) => this.log(`RLM ledger: ${message}`),
		});
	}

	get ledgerPath(): string {
		return this.path;
	}

	appendSpawn(input: { childId: string; parent: string; child: string; depth: number; name: string }): Promise<void> {
		return this.enqueue(() => this.appendSpawnUnlocked(input), true);
	}

	appendRename(input: { childId: string; child: string; name: string }): Promise<void> {
		return this.enqueue(() => {
			this.appendRecord({
				v: 1,
				op: "rename",
				at: nowIso(),
				childId: input.childId,
				child: canonicalSessionPath(input.child),
				name: input.name,
			});
		}, true);
	}

	/** Rename by child session path alone (offline saved-session rename knows no childId). */
	appendRenameByChildPath(child: string, name: string): Promise<void> {
		return this.enqueue(() => {
			const target = canonicalSessionPath(child);
			for (const edge of this.replaySync().values()) {
				if (!edge.deleted && canonicalSessionPath(edge.child) === target) {
					this.appendRecord({ v: 1, op: "rename", at: nowIso(), childId: edge.childId, child: target, name });
				}
			}
		}, true);
	}

	appendDelete(input: { childId: string; child: string; reason: RlmLedgerDeleteReason }): Promise<void> {
		return this.enqueue(() => {
			this.appendRecord({
				v: 1,
				op: "delete",
				at: nowIso(),
				childId: input.childId,
				child: canonicalSessionPath(input.child),
				reason: input.reason,
			});
		}, true);
	}

	/** Resolves once every operation enqueued so far has completed (durably, for appends). */
	flush(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/**
	 * Replay edges without liveness reconciliation. Deleted edges are filtered
	 * by default; `includeDeleted` keeps the tombstones (marked with their
	 * delete reason) for consumers that need a deleted child's identity, such
	 * as cleanup retries.
	 */
	edges(includeDeleted = false): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() =>
			[...this.replaySync().values()].filter((edge) => includeDeleted || !edge.deleted).map((edge) => ({ ...edge })),
		);
	}

	/**
	 * Family of every session rooted in this ledger's sessions dir: bounded
	 * readdir of *.jsonl roots as depth-0 rows plus live ledger edges, both
	 * reconciled by stat (a dead parent or child drops the edge). Depths are
	 * verified parent+1 between ledger-known depths; a contradictory edge is
	 * dropped and logged, never fails the whole family.
	 */
	family(): Promise<SessionInfo[]> {
		return this.enqueue(() => this.familyUnlocked());
	}

	/** Same-parent rows for a child session path, including the child itself. */
	siblings(sessionPath: string): Promise<SessionInfo[]> {
		return this.enqueue(async () => {
			const target = canonicalSessionPath(sessionPath);
			const family = await this.familyUnlocked();
			const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
			const parentByChild = new Map(
				edges.map((edge) => [canonicalSessionPath(edge.child), canonicalSessionPath(edge.parent)]),
			);
			const parent = parentByChild.get(target);
			if (parent !== undefined) {
				const rows = family.filter((row) => parentByChild.get(canonicalSessionPath(row.path)) === parent);
				// The target's edge can be reconciliation-dropped (parent file
				// gone) while its own file still exists: fall back to presenting
				// the survivor alone rather than an empty set the callers would
				// read as "session not found".
				if (!rows.some((row) => canonicalSessionPath(row.path) === target)) {
					try {
						if ((await stat(target)).isFile()) {
							return [await this.sessionRow(target, 0, undefined, undefined)];
						}
					} catch {
						// fall through to the (possibly empty) sibling rows
					}
				}
				return rows;
			}
			// Roots are siblings of the other roots. A session outside both the
			// ledger and the sessions dir is presented alone (matching the
			// registry-walking reader's behavior for parentless sessions).
			const roots = family.filter((row) => row.rlmDepth === 0);
			if (roots.some((row) => canonicalSessionPath(row.path) === target)) {
				return roots;
			}
			try {
				if (!(await stat(target)).isFile()) return [];
			} catch {
				return [];
			}
			return [await this.sessionRow(target, 0, undefined, undefined)];
		});
	}

	private enqueue<T>(fn: () => Promise<T> | T, write = false): Promise<T> {
		const next = this.queue.then(async () => {
			if (!this.seedAttempted) {
				this.seedAttempted = true;
				try {
					await this.seed();
				} catch (error) {
					this.log(`RLM ledger seeding failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return write ? this.withWriteGuard(fn) : fn();
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async withWriteGuard<T>(fn: () => Promise<T> | T): Promise<T> {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.path, {
			realpath: false,
			lockfilePath: `${this.path}.guard`,
			stale: 30_000,
			retries: { retries: 20, factor: 1, minTimeout: 10, maxTimeout: 10 },
		});
		try {
			return await fn();
		} finally {
			await release();
		}
	}

	/** Read the current committed edge; never use transcript parent metadata as authority over it. */
	admissionParent(child: string): string | undefined {
		this.replaySync();
		return this.replayCache?.admissionParents.get(canonicalSessionPath(child));
	}

	supervisionEdge(child: string): RlmLedgerEdge | undefined {
		const path = canonicalSessionPath(child);
		return [...this.replaySync().values()].find((edge) => edge.child === path && !edge.deleted);
	}

	supervisionSnapshot(): Promise<{ revision: string; edges: RlmLedgerEdge[] }> {
		return this.enqueue(() => {
			const edges = [...this.replaySync().values()].map((edge) => ({ ...edge }));
			return { revision: this.replayCache?.revision ?? createHash("sha256").digest("hex"), edges };
		});
	}

	/** Atomic ledger publication with an optional same-worker resident custody commit. */
	adoptBatch(input: RlmSupervisionRequest, options: RlmSupervisionOptions): Promise<RlmSupervisionReceipt> {
		return this.enqueue(() => {
			const request = normalizeSupervisionRequest(input);
			if (!options || typeof options.authorize !== "function") throw new Error("Owner authorization is required");
			if (options.authorize(structuredClone(request)) !== true)
				throw new Error("Owner authorization and runtime custody fence are required");
			const edges = [...this.replaySync().values()];
			const fingerprint = JSON.stringify(request);
			const prior = this.replayCache?.adoptions.get(request.operationId);
			if (prior) {
				if (prior.fingerprint !== fingerprint)
					throw new Error("Supervision operation ID was reused with another request");
				return structuredClone(prior.receipt);
			}
			const revision = this.replayCache?.revision ?? createHash("sha256").digest("hex");
			if (request.expectedRevision !== revision) throw new Error("Supervision topology revision CAS failed");
			const roots = new Set<string>();
			for (const edge of edges) {
				if (edge.deleted) continue;
				for (const path of [edge.child, edge.parent]) {
					if (dirname(path) === this.canonicalSessionsDir) roots.add(path);
				}
			}
			const changes = planSupervisionAdoption(request, edges, roots, options.maxDepthBySession);
			const parents = new Map(edges.filter((edge) => !edge.deleted).map((edge) => [edge.child, edge.parent]));
			const required = new Set([
				request.ownerRoot,
				...request.moves.flatMap((move) => [move.child, move.parent]),
				...changes.map((change) => change.after.child),
			]);
			for (const path of required) {
				const parent = parents.get(path);
				if (parent) required.add(parent);
				if (!statSync(path).isFile()) throw new Error("Supervision session file is unavailable");
			}
			const commit = options.prepareRuntime?.(changes);
			this.publishAdoption({ v: 2, op: "adopt", at: nowIso(), request, changes }, commit);
			this.replaySync();
			return structuredClone(this.replayCache!.adoptions.get(request.operationId)!.receipt);
		}, true);
	}

	private publishAdoption(record: RlmLedgerAdoptionRecord, commit?: () => void): void {
		const original = readFileSync(this.path);
		if (original.length && original[original.length - 1] !== 0x0a) {
			throw new Error("Cannot adopt with an unterminated ledger tail; reconcile the interrupted writer first");
		}
		const payload = Buffer.concat([original, Buffer.from(`${JSON.stringify(record)}\n`)]);
		if (
			payload.length > RLM_LEDGER_MAX_BYTES ||
			original.toString("utf8").split("\n").length > RLM_LEDGER_MAX_RECORDS
		) {
			throw new Error("Supervision adoption exceeds ledger bounds");
		}
		const temp = `${this.path}.adopt-${process.pid}-${Date.now()}`;
		const handle = openSync(temp, "wx", 0o600);
		try {
			let offset = 0;
			while (offset < payload.length) {
				const written = writeSync(handle, payload, offset, payload.length - offset);
				if (written <= 0) throw new Error("Short supervision ledger write");
				offset += written;
			}
			fsyncSync(handle);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		} finally {
			closeSync(handle);
		}
		try {
			renameSync(temp, this.path);
			this.replayCache = undefined;
			commit?.();
			const directory = openSync(dirname(this.path), "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		} finally {
			rmSync(temp, { force: true });
		}
	}

	private appendSpawnUnlocked(input: {
		childId: string;
		parent: string;
		child: string;
		depth: number;
		name: string;
	}): void {
		// Enforce the same invariants parseLedgerLine checks: never write a
		// record this reader would refuse to read back.
		if (!input.childId || !input.parent || !input.child || !Number.isSafeInteger(input.depth) || input.depth < 1) {
			throw new Error(
				`RLM ledger: invalid spawn for ${input.childId || "<missing childId>"} (depth ${input.depth})`,
			);
		}
		const childPath = canonicalSessionPath(input.child);
		// The writer guard covers this identity check and append. Mixed old
		// writers do not hold that guard and must be fenced before adoption.
		for (const edge of this.replaySync().values()) {
			if (
				!edge.deleted &&
				canonicalSessionPath(edge.child) === childPath &&
				this.replayCache?.adoptions.size &&
				(edge.parent !== canonicalSessionPath(input.parent) || edge.depth !== input.depth)
			) {
				throw new Error("RLM spawn cannot overwrite adopted topology");
			}
			if (!edge.deleted && canonicalSessionPath(edge.child) === childPath && edge.childId !== input.childId) {
				throw new Error(`RLM ledger: duplicate child session path ${childPath} (already ${edge.childId})`);
			}
		}
		this.appendRecord({
			v: 1,
			op: "spawn",
			at: nowIso(),
			childId: input.childId,
			parent: canonicalSessionPath(input.parent),
			child: childPath,
			depth: input.depth,
			name: input.name,
		});
	}

	/** Live edges reconciled by stat, exactly like family(): a dead parent or child drops the edge. */
	liveEdges(): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() => this.liveEdgesUnlocked());
	}

	private async liveEdgesUnlocked(
		edges = [...this.replaySync().values()].filter((edge) => !edge.deleted),
	): Promise<RlmLedgerEdge[]> {
		const statCache = new Map<string, boolean>();
		const exists = async (path: string): Promise<boolean> => {
			const cached = statCache.get(path);
			if (cached !== undefined) return cached;
			let ok = false;
			try {
				ok = (await stat(path)).isFile();
			} catch {
				ok = false;
			}
			statCache.set(path, ok);
			return ok;
		};
		const alive: RlmLedgerEdge[] = [];
		for (const edge of edges) {
			if ((await exists(canonicalSessionPath(edge.child))) && (await exists(canonicalSessionPath(edge.parent)))) {
				alive.push(edge);
			}
		}
		return alive;
	}

	private async familyUnlocked(): Promise<SessionInfo[]> {
		// One replay, one stat snapshot: byChild comes from the same alive set that emits child rows,
		// so a child whose dead edge was reconciled away degrades to a root row instead of vanishing.
		let alive: RlmLedgerEdge[] = await this.liveEdgesUnlocked(
			[...this.replaySync().values()].filter((candidate) => !candidate.deleted),
		);
		const byChild = new Map<string, RlmLedgerEdge>();
		for (const edge of alive) {
			byChild.set(canonicalSessionPath(edge.child), edge);
		}
		const rootPaths: string[] = [];
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			rootEntries = [];
		}
		for (const entry of rootEntries.filter((name) => name.endsWith(".jsonl")).sort()) {
			const path = canonicalSessionPath(join(this.canonicalSessionsDir, entry));
			// Ledger children that live directly in the sessions dir are not roots.
			if (byChild.has(path)) continue;
			rootPaths.push(path);
		}
		// Verify depth monotonicity between ledger-known depths only: a root's
		// presented depth of 0 is a display convention, not an assertion (a
		// nested daemon's roots legitimately carry env-derived depths > 0). A
		// contradictory edge is dropped and logged; one bad edge must not fail
		// the whole family.
		const depthByPath = new Map<string, number>();
		for (const edge of alive) {
			depthByPath.set(canonicalSessionPath(edge.child), edge.depth);
		}
		alive = alive.filter((edge) => {
			const parentDepth = depthByPath.get(canonicalSessionPath(edge.parent));
			if (parentDepth !== undefined && edge.depth !== parentDepth + 1) {
				this.log(
					`RLM ledger: dropped edge ${edge.childId} with contradictory depth (parent ${parentDepth}, child ${edge.depth})`,
				);
				return false;
			}
			return true;
		});
		const rows: SessionInfo[] = [];
		for (const rootPath of rootPaths) {
			rows.push(await this.sessionRow(rootPath, 0, undefined, undefined));
		}
		for (const edge of alive) {
			rows.push(
				await this.sessionRow(
					canonicalSessionPath(edge.child),
					edge.depth,
					canonicalSessionPath(edge.parent),
					edge.name,
				),
			);
		}
		return rows;
	}

	private async sessionRow(
		path: string,
		depth: number,
		parentPath: string | undefined,
		name: string | undefined,
	): Promise<SessionInfo> {
		// Display-grade fields are best-effort from the ordinary session-info
		// read; topology (path, depth, parent) comes EXCLUSIVELY from the
		// ledger: header-claimed parentSessionPath/rlmDepth (e.g. fork headers)
		// are stripped, never passed through. For roots the ledger carries no
		// name, so the name comes from this read — writer-owned display data,
		// not authority.
		const info = await readSessionInfo(path).catch(() => null);
		if (info) {
			const { parentSessionPath: _headerParent, rlmDepth: _headerDepth, ...display } = info;
			return {
				...display,
				rlmDepth: depth,
				...(parentPath ? { parentSessionPath: parentPath } : {}),
				...(name ? { name } : {}),
			};
		}
		return {
			path,
			id: basename(path, ".jsonl"),
			cwd: "",
			...(name ? { name } : {}),
			...(parentPath ? { parentSessionPath: parentPath } : {}),
			rlmDepth: depth,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
	}

	private async seed(): Promise<void> {
		if (!this.seedSource || existsSync(this.path)) return;
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			return;
		}
		// Collect the complete seed first, then publish it atomically via a
		// temp file + rename: the ledger file only exists once seeding is
		// complete, so an interrupted seed leaves nothing and the next
		// construction re-seeds from scratch. A concurrent process appending
		// before the rename creates the real file on demand and thereby
		// suppresses this seed — the same behavior as any pre-existing ledger.
		const records: RlmLedgerSpawnRecord[] = [];
		const queue: Array<{ sessionFile: string; depth: number }> = rootEntries
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.map((name) => ({ sessionFile: join(this.canonicalSessionsDir, name), depth: 0 }));
		const visited = new Set<string>(queue.map((item) => canonicalSessionPath(item.sessionFile)));
		while (queue.length > 0) {
			const { sessionFile, depth } = queue.shift()!;
			for (const entry of await this.seedSource.readRegistryForSessionFile(sessionFile)) {
				if (entry.status === "deleted") continue;
				const childPath = canonicalSessionPath(entry.sessionFile);
				if (visited.has(childPath)) continue;
				visited.add(childPath);
				// A registry depth < 1 (legacy 0-depth entries exist in real data)
				// would be unwritable under the spawn invariants; treat it as
				// absent and derive parent depth + 1 instead of skipping the edge.
				const registryDepth = entry.rlmDepth !== undefined && entry.rlmDepth >= 1 ? entry.rlmDepth : undefined;
				const childDepth = registryDepth ?? depth + 1;
				if (!entry.childId) {
					this.log("RLM ledger: skipped seeding a registry entry without a childId");
					continue;
				}
				records.push({
					v: 1,
					op: "spawn",
					at: nowIso(),
					childId: entry.childId,
					parent: canonicalSessionPath(sessionFile),
					child: childPath,
					depth: childDepth,
					name: entry.sessionName,
				});
				queue.push({ sessionFile: entry.sessionFile, depth: childDepth });
			}
		}
		if (records.length === 0) return;
		const meta: RlmLedgerMetaRecord = { v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir };
		const payload = [meta, ...records].map((record) => `${JSON.stringify(record)}\n`).join("");
		// A seed beyond the read bounds would publish a ledger every replaySync
		// refuses to read — manufacturing the exact poisoned state the bounds
		// exist to prevent. Skip seeding entirely (flat families, the documented
		// degradation mode) rather than publishing partial topology: profiles
		// this large are pathological, and a truncated tree would be more
		// confusing than a flat one. Not thrown: a hard error here would stick
		// via seedAttempted and the next append would create an empty ledger.
		if (records.length + 1 > RLM_LEDGER_MAX_RECORDS || Buffer.byteLength(payload) > RLM_LEDGER_MAX_BYTES) {
			this.log(
				`RLM ledger: seed exceeds read bounds (${records.length} records, ${Buffer.byteLength(payload)} bytes); skipping seeding`,
			);
			return;
		}
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = `${this.path}.seed-${process.pid}-${Date.now()}`;
		const handle = openSync(tempPath, "wx", 0o600);
		try {
			writeSync(handle, payload);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		try {
			this.publishSeedFile(tempPath);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}

	private publishSeedFile(tempPath: string): void {
		// Atomic no-clobber publish: link() fails with EEXIST if a live append
		// created the real file meanwhile — that append wins (its data is
		// fresher than the registries) and the seed is discarded. No-clobber
		// publication is a hard requirement for seeding: post-consolidation,
		// deletes live only in the ledger, so any clobber window can lose live
		// appends and resurrect deleted edges. Filesystems that cannot provide
		// link() therefore get flat pre-ledger history (the documented
		// degradation mode) rather than a check-then-rename race.
		try {
			linkSync(tempPath, this.path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				return;
			}
			this.log(`RLM ledger: link publish unavailable (${code ?? "unknown"}); skipping seeding`);
		}
	}

	private appendRecord(record: RlmLedgerRecord): void {
		this.replayCache = undefined;
		this.eventLog.appendSync([record], {
			durable: true,
			onCreate: () => [
				{ v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir } satisfies RlmLedgerMetaRecord,
			],
		});
	}

	private replaySync(): ReadonlyMap<string, RlmLedgerEdge> {
		const edges = new Map<string, RlmLedgerEdge>();
		if (!existsSync(this.path)) {
			this.replayCache = undefined;
			return edges;
		}
		const stats = statSync(this.path);
		if (stats.size > RLM_LEDGER_MAX_BYTES) {
			throw new Error(
				`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_BYTES} bytes (${stats.size}); refusing to read`,
			);
		}
		const cached = this.replayCache;
		if (cached && cached.ino === stats.ino && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
			return cached.edges;
		}
		const records = this.eventLog.replaySync((line, index) => {
			const record = parseLedgerLine(line, index);
			if (record === undefined) {
				this.log(`RLM ledger: skipped record with unknown op on line ${index + 1}`);
			}
			return record;
		});
		const digest = createHash("sha256");
		const admissionParents = new Map<string, string>();
		const adoptions = new Map<string, { fingerprint: string; receipt: RlmSupervisionReceipt }>();
		for (const record of records) {
			const previousRevision = digest.copy().digest("hex");
			digest.update(`${JSON.stringify(record)}\n`);
			if (record.op === "meta") continue;
			if (record.op === "adopt") {
				if (record.request.expectedRevision !== previousRevision || adoptions.has(record.request.operationId)) {
					throw new Error("Malformed RLM ledger adoption revision or operation ID");
				}
				const roots = new Set(
					[...edges.values()]
						.flatMap((edge) => [edge.parent, edge.child])
						.filter((path) => dirname(path) === this.canonicalSessionsDir),
				);
				const limits = new Map([...edges.values()].map((edge) => [edge.child, MAX_SUPERVISION_DEPTH]));
				const expected = planSupervisionAdoption(record.request, [...edges.values()], roots, limits);
				if (JSON.stringify(expected) !== JSON.stringify(record.changes))
					throw new Error("Malformed RLM ledger adoption change set");
				const changed = new Set<string>();
				for (const change of record.changes) {
					const key = edgeKey(change.before.childId, change.before.child);
					if (changed.has(key) || JSON.stringify(edges.get(key)) !== JSON.stringify(change.before)) {
						throw new Error("Malformed RLM ledger adoption old-edge CAS");
					}
					changed.add(key);
				}
				for (const change of record.changes) {
					edges.set(edgeKey(change.after.childId, change.after.child), { ...change.after });
				}
				adoptions.set(record.request.operationId, {
					fingerprint: JSON.stringify(record.request),
					receipt: {
						operationId: record.request.operationId,
						previousRevision,
						revision: digest.copy().digest("hex"),
						changes: record.changes,
					},
				});
				continue;
			}
			const key = edgeKey(record.childId, record.child);
			switch (record.op) {
				case "spawn":
					if (!admissionParents.has(record.child)) admissionParents.set(record.child, record.parent);
					edges.set(key, {
						childId: record.childId,
						parent: record.parent,
						child: record.child,
						depth: record.depth,
						name: record.name,
					});
					break;
				case "rename": {
					const existing = edges.get(key);
					if (existing) existing.name = record.name;
					break;
				}
				case "delete": {
					const existing = edges.get(key);
					if (existing) existing.deleted = record.reason;
					break;
				}
			}
		}
		this.replayCache = {
			ino: stats.ino,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			edges,
			revision: digest.digest("hex"),
			adoptions,
			admissionParents,
		};
		return edges;
	}
}

// The catalog scan never visits session-artifacts, where RLM children persist:
// without this merge a passivated descendant's row (and its spend) survives only
// as long as some resident roster remembers it.
export async function withPassiveRlmDescendantInfos(
	savedSessions: SessionInfo[],
	ledger: RlmSpawnLedger,
	options: { cwd?: string; onSession?: (info: SessionInfo) => void; log?: (message: string) => void } = {},
): Promise<SessionInfo[]> {
	const sessions = [...savedSessions];
	const seen = new Set(savedSessions.map((info) => canonicalSessionPath(info.path)));
	let edges: RlmLedgerEdge[];
	try {
		edges = await ledger.liveEdges();
	} catch (error) {
		// A broken ledger must not take the whole catalog down with it.
		options.log?.(`Could not merge passive RLM descendants: ${String(error)}`);
		return sessions;
	}
	for (const edge of edges) {
		const childPath = canonicalSessionPath(edge.child);
		if (seen.has(childPath)) continue;
		seen.add(childPath);
		const info = await readSessionInfo(childPath);
		if (!info) continue;
		if (options.cwd !== undefined && (!info.cwd || resolve(info.cwd) !== resolve(options.cwd))) continue;
		// The ledger edge is the authoritative topology (family() semantics); a fork
		// can leave the transcript header pointing at a dead ancestor path.
		const merged: SessionInfo = {
			...info,
			parentSessionPath: edge.parent,
			rlmDepth: edge.depth,
		};
		sessions.push(merged);
		options.onSession?.(merged);
	}
	return sessions;
}

// Shared user-delete policy: only a readable no-parent transcript is positively top-level; children and
// unknown targets tombstone via the ledger BEFORE the file delete (a tombstoned-but-undeleted file is
// the accepted orphan of a failed delete).
export async function tombstoneSavedSessionDelete(
	ledger: RlmSpawnLedger,
	sessionPath: string,
	knownSummary: { runtimeKind?: "top-level" | "subagent" } | undefined,
): Promise<{ deletedInfo: SessionInfo | undefined; ledgerEdge: RlmLedgerEdge | undefined }> {
	const deletedPath = canonicalSessionPath(sessionPath);
	const deletedInfo = (await readSessionInfo(sessionPath).catch(() => null)) ?? undefined;
	const knownChild =
		knownSummary?.runtimeKind === "subagent" ||
		deletedInfo?.parentSessionPath !== undefined ||
		(deletedInfo?.rlmDepth ?? 0) > 0;
	const positivelyTopLevel = !knownChild && (knownSummary !== undefined || deletedInfo !== undefined);
	if (positivelyTopLevel) return { deletedInfo, ledgerEdge: undefined };
	const edges = await ledger.edges();
	// Tombstone every matching edge: a duplicate edge for the path (corrupt or raced appends) left
	// live would resurrect a later recreation at that path as a subagent.
	const matching = edges.filter((edge) => canonicalSessionPath(edge.child) === deletedPath);
	for (const edge of matching) {
		await ledger.appendDelete({ childId: edge.childId, child: sessionPath, reason: "user" });
	}
	return { deletedInfo, ledgerEdge: matching[0] };
}
