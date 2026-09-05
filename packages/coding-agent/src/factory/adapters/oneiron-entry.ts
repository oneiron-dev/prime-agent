import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FactoryStatus } from "../types.js";
import {
	bindOneironEvidence,
	executeOneiron,
	inspectOneiron,
	type OneironManifest,
	prepareOneiron,
} from "./oneiron.js";
import { oneironSha } from "./oneiron-review.js";

export async function runOneironCli(args: string[]): Promise<unknown> {
	const [command, manifestPath, argument, choice, ...rest] = args;
	if (command === "help" || !command)
		return {
			usage: [
				"inspect MANIFEST",
				"prepare MANIFEST OPTIONS_JSON",
				"execute MANIFEST PERMIT MANIFEST_SHA256 --execute",
				"bind MANIFEST STATUS_JSON RECEIPT_JSON ACTION_ID",
			],
			preparation:
				"inspect/prepare/bind only read local files and print JSON. No factory import, pause change, model, Cargo, GitHub or publication.",
			execution:
				"Requires an explicit owner permit, released/transferred custody, clear local/external pauses and exact source. Only one stage executes; no implicit next-head planning.",
		};
	if (!manifestPath) throw new Error("Manifest path required");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OneironManifest;
	switch (command) {
		case "inspect":
			if (argument) throw new Error("inspect takes only MANIFEST");
			return inspectOneiron(manifest);
		case "prepare": {
			if (!argument || choice) throw new Error("prepare requires MANIFEST OPTIONS_JSON");
			const options = JSON.parse(readFileSync(argument, "utf8")) as Parameters<typeof prepareOneiron>[1];
			return prepareOneiron(manifest, { ...options, manifestPath });
		}
		case "execute":
			if (!argument || !choice || !/^[a-f0-9]{64}$/.test(choice) || rest.length !== 1 || rest[0] !== "--execute")
				throw new Error("execute requires MANIFEST PERMIT --execute");
			return executeOneiron(manifestPath, argument, true, undefined, choice);
		case "bind": {
			if (!argument || !choice || rest.length !== 1)
				throw new Error("bind requires MANIFEST STATUS_JSON RECEIPT_JSON ACTION_ID");
			const status = JSON.parse(readFileSync(argument, "utf8")) as FactoryStatus;
			return bindOneironEvidence(status, rest[0]!, manifest, {
				path: choice,
				sha256: oneironSha(readFileSync(choice)),
			});
		}
		default:
			throw new Error(`Unknown Oneiron adapter command ${command}`);
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		console.log(JSON.stringify(await runOneironCli(process.argv.slice(2)), null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
