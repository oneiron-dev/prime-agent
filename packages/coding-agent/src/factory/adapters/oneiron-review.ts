import { createHash } from "node:crypto";

export interface OneironPin {
	path: string;
	sha256: string;
}
export interface OneironReviewItem {
	id: string;
	body: string;
	bodySha256: string;
	commit: string | null;
	reviewer: "qodo" | "codex";
	url: string;
	/** GitHub's outdated/resolved flags are context, not semantic disposition. */
	threadResolved: boolean;
	threadOutdated: boolean;
}
export interface OneironFinding {
	id: string;
	bodySha256: string;
	classification: "informational" | "stale" | "duplicate" | "invalid" | "material" | "debt";
	disposition: "open" | "fixed" | "dismissed";
	reason: string;
	evidenceRefs: string[];
	resolvedAtCommit?: string;
}
export interface OneironTriage {
	version: 1;
	candidateCommit: string;
	/** Required in new native triage; absent only in historical exact-head results. */
	reviewedHead?: string;
	sourceFingerprint: string;
	corpusSha256: string;
	findings: OneironFinding[];
}
export interface OneironReviewReport {
	candidateCommit: string;
	/** Native triage projection only. Corpus inspection itself stays exact-head. */
	reviewedHead?: string;
	historicalCompletedReviewers?: ("qodo" | "codex")[];
	corpusSha256: string;
	completedReviewers: ("qodo" | "codex")[];
	items: OneironReviewItem[];
	blockers: string[];
}

export function oneironSha(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected review object");
	return value as Record<string, unknown>;
}
function reviewer(login: unknown): "qodo" | "codex" | undefined {
	if (["qodo-merge-pro[bot]", "qodo-merge-pro", "qodo-code-review[bot]", "qodo-code-review"].includes(String(login)))
		return "qodo";
	if (["chatgpt-codex-connector[bot]", "chatgpt-codex-connector", "codex[bot]", "codex"].includes(String(login)))
		return "codex";
	return undefined;
}
const NOT_COMPLETED =
	/(?:review (?:was |is |has been )?(?:skipped|disabled|pending|queued|timed out)|quota(?:[- ]limited| exceeded| exhausted)|(?:usage|rate) limit|unable to review|review not (?:run|performed)|maximum number of reviews)/i;

/** Consume the existing helper's frozen schema. Check-run success is never a review. */
export function inspectOneironCorpus(
	text: string,
	expected: { repo: string; pr: number; head: string; base: string },
): OneironReviewReport {
	const corpus = object(JSON.parse(text));
	if (
		corpus.schema !== "oneiron.wave6.github-bot-corpus.v1" ||
		corpus.repo !== expected.repo ||
		corpus.github_mutation !== false
	)
		throw new Error("Corpus schema/repository identity mismatch");
	const pins = object(corpus.pins);
	if (pins[String(expected.pr)] !== expected.head || !Array.isArray(corpus.prs))
		throw new Error("Corpus pin mismatch");
	const prs = corpus.prs.map(object).filter((pr) => pr.number === expected.pr);
	if (prs.length !== 1) throw new Error("Corpus must contain the selected PR exactly once");
	const pr = prs[0]!;
	if (pr.head_sha !== expected.head || pr.base_ref !== expected.base || !Array.isArray(pr.items))
		throw new Error("Corpus head/base mismatch");
	const items: OneironReviewItem[] = [];
	const completed = new Set<"qodo" | "codex">();
	const seen = new Set<string>();
	for (const raw of pr.items) {
		const item = object(raw);
		const bot = reviewer(object(item.author).login);
		if (!bot) continue;
		const body = typeof item.body === "string" ? item.body : "";
		if (typeof item.key !== "string" || !Array.isArray(item.sources) || item.body_sha256 !== oneironSha(body))
			throw new Error("Review item integrity mismatch");
		if (seen.has(item.key)) throw new Error("Duplicate corpus review item");
		seen.add(item.key);
		const isReview = item.sources.includes("review");
		// Empty review envelopes count only through their own exact-commit inline findings.
		const rawComments = object(pr.raw).review_comments;
		const inline =
			Array.isArray(rawComments) &&
			rawComments
				.map(object)
				.some(
					(comment) =>
						comment.pull_request_review_id === item.id &&
						comment.commit_id === expected.head &&
						reviewer(object(comment.user).login) === bot &&
						typeof comment.body === "string" &&
						comment.body.trim().length >= 40 &&
						!NOT_COMPLETED.test(comment.body),
				);
		const substantiveBody = body.trim().length >= 40 && !/automated review suggestions|tips about codex/i.test(body);
		if (
			isReview &&
			item.commit_id === expected.head &&
			["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(String(item.state)) &&
			(substantiveBody || inline) &&
			!NOT_COMPLETED.test(body)
		)
			completed.add(bot);
		const qodoFooter = `<!-- https://github.com/${expected.repo}/commit/${expected.head} -->`;
		if (
			bot === "qodo" &&
			item.sources.includes("issue_comment") &&
			body.includes("<h3>Code Review by Qodo</h3>") &&
			body.includes(qodoFooter) &&
			body.trim().length >= 100 &&
			!NOT_COMPLETED.test(body)
		)
			completed.add(bot);
		if (!body.trim() || item.in_reply_to_id) continue;
		if (
			!item.sources.some((source) =>
				["review", "review_comment", "review_thread_comment", "issue_comment"].includes(String(source)),
			)
		)
			continue;
		items.push({
			id: `${expected.repo}#${expected.pr}:${item.key}`,
			body,
			bodySha256: oneironSha(body),
			commit: typeof item.commit_id === "string" ? item.commit_id : null,
			reviewer: bot,
			url: typeof item.url === "string" ? item.url : "",
			threadResolved: item.thread_resolved === true,
			threadOutdated: item.thread_outdated === true,
		});
	}
	return {
		candidateCommit: expected.head,
		corpusSha256: oneironSha(text),
		completedReviewers: [...completed].sort(),
		items,
		blockers: (["qodo", "codex"] as const)
			.filter((bot) => !completed.has(bot))
			.map((bot) => `${bot}: no substantive completed exact-commit review`),
	};
}

/** Require complete modeled coverage, including old material obligations after a head change. */
export function validateOneironTriage(
	value: unknown,
	report: OneironReviewReport,
	sourceFingerprint: string,
	prior: OneironFinding[],
	allowedEvidenceRefs: string[],
): OneironTriage {
	const triage = object(value) as unknown as OneironTriage;
	if (
		triage.version !== 1 ||
		triage.candidateCommit !== report.candidateCommit ||
		(report.reviewedHead !== undefined && triage.reviewedHead !== report.reviewedHead) ||
		(triage.reviewedHead !== undefined && triage.reviewedHead !== (report.reviewedHead ?? report.candidateCommit)) ||
		triage.sourceFingerprint !== sourceFingerprint ||
		triage.corpusSha256 !== report.corpusSha256 ||
		!Array.isArray(triage.findings)
	)
		throw new Error("Triage source/corpus identity mismatch");
	const required = new Map(report.items.map((item) => [item.id, item.bodySha256]));
	const oldMaterial = prior.filter(
		(item) => ["material", "debt"].includes(item.classification) && item.disposition === "open",
	);
	for (const item of oldMaterial) {
		if (required.has(item.id) && required.get(item.id) !== item.bodySha256)
			throw new Error("Edited material finding must retain its original identity in the prior ledger");
		required.set(item.id, item.bodySha256);
	}
	const seen = new Set<string>();
	for (const [index, item] of triage.findings.entries()) {
		const label = item && typeof item.id === "string" ? JSON.stringify(item.id.slice(0, 256)) : `at index ${index}`;
		const fail = (condition: string): never => {
			throw new Error(`Triage finding ${label}: ${condition}`);
		};
		if (!item || typeof item.id !== "string" || !required.has(item.id))
			fail("id was not supplied in current items or carried material findings");
		if (seen.has(item.id)) fail("duplicate id");
		if (required.get(item.id) !== item.bodySha256) fail("bodySha256 differs from the supplied finding");
		seen.add(item.id);
		if (!["informational", "stale", "duplicate", "invalid", "material", "debt"].includes(item.classification))
			fail("classification must be exactly informational, stale, duplicate, invalid, material or debt");
		if (!["open", "fixed", "dismissed"].includes(item.disposition))
			fail("disposition must be exactly open, fixed or dismissed");
		if (typeof item.reason !== "string") fail("reason must be a string");
		if (item.reason.trim().length < 20)
			fail(`reason must have at least 20 characters after trimming (got ${item.reason.trim().length})`);
		if (!Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length)
			fail("evidenceRefs must be a nonempty array of current packet.evidence[].ref values");
		const invalidRef = item.evidenceRefs.findIndex((ref) => !allowedEvidenceRefs.includes(ref));
		if (invalidRef !== -1) {
			const ref: unknown = item.evidenceRefs[invalidRef];
			const rendered =
				typeof ref === "string"
					? JSON.stringify(ref.slice(0, 512))
					: `<${ref === null ? "null" : Array.isArray(ref) ? "array" : typeof ref}>`;
			fail(`evidenceRefs[${invalidRef}] is not a current packet.evidence[].ref value: ${rendered}`);
		}
		const wasMaterial = oldMaterial.some((old) => old.id === item.id);
		if (wasMaterial && !["material", "debt"].includes(item.classification))
			fail("unresolved material finding cannot be erased by reclassification");
		if ((wasMaterial || ["material", "debt"].includes(item.classification)) && item.disposition !== "open") {
			if (item.resolvedAtCommit !== report.candidateCommit)
				fail("resolvedAtCommit must equal candidateCommit for material resolution");
			if (!item.evidenceRefs.some((ref) => ref !== `sha256:${report.corpusSha256}`))
				fail("material resolution requires supplied repair/adjudication evidence beyond the bot corpus");
		}
	}
	if (seen.size !== required.size)
		throw new Error("Triage omitted review items or prior unresolved material findings");
	return triage;
}

export function oneironReviewBlockers(report: OneironReviewReport, triage: OneironTriage): string[] {
	return [
		...report.blockers,
		...triage.findings
			.filter((item) => item.disposition === "open")
			.map((item) => `${item.id}: unresolved ${item.classification}`),
	];
}
