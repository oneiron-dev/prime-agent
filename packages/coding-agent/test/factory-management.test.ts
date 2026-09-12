import { describe, expect, test, vi } from "vitest";
import { FACTORY_EVIDENCE_LIMITS } from "../src/factory/evidence.js";
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
	test.each([9, 12, 32])("accepts %i small evidence records and proposal references", (count) => {
		const evidence = Array.from({ length: count }, (_, index) => ({
			ref: `review:${index}`,
			content: `Independent exact-output review ${index} passed.`,
		}));
		const packet = createManagementPacket(status(), undefined, evidence);
		expect(packet.evidence).toEqual(evidence);
		expect(
			parseManagementProposal(
				proposal({ decision: "accept", evidenceRefs: evidence.map((item) => item.ref) }),
				packet,
			).evidenceRefs,
		).toHaveLength(count);
	});
	test("uses the full aggregate UTF-8 content budget, not per-record character caps", () => {
		const limit = FACTORY_EVIDENCE_LIMITS.contentBytes;
		expect(
			createManagementPacket(status(), undefined, [{ ref: "proof", content: "x".repeat(limit) }]).evidence,
		).toHaveLength(1);
		const evidence = Array.from({ length: 8 }, (_, index) => ({
			ref: `review:${index}`,
			content: "é".repeat(limit / 16),
		}));
		expect(createManagementPacket(status(), undefined, evidence).evidence).toHaveLength(8);
		evidence[7].content += "é";
		expect(() => createManagementPacket(status(), undefined, evidence)).toThrow(
			`evidence.content aggregate: actual ${limit + 2} UTF-8 bytes exceeds limit ${limit}`,
		);
	});
	test("bounds evidence record count independently of content bytes", () => {
		const evidence = Array.from({ length: 33 }, (_, index) => ({ ref: `proof:${index}`, content: "small" }));
		expect(() => createManagementPacket(status(), undefined, evidence)).toThrow(
			"evidence.length: actual 33; limit 0..32",
		);
	});
	test.each([
		[undefined, "evidence[0].ref: expected a nonempty string without control characters"],
		["", "evidence[0].ref: expected a nonempty string without control characters"],
		["  ", "evidence[0].ref: expected a nonempty string without control characters"],
		[42, "evidence[0].ref: expected a nonempty string without control characters"],
		["review\nproof", "evidence[0].ref: expected a nonempty string without control characters"],
		["é".repeat(2001), "evidence[0].ref: actual 4002 UTF-8 bytes exceeds limit 4000"],
	])("rejects malformed supplied ref %# with field diagnostics", (ref, message) => {
		const evidence = JSON.parse(JSON.stringify([{ ref, content: "proof" }]));
		expect(() => createManagementPacket(status(), undefined, evidence)).toThrow(message);
	});
	test("rejects duplicate supplied refs and reports the offending evidence content field", () => {
		expect(() =>
			createManagementPacket(status(), undefined, [
				{ ref: "proof", content: "one" },
				{ ref: "proof", content: "two" },
			]),
		).toThrow("evidence[1].ref: duplicate reference");
		expect(() => createManagementPacket(status(), undefined, [{ ref: "proof", content: "  " }])).toThrow(
			"evidence[0].content: expected nonempty substantive text",
		);
	});
	test.each([
		[null, "evidenceRefs: expected an array"],
		[[42], "evidenceRefs[0]: expected a nonempty string without control characters"],
		[[""], "evidenceRefs[0]: expected a nonempty string without control characters"],
		[["  "], "evidenceRefs[0]: expected a nonempty string without control characters"],
		[["proof\n"], "evidenceRefs[0]: expected a nonempty string without control characters"],
		[["é".repeat(2001)], "evidenceRefs[0]: actual 4002 UTF-8 bytes exceeds limit 4000"],
		[["proof", "proof"], "evidenceRefs: duplicate references"],
		[Array.from({ length: 33 }, (_, index) => `proof:${index}`), "evidenceRefs.length: actual 33; limit 0..32"],
	])("rejects malformed proposal refs %# before checking membership", (evidenceRefs, message) => {
		const packet = createManagementPacket(status(), undefined, [{ ref: "proof", content: "review passed" }]);
		expect(() => parseManagementProposal(proposal({ evidenceRefs }), packet)).toThrow(message);
	});
	test("allows an exact UTF-8 ref budget and still rejects invented refs on defer", () => {
		const ref = "é".repeat(2000);
		const packet = createManagementPacket(status(), undefined, [{ ref, content: "review passed" }]);
		expect(
			parseManagementProposal(proposal({ decision: "accept", evidenceRefs: [ref] }), packet).evidenceRefs,
		).toEqual([ref]);
		expect(() => parseManagementProposal(proposal({ evidenceRefs: ["invented"] }), packet)).toThrow("not supplied");
	});
	test("includes Unicode metadata in the serialized packet byte budget", () => {
		const input = status();
		input.tickets[0].owner = "";
		const empty = createManagementPacket(input);
		const remaining = FACTORY_EVIDENCE_LIMITS.packetBytes - Buffer.byteLength(JSON.stringify(empty), "utf8");
		input.tickets[0].owner = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
		expect(Buffer.byteLength(JSON.stringify(createManagementPacket(input)), "utf8")).toBe(
			FACTORY_EVIDENCE_LIMITS.packetBytes,
		);
		input.tickets[0].owner += "é";
		expect(() => createManagementPacket(input)).toThrow("packet: actual 98306 UTF-8 bytes exceeds limit 98304");
	});
	test.each(["content", "packet"])("revalidates mutated %s bytes before any model call", async (field) => {
		const input = status();
		const packet = createManagementPacket(input, undefined, [{ ref: "proof", content: "review passed" }]);
		if (field === "content") packet.evidence[0].content = "é".repeat(32769);
		else packet.ticket.owner = "é".repeat(49152);
		const call = vi.fn(async () => ({ text: proposal(), model: "configured" }));
		const expected =
			field === "content"
				? "evidence.content aggregate: actual 65538 UTF-8 bytes exceeds limit 65536"
				: `packet: actual ${Buffer.byteLength(JSON.stringify(packet), "utf8")} UTF-8 bytes exceeds limit 98304`;
		await expect(proposeManagementDecision(packet, input.roles!.ticketOwner, call)).rejects.toThrow(expected);
		expect(call).not.toHaveBeenCalled();
	});
	test("bounds proposal response UTF-8 bytes before parsing", () => {
		const text = proposal({ reason: "é".repeat(131072) });
		expect(() => parseManagementProposal(text, createManagementPacket(status()))).toThrow(
			`response: actual ${Buffer.byteLength(text, "utf8")} UTF-8 bytes exceeds limit 262144`,
		);
	});
	test("does not let supplied evidence impersonate the reserved process receipt namespace", () => {
		expect(() =>
			createManagementPacket(status(), undefined, [
				{ ref: "factory:attempt:attempt-a", content: "Not substantive review evidence" },
			]),
		).toThrow("evidence[0].ref: reserved factory receipt reference");
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
	test("retains transport-reported serving identity without relabeling the SDK selector", async () => {
		const input = status();
		const result = await proposeManagementDecision(
			createManagementPacket(input),
			input.roles!.ticketOwner,
			async () => ({
				text: proposal(),
				model: "configured",
				modelIdentitySource: "sdk",
				responseModel: "actual-served-model",
				responseModelSource: "provider-response",
				responseId: "wire-request-1",
			}),
		);
		expect(result.responseModel).toBe("configured");
		expect(result.servingIdentity).toEqual({
			requestedSelector: "configured",
			responseModel: "actual-served-model",
			responseId: "wire-request-1",
			source: "provider-response",
			upstreamIdentityAttested: false,
		});
	});
	test("does not infer serving identity from an SDK or unqualified caller model field", async () => {
		const input = status();
		const result = await proposeManagementDecision(
			createManagementPacket(input),
			input.roles!.ticketOwner,
			async () => ({
				text: proposal(),
				model: "configured",
				responseModel: "claimed-but-not-transport-derived",
			}),
		);
		expect(result.servingIdentity).toEqual({
			requestedSelector: "configured",
			responseModel: null,
			responseId: null,
			source: "unknown",
			upstreamIdentityAttested: false,
		});
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
