import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type FixCategory,
	pinnedReviewTier,
	type ReviewSeam,
	type ReviewTier,
	type RoutingAnswer,
	type RoutingSeats,
	routeReviewTier,
	routeTrivialFix,
	routeWriterContinuation,
	routingSeatsFromEnvironment,
} from "../routing.js";
import {
	FACTORY_JSON_EVENT_PROFILE,
	factoryCargoBinDirectory,
	factoryOwnedEnvironment,
	locateFactoryCli,
} from "../runtime.js";
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
	seats?: Partial<Record<SeatName, OneironSeat>>;
	/**
	 * Silence, never a clock. A seat or cargo run whose stream produces nothing for this long is killed and the
	 * round continues in the same session. A model that is still working is never interrupted.
	 */
	idleMs?: number;
	/** Ordered build hosts for cargo. The first reachable one runs it; an empty list keeps cargo on this host. */
	buildHosts?: OneironBuildHost[];
	timeouts?: Partial<{ ghMs: number; botsMs: number }>;
}
/** A host that runs cargo for this factory: the worktree is synced to `<root>/wt/<key>` and cargo runs there. */
export interface OneironBuildHost {
	/** ssh destination, e.g. `olety@100.124.216.116`. */
	sshHost: string;
	/** Absolute directory on that host; build trees live under `<root>/wt/<key>`. */
	root: string;
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
const DEFAULT_TIMEOUTS = { ghMs: 300_000, botsMs: 2_700_000 };
/** No event on a seat's stream for this long means the seat is gone, not thinking. */
export const DEFAULT_IDLE_MS = 30 * 60_000;
/** A round that writes nothing at all and exits non-zero is a seat that cannot start; enough of them is a failure. */
const MAX_SILENT_ROUNDS = 20;
/** The exit code the runner reports for a stream that went silent. Distinct from 124, which no longer happens. */
export const SEAT_IDLE_EXIT_CODE = 125;

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

type ContentBlock = { type?: unknown; text?: unknown };
function contentText(content: ContentBlock[]): string {
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
}

/**
 * The text of the last assistant reply of a turn that ended. A reply that called a tool, was cut off or errored
 * leaves nothing, and so does a stream without `agent_end`: earlier commentary is never reused as the final.
 */
export function finalAssistantText(jsonl: string): string {
	let final = "";
	let ended = false;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const record = event as { type?: unknown; message?: Record<string, unknown> };
		// Compaction and harness metadata can arrive after agent_end; it is not a new turn.
		if ((record.type === "message_start" || record.type === "message_end") && record.message?.role === "custom")
			continue;
		if (record.type === "agent_start" || record.type === "message_start") {
			ended = false;
			final = "";
		}
		if (record.type === "agent_end") {
			ended = true;
			continue;
		}
		if (record.type !== "message_end") continue;
		ended = false;
		final = "";
		const message = record.message;
		if (
			message?.role !== "assistant" ||
			message.stopReason !== "stop" ||
			!Array.isArray(message.content) ||
			(message.content as ContentBlock[]).some((block) => block?.type === "toolCall")
		)
			continue;
		final = contentText(message.content as ContentBlock[]);
	}
	return ended ? final : "";
}

/** Lines of `text` that sit outside fenced code blocks; fence markers themselves are dropped. */
function unfencedLines(text: string): { lines: string[]; open: boolean } {
	const lines: string[] = [];
	let fence: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			lines.push("");
			continue;
		}
		lines.push(fence ? "" : line);
	}
	return { lines, open: fence !== undefined };
}

export type WriterTerminal = { kind: "done"; line: string } | { kind: "blocked"; line: string; why: string };
/**
 * A writer reply is terminal only when its last non-empty line, outside any code fence, is exactly `DONE <key>` or
 * `BLOCKED <key>: <why>`. The same words anywhere else, inside a fence or with other text on the line are not.
 */
export function writerTerminal(final: string, key: string): WriterTerminal | undefined {
	const { lines, open } = unfencedLines(final);
	if (open) return undefined;
	const raw = final.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		if (!raw[index]!.trim()) continue;
		const line = lines[index]!.trimEnd();
		if (line === `DONE ${key}`) return { kind: "done", line };
		const blocked = `BLOCKED ${key}: `;
		if (line.startsWith(blocked) && line.slice(blocked.length).trim())
			return { kind: "blocked", line, why: line.slice(blocked.length).trim() };
		return undefined;
	}
	return undefined;
}

/**
 * The one standalone `VERDICT: LANDABLE|DEFECTS` line of a reviewer's final reply, outside code fences. None, or
 * two that disagree, is no verdict. Only terminal assistant text is inspected, never a raw event stream.
 */
export function reviewVerdict(final: string): "LANDABLE" | "DEFECTS" | undefined {
	const verdicts = new Set<"LANDABLE" | "DEFECTS">();
	for (const line of unfencedLines(final).lines) {
		const match = line.match(/^VERDICT:[ \t]*(LANDABLE|DEFECTS)[ \t]*$/)?.[1];
		if (match) verdicts.add(match as "LANDABLE" | "DEFECTS");
	}
	return verdicts.size === 1 ? [...verdicts][0] : undefined;
}

interface SessionEntry {
	type?: string;
	id?: string;
	cwd?: string;
	timestamp?: string;
	rlmDepth?: number;
	git?: { commit?: string };
	message?: {
		role?: string;
		stopReason?: string;
		content?: ContentBlock[];
		responseId?: string;
		provider?: string;
		model?: string;
		usage?: unknown;
		errorMessage?: string;
	};
}
function sessionEntries(path: string): SessionEntry[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as SessionEntry);
}
/** Whether a session directory already holds a session file, i.e. a later seat call continues it. */
function hasSessionFile(directory: string): boolean {
	return existsSync(directory) && readdirSync(directory).some((file) => file.endsWith(".jsonl"));
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
			/** Pause after a round whose seat process failed to start or died. Never a limit on the work itself. */
			retryDelayMs?: number;
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
			idleMs: l.idleMs ?? DEFAULT_IDLE_MS,
			buildHosts: l.buildHosts ?? [],
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
	/**
	 * The blockers as the launcher last wrote them, re-read on every wait iteration. A relaunch that corrects a
	 * ticket's DAG therefore reaches a runner that is already waiting, with no restart.
	 */
	private blockers(): string[] {
		try {
			const run = readTicketRun(join(this.directory, "ticket.json"));
			if (!isDeepStrictEqual(run.blockedBy, this.ticket.blockedBy)) {
				this.log(
					"blockers",
					`ticket.json changed: ${this.ticket.blockedBy.join(",") || "-"} → ${run.blockedBy.join(",") || "-"}`,
				);
				this.ticket.blockedBy = run.blockedBy;
			}
		} catch {}
		return this.ticket.blockedBy;
	}

	/**
	 * gh and git get a wall clock because they are network calls. A model or a build gets `idleMs` instead: the
	 * deadline moves forward on every byte the child writes, so work that is still producing is never interrupted
	 * and only silence ends it.
	 */
	async run(
		argv: string[],
		options: {
			cwd?: string;
			timeoutMs?: number;
			idleMs?: number;
			env?: Record<string, string>;
			logName?: string;
			onIdle?: (idleMs: number) => void;
			/** Written to the child's stdin, then closed; without it stdin is /dev/null. */
			input?: string;
		} = {},
	): Promise<Exec> {
		const cwd = options.cwd ?? this.worktree;
		const idleMs = options.idleMs;
		const timeoutMs = idleMs === undefined ? (options.timeoutMs ?? this.t.ghMs) : idleMs;
		return new Promise((resolve) => {
			const child = spawn(argv[0]!, argv.slice(1), {
				cwd,
				env: { ...(this.options.env ?? process.env), ...options.env, GIT_OPTIONAL_LOCKS: "0" },
				stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			});
			let output = "";
			let inputError: Error | undefined;
			if (options.input !== undefined) {
				child.stdin?.on("error", (error) => {
					inputError = error;
				});
				child.stdin?.end(options.input);
			}
			let expired = false;
			let timer: NodeJS.Timeout;
			const arm = () => {
				timer = setTimeout(() => {
					expired = true;
					if (idleMs !== undefined) options.onIdle?.(idleMs);
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
				}, timeoutMs);
			};
			arm();
			const collect = (chunk: Buffer) => {
				if (idleMs !== undefined && !expired) {
					clearTimeout(timer);
					arm();
				}
				output += chunk.toString();
				if (output.length > 64 * 1024 * 1024) output = output.slice(-32 * 1024 * 1024);
			};
			child.stdout!.on("data", collect);
			child.stderr!.on("data", collect);
			child.on("error", (error) => {
				clearTimeout(timer);
				resolve({ code: 127, output: `${output}\n${error.message}` });
			});
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				if (options.logName)
					appendFileSync(join(this.directory, "logs", options.logName), `\n=== ${argv.join(" ")}\n${output}`);
				const note = idleMs === undefined ? "TIMEOUT" : `IDLE ${Math.round(idleMs / 1000)}s`;
				resolve({
					code: expired
						? idleMs === undefined
							? 124
							: SEAT_IDLE_EXIT_CODE
						: inputError
							? 127
							: (code ?? (signal ? 128 : 1)),
					output: expired ? `${output}\n${note}` : inputError ? `${output}\nstdin: ${inputError.message}` : output,
				});
			});
		});
	}
	/**
	 * The ruled build order, as environment. The wrapper shipped beside this module goes first on PATH, so both
	 * this runner's own cargo and every cargo the writers call from their worktree land on a build host.
	 * With no build hosts configured nothing is prepended and cargo stays on this host.
	 */
	cargoEnvironment(): Record<string, string> {
		const hosts = this.settings.buildHosts;
		if (!hosts.length) return {};
		const path = (this.options.env ?? process.env).PATH ?? "";
		return {
			PATH: `${factoryCargoBinDirectory()}:${path}`,
			W7_CARGO_WORK: this.settings.work,
			W7_CARGO_HOSTS: hosts.map((h) => `${h.sshHost}:${h.root}`).join(";"),
		};
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

	/**
	 * One seat call. prime-agent print mode with the owned frontend, daemon-hosted so the session is attachable
	 * from another terminal while this stream is consumed, or an explicit command. The only guard is silence.
	 */
	async seat(
		name: SeatName,
		prompt: string,
		options: {
			system?: string;
			session?: string;
			continueSession?: boolean;
			/** An absolute session file to continue instead of the newest one in `session`. */
			resumeSession?: string;
			logName: string;
		},
	): Promise<{ code: number; final: string; bytes: number; idle: boolean; activity: boolean }> {
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
				"--daemon-hosted",
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
				...(options.resumeSession ? ["--resume", options.resumeSession] : options.continueSession ? ["-c"] : []),
				...(options.system ? ["--append-system-prompt", options.system] : []),
			];
		}
		const step = options.logName.replace(/\.jsonl$/, "");
		const result = await this.run(argv, {
			// Print mode reads a piped prompt; a review diff in argv can exceed the per-argument limit (E2BIG).
			input: "command" in spec ? undefined : prompt,
			idleMs: this.settings.idleMs,
			env: { ...factoryOwnedEnvironment(), ...this.cargoEnvironment() },
			onIdle: (idleMs) => this.noteIdle(step, idleMs),
		});
		writeFileSync(logPath, result.output, { flag: "a" });
		// Never the raw stream: it carries the prompts, which quote the completion line.
		const final = "command" in spec ? result.output.trim() : finalAssistantText(result.output);
		return {
			code: result.code,
			final,
			bytes: Buffer.byteLength(result.output),
			idle: result.code === SEAT_IDLE_EXIT_CODE,
			// Tools or delegated children ran: a review that did this and then failed is incomplete, not absent.
			activity: /"type"\s*:\s*"(?:tool_execution_start|rlm_child_update)"/.test(result.output),
		};
	}
	/** A seat that went silent is killed and journaled; the round continues in the same session. */
	private noteIdle(step: string, idleMs: number): void {
		this.log("seat idle", `${step}: no event for ${Math.round(idleMs / 60_000)} min; killing the seat process`);
		this.save({
			idleKills: [...(this.state.idleKills ?? []), { at: new Date().toISOString(), step, idleMs }],
		});
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

Task (read-only): build the context pack for the writer of this ticket. Read-only task; your final message is the pack.
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
		return `${this.ticketHeader()}
Context pack: .w7/CONTEXT.md (Muse wrote it; read it first). The docs are the intent; the code is what is.

Rules:
1. Work only in this worktree. Never touch another checkout, the docs repo, or anything outside it.
2. Implement the contract until the acceptance line passes. Write the tests it names.
3. Run the tests of the crates you touched (cargo test -p <crate>) before you stop; the whole workspace only when your change crosses crates.
4. Small commits, plain messages, commit everything before you stop. No attribution lines anywhere.
5. Never restart, install or upgrade anything on this host. Never touch remotes or other branches.
6. Before DONE, write \`PR BODY:\` and 3 to 8 lines: what changed, the canon page path that defines it, how the acceptance is tested.
7. If something cannot be done, one line \`COULD NOT: <what and why>\`, and still commit what works.
${WRITER_LINES}
${INITIATIVE_LINES}
${this.completionRule()}`;
	}
	/** The only words that end a writer's rounds; see `writerTerminal`. */
	completionRule(): string {
		const { key } = this.ticket;
		return `The last line of your final reply, outside any code fence, is exactly \`DONE ${key}\`, or \`BLOCKED ${key}: <why>\` when no useful authorized path remains. Nothing after it. Any other reply continues this session.`;
	}
	fixPrompt(what: string, output: string): string {
		return `Same ticket ${this.ticket.key}, same worktree. ${what} Fix it, keep commits small, commit and run the tests of the crates you touched.
${this.completionRule()}
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
Below is EVERY bot comment on the pull request, unfiltered. It is a snapshot, not proof that all current feedback is gathered.
Before any fix, fetch and read the latest complete Qodo, Codex and CodeRabbit reviews, pull request comments, inline comments and review threads (with pagination), and this ticket's internal reviewer findings. Read every finding in full, deduplicate overlapping defects across sources, and decide each distinct finding on its merits before editing. Keep the source comment ids when deduplicating so no feedback disappears. A pending or queued bot review is not an unavailable one.
For every real defect: fix it in this worktree, commit with a plain message, and run the tests of the crates you touched. Skip an invalid or inapplicable finding only with an explicit reason.
Reply on each inline thread with what you did or why not: \`gh api repos/${repo}/pulls/${pr}/comments/<id>/replies -f body=<text>\` for review_comment entries.
After the fixes, post exactly one summary comment on the pull request: \`gh pr comment ${pr} --repo ${repo} --body <text>\`. Map each source comment id and each internal finding to its disposition, say what changed, what was skipped and why, and the validation you ran with its actual result. Never claim validation that did not run.
Never push, never merge, never close the pull request; the launcher pushes after you stop.
${WRITER_LINES}
${INITIATIVE_LINES}
${this.completionRule()}

${rendered || "(no bot comments)"}`;
	}

	// ---- git -----------------------------------------------------------------------------------------------------
	private async chooseBase(): Promise<{ base: string; stacked: boolean; chain: string[] }> {
		const remoteTrunk = `${this.settings.remote}/${this.settings.trunk}`;
		for (let waited = 0; ; waited++) {
			const parents = this.blockers().map((key) => ({ key, state: this.stateOf(key) }));
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
	private routing(): RoutingSeats {
		return this.options.routing ?? routingSeatsFromEnvironment(this.options.env ?? process.env);
	}
	/**
	 * Rounds of one session until the writer's last line is `DONE <key>` or `BLOCKED <key>: <why>`; a fresh session
	 * name starts a fresh writer. Any other reply continues the session: Jev and the Grok advisor only tell a plain
	 * continuation from a named split remainder, never a terminal verdict. Rounds are unbounded: a writer holding an
	 * ultralarge packet may work for many hours and no count may end it. The only exit that is not the writer's own
	 * is a run of rounds that produced no stream at all, which is a seat that cannot start rather than a model that
	 * is still working.
	 */
	async writerRounds(
		session: string,
		prompt: string,
		continueLine: string,
	): Promise<{ final: string; split?: string }> {
		const { key } = this.ticket;
		let final = "";
		let split: string | undefined;
		let silent = 0;
		// A runner restarted after a crash or a relaunch continues the writer it had, never a blank one.
		const prior = hasSessionFile(join(this.directory, "sessions", session));
		if (prior) this.log(`writer:${session}`, "continuing the existing session");
		for (let round = 1; ; round++) {
			const note = this.resumeNote();
			const result = await this.seat(
				"writer",
				[round === 1 ? prompt : continueLine, note].filter((part) => part !== undefined).join("\n\n"),
				{
					system: this.writerSystem(),
					session,
					continueSession: round > 1 || prior,
					logName: `${session}.r${round}.jsonl`,
				},
			);
			if (note !== undefined && result.bytes > 0) this.noteDelivered(note);
			final = result.final;
			this.log(
				`writer:${session}`,
				`round ${round} rc=${result.code}${result.idle ? " (seat idle)" : ""} bytes=${result.bytes} final=${JSON.stringify(final.slice(-160))}`,
			);
			const terminal = writerTerminal(final, key);
			if (terminal) {
				this.journalIntent(session, round, {
					choice: terminal.kind,
					decided_by: "code",
					confidence: null,
					reason: `exact last line: ${terminal.line}`,
					wall_clock_ms: 0,
				});
				if (terminal.kind === "done") return { final, ...(split ? { split } : {}) };
				throw new TicketFailure(`writer BLOCKED: ${terminal.line}\n${final.slice(-600)}`);
			}
			const intent =
				result.code === 0 && !result.idle
					? await routeWriterContinuation({ key, session, final }, this.routing())
					: {
							choice: "continue" as const,
							decided_by: "code" as const,
							confidence: null,
							reason: "the seat did not end its turn cleanly",
							wall_clock_ms: 0,
						};
			this.journalIntent(session, round, intent);
			if (intent.choice === "split") split = final.match(/^SPLIT:\s*(.+)$/m)?.[1]?.trim() || tail(final, 20);
			silent = result.bytes === 0 && result.code !== 0 ? silent + 1 : 0;
			if (silent >= MAX_SILENT_ROUNDS)
				throw new TicketFailure(`the writer seat produced no output in ${silent} consecutive rounds`);
			if (result.code !== 0) await sleep(this.options.retryDelayMs ?? 30_000);
		}
	}
	/** The owner's note for the next writer round of this ticket, `resume-note.md` in the ticket directory. */
	private resumeNote(): string | undefined {
		const path = join(this.directory, "resume-note.md");
		return (existsSync(path) && readFileSync(path, "utf8").trim()) || undefined;
	}
	/** A delivered note is kept, renamed, so it reaches the writer once; a note rewritten meanwhile stays pending. */
	private noteDelivered(note: string): void {
		const path = join(this.directory, "resume-note.md");
		if (this.resumeNote() !== note) return;
		renameSync(
			path,
			join(this.directory, `resume-note.${new Date().toISOString().replace(/[:.]/g, "-")}.delivered.md`),
		);
		this.log("resume-note", "delivered to the writer");
	}
	private journalIntent(session: string, round: number, answer: RoutingAnswer<string>): void {
		appendFileSync(
			join(this.directory, "routing.jsonl"),
			`${JSON.stringify({ stage: "writer_completion", session, round, ...answer })}\n`,
		);
		this.log(`writer:${session}:intent`, `${answer.choice} by ${answer.decided_by}: ${answer.reason}`);
	}
	private continueLine(): string {
		return `Continue the same ticket. ${this.completionRule()} ${INITIATIVE_LINES}`;
	}
	private async write(): Promise<void> {
		if (this.state.writer) return;
		const { final, split: routed } = await this.writerRounds("write", this.writerPrompt(), this.continueLine());
		await this.commitLeftovers(`${this.ticket.key}: writer leftovers`);
		const split = final.match(/^SPLIT:\s*(.+)$/m)?.[1]?.trim() || routed;
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
				idleMs: this.settings.idleMs,
				env: {
					...this.cargoEnvironment(),
					CARGO_TARGET_DIR: target,
					CARGO_BUILD_JOBS: String(this.settings.cargoJobs),
					RUST_TEST_THREADS: String(this.settings.cargoJobs),
				},
				logName: "cargo-test.log",
				onIdle: (idleMs) => this.noteIdle("cargo-test", idleMs),
			});
			let ran = 0;
			for (const match of result.output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm))
				ran += Number(match[1]) + Number(match[2]);
			return { code: result.code === 0 && ran === 0 ? 1 : result.code, ran, crates, output: result.output };
		} finally {
			release();
		}
	}
	/**
	 * A cargo run that went silent proves nothing about the source: it is an infrastructure failure, never a test
	 * verdict and never a reason for a fix round. The retained log stays the evidence.
	 */
	private idleCargo(result: { code: number; ran: number; output: string }, when: string): void {
		if (result.code === SEAT_IDLE_EXIT_CODE)
			throw new TicketFailure(
				`infrastructure: the cargo run ${when} went idle (rc=${result.code}, ran=${result.ran}); no source verdict and no passing gate. Check the build host and slot custody before a retry; logs/cargo-test.log is the evidence. ${tail(result.output, 12)}`,
			);
	}
	private async tests(label: string): Promise<void> {
		let result = await this.cargoTest();
		this.log(label, `rc=${result.code} ran=${result.ran} crates=${result.crates.join(",")}`);
		this.idleCargo(result, `for ${label}`);
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
			this.idleCargo(result, `after the ${label} fix round, whose source failure stays unresolved`);
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
	/** The reviewers a tier names; tier one names none. */
	private tierSeats(tier: ReviewTier): ReviewSeat[] {
		return tier === "grok" ? ["grok"] : tier === "grok_plus_opus" ? ["grok", "opus"] : [];
	}
	private async reviewers(names: ReviewSeat[], diff: string, logSuffix: string): Promise<Record<string, string>> {
		const prompt = this.reviewPrompt(diff);
		const verdicts: Record<string, string> = {};
		await Promise.all(
			names.map(async (name) => {
				verdicts[name] = await this.reviewer(name, prompt, `review-${name}${logSuffix}`);
				this.log(`review:${name}`, verdicts[name]!.split("\n")[0]!);
			}),
		);
		return verdicts;
	}
	/**
	 * One reviewer in its own session, continued until it returns one standalone verdict line; a reply without one
	 * is never read as a pass. A seat that could not start is recorded unavailable. A seat that started, ran tools
	 * or answered and then failed leaves the review incomplete and its session preserved for a same-session resume.
	 * `sessions/<session>.resume` may point at the review's original session file to continue it in place.
	 */
	private async reviewer(name: ReviewSeat, prompt: string, session: string): Promise<string> {
		const sessionDir = join(this.directory, "sessions", session);
		const logName = `${session}.jsonl`;
		const spec = this.settings.seats[name] ?? DEFAULT_SEATS[name];
		const resumeFile = join(this.directory, "sessions", `${session}.resume`);
		const resumeSession = existsSync(resumeFile) ? readFileSync(resumeFile, "utf8").trim() : undefined;
		if (resumeSession !== undefined) {
			if (!isAbsolute(resumeSession) || !existsSync(resumeSession) || "command" in spec)
				throw new TicketFailure(`review ${name} invalid native resume pointer: ${resumeFile}`);
			const header = JSON.parse(readFileSync(resumeSession, "utf8").split("\n")[0] ?? "{}") as SessionEntry;
			if (header.type !== "session" || !header.id || header.cwd !== this.worktree)
				throw new TicketFailure(`review ${name} resume pointer is not the original worktree session`);
		}
		const completed = await this.completedReview(
			name,
			session,
			sessionDir,
			join(this.directory, "logs", logName),
			resumeSession,
		);
		if (completed !== undefined) return completed;
		let continuing = resumeSession !== undefined || hasSessionFile(sessionDir);
		let pending = continuing;
		const continuePrompt = `Continue this SAME review for ${this.ticket.key}. Do not start a new review or duplicate delegated reviewers. Recover existing child handles, collect their results and inspect completed child sessions if a reply is missing. Wait for outstanding delegated work before deciding. Never edit files. Return exactly one line \`VERDICT: LANDABLE\` or \`VERDICT: DEFECTS\`, followed by concrete defects with file:line. A progress report is not a verdict.`;
		const kept = resumeSession ?? sessionDir;
		for (;;) {
			const result = await this.seat(name, continuing ? continuePrompt : prompt, {
				session: resumeSession ? undefined : session,
				resumeSession,
				continueSession: continuing,
				logName,
			});
			// The provider returns this refusal as ordinary terminal text, not refusal metadata.
			if (/^(?:\*\*)?I must decline this request\.(?:\*\*)?(?:\r?\n|$)/.test(result.final.trim()))
				throw new TicketFailure(
					`review ${name} explicitly refused the request; review incomplete. Preserve session ${kept} and its findings; no unavailable or passing verdict and no automatic continuation.`,
				);
			if (/^\[error:[ \t]*user_prompt_too_long\][ \t]*$/m.test(result.final))
				throw new TicketFailure(
					`review ${name} context overflow: provider user_prompt_too_long; preserve session ${kept} and its findings; compact or recover that session before a retry; no verdict accepted`,
				);
			if (result.code !== 0) {
				if (pending || result.final.trim() || result.activity)
					throw new TicketFailure(
						`review ${name} incomplete rc=${result.code}; preserve and resume session ${kept}; no verdict accepted`,
					);
				return `unavailable rc=${result.code}`;
			}
			const verdict = reviewVerdict(result.final);
			if (verdict) return verdict === "LANDABLE" ? "LANDABLE" : `DEFECTS\n${result.final}`;
			pending = true;
			this.log(`review:${name}`, `incomplete rc=0; continuing same session ${session}`);
			if ("command" in spec || (resumeSession === undefined && !hasSessionFile(sessionDir)))
				throw new TicketFailure(
					`review ${name} incomplete; no resumable native session; preserve logs and recover before retrying`,
				);
			continuing = true;
		}
	}
	/**
	 * Owner recovery: `sessions/<session>.completed.json` (`head`, `sessionPath`, `messageId`, optional
	 * `missingSeatReceiptReason`) names a terminal review message already saved in the review's own session. It is
	 * reconsumed only when it binds this worktree, the current clean head, one successful terminal assistant message
	 * with one standalone verdict, no newer terminal message, and the seat stream and run.log line that produced it.
	 */
	private async completedReview(
		name: ReviewSeat,
		session: string,
		sessionDir: string,
		logPath: string,
		resumeSession: string | undefined,
	): Promise<string | undefined> {
		const receiptPath = join(this.directory, "sessions", `${session}.completed.json`);
		if (!existsSync(receiptPath)) return undefined;
		const invalid = (reason: string) => new TicketFailure(`review ${name} invalid completed receipt: ${reason}`);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
			head?: string;
			sessionPath?: string;
			messageId?: string;
			missingSeatReceiptReason?: string;
		};
		const { head, sessionPath, messageId } = receipt;
		if (!head || !sessionPath || !messageId || !isAbsolute(sessionPath) || !existsSync(sessionPath))
			throw invalid("missing canonical session, head or message ID");
		if (resumeSession ? sessionPath !== resumeSession : !sessionPath.startsWith(`${sessionDir}/`))
			throw invalid("session is not this review's original root");
		if (head !== (await this.head()) || (await this.git(["status", "--porcelain"])).trim())
			throw invalid("reviewed HEAD changed or worktree is dirty");
		const entries = sessionEntries(sessionPath);
		const header = entries[0];
		if (
			header?.type !== "session" ||
			header.cwd !== this.worktree ||
			header.git?.commit !== head ||
			header.rlmDepth !== 0
		)
			throw invalid("canonical root header does not bind this worktree and HEAD");
		const matches = entries.filter((entry) => entry.id === messageId);
		if (matches.length !== 1) throw invalid("message ID missing or ambiguous");
		const entry = matches[0]!;
		const message = entry.message;
		if (
			entry.type !== "message" ||
			message?.role !== "assistant" ||
			message.stopReason !== "stop" ||
			!Array.isArray(message.content) ||
			message.content.some((block) => block?.type === "toolCall")
		)
			throw invalid("not a successful terminal assistant message");
		const index = entries.indexOf(entry);
		if (
			entries
				.slice(index + 1)
				.some((later) => later.message?.role === "assistant" && later.message.stopReason === "stop")
		)
			throw invalid("a newer terminal assistant message supersedes the receipt");
		const final = contentText(message.content);
		const verdict = reviewVerdict(final);
		if (!verdict) throw invalid("missing or conflicting standalone verdict");
		if (
			/\b(?:reviewers?|delegated (?:work|reviews?)) (?:are |is )?(?:still )?(?:running|pending|outstanding)\b|\bI (?:will|must|need to) collect (?:their|the|child|reviewer)\b/i.test(
				final,
			)
		)
			throw invalid("terminal text contradicts completion of delegated review work");
		// The seat stream that carried this message must have reached agent_end.
		let matched = false;
		let seen = false;
		let ended = false;
		for (const line of existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : []) {
			let event: { type?: unknown; message?: unknown };
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "agent_start" || event.type === "message_start") matched = false;
			if (event.type === "message_end") {
				matched = isDeepStrictEqual(event.message, message);
				seen ||= matched;
			}
			if (event.type === "agent_end" && matched) ended = true;
		}
		if (seen && !ended) throw invalid("matching native message lacks terminal stream completion");
		if (
			!seen &&
			!(
				receipt.missingSeatReceiptReason &&
				message.responseId &&
				message.provider &&
				message.model &&
				message.usage &&
				!message.errorMessage
			)
		)
			throw invalid(
				"no matching seat stream; an explicit missing-receipt reason and native response provenance are required",
			);
		const nextUser = entries.slice(index + 1).find((later) => later.message?.role === "user");
		const after = Date.parse(entry.timestamp ?? "");
		const before = nextUser ? Date.parse(nextUser.timestamp ?? "") : Number.POSITIVE_INFINITY;
		const successful = readFileSync(this.logPath, "utf8")
			.split("\n")
			.some((line) => {
				const at = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? "");
				return (
					at >= after &&
					at <= before &&
					(line.includes(`review:${name} incomplete rc=0;`) || line.endsWith(`review:${name} ${verdict}`))
				);
			});
		if (seen && !successful) throw invalid("no successful seat receipt for this terminal message");
		appendFileSync(
			join(this.directory, "review-reconsumption.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), name, ...receipt, verdict, source: "canonical-native-terminal-message", responseId: message.responseId, seatReceipt: seen ? "native-agent-end-and-rc0" : "missing-after-controller-stop" })}\n`,
		);
		this.log(`review:${name}`, `${verdict} (reconsumed original terminal message ${messageId} at ${head})`);
		return verdict === "LANDABLE" ? "LANDABLE" : `DEFECTS\n${final}`;
	}
	private async review(): Promise<void> {
		if (this.state.review) return;
		const routing = this.routing();
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
		const verdicts = await this.reviewers(this.tierSeats(tier.choice), before.diff, "");
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
				const again = await this.reviewers(this.tierSeats(tier.choice), (await this.diffAgainstBase()).diff, "-2");
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
		const { final } = await this.writerRounds(
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
			const pending = this.blockers().filter((key) => !this.stateOf(key)?.merged);
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
					// Never a raw force push. A branch that is merely behind is updated natively; a conflict gets one
					// writer round that merges the trunk into the branch, then a plain push.
					const update = await this.gh(["pr", "update-branch", String(this.state.pr), "--repo", repo]);
					if (update.code === 0) {
						this.log("merge", "branch was behind; updated natively");
						await this.git(["fetch", "-q", this.settings.remote]);
						await this.git(["merge", "--ff-only", `${this.settings.remote}/${this.branch}`]);
					} else {
						this.log("merge", `squash failed; one merge fix round: ${tail(merge.output, 5)}`);
						await this.git(["fetch", "-q", this.settings.remote]);
						await this.fixRound(
							"fix-merge",
							`The pull request does not merge because this branch conflicts with ${this.settings.remote}/${this.settings.trunk}. Run \`git merge ${this.settings.remote}/${this.settings.trunk}\` in this worktree, resolve every conflict, keep every commit's intent, commit the merge, and do not push.`,
							`${merge.output}\n${update.output}`,
						);
						await this.tests("tests-after-merge-fix");
						const push = await this.run(["git", "push", this.settings.remote, this.branch], {
							timeoutMs: this.t.ghMs,
							logName: "git-push.log",
						});
						if (push.code !== 0)
							throw new TicketFailure(`push after the merge fix failed: ${tail(push.output, 10)}`);
					}
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
