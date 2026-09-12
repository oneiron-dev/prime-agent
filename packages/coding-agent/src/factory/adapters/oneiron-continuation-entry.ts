import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFactoryConfig } from "../config.js";
import { FactoryEngine } from "../engine.js";
import { FACTORY_EVIDENCE_LIMITS } from "../evidence.js";
import { readFactoryRuntime } from "../runtime.js";
import { FactoryStore } from "../store.js";
import type { FactoryAdapter } from "../types.js";
import { CommandAdapter } from "./command.js";
import { readOneironPin } from "./oneiron.js";
import {
	type ContinuationResult,
	OneironContinuation,
	type OneironContinuationConfig,
	type OneironSuccessorPacket,
	oneironContinuationUnit,
	readOneironContinuationStatus,
	submitOneironSuccessor,
	validateOneironSuccessor,
} from "./oneiron-continuation.js";
import { createPrimeManagementCaller } from "./prime-management.js";

const HELP = `Oneiron durable coordinator continuation (separate from factory serve)
  oneiron-continuation-entry help
  oneiron-continuation-entry validate PACKET_JSON PACKET_SHA256 CANDIDATE_JSON CANDIDATE_SHA256
  oneiron-continuation-entry submit PACKET_JSON PACKET_SHA256 CANDIDATE_JSON CANDIDATE_SHA256
  oneiron-continuation-entry status CONFIG_JSON CONFIG_SHA256
  oneiron-continuation-entry unit CONFIG_JSON CONFIG_SHA256
  oneiron-continuation-entry reconcile CONFIG_JSON CONFIG_SHA256 REQUEST_ID PROOF_JSON PROOF_SHA256 --execute
  oneiron-continuation-entry step CONFIG_JSON CONFIG_SHA256 --execute
  oneiron-continuation-entry watch CONFIG_JSON CONFIG_SHA256 --execute [--max-passes N] [--interval-ms N]

validate checks candidate shape, pins and shared limits without writing; submit repeats validation before atomic immutable response publication. Neither opens the factory DB or dispatches work. Limits: ${JSON.stringify(FACTORY_EVIDENCE_LIMITS)} (bytes are UTF-8).
status/unit are read-only; unit prints a user systemd unit, never installs/starts it.
step/watch preserve both pauses and never schedule product command actions.
watch defaults: 60 passes, 1000 ms; exits 75 for deterministic rearm, 0 at closure handoff.
Configuration failures exit 78. Dispatched uncertain commands are inspected, never replayed.
Read factory-continuation.md for authority, pin, response and supervised activation contracts.`;
const noDispatch: FactoryAdapter = {
	async launch() {
		throw new Error("Continuation cannot schedule product actions");
	},
	async inspect() {
		throw new Error("Continuation cannot reconcile product process custody");
	},
};
async function main(args: string[]): Promise<void> {
	if (!args.length || args[0] === "help" || args[0] === "--help") {
		console.log(HELP);
		return;
	}
	if (args[0] === "validate" || args[0] === "submit") {
		if (args.length !== 5) throw new Error(HELP);
		const packetPin = { path: resolve(args[1]), sha256: args[2] };
		const candidatePin = { path: resolve(args[3]), sha256: args[4] };
		if (args[0] === "submit")
			console.log(JSON.stringify({ kind: "submitted", response: submitOneironSuccessor(packetPin, candidatePin) }));
		else {
			const packet = JSON.parse(readOneironPin(packetPin)) as OneironSuccessorPacket;
			validateOneironSuccessor(
				JSON.parse(readOneironPin(candidatePin, FACTORY_EVIDENCE_LIMITS.responseBytes, "response")),
				packet,
			);
			console.log(
				JSON.stringify({
					kind: "valid",
					limits: FACTORY_EVIDENCE_LIMITS,
					authority: "preflight only; consume remains authoritative",
				}),
			);
		}
		return;
	}
	const [command, configPath, hash, ...rest] = args;
	if (!["status", "unit", "step", "watch", "reconcile"].includes(command) || !configPath || !hash)
		throw new Error(HELP);
	const config = JSON.parse(readOneironPin({ path: resolve(configPath), sha256: hash })) as OneironContinuationConfig;
	if (config.supervisor.configPath !== resolve(configPath))
		throw new Error("Supervisor must pin this exact config path");
	if (command === "status" || command === "unit") {
		if (rest.length) throw new Error("Read-only command takes no execution flags");
		if (command === "unit") console.log(oneironContinuationUnit(config));
		else {
			if (!existsSync(join(config.factoryDirectory, "factory.db"))) throw new Error("Factory is not initialized");
			const store = new FactoryStore(join(config.factoryDirectory, "factory.db"));
			try {
				const status = new FactoryEngine(store, noDispatch, { pauseFile: config.ownerPauseFile }).status();
				const runtime = readFactoryRuntime(config.coordinator.runtime, readOneironPin);
				console.log(
					JSON.stringify(
						{
							core: {
								...status,
								managementRequests: store.managementRequests(),
								managementMutationBlockers: store.managementMutationBlockers(),
							},
							continuation: readOneironContinuationStatus(join(config.factoryDirectory, "factory.db")),
							runtime: {
								pin: config.coordinator.runtime,
								cliArgv: runtime.cliArgv,
								capabilities: runtime.capabilities,
								verifiedFiles: runtime.files.length,
							},
							scope: "Composite controller custody: core attempts alone are not a coordinator process census",
						},
						null,
						2,
					),
				);
			} finally {
				store.close();
			}
		}
		return;
	}
	const recoveryArgs = command === "reconcile" ? rest.splice(0, 3) : [];
	if (command === "reconcile" && recoveryArgs.length !== 3)
		throw new Error("Reconcile requires request id and pinned proof");
	let execute = false;
	let maxPasses = command === "watch" ? 60 : 1;
	let intervalMs = 1000;
	const seen = new Set<string>();
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (seen.has(arg)) throw new Error(`Repeated option ${arg}`);
		seen.add(arg);
		if (arg === "--execute") execute = true;
		else if (command === "watch" && arg === "--max-passes") maxPasses = Number(rest[++index]);
		else if (command === "watch" && arg === "--interval-ms") intervalMs = Number(rest[++index]);
		else throw new Error(`Unknown option ${arg}`);
	}
	if (
		!execute ||
		!Number.isSafeInteger(maxPasses) ||
		maxPasses < 1 ||
		maxPasses > 10000 ||
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 50 ||
		intervalMs > 60000
	)
		throw new Error("Explicit execution and finite 1–10000 passes/50–60000 ms bounds required");
	const factory = readFactoryConfig(config.factoryDirectory);
	if (factory.pauseFile !== config.ownerPauseFile)
		throw new Error("Continuation must preserve the configured external owner fence");
	const host = factory.hosts[config.coordinator.host];
	if (host?.type !== "local" || host.runnerRoot !== config.coordinator.runnerRoot)
		throw new Error("Coordinator requires the existing local controller host/runnerRoot");
	const db = join(config.factoryDirectory, "factory.db");
	if (!existsSync(db)) throw new Error("Factory is not initialized");
	const store = new FactoryStore(db);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	const continuation = new OneironContinuation(
		new FactoryEngine(store, noDispatch, { pauseFile: factory.pauseFile }),
		config,
		new CommandAdapter(factory.hosts, { pauseFile: factory.pauseFile }),
		createPrimeManagementCaller,
		undefined,
		() => controller.signal.aborted,
	);
	let passes = 0;
	let result: ContinuationResult = {
		kind: "paused",
		nextActor: config.supervisor.actor,
		output: config.factoryDirectory,
		reason: "Consumer stopped before first pass",
	};
	try {
		if (command === "reconcile") {
			continuation.reconcile(recoveryArgs[0], { path: resolve(recoveryArgs[1]), sha256: recoveryArgs[2] });
			console.log(JSON.stringify({ kind: "coordinator-reconciled", requestId: recoveryArgs[0] }));
			return;
		}
		while (passes < maxPasses && !controller.signal.aborted) {
			try {
				result = await continuation.step();
			} catch (error) {
				result = {
					kind: "blocked",
					nextActor: config.coordinator.actor,
					output: join(config.factoryDirectory, "continuation", config.id),
					reason: String(error),
				};
			}
			passes++;
			console.log(JSON.stringify(result));
			if (result.kind === "closure-handoff" || passes >= maxPasses || controller.signal.aborted) break;
			await new Promise<void>((resolveWait) => {
				const done = () => {
					clearTimeout(timer);
					controller.signal.removeEventListener("abort", done);
					resolveWait();
				};
				const timer = setTimeout(done, intervalMs);
				controller.signal.addEventListener("abort", done, { once: true });
				if (controller.signal.aborted) done();
			});
		}
		const receipt = continuation.supervise(result, passes);
		console.log(JSON.stringify({ kind: "continuation-session-finished", ...receipt }));
		if (command === "watch") process.exitCode = receipt.exitCode;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		continuation.close();
		store.close();
	}
}
main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(String(error));
	process.exitCode = 78;
});
