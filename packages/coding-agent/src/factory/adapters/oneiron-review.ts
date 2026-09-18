import { createHash } from "node:crypto";
import type { AdapterDecisionContext, DecisionOf } from "../decisions.js";

export type OneironReviewer = NonNullable<DecisionOf<"review_posting">["reviewer"]>;

export interface OneironPin {
	path: string;
	sha256: string;
}
export interface OneironReviewItem {
	id: string;
	body: string;
	bodySha256: string;
	commit: string | null;
	reviewer: OneironReviewer;
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
	historicalCompletedReviewers?: OneironReviewer[];
	corpusSha256: string;
	completedReviewers: OneironReviewer[];
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
function reviewer(login: unknown): OneironReviewer | undefined {
	if (["qodo-merge-pro[bot]", "qodo-merge-pro", "qodo-code-review[bot]", "qodo-code-review"].includes(String(login)))
		return "qodo";
	if (["chatgpt-codex-connector[bot]", "chatgpt-codex-connector", "codex[bot]", "codex"].includes(String(login)))
		return "codex";
	if (["coderabbitai[bot]", "coderabbitai"].includes(String(login))) return "coderabbit";
	if (["cursor[bot]", "cursor"].includes(String(login))) return "cursor";
	if (["greptile-apps[bot]", "greptile-apps"].includes(String(login))) return "greptile";
	return undefined;
}
const NOT_COMPLETED =
	/^(?:(?:this |the )?review (?:was |is |has been )?)?(?:skipped|disabled|pending|queued|timed out|in progress|failed|currently processing new changes|bugbot (?:couldn['’]t|could not) run|quota(?:[- ]limited| exceeded| exhausted)|(?:usage|rate)[- ]limit(?:ed| (?:reached|exhausted|exceeded))?|out of (?:usage|credits)|unable to review|not (?:run|performed)|maximum number of reviews)(?=[ \t]*(?:$|[\r\n.!:])|[ \t]+(?:-[ \t]+)?(?:usage limit reached|in this PR|on this repository|please wait|try again)\b)/i;
const REVIEW_STATUS_NOTICE_MAX_LENGTH = 600;
const METADATA_TITLE =
	/^(?:(?:pr )?summary(?: by qodo)?|run configuration|walkthrough|review info|commits|files (?:selected for processing|ignored due to path filters)(?: \(\d+\))?)$/i;

/** Strip metadata blocks, not findings beside them or substantive details blocks. */
function reviewContent(body: string): { text: string; incomplete: boolean } {
	let text = body
		.replace(
			/<!-- (walkthrough|final_review_risk|pre_merge_checks_walkthrough|finishing_touch_checkbox|tips)_start -->[\s\S]*?<!-- \1_end -->/g,
			"",
		)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^\s*>\s?/gm, "");
	let depth = 0;
	let hiddenDepth: number | undefined;
	let start = 0;
	let content = "";
	const title = (value: string) =>
		value
			.replace(/<[^>]*>/g, "")
			.replace(/^[^a-z]+/i, "")
			.replace(/[\s#*_`]+$/, "")
			.trim();
	for (const tag of text.matchAll(/<\/?details\b[^>]*>/gi)) {
		if (!tag[0].startsWith("</")) {
			depth++;
			const summary = text.slice(tag.index + tag[0].length).match(/^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
			if (hiddenDepth === undefined && summary && METADATA_TITLE.test(title(summary[1]))) {
				content += text.slice(start, tag.index);
				hiddenDepth = depth;
			}
		} else {
			if (hiddenDepth === depth) {
				start = tag.index + tag[0].length;
				hiddenDepth = undefined;
			}
			depth = Math.max(0, depth - 1);
		}
	}
	text = content + (hiddenDepth === undefined ? text.slice(start) : "");
	let hiddenSection: number | undefined;
	const lines: string[] = [];
	for (const line of text
		.replace(
			/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
			(_: string, level: string, text: string) => `${"#".repeat(Number(level))} ${text}`,
		)
		.split("\n")) {
		const heading = line.match(/^\s*(#{1,6})\s+(.+)/);
		const level = heading?.[1].length ?? 1;
		if (heading && hiddenSection !== undefined && level <= hiddenSection) hiddenSection = undefined;
		if (METADATA_TITLE.test(title(heading?.[2] ?? line))) hiddenSection ??= level;
		if (hiddenSection === undefined) lines.push(line);
	}
	text = lines
		.join("\n")
		.replace(/<[^>]*>/g, "")
		.replace(/here are some automated review suggestions[^\n]*|[^\n]*tips about codex[\s\S]*/gi, "")
		.replace(/^[\s#*_>\-`]+$/gm, "")
		.trim();
	const notice = text.replace(/^(?:\[![A-Z]+\]\s*)?[\s#*_>\-`]+/, "");
	const incomplete = notice.length < REVIEW_STATUS_NOTICE_MAX_LENGTH && NOT_COMPLETED.test(notice);
	return { text: incomplete ? "" : text, incomplete };
}

/** Consume the existing helper's frozen schema. Check-run success is never a review. */
export function inspectOneironCorpus(
	text: string,
	expected: { repo: string; pr: number; head: string; base: string },
	decisionContext?: AdapterDecisionContext,
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
	const completed = new Set<OneironReviewer>();
	const postings = new Map<OneironReviewer, DecisionOf<"review_posting">>();
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
						reviewContent(comment.body).text.length >= 40,
				);
		const { text: content, incomplete } = reviewContent(body);
		const substantiveBody = content.length >= 40;
		if (
			isReview &&
			item.commit_id === expected.head &&
			["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].includes(String(item.state)) &&
			(substantiveBody || inline) &&
			!incomplete
		)
			completed.add(bot);
		const qodoFooter = `<!-- https://github.com/${expected.repo}/commit/${expected.head} -->`;
		if (
			bot === "qodo" &&
			item.sources.includes("issue_comment") &&
			body.includes("<h3>Code Review by Qodo</h3>") &&
			body.includes(qodoFooter) &&
			body.trim().length >= 100 &&
			substantiveBody &&
			!incomplete
		)
			completed.add(bot);
		const isComment = item.sources.some((source) =>
			["issue_comment", "review_comment", "review_thread_comment"].includes(String(source)),
		);
		if (decisionContext && (!postings.has(bot) || (!postings.get(bot)?.returned_comment_id && isComment)))
			postings.set(bot, {
				...decisionContext.base,
				type: "review_posting",
				reviewer: bot,
				request_command_exit: null,
				returned_comment_id:
					isComment && (typeof item.id === "string" || typeof item.id === "number") ? String(item.id) : null,
				url: typeof item.url === "string" && item.url.trim() ? item.url : null,
				posted_at:
					typeof item.created_at === "string" && Number.isFinite(Date.parse(item.created_at))
						? item.created_at
						: null,
				run_status: completed.has(bot) ? "completed_review_observed" : "incomplete_review_observed",
				status_check_vs_comment_contradiction: null,
				manual_request_exists: null,
				reason: `${bot}: observed frozen bot corpus; request-command success and manual request custody are not supplied`,
			});
		if (!content || item.in_reply_to_id) continue;
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
	for (const [bot, posting] of postings)
		decisionContext?.record({
			...posting,
			run_status: completed.has(bot) ? "completed_review_observed" : "incomplete_review_observed",
		});
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
