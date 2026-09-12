import { writeFileSync } from "node:fs";
import { isOwnedSessionWorkerProcess } from "../../src/cli/owned-session-worker.js";
import { runCli } from "../../src/cli-main.js";

// Observe routing only. Both processes run the real CLI, including main and print mode.
if (isOwnedSessionWorkerProcess()) {
	const path = process.env.FACTORY_JSON_EVENTS_WORKER;
	if (!path) throw new Error("Missing fixture worker receipt path");
	writeFileSync(
		path,
		JSON.stringify({
			pid: process.pid,
			ppid: process.ppid,
			entry: process.argv[1],
			execPath: process.execPath,
			args: process.argv.slice(2),
			profile: process.env.PRIME_AGENT_INTERNAL_OWNED_PROFILE,
			ipc: process.connected,
			lease: process.env.PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID,
		}),
	);
}
await runCli();
