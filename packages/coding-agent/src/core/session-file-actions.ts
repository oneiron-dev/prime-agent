import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { canonicalSessionPath } from "./session-lease.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

export type ChildKernelCacheCleanupResult =
	| { outcome: "pruned"; files: number }
	| { outcome: "not_found"; files: 0 }
	| { outcome: "skipped_invalid"; files: number; reason: string }
	| { outcome: "failed"; files: number; error: string };

const CHILD_KERNEL_CACHE_FILES = ["kernel-state.dill", "kernel-state.json"] as const;

function isContained(path: string, parent: string): boolean {
	const pathRelative = relative(parent, path);
	return pathRelative === "" || (!pathRelative.startsWith("..") && !pathRelative.includes("/../"));
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Removes only a deleted child's two fixed kernel snapshots. The caller must
 * invoke this after disposal has succeeded; this helper never removes sessions,
 * registries, transcripts, or arbitrary artifacts.
 */
export async function pruneDeletedChildKernelCaches(sessionPath: string): Promise<ChildKernelCacheCleanupResult> {
	const resolvedSessionPath = resolve(sessionPath);
	const canonicalPath = canonicalSessionPath(resolvedSessionPath);
	const sessionId = basename(canonicalPath).replace(/\.jsonl$/, "");
	if (resolvedSessionPath !== canonicalPath || !sessionId || basename(canonicalPath) !== `${sessionId}.jsonl`) {
		return { outcome: "skipped_invalid", files: 0, reason: "session path is not canonical" };
	}

	const artifactRoot = join(dirname(dirname(canonicalPath)), "session-artifacts");
	const artifactDir = join(artifactRoot, sessionId);
	if (!isContained(artifactDir, artifactRoot)) {
		return { outcome: "skipped_invalid", files: 0, reason: "artifact path escapes its root" };
	}
	try {
		if (!existsSync(artifactRoot) || !existsSync(artifactDir)) {
			return { outcome: "not_found", files: 0 };
		}
		if (isSymlink(artifactRoot) || isSymlink(artifactDir)) {
			return { outcome: "skipped_invalid", files: 0, reason: "artifact parent is symlinked" };
		}
		if (realpathSync(artifactRoot) !== resolve(artifactRoot) || realpathSync(artifactDir) !== resolve(artifactDir)) {
			return { outcome: "skipped_invalid", files: 0, reason: "artifact path is non-canonical" };
		}

		const cachePaths: string[] = [];
		// Validate the entire fixed set before unlinking either cache file.
		for (const fileName of CHILD_KERNEL_CACHE_FILES) {
			const cachePath = join(artifactDir, fileName);
			if (!isContained(cachePath, artifactDir)) {
				return { outcome: "skipped_invalid", files: 0, reason: "cache path escapes artifact directory" };
			}
			try {
				const stat = lstatSync(cachePath);
				if (stat.isSymbolicLink() || !stat.isFile()) {
					return { outcome: "skipped_invalid", files: 0, reason: `cache file is not a regular file: ${fileName}` };
				}
				cachePaths.push(cachePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				return { outcome: "failed", files: 0, error: error instanceof Error ? error.message : String(error) };
			}
		}

		let files = 0;
		for (const cachePath of cachePaths) {
			try {
				await unlink(cachePath);
				files += 1;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				return { outcome: "failed", files, error: error instanceof Error ? error.message : String(error) };
			}
		}
		return files > 0 ? { outcome: "pruned", files } : { outcome: "not_found", files: 0 };
	} catch (error) {
		return { outcome: "failed", files: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	const sessionId = basename(sessionPath).replace(/\.jsonl$/, "");
	if (!sessionId) return;
	const artifactDir = join(dirname(dirname(sessionPath)), "session-artifacts", sessionId);
	await rm(artifactDir, { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) parts.push(trashResult.error.message);
		const stderr = trashResult.stderr?.trim();
		if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		return { ok: false, error: trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError };
	}
}

/** Delete a session file and its artifact directory after the file is gone. */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}
