import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createPrimeManagementCaller } from "./adapters/prime-management.js";
import { readFactoryConfig } from "./config.js";
import { FactoryEngine } from "./engine.js";
import {
	createManagementPacket,
	type ManagementEvidence,
	type ManagementResult,
	proposeManagementDecision,
} from "./management.js";
import { watchFactoryParent } from "./parent.js";
import { FactoryStore } from "./store.js";
import type { FactoryAdapter } from "./types.js";

function save(path: string, data: unknown): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

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
		console.log(
			"Usage: prime-agent factory manage <directory> [action-id] [--role ticketOwner] [--evidence file] [--apply]\nReviews one pending wake with its configured model. Proposes by default; --apply records a validated acceptance/rejection. Defer preserves the wake. Run separately from factory serve so model latency cannot delay refill.",
		);
		return;
	}
	const positional: string[] = [];
	const evidence: ManagementEvidence[] = [];
	let role = "ticketOwner";
	let apply = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		if (arg === "--role" || arg === "--evidence") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			if (arg === "--role") role = value;
			else {
				const path = resolve(value);
				const info = statSync(path);
				if (!info.isFile() || info.size > 64000)
					throw new Error("Evidence must be a regular file of at most 64000 bytes");
				evidence.push({ ref: path, content: readFileSync(path, "utf8") });
			}
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		positional.push(arg);
	}
	if (positional.length < 1 || positional.length > 2)
		throw new Error("Expected a factory directory and optional action id");
	const directory = resolve(positional[0]);
	const config = readFactoryConfig(directory);
	const db = join(directory, "factory.db");
	if (!existsSync(db)) throw new Error("Factory is not initialized");
	const store = new FactoryStore(db);
	try {
		const engine = new FactoryEngine(store, noDispatch, { pauseFile: config.pauseFile });
		const callPrimeManagementModel = createPrimeManagementCaller(() => {
			if (engine.status().paused) throw new Error("Factory paused before inference; no management request was sent");
		});
		const status = engine.status();
		if (status.paused) throw new Error("Factory is paused; no management request was sent");
		const profile = status.roles?.[role];
		if (!profile) throw new Error(`No model configured for factory role: ${role}`);
		const packet = createManagementPacket(status, positional[1], evidence);
		const requestId = randomUUID();
		const output = join(directory, "decisions", requestId);
		mkdirSync(output, { recursive: true, mode: 0o700 });
		save(join(output, "request.json"), { id: requestId, createdAt: new Date().toISOString(), role, profile, packet });
		let result: ManagementResult;
		try {
			result = await proposeManagementDecision(
				packet,
				profile,
				async (...parameters) => {
					const response = await callPrimeManagementModel(...parameters);
					save(join(output, "response.json"), response);
					return response;
				},
				requestId,
			);
			save(join(output, "proposal.json"), result);
		} catch (error) {
			save(join(output, "error.json"), { error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		let applied = false;
		if (apply && result.proposal.decision !== "defer") {
			try {
				engine.decide(
					packet.action.id,
					result.proposal.decision,
					{
						actor: `${role}:${profile.provider}/${profile.model}`,
						reason: result.proposal.reason,
						ref: join(output, "proposal.json"),
					},
					packet.planRevision,
					packet.attempt?.id,
				);
				applied = true;
			} catch (error) {
				save(join(output, "apply-error.json"), { error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		}
		save(join(output, "application.json"), { applied, decision: result.proposal.decision });
		console.log(JSON.stringify({ ...result, applied, evidenceDirectory: output }, null, 2));
	} finally {
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
