import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import {
	acquireSlot,
	INITIATIVE_LINES,
	OneironTicketRunner,
	SEAT_POLICY_LINE,
	WRITER_LINES,
} from "../src/adapters/oneiron-ticket.js";
import type { OneironLauncherSettings, OneironTicketRun } from "../src/adapters/oneiron-settings.js";
import { SEAT_IDLE_EXIT_CODE } from "../src/adapters/seat-process.js";
import { getProcessStartId } from "../src/process-identity.js";
import { factoryCargoBinDirectory } from "../src/runtime.js";

const roots: string[] = [];
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const root = process.env.FAKE_ROOT, args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "gh.log"), args.join(" ") + "\\n");
const statePath = path.join(root, "gh-state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { prs: {}, next: 7 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const [group, verb, target] = args;
const long = "This handler ignores the usage limit returned by the provider and retries forever, so a throttled tenant will spin until the process is killed. Bound the retries.";
if (group === "pr" && verb === "view") {
  const pr = state.prs[target];
  if (!pr) { process.stderr.write("no pull requests found"); process.exit(1); }
  const remote = (ref) => require("node:child_process").execFileSync("git", ["ls-remote", "origin", "refs/heads/" + ref], { encoding: "utf8" }).split(/\\s+/)[0];
  // state.lag: that many head reads still show a stale head, as the API does right after a push.
  const stale = state.lag > 0 && (args[args.indexOf("--json") + 1] || "").includes("headRefOid");
  if (stale) { state.lag--; save(); }
  out({ number: pr.number, url: "https://github.com/org/repo/pull/" + pr.number, state: pr.merged ? "MERGED" : "OPEN", mergedAt: pr.merged ? "2026-09-19T00:00:00Z" : null,
    headRefOid: stale ? "0".repeat(40) : remote(pr.branch), baseRefName: "main", baseRefOid: state.baseOid ?? remote("main"), mergeable: state.mergeable ?? "MERGEABLE", mergeStateStatus: state.mergeStateStatus ?? "CLEAN" });
} else if (group === "pr" && verb === "checks") {
  if (state.checksText) { process.stderr.write(state.checksText); process.exit(1); }
  out(JSON.stringify(state.checks ?? []));
} else if (group === "pr" && verb === "create") {
  const head = args[args.indexOf("--head") + 1];
  const pr = { number: state.next++, merged: false, branch: head };
  state.prs[head] = pr; state.prs[String(pr.number)] = pr; save();
  out("https://github.com/org/repo/pull/" + pr.number + "\\n");
} else if (group === "pr" && verb === "merge") {
  const pr = state.prs[target]; pr.merged = true; save(); out("merged\\n");
} else if (group === "stack" && verb === "submit") {
  const branch = require("node:child_process").execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const pr = { number: state.next++, merged: false, branch };
  state.prs[branch] = pr; state.prs[String(pr.number)] = pr; save(); out("submitted\\n");
} else if (group === "stack" && verb === "view") {
  out({ trunk: "main", branches: Object.values(state.prs).filter((p, i, a) => a.findIndex((q) => q.number === p.number) === i).map((p) => ({ name: p.branch, pr: { number: p.number } })) });
} else if (group === "stack" && verb === "merge") {
  for (const pr of Object.values(state.prs)) pr.merged = true;
  save(); out("merged\\n");
} else if (group === "api") {
  const url = args[args.length - 1];
  if (url.includes("/pulls/") && url.endsWith("/reviews")) out([
    { id: 1, user: { login: "qodo-code-review[bot]" }, body: long, state: "COMMENTED", submitted_at: "2999-01-01T00:00:00Z" },
    { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body: long, state: "COMMENTED", submitted_at: "2999-01-01T00:00:01Z" },
    { id: 3, user: { login: "cursor[bot]" }, body: "Bugbot couldn't run - usage limit reached", state: "COMMENTED", submitted_at: "2999-01-01T00:00:02Z" },
  ]);
  else if (url.includes("/pulls/") && url.endsWith("/comments")) out([
    { id: 11, user: { login: "qodo-code-review[bot]" }, body: "Consider bounding this retry loop.", path: "crates/alpha/src/lib.rs", line: 2, created_at: "2999-01-01T00:00:03Z", html_url: "https://github.com/org/repo/pull/7#discussion_r11" },
  ]);
  else out([]);
} else out("ok\\n");
`;
const FAKE_CARGO = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(path.join(process.env.FAKE_ROOT, "cargo.log"), process.argv.slice(2).join(" ") + " target=" + process.env.CARGO_TARGET_DIR + "\\n");
process.stdout.write("running 3 tests\\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\\n");
`;
const FAKE_SEAT = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process"), fs = require("node:fs"), path = require("node:path");
const prompt = process.argv[process.argv.length - 1];
fs.appendFileSync(path.join(process.env.FAKE_ROOT, "seat.log"), "---\\n" + prompt + "\\n");
const key = (prompt.match(/Ticket ([-\\w.]+):/) || prompt.match(/ticket ([-\\w.]+)/))[1];
if (prompt.includes("build the context pack")) process.stdout.write("PACK: crates/alpha/src/lib.rs:1 add_one\\n");
else if (prompt.includes("Review this diff")) process.stdout.write(fs.existsSync(path.join(process.env.FAKE_ROOT, "defects")) ? "VERDICT: DEFECTS\\ndocs/x.md:1 wrong\\n" : "VERDICT: LANDABLE\\n");
else if (prompt.includes("EVERY bot comment")) process.stdout.write("replied to 11 and posted the summary\\nDONE " + key + "\\n");
else if (prompt.includes("docs only")) {
  fs.mkdirSync("docs", { recursive: true }); fs.writeFileSync("docs/" + key + ".md", "note\\n");
  execFileSync("git", ["add", "-A"]); execFileSync("git", ["commit", "-qm", key + ": note"]);
  process.stdout.write("Documented.\\nDONE " + key + "\\n");
} else {
  fs.appendFileSync("crates/alpha/src/lib.rs", "pub fn " + key.replace(/[^a-z0-9]/g, "_") + "() -> u8 { 1 }\\n");
  execFileSync("git", ["add", "-A"]); execFileSync("git", ["commit", "-qm", key + ": implement"]);
  process.stdout.write("Implemented.\\nPR BODY:\\nAdded the function.\\nSPLIT: the follow-up half\\nDONE " + key + "\\n");
}
`;
/** Print mode with a session directory: a review answers with progress first and its verdict only when continued. */
const FAKE_PRIME = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const input = fs.readFileSync(0, "utf8"), argv = process.argv.slice(2);
const dir = argv.includes("--session-dir") ? argv[argv.indexOf("--session-dir") + 1] : undefined;
if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, "session.jsonl"), "{}\\n"); }
fs.appendFileSync(path.join(process.env.FAKE_ROOT, "prime.log"), (argv.includes("-c") ? "continue " : "open ") + input.slice(0, 20) + (input.includes("owner note") ? " +note" : "") + "\\n");
if (input.startsWith("register")) fs.writeFileSync(path.join(process.env.FAKE_ROOT, "writer-prompt"), input);
const text = input.startsWith("Continue this SAME review") ? "Checked every hunk.\\nVERDICT: LANDABLE"
  : input.startsWith("finish") ? "Finished.\\nDONE note-one"
  : input.startsWith("register") ? (fs.mkdirSync(path.dirname(process.env.PENDING_PATH), { recursive: true }), fs.writeFileSync(process.env.PENDING_PATH, process.env.PENDING_JSON), "Validation started.\\nDONE wait-one")
  : input.includes("Registered validation job-00001") ? "Validation passed.\\nDONE wait-one"
  : input.startsWith("Review this diff") ? "Reviewers are still running; VERDICT: LANDABLE is likely."
  : "argv " + argv.includes(input) + " stdin " + input.length;
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
say({ type: "agent_start" });
say({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
say({ type: "agent_end" });
`;

function setup() {
	const root = mkdtempSync(join(tmpdir(), "factory-ticket-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	for (const [name, source] of [
		["gh", FAKE_GH],
		["cargo", FAKE_CARGO],
	] as const)
		writeFileSync(join(bin, name), source, { mode: 0o755 });
	writeFileSync(join(root, "seat.js"), FAKE_SEAT);
	writeFileSync(join(root, "prime.js"), FAKE_PRIME);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		FAKE_ROOT: root,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = (args: string[], cwd: string) =>
		execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const origin = join(root, "origin.git");
	git(["init", "-q", "--bare", "-b", "main", origin], root);
	const repo = join(root, "oneiron");
	git(["clone", "-q", origin, repo], root);
	mkdirSync(join(repo, "crates", "alpha", "src"), { recursive: true });
	writeFileSync(join(repo, "crates", "alpha", "Cargo.toml"), '[package]\nname = "alpha"\nversion = "0.1.0"\n');
	writeFileSync(join(repo, "crates", "alpha", "src", "lib.rs"), "pub fn add_one(x: u8) -> u8 { x + 1 }\n");
	git(["add", "-A"], repo);
	git(["commit", "-qm", "initial"], repo);
	git(["push", "-q", "-u", "origin", "main"], repo);
	const work = join(root, "work");
	const seat = { command: [process.execPath, join(root, "seat.js")] };
	const launcher: OneironLauncherSettings = {
		host: "local",
		repo,
		work,
		githubRepo: "org/repo",
		diskFloorGiB: 0,
		seats: { writer: seat, pack: seat, grok: seat, opus: seat },
		idleMs: 60_000,
		timeouts: { ghMs: 60_000, botsMs: 0 },
	};
	const ticket = (key: string, blockedBy: string[] = []): OneironTicketRun => ({
		version: 1,
		key,
		title: `Ticket ${key}`,
		contract: `Add ${key} to alpha.`,
		acceptance: "A unit test covers it.",
		row: "OF-1",
		blockedBy,
		launcher,
	});
	return { root, env, git, repo, work, launcher, ticket };
}
/** The built Rust binary the custody verifier runs (e.g. `target/debug/prime-agent`); unset skips it. */
const BUILT_AGENT = process.env.PRIME_AGENT_TEST_BINARY;
/** Sandbox daemon sockets the built-binary verifier may have started; each test's daemon stops before its root goes. */
const daemonSockets: string[] = [];
const envelope = (id: string, command: object) =>
	`${JSON.stringify({ type: "command", id, protocol: { name: "prime-agent.daemon", version: 7 }, command })}\n`;

/** One command over a sandbox daemon's socket: the daemon's hello and the command's response. */
function daemonRequest(
	socket: string,
	command: object,
): Promise<{ hello: Record<string, unknown>; response: { success: boolean; data: Record<string, unknown> } }> {
	return new Promise((resolve, reject) => {
		const client = createConnection(socket);
		let buffer = "";
		let hello: Record<string, unknown> | undefined;
		client.on("error", reject);
		client.on("close", () => reject(new Error(`the daemon closed before answering ${JSON.stringify(command)}`)));
		client.on("data", (chunk) => {
			buffer += chunk.toString();
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const frame = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (!hello) {
					hello = frame;
					client.write(envelope("verify-1", command));
				} else if (frame.type === "response" && frame.id === "verify-1") {
					client.end();
					resolve({ hello, response: frame });
				}
			}
		});
	});
}

/** Force-stop a sandbox daemon over its own socket, then wait for its supervisor process to exit. */
async function stopSandboxDaemon(socket: string): Promise<void> {
	if (!existsSync(socket)) return;
	const pid = await new Promise<number | undefined>((resolve) => {
		const client = createConnection(socket);
		let buffer = "";
		let pid: number | undefined;
		client.on("error", () => resolve(pid));
		// The supervisor closes the connection once its stop pass starts.
		client.on("close", () => resolve(pid));
		client.on("data", (chunk) => {
			buffer += chunk.toString();
			if (pid === undefined && buffer.includes("\n")) {
				pid = Number(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))).supervisorPid);
				client.write(envelope("stop", { type: "shutdown", force: true }));
			}
		});
	});
	if (pid === undefined) return;
	// `tail --pid` returns when the supervisor exits; the timeout is a failure bound only.
	const waited = spawnSync("tail", [`--pid=${pid}`, "-f", "/dev/null"], { timeout: 60_000 });
	if (waited.status !== 0) {
		process.kill(pid, "SIGKILL");
		throw new Error(`the sandbox daemon ${pid} outlived its shutdown and was killed`);
	}
}

afterEach(async () => {
	for (const socket of daemonSockets.splice(0)) await stopSandboxDaemon(socket);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Oneiron ticket runner", () => {
	it("runs one ticket from worktree to merge and stacks a child on its submitted parent", async () => {
		const f = setup();
		// The grok reviewer is a print-mode seat whose first reply is progress, not a verdict.
		const first = f.ticket("alpha-one");
		first.launcher = {
			...f.launcher,
			seats: { ...f.launcher.seats, grok: { provider: "p", model: "m", thinking: "low" } },
		};
		const alpha = new OneironTicketRunner(first, {
			env: f.env,
			routing: {},
			agentArgv: [process.execPath, join(f.root, "prime.js")],
		});
		await alpha.submit();
		expect(f.git(["rev-parse", "--abbrev-ref", "HEAD"], alpha.worktree)).toBe("w7/alpha-one");
		expect(alpha.state.base).toBe("origin/main");
		expect(readFileSync(join(alpha.worktree, ".w7", "CONTEXT.md"), "utf8")).toContain("PACK:");
		expect(alpha.state.writer?.final).toContain("DONE alpha-one");
		expect(JSON.parse(readFileSync(join(alpha.directory, "split.json"), "utf8")).remains).toBe("the follow-up half");
		const cargo = readFileSync(join(f.root, "cargo.log"), "utf8");
		expect(cargo).toContain("test --no-fail-fast -p alpha");
		expect(cargo).toContain(`target=${join(f.work, "target", "alpha-one")}`);
		expect(alpha.state.tests).toEqual({ crates: ["alpha"], ran: 3, rounds: 0 });
		// lib.rs is a public seam, so the tier is forced by code and both reviewers read the head once.
		expect(alpha.state.review?.tier).toMatchObject({ choice: "grok_plus_opus", decided_by: "code" });
		expect(alpha.state.review?.verdicts).toEqual({ grok: "LANDABLE", opus: "LANDABLE" });
		// A reply that only mentions a verdict is continued in the same session until the standalone line arrives.
		expect(readFileSync(join(f.root, "prime.log"), "utf8")).toBe(
			"open Review this diff for\ncontinue Continue this SAME r\n",
		);
		const gh = readFileSync(join(f.root, "gh.log"), "utf8");
		expect(gh).toContain("pr create --repo org/repo --title alpha-one: Ticket alpha-one");
		expect(gh).toContain("pr comment 7 --repo org/repo --body @coderabbitai review");
		expect(gh).toContain("api --paginate repos/org/repo/pulls/7/reviews");
		expect(alpha.state.pr).toBe(7);
		expect(alpha.state.bots).toMatchObject({ completed: ["qodo", "codex"], unavailable: [], comments: 4 });
		expect(alpha.state.botRound?.final).toContain("DONE alpha-one");
		const seatLog = readFileSync(join(f.root, "seat.log"), "utf8");
		expect(seatLog).toContain("Consider bounding this retry loop.");
		expect(seatLog).toContain("Bugbot couldn't run");
		expect(seatLog.split(INITIATIVE_LINES).length).toBeGreaterThan(4);
		expect(seatLog).toContain(WRITER_LINES);
		expect(alpha.writerSystem()).toContain(SEAT_POLICY_LINE);
		const body = readFileSync(join(alpha.directory, "PR-BODY.md"), "utf8");
		expect(body).toContain("Added the function.");
		expect(body).toContain("SPLIT: the follow-up half");
		expect(f.git(["log", "--format=%s", "origin/main..origin/w7/alpha-one"], f.repo)).toContain(
			"alpha-one: implement",
		);

		const beta = new OneironTicketRunner(f.ticket("beta", ["alpha-one"]), { env: f.env, routing: {} });
		await beta.submit();
		expect(beta.state).toMatchObject({ base: "w7/alpha-one", stacked: true, chain: ["w7/alpha-one"], pr: 8 });
		const stacked = readFileSync(join(f.root, "gh.log"), "utf8");
		expect(stacked).toContain("stack init --base main w7/alpha-one w7/beta");
		expect(stacked).toContain("stack submit --auto --open --remote origin");
		expect(f.git(["merge-base", "--is-ancestor", "w7/alpha-one", "w7/beta"], f.repo)).toBe("");

		const ticketEntry = join(inject("factoryDist"), "adapters", "oneiron-ticket-entry.js");
		const usage = spawnSync(process.execPath, [ticketEntry, "merge"], { env: f.env, encoding: "utf8" });
		writeFileSync(join(alpha.directory, "ticket.json"), JSON.stringify(f.ticket("alpha-one")));
		const rerun = spawnSync(process.execPath, [ticketEntry, "merge", join(alpha.directory, "ticket.json")], {
			env: f.env,
			encoding: "utf8",
		});
		expect([usage.status, rerun.status]).toEqual([2, 0]);
		expect(rerun.stdout).toContain("MERGED https://github.com/org/repo/pull/7");
		const mergeLog = readFileSync(join(f.root, "gh.log"), "utf8");
		// A lone pull request merges at its exact tested head, after its required checks were read.
		expect(mergeLog).toContain("pr checks 7 --repo org/repo --required --json name,bucket,state,link");
		expect(mergeLog).toMatch(
			/pr merge 7 --repo org\/repo --squash --subject alpha-one: Ticket alpha-one --body-file \S+ --match-head-commit [0-9a-f]{40}\n/,
		);
		expect(existsSync(alpha.worktree)).toBe(false);
		await beta.merge();
		expect(mergeLog.includes("stack sync")).toBe(false);
		const after = readFileSync(join(f.root, "gh.log"), "utf8");
		expect(after).toContain("stack sync");
		expect(after).toContain("stack merge --squash --yes");
		expect(beta.state.merged).toBe(true);
	});

	it("under noStacks waits for every blocker to merge, branches from the trunk and never calls gh stack", async () => {
		const f = setup();
		const parentState = join(f.work, "tickets", "parent", "state.json");
		mkdirSync(join(f.work, "tickets", "parent"), { recursive: true });
		const parent = { key: "parent", branch: "w7/parent", worktree: join(f.work, "wt", "parent"), pr: 3 };
		writeFileSync(parentState, JSON.stringify(parent));
		const ticket = f.ticket("child", ["parent"]);
		ticket.launcher = { ...f.launcher, noStacks: true };
		// The runner's first wait holds until the test has looked and merged the parent; later waits return at once.
		const waits: number[] = [];
		let hold: (release: () => void) => void = () => undefined;
		const held = new Promise<() => void>((resolveHold) => {
			hold = resolveHold;
		});
		const runner = new OneironTicketRunner(ticket, {
			env: f.env,
			routing: {},
			sleep: (ms) => {
				waits.push(ms);
				return waits.length === 1 ? new Promise<void>((release) => hold(release)) : Promise.resolve();
			},
		});
		// The parent is submitted but not merged: with stacks the child would branch from it now.
		const submitted = runner.submit();
		submitted.catch(() => undefined);
		const release = await held;
		expect([runner.state.base, readFileSync(runner.logPath, "utf8")]).toEqual([
			undefined,
			expect.stringContaining("noStacks"),
		]);
		writeFileSync(parentState, JSON.stringify({ ...parent, merged: true }));
		release();
		await submitted;
		expect(runner.state).toMatchObject({ base: "origin/main", stacked: false, pr: 7 });
		// It re-read its blockers once a minute.
		expect(waits).toEqual([60_000]);
		// The pull request API still shows the head from before the last push: the merge waits for it to follow.
		const ghState = join(f.root, "gh-state.json");
		writeFileSync(ghState, JSON.stringify({ ...JSON.parse(readFileSync(ghState, "utf8")), lag: 2 }));
		await runner.merge();
		expect(readFileSync(runner.logPath, "utf8")).toContain("waiting for the pull request head");
		expect(waits.slice(1)).toEqual([10_000]);
		const gh = readFileSync(join(f.root, "gh.log"), "utf8");
		expect(gh).not.toMatch(/^stack /m);
		expect(gh).toContain("--base main --head w7/child");
		expect(gh).toMatch(/^pr merge 7 --repo org\/repo --squash .* --match-head-commit [0-9a-f]{40}$/m);
		expect(runner.state.merged).toBe(true);

		// A ticket cut on a stack before noStacks was set is refused, never merged through gh stack.
		const stacked = f.ticket("stacked", ["parent"]);
		stacked.launcher = { ...f.launcher, noStacks: true };
		mkdirSync(join(f.work, "tickets", "stacked"), { recursive: true });
		writeFileSync(
			join(f.work, "tickets", "stacked", "state.json"),
			JSON.stringify({
				key: "stacked",
				branch: "w7/stacked",
				worktree: join(f.work, "wt", "stacked"),
				base: "w7/parent",
				stacked: true,
				pr: 9,
			}),
		);
		const leftover = new OneironTicketRunner(stacked, { env: f.env, routing: {} });
		await expect(leftover.merge()).rejects.toThrow("was cut on the stack w7/parent before noStacks was set");
		await expect(leftover.submit()).rejects.toThrow("before noStacks was set");
	});

	it("with CI-only tests, no bots and a pre-merge review, merges only a head whose checks and review pass", async () => {
		const f = setup();
		const ticket = f.ticket("docs-one");
		ticket.contract = "docs only: describe the flag.";
		ticket.launcher = {
			...f.launcher,
			noStacks: true,
			skipFactoryTests: true,
			skipBots: true,
			preMergeReview: true,
			timeouts: { ...f.launcher.timeouts, ciMs: 0 },
		};
		const runner = new OneironTicketRunner(ticket, { env: f.env, routing: {} });
		// A ticket that touches no crate is not "zero tests ran": the factory runs no cargo at all.
		await runner.submit();
		expect([existsSync(join(f.root, "cargo.log")), runner.state.tests?.skipped, runner.state.bots]).toEqual([
			false,
			true,
			undefined,
		]);
		const gh = () => readFileSync(join(f.root, "gh.log"), "utf8");
		expect(gh()).not.toMatch(/@coderabbitai|api --paginate/);
		const checks = (rows: unknown[]) => {
			const state = JSON.parse(readFileSync(join(f.root, "gh-state.json"), "utf8"));
			writeFileSync(join(f.root, "gh-state.json"), JSON.stringify({ ...state, checks: rows }));
		};
		// With no factory tests, a pull request with no required check reported has nothing gating it, and a head
		// whose checks have not registered yet ("no checks reported") waits for them rather than failing the read.
		const ghState = () => JSON.parse(readFileSync(join(f.root, "gh-state.json"), "utf8"));
		writeFileSync(
			join(f.root, "gh-state.json"),
			JSON.stringify({ ...ghState(), checksText: "no checks reported on the 'w7/docs-one' branch" }),
		);
		await expect(runner.merge()).rejects.toThrow("requiredPending=none reported, and skipFactoryTests needs one");
		writeFileSync(join(f.root, "gh-state.json"), JSON.stringify({ ...ghState(), checksText: undefined }));
		await expect(runner.merge()).rejects.toThrow("requiredPending=none reported, and skipFactoryTests needs one");
		const check = {
			name: "Test",
			state: "FAILURE",
			bucket: "fail",
			link: "https://ci.example.invalid/check/2",
		};
		checks([check]);
		await expect(runner.merge()).rejects.toThrow(/required checks failed at [0-9a-f]{40}: Test \(FAILURE\)/);
		checks([{ ...check, state: "SUCCESS", bucket: "pass" }]);
		writeFileSync(join(f.root, "defects"), "");
		await expect(runner.merge()).rejects.toThrow("is not LANDABLE");
		rmSync(join(f.root, "defects"));
		await runner.merge();
		expect(runner.state).toMatchObject({ merged: true, preMerge: { verdict: "LANDABLE" } });
		expect(gh()).toMatch(/^pr merge 7 .* --match-head-commit [0-9a-f]{40}$/m);
	});

	it("lets the writer run past any round count", async () => {
		const f = setup();
		// Rounds are unbounded: the old cap was 12, so a writer that only finishes on round 15 must still finish.
		writeFileSync(
			join(f.root, "late.js"),
			`const fs = require("node:fs"), p = process.env.FAKE_ROOT + "/rounds";
const n = (fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : 0) + 1;
fs.writeFileSync(p, String(n));
process.stdout.write("round " + n + "\\n");
if (n < 15) process.exit(1);
process.stdout.write("DONE late-one\\n");
`,
		);
		const late = f.ticket("late-one");
		late.launcher = {
			...f.launcher,
			seats: { ...f.launcher.seats, writer: { command: [process.execPath, join(f.root, "late.js")] } },
		};
		const waits: number[] = [];
		const writer = new OneironTicketRunner(late, {
			env: f.env,
			routing: {},
			sleep: async (ms) => void waits.push(ms),
		});
		mkdirSync(writer.worktree, { recursive: true });
		const { final } = await writer.writerRounds("write", "start", "continue");
		expect([final.includes("DONE late-one"), readFileSync(join(f.root, "rounds"), "utf8")]).toEqual([true, "15"]);
		// Each failed round pauses before the next one; the pause never counts toward an end.
		expect(waits).toEqual(Array(14).fill(30_000));
	});

	it("keeps a writer session going when DONE is only quoted, and ends it on the exact line", async () => {
		const f = setup();
		writeFileSync(
			join(f.root, "quoting.js"),
			`const fs = require("node:fs"), p = process.env.FAKE_ROOT + "/quoting";
const n = (fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : 0) + 1;
fs.writeFileSync(p, String(n));
if (n === 1) process.stdout.write("The build is running; I will end with DONE quote-one once it passes.\\n");
else if (n === 2) process.stdout.write("Template:\\n\`\`\`\\nDONE quote-one\\n\`\`\`\\n");
else if (n === 3) { process.stdout.write("Tests pass.\\nDONE quote-one\\n"); process.exitCode = 1; }
else process.stdout.write("Tests pass.\\nDONE quote-one\\n");
`,
		);
		const quoting = f.ticket("quote-one");
		quoting.launcher = {
			...f.launcher,
			seats: { ...f.launcher.seats, writer: { command: [process.execPath, join(f.root, "quoting.js")] } },
		};
		const waits: number[] = [];
		const writer = new OneironTicketRunner(quoting, {
			env: f.env,
			routing: {},
			sleep: async (ms) => void waits.push(ms),
		});
		mkdirSync(writer.worktree, { recursive: true });
		const { final } = await writer.writerRounds("write", "start", "continue");
		// Round 3 prints the exact line and then exits 1: a failed seat has not ended its round, and only it pauses.
		expect([final, readFileSync(join(f.root, "quoting"), "utf8"), waits]).toEqual([
			"Tests pass.\nDONE quote-one",
			"4",
			[30_000],
		]);
		const intents = readFileSync(join(writer.directory, "routing.jsonl"), "utf8").trim().split("\n");
		expect(intents.map((line) => JSON.parse(line).choice)).toEqual(["continue", "continue", "continue", "done"]);
	});

	it("sends a native seat its prompt on stdin, never in argv", async () => {
		const f = setup();
		const ticket = f.ticket("stdin-one");
		ticket.launcher = { ...f.launcher, seats: { writer: { provider: "p", model: "m", thinking: "low" } } };
		const runner = new OneironTicketRunner(ticket, {
			env: f.env,
			routing: {},
			agentArgv: [process.execPath, join(f.root, "prime.js")],
		});
		mkdirSync(runner.worktree, { recursive: true });
		const prompt = "x".repeat(300_000);
		const result = await runner.seat("writer", prompt, { logName: "stdin.jsonl" });
		expect([result.code, result.final]).toEqual([0, `argv false stdin ${prompt.length}`]);
	});

	it("counts a seat whose session began as started, and a spawn failure as never started", async () => {
		const f = setup();
		// A review killed mid-think streams only agent_start under the factory profile; it is not "unavailable".
		writeFileSync(join(f.root, "dies.js"), 'process.stdout.write(\'{"type":"agent_start"}\\n\'); process.exit(3);\n');
		const ticket = f.ticket("start-one");
		ticket.launcher = { ...f.launcher, seats: { grok: { provider: "p", model: "m", thinking: "low" } } };
		const cli = (...argv: string[]) => new OneironTicketRunner(ticket, { env: f.env, routing: {}, agentArgv: argv });
		const started = cli(process.execPath, join(f.root, "dies.js"));
		mkdirSync(started.worktree, { recursive: true });
		const died = await started.seat("grok", "Review this diff", { logName: "died.jsonl" });
		expect([died.code, died.final, died.activity]).toEqual([3, "", true]);
		const absent = await cli(join(f.root, "no-such-cli")).seat("grok", "Review this diff", {
			logName: "absent.jsonl",
		});
		expect([absent.code, absent.activity, absent.bytes > 0]).toEqual([127, false, true]);
	});

	const event = (value: object) => `${JSON.stringify(value)}\n`;
	const reply = (text: string) =>
		event({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
	const started = event({ type: "agent_start" });
	const ended = event({ type: "agent_end" });
	const STOPS = "stops before prompting that session again";
	const CONTINUES = "continues the same session";
	const failed = (output: string) => ({ code: 1, output });
	const silent = (output: string) => ({ code: SEAT_IDLE_EXIT_CODE, output });
	const unstarted = { code: 127, output: "\nspawn /opt/prime-agent-rs ENOENT", spawnFailed: true as const };
	it.each([
		["daemon", "died mid-turn", STOPS, failed(started)],
		["daemon", "was killed for silence before its turn began", STOPS, silent("\nIDLE 1800s")],
		["daemon", "exited before any event, its prompt possibly admitted", STOPS, failed("daemon closed\n")],
		["daemon", "was killed for silence after its turn ended", CONTINUES, silent(started + reply("") + ended)],
		["daemon", "could not be started at all", CONTINUES, unstarted],
		["owned", "died mid-turn", CONTINUES, failed(started)],
	] as const)(
		"under %s custody, a writer whose seat client %s %s",
		async (hosting, _case, outcome, first) => {
			const f = setup();
			const ticket = f.ticket("custody-one");
			ticket.launcher = {
				...f.launcher,
				seatHosting: hosting,
				seats: { writer: { provider: "p", model: "m", thinking: "low" } },
			};
			const runner = new OneironTicketRunner(ticket, {
				env: f.env,
				routing: {},
				agentArgv: ["/opt/prime-agent-rs"],
				sleep: async () => undefined,
			});
			mkdirSync(runner.worktree, { recursive: true });
			const calls: string[][] = [];
			runner.run = async (argv) => {
				calls.push(argv);
				return calls.length === 1 ? first : { code: 0, output: started + reply("DONE custody-one") + ended };
			};
			const rounds = runner.writerRounds("write", "start", "continue");
			if (outcome === STOPS) {
				await expect(rounds).rejects.toThrow("before its daemon-hosted turn was seen to end; that turn may still be");
				expect(calls).toHaveLength(1);
			} else {
				expect((await rounds).final).toBe("DONE custody-one");
				expect(calls.map((argv) => argv.includes("-c"))).toEqual([false, true]);
			}
			expect(calls[0]!.includes("--daemon-hosted")).toBe(hosting === "daemon");
		},
	);

	/**
	 * The matrix's custody contract against the BUILT Rust binary (`PRIME_AGENT_TEST_BINARY`): real seat processes run
	 * the factory's exact argv (`--offline` and `--no-skills` included), owned seats run the faux provider in-process,
	 * daemon seats a sandbox daemon whose workers run it. A wrapper pins the sandbox (HOME, TMPDIR, the daemon socket
	 * and its worker sockets, under $PA_SANDBOX_ROOT or ~/.cache/pa-sb) with nothing else inherited, logs each call's
	 * argv and hands call N its own script.
	 * Linux only: the teardown waits for the sandbox daemon's exit through `tail --pid`.
	 */
	// test-policy: allow conditional-or-disabled-test -- runs only with a built Rust binary (PRIME_AGENT_TEST_BINARY) on Linux; the package suite builds no Rust
	describe.skipIf(!BUILT_AGENT || process.platform !== "linux")("against the built prime-agent binary", () => {
		function builtAgent(scripts: object[]) {
			// The agent's sandbox (HOME, TMPDIR, sockets) stays off the shared /tmp.
			const parent = process.env.PA_SANDBOX_ROOT ?? join(homedir(), ".cache", "pa-sb");
			mkdirSync(parent, { recursive: true });
			const sandbox = mkdtempSync(join(parent, "custody-"));
			roots.push(sandbox);
			for (const dir of ["home", "tmp", "s"]) mkdirSync(join(sandbox, dir), { recursive: true });
			scripts.forEach((script, index) => {
				writeFileSync(join(sandbox, `faux-${index + 1}.json`), JSON.stringify(script));
				writeFileSync(join(sandbox, `daemon-${index + 1}.json`), JSON.stringify({ engine: "faux", ...script }));
			});
			const socket = join(sandbox, "d.sock");
			const wrapper = join(sandbox, "prime-agent");
			writeFileSync(
				wrapper,
				`#!/bin/sh
dir=${JSON.stringify(sandbox)}
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
[ -f "$dir/faux-$n.json" ] || n=${scripts.length}
printf '%s\\n' "$*" >> "$dir/calls.log"
exec env -i PATH=/usr/bin:/bin HOME="$dir/home" TMPDIR="$dir/tmp" PRIME_AGENT_DAEMON_SOCKET=${JSON.stringify(socket)} \\
  PRIME_AGENT_SOCKET_DIR="$dir/s" PRIME_AGENT_FAUX_SCRIPT="$(cat "$dir/faux-$n.json")" \\
  PRIME_AGENT_HOSTED_DAEMON_SCRIPT="$dir/daemon-$n.json" ${JSON.stringify(BUILT_AGENT)} "$@"
`,
				{ mode: 0o755 },
			);
			daemonSockets.push(socket);
			const calls = () => readFileSync(join(sandbox, "calls.log"), "utf8").trim().split("\n");
			return { wrapper, socket, calls };
		}
		function runner(f: ReturnType<typeof setup>, hosting: "owned" | "daemon", wrapper: string) {
			const ticket = f.ticket("custody-one");
			ticket.launcher = {
				...f.launcher,
				seatHosting: hosting,
				// Silence ends a held turn quickly; a streaming seat is never cut.
				idleMs: 3_000,
				seats: { writer: { provider: "faux", model: "faux-1", thinking: "low" } },
			};
			const r = new OneironTicketRunner(ticket, {
				env: f.env,
				routing: {},
				agentArgv: [wrapper],
				sleep: async () => undefined,
			});
			mkdirSync(r.worktree, { recursive: true });
			return r;
		}
		const held = { responses: [{ text: "held", holdUntilAborted: true }] };
		const seatFlags = ["--offline", "--no-skills"];

		it("daemon custody: an unfinished writer continues its resident session with -c", async () => {
			const f = setup();
			const agent = builtAgent([{ responses: ["Working on it.", "DONE custody-one"] }]);
			const writer = runner(f, "daemon", agent.wrapper);
			expect((await writer.writerRounds("write", "start", "continue")).final).toBe("DONE custody-one");
			const calls = agent.calls().map((argv) => argv.split(" "));
			expect(calls.map((argv) => [argv.includes("--daemon-hosted"), argv.includes("-c")])).toEqual([
				[true, false],
				[true, true],
			]);
			for (const argv of calls) expect(seatFlags.filter((flag) => argv.includes(flag))).toEqual(seatFlags);
			// One resident session, idle, carrying both rounds.
			const rows = (await daemonRequest(agent.socket, { type: "list" })).response.data.sessions as Record<
				string,
				unknown
			>[];
			expect(rows.map((row) => [row.workerState, row.isStreaming])).toEqual([["ready", false]]);
			const users = readFileSync(String(rows[0]!.sessionFile), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.type === "message" && entry.message?.role === "user");
			expect(users).toHaveLength(2);
			// test-policy: allow explicit-test-timeout -- real seat processes (a debug build, a sandbox daemon, the idle kill) need a failure bound past the 5 s default; process events signal progress
		}, 120_000);

		it("daemon custody: a writer killed for silence mid-turn stops the ticket, and the turn runs on", async () => {
			const f = setup();
			const agent = builtAgent([held]);
			const writer = runner(f, "daemon", agent.wrapper);
			await expect(writer.writerRounds("write", "start", "continue")).rejects.toThrow(
				"before its daemon-hosted turn was seen to end; that turn may still be",
			);
			expect(agent.calls()).toHaveLength(1);
			const rows = (await daemonRequest(agent.socket, { type: "list" })).response.data.sessions as Record<
				string,
				unknown
			>[];
			expect(rows.map((row) => [row.workerState, row.isStreaming])).toEqual([["ready", true]]);
			// test-policy: allow explicit-test-timeout -- real seat processes (a debug build, a sandbox daemon, the idle kill) need a failure bound past the 5 s default; process events signal progress
		}, 120_000);

		it("owned custody: a writer killed for silence mid-turn continues the same session", async () => {
			const f = setup();
			const agent = builtAgent([held, { responses: ["DONE custody-one"] }]);
			const writer = runner(f, "owned", agent.wrapper);
			expect((await writer.writerRounds("write", "start", "continue")).final).toBe("DONE custody-one");
			const calls = agent.calls().map((argv) => argv.split(" "));
			expect(calls.map((argv) => [argv.includes("--daemon-hosted"), argv.includes("-c")])).toEqual([
				[false, false],
				[false, true],
			]);
			const sessions = join(writer.directory, "sessions", "write");
			expect(readdirSync(sessions).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
			expect(existsSync(agent.socket)).toBe(false);
			// test-policy: allow explicit-test-timeout -- real seat processes (a debug build, a sandbox daemon, the idle kill) need a failure bound past the 5 s default; process events signal progress
		}, 120_000);
	});

	it("continues a writer's existing session on round 1 and delivers the owner's note once", async () => {
		const f = setup();
		const ticket = f.ticket("note-one");
		ticket.launcher = { ...f.launcher, seats: { writer: { provider: "p", model: "m", thinking: "low" } } };
		const runner = new OneironTicketRunner(ticket, {
			env: f.env,
			routing: {},
			agentArgv: [process.execPath, join(f.root, "prime.js")],
		});
		mkdirSync(runner.worktree, { recursive: true });
		writeFileSync(join(runner.directory, "resume-note.md"), "owner note: the fixture host moved\n");
		await runner.writerRounds("fix-tests", "finish the first fix", "continue");
		await runner.writerRounds("fix-tests", "finish the second fix", "continue");
		expect(readFileSync(join(f.root, "prime.log"), "utf8")).toBe(
			"open finish the first fix +note\ncontinue finish the second fi\n",
		);
		expect(existsSync(join(runner.directory, "resume-note.md"))).toBe(false);
	});

	it("holds a writer's registered validation without model rounds, then resumes the same session with its result", async () => {
		const f = setup();
		const controller = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
		try {
			const pid = controller.pid!;
			const identity = { version: 1, ticket: "wait-one", session: "write", jobId: "job-00001", pid };
			const startId = getProcessStartId(pid)!;
			const ticket = f.ticket("wait-one");
			ticket.launcher = { ...f.launcher, seats: { writer: { provider: "p", model: "m", thinking: "low" } } };
			const directory = join(f.work, "tickets", "wait-one");
			const terminalPath = join(directory, "validation.json");
			const runner = new OneironTicketRunner(ticket, {
				env: {
					...f.env,
					PENDING_PATH: join(directory, "pending-jobs", "write.json"),
					PENDING_JSON: JSON.stringify({ ...identity, startId, terminalPath }),
				},
				routing: {},
				agentArgv: [process.execPath, join(f.root, "prime.js")],
			});
			mkdirSync(runner.worktree, { recursive: true });
			const log = runner.log;
			const waiting = new Promise<void>((resolveWait) => {
				runner.log = (step, message) => {
					log(step, message);
					if (step === "writer:wait" && message?.includes(`pid=${pid}`)) resolveWait();
				};
			});
			// Round 1 registers the job and prints DONE; the pending job wins, so the session is not over.
			const rounds = runner.writerRounds("write", "register the gate", "continue");
			rounds.catch(() => undefined);
			await waiting;
			expect(readFileSync(join(f.root, "prime.log"), "utf8")).toBe("open register the gate\n\nP\n");
			expect(readFileSync(join(f.root, "writer-prompt"), "utf8")).toContain("use `setsid`, not `nohup ... &`");
			expect(runner.writerSystem()).toContain("setsid, not nohup ... &");
			writeFileSync(terminalPath, JSON.stringify({ ...identity, startId, exitCode: 0 }));
			const { final } = await rounds;
			expect([final, readFileSync(join(f.root, "prime.log"), "utf8")]).toEqual([
				"Validation passed.\nDONE wait-one",
				"open register the gate\n\nP\ncontinue continue\n\nProductive\n",
			]);
			expect(existsSync(join(directory, "pending-jobs", "write.job-00001.consumed.json"))).toBe(true);
		} finally {
			controller.stdin!.end();
		}
	});

	it("sends cargo to the ruled build hosts and leaves it alone with none configured", () => {
		const f = setup();
		const plain = new OneironTicketRunner(f.ticket("plain"), { env: f.env, routing: {} });
		expect(plain.cargoEnvironment()).toEqual({});
		const offloaded = f.ticket("offloaded");
		offloaded.launcher = {
			...f.launcher,
			buildHosts: [
				{ sshHost: "olety@100.124.216.116", root: "/Volumes/Cinema/w7-build", slots: 3, jobs: 3 },
				{ sshHost: "olety@100.81.227.117", root: "/Users/olety/w7-build" },
			],
		};
		const environment = new OneironTicketRunner(offloaded, { env: f.env, routing: {} }).cargoEnvironment();
		expect(environment.W7_CARGO_HOSTS).toBe(
			"olety@100.124.216.116:3:3:/Volumes/Cinema/w7-build;olety@100.81.227.117:2:4:/Users/olety/w7-build",
		);
		expect(environment.W7_CARGO_WORK).toBe(f.work);
		expect(environment.PATH?.startsWith(`${factoryCargoBinDirectory()}:`)).toBe(true);
	});

	it("reclaims dead slot locks on the next pass of the slot wait", async () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-slots-"));
		roots.push(directory);
		writeFileSync(join(directory, "slot-1.lock"), "999999999");
		vi.useFakeTimers();
		try {
			const waiting = acquireSlot(directory, 1);
			// The first pass removes the dead holder's lock; the claim lands one five-second wait later.
			await vi.advanceTimersByTimeAsync(4_999);
			expect(existsSync(join(directory, "slot-1.lock"))).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const release = await waiting;
			expect(readFileSync(join(directory, "slot-1.lock"), "utf8")).toBe(String(process.pid));
			release();
			expect(existsSync(join(directory, "slot-1.lock"))).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries git ref locks and cuts configurable branches without writing shared tracking config", async () => {
		const f = setup();
		f.git(["config", "branch.autoSetupMerge", "true"], f.repo);
		const ticket = f.ticket("lock-one");
		ticket.launcher = { ...f.launcher, branchPrefix: "w8", skipBots: true };
		const waits: number[] = [];
		const runner = new OneironTicketRunner(ticket, {
			env: f.env,
			routing: {},
			sleep: async (ms) => void waits.push(ms),
		});
		const execute = runner.run.bind(runner);
		let locks = 0;
		let trackingOnCut: number | null = null;
		runner.run = async (args, options) => {
			if (args[0] === "git" && args[1] === "fetch" && locks++ === 0)
				return { code: 1, output: "cannot lock ref 'refs/remotes/origin/main'" };
			const result = await execute(args, options);
			if (args[0] === "git" && args[1] === "worktree" && args[2] === "add")
				trackingOnCut = spawnSync("git", ["config", "--get", "branch.w8/lock-one.remote"], { cwd: f.repo }).status;
			return result;
		};
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			await runner.submit();
		} finally {
			random.mockRestore();
		}
		expect(locks).toBeGreaterThan(1);
		// One locked fetch, one backoff: a second plus up to four jittered seconds per attempt (no jitter here).
		expect(waits).toEqual([1_000]);
		expect(f.git(["rev-parse", "--abbrev-ref", "HEAD"], runner.worktree)).toBe("w8/lock-one");
		expect(trackingOnCut).toBe(1);
	});

	it("merges a green candidate with old ancestry and a stale GitHub baseRefOid", async () => {
		const f = setup();
		const ticket = f.ticket("base-one");
		ticket.launcher = { ...f.launcher, noStacks: true, skipBots: true, skipFactoryTests: true };
		const runner = new OneironTicketRunner(ticket, { env: f.env, routing: {} });
		await runner.submit();
		const baseOid = f.git(["rev-parse", "HEAD"], f.repo);
		writeFileSync(join(f.repo, "trunk.txt"), "new trunk\n");
		f.git(["add", "trunk.txt"], f.repo);
		f.git(["commit", "-qm", "advance main"], f.repo);
		f.git(["push", "-q", "origin", "main"], f.repo);
		const statePath = join(f.root, "gh-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(
			statePath,
			JSON.stringify({ ...state, baseOid, checks: [{ name: "Test", bucket: "pass", state: "SUCCESS" }] }),
		);
		await runner.merge();
		expect(readFileSync(join(f.root, "gh.log"), "utf8")).not.toContain("pr update-branch");
		expect(runner.state.merged).toBe(true);
	});

	it("backs off a GitHub rate limit without failing the ticket, with a 24-hour default CI budget", async () => {
		const f = setup();
		const runner = new OneironTicketRunner(f.ticket("rate-one"));
		expect(runner.settings.timeouts).toMatchObject({
			ciMs: 86_400_000,
			mergePollMs: 120_000,
			propagationPollMs: 10_000,
		});
		runner.save({ pr: 7 });
		let calls = 0;
		runner.run = async (args) => {
			if (args[0] === "git") return { code: 0, output: "a".repeat(40) };
			if (args.includes("checks") && calls++ === 0) return { code: 1, output: "GraphQL: API rate limit exceeded" };
			return args.includes("checks")
				? { code: 0, output: JSON.stringify([{ name: "Test", bucket: "pass", state: "SUCCESS" }]) }
				: {
						code: 0,
						output: JSON.stringify({
							state: "OPEN",
							headRefOid: "a".repeat(40),
							mergeable: "MERGEABLE",
							mergeStateStatus: "CLEAN",
						}),
					};
		};
		vi.useFakeTimers();
		try {
			const ready = runner.waitForMergeReadiness("org/repo");
			await vi.advanceTimersByTimeAsync(120_000);
			expect(await ready).toBe("ready");
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for the newest workflow's required Test instead of rejecting its old failure", async () => {
		const f = setup();
		const runner = new OneironTicketRunner(f.ticket("fresh-one"));
		runner.save({ pr: 7 });
		const head = "a".repeat(40);
		let currentChecks: object[] = [];
		runner.run = async (args) => {
			if (args[0] === "git") return { code: 0, output: head };
			if (args[1] === "pr" && args[2] === "checks")
				return {
					code: 0,
					output: JSON.stringify([
						{
							name: "Test",
							bucket: "fail",
							state: "FAILURE",
							link: "https://github.com/org/repo/actions/runs/1/job/11",
						},
					]),
				};
			if (args[1] === "pr")
				return {
					code: 0,
					output: JSON.stringify({
						state: "OPEN",
						headRefOid: head,
						mergeable: "MERGEABLE",
						mergeStateStatus: "CLEAN",
					}),
				};
			const path = args[4]!;
			const old = {
				id: 1,
				workflow_id: 50,
				check_suite_id: 101,
				head_sha: head,
				created_at: "2026-09-24T00:00:00Z",
				event: "pull_request",
				head_branch: "w7/fresh-one",
			};
			const newest = { ...old, id: 2, check_suite_id: 102, created_at: "2026-09-25T00:00:00Z" };
			const data = path.includes("/actions/runs?")
				? { total_count: 2, workflow_runs: [old, newest] }
				: path.endsWith("/actions/runs/1")
					? old
					: path.endsWith("/actions/runs/2")
						? newest
						: path.includes("/check-suites?")
							? {
									total_count: 2,
									check_suites: [101, 102].map((id) => ({
										id,
										head_sha: head,
										created_at: newest.created_at,
										app: { id: 15368, slug: "github-actions" },
									})),
								}
							: { total_count: currentChecks.length, check_runs: currentChecks };
			return { code: 0, output: JSON.stringify(data) };
		};
		expect(await runner.waitForMergeReadiness("org/repo", true)).toBe("pending");
		currentChecks = [{ id: 3, name: "Test", head_sha: head, status: "completed", conclusion: "success" }];
		expect(await runner.waitForMergeReadiness("org/repo", true)).toBe("ready");
	});

	it("spaces stale PR-head polling by ten seconds", async () => {
		const f = setup();
		const runner = new OneironTicketRunner(f.ticket("lag-one"));
		const head = "a".repeat(40);
		let views = 0;
		runner.run = async (args) => {
			if (args[0] === "git")
				return {
					code: 0,
					output: args[1] === "ls-remote" ? `${head}\trefs/heads/w7/lag-one` : args[1] === "status" ? "" : head,
				};
			return { code: 0, output: JSON.stringify({ state: "OPEN", headRefOid: views++ ? head : "0".repeat(40) }) };
		};
		vi.useFakeTimers();
		try {
			const ready = runner.waitForPushedHead("org/repo", head);
			await vi.advanceTimersByTimeAsync(9_999);
			expect(views).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			await ready;
			expect(views).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains a submitted ticket's branch across a prefix change and rejects a mismatched worktree", async () => {
		const f = setup();
		const ticket = f.ticket("prefix-one");
		ticket.launcher = { ...f.launcher, noStacks: true, skipBots: true };
		const submitted = new OneironTicketRunner(ticket, { env: f.env, routing: {} });
		await submitted.submit();
		const resumed = new OneironTicketRunner(
			{ ...ticket, launcher: { ...ticket.launcher, branchPrefix: "w8" } },
			{ env: f.env, routing: {} },
		);
		expect(resumed.branch).toBe("w7/prefix-one");
		f.git(["branch", "-m", "w7/prefix-one", "w7/other"], resumed.worktree);
		await expect(resumed.merge()).rejects.toThrow("worktree branch w7/other does not match w7/prefix-one");
		f.git(["branch", "-m", "w7/other", "w7/prefix-one"], resumed.worktree);
		await resumed.merge();
		expect(resumed.state.merged).toBe(true);
		expect(readFileSync(join(f.root, "gh.log"), "utf8")).toMatch(/^pr merge 7 .*--match-head-commit/m);
	});

	it("reports a failed required check whose name contains rate-limit", async () => {
		const f = setup();
		const runner = new OneironTicketRunner(f.ticket("failed-name"));
		runner.save({ pr: 7 });
		const head = "a".repeat(40);
		runner.run = async (args) =>
			args[0] === "git"
				? { code: 0, output: head }
				: {
						code: 0,
						output: JSON.stringify(
							args.includes("checks")
								? [{ name: "Rate-limit tests", state: "FAILURE", bucket: "fail" }]
								: { state: "OPEN", headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
						),
					};
		await expect(runner.waitForMergeReadiness("org/repo", true)).rejects.toThrow(
			`required checks failed at ${head}: Rate-limit tests (FAILURE)`,
		);
	});

	it("backs off rate limits in merge preparation and outside the final merge mutex", async () => {
		const f = setup();
		const ticket = f.ticket("throttle-merge");
		ticket.launcher = {
			...f.launcher,
			noStacks: true,
			skipBots: true,
		};
		const waits: number[] = [];
		const runner = new OneironTicketRunner(ticket, {
			env: f.env,
			routing: {},
			sleep: async (ms) => void waits.push(ms),
		});
		await runner.submit();
		const execute = runner.run.bind(runner);
		const log = runner.log;
		let releasedBeforeBackoff = false;
		runner.log = (step, message) => {
			if (step === "merge:prepare" && message?.startsWith("rate-limited"))
				releasedBeforeBackoff = !existsSync(join(f.work, "merge-lock", "slot-1.lock"));
			log(step, message);
		};
		let preparation = 0;
		let finalView = 0;
		let mergeCalls = 0;
		runner.run = (args, options) => {
			if (args[0] === "gh" && args[1] === "pr" && args[2] === "merge" && mergeCalls++ === 0)
				return Promise.resolve({ code: 1, output: "GraphQL: API rate limit exceeded" });
			if (args[0] === "gh" && args[1] === "pr" && args[2] === "view") {
				const fields = args[args.indexOf("--json") + 1];
				if (fields === "state,headRefOid,baseRefName,mergeable,mergeStateStatus" && preparation++ === 0)
					return Promise.resolve({ code: 1, output: "GraphQL: API rate limit exceeded" });
				if (fields === "headRefOid,baseRefName" && finalView++ === 0)
					return Promise.resolve({ code: 1, output: "GraphQL: API rate limit exceeded" });
			}
			return execute(args, options);
		};
		await runner.merge();
		expect(preparation).toBeGreaterThan(1);
		expect(finalView).toBeGreaterThan(1);
		expect(mergeCalls).toBe(2);
		expect(runner.state.merged).toBe(true);
		expect(releasedBeforeBackoff).toBe(true);
		// Each of the three rate limits backs off one merge poll interval.
		expect(waits).toEqual([120_000, 120_000, 120_000]);
	});

	it("retries a throttled update-branch without treating it as a conflict", async () => {
		const f = setup();
		const ticket = f.ticket("update-throttle");
		ticket.launcher = {
			...f.launcher,
			noStacks: true,
			skipBots: true,
			skipFactoryTests: true,
		};
		const waits: number[] = [];
		const runner = new OneironTicketRunner(ticket, {
			env: f.env,
			routing: {},
			sleep: async (ms) => void waits.push(ms),
		});
		await runner.submit();
		const statePath = join(f.root, "gh-state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(
			statePath,
			JSON.stringify({
				...state,
				mergeStateStatus: "BEHIND",
				checks: [{ name: "Test", bucket: "pass", state: "SUCCESS" }],
			}),
		);
		const execute = runner.run.bind(runner);
		let updates = 0;
		runner.run = (args, options) => {
			if (args[0] === "gh" && args[1] === "pr" && args[2] === "update-branch" && updates++ === 0) {
				writeFileSync(
					statePath,
					JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), mergeStateStatus: "CLEAN" }),
				);
				return Promise.resolve({ code: 1, output: "GraphQL: API rate limit exceeded" });
			}
			return execute(args, options);
		};
		await runner.merge();
		expect(updates).toBe(1);
		expect(runner.state.merged).toBe(true);
		// The throttled update backs off one merge poll interval.
		expect(waits).toEqual([120_000]);
	});

	it("confirms a remote branch advanced by a throttled update before reusing it", async () => {
		const f = setup();
		const ticket = f.ticket("update-ambiguous");
		ticket.launcher = { ...f.launcher, noStacks: true, skipBots: true, skipFactoryTests: true };
		const runner = new OneironTicketRunner(ticket, { env: f.env, routing: {} });
		await runner.submit();
		const statePath = join(f.root, "gh-state.json");
		writeFileSync(
			statePath,
			JSON.stringify({
				...JSON.parse(readFileSync(statePath, "utf8")),
				mergeStateStatus: "BEHIND",
				checks: [{ name: "Test", bucket: "pass", state: "SUCCESS" }],
			}),
		);
		const execute = runner.run.bind(runner);
		let updates = 0;
		runner.run = (args, options) => {
			if (args[0] === "gh" && args[1] === "pr" && args[2] === "update-branch" && updates++ === 0) {
				f.git(["fetch", "-q", "origin"], f.repo);
				const external = join(f.root, "external-update");
				f.git(["worktree", "add", "-q", "-b", "fake-update", external, `origin/${runner.branch}`], f.repo);
				writeFileSync(join(external, "remote.txt"), "updated branch\n");
				f.git(["add", "remote.txt"], external);
				f.git(["commit", "-qm", "remote update"], external);
				f.git(["push", "-q", "origin", `HEAD:refs/heads/${runner.branch}`], external);
				writeFileSync(
					statePath,
					JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), mergeStateStatus: "CLEAN" }),
				);
				return Promise.resolve({ code: 1, output: "GraphQL: API rate limit exceeded" });
			}
			return execute(args, options);
		};
		await runner.merge();
		expect(updates).toBe(1);
		expect(runner.state.merged).toBe(true);
		expect(readFileSync(runner.logPath, "utf8")).toContain("tests-after-merge-fix");
	});
});
