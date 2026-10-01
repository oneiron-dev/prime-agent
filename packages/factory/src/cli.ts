import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CommandAdapter, fingerprintCommand } from "./adapters/command.js";
import { DEFAULT_SEATS } from "./adapters/oneiron-settings.js";
import { type AgentExecutable, agentSelection, resolveAgentExecutable } from "./agent-command.js";
import { type FactoryConfig, readFactoryConfig, readFactoryHosts, readFactoryJson } from "./config.js";
import { FactoryEngine } from "./engine.js";
import { FACTORY_HELP } from "./help.js";
import { importSplits, launchTickets, readLauncherSettings, readLauncherTickets } from "./launcher.js";
import { resumeFactory } from "./resume.js";
import { recordFactoryRuntime } from "./runtime.js";
import { FactoryStore } from "./store.js";
import type { DecisionEvidence, FactoryPlan } from "./types.js";

function parseArguments(args: readonly string[]): { positionals: string[]; options: Map<string, string> } {
	const positionals: string[] = [];
	const options = new Map<string, string>();
	const allowed = new Set([
		"--hosts",
		"--launcher",
		"--pause-file",
		"--after",
		"--interval-ms",
		"--timeout-ms",
		"--actor",
		"--reason",
		"--ref",
		"--expected-revision",
		"--mutation-id",
		"--select",
		"--supersede",
		"--prime-agent-bin",
	]);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		if (!allowed.has(arg)) throw new Error(`Unknown factory option ${arg}`);
		const value = args[++index];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
		if (options.has(arg)) throw new Error(`Repeated option ${arg}`);
		options.set(arg, value);
	}
	return { positionals, options };
}

function integer(value: string | undefined, fallback: number, minimum: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`Expected an integer >= ${minimum}`);
	return parsed;
}

function expectedRevision(options: Map<string, string>): number {
	if (!options.has("--expected-revision")) throw new Error("An explicit --expected-revision is required");
	return integer(options.get("--expected-revision"), 0, 0);
}

function evidence(options: Map<string, string>): DecisionEvidence {
	const actor = options.get("--actor");
	const reason = options.get("--reason");
	const ref = options.get("--ref");
	if (!actor || !reason || !ref) throw new Error("An actor, reason and evidence ref are required");
	return { actor, reason, ref };
}

function emit(value: unknown): void {
	console.log(JSON.stringify(value));
}

export async function runFactoryCli(args: readonly string[]): Promise<void> {
	if (!args.length || ["help", "--help", "-h"].includes(args[0]!)) {
		console.log(FACTORY_HELP);
		return;
	}
	const { positionals, options } = parseArguments(args);
	const [command, rawDirectory, argument, choice] = positionals;
	if ((options.has("--select") || options.has("--supersede")) && command !== "recover-admit")
		throw new Error("--select and --supersede are only supported for recover-admit");
	if (options.has("--timeout-ms") && command !== "fingerprint") {
		throw new Error("--timeout-ms is only supported for fingerprint");
	}
	if (options.has("--prime-agent-bin") && command !== "launch")
		throw new Error("--prime-agent-bin is only supported for launch");
	if (command === "fingerprint") {
		const hostsPath = options.get("--hosts");
		if (!hostsPath || !rawDirectory || !argument)
			throw new Error("fingerprint requires host, absolute cwd and --hosts");
		const host = readFactoryHosts(hostsPath)[rawDirectory];
		if (!host) throw new Error(`Unknown host ${rawDirectory}`);
		const timeout = options.get("--timeout-ms");
		emit({
			sourceFingerprint: await fingerprintCommand(
				host,
				argument,
				timeout === undefined ? undefined : Number(timeout),
			),
		});
		return;
	}
	if (!rawDirectory) throw new Error("An explicit factory directory is required");
	const directory = resolve(rawDirectory);
	if (command === "init") {
		if (!argument || !options.get("--hosts")) throw new Error("init requires plan.json and --hosts hosts.json");
		if (existsSync(directory)) throw new Error("init requires a new factory directory");
		const pauseFile = options.get("--pause-file");
		if (pauseFile && !isAbsolute(pauseFile)) throw new Error("--pause-file must be absolute");
		const config: FactoryConfig = {
			version: 1,
			hosts: readFactoryHosts(options.get("--hosts")!),
			...(pauseFile ? { pauseFile } : {}),
		};
		const plan = readFactoryJson(argument) as FactoryPlan;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		const store = new FactoryStore(join(directory, "factory.db"));
		try {
			const engine = new FactoryEngine(store, new CommandAdapter(config.hosts), { enabled: false, pauseFile });
			engine.applyPlan(plan, 0, undefined, recordFactoryRuntime(directory));
			engine.pause("Initialized; explicit factory resume required");
			emit(engine.status());
		} finally {
			store.close();
		}
		return;
	}
	const config = readFactoryConfig(directory);
	const database = join(directory, "factory.db");
	if (!existsSync(database)) throw new Error("Factory database does not exist");
	const store = new FactoryStore(database);
	try {
		const engine = new FactoryEngine(store, new CommandAdapter(config.hosts, { pauseFile: config.pauseFile }), {
			enabled: true,
			pauseFile: config.pauseFile,
		});
		switch (command) {
			case "launch": {
				const launcherPath = options.get("--launcher");
				if (!argument || !choice || !launcherPath)
					throw new Error("launch requires <w7-manifest.json> <mint-plan.json> --launcher <launcher.json>");
				const requested = readLauncherSettings(launcherPath);
				const host = config.hosts[requested.host];
				if (!host) throw new Error(`launcher.host ${requested.host} is not a configured host`);
				const { tickets, skipped } = readLauncherTickets(argument, choice);
				// Every stage runs the agent binary resolved here, on the runner host, before anything is imported.
				// The launcher setting is launcher.json's, else the one an earlier launch recorded, so a relaunch never
				// switches binaries through the environment. Only seats that are all commands may launch without one.
				const selection = agentSelection(
					options.get("--prime-agent-bin"),
					requested.primeAgentBin ?? config.launcher?.primeAgentBin,
					process.env,
				);
				let agent: AgentExecutable | undefined;
				try {
					agent = await resolveAgentExecutable(host, selection);
				} catch (error) {
					const seats = Object.values({ ...DEFAULT_SEATS, ...requested.seats });
					if (seats.some((seat) => seat && !("command" in seat))) throw error;
				}
				const settings = agent ? { ...requested, primeAgentBin: agent.binary } : requested;
				const result = launchTickets(store, settings, tickets);
				if (agent) store.pinAgent({ host: settings.host, ...agent }, "launch");
				// Replaced whole, never rewritten in place: a running serve and the watchdog re-read it.
				const configPath = join(directory, "config.json");
				writeFileSync(`${configPath}.tmp`, `${JSON.stringify({ ...config, launcher: settings }, null, 2)}\n`, {
					mode: 0o600,
				});
				renameSync(`${configPath}.tmp`, configPath);
				emit({ ...result, skipped, tickets: tickets.length, agentBinary: agent?.binary ?? null });
				break;
			}
			case "recover-admit": {
				const allowed = new Set([
					"--select",
					"--supersede",
					"--expected-revision",
					"--mutation-id",
					"--actor",
					"--reason",
					"--ref",
				]);
				const select = options.get("--select");
				const mutationId = options.get("--mutation-id");
				if (
					positionals.length !== 3 ||
					!argument ||
					!select ||
					!mutationId ||
					[...options.keys()].some((key) => !allowed.has(key))
				)
					throw new Error(
						"recover-admit requires plan.json --select ACTION --expected-revision N --mutation-id ID --actor ACTOR --reason REASON --ref EVIDENCE; optional --supersede REJECTED",
					);
				emit(
					await engine.recoverAdmit(readFactoryJson(argument) as FactoryPlan, {
						select,
						supersede: options.get("--supersede"),
						expectedRevision: expectedRevision(options),
						mutationId,
						evidence: evidence(options),
					}),
				);
				break;
			}
			case "import":
				if (!argument) throw new Error("import requires plan.json");
				engine.applyPlan(
					readFactoryJson(argument) as FactoryPlan,
					expectedRevision(options),
					options.get("--mutation-id"),
				);
				emit(engine.status());
				break;
			case "status":
				emit({
					...engine.status(),
					ownerPauseFile: config.pauseFile ?? null,
					ownerPaused: Boolean(config.pauseFile && existsSync(config.pauseFile)),
				});
				break;
			case "events":
				emit(store.events(integer(options.get("--after"), 0, 0)));
				break;
			case "tick":
				emit(await engine.tick());
				break;
			case "pause":
				engine.pause(positionals.slice(2).join(" ") || "Paused by operator");
				emit(engine.status());
				break;
			case "resume":
				if (positionals.length !== 2 || options.size) throw new Error("resume requires only <directory>");
				await resumeFactory(engine, directory, config.launcher && config.hosts[config.launcher.host]);
				break;
			case "supersede":
				if (!argument || !choice) throw new Error("supersede requires rejected and replacement action IDs");
				engine.supersede(argument, choice, evidence(options), expectedRevision(options));
				emit(engine.status());
				break;
			case "resolve": {
				// A mass restart resolves every vanished attempt at once, under one piece of evidence.
				const attempts = positionals.slice(2);
				if (!attempts.length)
					throw new Error("resolve requires one or more attempt ids and evidence proving safe retry");
				const shared = evidence(options);
				const resolved: string[] = [];
				for (const attempt of attempts) {
					engine.resolveForRetry(attempt, shared);
					resolved.push(attempt);
				}
				emit({ resolved, ...engine.status() });
				break;
			}
			case "serve":
			case "run":
				await serve(engine, integer(options.get("--interval-ms"), 1000, 50), () => {
					if (engine.status().paused) return;
					// The launcher as the last launch wrote it: a relaunch that changed the settings or the agent
					// binary reaches the follow-ups this running server imports.
					const { launcher } = readFactoryConfig(directory);
					if (!launcher) return;
					const imported = importSplits(store, launcher);
					if (imported.length) emit({ splitsImported: imported });
				});
				break;
			default:
				throw new Error(`Unknown factory command ${command}`);
		}
	} finally {
		store.close();
	}
}

function sqliteBusy(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		error.code === "ERR_SQLITE_ERROR" &&
		"errcode" in error &&
		error.errcode === 5
	);
}

export async function tickWithBusyRetry(
	engine: Pick<FactoryEngine, "tick">,
): Promise<Awaited<ReturnType<FactoryEngine["tick"]>> | undefined> {
	for (let retry = 0; retry <= 3; retry++) {
		try {
			return await engine.tick();
		} catch (error) {
			if (!sqliteBusy(error)) throw error;
			emit({ error: "SQLITE_BUSY", retriesRemaining: 3 - retry });
			if (retry === 3) return undefined;
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100 * 2 ** retry));
		}
	}
}

async function serve(engine: FactoryEngine, intervalMs: number, afterTick: () => void): Promise<void> {
	let stopped = false;
	let wake: (() => void) | undefined;
	const stop = () => {
		if (stopped) return;
		engine.pause("Scheduling service stopped by signal; resume explicitly to dispatch");
		stopped = true;
		wake?.();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		while (!stopped) {
			const result = await tickWithBusyRetry(engine);
			if (stopped) break;
			if (result) {
				emit(result);
				try {
					afterTick();
				} catch (error) {
					emit({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			await new Promise<void>((resolveWait) => {
				const timer = setTimeout(() => {
					wake = undefined;
					resolveWait();
				}, intervalMs);
				wake = () => {
					clearTimeout(timer);
					wake = undefined;
					resolveWait();
				};
			});
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
