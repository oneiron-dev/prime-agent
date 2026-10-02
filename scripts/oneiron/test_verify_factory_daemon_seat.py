#!/usr/bin/env python3
"""Tests for the pure parts of scripts/oneiron/verify_factory_daemon_seat.py
(run: python3 scripts/oneiron/test_verify_factory_daemon_seat.py). Nothing here starts a binary, daemon or factory."""

from __future__ import annotations

import errno
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_factory_daemon_seat as verifier  # noqa: E402

KEY = "seat-one"
SEAT_ARGV = ["-p", "--mode", "json", "--json-event-profile", "factory-completed", "--daemon-hosted", "--offline",
             "--provider", "faux", "--model", "faux-1", "--thinking", "low", "--cwd", "/w", "--no-extensions",
             "--no-skills"]
ENDED = '{"type":"agent_start"}\n{"type":"agent_end"}\n'
TOOL_RESULT = json.dumps({"type": "message_end", "message": {"role": "toolResult", "toolName": "ipython",
                                                             "isError": False, "content": []}})
WRITER_LOG = f'{{"type":"agent_start"}}\n{TOOL_RESULT}\n{{"type":"agent_end"}}\n'


def passing_inputs() -> dict:
    """What a closed ticket on four daemon seats leaves behind."""
    return {
        "status": {
            "tickets": [{"id": KEY, "state": "RETIRED"}],
            "actions": [{"id": f"{KEY}:submit", "state": "ACCEPTED"}, {"id": f"{KEY}:merge", "state": "ACCEPTED"}],
        },
        "ticket_state": {"merged": True},
        "calls": [{"argv": SEAT_ARGV, "stage": stage} for stage in ("pack", "writer", "review", "review")],
        "seat_logs": {"pack.jsonl": ENDED, "write.r1.jsonl": WRITER_LOG, "review-grok.jsonl": ENDED,
                      "review-opus.jsonl": ENDED},
        "daemon_rows": [{"workerState": "ready", "isStreaming": False, "sessionFile": f"/s/{n}.jsonl"}
                        for n in range(4)],
        "worker_offline": {"11": "1", "12": "1"},
        "merged_source": "pub fn add_one(x: u8) -> u8 { x + 1 }\npub fn seat_one() -> u8 { 1 }\n",
    }


def evaluate(**overrides) -> list[str]:
    inputs = passing_inputs()
    inputs.update(overrides)
    return verifier.evaluate(inputs["status"], inputs["ticket_state"], inputs["calls"], inputs["seat_logs"],
                             inputs["daemon_rows"], inputs["worker_offline"], inputs["merged_source"], KEY)


class StageTests(unittest.TestCase):
    def test_each_ticket_prompt_names_its_stage(self):
        prompts = {
            "Ticket seat-one: Add\n\nTask (read-only): build the context pack for the writer": "pack",
            "Ticket seat-one: Add\nContext pack: .w7/CONTEXT.md (Muse wrote it; read it first).": "writer",
            "Review this diff for ticket seat-one (Add) against its contract": "review",
            "Continue the same ticket. The last line of your final reply": "continue",
            "Reply to EVERY bot comment": None,
        }
        self.assertEqual({prompt: verifier.stage_of(prompt) for prompt in prompts}, prompts)

    def test_every_stage_reply_is_terminal_for_its_stage(self):
        self.assertEqual(
            {stage: verifier.stage_reply(stage, KEY).splitlines()[-1] for stage in ("writer", "continue")},
            {"writer": f"DONE {KEY}", "continue": f"DONE {KEY}"},
        )
        self.assertEqual(verifier.stage_reply("review", KEY).splitlines()[0], "VERDICT: LANDABLE")
        self.assertTrue(verifier.stage_reply("pack", KEY).startswith("PACK: "))
        self.assertEqual(verifier.function_name("OF-1.seat-one"), "of_1_seat_one")

    def test_the_writer_edits_through_its_kernel_before_it_answers(self):
        script = verifier.stage_script("writer", KEY, "/wt/seat-one")
        call = script["responses"][0]["content"][0]
        self.assertEqual(
            [script["engine"], call["name"], script["responses"][1]],
            ["faux", "ipython", verifier.stage_reply("writer", KEY)],
        )
        self.assertEqual(
            call["arguments"]["code"],
            "open('/wt/seat-one/crates/alpha/src/lib.rs', 'a').write('pub fn seat_one() -> u8 { 1 }\\n')\n"
            "print('edited alpha')",
        )
        self.assertEqual(verifier.stage_script("review", KEY, "/wt/seat-one"),
                         {"engine": "faux", "responses": [verifier.stage_reply("review", KEY)]})

    def test_the_seat_wrapper_is_valid_python(self):
        source = verifier.seat_wrapper_source("/usr/bin/python3", HERE / "verify_factory_daemon_seat.py", {
            "root": "/sb", "key": KEY, "binary": "/bin/prime-agent", "env": {"HOME": "/sb/home"}})
        self.assertTrue(source.startswith("#!/usr/bin/python3\n"))
        compile(source, "prime-agent-seat", "exec")
        self.assertIn(json.dumps({"root": "/sb", "key": KEY, "binary": "/bin/prime-agent",
                                  "env": {"HOME": "/sb/home"}}), source)


class EvaluateTests(unittest.TestCase):
    def test_a_closed_ticket_on_resident_daemon_seats_passes(self):
        self.assertEqual(evaluate(), [])

    def test_an_open_ticket_and_unaccepted_actions_fail(self):
        self.assertEqual(
            evaluate(status={"tickets": [{"id": KEY, "state": "ACTIVE"}],
                             "actions": [{"id": f"{KEY}:submit", "state": "ACCEPTED"},
                                         {"id": f"{KEY}:merge", "state": "REJECTED"}]},
                     ticket_state={"merged": False}),
            [f"ticket {KEY} is 'ACTIVE', not RETIRED", f"action {KEY}:merge is 'REJECTED', not ACCEPTED",
             "the ticket state does not record merged: true"],
        )

    def test_a_seat_without_the_daemon_flags_or_with_an_unknown_prompt_fails(self):
        owned = [arg for arg in SEAT_ARGV if arg not in ("--daemon-hosted", "--no-skills")]
        calls = [{"argv": owned, "stage": "pack"}, {"argv": SEAT_ARGV, "stage": None, "prompt_head": "hello"},
                 *passing_inputs()["calls"][2:]]
        self.assertEqual(evaluate(calls=calls), [
            "a pack seat call lacks --daemon-hosted, --no-skills",
            "a seat call had an unexpected prompt: 'hello'",
        ])

    def test_a_stream_without_agent_end_fails(self):
        logs = dict(passing_inputs()["seat_logs"], **{"pack.jsonl": '{"type":"agent_start"}\nnot json\n'})
        self.assertEqual(evaluate(seat_logs=logs), ["seat log pack.jsonl never reached agent_end"])
        self.assertTrue(verifier.stream_reached_agent_end('noise\n=== argv\n{"type":"agent_end"}\n'))

    def test_daemon_sessions_must_stay_resident_and_idle(self):
        rows = passing_inputs()["daemon_rows"]
        rows[1] = {"workerState": "failed", "isStreaming": False, "sessionFile": "/s/1.jsonl"}
        self.assertEqual(evaluate(daemon_rows=rows), [
            "daemon session /s/1.jsonl is not resident and idle: workerState='failed' isStreaming=False"])
        self.assertEqual(evaluate(daemon_rows=rows[:3]), [
            "the daemon holds 3 sessions for 4 seat sessions",
            "daemon session /s/1.jsonl is not resident and idle: workerState='failed' isStreaming=False",
        ])

    def test_a_continued_seat_reuses_its_session(self):
        calls = [*passing_inputs()["calls"], {"argv": [*SEAT_ARGV, "-c"], "stage": "continue"}]
        self.assertEqual(evaluate(calls=calls), [])

    def test_a_writer_whose_tool_failed_or_whose_edit_is_missing_fails(self):
        failed = TOOL_RESULT.replace('"isError": false', '"isError": true')
        logs = dict(passing_inputs()["seat_logs"], **{"write.r1.jsonl": f"{failed}\n{ENDED}"})
        self.assertEqual(evaluate(seat_logs=logs, merged_source="pub fn add_one(x: u8) -> u8 { x + 1 }\n"), [
            "the writer's seat log shows no successful ipython call",
            "the published branch does not carry the writer's edit",
        ])

    def test_a_worker_without_pi_offline_fails(self):
        self.assertEqual(evaluate(worker_offline={"11": "1", "12": None}),
                         ["seat worker 12 runs with PI_OFFLINE=None"])


class TeardownTests(unittest.TestCase):
    def setUp(self):
        # The probe processes carry a sandbox-like marker in their environment, off the shared temp dir.
        cache = Path.home() / ".cache" / "pa-sb"
        cache.mkdir(parents=True, exist_ok=True)
        self.marker = tempfile.mkdtemp(prefix="vfds-test-", dir=cache)
        self.addCleanup(shutil.rmtree, self.marker, True)

    def spawn(self, *argv: str) -> subprocess.Popen:
        child = subprocess.Popen(list(argv), env={"PATH": "/usr/bin:/bin", "HOME": self.marker})
        self.addCleanup(self.reap, child)
        return child

    @staticmethod
    def reap(child: subprocess.Popen) -> None:
        if child.poll() is None:
            child.kill()
        child.wait()

    def held(self, child: subprocess.Popen) -> verifier.ProcessHandle:
        handle = verifier.ProcessHandle.acquire(child.pid, self.marker)
        self.assertIsNotNone(handle, "the sandbox process is found with its identity")
        self.addCleanup(handle.close)
        return handle

    def test_an_exit_is_awaited_and_a_live_process_only_bounds_out(self):
        live = self.spawn("sleep", "30")
        handle = self.held(live)
        self.assertFalse(handle.exited(0.2))
        live.kill()
        self.assertTrue(handle.exited(30))
        # A process that outlives the bound is killed through the identity held since it was found.
        stuck = self.spawn("sleep", "30")
        self.assertFalse(self.held(stuck).stop(0.2))
        self.assertEqual(stuck.wait(timeout=30), -9)

    def test_a_process_of_another_sandbox_is_not_acquired(self):
        child = self.spawn("sleep", "30")
        self.assertIsNone(verifier.ProcessHandle.acquire(child.pid, self.marker + "-other"))

    def test_only_a_vanished_process_reads_as_absent(self):
        # A pidfd failure that is not the process's disappearance (EMFILE here) leaves the teardown unproven, never
        # an empty sandbox; a vanished process is simply absent.
        vanished = OSError(errno.ESRCH, "No such process")
        exhausted = OSError(errno.EMFILE, "Too many open files")
        with mock.patch.object(verifier.os, "pidfd_open", side_effect=ProcessLookupError(*vanished.args),
                               create=True):
            self.assertIsNone(verifier.ProcessHandle.acquire(4242, self.marker))
        with mock.patch.object(verifier.os, "pidfd_open", side_effect=exhausted, create=True):
            with self.assertRaisesRegex(RuntimeError, "cannot hold process 4242"):
                verifier.ProcessHandle.acquire(4242, self.marker)

    def test_a_stale_identity_is_never_signalled(self):
        # The pid now belongs to a process that did not start when the recorded one did (a recycled pid): the kill
        # sends nothing, so the SIGTERM sent after it is what ends the process.
        child = self.spawn("sleep", "30")
        stale = verifier.ProcessHandle(child.pid, None, "Thu Jan  1 00:00:00 1970")
        stale.kill()
        self.assertTrue(stale.exited(0), "the recorded process is gone")
        child.terminate()
        self.assertEqual(child.wait(timeout=30), -15)

    def test_a_ps_line_reads_as_pid_start_and_command(self):
        self.assertEqual(verifier.parse_ps_line("  4242 Thu Oct  3 12:00:00 2026 /bin/sleep 30 HOME=/h"),
                         (4242, "Thu Oct 3 12:00:00 2026", "/bin/sleep 30 HOME=/h"))
        self.assertIsNone(verifier.parse_ps_line("PID STARTED COMMAND"))
        self.assertIsNone(verifier.parse_ps_line(""))

    def test_a_sandbox_root_under_the_shared_tmp_is_refused(self):
        shared = Path(os.path.realpath("/tmp"))
        link = Path(self.marker) / "into-tmp"
        link.symlink_to("/tmp")
        for root in (Path("/tmp"), Path("/tmp/pa-sb"), shared / "pa-sb", link, link / "pa-sb"):
            with self.assertRaises(SystemExit, msg=str(root)):
                verifier.refuse_shared_tmp(root)
        verifier.refuse_shared_tmp(Path.home() / ".cache" / "pa-sb")

    def test_a_process_started_for_the_sandbox_is_found_and_reaped(self):
        child = self.spawn("sleep", "30")
        handles = verifier.sandbox_processes(Path(self.marker))
        try:
            self.assertEqual([handle.pid for handle in handles], [child.pid])
        finally:
            for handle in handles:
                handle.close()
        # Once it is gone, the reap proves the sandbox empty with its scan.
        child.kill()
        child.wait()
        self.assertEqual(verifier.reap_sandbox(Path(self.marker)), [])


if __name__ == "__main__":
    unittest.main()
