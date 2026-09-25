import { readFileSync } from "node:fs";
import { expect, it, test } from "vitest";
import {
	fetchOneironBotReviews,
	type OneironReviewer,
	reviewContent,
	reviewerFromLogin,
} from "../src/factory/adapters/oneiron-review.js";

const bodies: { name: string; login: string; reviewer: OneironReviewer; body: string; completed: boolean }[] =
	JSON.parse(readFileSync(new URL("./fixtures/factory-oneiron/review-bodies.json", import.meta.url), "utf8"));

test.each(bodies)("classifies $name by login, status notice and substance", ({ login, reviewer, body, completed }) => {
	expect(reviewerFromLogin(login)).toBe(reviewer);
	const content = reviewContent(body);
	expect(!content.incomplete && content.text.length >= 40).toBe(completed);
});

it("reads every bot comment unfiltered and settles only on Qodo and Codex", async () => {
	const head = "a".repeat(40);
	const long = "Failed authentication requests bypass the retry limit and overwhelm the server; bound the retries.";
	const calls: string[] = [];
	const gh = async (args: string[]) => {
		calls.push(args.join(" "));
		const url = args.at(-1)!;
		if (url.endsWith("/reviews"))
			return [
				{
					id: 1,
					user: { login: "qodo-code-review[bot]" },
					body: long,
					state: "COMMENTED",
					commit_id: head,
					submitted_at: "2026-09-19T01:00:00Z",
				},
				{
					id: 2,
					user: { login: "chatgpt-codex-connector[bot]" },
					body: "Review skipped",
					state: "COMMENTED",
					commit_id: head,
					submitted_at: "2026-09-19T01:00:01Z",
				},
				{
					id: 3,
					user: { login: "coderabbitai[bot]" },
					body: long,
					state: "COMMENTED",
					commit_id: "b".repeat(40),
					submitted_at: "2026-09-19T00:00:00Z",
				},
				{
					id: 4,
					user: { login: "human" },
					body: long,
					state: "APPROVED",
					commit_id: head,
					submitted_at: "2026-09-19T01:00:02Z",
				},
			];
		if (url.endsWith("/pulls/5/comments"))
			return [
				{
					id: 11,
					user: { login: "greptile-apps[bot]" },
					body: "Off by one here.",
					path: "src/a.rs",
					line: 4,
					created_at: "2026-09-19T01:00:03Z",
					html_url: "u",
				},
			];
		return [
			{
				id: 21,
				user: { login: "some-other[bot]" },
				body: "Bugbot couldn't run - usage limit reached",
				created_at: "2026-09-19T01:00:04Z",
			},
		];
	};
	const report = await fetchOneironBotReviews(gh, "org/repo", 5, head, "2026-09-19T00:30:00Z");
	expect(calls).toEqual([
		"api --paginate repos/org/repo/pulls/5/reviews",
		"api --paginate repos/org/repo/pulls/5/comments",
		"api --paginate repos/org/repo/issues/5/comments",
	]);
	expect(report.comments.map((c) => [c.reviewer, c.source, c.incomplete])).toEqual([
		["coderabbit", "review", false],
		["qodo", "review", false],
		["codex", "review", true],
		["greptile", "review_comment", false],
		["other", "issue_comment", true],
	]);
	expect(report.completed).toEqual(["qodo"]);
	expect(report.unavailable).toEqual(["codex"]);
	// Qodo rewrites its in-progress post in place: pending is waited for, never counted unavailable.
	expect(["Review in progress", "Review skipped"].map((body) => reviewContent(body).unavailable)).toEqual([
		false,
		true,
	]);
});
