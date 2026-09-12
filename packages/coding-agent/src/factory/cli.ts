import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CommandAdapter, fingerprintCommand } from "./adapters/command.js";
import { type FactoryConfig, readFactoryConfig, readFactoryHosts, readFactoryJson } from "./config.js";
import { FactoryEngine } from "./engine.js";
import { FACTORY_HELP } from "./help.js";
import type { ManagementReconciliation } from "./management.js";
import { FactoryStore } from "./store.js";
import type { DecisionEvidence, FactoryPlan } from "./types.js";

function parseArguments(args: readonly string[]): { positionals: string[]; options: Map<string, string> } {
	const positionals: string[] = [];
	const options = new Map<string, string>();
	const allowed = new Set([
		"--hosts",
		"--pause-file",
		"--after",
		"--interval-ms",
		"--actor",
		"--reason",
		"--ref",
		"--expected-revision",
		"--expected-attempt",
		"--expected-wake",
		"--mutation-id",
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
	if (command === "fingerprint") {
		const hostsPath = options.get("--hosts");
		if (!hostsPath || !rawDirectory || !argument)
			throw new Error("fingerprint requires host, absolute cwd and --hosts");
		const host = readFactoryHosts(hostsPath)[rawDirectory];
		if (!host) throw new Error(`Unknown host ${rawDirectory}`);
		emit({ sourceFingerprint: await fingerprintCommand(host, argument) });
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
			engine.applyPlan(plan);
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
					managementRequests: store.managementRequests(),
					managementMutationBlockers: store.managementMutationBlockers().map((request) => request.id),
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
				engine.resume();
				emit(engine.status());
				break;
			case "decide":
				if (!argument || (choice !== "accept" && choice !== "reject"))
					throw new Error("decide requires action-id and accept|reject");
				engine.decide(
					argument,
					choice,
					evidence(options),
					options.has("--expected-revision") ? expectedRevision(options) : undefined,
					options.get("--expected-attempt"),
					options.has("--expected-wake") ? integer(options.get("--expected-wake"), 0, 1) : undefined,
				);
				emit(engine.status());
				break;
			case "supersede":
				if (!argument || !choice) throw new Error("supersede requires rejected and replacement action IDs");
				engine.supersede(argument, choice, evidence(options), expectedRevision(options));
				emit(engine.status());
				break;
			case "reconcile-management": {
				if (!argument)
					throw new Error("reconcile-management requires request-id and request-bound recovery evidence");
				const proof = evidence(options);
				if (!isAbsolute(proof.ref)) throw new Error("Management recovery --ref must be an absolute bundle path");
				const bundle = statSync(proof.ref);
				if (!bundle.isFile() || bundle.size > 1000000)
					throw new Error("Management recovery bundle must be a regular file of at most 1000000 bytes");
				const reconciliation = readFactoryJson(proof.ref) as ManagementReconciliation;
				engine.reconcileManagement(argument, reconciliation, proof, expectedRevision(options));
				emit({ ...engine.status(), managementRequests: store.managementRequests() });
				break;
			}
			case "resolve":
				if (!argument) throw new Error("resolve requires attempt-id and evidence proving safe retry");
				engine.resolveForRetry(argument, evidence(options));
				emit(engine.status());
				break;
			case "serve":
			case "run":
				await serve(engine, integer(options.get("--interval-ms"), 1000, 50));
				break;
			default:
				throw new Error(`Unknown factory command ${command}`);
		}
	} finally {
		store.close();
	}
}

async function serve(engine: FactoryEngine, intervalMs: number): Promise<void> {
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
			emit(await engine.tick());
			if (stopped) break;
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
