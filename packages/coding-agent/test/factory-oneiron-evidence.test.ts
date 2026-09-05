import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type OneironSuccessor,
	type OneironSuccessorPacket,
	submitOneironSuccessor,
	validateOneironSuccessor,
} from "../src/factory/adapters/oneiron-continuation.js";
import { type OneironPin, oneironSha } from "../src/factory/adapters/oneiron-review.js";
import { FACTORY_EVIDENCE_LIMITS } from "../src/factory/evidence.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "oneiron-successor-evidence-"));
	roots.push(root);
	const pin = (name: string, content: string): OneironPin => {
		const path = join(root, name);
		writeFileSync(path, content);
		return { path, sha256: oneironSha(content) };
	};
	const packet = {
		version: 1,
		requestId: "request-1",
		planRevision: 7,
		outcome: "AWAITING_DECISION",
		receipt: pin("receipt.json", JSON.stringify({ stage: "triage", productAccepted: false })),
		responsePath: join(root, "response.json"),
	} as OneironSuccessorPacket;
	const citation = pin("citation.txt", "Original retained factual evidence.");
	const candidate: OneironSuccessor = {
		version: 1,
		requestId: packet.requestId,
		planRevision: packet.planRevision,
		reason: "Preserve the original decision and validate the bounded successor before submission.",
		evidence: [citation],
		next: {
			kind: "wait",
			actor: "existing-producer",
			path: join(root, "new-evidence.json"),
			observedSha256: null,
			instructions: citation,
		},
	};
	return { root, pin, packet, candidate };
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coordinator evidence preflight", () => {
	test.each([9, 12, 32])("accepts %i citation pins without spending inline evidence budget", (count) => {
		const f = fixture();
		f.candidate.evidence = Array.from({ length: count }, (_, index) => f.pin(`cite-${index}`, "x".repeat(3000)));
		expect(validateOneironSuccessor(f.candidate, f.packet)).toBe(f.candidate);
	});

	test("permits more than three small docs and one doc over old character cap within shared byte budget", () => {
		const f = fixture();
		f.candidate.next = {
			kind: "resume-judgment",
			supplementalEvidence: Array.from({ length: 8 }, (_, index) =>
				f.pin(`doc-${index}`, `${index}:${"x".repeat(index === 0 ? 17000 : 100)}`),
			),
		};
		expect(validateOneironSuccessor(f.candidate, f.packet)).toBe(f.candidate);
	});

	test("counts all supplemental and canonical receipt content in UTF-8 bytes without truncation", () => {
		const f = fixture();
		const receiptBytes = Buffer.byteLength(readFileSync(f.packet.receipt!.path, "utf8"));
		const allowance = FACTORY_EVIDENCE_LIMITS.contentBytes - receiptBytes;
		const unicode = "😀".repeat(Math.floor(allowance / 4));
		const first = f.pin("unicode", unicode);
		const exact = f.pin("remainder", "a".repeat(allowance - Buffer.byteLength(unicode) + 1));
		f.candidate.next = { kind: "resume-judgment", supplementalEvidence: [first, exact] };
		expect(() => validateOneironSuccessor(f.candidate, f.packet)).toThrow(
			/content aggregate: actual 65537 UTF-8 bytes exceeds limit 65536/,
		);
		expect(readFileSync(first.path, "utf8")).toBe(unicode);
		expect(existsSync(f.packet.responsePath)).toBe(false);
	});

	test("reports exact field/count/path/hash bounds without coercing malformed refs", () => {
		const f = fixture();
		f.candidate.evidence = Array.from({ length: 33 }, (_, index) => ({
			path: `/cite-${index}`,
			sha256: "a".repeat(64),
		}));
		expect(() => validateOneironSuccessor(f.candidate, f.packet)).toThrow(
			"response.evidence.length: actual 33; limit 1..32",
		);
		const invalids = [
			[null, "response.evidence[0]: expected {path,sha256}"],
			[
				{
					path: {
						toString: () => {
							throw new Error("coerced");
						},
					},
					sha256: "a".repeat(64),
				},
				"response.evidence[0].path: expected a nonempty string",
			],
			[{ path: "relative", sha256: "a".repeat(64) }, "response.evidence[0].path: expected an absolute path"],
			[
				{ path: `/${"é".repeat(2000)}`, sha256: "a".repeat(64) },
				"response.evidence[0].path: actual 4001 UTF-8 bytes exceeds limit 4000",
			],
			[{ path: "/ok", sha256: null }, "response.evidence[0].sha256: expected 64 lowercase hexadecimal characters"],
		] as const;
		for (const [value, message] of invalids) {
			f.candidate.evidence = [value] as OneironPin[];
			expect(() => validateOneironSuccessor(f.candidate, f.packet)).toThrow(message);
		}
	});

	test("native submit validates before atomic publication and cannot overwrite a prior response", () => {
		const f = fixture();
		const packetPin = f.pin("packet.json", JSON.stringify(f.packet));
		const candidatePin = f.pin("candidate.json", JSON.stringify(f.candidate));
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"src/factory/adapters/oneiron-continuation-entry.ts",
				"validate",
				packetPin.path,
				packetPin.sha256,
				candidatePin.path,
				candidatePin.sha256,
			],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(output).kind).toBe("valid");
		expect(existsSync(f.packet.responsePath)).toBe(false);
		const submitted = submitOneironSuccessor(packetPin, candidatePin);
		expect(JSON.parse(readFileSync(submitted.path, "utf8"))).toEqual(f.candidate);
		expect(submitOneironSuccessor(packetPin, candidatePin)).toEqual(submitted);
		const other = f.pin(
			"other.json",
			JSON.stringify({
				...f.candidate,
				reason: "Changed response cannot overwrite the immutable submitted original.",
			}),
		);
		expect(() => submitOneironSuccessor(packetPin, other)).toThrow(/Immutable continuation artifact changed/);
		expect(oneironSha(readFileSync(submitted.path))).toBe(submitted.sha256);
	});

	test("preflight budgets exact pretty-printed published bytes, not only compact candidate bytes", () => {
		const f = fixture();
		const oversized = { ...f.candidate, retainedMetadata: Array.from({ length: 40000 }, () => 1) };
		const compact = JSON.stringify(oversized);
		expect(Buffer.byteLength(compact)).toBeLessThan(FACTORY_EVIDENCE_LIMITS.responseBytes);
		const actual = Buffer.byteLength(`${JSON.stringify(oversized, null, 2)}\n`);
		expect(actual).toBeGreaterThan(FACTORY_EVIDENCE_LIMITS.responseBytes);
		const packet = f.pin("packet.json", JSON.stringify(f.packet));
		const candidate = f.pin("candidate.json", compact);
		expect(() => validateOneironSuccessor(oversized, f.packet)).toThrow(
			`response.publishedJson: actual ${actual} UTF-8 bytes exceeds limit 262144`,
		);
		expect(() => submitOneironSuccessor(packet, candidate)).toThrow("response.publishedJson");
		expect(existsSync(f.packet.responsePath)).toBe(false);
	});

	test("invalid candidate never creates final response", () => {
		const f = fixture();
		const packet = f.pin("packet.json", JSON.stringify(f.packet));
		const candidate = f.pin("candidate.json", JSON.stringify({ ...f.candidate, reason: "😀".repeat(1001) }));
		expect(() => submitOneironSuccessor(packet, candidate)).toThrow(
			"response.reason: actual 4004 UTF-8 bytes exceeds limit 4000",
		);
		expect(existsSync(f.packet.responsePath)).toBe(false);
	});
});
