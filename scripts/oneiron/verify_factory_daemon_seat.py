#!/usr/bin/env python3
"""End-to-end verifier: one factory ticket closes on DAEMON seats against a built prime-agent binary.

    python3 scripts/oneiron/verify_factory_daemon_seat.py --prime-agent-bin <binary> \\
        --factory-dir packages/factory [--sandbox-root DIR] [--timeout-s 900] [--keep]

Everything runs in a throwaway sandbox under --sandbox-root: a fresh HOME and TMPDIR, a bare origin and its checkout
(one crate), fake `gh` and `cargo` (the oneiron-ticket.test.ts fakes), the factory package built from --factory-dir
into the sandbox, and a launcher on host `local` with `seatHosting: "daemon"` and `buildHosts: []`. Every seat is a
native seat, so it runs the factory's exact argv (`--daemon-hosted --offline ... --no-skills`) through a seat wrapper
that execs the given binary with only sandbox paths (its own daemon socket and worker socket dir). The model is the
faux provider (PRIME_AGENT_HOSTED_DAEMON_SCRIPT): the wrapper hands each seat call a script with that stage's reply
(the pack, the writer's `DONE <key>`, the reviewers' `VERDICT: LANDABLE`). The faux model has no tools here, so the
writer's edit is made by the wrapper before the seat runs; the factory commits it as the writer's leftovers. No
provider, network service, real agent dir or running daemon is touched.

The run: `init` (paused) -> `launch --prime-agent-bin` -> `status` -> `resume` -> `serve`, until the ticket is RETIRED
with `merged: true` (read on every line serve prints; --timeout-s only turns a stuck run into a failure). Then the
checks: both actions ACCEPTED, every seat call carried the daemon flags, every seat log reached `agent_end`, every
seat session is still resident in the sandbox daemon (ready, idle), and (Linux) every seat worker runs with
PI_OFFLINE=1. Teardown stops serve and the sandbox daemon by their own pids and removes the sandbox (--keep keeps it).
Exit 0 when every check passed; the report is printed as JSON either way.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TICKET_KEY = "seat-one"
SEATS = ("writer", "pack", "grok", "opus")
DAEMON_FLAGS = ("--daemon-hosted", "--offline", "--no-skills")
PROTOCOL = {"name": "prime-agent.daemon", "version": 7}
REQUEST_BOUND_S = 60

# The oneiron-ticket.test.ts fakes, reduced to what one non-stacked ticket calls.
FAKE_GH = r"""#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const root = process.env.FAKE_ROOT, args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "gh.log"), args.join(" ") + "\n");
const statePath = path.join(root, "gh-state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { prs: {}, next: 7 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const remote = (ref) => cp.execFileSync("git", ["ls-remote", "origin", "refs/heads/" + ref], { encoding: "utf8" }).split(/\s+/)[0];
const [group, verb, target] = args;
if (group === "pr" && verb === "view") {
  const pr = state.prs[target];
  if (!pr) { process.stderr.write("no pull requests found"); process.exit(1); }
  out({ number: pr.number, url: "https://github.invalid/org/repo/pull/" + pr.number, state: pr.merged ? "MERGED" : "OPEN",
    mergedAt: pr.merged ? "2026-10-02T00:00:00Z" : null, headRefOid: remote(pr.branch), baseRefName: "main",
    baseRefOid: remote("main"), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
} else if (group === "pr" && verb === "checks") out("[]");
else if (group === "pr" && verb === "create") {
  const head = args[args.indexOf("--head") + 1];
  const pr = { number: state.next++, merged: false, branch: head };
  state.prs[head] = pr; state.prs[String(pr.number)] = pr; save();
  out("https://github.invalid/org/repo/pull/" + pr.number + "\n");
} else if (group === "pr" && verb === "merge") { state.prs[target].merged = true; save(); out("merged\n"); }
else if (group === "api") out([]);
else out("ok\n");
"""
FAKE_CARGO = r"""#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(path.join(process.env.FAKE_ROOT, "cargo.log"), process.argv.slice(2).join(" ") + "\n");
process.stdout.write("running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n");
"""


def stage_of(prompt: str) -> str | None:
    """The ticket stage a seat prompt belongs to (src/adapters/oneiron-ticket.ts prompts), or None."""
    if "Task (read-only): build the context pack" in prompt:
        return "pack"
    if "Context pack: .w7/CONTEXT.md" in prompt:
        return "writer"
    if prompt.startswith("Review this diff for ticket "):
        return "review"
    if prompt.startswith("Continue the same ticket."):
        return "continue"
    return None


def stage_reply(stage: str, key: str) -> str:
    """The faux model's whole reply for one stage: terminal on the first round."""
    replies = {
        "pack": "PACK: crates/alpha/src/lib.rs:1 add_one is the function to extend.",
        "writer": f"Implemented the function.\nPR BODY:\nAdds {function_name(key)} to alpha.\n"
                  f"The acceptance test runs with the crate tests.\nDONE {key}",
        "continue": f"Nothing left.\nDONE {key}",
        "review": "VERDICT: LANDABLE\nThe diff matches the contract.",
    }
    return replies[stage]


def function_name(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", key.lower())


def seat_flags_missing(argv: list[str]) -> list[str]:
    """The daemon-seat flags a seat call's argv lacks."""
    return [flag for flag in DAEMON_FLAGS if flag not in argv]


def stream_reached_agent_end(log: str) -> bool:
    """Whether a seat log (its JSON event stream) carries an `agent_end`."""
    for line in log.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "agent_end":
            return True
    return False


def evaluate(status: dict, ticket_state: dict, calls: list[dict], seat_logs: dict[str, str],
             daemon_rows: list[dict], worker_offline: dict[str, str | None] | None, key: str = TICKET_KEY) -> list[str]:
    """Every check the run must pass; the empty list is a pass."""
    problems: list[str] = []
    tickets = {ticket.get("id"): ticket for ticket in status.get("tickets", [])}
    if tickets.get(key, {}).get("state") != "RETIRED":
        problems.append(f"ticket {key} is {tickets.get(key, {}).get('state')!r}, not RETIRED")
    actions = {action.get("id"): action.get("state") for action in status.get("actions", [])}
    for stage in ("submit", "merge"):
        if actions.get(f"{key}:{stage}") != "ACCEPTED":
            problems.append(f"action {key}:{stage} is {actions.get(f'{key}:{stage}')!r}, not ACCEPTED")
    if ticket_state.get("merged") is not True:
        problems.append("the ticket state does not record merged: true")
    if not calls:
        problems.append("no seat ran")
    for call in calls:
        missing = seat_flags_missing(call.get("argv", []))
        if missing:
            problems.append(f"a {call.get('stage')} seat call lacks {', '.join(missing)}")
        if call.get("stage") is None:
            problems.append(f"a seat call had an unexpected prompt: {call.get('prompt_head')!r}")
    if not seat_logs:
        problems.append("no seat log was written")
    for name, log in sorted(seat_logs.items()):
        if not stream_reached_agent_end(log):
            problems.append(f"seat log {name} never reached agent_end")
    # A continued seat (-c / --resume) reuses its resident session; every other call opened one.
    opened = [call for call in calls if not {"-c", "--resume"} & set(call.get("argv", []))]
    if len(daemon_rows) != len(opened):
        problems.append(f"the daemon holds {len(daemon_rows)} sessions for {len(opened)} seat sessions")
    for row in daemon_rows:
        if row.get("workerState") != "ready" or row.get("isStreaming"):
            problems.append(f"daemon session {row.get('sessionFile')} is not resident and idle: "
                            f"workerState={row.get('workerState')!r} isStreaming={row.get('isStreaming')!r}")
    for worker, value in sorted((worker_offline or {}).items()):
        if value != "1":
            problems.append(f"seat worker {worker} runs with PI_OFFLINE={value!r}")
    return problems


def seat_wrapper_source(python: str, verifier: Path, config: dict) -> str:
    """The seat binary the launcher records: logs the call, prepares the stage (the writer's edit, the stage's faux
    script), then execs the real binary with the prompt on stdin and only sandbox paths in its environment."""
    return f"""#!{python}
import json, os, sys
sys.path.insert(0, {str(verifier.parent)!r})
from verify_factory_daemon_seat import function_name, stage_of, stage_reply
CONFIG = json.loads({json.dumps(config)!r})
argv = sys.argv[1:]
prompt = sys.stdin.read()
stage = stage_of(prompt)
calls = os.path.join(CONFIG["root"], "seat-calls.jsonl")
with open(calls, "a") as log:
    log.write(json.dumps({{"argv": argv, "stage": stage, "prompt_head": prompt[:120]}}) + "\\n")
if stage is None:
    sys.stderr.write("verify_factory_daemon_seat: unexpected seat prompt\\n")
    sys.exit(2)
count = sum(1 for _ in open(calls))
cwd = argv[argv.index("--cwd") + 1]
if stage == "writer":
    with open(os.path.join(cwd, "crates", "alpha", "src", "lib.rs"), "a") as source:
        source.write("pub fn " + function_name(CONFIG["key"]) + "() -> u8 {{ 1 }}\\n")
script = os.path.join(CONFIG["root"], "scripts", f"{{count}}-{{stage}}.json")
with open(script, "w") as handle:
    json.dump({{"engine": "faux", "responses": [stage_reply(stage, CONFIG["key"])]}}, handle)
prompt_file = script + ".prompt"
with open(prompt_file, "w") as handle:
    handle.write(prompt)
os.dup2(os.open(prompt_file, os.O_RDONLY), 0)
env = dict(CONFIG["env"], PRIME_AGENT_HOSTED_DAEMON_SCRIPT=script)
os.execve(CONFIG["binary"], [CONFIG["binary"], *argv], env)
"""


def daemon_request(sock_path: Path, command: dict) -> tuple[dict, dict | None]:
    """One command over the sandbox daemon socket: its hello and the response (None when it closed first)."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(REQUEST_BOUND_S)
        client.connect(str(sock_path))
        reader = client.makefile("r", encoding="utf-8")
        hello = json.loads(reader.readline())
        envelope = {"type": "command", "id": "verify-1", "protocol": PROTOCOL, "command": command}
        client.sendall((json.dumps(envelope) + "\n").encode())
        for line in reader:
            frame = json.loads(line)
            if frame.get("type") == "response" and frame.get("id") == "verify-1":
                return hello, frame
        return hello, None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_pid_gone(pid: int, bound_s: float) -> bool:
    deadline = time.monotonic() + bound_s
    while pid_alive(pid):
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)
    return True


def stop_sandbox_daemon(sock_path: Path) -> str:
    """Force-stop the sandbox daemon over its own socket; SIGKILL its supervisor pid if it outlives the bound."""
    if not sock_path.exists():
        return "no daemon"
    try:
        hello, _ = daemon_request(sock_path, {"type": "shutdown", "force": True})
    except (OSError, ValueError) as error:
        return f"unreachable: {error}"
    pid = hello.get("supervisorPid")
    if not isinstance(pid, int):
        return "no supervisor pid"
    if wait_pid_gone(pid, REQUEST_BOUND_S):
        return f"stopped supervisor {pid}"
    os.kill(pid, signal.SIGKILL)
    return f"killed supervisor {pid}"


def worker_offline_env(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    for entry in raw.split(b"\0"):
        name, _, value = entry.partition(b"=")
        if name == b"PI_OFFLINE":
            return value.decode()
    return None


class Sandbox:
    def __init__(self, root: Path, binary: str, factory_dir: Path):
        self.root = root
        self.binary = binary
        self.factory_dir = factory_dir
        self.home, self.tmp, self.bin = root / "home", root / "tmp", root / "bin"
        self.origin, self.repo, self.work = root / "origin.git", root / "oneiron", root / "work"
        self.factory, self.attempts, self.dist = root / "factory", root / "attempts", root / "dist"
        self.socket, self.socket_dir = root / "d.sock", root / "s"
        for path in (self.home, self.tmp, self.bin, self.work, self.attempts, root / "scripts"):
            path.mkdir(parents=True)
        node = shutil.which("node")
        if not node:
            raise SystemExit("node is not on PATH")
        self.node = node
        self.env = {
            "PATH": os.pathsep.join([str(self.bin), str(Path(node).parent), "/usr/bin", "/bin"]),
            "HOME": str(self.home), "TMPDIR": str(self.tmp), "LANG": "C.UTF-8", "TZ": "UTC",
            "FAKE_ROOT": str(root), "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Verifier", "GIT_AUTHOR_EMAIL": "verifier@example.invalid",
            "GIT_COMMITTER_NAME": "Verifier", "GIT_COMMITTER_EMAIL": "verifier@example.invalid",
        }

    def run(self, argv: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run(argv, cwd=str(cwd or self.root), env=self.env, capture_output=True, text=True,
                                timeout=600)
        if check and result.returncode != 0:
            raise SystemExit(f"{' '.join(argv)} failed rc={result.returncode}: {result.stdout[-2000:]}"
                             f"{result.stderr[-2000:]}")
        return result

    def factory_cli(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return self.run([self.node, str(self.dist / "cli-entry.js"), *args], check=check)

    def prepare(self, verifier: Path) -> Path:
        for name, source in (("gh", FAKE_GH), ("cargo", FAKE_CARGO)):
            path = self.bin / name
            path.write_text(source)
            path.chmod(0o755)
        self.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)])
        self.run(["git", "clone", "-q", str(self.origin), str(self.repo)])
        (self.repo / "crates" / "alpha" / "src").mkdir(parents=True)
        (self.repo / "crates" / "alpha" / "Cargo.toml").write_text('[package]\nname = "alpha"\nversion = "0.1.0"\n')
        (self.repo / "crates" / "alpha" / "src" / "lib.rs").write_text("pub fn add_one(x: u8) -> u8 { x + 1 }\n")
        self.run(["git", "add", "-A"], cwd=self.repo)
        self.run(["git", "commit", "-qm", "initial"], cwd=self.repo)
        self.run(["git", "push", "-q", "-u", "origin", "main"], cwd=self.repo)
        self.run([self.node, str(self.factory_dir / "scripts" / "build.mjs"), str(self.dist)], cwd=self.factory_dir)
        seat_env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.tmp), "LANG": "C.UTF-8",
                    "TZ": "UTC", "PRIME_AGENT_DAEMON_SOCKET": str(self.socket),
                    "PRIME_AGENT_SOCKET_DIR": str(self.socket_dir)}
        wrapper = self.root / "prime-agent-seat"
        wrapper.write_text(seat_wrapper_source(sys.executable, verifier, {
            "root": str(self.root), "key": TICKET_KEY, "binary": self.binary, "env": seat_env}))
        wrapper.chmod(0o755)
        return wrapper

    def write_inputs(self) -> dict[str, Path]:
        native = {"provider": "faux", "model": "faux-1", "thinking": "low"}
        files = {
            "plan": {"version": 1, "tickets": [], "slots": [], "actions": []},
            "hosts": {"local": {"type": "local", "runnerRoot": str(self.attempts)}},
            "manifest": {"tickets": [{"identifier": f"({TICKET_KEY})", "key": TICKET_KEY, "row": "OF-1",
                                      "title": "Add seat_one to alpha", "blocked_by": []}]},
            "mint": {"creates": [{"key": TICKET_KEY, "contract": "Add seat_one to alpha.",
                                  "acceptance": "A unit test covers it."}]},
            "launcher": {"host": "local", "repo": str(self.repo), "work": str(self.work), "githubRepo": "org/repo",
                         "diskFloorGiB": 0, "idleMs": 300_000, "seatHosting": "daemon", "buildHosts": [],
                         "noStacks": True, "skipBots": True, "seats": {seat: native for seat in SEATS},
                         "timeouts": {"ghMs": 60_000, "botsMs": 0}},
        }
        paths = {}
        for name, value in files.items():
            paths[name] = self.root / f"{name}.json"
            paths[name].write_text(json.dumps(value, indent=2))
        return paths

    def serve_until_retired(self, timeout_s: float) -> tuple[bool, list[str]]:
        """Run serve; after every line it prints, read the ticket state; stop at RETIRED + merged or a rejection."""
        serve = subprocess.Popen([self.node, str(self.dist / "cli-entry.js"), "serve", str(self.factory),
                                  "--interval-ms", "250"], cwd=str(self.root), env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines: list[str] = []
        done = False
        try:
            selector = selectors.DefaultSelector()
            selector.register(serve.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + timeout_s
            while not done:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    lines.append(f"verifier: no RETIRED ticket within {timeout_s:.0f}s")
                    break
                line = serve.stdout.readline()
                if not line:
                    lines.append(f"verifier: serve exited rc={serve.wait()}")
                    break
                lines.append(line.rstrip())
                status = json.loads(self.factory_cli("status", str(self.factory)).stdout)
                actions = {a["id"]: a["state"] for a in status["actions"]}
                if "REJECTED" in actions.values():
                    lines.append(f"verifier: an action was rejected: {actions}")
                    break
                tickets = {t["id"]: t.get("state") for t in status["tickets"]}
                done = tickets.get(TICKET_KEY) == "RETIRED" and self.ticket_state().get("merged") is True
        finally:
            if serve.poll() is None:
                serve.send_signal(signal.SIGTERM)
                try:
                    serve.wait(timeout=REQUEST_BOUND_S)
                except subprocess.TimeoutExpired:
                    serve.kill()
                    serve.wait()
        return done, lines

    def ticket_state(self) -> dict:
        path = self.work / "tickets" / TICKET_KEY / "state.json"
        return json.loads(path.read_text()) if path.exists() else {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--prime-agent-bin", required=True)
    parser.add_argument("--factory-dir", required=True, type=Path)
    parser.add_argument("--sandbox-root", default=None, help="parent of the throwaway sandbox (default: $TMPDIR)")
    parser.add_argument("--timeout-s", type=float, default=900.0)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox for inspection")
    args = parser.parse_args()
    binary = os.path.abspath(args.prime_agent_bin)
    factory_dir = args.factory_dir.resolve()
    root = Path(tempfile.mkdtemp(prefix="vfds-", dir=args.sandbox_root))
    report: dict = {"sandbox": str(root), "binary": binary}
    sandbox = Sandbox(root, binary, factory_dir)
    try:
        wrapper = sandbox.prepare(Path(__file__).resolve())
        inputs = sandbox.write_inputs()
        report["init"] = json.loads(sandbox.factory_cli("init", str(sandbox.factory), str(inputs["plan"]), "--hosts",
                                                        str(inputs["hosts"])).stdout)
        report["launch"] = json.loads(sandbox.factory_cli(
            "launch", str(sandbox.factory), str(inputs["manifest"]), str(inputs["mint"]), "--launcher",
            str(inputs["launcher"]), "--prime-agent-bin", str(wrapper)).stdout)
        before = json.loads(sandbox.factory_cli("status", str(sandbox.factory)).stdout)
        report["status_before"] = {"paused": before["paused"],
                                   "actions": {a["id"]: a["state"] for a in before["actions"]}}
        resumed = sandbox.factory_cli("resume", str(sandbox.factory), check=False)
        report["resume"] = {"rc": resumed.returncode, "stdout": resumed.stdout.strip()[-2000:]}
        started = time.monotonic()
        retired, serve_lines = sandbox.serve_until_retired(args.timeout_s)
        report["serve_s"] = round(time.monotonic() - started, 1)
        report["serve_tail"] = serve_lines[-5:]
        status = json.loads(sandbox.factory_cli("status", str(sandbox.factory)).stdout)
        calls_path = root / "seat-calls.jsonl"
        calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
        logs_dir = sandbox.work / "tickets" / TICKET_KEY / "logs"
        seat_logs = {path.name: path.read_text() for path in sorted(logs_dir.glob("*.jsonl"))} \
            if logs_dir.exists() else {}
        rows: list[dict] = []
        if sandbox.socket.exists():
            _, listed = daemon_request(sandbox.socket, {"type": "list"})
            rows = (listed or {}).get("data", {}).get("sessions", [])
        offline = ({str(row.get("workerPid")): worker_offline_env(int(row["workerPid"]))
                    for row in rows if row.get("workerPid")} if sys.platform.startswith("linux") else None)
        report.update({
            "retired": retired,
            "ticket_state": {k: sandbox.ticket_state().get(k) for k in ("merged", "pr", "writer")},
            "actions": {a["id"]: a["state"] for a in status["actions"]},
            "tickets": {t["id"]: t.get("state") for t in status["tickets"]},
            "seat_calls": [{"stage": c.get("stage"), "flags": [f for f in DAEMON_FLAGS if f in c.get("argv", [])],
                            "continue": "-c" in c.get("argv", [])} for c in calls],
            "seat_logs": sorted(seat_logs),
            "daemon_sessions": [{k: row.get(k) for k in ("workerState", "isStreaming", "sessionFile")}
                                for row in rows],
            "worker_pi_offline": offline,
        })
        report["problems"] = evaluate(status, sandbox.ticket_state(), calls, seat_logs, rows, offline)
        if not retired and not report["problems"]:
            report["problems"].append("the ticket never retired")
    finally:
        report["daemon_teardown"] = stop_sandbox_daemon(sandbox.socket)
        if args.keep:
            report["kept"] = str(root)
        else:
            shutil.rmtree(root, ignore_errors=True)
    report["verdict"] = "PASS" if not report.get("problems") else "FAIL"
    print(json.dumps(report, indent=2))
    return 0 if report["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
