import { describe, expect, test } from "vitest";
import {
	createManagementPacket,
	parseManagementProposal,
	proposeManagementDecision,
} from "../src/factory/management.js";
import type { FactoryStatus } from "../src/factory/types.js";

function status(): FactoryStatus {
	return {
		schemaVersion: 1,
		planRevision: 3,
		paused: false,
		pauseReason: null,
		tickets: [{ id: "ticket", owner: "owner", state: "ACTIVE" }],
		slots: [],
		actions: [
			{
				id: "review",
				ticketId: "ticket",
				state: "AWAITING_DECISION",
				dependencies: [],
				kind: "decision",
				acceptanceCriteria: ["Independent review passed for the output"],
				sourceFingerprint: "before",
				command: { argv: ["writer"], cwd: "/workspace" },
				requirements: {},
			},
		],
		attempts: [
			{
				id: "attempt-a",
				actionId: "review",
				slotId: "slot",
				state: "TERMINAL",
				createdAt: "2026-09-05",
				submittedAt: "2026-09-05",
				processIdentity: "process",
				claimReleased: true,
				uncertainty: null,
				receipt: {
					attemptId: "attempt-a",
					sourceFingerprint: "before",
					exitCode: 0,
					finishedAt: "2026-09-05",
					artifact: { ref: "/output", sourceFingerprint: "after" },
				},
			},
		],
		wakes: [
			{
				id: 1,
				actionId: "review",
				attemptId: "attempt-a",
				reason: "Review artifact",
				createdAt: "2026-09-05",
				resolvedAt: null,
			},
		],
		roles: { ticketOwner: { provider: "test", model: "configured", effort: "low" } },
	};
}
function proposal(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		version: 1,
		actionId: "review",
		attemptId: "attempt-a",
		planRevision: 3,
		decision: "defer",
		reason: "Need acceptance evidence",
		evidenceRefs: [],
		...overrides,
	});
}

describe("factory management boundary", () => {
	test("builds a compact wake without unrelated ticket histories", () => {
		const input = status();
		input.actions.push({ ...input.actions[0], id: "unrelated", state: "READY" });
		const packet = createManagementPacket(input);
		expect(packet.action.id).toBe("review");
		expect(packet.attempt?.id).toBe("attempt-a");
		expect(JSON.stringify(packet)).not.toContain("unrelated");
	});
	test("rejects stale plan and attempt decisions", () => {
		const packet = createManagementPacket(status());
		expect(() => parseManagementProposal(proposal({ planRevision: 2 }), packet)).toThrow(/revision/);
		expect(() => parseManagementProposal(proposal({ attemptId: "old" }), packet)).toThrow(/revision/);
	});
	test("rejects invented evidence and receipt-only semantic acceptance", () => {
		const packet = createManagementPacket(status());
		expect(() =>
			parseManagementProposal(proposal({ decision: "accept", evidenceRefs: ["/invented"] }), packet),
		).toThrow(/not supplied/);
		expect(() =>
			parseManagementProposal(proposal({ decision: "accept", evidenceRefs: ["factory:attempt:attempt-a"] }), packet),
		).toThrow(/Semantic acceptance/);
	});
	test("allows evidence-bearing rejection and keeps uncertain custody deferred", () => {
		const packet = createManagementPacket(status());
		expect(
			parseManagementProposal(proposal({ decision: "reject", evidenceRefs: ["factory:attempt:attempt-a"] }), packet)
				.decision,
		).toBe("reject");
		packet.action.state = "UNCERTAIN";
		expect(() =>
			parseManagementProposal(proposal({ decision: "reject", evidenceRefs: ["factory:attempt:attempt-a"] }), packet),
		).toThrow(/custody/);
		expect(parseManagementProposal(proposal(), packet).decision).toBe("defer");
	});
	test("requires explicit criteria and evidence for semantic acceptance", () => {
		const packet = createManagementPacket(status(), undefined, [
			{ ref: "review-proof", content: "Independent review passed for output after." },
		]);
		expect(
			parseManagementProposal(proposal({ decision: "accept", evidenceRefs: ["review-proof"] }), packet).decision,
		).toBe("accept");
		packet.action.acceptanceCriteria = [];
		expect(() =>
			parseManagementProposal(proposal({ decision: "accept", evidenceRefs: ["review-proof"] }), packet),
		).toThrow(/explicit criteria/);
	});
	test("bounds supplied context before any model call", () => {
		expect(() => createManagementPacket(status(), undefined, [{ ref: "proof", content: "x".repeat(16001) }])).toThrow(
			/16000/,
		);
		expect(() =>
			createManagementPacket(status(), undefined, [
				{ ref: "proof", content: "one" },
				{ ref: "proof", content: "two" },
			]),
		).toThrow(/unique/);
	});
	test("makes one configured-model call and returns a proposal without mutating status", async () => {
		const input = status();
		const before = JSON.stringify(input);
		let calls = 0;
		const result = await proposeManagementDecision(
			createManagementPacket(input),
			input.roles!.ticketOwner,
			async (_system, _packet, profile) => {
				calls++;
				return { text: proposal(), model: profile.model, usage: { output: 1 } };
			},
		);
		expect(calls).toBe(1);
		expect(result.proposal.decision).toBe("defer");
		expect(result.packetSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(input)).toBe(before);
	});
	test("does not silently accept a substituted model", async () => {
		const input = status();
		await expect(
			proposeManagementDecision(createManagementPacket(input), input.roles!.ticketOwner, async () => ({
				text: proposal(),
				model: "other",
			})),
		).rejects.toThrow(/differs/);
	});
});
