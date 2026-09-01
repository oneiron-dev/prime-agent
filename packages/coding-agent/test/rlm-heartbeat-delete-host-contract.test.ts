import { afterEach, describe, expect, it } from "vitest";
import type { AgentRlmHeartbeatCancellationReceipt, AgentRlmHeartbeatController } from "../src/core/cron-jobs.js";
import { createHarness, type Harness } from "./suite/harness.js";

const cancellation: AgentRlmHeartbeatCancellationReceipt = {
	id: "heartbeat-1",
	source: "rlm_heartbeat",
	status: "cancelled",
	ownerActiveSessionId: "child-active-1",
	ownerSessionId: "child-session-1",
	ownerSessionFile: "/tmp/child-session.jsonl",
	ownerRuntimeKind: "subagent",
	runCount: 0,
	cancelledAt: "2026-01-01T12:40:00.000Z",
};

describe("rlm_heartbeat.delete host contract", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("returns a cancellation receipt with owner identity and null last_run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.setRlmHeartbeatController(
			controller((id) => (id === cancellation.id ? cancellation : undefined)),
		);

		expect(harness.session.handleRlmHeartbeatHostRequest("rlm_heartbeat.delete", { id: cancellation.id })).toEqual({
			cancellation: {
				id: cancellation.id,
				source: "rlm_heartbeat",
				status: "cancelled",
				owner: {
					active_session_id: "child-active-1",
					session_id: "child-session-1",
					session_file: "/tmp/child-session.jsonl",
					runtime_kind: "subagent",
				},
				run_count: 0,
				last_run: null,
				cancelled_at: "2026-01-01T12:40:00.000Z",
			},
		});
	});

	it("throws the same closed error for unknown and unowned ids", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.setRlmHeartbeatController(controller(() => undefined));

		for (const id of ["missing", "owned-by-another-session"]) {
			expect(() => harness.session.handleRlmHeartbeatHostRequest("rlm_heartbeat.delete", { id })).toThrow(
				"RLM heartbeat was not found for this session",
			);
		}
	});
});

function controller(
	deleteRlmHeartbeat: AgentRlmHeartbeatController["deleteRlmHeartbeat"],
): AgentRlmHeartbeatController {
	return {
		listRlmHeartbeats: () => [],
		createRlmHeartbeat: () => {
			throw new Error("not used");
		},
		updateRlmHeartbeat: () => undefined,
		deleteRlmHeartbeat,
	};
}
