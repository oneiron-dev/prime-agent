import { describe, expect, it } from "vitest";
import { baselineRecap } from "../src/modes/agent-connection/snapshot.js";

describe("baselineRecap", () => {
	it("returns nothing without a persisted status", () => {
		expect(baselineRecap(undefined, 4)).toBeUndefined();
	});

	it("carries a normal recap across later turns", () => {
		expect(
			baselineRecap({ summary: "Wrote the marker file", taskState: "completed", basedOnMessageCount: 2 }, 6),
		).toBe("Wrote the marker file");
	});

	it("keeps an error verdict that is still the transcript's last event", () => {
		const status = {
			summary: "Model request failed: WebSocket closed",
			taskState: "error" as const,
			basedOnMessageCount: 2,
		};
		expect(baselineRecap(status, 2)).toBe("Model request failed: WebSocket closed");
	});

	it("drops an error verdict once later messages superseded it", () => {
		const status = {
			summary: "Model request failed: WebSocket closed",
			taskState: "error" as const,
			basedOnMessageCount: 2,
		};
		expect(baselineRecap(status, 4)).toBeUndefined();
	});
});
