import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SeatHosting } from "../agent-command.js";
import type { ReviewTier, RoutingAnswer } from "../routing.js";

/** One model seat: a prime-agent print session, or any command that takes the prompt as its last argument. */
export type OneironSeat = { provider: string; model: string; thinking: string } | { command: string[] };
export interface OneironLauncherSettings {
	/** The configured factory host the ticket runners are launched on. */
	host: string;
	/** The engine checkout that owns the worktrees. */
	repo: string;
	/** The docs mirror the pack maker reads; optional. */
	docs?: string;
	/** Worktrees, logs, cargo targets and ticket directories live here. */
	work: string;
	remote?: string;
	trunk?: string;
	branchPrefix?: string;
	/** Repair only when GitHub reports a conflict or BEHIND, unless current-base is explicitly requested. */
	mergePolicy?: "github" | "current-base";
	/** owner/name for gh api; derived from the remote URL when absent. */
	githubRepo?: string;
	buildSlots?: number;
	cargoJobs?: number;
	diskFloorGiB?: number;
	seats?: Partial<Record<SeatName, OneironSeat>>;
	/**
	 * The agent binary native seats run, as resolved on the runner host by `launch` (an absolute path there). Absent,
	 * the runner takes PRIME_AGENT_FACTORY_AGENT_BIN, then `prime-agent` on its PATH.
	 */
	primeAgentBin?: string;
	/**
	 * Who holds a native seat's session. `owned` (the default): the seat process itself, so killing a silent seat
	 * ends its turn. `daemon`: the agent daemon (`--daemon-hosted`); the session stays attachable from another
	 * terminal and outlives the seat process.
	 */
	seatHosting?: SeatHosting;
	/**
	 * Silence, never a clock. A seat or cargo run whose stream produces nothing for this long is killed and the
	 * round continues in the same session. A model that is still working is never interrupted.
	 */
	idleMs?: number;
	/**
	 * Ordered build hosts for cargo. The first one with a free slot runs a call; a call waits while every reachable
	 * host is full. An empty list keeps cargo on this host.
	 */
	buildHosts?: OneironBuildHost[];
	/** gh and git calls; the bot poll; the required-check wait before a merge. */
	timeouts?: Partial<{ ghMs: number; botsMs: number; ciMs: number; mergePollMs: number; propagationPollMs: number }>;
	/**
	 * No stacks: every ticket branches from the trunk, its submit waits until every blocker merged, it opens with
	 * `gh pr create --base <trunk>` and merges with `gh pr merge --squash`. No `gh stack` call runs. Default off.
	 */
	noStacks?: boolean;
	/**
	 * The factory runs no cargo tests of its own: the pull request's required checks gate the merge, which waits for
	 * them at the exact head. A ticket that touches no crate no longer fails "zero tests ran". Needs `noStacks`.
	 */
	skipFactoryTests?: boolean;
	/** No CodeRabbit request, no bot wait and no bot round. */
	skipBots?: boolean;
	/** One more review on the review seat (`grok`) of the exact head right before the merge; only LANDABLE merges. */
	preMergeReview?: boolean;
}
/** A host that runs cargo for this factory: the worktree is synced to `<root>/wt/<key>` and cargo runs there. */
export interface OneironBuildHost {
	/** ssh destination, e.g. `olety@100.124.216.116`, or `local` for this host. */
	sshHost: string;
	/** Absolute directory on that host: build trees under `<root>/wt/<key>`, or `<root>/target/<key>` for `local`. */
	root: string;
	/** Cargo calls this host runs at once (default 2). */
	slots?: number;
	/** Cargo jobs per call on this host (default `cargoJobs`). */
	jobs?: number;
}
export const DEFAULT_BUILD_HOST_SLOTS = 2;
export interface OneironTicketRun {
	version: 1;
	key: string;
	title: string;
	contract: string;
	acceptance: string;
	row?: string;
	tier?: string;
	blockedBy: string[];
	launcher: OneironLauncherSettings;
}
export interface OneironTicketState {
	key: string;
	branch: string;
	worktree: string;
	base?: string;
	stacked?: boolean;
	chain?: string[];
	pack?: boolean;
	writer?: { rounds: number; final: string };
	split?: string;
	tests?: { crates: string[]; ran: number; rounds: number; skipped?: true };
	/** Seats killed for silence, newest last. A working model never lands here. */
	idleKills?: Array<{ at: string; step: string; idleMs: number }>;
	review?: { tier: RoutingAnswer<ReviewTier>; verdicts: Record<string, string>; fixRound?: boolean; recheck?: string };
	attribution?: string[];
	pr?: number;
	prUrl?: string;
	submittedHead?: string;
	submittedAt?: string;
	coderabbit?: "requested" | "failed";
	bots?: { completed: string[]; unavailable: string[]; comments: number; waitedMs: number };
	botRound?: { final: string; head: string };
	/** The last pre-merge review: the head it read and its verdict line. */
	preMerge?: { head: string; verdict: string };
	merged?: boolean;
	failure?: string;
}

export type SeatName = "writer" | "pack" | "grok" | "opus";
/** The seats a review tier can name. `grok` is only the slot name; the launcher decides its model. */
export type ReviewSeat = "grok" | "opus";
export const DEFAULT_SEATS: Record<SeatName, OneironSeat> = {
	writer: { provider: "cpa-r", model: "gpt-6-astra", thinking: "xhigh" },
	pack: { provider: "cpa-r", model: "muse-spark-1.3-contributor", thinking: "max" },
	grok: { provider: "cpa-r", model: "grok-4.6", thinking: "xhigh" },
	opus: { provider: "cpa-r", model: "claude-opus-5", thinking: "xhigh" },
};
/** gh and git are network calls, not models; they keep a wall clock. Nothing that runs a model does. */
export const DEFAULT_TIMEOUTS = {
	ghMs: 300_000,
	botsMs: 2_700_000,
	ciMs: 24 * 60 * 60_000,
	mergePollMs: 120_000,
	propagationPollMs: 10_000,
};
/** No event on a seat's stream for this long means the seat is gone, not thinking. */
export const DEFAULT_IDLE_MS = 30 * 60_000;

/** A stage failure the runner reports as exit 1, the ledger's rejection; anything else exits 3. */
export class TicketFailure extends Error {}

export function readTicketRun(path: string): OneironTicketRun {
	const value = JSON.parse(readFileSync(path, "utf8")) as OneironTicketRun;
	if (
		value.version !== 1 ||
		!/^[-A-Za-z0-9_.]+$/.test(value.key ?? "") ||
		typeof value.contract !== "string" ||
		!Array.isArray(value.blockedBy) ||
		!value.launcher?.repo ||
		!value.launcher.work
	)
		throw new Error(`Invalid ticket run file: ${path}`);
	return value;
}

export function listSplitFiles(work: string): Array<{ key: string; remains: string; path: string }> {
	const root = join(work, "tickets");
	if (!existsSync(root)) return [];
	const splits: Array<{ key: string; remains: string; path: string }> = [];
	for (const key of readdirSync(root)) {
		const path = join(root, key, "split.json");
		if (!existsSync(path)) continue;
		const value = JSON.parse(readFileSync(path, "utf8")) as { key: string; remains: string };
		splits.push({ key: value.key, remains: value.remains, path });
	}
	return splits;
}
