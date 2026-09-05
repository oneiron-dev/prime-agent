import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPrimeManagementCaller } from "./adapters/prime-management.js";
import { readFactoryConfig } from "./config.js";
import { FactoryEngine } from "./engine.js";
import { FACTORY_MANAGE_HELP } from "./help.js";
import type { ManagementEvidence } from "./management.js";
import { manageFactoryWake, watchFactoryManagement } from "./management-dispatch.js";
import { watchFactoryParent } from "./parent.js";
import { FactoryStore } from "./store.js";
import type { FactoryAdapter } from "./types.js";

const noDispatch: FactoryAdapter = {
	async launch() {
		throw new Error("Management cannot launch work");
	},
	async inspect() {
		throw new Error("Management cannot inspect or resolve process custody");
	},
};

async function main(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(FACTORY_MANAGE_HELP);
		return;
	}
	const positional: string[] = [];
	const evidence: ManagementEvidence[] = [];
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--apply" || arg === "--watch") {
			if (flags.has(arg)) throw new Error(`Repeated option: ${arg}`);
			flags.add(arg);
			continue;
		}
		if (
			["--role", "--evidence", "--evidence-directory", "--max-requests", "--max-passes", "--interval-ms"].includes(
				arg,
			)
		) {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			if (arg === "--evidence") {
				const path = resolve(value);
				const info = statSync(path);
				if (!info.isFile() || info.size > 64000)
					throw new Error("Evidence must be a regular file of at most 64000 bytes");
				evidence.push({ ref: path, content: readFileSync(path, "utf8") });
			} else {
				if (values.has(arg)) throw new Error(`Repeated option: ${arg}`);
				values.set(arg, value);
			}
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		positional.push(arg);
	}
	const watch = flags.has("--watch");
	if (positional.length < 1 || positional.length > (watch ? 1 : 2))
		throw new Error("Expected a factory directory and optional action id (one-wake mode only)");
	if (watch && evidence.length) throw new Error("--watch requires per-wake bindings, not --evidence");
	if (
		!watch &&
		["--evidence-directory", "--max-requests", "--max-passes", "--interval-ms"].some((option) => values.has(option))
	)
		throw new Error("Automatic management options require --watch");
	const directory = resolve(positional[0]);
	const config = readFactoryConfig(directory);
	const db = join(directory, "factory.db");
	if (!existsSync(db)) throw new Error("Factory is not initialized");
	const store = new FactoryStore(db);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		const engine = new FactoryEngine(store, noDispatch, { pauseFile: config.pauseFile });
		const options = {
			directory,
			role: values.get("--role") ?? "ticketOwner",
			apply: flags.has("--apply"),
			stopped: () => controller.signal.aborted,
		};
		if (watch) {
			const summary = await watchFactoryManagement(
				engine,
				{
					...options,
					evidenceDirectory: values.has("--evidence-directory")
						? resolve(values.get("--evidence-directory")!)
						: undefined,
					maxRequests: Number(values.get("--max-requests") ?? 10),
					maxPasses: Number(values.get("--max-passes") ?? 60),
					intervalMs: Number(values.get("--interval-ms") ?? 1000),
					signal: controller.signal,
				},
				createPrimeManagementCaller,
				(result) => console.log(JSON.stringify(result)),
			);
			console.log(JSON.stringify({ kind: "watch-finished", ...summary }));
		} else {
			const result = await manageFactoryWake(
				engine,
				{ ...options, actionId: positional[1], evidence },
				createPrimeManagementCaller,
			);
			console.log(JSON.stringify(result, null, 2));
			if (result.kind === "error") process.exitCode = 1;
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		store.close();
	}
}

const releaseParent = watchFactoryParent();
main(process.argv.slice(2))
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	.finally(releaseParent);
