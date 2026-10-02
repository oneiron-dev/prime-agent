#!/usr/bin/env python3
"""Contract tests for scripts/oneiron/bench_side_by_side.py's helpers
(run: python3 scripts/oneiron/test_bench_side_by_side.py). No product is run."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bench_side_by_side as bench  # noqa: E402

# A sleeper whose environment `ps -E` can read on macOS: the OS hides it for
# platform binaries such as /bin/sleep, and the sandbox match needs HOME=.
SLEEPER = [sys.executable, "-c", "import time; time.sleep(30)"]

TS_READY = """
   ▗█▛▐█▙   ▗▄█▀▗█▀       prime agent v0.9.6-oneiron.20261001.1
  ▗█▛ ▟██▙▄██▛ ▟▛         model mock-1
 >
← manage                                                                     mock-1 · 0 (0%)
"""
TS_BINDING = """
   ▗█▛▐█▙   ▗▄█▀▗█▀       prime agent v0.9.6-oneiron.20261001.1
  ▗█▛ ▟██▙▄██▛ ▟▛         model —
 >
← manage
"""


# A stand-in product for run_headless: reads the sandbox models.json the way
# the real ones do, calls the mock unless told not to, prints JSON events
# with the reply it was given (argv[2]), or the failure its mode names.
FAKE_PRODUCT = """
import json, os, sys, urllib.request
mode, reply = sys.argv[1], sys.argv[2]
models = json.load(open(os.path.join(os.environ["HOME"], ".prime/agent/models.json")))
if mode != "no-call":
    url = models["providers"]["mock"]["baseUrl"] + "/chat/completions"
    body = json.dumps({"model": "mock-1", "messages": [{"role": "user", "content": "hi"}]}).encode()
    urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=10).read()
print(json.dumps({"type": "agent_start"}), flush=True)
if mode != "no-assistant":
    stop = {"error": "error", "length": "length"}.get(mode, "stop")
    text = "something else" if mode == "wrong-text" else reply
    message = {"role": "assistant", "stopReason": stop, "content": [{"type": "text", "text": text}]}
    print(json.dumps({"type": "message_end", "message": message}), flush=True)
print(json.dumps({"type": "agent_end", "messages": []}), flush=True)
sys.exit(3 if mode == "exit" else 0)
"""


def sse_events(frames: list[bytes]) -> list[dict | str]:
    out: list[dict | str] = []
    for frame in frames:
        text = frame.decode()
        assert text.endswith("\n\n"), text
        data = [line[len("data: "):] for line in text.splitlines() if line.startswith("data: ")]
        assert len(data) == 1, text
        out.append(data[0] if data[0] == "[DONE]" else json.loads(data[0]))
    return out


class StatsTests(unittest.TestCase):
    def test_summary_median_p90_and_bounds(self) -> None:
        summary = bench.summarize([5, 1, 3, 2, 4, None])
        self.assertEqual(summary["n"], 5)
        self.assertEqual(summary["median"], 3)
        self.assertEqual((summary["min"], summary["max"]), (1, 5))
        self.assertAlmostEqual(summary["p90"], 4.6)
        self.assertEqual(summary["mean"], 3)

    def test_summary_of_nothing_is_none(self) -> None:
        self.assertIsNone(bench.summarize([]))
        self.assertIsNone(bench.summarize([None]))
        self.assertEqual(bench.summarize([7])["p90"], 7)

    def test_interleaving_alternates_the_product_order(self) -> None:
        self.assertEqual(bench.interleaved(3, ["ts", "rs"]),
                         [(0, "ts"), (0, "rs"), (1, "rs"), (1, "ts"), (2, "ts"), (2, "rs")])


class MockProviderTests(unittest.TestCase):
    def test_chat_completion_stream_ends_with_usage_and_done(self) -> None:
        events = sse_events(bench.chat_completion_stream("mock-1", 1234))
        self.assertEqual(events[-1], "[DONE]")
        usage = events[-2]["usage"]
        self.assertEqual(usage["prompt_tokens"], 1234)
        self.assertEqual(events[-2]["choices"], [])
        self.assertEqual(events[-3]["choices"][0]["finish_reason"], "stop")
        text = "".join(event["choices"][0]["delta"].get("content", "") for event in events[:-2])
        self.assertEqual(text, bench.MOCK_REPLY)
        self.assertTrue(all(event["model"] == "mock-1" for event in events[:-1]))

    def test_responses_stream_runs_created_to_completed(self) -> None:
        frames = bench.responses_stream("mock-1", 99)
        names = [frame.decode().split("\n", 1)[0].removeprefix("event: ") for frame in frames]
        self.assertEqual(names[0], "response.created")
        self.assertEqual(names[-1], "response.completed")
        events = sse_events(frames)
        self.assertEqual([event["type"] for event in events], names)
        self.assertEqual([event["sequence_number"] for event in events], list(range(len(events))))
        done = events[-1]["response"]
        self.assertEqual((done["model"], done["status"]), ("mock-1", "completed"))
        self.assertEqual(done["usage"]["input_tokens"], 99)
        deltas = "".join(event["delta"] for event in events if event["type"] == "response.output_text.delta")
        self.assertEqual(deltas, bench.MOCK_REPLY)

    def test_server_streams_and_logs_every_request(self) -> None:
        mock = bench.MockProvider()
        try:
            body = json.dumps({"model": "mock-1", "stream": True,
                               "messages": [{"role": "user", "content": "hi"}] * 3}).encode()
            request = urllib.request.Request(f"{mock.base_url}/chat/completions", data=body,
                                             headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                self.assertEqual(response.headers["Content-Type"], "text/event-stream")
                payload = response.read().decode()
            self.assertTrue(payload.rstrip().endswith("data: [DONE]"))
            request = urllib.request.Request(f"{mock.base_url}/responses", data=b'{"input": [1, 2]}')
            with urllib.request.urlopen(request, timeout=10) as response:
                self.assertIn("response.completed", response.read().decode())
            with urllib.request.urlopen(f"{mock.base_url}/models", timeout=10) as response:
                self.assertEqual(json.loads(response.read())["data"][0]["id"], "mock-1")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(urllib.request.Request(f"{mock.base_url}/nope", data=b"{}"), timeout=10)
            caught.exception.close()
            log = mock.since(0)
            self.assertEqual(log[0], {"path": "/v1/chat/completions", "bytes": len(body), "messages": 3})
            self.assertEqual(log[1]["messages"], 2)
            self.assertEqual(mock.since(mock.mark()), [])
        finally:
            mock.close()

    def test_models_json_entry_is_the_brief_shape(self) -> None:
        entry = bench.mock_provider_entry("http://127.0.0.1:9/v1")
        self.assertEqual((entry["api"], entry["apiKey"]), ("openai-completions", "mock"))
        self.assertEqual([model["id"] for model in entry["models"]], ["mock-1"])
        self.assertEqual(entry["models"][0]["contextWindow"], 200000)


class CorpusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = bench.build_corpus("/w", "019f0000-0000-7000-8000-000000000001")

    def test_corpus_is_deterministic(self) -> None:
        self.assertEqual(self.rows, bench.build_corpus("/w", "019f0000-0000-7000-8000-000000000001"))
        self.assertNotEqual(self.rows, bench.build_corpus("/w", "019f0000-0000-7000-8000-000000000001", seed=1))

    def test_header_and_row_count(self) -> None:
        header = self.rows[0]
        self.assertEqual((header["type"], header["version"], header["cwd"]), ("session", 3, "/w"))
        messages = [row for row in self.rows if row["type"] == "message"]
        self.assertIn(len(messages), (1100, 1101))
        roles = {row["message"]["role"] for row in messages}
        self.assertEqual(roles, {"user", "assistant", "toolResult"})

    def test_rows_form_one_parent_chain(self) -> None:
        ids = [row["id"] for row in self.rows[1:]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIsNone(self.rows[1]["parentId"])
        for previous, row in zip(self.rows[1:], self.rows[2:]):
            self.assertEqual(row["parentId"], previous["id"])

    def test_every_tool_call_is_answered_next(self) -> None:
        messages = [row["message"] for row in self.rows if row["type"] == "message"]
        for index, message in enumerate(messages):
            calls = [block for block in message["content"] if block.get("type") == "toolCall"]
            if calls:
                self.assertEqual(message["stopReason"], "toolUse")
                result = messages[index + 1]
                self.assertEqual((result["role"], result["toolCallId"], result["toolName"]),
                                 ("toolResult", calls[0]["id"], "ipython"))
        self.assertEqual((messages[-1]["role"], messages[-1]["stopReason"]), ("assistant", "stop"))

    def test_transcript_fits_the_mock_window(self) -> None:
        text = "".join(json.dumps(row) + "\n" for row in self.rows)
        facts = bench.corpus_facts(self.rows, text)
        self.assertLess(facts["estTokens"], 120000)
        last_usage = [row["message"]["usage"] for row in self.rows
                      if row["type"] == "message" and row["message"]["role"] == "assistant"][-1]
        # TS compacts above contextWindow - reserveTokens (200k - 16384).
        self.assertLess(last_usage["totalTokens"], 200000 - 16384)
        self.assertGreater(facts["bytes"], 500000)


class FrameAndRoleTests(unittest.TestCase):
    def test_ready_needs_prompt_bar_and_bound_model(self) -> None:
        self.assertTrue(bench.is_ready(TS_READY))
        self.assertFalse(bench.is_ready(TS_BINDING))
        self.assertFalse(bench.is_ready(TS_READY.replace(" >\n", " > hello\n")))
        self.assertFalse(bench.is_ready(""))

    def test_roles(self) -> None:
        def info(cmd: str, *env: str) -> dict:
            return {"cmd": cmd, "env": set(env), "name": cmd.split(" ")[0]}

        self.assertEqual(bench.classify(7, info("prime-agent"), tui_pid=7), "tui")
        self.assertEqual(bench.classify(8, info("prime-agent", "PI_CODING_AGENT=true")), "daemon")
        self.assertEqual(bench.classify(8, info("prime-agent", "PI_CODING_AGENT=true",
                                                "PRIME_AGENT_INTERNAL_DAEMON_WORKER=1")), "worker")
        self.assertEqual(bench.classify(9, info("/x/prime-agent --mode daemon --daemon-socket /s")), "daemon")
        self.assertEqual(bench.classify(9, info("/x/prime-agent worker")), "worker")
        self.assertEqual(bench.classify(9, info("/h/kernel-venv/bin/python -m rlm.repl")), "kernel")
        self.assertEqual(bench.classify(9, info("/home/u/.local/bin/uv pip install x")), "bootstrap")
        self.assertEqual(bench.classify(9, info("fd --version")), "other")

    def test_mac_table_reads_argv_apart_from_the_environment(self) -> None:
        # `ps -E` puts the environment in the command column. The sandbox env carries
        # UV_CACHE_DIR=<home>/.cache/uv, which the bootstrap rule must not read as a uv argv.
        start, later = "Thu Oct  2 02:47:53 2026", "Thu Oct  2 02:49:01 2026"
        daemon = "/r/prime-agent --mode daemon --daemon-socket /tmp/pb.x/t/prime-agent-user/daemon.sock"
        env = "HOME=/tmp/pb.x/h TMPDIR=/tmp/pb.x/t UV_CACHE_DIR=/Users/u/.cache/uv"
        rows = {  # pid: (lstart in the -E call, argv, environment, lstart in the argv call or None)
            101: (start, daemon, env, start),
            102: (start, "/r/prime-agent", env + " PRIME_AGENT_INTERNAL_DAEMON_WORKER=1", start),
            103: (start, "/Users/u/.local/bin/uv pip install x", env, start),
            104: (start, "/r/prime-agent --mode daemon", env, None),        # gone before the argv call
            105: (start, "/r/prime-agent --mode daemon", env, later),       # pid reused between the calls
        }
        with_env = [f"{pid} 1 2048 S {s} {argv} {e}" for pid, (s, argv, e, _) in rows.items()]
        with_env.append(f"106 1 0 Z {start} /r/zombie {env}")
        argv_only = [f"{pid} {a} {argv}" for pid, (_, argv, _, a) in rows.items() if a]
        # Same pid and start, but the argv is not the -E column's prefix (retitled between the calls).
        with_env.append(f"107 1 2048 S {start} /r/prime-agent --mode daemon {env}")
        argv_only.append(f"107 {start} node /x/cli.js")
        # A retitled process: its padded title replaces argv and hides the environment in both calls.
        with_env.append(f"108 1 2048 S {start} prime-agent      ")
        argv_only.append(f"108 {start} prime-agent      ")

        def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess:
            lines = with_env if "-E" in command else argv_only
            return subprocess.CompletedProcess(command, 0, "\n".join(lines) + "\n", "")

        with unittest.mock.patch.object(bench.subprocess, "run", fake_run):
            table = bench._mac_table()
        self.assertEqual(sorted(table), [101, 102, 103, 104, 105, 107, 108])
        self.assertEqual(table[101]["cmd"], daemon)
        self.assertEqual(table[101]["ident"], "Thu Oct 2 02:47:53 2026")
        self.assertLessEqual({"HOME=/tmp/pb.x/h", "TMPDIR=/tmp/pb.x/t", "UV_CACHE_DIR=/Users/u/.cache/uv"},
                             table[101]["env"])
        self.assertEqual(bench.classify(101, table[101]), "daemon")
        self.assertEqual(bench.classify(102, table[102]), "worker")
        self.assertEqual(bench.classify(103, table[103]), "bootstrap")
        # No trustworthy argv: the -E column stays the command, as before.
        self.assertTrue(table[104]["cmd"].endswith("UV_CACHE_DIR=/Users/u/.cache/uv"))
        self.assertTrue(table[105]["cmd"].endswith("UV_CACHE_DIR=/Users/u/.cache/uv"))
        self.assertTrue(table[107]["cmd"].endswith("UV_CACHE_DIR=/Users/u/.cache/uv"))
        self.assertEqual(table[108]["cmd"], "prime-agent")
        self.assertEqual(bench.classify(108, table[108]), "cli")

    def test_json_events_and_final_assistant(self) -> None:
        stream = "\n".join([
            "not json",
            json.dumps({"type": "message_end", "message": {"role": "user"}}),
            json.dumps({"type": "message_end", "message": {"role": "assistant", "responseModel": "m",
                                                           "usage": {"output": 3}}}),
            json.dumps({"type": "agent_end", "messages": []}),
        ])
        events = bench.json_events(stream)
        self.assertEqual([event["type"] for event in events], ["message_end", "message_end", "agent_end"])
        self.assertEqual(bench.final_assistant(events)["responseModel"], "m")
        fallback = [{"type": "agent_end", "messages": [{"role": "assistant", "usage": {"output": 1}}]}]
        self.assertEqual(bench.final_assistant(fallback)["usage"]["output"], 1)

    def test_response_models_walks_every_event(self) -> None:
        events = [{"type": "message_update", "assistantMessageEvent": {"partial": {"responseModel": "a"}}},
                  {"type": "agent_end", "messages": [{"role": "assistant", "responseModel": "b"}]}]
        self.assertEqual(bench.response_models(events), ["a", "b"])
        self.assertEqual(bench.response_models([{"type": "agent_end"}]), [])

    def test_live_provider_copy_takes_one_provider_and_resolves_a_command_key(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            models = Path(scratch) / "models.json"
            models.write_text(json.dumps({"providers": {
                "live": {"apiKey": "!printf 'resolved-key\\n'", "models": [{"id": "m"}]},
                "other": {"apiKey": "never-copied"}}}))
            copy = bench.live_provider_copy(models, "live")
            self.assertEqual(copy, {"live": {"apiKey": "resolved-key", "models": [{"id": "m"}]}})
            self.assertIn("resolved-key", bench.SECRETS)
            bench.SECRETS.discard("resolved-key")
            with self.assertRaises(SystemExit):
                bench.live_provider_copy(models, "absent")
            models.write_text(json.dumps({"providers": {"live": {"apiKey": "!exit 3"}}}))
            with self.assertRaises(SystemExit):
                bench.live_provider_copy(models, "live")

    def test_redact(self) -> None:
        self.assertEqual(bench.redact("auth Bearer abcdefghijklmnop end"), "auth Bearer <redacted> end")
        self.assertEqual(bench.redact("key sk-abcdefghijkl"), "key sk-<redacted>")
        bench.SECRETS.add("opaque0key0without0prefix")
        try:
            self.assertEqual(bench.redact("got opaque0key0without0prefix back"), "got <redacted> back")
        finally:
            bench.SECRETS.discard("opaque0key0without0prefix")


class SandboxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="pbt.", dir="/tmp"))
        self.saved = dict(os.environ)
        os.environ["PRIME_AGENT_SOCKET_DIR"] = "/live/fleet"
        os.environ["PI_PACKAGE_DIR"] = "/live/pkg"
        os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = "/live/agent"

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self.saved)
        shutil.rmtree(self.base, ignore_errors=True)

    def test_base_env_keeps_only_the_allow_list(self) -> None:
        env = bench.base_env({"PATH": "/bin", "PRIME_AGENT_X": "1", "PI_Y": "2", "HOME": "/real", "LANG": "C"})
        self.assertEqual(env, {"PATH": "/bin", "LANG": "C"})

    def test_the_live_launcher_env_names_a_socket_dir_inside_the_sandbox(self) -> None:
        # The macOS launcher defaults its socket dir to /tmp/pa-rs-<uid> whatever TMPDIR says, so
        # the live leg must name a sandbox dir or its isolation check refuses the run.
        fake = self.base / "prime-agent-rs"
        fake.write_text('#!/bin/sh\necho "PRIME_AGENT_CODING_AGENT_DIR=$HOME/.prime/agent-rs"\n'
                        'echo "PRIME_AGENT_SOCKET_DIR=${PRIME_AGENT_RS_SOCKET_DIR:-/tmp/pa-rs-$(id -u)}"\n')
        fake.chmod(0o755)
        sandbox = bench.Sandbox("rs", "t", self.base, "http://127.0.0.1:9/v1", None)
        saved = bench.RS_LAUNCHER
        bench.RS_LAUNCHER = fake
        try:
            bench.apply_rs_launcher_env(sandbox, "http://127.0.0.1:9/v1", {})
            self.assertEqual(
                {key: sandbox.env[key] for key in ("PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_SOCKET_DIR")},
                {"PRIME_AGENT_CODING_AGENT_DIR": str(sandbox.home / ".prime" / "agent-rs"),
                 "PRIME_AGENT_SOCKET_DIR": str(sandbox.tmp / f"pa-rs-{os.getuid()}")})
        finally:
            bench.RS_LAUNCHER = saved
            sandbox.teardown()

    def test_sandbox_env_points_inside_and_scrubs_the_fleet(self) -> None:
        for product in ("ts", "rs"):
            sandbox = bench.Sandbox(product, "t", self.base, "http://127.0.0.1:9/v1", "/real/uv-cache")
            try:
                env = sandbox.env
                for key in ("HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
                            "XDG_STATE_HOME"):
                    self.assertTrue(Path(env[key]).is_relative_to(sandbox.root), key)
                self.assertNotIn("PRIME_AGENT_SOCKET_DIR", env)
                self.assertNotIn("PRIME_AGENT_CODING_AGENT_DIR", env)
                self.assertNotIn("PI_PACKAGE_DIR", env)
                self.assertEqual((env["PI_SKIP_VERSION_CHECK"], env["DO_NOT_TRACK"]), ("1", "1"))
                self.assertEqual(env["UV_CACHE_DIR"], "/real/uv-cache")
                if product == "rs":
                    self.assertEqual(env["PRIME_AGENT_DISABLE_SELF_UPDATE"], "1")
                    self.assertTrue(env["PRIME_AGENT_RUST_INSTALLER_URL"].startswith("http://127.0.0.1:1/"))
                    self.assertTrue(env["PRIME_AGENT_DOWNLOAD_BASE_URL"].startswith("http://127.0.0.1:1/"))
                else:
                    self.assertFalse(any(key.startswith("PRIME_AGENT_") and key != "PRIME_AGENT_TELEMETRY"
                                         for key in env))
                models = sandbox.agent_dir / "models.json"
                self.assertEqual(stat.S_IMODE(models.stat().st_mode), 0o600)
                provider = json.loads(models.read_text())["providers"]["mock"]
                self.assertEqual(provider["baseUrl"], "http://127.0.0.1:9/v1")
                settings = json.loads((sandbox.agent_dir / "settings.json").read_text())
                self.assertTrue(settings["onboardingShown"])
                self.assertFalse(settings["telemetry"]["enabled"])
            finally:
                sandbox.teardown()
            self.assertFalse(sandbox.root.exists())

    def test_live_providers_ride_beside_the_mock(self) -> None:
        sandbox = bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        try:
            sandbox.write_agent_files(sandbox.agent_dir, "http://127.0.0.1:9/v1",
                                      {"real": {"apiKey": "secret"}, "mock": {"stale": True}})
            providers = json.loads((sandbox.agent_dir / "models.json").read_text())["providers"]
            self.assertEqual(providers["real"], {"apiKey": "secret"})
            self.assertEqual(providers["mock"]["baseUrl"], "http://127.0.0.1:9/v1")
        finally:
            sandbox.teardown()

    def test_sandbox_processes_and_reap_touch_only_the_sandbox(self) -> None:
        sandbox = bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        outsider = subprocess.Popen(["sleep", "30"])
        try:
            direct = subprocess.Popen(SLEEPER, env=sandbox.env)
            # A detached grandchild (its parent exits at once) still carries the HOME.
            subprocess.run(["sh", "-c", f"{shlex.join(SLEEPER)} >/dev/null 2>&1 &"], env=sandbox.env, check=True)
            # A spawned root without the sandbox HOME is tracked by descent.
            rooted = subprocess.Popen(["sleep", "30"], env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
            sandbox.add_root(rooted.pid)
            deadline = time.monotonic() + 5
            procs: dict = {}
            while time.monotonic() < deadline:
                procs = sandbox.processes()
                if len(procs) >= 3:
                    break
                time.sleep(0.1)
            self.assertIn(direct.pid, procs)
            self.assertIn(rooted.pid, procs)
            self.assertFalse(procs[rooted.pid]["envMatched"])
            self.assertEqual(len(procs), 3, procs)
            self.assertNotIn(outsider.pid, procs)
            signalled = sandbox.reap()
            self.assertEqual(len({entry["pid"] for entry in signalled}), 3)
            direct.wait(timeout=5)
            rooted.wait(timeout=5)
            self.assertEqual(sandbox.processes(), {})
            self.assertIsNone(outsider.poll())
        finally:
            outsider.kill()
            outsider.wait()
            sandbox.teardown()

    def test_signal_skips_a_pid_whose_identity_changed(self) -> None:
        sandbox = bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        child = subprocess.Popen(SLEEPER, env=sandbox.env)
        try:
            deadline = time.monotonic() + 5
            while child.pid not in sandbox.processes() and time.monotonic() < deadline:
                time.sleep(0.05)
            info = sandbox.processes()[child.pid]
            self.assertEqual(info["ident"], bench.identity(child.pid))
            bench._signal(child.pid, 15, str(sandbox.home), {**info, "ident": "someone else"})
            time.sleep(0.2)
            self.assertIsNone(child.poll())
            bench._signal(child.pid, 15, str(sandbox.home), info)
            self.assertEqual(child.wait(timeout=5), -15)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            sandbox.teardown()

    def test_a_root_whose_pid_was_reused_is_neither_tracked_nor_signalled(self) -> None:
        sandbox = bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        # An unrelated process (with a child of its own) now holds the pid of
        # a root this script launched earlier, under that root's identity.
        reused = subprocess.Popen(["sh", "-c", "sleep 30 & wait"], env={"PATH": os.environ["PATH"]})
        try:
            sandbox.roots[reused.pid] = "the launched root's start time"
            self.assertEqual(sandbox.processes(), {})
            self.assertEqual(sandbox.reap(), [])
            self.assertIsNone(reused.poll())
            self.assertEqual((sandbox.roots, sandbox.known), ({}, {}))
        finally:
            reused.kill()
            reused.wait()
            sandbox.teardown()

    def test_add_root_records_the_launch_identity_and_skips_a_finished_pid(self) -> None:
        sandbox = bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        child = subprocess.Popen(["sleep", "30"], env={"PATH": os.environ["PATH"]})
        done = subprocess.Popen(["true"])
        done.wait()
        try:
            sandbox.add_root(child.pid)
            sandbox.add_root(done.pid)
            self.assertEqual(sandbox.roots, {child.pid: bench.identity(child.pid)})
            self.assertEqual(list(sandbox.processes()), [child.pid])
        finally:
            child.kill()
            child.wait()
            sandbox.teardown()

    def test_an_orphan_without_the_sandbox_home_stays_tracked(self) -> None:
        sandbox = bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        # The shell (a spawned root) starts a child with a scrubbed env, then
        # dies: the child keeps neither its parent nor the sandbox HOME.
        shell = subprocess.Popen(["sh", "-c", "env -i PATH=\"$PATH\" sleep 30 & echo $!; wait"],
                                 stdout=subprocess.PIPE, text=True, env={"PATH": os.environ["PATH"]})
        orphan = int(shell.stdout.readline())
        try:
            sandbox.add_root(shell.pid)
            self.assertIn(orphan, sandbox.processes())
            shell.kill()
            shell.wait()
            sandbox.roots.pop(shell.pid, None)
            time.sleep(0.2)
            procs = sandbox.processes()
            self.assertIn(orphan, procs)
            self.assertFalse(procs[orphan]["envMatched"])
            sandbox.reap()
            time.sleep(0.2)
            self.assertFalse(bench.pid_alive(orphan))
        finally:
            shell.stdout.close()
            try:
                os.kill(orphan, 9)
            except ProcessLookupError:
                pass
            sandbox.teardown()

    def test_run_headless_counts_only_real_replies(self) -> None:
        mock = bench.MockProvider()
        sandbox = bench.Sandbox("ts", "t", self.base, mock.base_url, None)
        script = sandbox.root / "fake.py"
        script.write_text(FAKE_PRODUCT)
        try:
            def run(mode: str) -> dict:
                argv = [sys.executable, str(script), mode, bench.MOCK_REPLY]
                return bench.strip_events(bench.run_headless(sandbox, argv, mock, 0.02, 30, run=0))

            good = run("ok")
            self.assertTrue(good["ok"], good)
            self.assertEqual(good["stopReason"], "stop")
            self.assertGreater(good["maxRssKb"], 1000)
            self.assertLessEqual(good["agentEndS"], good["exitS"])
            self.assertGreaterEqual(good["peakSandboxRssKb"], good["maxRssKb"])
            self.assertEqual(good["requests"][0]["messages"], 1)
            self.assertNotIn("stderrTail", good)
            # A clean agent_end and exit 0 are not enough: no assistant
            # message, a non-reply stop, or another reply all fail the run.
            for mode in ("error", "no-call", "no-assistant", "length", "wrong-text"):
                with self.subTest(mode):
                    self.assertEqual(run(mode)["ok"], False)
            failed = run("exit")
            self.assertEqual((failed["ok"], failed["exitCode"]), (False, 3))
            self.assertIn("stderrTail", failed)
            self.assertEqual(sandbox.roots, {})
        finally:
            sandbox.teardown()
            mock.close()

    def test_constructor_failure_rolls_the_sandbox_back(self) -> None:
        def boom(*args: object) -> None:
            raise OSError("disk full")

        saved = bench.Sandbox.write_agent_files
        bench.Sandbox.write_agent_files = boom
        try:
            with self.assertRaises(OSError):
                bench.Sandbox("ts", "t", self.base, "http://127.0.0.1:9/v1", None)
        finally:
            bench.Sandbox.write_agent_files = saved
        self.assertEqual(list(self.base.iterdir()), [])
        self.assertEqual(bench.Sandbox.created, [])

    def test_teardown_deletes_the_key_copies(self) -> None:
        sandbox = bench.Sandbox("rs", "t", self.base, "http://127.0.0.1:9/v1", None)
        sandbox.write_agent_files(sandbox.home / ".prime" / "agent-rs", "http://127.0.0.1:9/v1",
                                  {"live": {"apiKey": "secret"}})
        sandbox.teardown()
        self.assertFalse(sandbox.root.exists())
        self.assertNotIn(sandbox, bench.Sandbox.created)

    def test_sandbox_base_override_must_fit_the_socket_paths(self) -> None:
        with self.assertRaises(SystemExit):
            bench.sandbox_base("/tmp/has space")
        with self.assertRaises(SystemExit):
            bench.sandbox_base("/" + "x" * 60)
        cwd = os.getcwd()
        os.chdir("/")
        try:
            self.assertEqual(bench.sandbox_base("tmp")[0], Path("/tmp"))
        finally:
            os.chdir(cwd)

    def test_mac_sandbox_base_falls_back_when_sockets_would_overflow(self) -> None:
        saved = (bench.IS_MAC, os.environ.get("TMPDIR"))
        try:
            bench.IS_MAC = True
            os.environ["TMPDIR"] = "/var/folders/7x/abcdefghijklmnopqrstuvwxyz12/T/"
            self.assertEqual(bench.sandbox_base(None)[0], Path("/tmp"))
            os.environ["TMPDIR"] = "/t/"
            self.assertEqual(bench.sandbox_base(None)[0], Path("/t"))
            self.assertEqual(bench.sandbox_base("/x")[0], Path("/x"))
        finally:
            bench.IS_MAC = saved[0]
            if saved[1] is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = saved[1]


class ReportTests(unittest.TestCase):
    def result(self) -> dict:
        def headless(agent_end: float, rss: int) -> dict:
            summary = {"agentEndS": bench.summarize([agent_end, agent_end * 1.1]),
                       "maxRssKb": bench.summarize([rss, rss])}
            return {"ok": True, "firstRun": {"agentEndS": agent_end * 2, "exitS": agent_end * 3},
                    "samples": [], "summary": summary}

        interactive = {name: {"ok": True, "firstRun": {"readyS": 1.0, "bootstrapS": 30.0},
                              "summary": {"readyS": bench.summarize([ready]),
                                          "idleRssKb": bench.summarize([rss * 1024]),
                                          "idleByRole": {"tui": bench.summarize([rss * 512])}}}
                       for name, ready, rss in (("ts", 1.5, 600), ("rs", 0.5, 150))}
        return {"startedAt": "2026-10-01T00:00:00Z",
                "host": {"hostname": "h", "os": "Linux", "cpuModel": "cpu", "cpuCount": 4, "ramBytes": 2 ** 34,
                         "loadAvgBefore": [1, 1, 1], "loadAvgAfter": [2, 2, 2]},
                "products": {"ts": {"label": "TS prime-agent", "version": "0.9.6", "path": "/ts"},
                             "rs": {"label": "Rust prime-agent-rs", "version": "0.9.8", "path": "/rs"}},
                "config": {"runs": 2, "versionRuns": 20, "versionWarmup": 2, "idleSeconds": 10},
                "corpus": {"messageRows": 1100},
                "measurements": {"version": {"ts": {"ok": True, "summary": {"wallS": bench.summarize([0.2])}},
                                             "rs": {"ok": False, "summary": {"wallS": None}}},
                                 "oneshot": {"ts": headless(1.0, 160000), "rs": headless(0.1, 40000)},
                                 "interactive": interactive}}

    def test_markdown_table_rows_and_ratio(self) -> None:
        markdown = bench.render_markdown(self.result())
        self.assertIn("| Measurement | Metric | TS | Rust | Rust/TS |", markdown)
        self.assertIn("| one-shot `-p` (steady) | to agent_end s | 1.050 (1.090) | 0.105 (0.109) | 0.10x |",
                      markdown)
        self.assertIn("| interactive | start-to-ready s | 1.500 (1.500) | 0.500 (0.500) | 0.33x |", markdown)
        self.assertIn("| `--version` | wall s | 0.200 (0.200) | n/a | n/a |", markdown)
        self.assertIn("| TS prime-agent | 1.0 | 30.0 |", markdown)
        self.assertIn("| tui | 300 | 75 |", markdown)
        self.assertIn("**Incomplete:** version/rs", markdown)
        self.assertIn("Upstream reference", markdown)


if __name__ == "__main__":
    unittest.main()
