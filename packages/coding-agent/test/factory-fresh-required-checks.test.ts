import { describe, expect, it } from "vitest";
import { freshRequiredChecks, type GhCall } from "../src/factory/adapters/fresh-required-checks.js";

const head = "a".repeat(40);
const stale = {
	name: "Test",
	bucket: "fail",
	state: "FAILURE",
	link: "https://github.com/org/repo/actions/runs/1/job/11",
};
const old = {
	id: 1,
	workflow_id: 50,
	check_suite_id: 101,
	head_sha: head,
	created_at: "2026-09-24T00:00:00Z",
	event: "pull_request",
	head_branch: "branch",
};
const fresh = {
	...old,
	id: 2,
	check_suite_id: 102,
	created_at: "2026-09-25T00:00:00Z",
	pull_requests: [{ number: 7 }],
};
const other = { ...fresh, id: 3, workflow_id: 51, check_suite_id: 103, created_at: "2026-09-25T01:00:00Z" };

function fixture() {
	const calls: string[] = [];
	const state = {
		runs: [old, fresh, other] as Array<
			typeof old & { run_attempt?: number; pull_requests?: Array<{ number: number }> }
		>,
		suites: [101, 102, 103],
		checks: [] as object[],
		attemptJobs: [] as object[],
		status: 0,
	};
	const gh: GhCall = async (args) => {
		const path = args[3]!;
		calls.push(path);
		if (state.status) return { code: state.status, output: "API unavailable" };
		let response: unknown;
		if (path === "repos/org/repo/actions/runs/1") response = old;
		else if (path.startsWith("repos/org/repo/actions/runs?"))
			response = { total_count: state.runs.length, workflow_runs: state.runs };
		else if (path.startsWith(`repos/org/repo/commits/${head}/check-suites?`))
			response = {
				total_count: state.suites.length,
				check_suites: state.suites.map((id) => ({ id, head_sha: head, created_at: fresh.created_at })),
			};
		else if (path.includes("/check-suites/102/check-runs?"))
			response = { total_count: state.checks.length, check_runs: state.checks };
		else if (path.includes("/actions/runs/2/attempts/2/jobs?"))
			response = { total_count: state.attemptJobs.length, jobs: state.attemptJobs };
		else throw new Error(`unexpected GitHub API call: ${path}`);
		return { code: 0, output: JSON.stringify(response) };
	};
	return { state, gh, calls };
}

describe("fresh required checks", () => {
	it("ignores a stale failure while the newest exact-head workflow suite has not created its required job", async () => {
		const f = fixture();
		const read = () => freshRequiredChecks(f.gh, "org/repo", head, 7, [stale]);
		const missing = await read();
		expect(missing).toMatchObject({ pendingMissing: true, rows: [{ name: "Test", bucket: "pending" }] });
		expect(f.calls.some((call) => call.includes("check-suites/102/check-runs"))).toBe(true);
		f.state.checks.push({ id: 1001, name: "Test", head_sha: head, status: "in_progress", conclusion: null });
		expect((await read()).rows[0]?.bucket).toBe("pending");
		f.state.checks.push({ id: 1002, name: "Test", head_sha: head, status: "completed", conclusion: "success" });
		expect(await read()).toMatchObject({ pendingMissing: false, rows: [{ bucket: "pass" }] });
		f.state.checks.push({ id: 1003, name: "Test", head_sha: head, status: "completed", conclusion: "failure" });
		expect((await read()).rows[0]?.bucket).toBe("fail");
	});

	it("ignores checks from an earlier attempt when a run reuses its suite", async () => {
		const f = fixture();
		f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
		f.state.checks.push({ id: 1001, name: "Test", head_sha: head, status: "completed", conclusion: "failure" });
		const read = () => freshRequiredChecks(f.gh, "org/repo", head, 7, [stale]);
		expect(await read()).toMatchObject({ pendingMissing: true, rows: [{ bucket: "pending" }] });
		f.state.attemptJobs.push({
			id: 1002,
			run_id: 2,
			head_sha: head,
			name: "Test",
			status: "completed",
			conclusion: "success",
		});
		expect(await read()).toMatchObject({ pendingMissing: false, rows: [{ bucket: "pass" }] });
	});

	it("fails closed on incomplete or failing API reads, not stale success", async () => {
		const f = fixture();
		f.state.runs = [old, fresh, other];
		f.state.status = 1;
		await expect(freshRequiredChecks(f.gh, "org/repo", head, 7, [{ ...stale, bucket: "pass" }])).rejects.toThrow(
			"API unavailable",
		);
		f.state.status = 0;
		f.state.suites = Array.from({ length: 101 }, (_, i) => i + 1);
		await expect(freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).rejects.toThrow("limit 100");
	});
});
