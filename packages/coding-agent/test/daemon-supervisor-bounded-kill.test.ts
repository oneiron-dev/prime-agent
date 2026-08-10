import { describe, expect, it, vi } from "vitest";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor, WORKER_KILL_ACK_TIMEOUT_MS } from "../src/modes/daemon/daemon-supervisor.js";

interface BoundedKillInternals {
	forwardToWorker: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	stopKilledRootWorker(worker: unknown, command: DaemonCommand): Promise<DaemonResponse>;
}

function makeSupervisor(): BoundedKillInternals {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		forwardToWorker: vi.fn(async () => ({ id: "command-1", type: "response", command: "kill", success: true })),
		stopWorker: vi.fn(async () => undefined),
		log: vi.fn(),
	}) as BoundedKillInternals;
}

const killCommand = { id: "command-1", type: "kill", activeSessionId: "root" } as DaemonCommand;
const worker = { descriptor: { workerId: "worker-1", pid: process.pid } };

describe("daemon supervisor bounded root kill", () => {
	it("forwards the kill behind a bounded ack timeout instead of the 24h worker timeout", async () => {
		const supervisor = makeSupervisor();
		await supervisor.stopKilledRootWorker(worker, killCommand);
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(worker, killCommand, WORKER_KILL_ACK_TIMEOUT_MS);
		expect(WORKER_KILL_ACK_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
	});

	it("keeps the graceful stop path and returns the worker response when the worker acknowledges", async () => {
		const supervisor = makeSupervisor();
		const response = await supervisor.stopKilledRootWorker(worker, killCommand);
		expect(response).toEqual({ id: "command-1", type: "response", command: "kill", success: true });
		expect(supervisor.stopWorker).toHaveBeenCalledWith(worker, true, false, true);
		expect(supervisor.log).not.toHaveBeenCalled();
	});

	it("force-stops a wedged worker and still returns a kill success", async () => {
		const supervisor = makeSupervisor();
		supervisor.forwardToWorker.mockRejectedValue(new Error("request timed out"));
		const response = await supervisor.stopKilledRootWorker(worker, killCommand);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(worker, true, true, true);
		expect(response).toEqual({ id: "command-1", type: "response", command: "kill", success: true });
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("worker-1"));
	});

	it("force-stops when the worker connection is already broken", async () => {
		const supervisor = makeSupervisor();
		supervisor.forwardToWorker.mockRejectedValue(new Error("Session worker is failed"));
		await expect(supervisor.stopKilledRootWorker(worker, killCommand)).resolves.toMatchObject({ success: true });
		expect(supervisor.stopWorker).toHaveBeenCalledWith(worker, true, true, true);
	});

	it("reports failure instead of hanging when the wedged worker survives SIGKILL", async () => {
		const supervisor = makeSupervisor();
		supervisor.forwardToWorker.mockRejectedValue(new Error("request timed out"));
		supervisor.stopWorker.mockRejectedValue(new Error("Session worker worker-1 did not stop after SIGKILL"));
		await expect(supervisor.stopKilledRootWorker(worker, killCommand)).rejects.toThrow(/did not stop after SIGKILL/);
	});
});
