#!/usr/bin/env python3
"""Tests for the pure parts of scripts/oneiron/verify_factory_daemon_seat.py
(run: python3 scripts/oneiron/test_verify_factory_daemon_seat.py). Nothing here starts a binary, daemon or factory."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_factory_daemon_seat as verifier  # noqa: E402

KEY = "seat-one"
SEAT_ARGV = ["-p", "--mode", "json", "--json-event-profile", "factory-completed", "--daemon-hosted", "--offline",
             "--provider", "faux", "--model", "faux-1", "--thinking", "low", "--cwd", "/w", "--no-extensions",
             "--no-skills"]
ENDED = '{"type":"agent_start"}\n{"type":"agent_end"}\n'


def passing_inputs() -> dict:
    """What a closed ticket on four daemon seats leaves behind."""
    return {
        "status": {
            "tickets": [{"id": KEY, "state": "RETIRED"}],
            "actions": [{"id": f"{KEY}:submit", "state": "ACCEPTED"}, {"id": f"{KEY}:merge", "state": "ACCEPTED"}],
        },
        "ticket_state": {"merged": True},
        "calls": [{"argv": SEAT_ARGV, "stage": stage} for stage in ("pack", "writer", "review", "review")],
        "seat_logs": {name: ENDED for name in ("pack.jsonl", "write.r1.jsonl", "review-grok.jsonl",
                                               "review-opus.jsonl")},
        "daemon_rows": [{"workerState": "ready", "isStreaming": False, "sessionFile": f"/s/{n}.jsonl"}
                        for n in range(4)],
        "worker_offline": {"11": "1", "12": "1"},
    }


def evaluate(**overrides) -> list[str]:
    inputs = passing_inputs()
    inputs.update(overrides)
    return verifier.evaluate(inputs["status"], inputs["ticket_state"], inputs["calls"], inputs["seat_logs"],
                             inputs["daemon_rows"], inputs["worker_offline"], KEY)


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
        logs = dict(passing_inputs()["seat_logs"], **{"write.r1.jsonl": '{"type":"agent_start"}\nnot json\n'})
        self.assertEqual(evaluate(seat_logs=logs), ["seat log write.r1.jsonl never reached agent_end"])
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

    def test_a_worker_without_pi_offline_fails(self):
        self.assertEqual(evaluate(worker_offline={"11": "1", "12": None}),
                         ["seat worker 12 runs with PI_OFFLINE=None"])


if __name__ == "__main__":
    unittest.main()
