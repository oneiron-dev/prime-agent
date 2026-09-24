/** Bot reviews on a pull request, read unfiltered through `gh api`. Qodo and Codex are the only reviewers waited for. */
export type OneironReviewer = "qodo" | "codex" | "coderabbit" | "cursor" | "greptile" | "other";
export const REQUIRED_REVIEWERS: readonly OneironReviewer[] = ["qodo", "codex"];

export interface OneironBotComment {
	id: string;
	reviewer: OneironReviewer;
	login: string;
	/** review: a PR review envelope; review_comment: an inline thread comment; issue_comment: a PR conversation comment. */
	source: "review" | "review_comment" | "issue_comment";
	body: string;
	commit: string | null;
	path: string | null;
	line: number | null;
	inReplyTo: string | null;
	url: string;
	createdAt: string;
	/** A skipped, rate-limited or in-progress notice rather than a review. */
	incomplete: boolean;
}
export interface OneironBotReport {
	head: string;
	comments: OneironBotComment[];
	/** Required reviewers that posted a substantive review or comment on the head. */
	completed: OneironReviewer[];
	/** Required reviewers whose latest word on this head is a terminal not-completed notice; pending is not one. */
	unavailable: OneironReviewer[];
}
export type GhJson = (args: string[]) => Promise<unknown>;

export function reviewerFromLogin(login: unknown): OneironReviewer | undefined {
	const name = String(login ?? "");
	if (/^qodo(?:-merge-pro|-code-review)?(?:\[bot\])?$/.test(name)) return "qodo";
	if (/^(?:chatgpt-codex-connector|codex)(?:\[bot\])?$/.test(name)) return "codex";
	if (/^coderabbitai(?:\[bot\])?$/.test(name)) return "coderabbit";
	if (/^cursor(?:\[bot\])?$/.test(name)) return "cursor";
	if (/^greptile-apps(?:\[bot\])?$/.test(name)) return "greptile";
	if (name.endsWith("[bot]")) return "other";
	return undefined;
}
const NOT_COMPLETED =
	/^(?:(?:this |the )?review (?:was |is |has been )?)?(?:skipped|disabled|pending|queued|timed out|in progress|failed|currently processing new changes|bugbot (?:couldn['’]t|could not) run|quota(?:[- ]limited| exceeded| exhausted)|(?:usage|rate)[- ]limit(?:ed| (?:reached|exhausted|exceeded))?|out of (?:usage|credits)|unable to review|not (?:run|performed)|maximum number of reviews)(?=[ \t]*(?:$|[\r\n.!:])|[ \t]+(?:-[ \t]+)?(?:usage limit reached|in this PR|on this repository|please wait|try again)\b)/i;
/** A notice the bot rewrites in place when it finishes: pending, never a terminal unavailable. */
const IN_PROGRESS =
	/^(?:(?:this |the )?review (?:was |is |has been )?)?(?:pending|queued|in progress|currently processing new changes)\b/i;
const REVIEW_STATUS_NOTICE_MAX_LENGTH = 600;
const METADATA_TITLE =
	/^(?:(?:pr )?summary(?: by qodo)?|run configuration|walkthrough|review info|commits|files (?:selected for processing|ignored due to path filters)(?: \(\d+\))?)$/i;

/** Strip metadata blocks, not findings beside them. Returns the substantive text and whether the body is only a status notice. */
export function reviewContent(body: string): { text: string; incomplete: boolean; unavailable: boolean } {
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
	return { text: incomplete ? "" : text, incomplete, unavailable: incomplete && !IN_PROGRESS.test(notice) };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function list(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record) : [];
}

/** Every bot comment on the pull request, in posting order, plus the required-reviewer completion on the head. */
export async function fetchOneironBotReviews(
	gh: GhJson,
	repo: string,
	pr: number,
	head: string,
	since?: string,
): Promise<OneironBotReport> {
	const [reviews, reviewComments, issueComments] = await Promise.all([
		gh(["api", "--paginate", `repos/${repo}/pulls/${pr}/reviews`]),
		gh(["api", "--paginate", `repos/${repo}/pulls/${pr}/comments`]),
		gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`]),
	]);
	const comments: OneironBotComment[] = [];
	const push = (item: Record<string, unknown>, source: OneironBotComment["source"]) => {
		const reviewer = reviewerFromLogin(record(item.user).login);
		if (!reviewer) return;
		const body = text(item.body);
		if (!body.trim() && source === "review") return;
		const commit = text(item.commit_id) || null;
		const createdAt = text(item.submitted_at) || text(item.created_at);
		comments.push({
			id: String(item.id ?? ""),
			reviewer,
			login: text(record(item.user).login),
			source,
			body,
			commit,
			path: text(item.path) || null,
			line:
				typeof item.line === "number"
					? item.line
					: typeof item.original_line === "number"
						? item.original_line
						: null,
			inReplyTo:
				item.in_reply_to_id === undefined || item.in_reply_to_id === null ? null : String(item.in_reply_to_id),
			url: text(item.html_url) || text(item.url),
			createdAt,
			incomplete: reviewContent(body).incomplete,
		});
	};
	for (const item of list(reviews)) push(item, "review");
	for (const item of list(reviewComments)) push(item, "review_comment");
	for (const item of list(issueComments)) push(item, "issue_comment");
	comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const onHead = (c: OneironBotComment) =>
		c.commit === head || (c.commit === null && (!since || c.createdAt >= since) && !c.inReplyTo);
	const completed: OneironReviewer[] = [];
	const unavailable: OneironReviewer[] = [];
	for (const reviewer of REQUIRED_REVIEWERS) {
		const own = comments.filter((c) => c.reviewer === reviewer && onHead(c));
		if (own.some((c) => !c.incomplete && reviewContent(c.body).text.length >= 40)) completed.push(reviewer);
		else if (own.length && reviewContent(own.at(-1)!.body).unavailable) unavailable.push(reviewer);
	}
	return { head, comments, completed, unavailable };
}
