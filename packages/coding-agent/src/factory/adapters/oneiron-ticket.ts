import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statfsSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import {
	type FixCategory,
	pinnedReviewTier,
	type ReviewSeam,
	type ReviewTier,
	type RoutingAnswer,
	type RoutingSeats,
	routeReviewTier,
	routeTrivialFix,
	routingSeatsFromEnvironment,
} from "../routing.js";
import { FACTORY_JSON_EVENT_PROFILE, factoryOwnedEnvironment, locateFactoryCli } from "../runtime.js";
import { fetchOneironBotReviews, type OneironBotComment, REQUIRED_REVIEWERS } from "./oneiron-review.js";

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
	/** owner/name for gh api; derived from the remote URL when absent. */
	githubRepo?: string;
	buildSlots?: number;
	cargoJobs?: number;
	diskFloorGiB?: number;
	seats?: Partial<Record<"writer" | "pack" | "grok" | "opus", OneironSeat>>;
	timeouts?: Partial<{ seatMs: number; testMs: number; ghMs: number; botsMs: number; writerRounds: number }>;
}
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
	tests?: { crates: string[]; ran: number; rounds: number };
	review?: { tier: RoutingAnswer<ReviewTier>; verdicts: Record<string, string>; fixRound?: boolean; recheck?: string };
	attribution?: string[];
	pr?: number;
	prUrl?: string;
	submittedHead?: string;
	submittedAt?: string;
	coderabbit?: "requested" | "failed";
	bots?: { completed: string[]; unavailable: string[]; comments: number; waitedMs: number };
	botRound?: { final: string; head: string };
	merged?: boolean;
	failure?: string;
}

export const DEFAULT_SEATS: Record<"writer" | "pack" | "grok" | "opus", OneironSeat> = {
	writer: { provider: "cpa-r", model: "gpt-6-astra", thinking: "xhigh" },
	pack: { provider: "cpa-r", model: "muse-spark-1.3-contributor", thinking: "max" },
	grok: { provider: "cpa-r", model: "grok-4.6", thinking: "xhigh" },
	opus: { provider: "cpa-r", model: "claude-opus-5", thinking: "xhigh" },
};
const DEFAULT_TIMEOUTS = { seatMs: 3_600_000, testMs: 2_400_000, ghMs: 300_000, botsMs: 2_700_000, writerRounds: 12 };

/** Every seat prompt carries these sentences; the passivity fix lives in words, not checks. */
export const INITIATIVE_LINES = [
	"Act aggressively in initiative and conservatively only at real shared boundaries.",
	"If a lawful material action is executable, start it in the current turn. Do not stop after a plan, classification, ACK, risk list, status report, or request for permission that existing authority already grants.",
	"End only at a validated product/PR terminal or an exact blocker that makes every useful action unavailable.",
].join(" ");
export const SEAT_POLICY_LINE =
	"Use cpa-r/muse-spark-1.3-contributor with thinking max for context-gathering RLM subagents, never Astra; an Astra xhigh child only for a genuinely hard sub-task.";
export const WRITER_LINES = [
	"Use one coherent implementation, the smallest test that can falsify changed behavior plus required compile/typecheck. Reuse green evidence. Skip broad, redundant, ceremonial, and unchanged-byte tests.",
	"A plan is not work. A status report is not work.",
	"Do the whole contract. Only if a genuinely separate piece remains after the work, end with `SPLIT: <what remains>`.",
	"Never edit the docs repo. Leave implementation notes in `impl-notes/<ticket>.md` in the engine repo (decisions, where the canon page was stale or wrong, what it should say); they ride the PR.",
	"No attribution lines in commits or PR text.",
].join(" ");
export const PACK_LINE =
	"Docs might be stale. Implementation notes live in impl-notes/. Read them too when gathering context.";
const ATTRIBUTION =
	/co-authored-by|generated with \[?claude|generated-by|🤖|signed-off-by: .*(?:claude|codex|astra|gpt)/i;

export class TicketFailure extends Error {}

type Logger = (step: string, message?: string) => void;
interface Exec {
	code: number;
	output: string;
}

export function finalAssistantText(jsonl: string): string {
	let final = "";
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const record = event as Record<string, unknown>;
		if (record.type !== "message_end") continue;
		const message = record.message as Record<string, unknown> | undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter(
				(block: unknown) => !!block && typeof block === "object" && (block as { type?: string }).type === "text",
			)
			.map((block: unknown) => String((block as { text?: unknown }).text ?? ""))
			.join("");
		if (text.trim()) final = text;
	}
	return final;
}

function readState(path: string): OneironTicketState | undefined {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as OneironTicketState) : undefined;
}
function tail(text: string, lines = 160): string {
	return text.split("\n").slice(-lines).join("\n");
}
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** A pid lock file per slot; a dead holder's lock is reclaimed. Cargo builds and merges queue here. */
export async function acquireSlot(directory: string, slots: number, log?: Logger): Promise<() => void> {
	mkdirSync(directory, { recursive: true });
	for (let waited = 0; ; waited++) {
		for (let slot = 1; slot <= slots; slot++) {
			const path = join(directory, `slot-${slot}.lock`);
			try {
				const fd = openSync(path, "wx");
				writeSync(fd, String(process.pid));
				closeSync(fd);
				return () => {
					try {
						if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
					} catch {}
				};
			} catch {
				let holder = Number.NaN;
				try {
					holder = Number(readFileSync(path, "utf8"));
				} catch {}
				if (!Number.isInteger(holder) || !alive(holder)) {
					try {
						unlinkSync(path);
					} catch {}
				}
			}
		}
		if (waited % 12 === 0) log?.("slot", `all ${slots} slots busy in ${directory}; waiting`);
		await sleep(5_000);
	}
}
export function freeGiB(path: string): number {
	const stats = statfsSync(path);
	return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
}

export class OneironTicketRunner {
	readonly settings: Required<Omit<OneironLauncherSettings, "docs" | "githubRepo">> &
		Pick<OneironLauncherSettings, "docs" | "githubRepo">;
	readonly directory: string;
	readonly worktree: string;
	readonly branch: string;
	readonly logPath: string;
	private readonly statePath: string;
	state: OneironTicketState;
	constructor(
		readonly ticket: OneironTicketRun,
		private readonly options: {
			cli?: string[];
			env?: NodeJS.ProcessEnv;
			routing?: RoutingSeats;
			now?: () => number;
		} = {},
	) {
		const l = ticket.launcher;
		this.settings = {
			host: l.host,
			repo: l.repo,
			docs: l.docs,
			work: l.work,
			remote: l.remote ?? "origin",
			trunk: l.trunk ?? "main",
			githubRepo: l.githubRepo,
			buildSlots: l.buildSlots ?? 4,
			cargoJobs: l.cargoJobs ?? 4,
			diskFloorGiB: l.diskFloorGiB ?? 100,
			seats: { ...DEFAULT_SEATS, ...l.seats },
			timeouts: { ...DEFAULT_TIMEOUTS, ...l.timeouts },
		};
		this.directory = join(this.settings.work, "tickets", ticket.key);
		this.worktree = join(this.settings.work, "wt", ticket.key);
		this.branch = `w7/${ticket.key}`;
		this.statePath = join(this.directory, "state.json");
		this.logPath = join(this.directory, "run.log");
		mkdirSync(join(this.directory, "logs"), { recursive: true });
		this.state = readState(this.statePath) ?? { key: ticket.key, branch: this.branch, worktree: this.worktree };
	}
	private get t() {
		return this.settings.timeouts as Required<NonNullable<OneironLauncherSettings["timeouts"]>>;
	}
	log: Logger = (step, message = "") => {
		const line = `[${new Date().toISOString()}] ${this.ticket.key} ${step} ${message}`.trimEnd();
		appendFileSync(this.logPath, `${line}\n`);
		console.log(line);
	};
	save(patch: Partial<OneironTicketState>): void {
		this.state = { ...this.state, ...patch };
		writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
	}
	private stateOf(key: string): OneironTicketState | undefined {
		return readState(join(this.settings.work, "tickets", key, "state.json"));
	}

	/** Every external command has a hard deadline; on expiry the child is terminated and the failure recorded. */
	async run(
		argv: string[],
		options: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; logName?: string } = {},
	): Promise<Exec> {
		const cwd = options.cwd ?? this.worktree;
		const timeoutMs = options.timeoutMs ?? this.t.ghMs;
		return new Promise((resolve) => {
			const child = spawn(argv[0]!, argv.slice(1), {
				cwd,
				env: { ...(this.options.env ?? process.env), ...options.env, GIT_OPTIONAL_LOCKS: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
			}, timeoutMs);
			const collect = (chunk: Buffer) => {
				output += chunk.toString();
				if (output.length > 64 * 1024 * 1024) output = output.slice(-32 * 1024 * 1024);
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({ code: 127, output: `${output}\n${error.message}` });
			});
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				if (options.logName)
					appendFileSync(join(this.directory, "logs", options.logName), `\n=== ${argv.join(" ")}\n${output}`);
				resolve({
					code: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
					output: timedOut ? `${output}\nTIMEOUT` : output,
				});
			});
		});
	}
	private async git(args: string[], cwd = this.worktree): Promise<string> {
		const result = await this.run(["git", ...args], { cwd, timeoutMs: this.t.ghMs });
		if (result.code !== 0) throw new TicketFailure(`git ${args[0]} failed: ${tail(result.output, 20)}`);
		return result.output.trim();
	}
	private async gh(args: string[], cwd = this.worktree): Promise<Exec> {
		return this.run(["gh", ...args], { cwd, timeoutMs: this.t.ghMs, logName: "gh.log" });
	}
	private ghJson = async (args: string[]): Promise<unknown> => {
		const result = await this.gh(args);
		if (result.code !== 0) throw new TicketFailure(`gh ${args.join(" ")} failed: ${tail(result.output, 10)}`);
		return JSON.parse(result.output || "null");
	};
	private async githubRepo(): Promise<string> {
		if (this.settings.githubRepo) return this.settings.githubRepo;
		const url = await this.git(["remote", "get-url", this.settings.remote]);
		const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
		if (!match) throw new TicketFailure(`Cannot derive the GitHub repository from ${url}`);
		return match[1]!;
	}

	/** One seat call. prime-agent print mode with the owned frontend, or an explicit command. */
	async seat(
		name: "writer" | "pack" | "grok" | "opus",
		prompt: string,
		options: { system?: string; session?: string; continueSession?: boolean; logName: string },
	): Promise<{ code: number; final: string }> {
		const spec = this.settings.seats[name] ?? DEFAULT_SEATS[name];
		const logPath = join(this.directory, "logs", options.logName);
		let argv: string[];
		if ("command" in spec) argv = [...spec.command, prompt];
		else {
			const cli = this.options.cli ?? [process.execPath, ...process.execArgv, locateFactoryCli()];
			argv = [
				...cli,
				"-p",
				"--mode",
				"json",
				"--json-event-profile",
				FACTORY_JSON_EVENT_PROFILE,
				"--offline",
				"--provider",
				spec.provider,
				"--model",
				spec.model,
				"--thinking",
				spec.thinking,
				"--cwd",
				this.worktree,
				"--no-extensions",
				"--no-skills",
				...(options.session ? ["--session-dir", join(this.directory, "sessions", options.session)] : []),
				...(options.continueSession ? ["-c"] : []),
				...(options.system ? ["--append-system-prompt", options.system] : []),
				"--",
				prompt,
			];
		}
		const result = await this.run(argv, { timeoutMs: this.t.seatMs, env: factoryOwnedEnvironment() });
		writeFileSync(logPath, result.output, { flag: "a" });
		const final =
			"command" in spec ? result.output.trim() : finalAssistantText(result.output) || tail(result.output, 40);
		return { code: result.code, final };
	}

	// ---- prompts -------------------------------------------------------------------------------------------------
	private ticketHeader(): string {
		const { key, title, contract, acceptance, row } = this.ticket;
		return [
			`Ticket ${key}: ${title}`,
			`Contract: ${contract}`,
			`Acceptance: ${acceptance}`,
			...(row ? [`Registry row: ${row}`] : []),
			`Worktree: ${this.worktree} (branch ${this.branch}, base ${this.state.base ?? `${this.settings.remote}/${this.settings.trunk}`})`,
			...(this.settings.docs ? [`Docs mirror (read only, never edit): ${this.settings.docs}`] : []),
		].join("\n");
	}
	packPrompt(): string {
		return `${this.ticketHeader()}

Task (read-only): build the context pack for the writer of this ticket. Never write files. Never edit the docs repo.
1. Canon: read the docs mirror for the registry row and the nouns of the contract; quote the exact sentences that bind this change, each with page path and line number.
2. Code map of this worktree: the crates, modules, types, functions and existing tests the writer must touch or extend, each with file:line.
3. What already exists, so nothing is rebuilt.
4. Risks: what this change could break, with file:line.
${PACK_LINE}
${INITIATIVE_LINES}
Return the pack as markdown under 5000 words. Your final message is the pack.`;
	}
	writerSystem(): string {
		return `You are the Astra coding seat for one ticket. ${SEAT_POLICY_LINE} ${INITIATIVE_LINES} ${WRITER_LINES}`;
	}
	writerPrompt(): string {
		const { key } = this.ticket;
		return `${this.ticketHeader()}
Context pack: .w7/CONTEXT.md (Muse wrote it; read it first). The docs are the intent; the code is what is.

Rules:
1. Work only in this worktree. Never touch another checkout, the docs repo, or anything outside it.
2. Implement the contract until the acceptance line passes. Write the tests it names.
3. Run the tests of the crates you touched (cargo test -p <crate>) before you stop; never the whole workspace.
4. Small commits, plain messages, commit everything before you stop. No attribution lines anywhere.
5. Never restart, install or upgrade anything on this host. Never touch remotes or other branches.
6. Before DONE, write \`PR BODY:\` and 3 to 8 lines: what changed, the canon page path that defines it, how the acceptance is tested.
7. If something cannot be done, one line \`COULD NOT: <what and why>\`, and still commit what works.
${WRITER_LINES}
${INITIATIVE_LINES}
End your final reply with the exact line \`DONE ${key}\` (or \`BLOCKED ${key}\` with one reason).`;
	}
	fixPrompt(what: string, output: string): string {
		return `Same ticket ${this.ticket.key}, same worktree. ${what} Fix it, keep commits small, commit, run the tests of the crates you touched, and stop with the exact line \`DONE ${this.ticket.key}\`.
${INITIATIVE_LINES}
Output tail:
${tail(output, 160)}`;
	}
	reviewPrompt(diff: string): string {
		return `Review this diff for ticket ${this.ticket.key} (${this.ticket.title}) against its contract and acceptance. Read files in this worktree if the diff is not enough. Never edit anything.
Contract: ${this.ticket.contract}
Acceptance: ${this.ticket.acceptance}
Blocking defects only: wrong behaviour against the contract, missing acceptance test, breakage of existing behaviour, secrets, attribution lines. Style is never blocking.
${INITIATIVE_LINES}
Reply with exactly one first line: \`VERDICT: LANDABLE\` or \`VERDICT: DEFECTS\`, then each defect on its own line with file:line.

Diff (${this.state.base}...HEAD):
${diff}`;
	}
	botRoundPrompt(repo: string, pr: number, comments: OneironBotComment[]): string {
		const rendered = comments
			.map(
				(c) =>
					`--- ${c.reviewer} (${c.login}) ${c.source} id=${c.id}${c.path ? ` ${c.path}:${c.line ?? "?"}` : ""}${c.inReplyTo ? ` reply-to=${c.inReplyTo}` : ""} ${c.url}\n${c.body}`,
			)
			.join("\n\n");
		return `Same ticket ${this.ticket.key}, same worktree, pull request ${repo}#${pr} (branch ${this.branch}).
Below is EVERY bot comment on the pull request, unfiltered. Read each one and decide it on the merits.
For every real defect: fix it in this worktree, commit with a plain message, and run the tests of the crates you touched.
Reply on each inline thread with what you did or why not: \`gh api repos/${repo}/pulls/${pr}/comments/<id>/replies -f body=<text>\` for review_comment entries.
Then post exactly one summary comment on the pull request: \`gh pr comment ${pr} --repo ${repo} --body <text>\` listing each comment id and its disposition.
Never push, never merge, never close the pull request; the launcher pushes after you stop.
${WRITER_LINES}
${INITIATIVE_LINES}
End with the exact line \`DONE ${this.ticket.key}\`.

${rendered || "(no bot comments)"}`;
	}

	// ---- git -----------------------------------------------------------------------------------------------------
	private async chooseBase(): Promise<{ base: string; stacked: boolean; chain: string[] }> {
		const remoteTrunk = `${this.settings.remote}/${this.settings.trunk}`;
		for (let waited = 0; ; waited++) {
			const parents = this.ticket.blockedBy.map((key) => ({ key, state: this.stateOf(key) }));
			const unmerged = parents.filter((p) => !p.state?.merged);
			if (unmerged.length === 0) return { base: remoteTrunk, stacked: false, chain: [] };
			if (unmerged.length === 1 && unmerged[0]!.state?.pr) {
				const parent = unmerged[0]!.state!;
				return { base: parent.branch, stacked: true, chain: [...(parent.chain ?? []), parent.branch] };
			}
			if (waited % 10 === 0)
				this.log(
					"base",
					`waiting: ${unmerged.length} blockers unmerged (${unmerged.map((p) => `${p.key}:${p.state?.pr ? "submitted" : "not submitted"}`).join(", ")})`,
				);
			await sleep(60_000);
		}
	}
	private async cutWorktree(): Promise<void> {
		if (this.state.base && existsSync(join(this.worktree, ".git"))) {
			this.log("worktree", `reusing ${this.worktree}`);
			return;
		}
		await this.git(["fetch", "-q", this.settings.remote], this.settings.repo);
		const chosen = await this.chooseBase();
		mkdirSync(join(this.settings.work, "wt"), { recursive: true });
		if (existsSync(this.worktree)) rmSync(this.worktree, { recursive: true, force: true });
		await this.run(["git", "worktree", "prune"], { cwd: this.settings.repo });
		await this.git(["worktree", "add", "-B", this.branch, this.worktree, chosen.base], this.settings.repo);
		const exclude = (await this.git(["rev-parse", "--git-path", "info/exclude"])).trim();
		appendFileSync(exclude.startsWith("/") ? exclude : join(this.worktree, exclude), ".w7/\n");
		mkdirSync(join(this.worktree, ".w7"), { recursive: true });
		if (chosen.stacked) {
			const init = await this.gh(["stack", "init", "--base", this.settings.trunk, ...chosen.chain, this.branch]);
			if (init.code !== 0) throw new TicketFailure(`gh stack init failed: ${tail(init.output, 10)}`);
		}
		this.save({ base: chosen.base, stacked: chosen.stacked, chain: chosen.chain });
		this.log(
			"worktree",
			`${this.worktree} from ${chosen.base}${chosen.stacked ? ` (stack ${chosen.chain.join(" ← ")})` : ""}`,
		);
	}
	private async commitLeftovers(message: string): Promise<void> {
		await this.git(["add", "-A"]);
		const staged = await this.run(["git", "diff", "--cached", "--quiet"]);
		if (staged.code !== 0) await this.git(["commit", "-qm", message]);
	}
	private async head(): Promise<string> {
		return this.git(["rev-parse", "HEAD"]);
	}
	private async diffAgainstBase(): Promise<{ files: string[]; stat: string; diff: string }> {
		const base = this.state.base!;
		const files = (await this.git(["diff", "--name-only", `${base}...HEAD`])).split("\n").filter(Boolean);
		const stat = await this.git(["diff", "--numstat", `${base}...HEAD`]);
		const diff = await this.git(["diff", `${base}...HEAD`]);
		return { files, stat, diff: diff.slice(0, 120_000) };
	}

	// ---- stages --------------------------------------------------------------------------------------------------
	private async pack(): Promise<void> {
		const path = join(this.worktree, ".w7", "CONTEXT.md");
		if (this.state.pack && existsSync(path)) return;
		const result = await this.seat("pack", this.packPrompt(), { logName: "pack.jsonl" });
		writeFileSync(
			path,
			result.final.trim() ? result.final : "(the pack maker returned nothing; read the worktree directly)\n",
		);
		this.save({ pack: true });
		this.log("pack", `rc=${result.code} bytes=${Buffer.byteLength(result.final)}`);
	}
	/** Rounds of one session until the writer says DONE; a fresh session name starts a fresh writer. */
	private async writerRounds(session: string, prompt: string, continueLine: string): Promise<string> {
		const { key } = this.ticket;
		let final = "";
		for (let round = 1; round <= this.t.writerRounds; round++) {
			const result = await this.seat("writer", round === 1 ? prompt : continueLine, {
				system: this.writerSystem(),
				session,
				continueSession: round > 1,
				logName: `${session}.r${round}.jsonl`,
			});
			final = result.final;
			this.log(`writer:${session}`, `round ${round} rc=${result.code} final=${JSON.stringify(final.slice(-160))}`);
			if (final.includes(`DONE ${key}`)) return final;
			if (final.includes(`BLOCKED ${key}`)) throw new TicketFailure(`writer BLOCKED: ${final.slice(-600)}`);
			if (result.code !== 0) await sleep(30_000);
		}
		throw new TicketFailure(`writer did not finish in ${this.t.writerRounds} rounds`);
	}
	private continueLine(): string {
		return `Continue the same ticket. Finish and end with the exact line \`DONE ${this.ticket.key}\` or \`BLOCKED ${this.ticket.key}\`. ${INITIATIVE_LINES}`;
	}
	private async write(): Promise<void> {
		if (this.state.writer) return;
		const final = await this.writerRounds("write", this.writerPrompt(), this.continueLine());
		await this.commitLeftovers(`${this.ticket.key}: writer leftovers`);
		const split = final.match(/^SPLIT:\s*(.+)$/m)?.[1]?.trim();
		if (split) {
			writeFileSync(
				join(this.directory, "split.json"),
				`${JSON.stringify({ key: this.ticket.key, remains: split }, null, 2)}\n`,
			);
			this.log("split", split);
		}
		this.save({ writer: { rounds: 1, final }, ...(split ? { split } : {}) });
	}
	private async fixRound(session: string, what: string, output: string): Promise<void> {
		await this.writerRounds(session, this.fixPrompt(what, output), this.continueLine());
		await this.commitLeftovers(`${this.ticket.key}: ${session}`);
	}
	async touchedCrates(): Promise<string[]> {
		const committed = await this.git(["diff", "--name-only", `${this.state.base}...HEAD`]);
		const dirty = await this.git(["diff", "--name-only"]);
		const crates = new Set<string>();
		for (const path of `${committed}\n${dirty}`.split("\n")) {
			const match = path.match(/^crates\/([^/]+)\//);
			if (!match) continue;
			const manifest = join(this.worktree, "crates", match[1]!, "Cargo.toml");
			if (!existsSync(manifest)) continue;
			const name = readFileSync(manifest, "utf8").match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
			if (name) crates.add(name);
		}
		return [...crates].sort();
	}
	/** Tests of the touched crates under one of the ruled build slots; zero tests run is not a pass. */
	async cargoTest(): Promise<{ code: number; ran: number; crates: string[]; output: string }> {
		const crates = await this.touchedCrates();
		if (!crates.length) return { code: 1, ran: 0, crates, output: "no crate under crates/ changed; zero tests ran" };
		const floor = this.settings.diskFloorGiB;
		for (let waited = 0; freeGiB(this.settings.work) < floor; waited++) {
			if (waited % 12 === 0) this.log("disk", `free space below the ${floor} GiB floor; waiting`);
			await sleep(5_000);
		}
		const release = await acquireSlot(join(this.settings.work, "build-slots"), this.settings.buildSlots, this.log);
		try {
			const target = join(this.settings.work, "target", this.ticket.key);
			const argv = ["cargo", "test", "--no-fail-fast", ...crates.flatMap((c) => ["-p", c])];
			const result = await this.run(argv, {
				timeoutMs: this.t.testMs,
				env: {
					CARGO_TARGET_DIR: target,
					CARGO_BUILD_JOBS: String(this.settings.cargoJobs),
					RUST_TEST_THREADS: String(this.settings.cargoJobs),
				},
				logName: "cargo-test.log",
			});
			let ran = 0;
			for (const match of result.output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm))
				ran += Number(match[1]) + Number(match[2]);
			return { code: result.code === 0 && ran === 0 ? 1 : result.code, ran, crates, output: result.output };
		} finally {
			release();
		}
	}
	private async tests(label: string): Promise<void> {
		let result = await this.cargoTest();
		this.log(label, `rc=${result.code} ran=${result.ran} crates=${result.crates.join(",")}`);
		let rounds = 0;
		if (result.code !== 0) {
			rounds = 1;
			await this.fixRound(
				`fix-${label}`,
				result.ran === 0
					? "No tests ran for the crates you changed. Add the tests the acceptance names and run them."
					: "The tests failed.",
				result.output,
			);
			result = await this.cargoTest();
			this.log(`${label}:2`, `rc=${result.code} ran=${result.ran}`);
			if (result.code !== 0)
				throw new TicketFailure(
					result.ran === 0
						? "zero tests ran after the fix round"
						: `tests still failing: ${tail(result.output, 30)}`,
				);
		}
		this.save({ tests: { crates: result.crates, ran: result.ran, rounds } });
	}
	private seams(files: string[]): ReviewSeam[] {
		const seams = new Set<ReviewSeam>();
		for (const file of files) {
			const f = file.toLowerCase();
			if (/custody|owner|grant/.test(f)) seams.add("custody");
			if (/auth|token|credential|permit/.test(f)) seams.add("auth");
			if (/store|storage|persist|ledger|db|sqlite|lmdb|heed/.test(f)) seams.add("persistence");
			if (/migrat/.test(f)) seams.add("migration");
			if (/crypt|sign|hash|seal/.test(f)) seams.add("crypto");
			if (/lock|mutex|atomic|concurr|thread/.test(f)) seams.add("concurrency");
			if (/ffi|napi|uniffi|abi|wire|proto/.test(f)) seams.add("abi");
			if (/^crates\/[^/]+\/src\/lib\.rs$|public|api/.test(f)) seams.add("public_api");
		}
		return [...seams];
	}
	private categories(files: string[]): FixCategory[] {
		const set = new Set<FixCategory>();
		for (const file of files) {
			const f = file.toLowerCase();
			if (/test/.test(f)) set.add("tests");
			else if (/store|persist|ledger|db|migrat/.test(f)) set.add("persistence");
			else if (/auth|crypt|seal|permit/.test(f)) set.add("security");
			else if (/lock|mutex|atomic|concurr/.test(f)) set.add("concurrency");
			else if (/ffi|napi|uniffi|abi|wire|proto/.test(f)) set.add("abi");
			else if (/error|result|fail/.test(f)) set.add("error_semantics");
			else set.add("logic");
		}
		return [...set];
	}
	private numstat(stat: string): { lines: number; hunks: number } {
		let lines = 0;
		for (const row of stat.split("\n")) {
			const [added, deleted] = row.split("\t");
			lines += Number(added) || 0;
			lines += Number(deleted) || 0;
		}
		return { lines, hunks: stat.split("\n").filter(Boolean).length };
	}
	private async reviewers(tier: ReviewTier, diff: string, logSuffix: string): Promise<Record<string, string>> {
		const names: Array<"grok" | "opus"> =
			tier === "grok" ? ["grok"] : tier === "grok_plus_opus" ? ["grok", "opus"] : [];
		const prompt = this.reviewPrompt(diff);
		const verdicts: Record<string, string> = {};
		await Promise.all(
			names.map(async (name) => {
				const result = await this.seat(name, prompt, { logName: `review-${name}${logSuffix}.jsonl` });
				verdicts[name] =
					result.code !== 0 || !/VERDICT:/.test(result.final)
						? `unavailable rc=${result.code}`
						: /VERDICT:\s*LANDABLE/.test(result.final)
							? "LANDABLE"
							: `DEFECTS\n${tail(result.final, 60)}`;
				this.log(`review:${name}`, verdicts[name]!.split("\n")[0]!);
			}),
		);
		return verdicts;
	}
	private async review(): Promise<void> {
		if (this.state.review) return;
		const routing = this.options.routing ?? routingSeatsFromEnvironment(this.options.env ?? process.env);
		const before = await this.diffAgainstBase();
		const stat = this.numstat(before.stat);
		const tier = await routeReviewTier(
			{
				changed_files: before.files.length,
				changed_lines: stat.lines,
				hunks: stat.hunks,
				seams_touched: this.seams(before.files),
				prior_bot_findings: 0,
				test_delta: { added: before.files.filter((f) => /test/.test(f)).length, removed: 0 },
				docs_only: before.files.every((f) => /\.md$/.test(f) || f.startsWith("impl-notes/")),
			},
			routing,
			pinnedReviewTier(this.ticket.tier),
		);
		appendFileSync(
			join(this.directory, "routing.jsonl"),
			`${JSON.stringify({ question: "review_tier", ...tier })}\n`,
		);
		this.log("review:tier", `${tier.choice} by ${tier.decided_by}`);
		const verdicts = await this.reviewers(tier.choice, before.diff, "");
		const defects = Object.entries(verdicts).filter(([, v]) => v.startsWith("DEFECTS"));
		const review: NonNullable<OneironTicketState["review"]> = { tier, verdicts };
		if (defects.length) {
			review.fixRound = true;
			const reviewedHead = await this.head();
			await this.fixRound(
				"fix-review",
				`A reviewer found blocking defects:\n${defects.map(([n, v]) => `--- ${n}\n${v}`).join("\n")}`,
				"",
			);
			await this.tests("tests-after-review");
			const delta = (await this.git(["diff", "--name-only", `${reviewedHead}...HEAD`])).split("\n").filter(Boolean);
			const deltaStat = this.numstat(await this.git(["diff", "--numstat", `${reviewedHead}...HEAD`]));
			const trivial = await routeTrivialFix(
				{
					changed_files: delta.length,
					changed_lines: deltaStat.lines,
					hunks: deltaStat.hunks,
					semantic_categories_touched: this.categories(delta),
					prior_rounds: 1,
				},
				routing,
			);
			appendFileSync(
				join(this.directory, "routing.jsonl"),
				`${JSON.stringify({ question: "trivial_fix_eligible", ...trivial })}\n`,
			);
			this.log("review:trivial", `${trivial.choice} by ${trivial.decided_by}`);
			if (trivial.choice === "review_again") {
				const again = await this.reviewers(tier.choice, (await this.diffAgainstBase()).diff, "-2");
				review.recheck = Object.entries(again)
					.map(([n, v]) => `${n}: ${v.split("\n")[0]}`)
					.join("; ");
			} else review.recheck = "trivial delta; reviewers not re-run";
		}
		this.save({ review });
	}
	private stripAttribution(text: string): string {
		return text
			.split("\n")
			.filter((line) => !ATTRIBUTION.test(line))
			.join("\n");
	}
	private async attributionScan(): Promise<string[]> {
		const messages = await this.git(["log", "--format=%H %s%n%b", `${this.state.base}..HEAD`]);
		const hits = messages.split("\n").filter((line) => ATTRIBUTION.test(line));
		this.save({ attribution: hits });
		if (hits.length) this.log("attribution", `commit text carries attribution lines: ${hits.join(" | ")}`);
		return hits;
	}
	private prBody(): string {
		const { contract, acceptance, row, key } = this.ticket;
		const writer = this.state.writer?.final ?? "";
		const body = writer.match(/PR BODY:\s*([\s\S]+?)(?:\n\s*(?:DONE|SPLIT:)|$)/)?.[1]?.trim() ?? "";
		const verdicts = this.state.review
			? Object.entries(this.state.review.verdicts)
					.map(([n, v]) => `${n}: ${v.split("\n")[0]}`)
					.join(", ")
			: "none";
		return this.stripAttribution(
			`${contract}\n\nAcceptance: ${acceptance}\n\nRow: ${row ?? "-"} · ticket ${key} · review tier ${this.state.review?.tier.choice ?? "-"} (${verdicts})${this.state.split ? `\n\nSPLIT: ${this.state.split}` : ""}\n\n${body}`,
		);
	}
	private async publish(): Promise<void> {
		if (this.state.pr) return;
		await this.commitLeftovers(`${this.ticket.key}: leftovers before publication`);
		await this.attributionScan();
		const repo = await this.githubRepo();
		const bodyPath = join(this.directory, "PR-BODY.md");
		writeFileSync(bodyPath, `${this.prBody()}\n`);
		const title = `${this.ticket.key}: ${this.ticket.title}`.slice(0, 250);
		let pr: number | undefined;
		const existing = await this.gh(["pr", "view", this.branch, "--repo", repo, "--json", "number,url,state"]);
		if (existing.code === 0) {
			const view = JSON.parse(existing.output) as { number: number; url: string; state: string };
			if (view.state === "OPEN") pr = view.number;
		}
		if (this.state.stacked) {
			const submit = await this.gh(["stack", "submit", "--auto", "--open", "--remote", this.settings.remote]);
			if (submit.code !== 0) throw new TicketFailure(`gh stack submit failed: ${tail(submit.output, 15)}`);
			const view = JSON.parse((await this.gh(["stack", "view", "--json"])).output || "{}") as {
				branches?: Array<{ name: string; pr?: { number: number; url?: string } }>;
			};
			pr ??= view.branches?.find((b) => b.name === this.branch)?.pr?.number;
			if (!pr) throw new TicketFailure("gh stack submit opened no pull request for this branch");
			const edit = await this.gh([
				"pr",
				"edit",
				String(pr),
				"--repo",
				repo,
				"--title",
				title,
				"--body-file",
				bodyPath,
			]);
			if (edit.code !== 0) this.log("publish", `pr edit failed: ${tail(edit.output, 5)}`);
		} else if (!pr) {
			const push = await this.run(["git", "push", "-u", this.settings.remote, this.branch], {
				timeoutMs: this.t.ghMs,
				logName: "git-push.log",
			});
			if (push.code !== 0) throw new TicketFailure(`git push failed: ${tail(push.output, 10)}`);
			const create = await this.gh([
				"pr",
				"create",
				"--repo",
				repo,
				"--title",
				title,
				"--body-file",
				bodyPath,
				"--base",
				this.settings.trunk,
				"--head",
				this.branch,
			]);
			if (create.code !== 0) throw new TicketFailure(`gh pr create failed: ${tail(create.output, 10)}`);
			pr = Number(create.output.match(/\/pull\/(\d+)/)?.[1]);
			if (!pr) {
				const view = JSON.parse(
					(await this.gh(["pr", "view", this.branch, "--repo", repo, "--json", "number"])).output || "{}",
				);
				pr = Number((view as { number?: number }).number);
			}
		} else {
			const push = await this.run(["git", "push", this.settings.remote, this.branch], {
				timeoutMs: this.t.ghMs,
				logName: "git-push.log",
			});
			if (push.code !== 0) throw new TicketFailure(`git push failed: ${tail(push.output, 10)}`);
		}
		if (!Number.isInteger(pr)) throw new TicketFailure("No pull request number after publication");
		this.save({
			pr,
			prUrl: `https://github.com/${repo}/pull/${pr}`,
			submittedHead: await this.head(),
			submittedAt: new Date().toISOString(),
		});
		this.log("publish", `${this.state.prUrl} head ${this.state.submittedHead}`);
	}
	private async requestCodeRabbit(): Promise<void> {
		if (this.state.coderabbit) return;
		const repo = await this.githubRepo();
		const result = await this.gh([
			"pr",
			"comment",
			String(this.state.pr),
			"--repo",
			repo,
			"--body",
			"@coderabbitai review",
		]);
		this.save({ coderabbit: result.code === 0 ? "requested" : "failed" });
		this.log("coderabbit", result.code === 0 ? "requested" : `request failed (ignored): ${tail(result.output, 3)}`);
	}
	/** Wait bounded for Qodo and Codex on the submitted head; every other bot is read but never waited for. */
	private async waitForBots(): Promise<OneironBotComment[]> {
		const repo = await this.githubRepo();
		const started = (this.options.now ?? Date.now)();
		let report = await fetchOneironBotReviews(
			this.ghJson,
			repo,
			this.state.pr!,
			this.state.submittedHead!,
			this.state.submittedAt,
		);
		while ((this.options.now ?? Date.now)() - started < this.t.botsMs) {
			const settled = REQUIRED_REVIEWERS.every(
				(r) => report.completed.includes(r) || report.unavailable.includes(r),
			);
			if (settled) break;
			await sleep(60_000);
			report = await fetchOneironBotReviews(
				this.ghJson,
				repo,
				this.state.pr!,
				this.state.submittedHead!,
				this.state.submittedAt,
			);
		}
		const waitedMs = (this.options.now ?? Date.now)() - started;
		this.save({
			bots: {
				completed: report.completed,
				unavailable: report.unavailable,
				comments: report.comments.length,
				waitedMs,
			},
		});
		this.log(
			"bots",
			`completed=${report.completed.join(",") || "-"} unavailable=${report.unavailable.join(",") || "-"} comments=${report.comments.length} waited=${Math.round(waitedMs / 1000)}s`,
		);
		return report.comments;
	}
	private async botRound(comments: OneironBotComment[]): Promise<void> {
		if (this.state.botRound) return;
		const repo = await this.githubRepo();
		const final = await this.writerRounds(
			"bots",
			this.botRoundPrompt(repo, this.state.pr!, comments),
			this.continueLine(),
		);
		await this.commitLeftovers(`${this.ticket.key}: after bot review`);
		const head = await this.head();
		if (head !== this.state.submittedHead) {
			await this.tests("tests-after-bots");
			const push = this.state.stacked
				? await this.gh(["stack", "push", "--remote", this.settings.remote])
				: await this.run(["git", "push", this.settings.remote, this.branch], {
						timeoutMs: this.t.ghMs,
						logName: "git-push.log",
					});
			if (push.code !== 0) throw new TicketFailure(`push after the bot round failed: ${tail(push.output, 10)}`);
			this.save({ submittedHead: await this.head() });
		}
		this.save({ botRound: { final: final.slice(-2000), head: this.state.submittedHead! } });
		this.log("bots:round", `done at ${this.state.submittedHead}`);
	}

	/** Worktree → pack → writer → tests → review → publish → CodeRabbit → bots → bot round. Exit 0 = submitted. */
	async submit(): Promise<void> {
		await this.cutWorktree();
		await this.pack();
		await this.write();
		await this.tests("tests");
		await this.review();
		await this.publish();
		await this.requestCodeRabbit();
		const comments = await this.waitForBots();
		await this.botRound(comments);
	}

	private async waitForParents(): Promise<void> {
		for (let waited = 0; ; waited++) {
			const pending = this.ticket.blockedBy.filter((key) => !this.stateOf(key)?.merged);
			if (!pending.length) return;
			if (waited % 10 === 0) this.log("merge", `waiting for blockers to merge: ${pending.join(", ")}`);
			await sleep(60_000);
		}
	}
	private async mergedOnGitHub(repo: string): Promise<boolean> {
		const view = await this.gh(["pr", "view", String(this.state.pr), "--repo", repo, "--json", "state,mergedAt"]);
		if (view.code !== 0) return false;
		const parsed = JSON.parse(view.output) as { state?: string; mergedAt?: string | null };
		return parsed.state === "MERGED" || !!parsed.mergedAt;
	}
	/** Native stacks: sync then merge; a lone PR is an ordinary squash. One merge at a time on this host. */
	async merge(): Promise<void> {
		if (this.state.merged) return;
		if (!this.state.pr) throw new TicketFailure("merge requires a submitted pull request; run submit first");
		await this.waitForParents();
		const repo = await this.githubRepo();
		const release = await acquireSlot(join(this.settings.work, "merge-lock"), 1, this.log);
		try {
			if (await this.mergedOnGitHub(repo)) {
				this.save({ merged: true });
				this.log("merge", "already merged");
				return;
			}
			if (this.state.stacked) {
				const sync = await this.gh(["stack", "sync"]);
				if (sync.code !== 0) {
					this.log("merge", `gh stack sync failed; one fix round: ${tail(sync.output, 5)}`);
					await this.fixRound(
						"fix-merge",
						`\`gh stack sync\` could not rebase this branch onto ${this.settings.remote}/${this.settings.trunk}. Rebase this worktree onto ${this.settings.remote}/${this.settings.trunk}, resolve the conflicts, keep every commit's intent, and do not push.`,
						sync.output,
					);
					await this.tests("tests-after-merge-fix");
					const again = await this.gh(["stack", "sync"]);
					if (again.code !== 0) throw new TicketFailure(`gh stack sync still failing: ${tail(again.output, 10)}`);
				}
				const merge = await this.gh(["stack", "merge", "--squash", "--yes"]);
				if (merge.code !== 0 && !(await this.mergedOnGitHub(repo)))
					throw new TicketFailure(`gh stack merge failed: ${tail(merge.output, 15)}`);
			} else {
				const title = `${this.ticket.key}: ${this.ticket.title}`.slice(0, 250);
				const args = [
					"pr",
					"merge",
					String(this.state.pr),
					"--repo",
					repo,
					"--squash",
					"--subject",
					title,
					"--body-file",
					join(this.directory, "PR-BODY.md"),
				];
				let merge = await this.gh(args);
				if (merge.code !== 0 && !(await this.mergedOnGitHub(repo))) {
					this.log("merge", `squash failed; one rebase fix round: ${tail(merge.output, 5)}`);
					await this.git(["fetch", "-q", this.settings.remote]);
					await this.fixRound(
						"fix-merge",
						`The pull request does not merge. Rebase this worktree onto ${this.settings.remote}/${this.settings.trunk}, resolve the conflicts, keep every commit's intent, and do not push.`,
						merge.output,
					);
					await this.tests("tests-after-merge-fix");
					const push = await this.run(["git", "push", "--force-with-lease", this.settings.remote, this.branch], {
						timeoutMs: this.t.ghMs,
						logName: "git-push.log",
					});
					if (push.code !== 0) throw new TicketFailure(`push after the rebase failed: ${tail(push.output, 10)}`);
					merge = await this.gh(args);
					if (merge.code !== 0 && !(await this.mergedOnGitHub(repo)))
						throw new TicketFailure(`gh pr merge failed: ${tail(merge.output, 15)}`);
				}
			}
			this.save({ merged: true });
			this.log("merge", `MERGED ${this.state.prUrl}`);
		} finally {
			release();
		}
		await this.run(["git", "worktree", "remove", "--force", this.worktree], { cwd: this.settings.repo });
		await this.run(["git", "worktree", "prune"], { cwd: this.settings.repo });
	}
}

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
