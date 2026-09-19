import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSlot,
	finalAssistantText,
	INITIATIVE_LINES,
	type OneironLauncherSettings,
	type OneironTicketRun,
	OneironTicketRunner,
	SEAT_IDLE_EXIT_CODE,
	SEAT_POLICY_LINE,
	WRITER_LINES,
} from "../src/factory/adapters/oneiron-ticket.js";
import { factoryCargoBinDirectory } from "../src/factory/runtime.js";

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
  out({ number: pr.number, url: "https://github.com/org/repo/pull/" + pr.number, state: pr.merged ? "MERGED" : "OPEN", mergedAt: pr.merged ? "2026-09-19T00:00:00Z" : null });
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
else if (prompt.includes("Review this diff")) process.stdout.write("VERDICT: LANDABLE\\n");
else if (prompt.includes("EVERY bot comment")) process.stdout.write("replied to 11 and posted the summary\\nDONE " + key + "\\n");
else {
  fs.appendFileSync("crates/alpha/src/lib.rs", "pub fn " + key.replace(/[^a-z0-9]/g, "_") + "() -> u8 { 1 }\\n");
  execFileSync("git", ["add", "-A"]); execFileSync("git", ["commit", "-qm", key + ": implement"]);
  process.stdout.write("Implemented.\\nPR BODY:\\nAdded the function.\\nSPLIT: the follow-up half\\nDONE " + key + "\\n");
}
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
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		FAKE_ROOT: root,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
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
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Oneiron ticket runner", () => {
	it("runs one ticket from worktree to merge and stacks a child on its submitted parent", async () => {
		const f = setup();
		const alpha = new OneironTicketRunner(f.ticket("alpha-one"), { env: f.env, routing: {} });
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
		expect(seatLog.split(INITIATIVE_LINES).length).toBeGreaterThan(5);
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

		const usage = spawnSync(
			process.execPath,
			[
				"--import",
				resolve("../../node_modules/tsx/dist/loader.mjs"),
				resolve("src/factory/adapters/oneiron-ticket-entry.ts"),
				"merge",
			],
			{ env: f.env, encoding: "utf8" },
		);
		writeFileSync(join(alpha.directory, "ticket.json"), JSON.stringify(f.ticket("alpha-one")));
		const rerun = spawnSync(
			process.execPath,
			[
				"--import",
				resolve("../../node_modules/tsx/dist/loader.mjs"),
				resolve("src/factory/adapters/oneiron-ticket-entry.ts"),
				"merge",
				join(alpha.directory, "ticket.json"),
			],
			{ env: f.env, encoding: "utf8" },
		);
		expect([usage.status, rerun.status]).toEqual([2, 0]);
		expect(rerun.stdout).toContain("MERGED https://github.com/org/repo/pull/7");
		const mergeLog = readFileSync(join(f.root, "gh.log"), "utf8");
		expect(mergeLog).toContain(
			"pr merge 7 --repo org/repo --squash --subject alpha-one: Ticket alpha-one --body-file",
		);
		expect(existsSync(alpha.worktree)).toBe(false);
		await beta.merge();
		expect(mergeLog.includes("stack sync")).toBe(false);
		const after = readFileSync(join(f.root, "gh.log"), "utf8");
		expect(after).toContain("stack sync");
		expect(after).toContain("stack merge --squash --yes");
		expect(beta.state.merged).toBe(true);
	});

	it("kills a silent seat, keeps a talking one, and lets the writer run past any round count", async () => {
		const f = setup();
		// A seat that prints nothing and outlives the idle window, and one that keeps talking through it.
		writeFileSync(join(f.root, "quiet.js"), "setTimeout(() => process.stdout.write('too late'), 60_000);\n");
		writeFileSync(
			join(f.root, "chatty.js"),
			`let n = 0;
const tick = 60;
const t = setInterval(() => {
  process.stdout.write('{"type":"tool_execution_end"}\\n');
  if (++n === 8) { clearInterval(t); process.stdout.write("DONE chatty\\n"); }
}, tick);
`,
		);
		const runner = new OneironTicketRunner(f.ticket("idle-one"), { env: f.env, routing: {} });
		mkdirSync(runner.worktree, { recursive: true });

		// idleMs is the only guard: silence ends the seat, output past it does not.
		const silent = await runner.run([process.execPath, join(f.root, "quiet.js")], {
			cwd: runner.worktree,
			idleMs: 300,
			onIdle: (ms) => runner.log("seat idle", `write.r1: no event for ${ms} ms`),
		});
		expect(silent.code).toBe(SEAT_IDLE_EXIT_CODE);
		expect(silent.output).toContain("IDLE");
		expect(readFileSync(runner.logPath, "utf8")).toContain("seat idle");
		const talking = await runner.run([process.execPath, join(f.root, "chatty.js")], {
			cwd: runner.worktree,
			idleMs: 300,
		});
		expect([talking.code, talking.output.includes("DONE chatty")]).toEqual([0, true]);

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
		const writer = new OneironTicketRunner(late, { env: f.env, routing: {}, retryDelayMs: 0 });
		mkdirSync(writer.worktree, { recursive: true });
		const final = await writer.writerRounds("write", "start", "continue");
		expect([final.includes("DONE late-one"), readFileSync(join(f.root, "rounds"), "utf8")]).toEqual([true, "15"]);
	});

	it("sends cargo to the ruled build hosts and leaves it alone with none configured", () => {
		const f = setup();
		const plain = new OneironTicketRunner(f.ticket("plain"), { env: f.env, routing: {} });
		expect(plain.cargoEnvironment()).toEqual({});
		const offloaded = f.ticket("offloaded");
		offloaded.launcher = {
			...f.launcher,
			buildHosts: [
				{ sshHost: "olety@100.124.216.116", root: "/Volumes/Cinema/w7-build" },
				{ sshHost: "olety@100.81.227.117", root: "/Users/olety/w7-build" },
			],
		};
		const environment = new OneironTicketRunner(offloaded, { env: f.env, routing: {} }).cargoEnvironment();
		expect(environment.W7_CARGO_HOSTS).toBe(
			"olety@100.124.216.116:/Volumes/Cinema/w7-build;olety@100.81.227.117:/Users/olety/w7-build",
		);
		expect(environment.W7_CARGO_WORK).toBe(f.work);
		expect(environment.PATH?.startsWith(`${factoryCargoBinDirectory()}:`)).toBe(true);
	});

	it("reads the final assistant text from a factory-completed stream and reclaims dead slot locks", async () => {
		const stream = [
			JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "no" }] } }),
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "first" }] },
			}),
			"not json",
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "DONE x" }] },
			}),
		].join("\n");
		expect(finalAssistantText(stream)).toBe("DONE x");
		const directory = mkdtempSync(join(tmpdir(), "factory-slots-"));
		roots.push(directory);
		writeFileSync(join(directory, "slot-1.lock"), "999999999");
		const release = await acquireSlot(directory, 1);
		expect(readFileSync(join(directory, "slot-1.lock"), "utf8")).toBe(String(process.pid));
		release();
		expect(existsSync(join(directory, "slot-1.lock"))).toBe(false);
	});
});
