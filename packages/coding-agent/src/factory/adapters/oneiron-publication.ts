import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { factoryOwnedEnvironment, readFactoryRuntime } from "../runtime.js";
import type { OneironManifest, OneironSource } from "./oneiron.js";
import { type OneironPin, oneironSha } from "./oneiron-review.js";

interface PublicationBase {
	repo: string;
	pr: number;
	base: string;
	gates: OneironPin[];
	editorial: OneironPin;
}
export type OneironPublicationStage =
	| ({ kind: "publish-ready" } & PublicationBase)
	| ({
			kind: "publish-update";
			expectedRemoteHead: string;
			pushGuard: OneironPin;
			nativeTool: OneironPin;
			dependencyAudit: OneironPin;
	  } & PublicationBase);
export type OneironCommand = (argv: string[], environment?: Record<string, string>) => Promise<string>;
function check(condition: unknown, reason: string): asserts condition {
	if (!condition) throw new Error(reason);
}
interface PullRequest {
	number: number;
	headRefOid: string;
	headRefName: string;
	baseRefName: string;
	state: string;
	title: string;
	body: string;
	isDraft: boolean;
}
function topology(text: string, stage: OneironPublicationStage, source: OneironSource) {
	const state = JSON.parse(text) as {
		trunk: string;
		currentBranch: string;
		branches: Array<{
			name: string;
			isCurrent: boolean;
			isMerged: boolean;
			isQueued: boolean;
			needsRebase: boolean;
			pr?: { number: number; state: string };
		}>;
	};
	check(
		state.trunk === stage.base && state.currentBranch === source.branch && state.branches?.length === 1,
		"Publication requires exactly one natively tracked branch and pinned trunk",
	);
	const branch = state.branches[0]!;
	check(
		branch.name === source.branch &&
			branch.isCurrent === true &&
			branch.isMerged === false &&
			branch.isQueued === false &&
			branch.needsRebase === false &&
			branch.pr?.number === stage.pr &&
			branch.pr.state === "OPEN",
		"Native branch/PR topology changed, queued, or needs rebase",
	);
	return state;
}

/** Native publication only. Never authors commits, initializes stacks, rebases or merges. */
export async function publishOneiron(
	m: OneironManifest,
	stage: OneironPublicationStage,
	run: OneironCommand,
	readPin: (pin: OneironPin) => string,
): Promise<Record<string, unknown>> {
	const source = m.source;
	check(m.factoryRuntime, "Publication requires the shared pinned factory runtime");
	const factoryCli = readFactoryRuntime(m.factoryRuntime, readPin).cliArgv;
	const editorial = JSON.parse(readPin(stage.editorial)) as {
		ticketId: string;
		head: string;
		title: string;
		bodySha256: string;
		approved: boolean;
	};
	check(
		editorial.approved === true &&
			editorial.ticketId === m.ticketId &&
			editorial.head === source.head &&
			editorial.title.startsWith(m.ticketId) &&
			/^[a-f0-9]{64}$/.test(editorial.bodySha256),
		"Exact-head editorial approval required",
	);
	const query = [
		"gh",
		"pr",
		"view",
		String(stage.pr),
		"--repo",
		stage.repo,
		"--json",
		"number,headRefOid,headRefName,baseRefName,isDraft,state,title,body",
	];
	const validatePR = (text: string, head: string) => {
		const pr = JSON.parse(text) as PullRequest;
		check(
			pr.number === stage.pr &&
				pr.headRefOid === head &&
				pr.headRefName === source.branch &&
				pr.baseRefName === stage.base &&
				pr.state === "OPEN" &&
				pr.title === editorial.title &&
				oneironSha(pr.body) === editorial.bodySha256,
			"Publication PR/head/base/editorial identity changed",
		);
		return pr;
	};
	check(
		(await run(["git", "status", "--porcelain=v1", "--untracked-files=all"])).trim() === "",
		"Publication requires a clean signed candidate",
	);
	const oldHead = stage.kind === "publish-update" ? stage.expectedRemoteHead : source.head;
	check(/^[a-f0-9]{40}$/.test(oldHead), "Publication expected remote head is invalid");
	const before = validatePR(await run(query), oldHead);
	const commits =
		stage.kind === "publish-update"
			? (await run(["git", "rev-list", `${oldHead}..${source.head}`])).trim().split("\n").filter(Boolean)
			: [source.head];
	check(
		commits.length > 0 && commits.length <= 50 && commits.every((sha) => /^[a-f0-9]{40}$/.test(sha)),
		"Publication needs a bounded nonempty exact commit range",
	);
	for (const commit of commits) {
		await run(["git", "verify-commit", commit]);
		const metadata = (await run(["git", "show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", commit])).trim();
		check(
			metadata.startsWith("Lexi <olety7@gmail.com>\nLexi <olety7@gmail.com>\n") &&
				!/(?:co-authored-by|generated-by|reviewed-by|claude|opus|gpt-6|astra|qodo|codex|grok)/i.test(metadata),
			"Publication commit attribution/message policy mismatch",
		);
	}
	if (stage.kind === "publish-ready") {
		if (before.isDraft) await run(["gh", "pr", "ready", String(stage.pr), "--repo", stage.repo]);
		const after = validatePR(await run(query), source.head);
		check(!after.isDraft, "PR did not become ready");
		return { before, after, readinessOnly: true, pushed: false, merged: false };
	}
	const audit = JSON.parse(readPin(stage.dependencyAudit)) as {
		repo: string;
		pr: number;
		branch: string;
		expectedRemoteHead: string;
		candidateHead: string;
		noUnknownDependents: boolean;
		expiresAt: string;
	};
	check(
		audit.repo === stage.repo &&
			audit.pr === stage.pr &&
			audit.branch === source.branch &&
			audit.expectedRemoteHead === oldHead &&
			audit.candidateHead === source.head &&
			audit.noUnknownDependents === true &&
			Date.parse(audit.expiresAt) > Date.now(),
		"Fresh exact branch dependency/custody audit required",
	);
	const tool = JSON.parse(readPin(stage.nativeTool)) as {
		executable: OneironPin;
		version: string;
		sources: OneironPin[];
		explicitPerBranchLease: boolean;
		refreshesTrackingBeforePush: boolean;
	};
	const executableBytes = readFileSync(tool.executable.path);
	check(
		isAbsolute(tool.executable.path) &&
			oneironSha(executableBytes) === tool.executable.sha256 &&
			tool.explicitPerBranchLease === true &&
			tool.refreshesTrackingBeforePush === true &&
			tool.sources.length > 0,
		"Native publication executable/provenance mismatch",
	);
	for (const pin of tool.sources) readPin(pin);
	const native = join(m.outputDirectory, "native-gh-stack");
	writeFileSync(native, executableBytes, { flag: "wx", mode: 0o500 });
	const nativeRun: OneironCommand = (argv, env) => {
		check(oneironSha(readFileSync(native)) === tool.executable.sha256, "Native executable snapshot changed");
		for (const pin of tool.sources) readPin(pin);
		readPin(stage.pushGuard);
		return run([native, ...argv], env);
	};
	check((await nativeRun(["--version"])).trim() === tool.version, "Native publication version changed");
	const topologyBefore = topology(await nativeRun(["view", "--json"]), stage, source);
	await run(["git", "merge-base", "--is-ancestor", oldHead, source.head]);
	check(
		(await run(["git", "rev-parse", `refs/remotes/origin/${source.branch}`])).trim() === oldHead,
		"Remote tracking ref does not match the pinned old head",
	);
	const branchInfo = JSON.parse(
		await run(["gh", "api", `repos/${stage.repo}/branches/${encodeURIComponent(source.branch)}`]),
	) as { name: string; protected: boolean; commit: { sha: string } };
	check(
		branchInfo.name === source.branch && branchInfo.protected === false && branchInfo.commit?.sha === oldHead,
		"Publication branch is protected or its remote identity changed",
	);
	const ref = `refs/heads/${source.branch}`;
	check(
		(await run(["git", "ls-remote", "--refs", "origin", ref])).trim() === `${oldHead}\t${ref}`,
		"Remote changed before publication",
	);
	// Native push fetches first, so scoped hooksPath must not suppress any active Git hook.
	const originalHook = (await run(["git", "rev-parse", "--git-path", "hooks/pre-push"])).trim();
	check(originalHook.length > 0, "Cannot resolve the existing pre-push hook");
	const hookPath = isAbsolute(originalHook) ? originalHook : join(source.workspace, originalHook);
	const hookDirectory = dirname(hookPath);
	const activeHooks = existsSync(hookDirectory)
		? readdirSync(hookDirectory).filter((name) => {
				if (name.endsWith(".sample")) return false;
				const info = statSync(join(hookDirectory, name));
				return info.isFile() && (info.mode & 0o111) !== 0;
			})
		: [];
	check(activeHooks.length === 0, "Existing executable Git hooks require explicit integration, not override");
	check(
		!Object.keys(process.env).some((key) => /^(GIT_CONFIG_(?:COUNT|KEY_.*|VALUE_.*|PARAMETERS))$/.test(key)),
		"Inherited command-scoped Git config requires explicit integration",
	);
	const hooks = join(m.outputDirectory, "hooks");
	mkdirSync(hooks, { mode: 0o700 });
	writeFileSync(join(hooks, "pre-push"), readPin(stage.pushGuard), { mode: 0o500, flag: "wx" });
	const guard = {
		version: 1,
		branch: source.branch,
		protectedBranches: [stage.base, "main", "master"],
		candidateHead: source.head,
		expectedRemoteHead: oldHead,
		remote: "origin",
		remoteUrl: source.remoteUrl,
		ownerPauseFile: m.ownerPauseFile,
		factoryDirectory: m.factoryDirectory,
		factoryCli,
		factoryEnvironment: factoryOwnedEnvironment(),
		receipt: join(m.outputDirectory, "push-guard-receipt.json"),
	};
	const guardPath = join(m.outputDirectory, "push-guard.json");
	const guardBytes = JSON.stringify(guard);
	writeFileSync(guardPath, guardBytes, { flag: "wx", mode: 0o600 });
	// Use the pinned native extension executable, not a PATH-dependent substitute.
	await nativeRun(["push", "--remote", "origin"], {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: hooks,
		ONEIRON_PUSH_GUARD: guardPath,
		ONEIRON_PUSH_GUARD_SHA256: oneironSha(guardBytes),
	});
	const guardReceipt = JSON.parse(readFileSync(guard.receipt, "utf8")) as { guardSha256: string; passed: boolean };
	check(
		guardReceipt.passed === true && guardReceipt.guardSha256 === oneironSha(guardBytes),
		"Publication did not pass the exact advertised-head pre-push guard",
	);
	const topologyAfter = topology(await nativeRun(["view", "--json"]), stage, source);
	const after = validatePR(await run(query), source.head);
	check(
		(await run(["git", "ls-remote", "--refs", "origin", ref])).trim() === `${source.head}\t${ref}`,
		"Published remote head differs from the signed candidate",
	);
	return {
		before,
		after,
		topologyBefore,
		topologyAfter,
		nativeTool: stage.nativeTool,
		guard: stage.pushGuard,
		guardReceipt,
		expectedRemoteHead: oldHead,
		pushed: true,
		merged: false,
		requiresCurrentHeadReview: true,
	};
}
