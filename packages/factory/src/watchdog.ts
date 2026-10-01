import { execFile } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statfsSync,
	watch,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AGENT_BINARY_ENV, agentSelection } from "./agent-command.js";
import { type FactoryConfig, readFactoryConfig } from "./config.js";
import { invokedDirectly, locateFactoryEntrypoint } from "./runtime.js";
import { serveRunning } from "./serve-record.js";
import type { FactoryStatus } from "./types.js";

/**
 * Exception-only watchdog for one factory and one owner session. It makes no model call and sends no periodic
 * prompt: it reads `factory status` and the durable event cursor, and messages the session only for a new
 * actionable exception (a rejected or uncertain attempt, a runner identity missing twice without a terminal
 * receipt, a narrow structured provider failure, the serve process disappearing, local free space crossing below
 * the floor). Known exceptions at the first pass are baselined silently. Delivery is at least once: the outbox is
 * written before `prime-agent send` and an item leaves it only after the daemon accepted it. An engine-owned event
 * outbox replaces this later. Two routes: the factory's own CLI (Node and this package's entry) for `status` and
 * `events`, and the agent binary the seats run for `send`.
 */
export interface WatchdogSnapshot {
	status: Pick<FactoryStatus, "actions" | "attempts" | "tickets">;
	sequence: number;
	/** Running or submitted attempts whose runner identity is gone without a terminal receipt. */
	lost: string[];
	/** Ticket id to a structured provider failure class. */
	failures: Record<string, string>;
	/** Whether the factory's recorded `serve` runs (see `serve-record`); undefined when it cannot be observed. */
	serve: boolean | undefined;
	freeGiB: number;
	at: string;
}
export interface WatchdogAlert {
	key: string;
	message: string;
	at: string;
	attempts?: number;
	nextAttemptAt?: number;
	deliveryPaused?: boolean;
}
export interface WatchdogState {
	version: 1;
	session: string;
	factory: string;
	sequence: number;
	initialized?: boolean;
	checkedAt?: string;
	seen?: Record<string, true>;
	outbox?: WatchdogAlert[];
	suspects?: Record<string, number>;
	failures?: Record<string, string>;
	serve?: boolean;
	serveGeneration?: number;
	diskLow?: boolean;
	diskGeneration?: number;
}

/** Fold one snapshot into the state and return the new alerts; a baseline pass records without alerting. */
export function reduceSignals(
	state: WatchdogState,
	snapshot: WatchdogSnapshot,
	options: { baseline?: boolean; diskLowGiB: number },
): WatchdogAlert[] {
	state.seen ??= {};
	state.outbox ??= [];
	state.suspects ??= {};
	const { seen, outbox, suspects } = state;
	const alerts: WatchdogAlert[] = [];
	const signal = (key: string, message: string) => {
		if (seen[key]) return;
		seen[key] = true;
		if (options.baseline) return;
		const item = { key, message, at: snapshot.at };
		outbox.push(item);
		alerts.push(item);
	};
	const latest = new Map(snapshot.status.attempts.map((attempt) => [attempt.actionId, attempt]));
	for (const action of snapshot.status.actions) {
		const attempt = latest.get(action.id);
		// One key per exception class, so a lost runner or a provider failure never hides a later rejection.
		const key = `${action.id}:${attempt?.id ?? "none"}`;
		if (action.state === "REJECTED" || action.state === "UNCERTAIN" || attempt?.state === "UNCERTAIN")
			signal(
				`action:${key}`,
				`${action.id}: ${action.state === "UNCERTAIN" || attempt?.state === "UNCERTAIN" ? "UNCERTAIN" : "REJECTED"}; inspect tickets/${action.ticketId}/state.json and attempt ${attempt?.id ?? "unknown"}. No automatic retry performed.`,
			);
		if (attempt?.state === "RUNNING" || attempt?.state === "SUBMITTED") {
			suspects[attempt.id] = snapshot.lost.includes(attempt.id) ? (suspects[attempt.id] ?? 0) + 1 : 0;
			if (suspects[attempt.id]! >= 2)
				signal(
					`lost:${key}`,
					`${action.id}: the runner identity was missing twice with no terminal receipt (${attempt.id}); reconcile custody before any retry.`,
				);
			const failure = snapshot.failures[action.ticketId];
			if (failure && failure !== state.failures?.[action.ticketId])
				signal(
					`provider:${key}:${failure}`,
					`${action.id}: new structured provider failure (${failure}); inspect the retained ticket evidence. No provider bypass or retry performed.`,
				);
		}
	}
	state.failures = { ...snapshot.failures };
	if (snapshot.serve !== undefined) {
		if (state.serve === true && !snapshot.serve)
			signal(
				`serve-lost:${state.serveGeneration ?? 0}`,
				"factory serve disappeared. Running attempts were not stopped. Restore serve through the approved launch path.",
			);
		if (snapshot.serve && state.serve === false) state.serveGeneration = (state.serveGeneration ?? 0) + 1;
		state.serve = snapshot.serve;
	}
	const low = snapshot.freeGiB < options.diskLowGiB;
	if (state.diskLow === undefined) state.diskLow = low;
	else if (!state.diskLow && low) {
		state.diskLow = true;
		state.diskGeneration = (state.diskGeneration ?? 0) + 1;
		signal(
			`disk-low:${state.diskGeneration}`,
			`The work filesystem crossed below ${options.diskLowGiB} GiB free (${snapshot.freeGiB.toFixed(1)} GiB). It rearms above ${options.diskLowGiB + 10} GiB; no cleanup performed.`,
		);
	} else if (state.diskLow && snapshot.freeGiB > options.diskLowGiB + 10) state.diskLow = false;
	state.sequence = snapshot.sequence;
	state.checkedAt = snapshot.at;
	return alerts;
}

const execute = promisify(execFile);

/** A Linux runner identity `boot:pid:starttime` that still names a live process; undefined where it cannot be read. */
function identityCurrent(identity: string): boolean | undefined {
	let boot: string;
	try {
		boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return undefined;
	}
	const parts = identity.split(":");
	const pid = Number(parts.at(-2));
	if (parts[0] !== boot || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[0] !== "Z" && fields[19] === parts.at(-1);
	} catch {
		return false;
	}
}
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The agent binary that delivers a message: `--agent-bin`, else the factory's recorded `launcher.primeAgentBin`
 * when its launcher host is this machine, else `PRIME_AGENT_FACTORY_AGENT_BIN`, else `prime-agent` on PATH. An SSH
 * launcher's recorded path names a binary on that host, so such a factory needs `--agent-bin` or the environment:
 * an unrelated local `prime-agent` is never substituted for it.
 */
export function deliveryAgent(
	config: FactoryConfig,
	explicit: string[] | undefined,
	env: NodeJS.ProcessEnv,
): string[] {
	if (explicit) return explicit;
	const launcher = config.launcher;
	const host = launcher ? config.hosts[launcher.host] : undefined;
	if (launcher && host?.type === "ssh" && !env[AGENT_BINARY_ENV])
		throw new Error(
			`the factory's agent binary ${launcher.primeAgentBin ?? "(none recorded)"} is on SSH host ${launcher.host}; pass --agent-bin or set ${AGENT_BINARY_ENV} to the agent on this machine that delivers to the owner session`,
		);
	return [agentSelection(undefined, host?.type === "local" ? launcher?.primeAgentBin : undefined, env)];
}

export interface WatchdogOptions {
	factory: string;
	session: string;
	/** The agent binary that delivers a message (`send --json`); defaults to `deliveryAgent`. */
	agentArgv?: string[];
	/** How to run this package's CLI for `status` and `events`; defaults to this installation's entry. */
	factoryArgv?: string[];
	env?: NodeJS.ProcessEnv;
	stateDirectory?: string;
	diskLowGiB?: number;
}
/** One factory's watchdog: `pass` snapshots, folds and delivers at most one alert. */
export interface FactoryWatchdog {
	pass(): Promise<void>;
}

/**
 * Set up the watchdog of one factory and one owner session. Each pass reads the factory's config again, so a
 * relaunch that switched the agent binary or the launcher settings reaches a watchdog that is already running.
 * A delivery route that cannot work is refused here, before anything is watched.
 */
export function factoryWatchdog(options: WatchdogOptions): FactoryWatchdog {
	const factory = resolve(options.factory);
	const env = options.env ?? process.env;
	const entrypoint = locateFactoryEntrypoint();
	const factoryArgv = options.factoryArgv ?? [entrypoint.node, ...entrypoint.execArgv, entrypoint.entry];
	const entry = canonical(factoryArgv.at(-1)!);
	const route = () => {
		const config = readFactoryConfig(factory);
		const launcher = config.launcher;
		const host = launcher ? config.hosts[launcher.host] : undefined;
		return {
			work: launcher?.work,
			runnerRoot: host && host.type !== "ssh" ? host.runnerRoot : undefined,
			// The runner's own default floor: below it cargoTest waits, so that is when the owner hears of it.
			diskLowGiB: options.diskLowGiB ?? launcher?.diskFloorGiB ?? 100,
			agentArgv: deliveryAgent(config, options.agentArgv, env),
		};
	};
	route();
	const directory = options.stateDirectory ?? join(factory, "watchdog");
	const statePath = join(directory, "state.json");
	const receipts = join(directory, "deliveries.jsonl");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const state: WatchdogState = existsSync(statePath)
		? (JSON.parse(readFileSync(statePath, "utf8")) as WatchdogState)
		: { version: 1, session: options.session, factory, sequence: 0 };
	if (state.session !== options.session || state.factory !== factory)
		throw new Error(`watchdog state in ${statePath} belongs to another factory or session`);
	const save = () => {
		const temporary = `${statePath}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, statePath);
	};
	const run = async (argv: string[], args: string[]): Promise<unknown> => {
		const { stdout } = await execute(argv[0]!, [...argv.slice(1), ...args], {
			env,
			timeout: 30_000,
			maxBuffer: 32 * 1024 * 1024,
		});
		return JSON.parse(stdout);
	};
	const snapshot = async ({ work, runnerRoot }: ReturnType<typeof route>): Promise<WatchdogSnapshot> => {
		const status = (await run(factoryArgv, ["status", factory])) as FactoryStatus;
		let sequence = state.sequence;
		// The native event ledger is read by its durable sequence; ordinary stages never become messages.
		for (;;) {
			const events = (await run(factoryArgv, ["events", factory, "--after", String(sequence)])) as Array<{
				sequence: number;
			}>;
			if (!events.length) break;
			sequence = Math.max(sequence, ...events.map((event) => event.sequence));
			if (events.length < 100) break;
		}
		const lost: string[] = [];
		for (const attempt of status.attempts) {
			if ((attempt.state !== "RUNNING" && attempt.state !== "SUBMITTED") || !attempt.processIdentity || !runnerRoot)
				continue;
			const attemptDirectory = join(runnerRoot, attempt.id);
			if (existsSync(join(attemptDirectory, "terminal.json"))) continue;
			let alive = identityCurrent(attempt.processIdentity);
			const childPath = join(attemptDirectory, "child.json");
			if (alive && existsSync(childPath)) {
				const child = JSON.parse(readFileSync(childPath, "utf8")) as { processIdentity?: string };
				if (child.processIdentity) alive = identityCurrent(child.processIdentity);
			}
			if (alive === false) lost.push(attempt.id);
		}
		const failures: Record<string, string> = {};
		for (const ticket of status.tickets) {
			if (!work) break;
			try {
				const failure = (
					JSON.parse(readFileSync(join(work, "tickets", ticket.id, "state.json"), "utf8")) as { failure?: unknown }
				).failure;
				if (typeof failure !== "string") continue;
				if (/^review \S+ context overflow: provider user_prompt_too_long/.test(failure))
					failures[ticket.id] = "user_prompt_too_long";
				else if (/^review \S+ explicitly refused the request/.test(failure))
					failures[ticket.id] = "explicit-review-refusal";
			} catch {}
		}
		const disk = statfsSync(work ?? factory);
		return {
			status,
			sequence,
			lost,
			failures,
			serve: serveRunning(factory, entry),
			freeGiB: (Number(disk.bavail) * Number(disk.bsize)) / 1024 ** 3,
			at: new Date().toISOString(),
		};
	};
	// One bounded delivery attempt per pass. A failed delivery never advances or removes the outbox item.
	const deliver = async (agentArgv: string[]) => {
		const item = state.outbox?.[0];
		if (!item || item.deliveryPaused || (item.nextAttemptAt ?? 0) > Date.now()) return;
		const message = `[FACTORY_EXCEPTION ${item.key}] ${item.message} Factory ${factory}, event cursor ${state.sequence}.`;
		try {
			const receipt = (await run(agentArgv, ["send", "--json", options.session, "--message", message])) as {
				deliveryStatus?: string;
			};
			if (receipt.deliveryStatus !== "queued" && receipt.deliveryStatus !== "delivered")
				throw new Error("send did not acknowledge delivery");
			appendFileSync(receipts, `${JSON.stringify({ at: new Date().toISOString(), key: item.key, receipt })}\n`);
			state.outbox!.shift();
			save();
		} catch (error) {
			item.attempts = (item.attempts ?? 0) + 1;
			item.nextAttemptAt = Date.now() + Math.min(900_000, 30_000 * 2 ** (item.attempts - 1));
			// Sends carry no idempotency key: after eight failures the owner reconciles before anything is re-sent.
			if (item.attempts >= 8) item.deliveryPaused = true;
			save();
			if (!item.deliveryPaused) throw error;
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; delivery of ${item.key} is paused after ${item.attempts} failures and ${state.outbox!.length - 1} later alerts wait behind it: check the daemon and deliveries.jsonl, then clear the item's deliveryPaused, attempts and nextAttemptAt in state.json`,
			);
		}
	};
	return {
		async pass() {
			try {
				const current = route();
				const baseline = !state.initialized;
				reduceSignals(state, await snapshot(current), { baseline, diskLowGiB: current.diskLowGiB });
				state.initialized = true;
				save();
				await deliver(current.agentArgv);
			} catch (error) {
				appendFileSync(
					join(directory, "errors.log"),
					`${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}; the outbox is kept\n`,
				);
			}
		},
	};
}

/** Run the watchdog until SIGTERM or SIGINT: a pass now, on every factory database write and every 30 seconds. */
export async function runFactoryWatchdog(options: WatchdogOptions): Promise<void> {
	const watchdog = factoryWatchdog(options);
	const factory = resolve(options.factory);
	let running = false;
	let again = false;
	let debounce: NodeJS.Timeout | undefined;
	const tick = async (): Promise<void> => {
		if (running) {
			again = true;
			return;
		}
		running = true;
		try {
			await watchdog.pass();
		} finally {
			running = false;
			if (again) {
				again = false;
				schedule();
			}
		}
	};
	const schedule = () => {
		debounce ??= setTimeout(() => {
			debounce = undefined;
			void tick();
		}, 10_000);
	};
	const watcher = watch(factory, (_event, file) => {
		if (file === "factory.db-wal" || file === "factory.db") schedule();
	});
	const interval = setInterval(() => void tick(), 30_000);
	const stop = (code: number) => {
		watcher.close();
		clearInterval(interval);
		clearTimeout(debounce);
		process.exit(code);
	};
	watcher.on("error", () => stop(1));
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(0));
	await tick();
}

const USAGE = `Usage: node <package>/dist/watchdog.js --factory <absolute-dir> --session <owner-session-id> [--agent-bin <executable>] [--state-dir <absolute-dir>] [--disk-low-gib <n>]
Messages the session only for new factory exceptions; state lives in <factory>/watchdog unless --state-dir is set.
Messages go through the agent binary: --agent-bin, else the factory's launcher.primeAgentBin when its launcher host is local, else PRIME_AGENT_FACTORY_AGENT_BIN, else prime-agent on PATH. A factory whose launcher host is an SSH host needs --agent-bin or PRIME_AGENT_FACTORY_AGENT_BIN.`;

export async function runFactoryWatchdogCli(args: string[]): Promise<number> {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const [name, value] = [args[index]!, args[index + 1]];
		if (!["--factory", "--session", "--agent-bin", "--state-dir", "--disk-low-gib"].includes(name) || !value) {
			console.error(USAGE);
			return 2;
		}
		values.set(name, value);
	}
	const factory = values.get("--factory");
	const session = values.get("--session");
	const stateDirectory = values.get("--state-dir");
	const diskText = values.get("--disk-low-gib");
	// Number(" ") is 0, which would silence every disk alert.
	const diskLowGiB = diskText === undefined ? undefined : diskText.trim() ? Number(diskText) : Number.NaN;
	if (
		!factory ||
		!isAbsolute(factory) ||
		!session?.trim() ||
		(stateDirectory !== undefined && !isAbsolute(stateDirectory)) ||
		(diskLowGiB !== undefined && !(Number.isFinite(diskLowGiB) && diskLowGiB >= 0))
	) {
		console.error(USAGE);
		return 2;
	}
	const agent = values.get("--agent-bin");
	try {
		await runFactoryWatchdog({ factory, session, agentArgv: agent ? [agent] : undefined, stateDirectory, diskLowGiB });
	} catch (error) {
		console.error(`factory watchdog: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	return 0;
}

if (invokedDirectly(import.meta.url)) {
	process.exitCode = await runFactoryWatchdogCli(process.argv.slice(2));
}
