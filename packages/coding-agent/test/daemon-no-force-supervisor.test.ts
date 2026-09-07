import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonUpdateRestartManifest,
	success,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness(commitFails: boolean, capable = true) {
	const root = mkdtempSync(join(tmpdir(), "no-force-supervisor-"));
	roots.push(root);
	mkdirSync(join(root, "daemon-update-restarts"));
	const manifest: DaemonUpdateRestartManifest = {
		formatVersion: 1,
		noForce: true,
		createdAt: new Date().toISOString(),
		sessions: [],
		discardedActiveSessionIds: ["root"],
	};
	const requestWorker = vi.fn(async (command: { type: string }) => {
		if (command.type === "worker_prepare_update") return success(undefined, "prepare_update_restart", manifest);
		if (command.type === "worker_commit_update" && commitFails) throw new Error("lost commit response");
		return success(undefined, "prepare_update_restart");
	});
	const worker = {
		summaries: new Map(),
		descriptor: { workerId: "worker", rootActiveSessionId: "root", lifecycle: "ready" },
		client: {
			requestWorker,
			hello: {
				protocol: DAEMON_PROTOCOL_INFO,
				schemaRevision: DAEMON_SCHEMA_REVISION,
				serverCapabilities: capable ? DAEMON_DEFAULT_SERVER_CAPABILITIES : [],
			},
		},
	};
	const stopWorker = vi.fn(async () => undefined);
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers: new Map([["worker", worker]]),
		defaultSessionConfig: { agentDir: root },
		socketPath: join(root, "daemon.sock"),
		isWorkerStopping: () => false,
		stopWorker,
		validateAndPersistUpdateManifest: vi.fn(),
		log: vi.fn(),
	}) as {
		prepareUpdateRestartFenced(deadline: number, noForce: boolean): Promise<DaemonUpdateRestartManifest>;
		updateRestartPhase?: string;
	};
	return { supervisor, stopWorker, requestWorker };
}

describe("supervisor no-force commit fence", () => {
	it("retains the fence and never stops a worker after an uncertain commit response", async () => {
		const { supervisor, stopWorker } = harness(true);
		await expect(supervisor.prepareUpdateRestartFenced(Date.now() + 10000, true)).rejects.toThrow("uncertain");
		expect(supervisor.updateRestartPhase).toBe("prepared");
		expect(stopWorker).not.toHaveBeenCalled();
	});
	it("rejects an old reader before sending any worker prepare or close", async () => {
		const { supervisor, stopWorker, requestWorker } = harness(false, false);
		await expect(supervisor.prepareUpdateRestartFenced(Date.now() + 10000, true)).rejects.toThrow(
			"no_force_update_restart",
		);
		expect(requestWorker).not.toHaveBeenCalled();
		expect(stopWorker).not.toHaveBeenCalled();
	});
	it("uses only the no-signal worker stop path after acknowledged commit", async () => {
		const { supervisor, stopWorker, requestWorker } = harness(false);
		expect((await supervisor.prepareUpdateRestartFenced(Date.now() + 10000, true)).noForce).toBe(true);
		expect(requestWorker).toHaveBeenCalledWith({ type: "worker_commit_update", noForce: true }, expect.any(Number));
		expect(stopWorker).toHaveBeenCalledWith(expect.anything(), false, false, false, false, undefined, true);
	});
});
