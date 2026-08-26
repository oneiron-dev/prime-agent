import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneDeletedChildKernelCaches } from "../src/core/session-file-actions.js";

let root = "";
let sessionPath = "";
let artifactDir = "";

function createChild(): void {
	const sessionDir = join(root, "parent", "sub-child");
	const sessionId = "child-session";
	sessionPath = join(sessionDir, `${sessionId}.jsonl`);
	artifactDir = join(root, "parent", "session-artifacts", sessionId);
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(sessionPath, "{}\n");
	writeFileSync(join(artifactDir, "kernel-state.dill"), "dill");
	writeFileSync(join(artifactDir, "kernel-state.json"), "{}");
	writeFileSync(join(artifactDir, "child.jsonl"), "transcript\n");
	writeFileSync(join(artifactDir, "rlm-subagents.jsonl"), "registry\n");
	writeFileSync(join(artifactDir, "report.md"), "report\n");
}

describe("pruneDeletedChildKernelCaches", () => {
	beforeEach(() => {
		// Cleanup fails closed on non-canonical session paths, so the fixture must be
		// canonical: on macOS `tmpdir()` is the `/var` -> `/private/var` alias. The
		// alias-rejection behavior itself is covered by the symlink cases below.
		root = mkdtempSync(join(realpathSync(tmpdir()), "prime-agent-child-cache-"));
		createChild();
	});
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	it("removes only fixed kernel cache files and preserves child artifacts", async () => {
		await expect(pruneDeletedChildKernelCaches(sessionPath)).resolves.toEqual({ outcome: "pruned", files: 2 });
		expect(existsSync(join(artifactDir, "kernel-state.dill"))).toBe(false);
		expect(existsSync(join(artifactDir, "kernel-state.json"))).toBe(false);
		for (const file of ["child.jsonl", "rlm-subagents.jsonl", "report.md"])
			expect(existsSync(join(artifactDir, file))).toBe(true);
	});

	it("is idempotent when caches are already absent", async () => {
		await pruneDeletedChildKernelCaches(sessionPath);
		await expect(pruneDeletedChildKernelCaches(sessionPath)).resolves.toEqual({ outcome: "not_found", files: 0 });
	});

	it("skips symlinked artifact parents without following them", async () => {
		const outside = join(root, "outside-artifacts");
		mkdirSync(outside);
		rmSync(artifactDir, { recursive: true });
		symlinkSync(outside, artifactDir);
		await expect(pruneDeletedChildKernelCaches(sessionPath)).resolves.toMatchObject({ outcome: "skipped_invalid" });
		expect(existsSync(join(outside, "kernel-state.dill"))).toBe(false);
	});

	it("skips symlinked cache files without following them", async () => {
		const outside = join(root, "outside.dill");
		writeFileSync(outside, "keep");
		rmSync(join(artifactDir, "kernel-state.dill"));
		symlinkSync(outside, join(artifactDir, "kernel-state.dill"));
		await expect(pruneDeletedChildKernelCaches(sessionPath)).resolves.toMatchObject({ outcome: "skipped_invalid" });
		expect(existsSync(outside)).toBe(true);
		expect(existsSync(join(artifactDir, "kernel-state.json"))).toBe(true);
	});

	it("preflights both cache files before rejecting a second-file symlink", async () => {
		const outside = join(root, "outside.json");
		writeFileSync(outside, "keep");
		rmSync(join(artifactDir, "kernel-state.json"));
		symlinkSync(outside, join(artifactDir, "kernel-state.json"));
		await expect(pruneDeletedChildKernelCaches(sessionPath)).resolves.toMatchObject({
			outcome: "skipped_invalid",
			files: 0,
		});
		expect(existsSync(join(artifactDir, "kernel-state.dill"))).toBe(true);
		expect(existsSync(outside)).toBe(true);
	});

	it("skips non-canonical session paths", async () => {
		const alias = join(root, "alias");
		symlinkSync(join(root, "parent", "sub-child"), alias);
		await expect(pruneDeletedChildKernelCaches(join(alias, "child-session.jsonl"))).resolves.toMatchObject({
			outcome: "skipped_invalid",
		});
		expect(existsSync(join(artifactDir, "kernel-state.dill"))).toBe(true);
	});
});
