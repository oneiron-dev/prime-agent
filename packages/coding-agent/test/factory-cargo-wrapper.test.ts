import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WRAPPER = resolve("src/factory/bin/cargo");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mkdirSyncReturning(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

/** A build host stands in for ssh and rsync: both log their argv, and ssh also records the script on stdin. */
function stub(name: string, body: string): string {
	return `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const log = path.join(process.env.STUB_ROOT, "${name}.log");
fs.appendFileSync(log, process.argv.slice(2).join(" ") + "\\n");
${body}
`;
}
const SSH = stub(
	"ssh",
	`const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(path.join(process.env.STUB_ROOT, "ssh-stdin.log"), "--- " + process.argv.slice(2).join(" ") + "\\n" + stdin);
const host = process.argv.slice(2).find((a) => !a.startsWith("-") && !a.includes("/") && process.argv[process.argv.indexOf(a) - 1] !== "-o");
if ((process.env.STUB_UNREACHABLE || "").split(",").includes(host)) { process.stderr.write("ssh: connect failed\\n"); process.exit(255); }
process.stdout.write("remote ran\\n");
process.exit(stdin.includes("exec cargo") ? Number(process.env.STUB_CARGO_EXIT || 0) : 0);`,
);
const RSYNC = stub(
	"rsync",
	`const host = (process.argv.slice(2).at(-1) || "").split(":")[0];
if ((process.env.STUB_UNREACHABLE || "").split(",").includes(host)) { process.stderr.write("rsync: transport failed\\n"); process.exit(12); }`,
);
const REAL_CARGO = stub(
	"real-cargo",
	`const target = process.env.CARGO_TARGET_DIR ? " target=" + process.env.CARGO_TARGET_DIR : "";
process.stdout.write("local cargo " + process.argv.slice(2).join(" ") + target + "\\n");`,
);

function setup() {
	const root = mkdtempSync(join(tmpdir(), "factory-cargo-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	for (const [name, source] of [
		["ssh", SSH],
		["rsync", RSYNC],
		["cargo", REAL_CARGO],
	] as const)
		writeFileSync(join(bin, name), source, { mode: 0o755 });
	const work = join(root, "w7-build");
	const worktree = realpathSync(mkdirSyncReturning(join(work, "wt", "W7-C01")));
	mkdirSync(join(worktree, "crates", "alpha"), { recursive: true });
	execFileSync("git", ["init", "-q", worktree]);
	const outside = join(root, "elsewhere");
	mkdirSync(outside);
	execFileSync("git", ["init", "-q", outside]);
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		STUB_ROOT: root,
		W7_CARGO_WORK: work,
		W7_CARGO_HOSTS: "olety@mac-one:1:3:/Volumes/Cinema/w7-build;olety@mac-two:1:2:/Users/olety/w7-build",
	};
	const cargo = (cwd: string, args: string[], overrides: Record<string, string> = {}) =>
		spawnSync("bash", [WRAPPER, ...args], { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
	const read = (name: string) => {
		try {
			return readFileSync(join(root, name), "utf8");
		} catch {
			return "";
		}
	};
	return { root, work, worktree, outside, cargo, read };
}

/** Hold one host slot the way another wrapper does, until the returned release is called. */
async function holdSlot(work: string, host: string): Promise<() => void> {
	mkdirSync(join(work, "locks"), { recursive: true });
	const holder = spawn(
		"perl",
		[
			"-MFcntl=:flock",
			"-e",
			'open(my $h, ">", $ARGV[0]) or die; flock($h, LOCK_EX) or die; $| = 1; print "held\\n"; <STDIN>;',
			join(work, "locks", `cargo-host-${host}-1.lock`),
		],
		{ stdio: ["pipe", "pipe", "inherit"] },
	);
	await new Promise<void>((resolveHeld) => holder.stdout.once("data", () => resolveHeld()));
	return () => holder.stdin.end();
}

describe("factory cargo wrapper", () => {
	it("runs a worktree's cargo on the first reachable build host, in the same relative directory", () => {
		const f = setup();
		const result = f.cargo(join(f.worktree, "crates", "alpha"), ["test", "--no-fail-fast", "-p", "alpha"]);
		expect(result.status).toBe(0);
		// The tree goes to <root>/wt/<key> on host one, without target or .git.
		expect(f.read("rsync.log")).toContain(
			`--exclude target --exclude .git -e ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 ${f.worktree}/ olety@mac-one:/Volumes/Cinema/w7-build/wt/W7-C01/`,
		);
		const script = f.read("ssh-stdin.log");
		expect(script).toContain("cd /Volumes/Cinema/w7-build/wt/W7-C01/crates/alpha");
		expect(script).toContain("exec cargo test --no-fail-fast -p alpha --jobs=3");
		expect(script).toContain("export CARGO_BUILD_JOBS=3;");
		expect(script).toContain("unset CARGO_TARGET_DIR");
		expect(f.read("real-cargo.log")).toBe("");
	});

	it("falls through to the next build host, then to this host, and never leaves a worktree it was not given", () => {
		const f = setup();
		const second = f.cargo(f.worktree, ["build"], { STUB_UNREACHABLE: "olety@mac-one" });
		expect(second.status).toBe(0);
		expect(f.read("ssh-stdin.log")).toContain("cd /Users/olety/w7-build/wt/W7-C01");
		expect(f.read("real-cargo.log")).toBe("");

		const none = setup();
		const local = none.cargo(none.worktree, ["check"], { STUB_UNREACHABLE: "olety@mac-one,olety@mac-two" });
		expect([local.status, local.stdout.trim()]).toEqual([0, "local cargo check"]);
		expect(local.stderr).toContain("no build host could be reached");

		// Outside <work>/wt/<key>, with no hosts, and under the escape hatch, the real cargo runs here.
		for (const [cwd, overrides] of [
			[f.outside, {}],
			[f.worktree, { W7_CARGO_HOSTS: "" }],
			[f.worktree, { W7_CARGO_LOCAL: "1" }],
		] as const) {
			const run = f.cargo(cwd, ["fmt"], overrides);
			expect([run.status, run.stdout.trim()]).toEqual([0, "local cargo fmt"]);
		}
		expect(f.read("ssh-stdin.log")).not.toContain("exec cargo fmt");
	});

	it("skips a host whose slots are all taken, caps explicit jobs, and runs the local host into its own target", async () => {
		const f = setup();
		const release = await holdSlot(f.work, "olety@mac-one");
		try {
			const result = f.cargo(f.worktree, ["build", "-j", "8", "--", "-j", "9"]);
			expect(result.status).toBe(0);
			const script = f.read("ssh-stdin.log");
			expect(script).toContain("cd /Users/olety/w7-build/wt/W7-C01");
			expect(script).toContain("exec cargo build --jobs=2 -- -j 9");
			expect(script).not.toContain("/Volumes/Cinema/w7-build/wt/W7-C01\n");
		} finally {
			release();
		}
		const local = f.cargo(f.worktree, ["check", "--jobs=1"], { W7_CARGO_HOSTS: "local:1:2:/mnt/build" });
		expect([local.status, local.stdout.trim()]).toEqual([
			0,
			"local cargo check --jobs=1 target=/mnt/build/target/W7-C01",
		]);
	});

	it("returns the remote exit code and syncs a source-changing subcommand back", () => {
		const f = setup();
		const failed = f.cargo(f.worktree, ["test"], { STUB_CARGO_EXIT: "101" });
		expect(failed.status).toBe(101);
		expect(f.read("rsync.log").trim().split("\n")).toHaveLength(1);
		const formatted = f.cargo(f.worktree, ["fmt", "--all"]);
		expect(formatted.status).toBe(0);
		// fmt rewrites sources, so the tree comes back from the build host.
		expect(f.read("rsync.log")).toContain(`olety@mac-one:/Volumes/Cinema/w7-build/wt/W7-C01/ ${f.worktree}/`);
	});
});
