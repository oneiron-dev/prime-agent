import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type OneironManifest, readOneironPin } from "../src/factory/adapters/oneiron.js";
import {
	type OneironCommand,
	type OneironPublicationStage,
	publishOneiron,
} from "../src/factory/adapters/oneiron-publication.js";
import { type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import { factoryOwnedEnvironment } from "../src/factory/runtime.js";

const roots: string[] = [];
const oldHead = "a".repeat(40),
	head = "b".repeat(40);
const guardFile = resolve("src/factory/adapters/oneiron-push-guard.py");
function setup() {
	const directory = mkdtempSync(join(tmpdir(), "oneiron-publication-"));
	roots.push(directory);
	let index = 0;
	const pin = (value: unknown): OneironPin => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		const path = join(directory, `pin-${index++}`);
		writeFileSync(path, text);
		return { path, sha256: oneironSha(text) };
	};
	const source = {
		workspace: directory,
		head,
		tree: "c".repeat(40),
		branch: "w6/one-1914",
		remoteUrl: "git@github.com:org/repo.git",
		fingerprint: `git:${"d".repeat(64)}`,
	};
	const native = pin("fixture native executable bytes");
	const title = "ONE-1914: correct retrieval";
	const body = "Why, behavior, invariants and focused verification.";
	const stage: OneironPublicationStage = {
		kind: "publish-update",
		repo: "org/repo",
		pr: 855,
		base: "main",
		expectedRemoteHead: oldHead,
		pushGuard: { path: guardFile, sha256: oneironSha(readFileSync(guardFile)) },
		gates: [],
		editorial: pin({ approved: true, ticketId: "ONE-1914", head, title, bodySha256: oneironSha(body) }),
		nativeTool: pin({
			executable: native,
			version: "gh stack version fixture",
			sources: [pin("reviewed source receipt")],
			explicitPerBranchLease: true,
			refreshesTrackingBeforePush: true,
		}),
		dependencyAudit: pin({
			repo: "org/repo",
			pr: 855,
			branch: source.branch,
			expectedRemoteHead: oldHead,
			candidateHead: head,
			noUnknownDependents: true,
			expiresAt: "2099-01-01",
		}),
	};
	const runtimeDirectory = join(directory, "runtime");
	mkdirSync(runtimeDirectory);
	const runtimeNode = join(runtimeDirectory, "node");
	const runtimeCli = join(runtimeDirectory, "cli.js");
	writeFileSync(runtimeNode, "fixture node");
	writeFileSync(runtimeCli, "fixture cli");
	const factoryRuntime = pin({
		version: 1,
		cliArgv: [runtimeNode, runtimeCli],
		files: [runtimeNode, runtimeCli].map((path) => ({ path, sha256: oneironSha(readFileSync(path)) })),
		capabilities: ["provider-response-model-v1"],
	});
	const manifest: OneironManifest = {
		version: 1,
		ticketId: "ONE-1914",
		owner: "fixture",
		source,
		factoryDirectory: join(directory, "factory"),
		factoryRuntime,
		ownerPauseFile: join(directory, "pause"),
		custody: pin({}),
		outputDirectory: join(directory, "output"),
		stage,
	};
	mkdirSync(manifest.outputDirectory);
	let pushed = false;
	const run = vi.fn<OneironCommand>(async (argv, env) => {
		if (argv[0] === join(manifest.outputDirectory, "native-gh-stack")) {
			if (argv[1] === "--version") return "gh stack version fixture";
			if (argv[1] === "view")
				return JSON.stringify({
					trunk: "main",
					currentBranch: source.branch,
					branches: [
						{
							name: source.branch,
							isCurrent: true,
							isMerged: false,
							isQueued: false,
							needsRebase: false,
							pr: { number: 855, state: "OPEN" },
						},
					],
				});
			if (argv[1] === "push") {
				const guard = JSON.parse(readFileSync(env!.ONEIRON_PUSH_GUARD!, "utf8")) as { receipt: string };
				writeFileSync(guard.receipt, JSON.stringify({ passed: true, guardSha256: env!.ONEIRON_PUSH_GUARD_SHA256 }));
				pushed = true;
				return "Pushed one branch";
			}
		}
		if (argv[0] === "gh") {
			if (argv[1] === "api")
				return JSON.stringify({ name: source.branch, protected: false, commit: { sha: oldHead } });
			return JSON.stringify({
				number: 855,
				headRefOid: pushed ? head : oldHead,
				headRefName: source.branch,
				baseRefName: "main",
				state: "OPEN",
				title,
				body,
				isDraft: true,
			});
		}
		if (argv[1] === "show")
			return "Lexi <olety7@gmail.com>\nLexi <olety7@gmail.com>\nFix retrieval candidate scoping.";
		if (argv[1] === "rev-list") return head;
		if (argv[1] === "rev-parse") return argv[2] === "--git-path" ? join(directory, "absent-hook") : oldHead;
		if (argv[1] === "ls-remote") return `${pushed ? head : oldHead}\trefs/heads/${source.branch}`;
		return "";
	});
	return { directory, pin, manifest, stage, run, native };
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Oneiron native single-PR controlled publication", () => {
	test("uses one native push with a scoped exact-ref guard and verifies pre/post topology and remote head", async () => {
		const f = setup();
		const result = await publishOneiron(f.manifest, f.stage, f.run, readOneironPin);
		expect(result.pushed).toBe(true);
		expect(result.merged).toBe(false);
		expect(result.requiresCurrentHeadReview).toBe(true);
		const pushes = f.run.mock.calls.filter(([argv]) => argv[1] === "push");
		expect(pushes).toHaveLength(1);
		expect(pushes[0]![0]).toEqual([
			join(f.manifest.outputDirectory, "native-gh-stack"),
			"push",
			"--remote",
			"origin",
		]);
		expect(pushes[0]![1]!.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
		expect(f.run.mock.calls.some(([argv]) => ["merge", "rebase", "init", "submit"].includes(argv[1] ?? ""))).toBe(
			false,
		);
	});
	test("rejects inherited command Git config rather than dropping it", async () => {
		const f = setup();
		vi.stubEnv("GIT_CONFIG_COUNT", "2");
		await expect(publishOneiron(f.manifest, f.stage, f.run, readOneironPin)).rejects.toThrow(/Inherited/);
		expect(f.run.mock.calls.some(([argv]) => argv[1] === "push")).toBe(false);
	});
	test("rejects topology expansion, remote drift and protected branches without push", async () => {
		for (const mode of ["topology", "remote", "protected"]) {
			const f = setup();
			const run: OneironCommand = async (argv, env) => {
				if (mode === "topology" && argv[1] === "view")
					return JSON.stringify({ trunk: "main", currentBranch: f.manifest.source.branch, branches: [] });
				if (mode === "remote" && argv[1] === "ls-remote")
					return `${"e".repeat(40)}\trefs/heads/${f.manifest.source.branch}`;
				if (mode === "protected" && argv[1] === "api")
					return JSON.stringify({ name: f.manifest.source.branch, protected: true, commit: { sha: oldHead } });
				return f.run(argv, env);
			};
			await expect(publishOneiron(f.manifest, f.stage, run, readOneironPin)).rejects.toThrow();
			expect(f.run.mock.calls.some(([argv]) => argv[1] === "push")).toBe(false);
		}
	});
	test.each(["absent-hook", "reference-transaction"])(
		"does not silently disable existing executable %s",
		async (hook) => {
			const f = setup();
			writeFileSync(join(f.directory, hook), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			await expect(publishOneiron(f.manifest, f.stage, f.run, readOneironPin)).rejects.toThrow(
				/Existing executable/,
			);
		},
	);
	test("executes the verified native snapshot even if the original executable changes during preflight", async () => {
		const f = setup();
		const run: OneironCommand = async (argv, environment) => {
			if (argv[1] === "--version") writeFileSync(f.native.path, "different rebuilt native tool");
			return f.run(argv, environment);
		};
		expect((await publishOneiron(f.manifest, f.stage, run, readOneironPin)).pushed).toBe(true);
		expect(readFileSync(join(f.manifest.outputDirectory, "native-gh-stack"), "utf8")).toBe(
			"fixture native executable bytes",
		);
	});
	test("real pre-push hook accepts the sealed old ref, rejects race/extra ref/creation/deletion/protected and pause", () => {
		const f = setup();
		const prime = join(f.directory, "prime-agent");
		writeFileSync(prime, `#!/usr/bin/env python3\nprint('{"paused":false,"ownerPaused":false}')\n`, { mode: 0o700 });
		const ref = "refs/heads/w6/one-1914";
		const guard = {
			version: 1,
			branch: "w6/one-1914",
			candidateHead: head,
			expectedRemoteHead: oldHead,
			protectedBranches: ["main"],
			remote: "origin",
			remoteUrl: f.manifest.source.remoteUrl,
			ownerPauseFile: f.manifest.ownerPauseFile,
			factoryDirectory: f.manifest.factoryDirectory,
			factoryEnvironment: factoryOwnedEnvironment(),
			factoryCli: [
				execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim(),
				prime,
			],
			receipt: join(f.directory, "guard-receipt"),
		};
		const pin = f.pin(guard);
		const env = {
			...process.env,
			PATH: `${f.directory}:${process.env.PATH}`,
			ONEIRON_PUSH_GUARD: pin.path,
			ONEIRON_PUSH_GUARD_SHA256: pin.sha256,
		};
		const invoke = (input: string) =>
			execFileSync("python3", [guardFile, "origin", f.manifest.source.remoteUrl], {
				input,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 5000,
			});
		const valid = `${ref} ${head} ${ref} ${oldHead}\n`;
		expect(() => invoke(valid)).not.toThrow();
		expect(existsSync(guard.receipt)).toBe(true);
		rmSync(guard.receipt);
		for (const input of [
			valid.replace(oldHead, "e".repeat(40)),
			valid + valid,
			valid.replace(oldHead, "0".repeat(40)),
			valid.replace(head, "0".repeat(40)),
			valid.replaceAll(ref, "refs/heads/main"),
		])
			expect(() => invoke(input)).toThrow();
		writeFileSync(guard.ownerPauseFile, "paused");
		expect(() => invoke(valid)).toThrow();
		expect(existsSync(guard.receipt)).toBe(false);
	});
});
