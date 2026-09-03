/**
 * Deep compaction: resumable, bounded-parallel map-reduce summarization.
 *
 * Ordinary compaction rolls one summary forward chunk by chunk. Deep compaction
 * summarizes every chunk independently and merges the partials hierarchically, so
 * a very long branch keeps its middle detail. Two properties make that affordable
 * on real sessions:
 *
 * - Seeding: the caller prepares from the newest readable checkpoint, so already
 *   summarized history is carried in as text instead of being re-read from root.
 * - Resumability: every completed map partial is written to a durable per-run
 *   cache keyed by a deterministic run identity (source preparation, ordered chunk
 *   content, model, thinking level, settings, custom instructions). A cancelled run
 *   resumes from those partials; anything stale or mismatched is recomputed.
 *
 * The cache is advisory: any filesystem failure degrades to recomputation and never
 * fails a compaction.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { convertToLlm } from "../messages.js";
import {
	buildSummarizationPrompt,
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	completeSummaryText,
	elideSummaryForRequest,
	summaryRequestByteLimit,
} from "./compaction.js";
import {
	computeFileLists,
	formatFileOperations,
	isCompactionIntegrityMarker,
	splitConversationForSummary,
} from "./utils.js";

/** Hard ceiling on chunk summarization requests for one deep compaction. */
export const MAP_REDUCE_MAX_CHUNKS = 256;

/**
 * Map chunks are independent, so a small pool keeps a long deep compaction from
 * running serially without turning one command into a provider burst.
 */
export const DEEP_MAP_CONCURRENCY = 4;

/** Directory holding per-run partial caches inside the session artifact directory. */
export const DEEP_COMPACTION_CACHE_DIRNAME = "deep-compaction";

const DEEP_CACHE_VERSION = 1;
/** Abandoned runs (model swap, edited instructions) are swept after this age. */
const STALE_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAP_REDUCE_CHUNK_PROMPT = `This is one consecutive part of a long AI coding-assistant session history, provided inside <conversation> tags. Summarize THIS part densely and self-contained: key decisions, exact identifiers (paths, SHAs, PRs, ticket IDs, agent/child names, error texts), current state at the end of the part, and unresolved items. Do not reference other parts; a later pass merges the parts. Preserve verbatim anything that looks load-bearing.`;

const MAP_REDUCE_MERGE_PROMPT = `The partial summaries above cover consecutive parts of one AI coding-assistant session, in chronological order. Merge them into ONE summary following the required section format. Reconcile duplicates, keep the newest state when parts conflict, drop narration of the merging process itself, and preserve exact identifiers (paths, SHAs, PRs, ticket IDs, agent/child names, error texts).`;

const CHECKPOINT_SEED_HEADER =
	"[Prior compaction checkpoint summary. It already covers all session history before the parts that follow.]";

/**
 * Progress of one deep compaction run.
 * `map` counts chunk summaries against the total chunk count (resumed chunks are
 * already counted when the run starts). `merge` counts merge requests within the
 * current reduce pass.
 */
export interface DeepCompactionProgress {
	phase: "map" | "merge";
	completed: number;
	total: number;
}

export interface DeepCompactionOptions {
	headers?: Record<string, string>;
	customInstructions?: string;
	signal?: AbortSignal;
	thinkingLevel?: ThinkingLevel;
	/** Bound into the run identity so runs of different sessions never share partials. */
	sessionId?: string;
	/** Durable partial cache; absent for in-memory sessions, which cannot resume. */
	cache?: DeepCompactionCache;
	onProgress?: (progress: DeepCompactionProgress) => void;
}

/** Everything a resumed partial must agree with to still be valid. */
export interface DeepRunIdentity {
	sessionId: string | undefined;
	firstKeptEntryId: string;
	previousSummary: string | undefined;
	chunkDigests: readonly string[];
	model: Model<any>;
	thinkingLevel: ThinkingLevel | undefined;
	customInstructions: string | undefined;
	settings: CompactionSettings;
}

interface DeepPartialRecord {
	version: number;
	runId: string;
	index: number;
	digest: string;
	summary: string;
}

export function deepChunkDigest(chunk: string): string {
	return createHash("sha256").update(chunk, "utf8").digest("hex");
}

/**
 * Deterministic identity of a deep compaction run. Any change to the prepared
 * source, the ordered chunk content, the model, the thinking level, the compaction
 * settings, or the custom instructions produces a different id, so partials from an
 * older run are never reused for a different summary.
 */
export function computeDeepRunId(identity: DeepRunIdentity): string {
	const hash = createHash("sha256");
	const field = (label: string, value: string | undefined) => {
		hash.update(label, "utf8");
		hash.update("\0", "utf8");
		hash.update(value ?? "", "utf8");
		hash.update("\0", "utf8");
	};
	field("version", String(DEEP_CACHE_VERSION));
	field("session", identity.sessionId);
	field("firstKeptEntryId", identity.firstKeptEntryId);
	field("previousSummary", identity.previousSummary ? deepChunkDigest(identity.previousSummary) : "");
	field("model", `${identity.model.provider}/${identity.model.api}/${identity.model.id}`);
	field("thinkingLevel", identity.thinkingLevel);
	field("customInstructions", identity.customInstructions);
	field(
		"settings",
		JSON.stringify({
			mode: identity.settings.mode ?? null,
			reserveTokens: identity.settings.reserveTokens,
			keepRecentTokens: identity.settings.keepRecentTokens,
		}),
	);
	field("chunkCount", String(identity.chunkDigests.length));
	for (const [index, digest] of identity.chunkDigests.entries()) field(`chunk:${index}`, digest);
	return hash.digest("hex").slice(0, 32);
}

function partialFileName(index: number): string {
	return `${String(index).padStart(5, "0")}.json`;
}

/**
 * Durable per-run store of completed map partials. One small JSON file per chunk,
 * written atomically, so a cancelled run leaves exactly the work it finished.
 */
export class DeepCompactionCache {
	constructor(private readonly rootDir: string) {}

	/** Cache rooted in the session artifact directory, or none for in-memory sessions. */
	static forSessionArtifacts(artifactDir: string | undefined): DeepCompactionCache | undefined {
		return artifactDir ? new DeepCompactionCache(join(artifactDir, DEEP_COMPACTION_CACHE_DIRNAME)) : undefined;
	}

	runDir(runId: string): string {
		return join(this.rootDir, runId);
	}

	/** Valid partials for this run, keyed by chunk index. Stale records are dropped. */
	async loadPartials(runId: string, chunkDigests: readonly string[]): Promise<Map<number, string>> {
		const partials = new Map<number, string>();
		let files: string[];
		try {
			files = await readdir(this.runDir(runId));
		} catch {
			return partials;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			let record: Partial<DeepPartialRecord>;
			try {
				record = JSON.parse(await readFile(join(this.runDir(runId), file), "utf8")) as Partial<DeepPartialRecord>;
			} catch {
				continue; // Unreadable or truncated partial: recompute that chunk.
			}
			if (record.version !== DEEP_CACHE_VERSION || record.runId !== runId) continue;
			const { index, digest, summary } = record;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= chunkDigests.length)
				continue;
			if (typeof digest !== "string" || digest !== chunkDigests[index]) continue;
			if (typeof summary !== "string" || summary.length === 0) continue;
			partials.set(index, summary);
		}
		return partials;
	}

	async savePartial(runId: string, index: number, digest: string, summary: string): Promise<void> {
		const record: DeepPartialRecord = { version: DEEP_CACHE_VERSION, runId, index, digest, summary };
		const target = join(this.runDir(runId), partialFileName(index));
		const temp = `${target}.${randomUUID()}.tmp`;
		try {
			await mkdir(this.runDir(runId), { recursive: true });
			await writeFile(temp, JSON.stringify(record), "utf8");
			await rename(temp, target);
		} catch {
			// Best effort: losing resumability must never fail a compaction.
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}

	/** Drop a finished run's partials. Called only once its summary is committed. */
	async clearRun(runId: string): Promise<void> {
		await rm(this.runDir(runId), { recursive: true, force: true }).catch(() => undefined);
	}

	/** Sweep partials of runs that were superseded and never resumed. */
	async pruneStaleRuns(keepRunId: string, maxAgeMs: number = STALE_RUN_MAX_AGE_MS): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(this.rootDir);
		} catch {
			return;
		}
		const cutoff = Date.now() - maxAgeMs;
		for (const entry of entries) {
			if (entry === keepRunId) continue;
			const dir = join(this.rootDir, entry);
			try {
				const info = await stat(dir);
				if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
			} catch {
				// Concurrent run or permission problem: leave it alone.
			}
		}
	}
}

/** Run `worker` over `items` with at most `limit` in flight, stopping on first failure or abort. */
async function runBounded(
	items: readonly number[],
	limit: number,
	signal: AbortSignal | undefined,
	worker: (item: number) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	let failure: unknown;
	let failed = false;
	const drain = async (): Promise<void> => {
		while (!failed && !signal?.aborted) {
			const slot = cursor++;
			if (slot >= items.length) return;
			try {
				await worker(items[slot]);
			} catch (error) {
				if (!failed) {
					failed = true;
					failure = error;
				}
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, drain));
	if (failed) throw failure;
	if (signal?.aborted) throw new Error("Compaction cancelled");
}

/**
 * Deep map-reduce compaction of a prepared history.
 *
 * The preparation supplies the source: when it carries a previous readable summary
 * that checkpoint is merged in as the oldest partial, so seeded runs cover the same
 * history as a from-root run at a fraction of the cost. Every request stays within
 * the same byte budget as ordinary compaction.
 */
export async function compactMapReduce(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	options: DeepCompactionOptions = {},
): Promise<CompactionResult<CompactionDetails>> {
	const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, tokensBefore, fileOps, settings } = preparation;
	const { headers, customInstructions, signal, thinkingLevel, cache, onProgress } = options;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}
	const reserveTokens = settings.reserveTokens;
	const maxTokens = Math.floor(0.8 * reserveTokens);
	const requestLimit = summaryRequestByteLimit(model, reserveTokens, maxTokens);
	const chunkBudget = Math.max(1_024, Math.floor(requestLimit / 3));
	const llmMessages = convertToLlm([...messagesToSummarize, ...turnPrefixMessages]);
	const chunks = splitConversationForSummary(llmMessages, chunkBudget, MAP_REDUCE_MAX_CHUNKS);
	const chunkDigests = chunks.map(deepChunkDigest);

	const runId = computeDeepRunId({
		sessionId: options.sessionId,
		firstKeptEntryId,
		previousSummary: preparation.previousSummary,
		chunkDigests,
		model,
		thinkingLevel,
		customInstructions,
		settings,
	});
	await cache?.pruneStaleRuns(runId);

	const customBlock = customInstructions
		? `\n\n<user-instructions>\nThe user provided these instructions for this summary. Follow them with high priority: emphasize what they ask to focus on, and preserve verbatim anything they ask to remember.\n${customInstructions}\n</user-instructions>`
		: "";

	// MAP: one independent dense summary per chunk. Integrity markers are program
	// facts, not history: carried verbatim, never summarized. Chunks already summarized
	// by an interrupted run of the same identity are restored instead of re-requested.
	const resumed = cache ? await cache.loadPartials(runId, chunkDigests) : new Map<number, string>();
	const partials: Array<string | undefined> = new Array(chunks.length);
	const missing: number[] = [];
	let resumedChunks = 0;
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		if (isCompactionIntegrityMarker(chunk)) {
			partials[index] = chunk;
			continue;
		}
		const cached = resumed.get(index);
		if (cached !== undefined) {
			partials[index] = cached;
			resumedChunks++;
			continue;
		}
		missing.push(index);
	}

	let mapped = chunks.length - missing.length;
	onProgress?.({ phase: "map", completed: mapped, total: chunks.length });
	await runBounded(missing, DEEP_MAP_CONCURRENCY, signal, async (index) => {
		const promptText =
			`<conversation>\n${chunks[index]}\n</conversation>\n\n` +
			`Part ${index + 1} of ${chunks.length}. ${MAP_REDUCE_CHUNK_PROMPT}${customBlock}`;
		const summary = await completeSummaryText(
			model,
			promptText,
			requestLimit,
			maxTokens,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			`Map-reduce chunk ${index + 1} summarization failed`,
		);
		if (signal?.aborted) throw new Error("Compaction cancelled");
		partials[index] = summary;
		if (summary.length > 0) await cache?.savePartial(runId, index, chunkDigests[index], summary);
		mapped++;
		onProgress?.({ phase: "map", completed: mapped, total: chunks.length });
	});

	const orderedPartials = partials.map((partial, index) => {
		if (partial === undefined) throw new Error(`Map-reduce chunk ${index + 1} produced no summary`);
		return partial;
	});

	// REDUCE: hierarchically merge partials, oldest first, until one summary remains.
	// A seeded checkpoint summary is the oldest partial: it stands in for the history
	// the checkpoint already covered.
	const mergeInstructions = `${MAP_REDUCE_MERGE_PROMPT}${customBlock}\n\n${buildSummarizationPrompt(customInstructions)}`;
	const mergeBudget = Math.max(1_024, Math.floor(requestLimit / 2));
	const seededFromCheckpoint = Boolean(preparation.previousSummary);
	let level = seededFromCheckpoint
		? [`${CHECKPOINT_SEED_HEADER}\n\n${preparation.previousSummary}`, ...orderedPartials]
		: orderedPartials;
	let mergePasses = 0;
	while (level.length > 1 && mergePasses < 10) {
		mergePasses++;
		const groups: string[][] = [];
		let group: string[] = [];
		let groupBytes = 0;
		for (const partial of level) {
			const bytes = Buffer.byteLength(partial, "utf8");
			if (group.length > 0 && groupBytes + bytes > mergeBudget) {
				groups.push(group);
				group = [];
				groupBytes = 0;
			}
			group.push(partial);
			groupBytes += bytes;
		}
		if (group.length > 0) groups.push(group);
		if (groups.length === level.length) {
			// No grouping progress: every partial nearly fills the budget. Elide each
			// to half budget so the next pass can always merge at least pairs.
			level = level.map((partial) => elideSummaryForRequest(partial, Math.floor(mergeBudget / 2)));
			continue;
		}
		const mergeTotal = groups.filter((mergeGroup) => mergeGroup.length > 1).length;
		let merged = 0;
		onProgress?.({ phase: "merge", completed: merged, total: mergeTotal });
		const next: string[] = [];
		for (const mergeGroup of groups) {
			if (mergeGroup.length === 1) {
				next.push(mergeGroup[0]);
				continue;
			}
			const joined = mergeGroup
				.map((partial, i) => `<partial-summary index="${i + 1}">\n${partial}\n</partial-summary>`)
				.join("\n\n");
			next.push(
				await completeSummaryText(
					model,
					`${joined}\n\n${mergeInstructions}`,
					requestLimit,
					maxTokens,
					apiKey,
					headers,
					signal,
					thinkingLevel,
					"Map-reduce merge failed",
				),
			);
			merged++;
			onProgress?.({ phase: "merge", completed: merged, total: mergeTotal });
		}
		level = next;
	}
	if (level.length > 1) {
		// Merge-pass ceiling: deterministic final merge with elided inputs rather than
		// another model round that cannot shrink further.
		const elided = level.map((partial) => elideSummaryForRequest(partial, Math.floor(mergeBudget / level.length)));
		level = [
			await completeSummaryText(
				model,
				`${elided.map((partial, i) => `<partial-summary index="${i + 1}">\n${partial}\n</partial-summary>`).join("\n\n")}\n\n${mergeInstructions}`,
				requestLimit,
				maxTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				"Map-reduce final merge failed",
			),
		];
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	let summary = level[0] || "No compactable conversation content.";
	summary += formatFileOperations(readFiles, modifiedFiles);
	const provenance = [
		`${chunks.length} chunk(s)`,
		`${orderedPartials.length} partial summar${orderedPartials.length === 1 ? "y" : "ies"}`,
		`${mergePasses} merge pass(es)`,
		`${resumedChunks} chunk(s) resumed from cache`,
		seededFromCheckpoint ? "seeded from the prior checkpoint summary" : "rebuilt from the branch root",
	].join(", ");
	summary += `\n\n[Deep map-reduce compaction: ${provenance}.]`;
	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: {
			readFiles,
			modifiedFiles,
			mapReduce: {
				chunks: chunks.length,
				partialSummaries: orderedPartials.length,
				mergePasses,
				runId,
				resumedChunks,
				seededFromCheckpoint,
			},
		},
		mechanism: "local",
	};
}
