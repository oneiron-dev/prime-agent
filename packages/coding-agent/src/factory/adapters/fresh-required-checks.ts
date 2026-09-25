/** The PR rollup can retain a failed job from an earlier run of the same head. */
export interface RequiredCheckRow {
	name?: string;
	bucket?: string;
	state?: string;
	link?: string;
}

export type GhResult = { code: number; output: string };
export type GhCall = (args: string[]) => Promise<GhResult>;

type WorkflowRun = {
	id: number;
	workflow_id: number;
	check_suite_id: number;
	head_sha: string;
	created_at: string;
	run_attempt?: number;
	event?: string;
	head_branch?: string;
	pull_requests?: Array<{ number: number }>;
};
type CheckSuite = { id: number; head_sha: string; created_at: string };
type WorkflowJob = {
	id: number;
	run_id: number;
	head_sha: string;
	name: string;
	status: string;
	conclusion: string | null;
	html_url?: string;
};
type CheckRun = {
	id: number;
	name: string;
	head_sha: string;
	status: string;
	conclusion: string | null;
	started_at?: string | null;
	completed_at?: string | null;
	details_url?: string;
};

const PAGE_SIZE = 100;
const SHA = /^[0-9a-f]{40}$/;

async function getJson<T>(gh: GhCall, path: string): Promise<T> {
	const args = ["api", "-X", "GET", path];
	const result = await gh(args);
	if (result.code !== 0) throw new Error(`cannot read GitHub checks (${path}): ${result.output.slice(-1000)}`);
	try {
		return JSON.parse(result.output) as T;
	} catch {
		throw new Error(`invalid GitHub checks JSON (${path})`);
	}
}

function onePage<T>(data: { total_count?: number }, rows: T[] | undefined, label: string): T[] {
	if (
		!Array.isArray(rows) ||
		!Number.isSafeInteger(data.total_count) ||
		data.total_count! > PAGE_SIZE ||
		rows.length !== data.total_count
	)
		throw new Error(`cannot establish complete ${label} (limit ${PAGE_SIZE})`);
	return rows;
}

function latest<T extends { id: number; created_at: string }>(rows: T[]): T | undefined {
	return [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
}

function latestWorkflow(runs: WorkflowRun[]): WorkflowRun | undefined {
	return [...runs].sort(
		(a, b) =>
			Date.parse(b.created_at) - Date.parse(a.created_at) ||
			b.id - a.id ||
			(b.run_attempt ?? 1) - (a.run_attempt ?? 1),
	)[0];
}

function checkBucket(run: CheckRun): RequiredCheckRow {
	const conclusion = run.conclusion?.toLowerCase();
	let bucket = "pending";
	if (run.status === "completed") {
		if (conclusion === "success" || conclusion === "neutral") bucket = "pass";
		else if (conclusion === "skipped") bucket = "skipping";
		else if (conclusion === "cancelled") bucket = "cancel";
		else if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(conclusion ?? ""))
			bucket = "fail";
	}
	return {
		name: run.name,
		bucket,
		state: run.status === "completed" ? (run.conclusion ?? "UNKNOWN").toUpperCase() : run.status.toUpperCase(),
		link: run.details_url,
	};
}

/**
 * Replace an Actions required check with the check from the newest workflow run at this exact SHA.
 * Missing jobs in that run are pending, even when the PR rollup still shows an older failure or success.
 * A bounded REST read fails closed rather than treating a truncated result as green.
 */
export async function freshRequiredChecks(
	gh: GhCall,
	repo: string,
	head: string,
	pr: number,
	rows: RequiredCheckRow[],
): Promise<{ rows: RequiredCheckRow[]; pendingMissing: boolean }> {
	if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || !SHA.test(head) || !Number.isSafeInteger(pr) || pr <= 0)
		throw new Error("invalid repository, head or pull request for required checks");
	if (!rows.length) return { rows, pendingMissing: false };
	const actions = rows.map((row) => {
		let url: URL;
		try {
			url = new URL(row.link ?? "");
		} catch {
			return undefined;
		}
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/);
		return url.hostname === "github.com" && match?.[1] === repo.split("/")[0] && match[2] === repo.split("/")[1]
			? Number(match[3])
			: undefined;
	});
	if (!actions.some((id) => id !== undefined)) return { rows, pendingMissing: false };

	const listedRuns = await getJson<{ total_count: number; workflow_runs: WorkflowRun[] }>(
		gh,
		`repos/${repo}/actions/runs?head_sha=${head}&per_page=${PAGE_SIZE}`,
	);
	const runs = onePage(listedRuns, listedRuns.workflow_runs, "workflow runs");
	const listedSuites = await getJson<{ total_count: number; check_suites: CheckSuite[] }>(
		gh,
		`repos/${repo}/commits/${head}/check-suites?per_page=${PAGE_SIZE}`,
	);
	const suites = onePage(listedSuites, listedSuites.check_suites, "check suites");
	if (runs.some((run) => run.head_sha !== head) || suites.some((suite) => suite.head_sha !== head))
		throw new Error("GitHub returned checks for another head");

	const previousRuns = new Map<number, WorkflowRun>();
	const suiteChecks = new Map<number, CheckRun[]>();
	const attemptJobs = new Map<string, WorkflowJob[]>();
	let pendingMissing = false;
	const current = await Promise.all(
		rows.map(async (row, index): Promise<RequiredCheckRow> => {
			const oldId = actions[index];
			if (oldId === undefined) return row;
			if (!row.name) throw new Error("required check has no name");
			let old = previousRuns.get(oldId);
			if (!old) {
				old = await getJson<WorkflowRun>(gh, `repos/${repo}/actions/runs/${oldId}`);
				if (
					old.id !== oldId ||
					old.head_sha !== head ||
					!Number.isSafeInteger(old.workflow_id) ||
					!Number.isSafeInteger(old.check_suite_id)
				)
					throw new Error(`cannot bind required check to exact workflow run ${oldId}`);
				previousRuns.set(oldId, old);
			}
			const matched = runs.filter(
				(run) =>
					run.workflow_id === old.workflow_id &&
					run.event === old.event &&
					run.head_branch === old.head_branch &&
					(run.pull_requests?.length ? run.pull_requests.some((pull) => pull.number === pr) : true),
			);
			// The old row may be visible before the workflow-run listing catches up. Never borrow its result.
			const chosen = latestWorkflow(matched);
			if (
				!chosen ||
				chosen.id < old.id ||
				(chosen.id === old.id && (chosen.run_attempt ?? 1) < (old.run_attempt ?? 1))
			)
				throw new Error(`cannot locate latest required workflow run ${old.workflow_id}`);
			if (!Number.isSafeInteger(chosen.check_suite_id)) throw new Error("latest workflow has no valid check suite");
			if (!suites.some((suite) => suite.id === chosen.check_suite_id)) {
				pendingMissing = true;
				return { name: row.name, bucket: "pending", state: "PENDING" };
			}
			// A rerun may reuse its suite. The attempt's job list excludes checks from earlier attempts.
			if ((chosen.run_attempt ?? 1) > 1) {
				const key = `${chosen.id}/${chosen.run_attempt}`;
				let jobs = attemptJobs.get(key);
				if (!jobs) {
					const listed = await getJson<{ total_count: number; jobs: WorkflowJob[] }>(
						gh,
						`repos/${repo}/actions/runs/${chosen.id}/attempts/${chosen.run_attempt}/jobs?per_page=${PAGE_SIZE}`,
					);
					jobs = onePage(listed, listed.jobs, "rerun attempt jobs");
					if (jobs.some((job) => job.run_id !== chosen.id || job.head_sha !== head))
						throw new Error("rerun attempt contains another workflow or head");
					attemptJobs.set(key, jobs);
				}
				const job = [...jobs].filter((candidate) => candidate.name === row.name).sort((a, b) => b.id - a.id)[0];
				if (!job) {
					pendingMissing = true;
					return { name: row.name, bucket: "pending", state: "PENDING" };
				}
				return checkBucket({ ...job, details_url: job.html_url });
			}
			let checks = suiteChecks.get(chosen.check_suite_id);
			if (!checks) {
				const listed = await getJson<{ total_count: number; check_runs: CheckRun[] }>(
					gh,
					`repos/${repo}/check-suites/${chosen.check_suite_id}/check-runs?per_page=${PAGE_SIZE}&filter=all`,
				);
				checks = onePage(listed, listed.check_runs, "check runs");
				if (checks.some((check) => check.head_sha !== head)) throw new Error("check suite contains another head");
				suiteChecks.set(chosen.check_suite_id, checks);
			}
			const matching = checks.filter((check) => check.name === row.name);
			const newest = latest(
				matching.map((check) => ({ ...check, created_at: check.started_at ?? check.completed_at ?? "" })),
			);
			if (!newest) {
				pendingMissing = true;
				return { name: row.name, bucket: "pending", state: "PENDING" };
			}
			return checkBucket(newest);
		}),
	);
	return { rows: current, pendingMissing };
}
