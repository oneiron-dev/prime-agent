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
	status?: string;
	conclusion?: string | null;
	event?: string;
	head_branch?: string;
	pull_requests?: Array<{ number: number }>;
};
type CheckSuite = { id: number; head_sha: string; created_at: string; app?: { id?: number; slug?: string } };
type WorkflowJob = {
	id: number;
	run_id: number;
	head_sha: string;
	name: string;
	status: string;
	conclusion: string | null;
	html_url?: string;
	check_run_url?: string;
	run_attempt?: number;
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

	async function generation() {
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
		return { runs, suites };
	}

	const initial = await generation();
	const previousRuns = new Map<number, WorkflowRun>();
	const suiteChecks = new Map<string, CheckRun[]>();
	const attemptJobs = new Map<string, WorkflowJob[]>();
	const selected = new Map<number, { old: WorkflowRun; run: WorkflowRun }>();
	const retained = new Map<number, number>();
	let pendingMissing = false;
	const pending = (name: string): RequiredCheckRow => {
		pendingMissing = true;
		return { name, bucket: "pending", state: "PENDING" };
	};
	const matches = (run: WorkflowRun, old: WorkflowRun) =>
		run.workflow_id === old.workflow_id &&
		run.event === old.event &&
		run.head_branch === old.head_branch &&
		(run.pull_requests?.length ? run.pull_requests.some((pull) => pull.number === pr) : true);
	// Only an unbound Actions suite can signal a newer Actions generation.
	// Missing or conflicting app identity cannot disprove that race.
	const unreconciled = (snapshot: Awaited<ReturnType<typeof generation>>, run: WorkflowRun) => {
		const chosenSuites = snapshot.suites.filter((suite) => suite.id === run.check_suite_id);
		if (chosenSuites.length !== 1) return true;
		const app = chosenSuites[0]?.app;
		if (!app || !Number.isSafeInteger(app.id) || !app.slug) return true;
		const boundSuites = new Set(snapshot.runs.map((listed) => listed.check_suite_id));
		return snapshot.suites.some(
			(suite) =>
				suite.id > run.check_suite_id &&
				Date.parse(suite.created_at) >= Date.parse(run.created_at) &&
				!boundSuites.has(suite.id) &&
				(!suite.app ||
					!Number.isSafeInteger(suite.app.id) ||
					!suite.app.slug ||
					suite.app.id === app.id ||
					suite.app.slug === app.slug),
		);
	};
	async function jobsFor(run: WorkflowRun, attempt: number): Promise<WorkflowJob[]> {
		const key = `${run.id}/${attempt}`;
		let jobs = attemptJobs.get(key);
		if (!jobs) {
			const listed = await getJson<{ total_count: number; jobs: WorkflowJob[] }>(
				gh,
				`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}`,
			);
			jobs = onePage(listed, listed.jobs, "rerun attempt jobs");
			if (
				jobs.some(
					(job) =>
						job.run_id !== run.id ||
						job.head_sha !== head ||
						(job.run_attempt !== undefined && job.run_attempt !== attempt),
				)
			)
				throw new Error("rerun attempt contains another workflow, head or attempt");
			attemptJobs.set(key, jobs);
		}
		return jobs;
	}
	async function latestJobsFor(run: WorkflowRun): Promise<WorkflowJob[]> {
		const listed = await getJson<{ total_count: number; jobs: WorkflowJob[] }>(
			gh,
			`repos/${repo}/actions/runs/${run.id}/jobs?per_page=${PAGE_SIZE}&filter=latest`,
		);
		const jobs = onePage(listed, listed.jobs, "latest workflow jobs");
		if (jobs.some((job) => job.run_id !== run.id || job.head_sha !== head))
			throw new Error("latest workflow jobs belong to another run or head");
		return jobs;
	}
	async function checksFor(suiteId: number, filter: "all" | "latest"): Promise<CheckRun[]> {
		const key = `${suiteId}/${filter}`;
		let checks = suiteChecks.get(key);
		if (!checks) {
			const listed = await getJson<{ total_count: number; check_runs: CheckRun[] }>(
				gh,
				`repos/${repo}/check-suites/${suiteId}/check-runs?per_page=${PAGE_SIZE}&filter=${filter}`,
			);
			checks = onePage(listed, listed.check_runs, "check runs");
			if (checks.some((check) => check.head_sha !== head)) throw new Error("check suite contains another head");
			suiteChecks.set(key, checks);
		}
		return checks;
	}
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
			const listed = latestWorkflow(initial.runs.filter((run) => matches(run, old)));
			const chosen = latestWorkflow([old, ...(listed ? [listed] : [])])!;
			if (!Number.isSafeInteger(chosen.check_suite_id)) throw new Error("latest workflow has no valid check suite");
			// Both the listing and detail must agree before a completed job can be trusted.
			const detail =
				chosen.id === oldId ? old : await getJson<WorkflowRun>(gh, `repos/${repo}/actions/runs/${chosen.id}`);
			if (
				!listed ||
				listed.id !== chosen.id ||
				(listed.run_attempt ?? 1) !== (chosen.run_attempt ?? 1) ||
				detail.id !== chosen.id ||
				detail.head_sha !== head ||
				!matches(detail, old) ||
				detail.check_suite_id !== chosen.check_suite_id ||
				(detail.run_attempt ?? 1) !== (chosen.run_attempt ?? 1)
			)
				return pending(row.name);
			selected.set(index, { old, run: detail });
			if (unreconciled(initial, detail)) return pending(row.name);
			if ((detail.run_attempt ?? 1) > 1) {
				const attempt = detail.run_attempt!;
				const jobs = await jobsFor(detail, attempt);
				const job = [...jobs].filter((candidate) => candidate.name === row.name).sort((a, b) => b.id - a.id)[0];
				if (job) return checkBucket({ ...job, details_url: job.html_url });
				// An attempt can carry a required job without re-executing it. The run's latest
				// job view must still expose that check as a job of this exact attempt.
				if (
					detail.status === "completed" &&
					detail.conclusion &&
					detail.conclusion !== "cancelled" &&
					jobs.length > 0 &&
					jobs.every((candidate) => candidate.status === "completed")
				) {
					const latestJobs = await latestJobsFor(detail);
					const matching = latestJobs.filter(
						(candidate) => candidate.name === row.name && candidate.run_attempt === attempt,
					);
					if (matching.length === 1) {
						const effectiveJob = matching[0]!;
						const result = checkBucket({ ...effectiveJob, details_url: effectiveJob.html_url });
						if (result.bucket === "pass" || result.bucket === "skipping") {
							const checks = await checksFor(detail.check_suite_id, "latest");
							const effective = checks.filter((check) => check.name === row.name);
							if (
								effective.length === 1 &&
								effective[0]!.id === effectiveJob.id &&
								effectiveJob.check_run_url ===
									`https://api.github.com/repos/${repo}/check-runs/${effectiveJob.id}` &&
								checkBucket(effective[0]!).bucket === result.bucket
							) {
								retained.set(index, effectiveJob.id);
								return result;
							}
						}
					}
				}
				return pending(row.name);
			}
			const checks = await checksFor(detail.check_suite_id, "all");
			const matching = checks.filter((check) => check.name === row.name);
			const newest = latest(
				matching.map((check) => ({ ...check, created_at: check.started_at ?? check.completed_at ?? "" })),
			);
			return newest ? checkBucket(newest) : pending(row.name);
		}),
	);
	// The next generation may appear while reading jobs. Never publish the older result in that case.
	const after = await generation();
	for (const [index, { old, run }] of selected) {
		const newest = latestWorkflow([old, ...after.runs.filter((candidate) => matches(candidate, old))])!;
		const detail = await getJson<WorkflowRun>(gh, `repos/${repo}/actions/runs/${run.id}`);
		if (
			newest.id > run.id ||
			(newest.id === run.id && (newest.run_attempt ?? 1) > (run.run_attempt ?? 1)) ||
			detail.id !== run.id ||
			detail.head_sha !== head ||
			!matches(detail, old) ||
			detail.check_suite_id !== run.check_suite_id ||
			(detail.run_attempt ?? 1) !== (run.run_attempt ?? 1) ||
			(retained.has(index) &&
				(detail.status !== "completed" || !detail.conclusion || detail.conclusion === "cancelled")) ||
			unreconciled(after, run)
		) {
			current[index] = pending(rows[index]!.name!);
			continue;
		}
		const retainedId = retained.get(index);
		if (retainedId !== undefined) {
			const latestJobs = await latestJobsFor(run);
			const currentJobs = latestJobs.filter(
				(job) => job.name === rows[index]!.name && job.run_attempt === run.run_attempt,
			);
			const listed = await getJson<{ total_count: number; check_runs: CheckRun[] }>(
				gh,
				`repos/${repo}/check-suites/${run.check_suite_id}/check-runs?per_page=${PAGE_SIZE}&filter=latest`,
			);
			const checks = onePage(listed, listed.check_runs, "latest check runs");
			const effective = checks.filter((check) => check.name === rows[index]!.name);
			if (
				currentJobs.length !== 1 ||
				currentJobs[0]!.id !== retainedId ||
				checks.some((check) => check.head_sha !== head) ||
				effective.length !== 1 ||
				effective[0]!.id !== retainedId ||
				checkBucket(effective[0]!).bucket !== current[index]!.bucket
			)
				current[index] = pending(rows[index]!.name!);
		}
	}
	return { rows: current, pendingMissing };
}
