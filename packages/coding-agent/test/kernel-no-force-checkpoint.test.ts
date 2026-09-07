import { describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";

describe("native kernel no-force checkpoint", () => {
	it("accepts an unstarted kernel without creating a process", () => {
		const manager = new ReplKernelManager({});
		expect(manager.noForceUpdateBlocker).toBeUndefined();
		expect(manager.processId).toBeUndefined();
	});

	it.each([
		"activeExecution",
		"pendingExecutions",
		"inFlightHostRequests",
		"protocolRepairPromise",
		"teardownInFlight",
	])("rejects %s before shutdown", (field) => {
		const manager = new ReplKernelManager({});
		Object.assign(manager, { [field]: field === "inFlightHostRequests" ? new Set([Promise.resolve()]) : 1 });
		expect(manager.noForceUpdateBlocker).toBeDefined();
		expect(manager.isShutDown).toBe(false);
	});
});
