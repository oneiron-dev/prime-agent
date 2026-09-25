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

function job(id: number, name: string, conclusion: string) {
	return {
		id,
		run_id: 2,
		head_sha: head,
		name,
		status: "completed",
		conclusion,
		check_run_url: `https://api.github.com/repos/org/repo/check-runs/${id}`,
	};
}

function fixture() {
	const calls: string[] = [];
	const state = {
		runs: [old, fresh, other] as Array<
			typeof old & { run_attempt?: number; pull_requests?: Array<{ number: number }> }
		>,
		suites: [101, 102, 103],
		externalSuites: [] as Array<{
			id: number;
			head_sha: string;
			created_at: string;
			app?: { id?: number; slug?: string };
		}>,
		checks: [] as object[],
		latestChecks: [] as object[],
		latestJobs: [] as object[],
		attemptJobs: [] as object[],
		detail: undefined as (typeof fresh & { run_attempt?: number; status?: string; conclusion?: string }) | undefined,
		status: 0,
		onRead: (_path: string) => {},
	};
	const gh: GhCall = async (args) => {
		const path = args[3]!;
		calls.push(path);
		state.onRead(path);
		if (state.status) return { code: state.status, output: "API unavailable" };
		let response: unknown;
		if (path === "repos/org/repo/actions/runs/1") response = state.runs.find((run) => run.id === 1) ?? old;
		else if (path === "repos/org/repo/actions/runs/2")
			response = state.detail ?? state.runs.find((run) => run.id === 2) ?? fresh;
		else if (path.startsWith("repos/org/repo/actions/runs/2/jobs?"))
			response = { total_count: state.latestJobs.length, jobs: state.latestJobs };
		else if (path.startsWith("repos/org/repo/actions/runs?"))
			response = { total_count: state.runs.length, workflow_runs: state.runs };
		else if (path.startsWith(`repos/org/repo/commits/${head}/check-suites?`))
			response = {
				total_count: state.suites.length + state.externalSuites.length,
				check_suites: [
					...state.suites.map((id) => ({
						id,
						head_sha: head,
						created_at: fresh.created_at,
						app: { id: 15368, slug: "github-actions" },
					})),
					...state.externalSuites,
				],
			};
		else if (path.includes("/check-suites/102/check-runs?")) {
			const checks = path.includes("filter=latest") ? state.latestChecks : state.checks;
			response = { total_count: checks.length, check_runs: checks };
		} else if (path.includes("/actions/runs/2/attempts/2/jobs?"))
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

	it.each(["pass", "fail"] as const)(
		"holds superseded %s while run and suite lists interleave or lag",
		async (bucket) => {
			for (const interleaved of [false, true]) {
				const f = fixture();
				f.state.checks.push({ id: 1002, name: "Test", head_sha: head, status: "completed", conclusion: "success" });
				const next = { ...fresh, id: 4, check_suite_id: 104, created_at: "2026-09-26T00:00:00Z" };
				const advance = () => {
					f.state.runs = [old, fresh, other, next];
					f.state.suites.push(104);
				};
				if (interleaved)
					f.state.onRead = (path) => {
						if (path.includes("check-suites/102/check-runs?")) advance();
					};
				else f.state.suites.push(104); // The suite appeared, but the run list still lags.
				expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [{ ...stale, bucket }])).toMatchObject({
					pendingMissing: true,
					rows: [{ bucket: "pending" }],
				});
			}
		},
	);

	it.each([
		[{ id: 900, slug: "qodo" }, "pass"],
		[undefined, "pending"],
		[{ id: 900, slug: "github-actions" }, "pending"],
	] as const)(
		"distinguishes a newer external suite from missing or ambiguous app identity (%s)",
		async (app, bucket) => {
			const f = fixture();
			f.state.externalSuites.push({ id: 104, head_sha: head, created_at: fresh.created_at, app });
			f.state.checks.push({ id: 1002, name: "Test", head_sha: head, status: "completed", conclusion: "success" });
			expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
				pendingMissing: bucket === "pending",
				rows: [{ bucket }],
			});
		},
	);

	it("holds an attempt exposed by run detail before its listing catches up", async () => {
		const f = fixture();
		f.state.detail = { ...fresh, run_attempt: 2, status: "in_progress" };
		expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
			pendingMissing: true,
			rows: [{ bucket: "pending" }],
		});
	});

	it("holds a listed attempt when its direct detail still lags", async () => {
		const f = fixture();
		f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
		f.state.detail = { ...fresh, run_attempt: 1 };
		f.state.checks.push({ id: 1002, name: "Test", head_sha: head, status: "completed", conclusion: "success" });
		expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
			pendingMissing: true,
			rows: [{ bucket: "pending" }],
		});
	});

	it("rechecks the run attempt after reading successful jobs", async () => {
		const f = fixture();
		f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
		f.state.detail = { ...fresh, run_attempt: 2 };
		f.state.attemptJobs.push({
			id: 1002,
			run_id: 2,
			head_sha: head,
			name: "Test",
			status: "completed",
			conclusion: "success",
		});
		f.state.onRead = (path) => {
			if (path.includes("attempts/2/jobs?")) f.state.detail = { ...fresh, run_attempt: 3 };
		};
		expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
			pendingMissing: true,
			rows: [{ bucket: "pending" }],
		});
	});

	it.each([
		["success", "success", true, 1003, "pass"],
		["success", "skipped", true, 1003, "skipping"],
		["in_progress", "success", true, 1001, "pending"],
		["failure", "success", true, 1001, "pending"],
		["cancelled", "skipped", true, 1001, "pending"],
		["success", "success", false, 1001, "pending"],
		["success", "success", true, undefined, "pending"],
		["success", "success", true, 9999, "pending"],
		["success", "failure", true, 1001, "pending"],
	] as const)(
		"retains an earlier %s rerun job only with complete current jobs and exact effective %s check (%s, %s)",
		async (conclusion, previousConclusion, currentJobs, effectiveId, bucket) => {
			const f = fixture();
			f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
			f.state.detail = {
				...fresh,
				run_attempt: 2,
				status: conclusion === "in_progress" ? conclusion : "completed",
				conclusion,
			};
			if (currentJobs)
				f.state.attemptJobs = [
					{ id: 1002, run_id: 2, head_sha: head, name: "Other", status: "completed", conclusion },
				];
			f.state.latestJobs = [
				{
					...job(conclusion === "failure" || conclusion === "cancelled" ? 1001 : 1003, "Test", previousConclusion),
					run_attempt: conclusion === "failure" || conclusion === "cancelled" ? 1 : 2,
				},
				...f.state.attemptJobs,
			];
			if (effectiveId)
				f.state.latestChecks = [
					{ id: effectiveId, name: "Test", head_sha: head, status: "completed", conclusion: previousConclusion },
				];
			expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
				pendingMissing: bucket === "pending",
				rows: [{ bucket }],
			});
		},
	);

	it("holds a retained success when the effective check changes during the final generation read", async () => {
		const f = fixture();
		f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
		f.state.detail = { ...fresh, run_attempt: 2, status: "completed", conclusion: "success" };
		f.state.attemptJobs = [
			{ id: 1002, run_id: 2, head_sha: head, name: "Other", status: "completed", conclusion: "success" },
		];
		f.state.latestJobs = [{ ...job(1003, "Test", "success"), run_attempt: 2 }, ...f.state.attemptJobs];
		f.state.latestChecks = [{ id: 1003, name: "Test", head_sha: head, status: "completed", conclusion: "success" }];
		let reads = 0;
		f.state.onRead = (path) => {
			if (path.includes("/check-suites?") && ++reads === 2) f.state.latestChecks = [];
		};
		expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
			pendingMissing: true,
			rows: [{ bucket: "pending" }],
		});
	});

	it.each(["success", "skipped"] as const)(
		"retains required %s when a separately rerun optional job fails",
		async (conclusion) => {
			const f = fixture();
			f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
			f.state.detail = { ...fresh, run_attempt: 2, status: "completed", conclusion: "failure" };
			f.state.attemptJobs = [{ ...job(1002, "Other", "failure"), run_attempt: 2 }];
			f.state.latestJobs = [{ ...job(1003, "Test", conclusion), run_attempt: 2 }, ...f.state.attemptJobs];
			f.state.latestChecks = [{ id: 1003, name: "Test", head_sha: head, status: "completed", conclusion }];
			expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
				pendingMissing: false,
				rows: [{ bucket: conclusion === "skipped" ? "skipping" : "pass" }],
			});
		},
	);

	it("does not inherit a prior green from a failed full rerun whose current Test is missing", async () => {
		const f = fixture();
		f.state.runs = [old, { ...fresh, run_attempt: 2 }, other];
		f.state.detail = { ...fresh, run_attempt: 2, status: "completed", conclusion: "failure" };
		f.state.attemptJobs = [{ ...job(1002, "Other", "failure"), run_attempt: 2 }];
		f.state.latestJobs = [{ ...job(1001, "Test", "success"), run_attempt: 1 }, ...f.state.attemptJobs];
		f.state.latestChecks = [{ id: 1001, name: "Test", head_sha: head, status: "completed", conclusion: "success" }];
		expect(await freshRequiredChecks(f.gh, "org/repo", head, 7, [stale])).toMatchObject({
			pendingMissing: true,
			rows: [{ bucket: "pending" }],
		});
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
