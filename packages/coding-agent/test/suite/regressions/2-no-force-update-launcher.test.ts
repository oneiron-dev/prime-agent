import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DAEMON_UPDATE_RESTART_COORDINATOR_FLAG,
	DAEMON_UPDATE_RESTART_NO_FORCE_FLAG,
	DAEMON_UPDATE_RESTART_ORIGIN_FLAG,
	DAEMON_UPDATE_RESTART_STATUS_FLAG,
	launchDaemonUpdateRestartCoordinator,
} from "../../../src/cli/daemon-update-restart.js";
import { createHarness } from "../harness.js";

describe("no-force update coordinator launch", () => {
	it.each([undefined, false, true])("forwards noForce=%s to the actual child argv", async (noForce) => {
		const harness = await createHarness();
		const entrypoint = join(harness.tempDir, "coordinator.mjs");
		const argvPath = join(harness.tempDir, "argv.json");
		const socketPath = join(harness.tempDir, "daemon.sock");
		writeFileSync(
			entrypoint,
			`import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));
writeFileSync(args[args.indexOf(${JSON.stringify(DAEMON_UPDATE_RESTART_STATUS_FLAG)}) + 1], JSON.stringify({
	version: 1, requestId: "argv-test", socketPath: ${JSON.stringify(socketPath)}, phase: "skipped",
	coordinator: { pid: process.pid }, counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
	startedAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z"
}));
`,
		);
		const previousArgv = [...process.argv];
		const previousExecArgv = [...process.execArgv];
		process.argv[1] = entrypoint;
		process.execArgv.splice(0, process.execArgv.length);
		try {
			const status = await launchDaemonUpdateRestartCoordinator({
				socketPath,
				agentDir: harness.tempDir,
				originActiveSessionId: "update-origin",
				timeoutMs: 5000,
				...(noForce === undefined ? {} : { noForce }),
			});
			expect(status.phase).toBe("skipped");
			const args = JSON.parse(readFileSync(argvPath, "utf8")) as string[];
			expect(args).toEqual([
				"update",
				DAEMON_UPDATE_RESTART_COORDINATOR_FLAG,
				"--daemon-socket",
				socketPath,
				DAEMON_UPDATE_RESTART_STATUS_FLAG,
				expect.stringContaining(join(harness.tempDir, "update-restarts")),
				DAEMON_UPDATE_RESTART_ORIGIN_FLAG,
				"update-origin",
				...(noForce ? [DAEMON_UPDATE_RESTART_NO_FORCE_FLAG] : []),
			]);
		} finally {
			process.argv.splice(0, process.argv.length, ...previousArgv);
			process.execArgv.splice(0, process.execArgv.length, ...previousExecArgv);
			harness.cleanup();
		}
	});
});
