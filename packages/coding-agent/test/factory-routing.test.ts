import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
	pinnedReviewTier,
	type ReviewTierFacts,
	type RoutingSeats,
	routeReviewTier,
	routeTrivialFix,
} from "../src/factory/routing.js";

const servers: Server[] = [];
async function serve(reply: (body: Record<string, unknown>) => unknown): Promise<string> {
	const server = createServer((request, response) => {
		let data = "";
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("end", () => {
			const value = reply(JSON.parse(data) as Record<string, unknown>);
			response.writeHead(value === undefined ? 500 : 200, { "Content-Type": "application/json" });
			response.end(JSON.stringify(value ?? { error: "down" }));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
});
const facts: ReviewTierFacts = {
	changed_files: 4,
	changed_lines: 120,
	hunks: 6,
	seams_touched: [],
	prior_bot_findings: 0,
	test_delta: { added: 1, removed: 0 },
	docs_only: false,
};

it("Jev decides above the band, the advisor takes the band, and nothing ever refuses", async () => {
	let confidence = 0.9;
	const jevUrl = await serve((body) => {
		const question = (body.questions as { q: { type: string } }).q;
		return {
			model: "jev-1.13.0",
			answers: {
				q:
					question.type === "choice"
						? { type: "choice", choice: "grok", confidence }
						: { type: "noul", noul: confidence },
			},
		};
	});
	const advisorUrl = await serve(() => ({
		model: "grok-4.6",
		choices: [
			{
				finish_reason: "stop",
				message: { content: JSON.stringify({ decision: "bots_only", confidence: 0.8, reason: "small" }) },
			},
		],
	}));
	const seats: RoutingSeats = { jevUrl, jevKey: "k", advisorUrl, advisorKey: "a", timeoutMs: 2000 };
	expect(await routeReviewTier({ ...facts, seams_touched: [] }, seats)).toMatchObject({
		choice: "grok",
		decided_by: "jev",
	});
	confidence = 0.5;
	expect(await routeReviewTier({ ...facts, seams_touched: [] }, seats)).toMatchObject({
		choice: "bots_only",
		decided_by: "advisor",
	});
	confidence = 0.9;
	expect(
		await routeTrivialFix(
			{ changed_files: 1, changed_lines: 3, hunks: 1, semantic_categories_touched: ["tests"], prior_rounds: 1 },
			seats,
		),
	).toMatchObject({ choice: "trivial", decided_by: "jev" });
	confidence = 0.1;
	expect(
		await routeTrivialFix(
			{ changed_files: 1, changed_lines: 3, hunks: 1, semantic_categories_touched: ["tests"], prior_rounds: 1 },
			seats,
		),
	).toMatchObject({ choice: "review_again", decided_by: "jev" });
	expect(await routeReviewTier({ ...facts, seams_touched: ["auth"] }, seats)).toMatchObject({
		choice: "grok_plus_opus",
		decided_by: "code",
	});
	expect(await routeReviewTier(facts, seats, "bots_only")).toMatchObject({ choice: "bots_only", decided_by: "code" });
	expect(
		await routeTrivialFix(
			{ changed_files: 1, changed_lines: 3, hunks: 1, semantic_categories_touched: ["logic"], prior_rounds: 1 },
			seats,
		),
	).toMatchObject({ choice: "review_again", decided_by: "code" });
	for (const server of servers.splice(0)) server.close();
	const dead = await routeReviewTier(facts, seats);
	expect(dead).toMatchObject({ choice: "grok", decided_by: "default" });
	expect(dead.reason).toMatch(/jev unavailable.*advisor unavailable/);
	expect(await routeReviewTier({ ...facts, changed_files: 1, changed_lines: 10 }, {})).toMatchObject({
		choice: "bots_only",
		decided_by: "default",
		reason: "jev unconfigured; advisor unconfigured",
	});
	expect(await routeReviewTier(facts, { jevKey: "k", jevUrl: "http://public.example.invalid" })).toMatchObject({
		decided_by: "default",
		reason: "jev unconfigured; advisor unconfigured",
	});
	expect(["one", "two", "three", "bots", "grok_plus_muse_plus_opus", "x"].map(pinnedReviewTier)).toEqual([
		"bots_only",
		"grok",
		"grok_plus_opus",
		"bots_only",
		"grok_plus_opus",
		undefined,
	]);
});
