import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	inspectOneironCorpus,
	type OneironFinding,
	oneironReviewBlockers,
	oneironSha,
	validateOneironTriage,
} from "../src/factory/adapters/oneiron-review.js";

const head = "a".repeat(40);
const expected = { repo: "org/repo", pr: 855, head, base: "main" };
function item(key: string, login: string, overrides: Record<string, unknown> = {}) {
	const body = "Reviewed source contracts and tests. No material correctness issue was found in the changed code.";
	return {
		key,
		id: key.split(":")[1],
		sources: ["review"],
		author: { login },
		body,
		body_sha256: oneironSha(body),
		state: "COMMENTED",
		commit_id: head,
		...overrides,
	};
}
function corpus(items: unknown[], comments: unknown[] = []) {
	return JSON.stringify({
		schema: "oneiron.wave6.github-bot-corpus.v1",
		repo: "org/repo",
		github_mutation: false,
		pins: { 855: head },
		prs: [{ number: 855, head_sha: head, base_ref: "main", items, raw: { review_comments: comments } }],
	});
}
function report() {
	return inspectOneironCorpus(
		corpus([item("review:1", "qodo-code-review[bot]"), item("review:2", "chatgpt-codex-connector[bot]")]),
		expected,
	);
}
function disposition(id: string, hash: string, extra: Partial<OneironFinding> = {}): OneironFinding {
	return {
		id,
		bodySha256: hash,
		classification: "informational",
		disposition: "dismissed",
		reason: "The exact-head review provides a no-findings result, not a material obligation.",
		evidenceRefs: [`sha256:${report().corpusSha256}`],
		...extra,
	};
}

describe("Oneiron exact-commit review policy", () => {
	test("preserves the six actual PR855 roots and carries the docs CodeRabbit obligation", () => {
		const text = readFileSync(
			new URL("./fixtures/factory-oneiron/pr855-review-extract.json", import.meta.url),
			"utf8",
		);
		const report = inspectOneironCorpus(text, {
			repo: "oneiron-dev/oneiron",
			pr: 855,
			head: "3a3b482ca80f361b1c7dc190c3831647aad63064",
			base: "main",
		});
		expect(report.completedReviewers).toEqual(["codex", "qodo"]);
		const roots = report.items.filter((item) => item.id.includes(":review_comment:"));
		expect(roots.map((item) => item.id.split(":").at(-1))).toEqual([
			"3936277432",
			"3936314147",
			"3936314153",
			"3936314158",
			"3936314165",
			"3936314167",
		]);
		const prior = disposition("oneiron-dev/oneiron-docs#457:review_comment:3936283027", "d".repeat(64), {
			classification: "material",
			disposition: "open",
			evidenceRefs: [`sha256:${report.corpusSha256}`],
		});
		const findings = report.items.map((item) =>
			disposition(item.id, item.bodySha256, {
				classification: "material",
				disposition: "open",
				evidenceRefs: [`sha256:${report.corpusSha256}`],
			}),
		);
		const triage = {
			version: 1,
			candidateCommit: report.candidateCommit,
			sourceFingerprint: "git:fixture",
			corpusSha256: report.corpusSha256,
			findings,
		};
		expect(() =>
			validateOneironTriage(triage, report, "git:fixture", [prior], [`sha256:${report.corpusSha256}`]),
		).toThrow(/omitted/);
		triage.findings.push(prior);
		expect(
			oneironReviewBlockers(
				report,
				validateOneironTriage(triage, report, "git:fixture", [prior], [`sha256:${report.corpusSha256}`]),
			),
		).toContain(`${prior.id}: unresolved material`);
	});
	test("credits actual Qodo and Codex substantive completed reviews", () => {
		expect(report().completedReviewers).toEqual(["codex", "qodo"]);
		expect(report().blockers).toEqual([]);
	});
	test.each(["skipped", "disabled", "pending", "queued", "timed out", "quota exceeded", "usage limit exhausted"])(
		"does not credit %s",
		(state) => {
			const body = `This review was ${state}. The bot has not analyzed any changed source files yet.`;
			const data = item("review:1", "qodo-code-review[bot]", { body, body_sha256: oneironSha(body) });
			expect(inspectOneironCorpus(corpus([data]), expected).completedReviewers).not.toContain("qodo");
		},
	);
	test("green check, missing commit, stale review, empty envelope and boilerplate are not completion", () => {
		for (const overrides of [
			{ sources: ["check_run"], status: "completed", conclusion: "success" },
			{ commit_id: undefined },
			{ commit_id: "b".repeat(40) },
			{ body: "", body_sha256: oneironSha("") },
			{
				body: "Here are some automated review suggestions for this pull request. Tips about Codex.",
				body_sha256: oneironSha(
					"Here are some automated review suggestions for this pull request. Tips about Codex.",
				),
			},
		]) {
			expect(
				inspectOneironCorpus(corpus([item("review:1", "qodo-code-review[bot]", overrides)]), expected)
					.completedReviewers,
			).not.toContain("qodo");
		}
	});
	test("credits an empty review only via its own exact-head inline finding; handles GraphQL login aliases", () => {
		const body = "This truncates the candidate before the filter, losing eligible search results.";
		const review = item("review:1", "qodo-code-review[bot]", { body: "", body_sha256: oneironSha("") });
		const comment = { pull_request_review_id: "1", commit_id: head, body, user: { login: "qodo-code-review[bot]" } };
		const normalized = item("review_comment:4", "qodo-code-review", {
			sources: ["review_comment", "review_thread_comment"],
			body,
			body_sha256: oneironSha(body),
			thread_outdated: true,
			thread_resolved: true,
		});
		const result = inspectOneironCorpus(corpus([review, normalized], [comment]), expected);
		expect(result.completedReviewers).toContain("qodo");
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.threadOutdated).toBe(true);
		expect(
			inspectOneironCorpus(corpus([review], [{ ...comment, pull_request_review_id: "other" }]), expected)
				.completedReviewers,
		).not.toContain("qodo");
	});
	test("Qodo no-findings comment requires its exact full-commit footer and actual review marker", () => {
		const body = `<h3>Code Review by Qodo</h3> Qodo reviewed your code and found no material issues that require review. <!-- https://github.com/org/repo/commit/${head} -->`;
		const data = item("comment:4", "qodo-code-review[bot]", {
			sources: ["issue_comment"],
			commit_id: undefined,
			body,
			body_sha256: oneironSha(body),
		});
		expect(inspectOneironCorpus(corpus([data]), expected).completedReviewers).toEqual(["qodo"]);
		const stale = body.replace(head, "b".repeat(40));
		expect(
			inspectOneironCorpus(corpus([{ ...data, body: stale, body_sha256: oneironSha(stale) }]), expected)
				.completedReviewers,
		).toEqual([]);
	});
	test("fails closed on corpus identity and body tampering", () => {
		expect(() =>
			inspectOneironCorpus(corpus([item("review:1", "qodo-code-review[bot]", { body_sha256: "bad" })]), expected),
		).toThrow(/integrity/);
		expect(() => inspectOneironCorpus(corpus([]), { ...expected, head: "b".repeat(40) })).toThrow(/pin/);
	});
	test.each([
		[{ classification: "accepted" }, /classification/],
		[{ disposition: "resolved" }, /disposition/],
		[{ reason: "short" }, /reason.*20.*got 5/],
		[{ reason: null }, /reason must be a string/],
		[{ evidenceRefs: [] }, /evidenceRefs.*nonempty/],
		[{ evidenceRefs: ["https://example.invalid/prior-ref"] }, /evidenceRefs\[0\].*current packet/],
	] as const)("identifies the finding and failed field for %j", (patch, condition) => {
		const r = report();
		const findings = r.items.map((entry) => disposition(entry.id, entry.bodySha256));
		const value = {
			version: 1,
			candidateCommit: head,
			corpusSha256: r.corpusSha256,
			sourceFingerprint: "git:test",
			findings: [{ ...findings[0], ...patch }, ...findings.slice(1)],
		};
		const validate = () => validateOneironTriage(value, r, "git:test", [], [`sha256:${r.corpusSha256}`]);
		expect(validate).toThrow(/Triage finding "org\/repo#855:review:1"/);
		expect(validate).toThrow(condition);
	});
	test("requires every item and preserves old material even across heads, repos or review policy changes", () => {
		const r = report();
		const old = disposition("docs#457:coderabbit:1", "c".repeat(64), {
			classification: "material",
			disposition: "open",
		});
		const values = r.items.map((entry) => disposition(entry.id, entry.bodySha256));
		const base = {
			version: 1,
			candidateCommit: head,
			corpusSha256: r.corpusSha256,
			sourceFingerprint: "git:test",
			findings: values,
		};
		const refs = [`sha256:${r.corpusSha256}`, "repair-proof"];
		expect(() => validateOneironTriage(base, r, "git:test", [old], refs)).toThrow(/omitted/);
		base.findings.push(old);
		const triage = validateOneironTriage(base, r, "git:test", [old], refs);
		expect(oneironReviewBlockers(r, triage)).toContain("docs#457:coderabbit:1: unresolved material");
		expect(() =>
			validateOneironTriage(
				{ ...base, findings: [...values.slice(0, 2), { ...old, classification: "stale" }] },
				r,
				"git:test",
				[old],
				refs,
			),
		).toThrow(/reclassification/);
		expect(() =>
			validateOneironTriage(
				{ ...base, findings: [...values.slice(0, 2), { ...old, disposition: "fixed", resolvedAtCommit: head }] },
				r,
				"git:test",
				[old],
				refs,
			),
		).toThrow(/beyond/);
		const fixed = { ...old, disposition: "fixed", resolvedAtCommit: head, evidenceRefs: ["repair-proof"] };
		expect(
			validateOneironTriage(
				{ ...base, findings: [...values.slice(0, 2), fixed] },
				r,
				"git:test",
				[old],
				refs,
			).findings.at(-1)!.disposition,
		).toBe("fixed");
	});
});
