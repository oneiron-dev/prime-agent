#!/usr/bin/env python3
"""Headless exit verifier: does the Rust prime-agent exit right after its answer?

Runs an explicit prime-agent binary headless (`-p --mode json`) against the
side-by-side bench's local mock provider, in a fresh sandbox per flag set
(HOME, TMPDIR and XDG_* inside it, every PRIME_AGENT_*/PI_* variable
scrubbed, telemetry and self-update off, as the bench does). For each run it
records when the `agent_end` event reached stdout and when the process
exited (a blocking wait4), and reports the lag between them:

  - the fresh-home first run on its own (on a fresh home the kernel
    environment is set up before the first turn, so it may be slow to its
    answer, but not after it);
  - then N warm runs (default 20): per-run lag, p50/p90/max.

Flag sets: `default` (tools on, the session persisted) and `sol` (the sol
wrapper's `--no-session --no-tools --no-skills --no-extensions
--no-prompt-templates --no-themes`).

After every run no sandbox process may survive the CLI: anything still
alive (a kernel, a uv step, a probe) gets a short grace to finish exiting
(waited on with pidfd/kqueue, never a sleep), and whatever is still there
is reaped and fails the run.

Verdict: PASS when every run answered, nothing survived, every warm set's
p90 lag is under --threshold (0.5 s) and each fresh-home first run's lag is
too. Exit status 0 on PASS, 1 on FAIL.

    python3 scripts/oneiron/verify_headless_exit.py --binary ./target/release/prime-agent
    python3 scripts/oneiron/verify_headless_exit.py --binary BIN --runs 20 --modes sol \\
        --sandbox-base ~/.cache/pa-sb --json-out exit.json

Never touches the installed products, the real ~/.prime/agent or any
running prime-agent: the binary runs only inside its sandbox, and only
processes carrying that sandbox's HOME (or spawned by this script) are
ever signalled.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench_side_by_side as bench  # noqa: E402

THRESHOLD_S = 0.5
DEFAULT_RUNS = 20
# How long a child the CLI killed on its way out may take to be gone.
SURVIVOR_GRACE_S = 2.0
SOL_FLAGS = ("--no-session", "--no-tools", "--no-skills", "--no-extensions",
             "--no-prompt-templates", "--no-themes")
MODES: dict[str, tuple[str, ...]] = {"default": (), "sol": SOL_FLAGS}
MESSAGE = "say hi"


# -- pure parts --------------------------------------------------------------------

def run_argv(binary: str, mode: str, message: str = MESSAGE) -> list[str]:
    """The headless json invocation for one flag set, against the mock."""
    return [binary, "-p", "--mode", "json", *MODES[mode], "--provider", bench.MOCK_PROVIDER,
            "--model", bench.MOCK_MODEL, "--", message]


def is_agent_end(line: str) -> bool:
    """One stdout line is the run's `agent_end` event."""
    if '"agent_end"' not in line:
        return False
    try:
        return json.loads(line).get("type") == "agent_end"
    except (json.JSONDecodeError, AttributeError):
        return False


def exit_lag(sample: dict) -> float | None:
    """Seconds from the `agent_end` line to the OS exit, when both happened."""
    if sample.get("agentEndS") is None or sample.get("exitS") is None:
        return None
    return round(sample["exitS"] - sample["agentEndS"], 4)


def lag_summary(lags: list[float]) -> dict | None:
    """n/p50/p90/max of the per-run lags (None when there are none)."""
    ordered = sorted(lags)
    if not ordered:
        return None
    return {"n": len(ordered), "p50": round(bench.percentile(ordered, 50), 4),
            "p90": round(bench.percentile(ordered, 90), 4), "max": round(ordered[-1], 4)}


def mode_verdict(result: dict, threshold: float) -> list[str]:
    """Why one flag set fails (empty: it passes)."""
    problems: list[str] = []
    runs = [result["firstRun"], *result["samples"]]
    for sample in runs:
        label = "fresh-home first run" if sample is result["firstRun"] else f"run {sample['run']}"
        if not sample["ok"]:
            problems.append(f"{label} did not answer cleanly (exit {sample['exitCode']})")
        if sample["survivors"]:
            names = ", ".join(f"{entry['pid']} {entry['role']}" for entry in sample["survivors"])
            problems.append(f"{label} left sandbox processes alive: {names}")
    summary = result["summary"]
    if summary is None:
        problems.append("no warm run produced a lag")
    elif summary["p90"] >= threshold:
        problems.append(f"warm p90 lag {summary['p90']:.3f}s is not under {threshold}s")
    first_lag = result["firstRun"].get("lagS")
    if first_lag is None:
        problems.append("the fresh-home first run produced no lag")
    elif first_lag >= threshold:
        problems.append(f"fresh-home first run lag {first_lag:.3f}s is not under {threshold}s")
    return problems


# -- runs ----------------------------------------------------------------------------

def wait_gone(pid: int, grace: float) -> bool:
    """True once `pid` has exited (or is already gone), waiting at most
    `grace` seconds on the kernel's exit notification (pidfd on Linux,
    kqueue elsewhere), never polling."""
    if hasattr(os, "pidfd_open"):
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            return True
        try:
            readable, _, _ = select.select([fd], [], [], grace)
            return bool(readable)
        finally:
            os.close(fd)
    if hasattr(select, "kqueue"):
        queue = select.kqueue()
        try:
            event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                                  flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                  fflags=select.KQ_NOTE_EXIT)
            try:
                return bool(queue.control([event], 1, grace))
            except ProcessLookupError:
                return True
        finally:
            queue.close()
    return not bench.pid_alive(pid)


def survivors(sandbox: bench.Sandbox) -> list[dict]:
    """Sandbox processes still alive after the CLI exited (each given the
    grace to finish exiting first); any found are reaped."""
    found = bench.sandbox_processes(str(sandbox.home))
    lingering = [{"pid": pid, "role": bench.classify(pid, info), "cmd": info.get("cmd", "")[:120]}
                 for pid, info in sorted(found.items()) if not wait_gone(pid, SURVIVOR_GRACE_S)]
    if lingering:
        sandbox.reap()
    return lingering


def run_once(sandbox: bench.Sandbox, argv: list[str], mock: bench.MockProvider, run: int,
             timeout: float) -> dict:
    """One headless run: the `agent_end` line's time on stdout and the exit
    time from wait4, both from launch."""
    mark = mock.mark()
    stderr_path = sandbox.root / f"stderr-{run}.log"
    lines: list[str] = []
    agent_end: list[float] = []
    exited: dict = {}
    with open(stderr_path, "wb") as stderr:
        started = time.monotonic()
        proc = subprocess.Popen(argv, cwd=sandbox.work, env=sandbox.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        sandbox.add_root(proc.pid)

        def read() -> None:
            for raw in proc.stdout:
                line = raw.decode(errors="replace")
                lines.append(line)
                if not agent_end and is_agent_end(line):
                    agent_end.append(time.monotonic() - started)

        def wait() -> None:
            _, status, _ = os.wait4(proc.pid, 0)
            exited.update(at=time.monotonic() - started, status=status)

        reader = threading.Thread(target=read, daemon=True)
        waiter = threading.Thread(target=wait, daemon=True)
        reader.start()
        waiter.start()
        waiter.join(timeout)
        timed_out = waiter.is_alive()
        if timed_out:
            sandbox.reap()
            waiter.join(30)
        reader.join(30)
    if "status" in exited:
        proc.returncode = os.waitstatus_to_exitcode(exited["status"])
        sandbox.roots.pop(proc.pid, None)
    events = bench.json_events("".join(lines))
    final = bench.final_assistant(events) or {}
    posted = [entry for entry in mock.since(mark)
              if entry["path"].endswith(("/chat/completions", "/responses"))]
    ok = (not timed_out and proc.returncode == 0 and bool(agent_end) and bench.replied(final)
          and bool(posted) and bench.reply_text(final).strip() == bench.MOCK_REPLY)
    sample = {"run": run, "ok": ok, "exitCode": proc.returncode, "timedOut": timed_out,
              "agentEndS": round(agent_end[0], 4) if agent_end else None,
              "exitS": round(exited["at"], 4) if "at" in exited else None}
    sample["lagS"] = exit_lag(sample)
    if not ok:
        sample["stderrTail"] = stderr_path.read_text(errors="replace")[-2000:]
    sample["survivors"] = survivors(sandbox)
    return sample


def measure_mode(mode: str, args: argparse.Namespace, mock: bench.MockProvider,
                 base: Path, uv_cache: str | None) -> dict:
    sandbox = bench.Sandbox("rs", f"exit-{mode}", base, mock.base_url, uv_cache)
    argv = run_argv(args.binary, mode)
    try:
        first = run_once(sandbox, argv, mock, run=-1, timeout=args.first_run_timeout)
        report_run(mode, "fresh-home first run", first)
        samples = []
        for run in range(args.runs):
            sample = run_once(sandbox, argv, mock, run=run, timeout=args.run_timeout)
            report_run(mode, f"run {run:2d}", sample)
            samples.append(sample)
    finally:
        sandbox.teardown()
    lags = [sample["lagS"] for sample in samples if sample["ok"] and sample["lagS"] is not None]
    return {"mode": mode, "flags": list(MODES[mode]), "firstRun": first, "samples": samples,
            "summary": lag_summary(lags)}


def report_run(mode: str, label: str, sample: dict) -> None:
    lag = "-" if sample["lagS"] is None else f"{sample['lagS']:.3f}s"
    end = "-" if sample["agentEndS"] is None else f"{sample['agentEndS']:.3f}s"
    done = "-" if sample["exitS"] is None else f"{sample['exitS']:.3f}s"
    extra = "" if not sample["survivors"] else f" survivors={len(sample['survivors'])}"
    print(f"[{mode}] {label}: agent_end {end} exit {done} lag {lag} ok={sample['ok']}{extra}",
          flush=True)


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--binary", required=True, help="the prime-agent binary to run (explicit)")
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS, help="warm runs per flag set")
    parser.add_argument("--modes", default="default,sol",
                        help=f"comma-separated flag sets ({', '.join(MODES)})")
    parser.add_argument("--threshold", type=float, default=THRESHOLD_S,
                        help="p90 (and fresh-home) exit lag bound, seconds")
    parser.add_argument("--sandbox-base", default="/tmp",
                        help="where the fresh sandboxes go (default /tmp)")
    parser.add_argument("--run-timeout", type=float, default=120.0,
                        help="failure bound for one warm run, seconds")
    parser.add_argument("--first-run-timeout", type=float, default=900.0,
                        help="failure bound for the fresh-home first run (kernel setup), seconds")
    parser.add_argument("--json-out", help="also write the full result as JSON here")
    args = parser.parse_args(argv)
    args.binary = os.path.abspath(args.binary)
    if not os.access(args.binary, os.X_OK):
        parser.error(f"--binary {args.binary} is not an executable file")
    args.modes = [mode.strip() for mode in args.modes.split(",") if mode.strip()]
    unknown = [mode for mode in args.modes if mode not in MODES]
    if unknown or not args.modes:
        parser.error(f"--modes takes {', '.join(MODES)}; got {args.modes}")
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    base = Path(os.path.abspath(args.sandbox_base))
    base.mkdir(parents=True, exist_ok=True)
    mock = bench.MockProvider()
    uv_cache = bench.uv_cache_dir()
    results = []
    try:
        for mode in args.modes:
            results.append(measure_mode(mode, args, mock, base, uv_cache))
    finally:
        mock.close()
        bench.teardown_all()
    verdicts = {}
    for result in results:
        problems = mode_verdict(result, args.threshold)
        verdicts[result["mode"]] = problems
        summary = result["summary"] or {}
        print(f"[{result['mode']}] warm runs: n={summary.get('n')} p50={summary.get('p50')}s "
              f"p90={summary.get('p90')}s max={summary.get('max')}s; "
              f"fresh-home first run lag={result['firstRun']['lagS']}s "
              f"(answer at {result['firstRun']['agentEndS']}s)")
        for problem in problems:
            print(f"[{result['mode']}] FAIL: {problem}")
    passed = all(not problems for problems in verdicts.values())
    print(f"verdict: {'PASS' if passed else 'FAIL'} (threshold {args.threshold}s, binary {args.binary})")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(
            {"binary": args.binary, "threshold": args.threshold, "machine": bench.machine_facts(),
             "results": results, "verdicts": verdicts, "passed": passed}, indent=2) + "\n")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
