#!/usr/bin/env python3
"""Contract tests for scripts/oneiron/verify_headless_exit.py's pure parts and
its exit wait (run: python3 -m unittest scripts/oneiron/test_verify_headless_exit.py).
No product is run."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_headless_exit as verify  # noqa: E402


def sample(run: int, agent_end: float | None, exit_at: float | None, ok: bool = True,
           survivors: list | None = None, stdout_eof: bool = True,
           telemetry: dict | None = None) -> dict:
    entry = {"run": run, "ok": ok, "exitCode": 0 if ok else 1, "agentEndS": agent_end,
             "exitS": exit_at, "survivors": survivors or [], "stdoutEof": stdout_eof}
    if telemetry is not None:
        entry["telemetry"] = telemetry
    entry["lagS"] = verify.exit_lag(entry)
    return entry


class PureParts(unittest.TestCase):
    def test_run_argv_per_flag_set(self) -> None:
        self.assertEqual(verify.run_argv("/bin/pa", "default"),
                         ["/bin/pa", "-p", "--mode", "json", "--provider", "mock", "--model", "mock-1",
                          "--", "say hi"])
        self.assertEqual(verify.run_argv("/bin/pa", "sol"),
                         ["/bin/pa", "-p", "--mode", "json", "--no-session", "--no-tools", "--no-skills",
                          "--no-extensions", "--no-prompt-templates", "--no-themes", "--provider", "mock",
                          "--model", "mock-1", "--", "say hi"])

    def test_agent_end_detection(self) -> None:
        self.assertTrue(verify.is_agent_end('{"type":"agent_end","messages":[]}\n'))
        self.assertFalse(verify.is_agent_end('{"type":"message_end","note":"agent_end"}\n'))
        self.assertFalse(verify.is_agent_end('"agent_end" but not json\n'))
        self.assertFalse(verify.is_agent_end('["agent_end"]\n'))

    def test_exit_lag(self) -> None:
        self.assertEqual(verify.exit_lag({"agentEndS": 0.25, "exitS": 0.4}), 0.15)
        self.assertIsNone(verify.exit_lag({"agentEndS": None, "exitS": 0.4}))
        self.assertIsNone(verify.exit_lag({"agentEndS": 0.25, "exitS": None}))

    def test_lag_summary(self) -> None:
        self.assertIsNone(verify.lag_summary([]))
        self.assertEqual(verify.lag_summary([0.1, 0.3, 0.2, 0.4, 0.05]),
                         {"n": 5, "p50": 0.2, "p90": 0.36, "max": 0.4})

    def test_verdict_passes_fast_clean_runs(self) -> None:
        samples = [sample(run, 0.1, 0.15) for run in range(20)]
        result = {"firstRun": sample(-1, 30.0, 30.2), "samples": samples,
                  "summary": verify.lag_summary([entry["lagS"] for entry in samples])}
        self.assertEqual(verify.mode_verdict(result, 0.5), [])

    def test_verdict_names_every_failure(self) -> None:
        samples = [sample(run, 0.1, 1.1) for run in range(3)]
        samples.append(sample(3, None, 0.5, ok=False))
        samples.append(sample(4, 0.1, 0.2, survivors=[{"pid": 42, "role": "bootstrap", "cmd": "uv pip"}]))
        samples.append(sample(5, 0.1, 0.2, stdout_eof=False))
        samples.append(sample(6, 0.1, 0.2, telemetry={"kernel bootstrap": 1}))
        result = {"firstRun": sample(-1, 0.5, 44.0), "samples": samples,
                  "summary": verify.lag_summary([1.0, 1.0, 1.0, 0.1, 0.1, 0.1])}
        self.assertEqual(verify.mode_verdict(result, 0.5), [
            "run 3 did not answer cleanly (exit 1)",
            "run 4 left processes alive: 42 bootstrap",
            "run 5 left stdout open after the CLI exited",
            "run 6 recorded 0 'agent headless invoked' events, not 1",
            "warm p90 lag 1.000s is not under 0.5s",
            "fresh-home first run lag 43.500s is not under 0.5s",
        ])

    def test_telemetry_counts(self) -> None:
        lines = ['{"name":"agent headless invoked","properties":{}}', "not json", "[]",
                 '{"name":"kernel bootstrap"}', '{"event":"agent headless invoked"}', '{"name":7}']
        self.assertEqual(verify.telemetry_counts(lines),
                         {"agent headless invoked": 2, "kernel bootstrap": 1})


class WaitGone(unittest.TestCase):
    def test_waits_on_the_exit_notification(self) -> None:
        child = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"],
                                 stdin=subprocess.PIPE)
        try:
            self.assertFalse(verify.wait_gone(child.pid, 0))
            child.stdin.close()
            self.assertTrue(verify.wait_gone(child.pid, 30))
        finally:
            child.wait()
        # Reaped: the pid no longer names a process.
        self.assertTrue(verify.wait_gone(child.pid, 0))


if __name__ == "__main__":
    unittest.main()
