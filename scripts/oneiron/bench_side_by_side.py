#!/usr/bin/env python3
"""Side-by-side benchmark: the TS prime-agent vs the Rust prime-agent-rs.

Numbers for the re-fork report, taken on our own machines against a local
mock provider (no real provider is called unless --live-sol):

  version      `--version` cold start (hyperfine --warmup 2 --runs 20, or a
               timed loop when hyperfine is missing)
  oneshot      headless `-p --mode json --no-session --no-tools ... -- "say hi"`
               wall time to the agent_end event, the CLI's wait4 max RSS and
               the peak summed RSS of every sandbox process. "steady" leaves
               sandbox processes alive between runs (the TS CLI keeps a
               supervisor daemon, as on a workstation); "oneshotCold" reaps
               every sandbox process before each run. A run counts only when
               the mock got a request and the final assistant message did
               not end in an error
  resume       `-p --mode json --resume <session file> --no-tools ... --
               "continue"` on a synthetic v3 transcript (~1,100 message rows
               of realistic sizes; a pristine copy per run), to agent_end
  interactive  the TUI in a detached tmux pane: launch to the ready frame
               (the `>` prompt, the `manage` bar and the `mock-1 · N` status
               segment), then after --idle-seconds the RSS of every sandbox
               process (TUI, daemon, workers, kernel) with a per-role
               breakdown, then C-c C-c, the leftovers and a reap by PID. The
               first launch in a fresh sandbox runs the one-time kernel
               bootstrap: it is reported apart (`firstRun`: its own ready
               time plus the time until the kernel is up and no uv process is
               left) and never mixed into the samples
  liveSol      (--live-sol only) the `sol`-shaped probe on the real provider,
               both products, same brief, K runs each: wall time, usage of
               the final assistant message, responseModel. The sandbox
               models.json (0600, gone with the sandbox) holds the mock plus
               a copy of the live provider's entry only, its `!command` key
               resolved once with the caller's env (the command reads the
               real home); keys are never printed. The Rust side runs with
               the prime-agent-rs launcher's env (computed by the installed
               launcher under the sandbox HOME/TMPDIR)

Isolation (a live TS fleet runs on these machines): every product gets fresh
sandboxes per measurement (`mkdtemp` under /tmp on Linux; under $TMPDIR on
macOS when the deepest daemon socket path still fits sun_path, else /tmp):
HOME=<sb>/h, TMPDIR=<sb>/t, XDG_*=<sb>/x/*, an env rebuilt from a short
allow-list (so every PRIME_AGENT_* / PI_* var is dropped), then
PI_SKIP_VERSION_CHECK=1, DO_NOT_TRACK=1, PRIME_AGENT_TELEMETRY=0 and for Rust
PRIME_AGENT_DISABLE_SELF_UPDATE=1 plus dead loopback installer/feed URLs. The
binaries run directly (TS: node + the cli.js behind ~/.local/bin/prime-agent,
Rust: the physical binary behind prime-agent-oneiron-rs/current). A sandbox's
processes are the ones whose environment carries HOME=<sb>/h (Linux
/proc/<pid>/environ; macOS `ps -E`, which also needs TMPDIR=<sb>/t there),
the descendants of those and of PIDs this script spawned, and earlier-seen
ones that outlived their parent; only those are ever signalled, by PID, and
only while the PID still names the same process (its start time).
`update`, `shutdown` and daemon stop commands are never run. The real uv cache dir is reused (as
scripts/oneiron/gate.sh does) so a kernel bootstrap needs no download it
already has; everything uv installs lands in the sandbox.

JSON schema `prime-agent-oneiron.bench/1` (bench-<host>-<utc>.json):

  schema, startedAt, finishedAt                 str
  ok                                            bool: every requested
                                                measurement produced numbers
                                                for every product
  host       {hostname, os, system, release, machine, macVersion, cpuModel,
              cpuCount, ramBytes, loadAvgBefore[3], loadAvgAfter[3],
              tools{hyperfine, tmux, node, uv, python}}
  config     {runs, versionRuns, versionWarmup, idleSeconds, pollSeconds,
              bootstrapTimeoutSeconds, measurements[], products[],
              sandboxBase, uvCacheDir, mockReply, upstreamReference{...},
              liveSol{provider, model, thinking, brief, runs} | null}
  products   {ts|rs: {label, path, argv[], version}}
  corpus     {rows, messageRows, bytes, estTokens} | null   (resume only;
              the same generator and seed for both products)
  measurements
    version      {ts|rs: {ok, method: hyperfine|loop, samples[s],
                  summary{wallS}, error}}
    oneshot, oneshotCold, resume
                 {ts|rs: {ok, firstRun: Sample | null, samples[Sample],
                  summary{agentEndS, exitS, maxRssKb, peakSandboxRssKb,
                  requestBytes}, error}}
                 Sample = {run, ok, exitCode, agentEndS, exitS, stopReason,
                  maxRssKb, peakSandboxRssKb, peakProcesses, requestBytes
                  (largest provider request body), requests[{path, bytes,
                  messages}], requestMessages (resume), error?, stderrTail?,
                  stdoutTail?}
                 maxRssKb: wait4 ru_maxrss of the CLI (the largest of it and
                  any child it waited for; not a sum). peakSandboxRssKb: the
                  largest sum of RSS over all sandbox processes, sampled every
                  pollSeconds while the CLI runs (daemons it reuses included),
                  floored at maxRssKb: a run shorter than one poll is sampled
                  about once.
                 (oneshotCold.firstRun is null: it shares oneshot's sandbox)
    interactive  {ts|rs: {ok, firstRun: {ok, readyS, firstFrameS,
                  bootstrapS, error, lastFrame?}, samples[{run, ok, readyS,
                  firstFrameS, idleRssKb, idleByRole{role: kb},
                  processes[{pid, ppid, role, name, rssKb}], quitS,
                  cleanQuit, afterQuitRssKb, afterQuitRoles[], reaped,
                  error?, lastFrame?}], summary{readyS, firstFrameS,
                  idleRssKb, afterQuitRssKb, idleByRole{role: Summary}},
                  readyFrame, error}}
    liveSol      {ts|rs: {ok, env, warmupOk, samples[{run, ok, exitCode,
                  agentEndS, exitS, responseModel, stopReason, usage{input,
                  output, cacheRead, cacheWrite, totalTokens}, errorMessage?,
                  stderrTail?}], summary{agentEndS, exitS, outputTokens},
                  error}}   (present only with --live-sol; a sample is ok
                  only when the reply came from the requested model)
  Summary = {n, median, p90, min, max, mean} over the ok samples; times in
  seconds, RSS in KiB, request sizes in bytes.
  Interactive roles: tui, daemon, worker, kernel, bootstrap (uv), cli, other.

The markdown table (bench-<host>-<utc>.md, also printed) carries the medians
(p90) per product and the Rust/TS ratio.

Run: python3 scripts/oneiron/bench_side_by_side.py --out <dir> [--runs N]
Not part of the product.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import random
import re
import shlex
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCHEMA = "prime-agent-oneiron.bench/1"
HOME = Path.home()
IS_LINUX = sys.platform.startswith("linux")
IS_MAC = sys.platform == "darwin"
TS_LAUNCHER = HOME / ".local" / "bin" / "prime-agent"
RS_BINARY = HOME / ".local" / "share" / "prime-agent-oneiron-rs" / "current" / "prime-agent"
RS_LAUNCHER = HOME / ".local" / "bin" / "prime-agent-rs"
LIVE_MODELS_JSON = HOME / ".prime" / "agent" / "models.json"
MOCK_PROVIDER = "mock"
MOCK_MODEL = "mock-1"
MOCK_REPLY = "Hi! This is the mock provider replying."
# The only stopReason of a final assistant message that is a real reply.
SUCCESS_STOP_REASONS = ("stop",)
DEAD_URL = "http://127.0.0.1:1/oneiron-bench-disabled"
PRODUCTS = ("ts", "rs")
LABELS = {"ts": "TS prime-agent", "rs": "Rust prime-agent-rs"}
MEASUREMENTS = ("version", "oneshot", "resume", "interactive")
# Kept from the caller's env; everything else (every PRIME_AGENT_* / PI_*
# included) is dropped before the sandbox values are layered on.
ENV_KEEP = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL", "TZ")
SCRUB_PREFIXES = ("PRIME_AGENT_", "PI_")
HEADLESS_FLAGS = ("--no-tools", "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes")
# Upstream's own claims (sandbox, mock provider), quoted for the report.
UPSTREAM_REFERENCE = {
    "interactiveStartupS": {"ts": 1.539, "rs": 0.332},
    "idleRssMb": {"ts": 998, "rs": 166, "scope": "daemon+TUI+kernel"},
    "resume1078RowsS": {"ts": 1.450, "rs": 0.683},
}
# Interactive-ready frame, the same for both products: the empty input
# prompt, the bottom bar, and the resolved model in the status segment (both
# show "model —" while the session is still binding, keys sent then are lost).
READY_PROMPT = re.compile(r"^\s*>\s*$", re.MULTILINE)
READY_STATUS = re.compile(re.escape(MOCK_MODEL) + r" · \d")
QUIT_KEYS = ("C-c", "C-c")
# Worst-case socket path below a sandbox base: `pb.XXXXXXXX/t` then the
# daemon's worker socket (`prime-agent-<uid>/worker-<12>-<12>.sock`). sun_path
# holds 104 bytes on macOS and 108 on Linux, the terminating NUL included.
SOCKET_TAIL = len("/pb.XXXXXXXX/t/prime-agent-99999/worker-xxxxxxxxxxxx-xxxxxxxxxxxx.sock")
SUN_PATH_MAX = 103 if sys.platform == "darwin" else 107
# Resolved live keys (--live-sol): scrubbed from every diagnostic kept.
SECRETS: set[str] = set()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def log(message: str) -> None:
    print(f"[bench {time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


# -- statistics ----------------------------------------------------------------

def percentile(ordered: list[float], pct: float) -> float:
    """Linear-interpolated percentile of an already sorted list."""
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * pct / 100.0
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def summarize(values: list) -> dict | None:
    """n/median/p90/min/max/mean of the numeric samples (None when empty)."""
    samples = sorted(float(value) for value in values if value is not None)
    if not samples:
        return None
    return {"n": len(samples), "median": round(statistics.median(samples), 4),
            "p90": round(percentile(samples, 90), 4), "min": round(samples[0], 4),
            "max": round(samples[-1], 4), "mean": round(statistics.fmean(samples), 4)}


# -- mock provider ---------------------------------------------------------------

def sse(event: dict, name: str | None = None) -> bytes:
    head = f"event: {name}\n" if name else ""
    return f"{head}data: {json.dumps(event, separators=(',', ':'))}\n\n".encode()


def chat_completion_stream(model: str, prompt_tokens: int, reply: str = MOCK_REPLY) -> list[bytes]:
    """The SSE frames of a streamed /v1/chat/completions reply."""
    created = int(time.time())
    words = re.findall(r"\S+\s*", reply)

    def chunk(delta: dict, finish: str | None = None) -> dict:
        return {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": created,
                "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

    frames = [sse(chunk({"role": "assistant", "content": ""}))]
    frames += [sse(chunk({"content": word})) for word in words]
    frames.append(sse(chunk({}, "stop")))
    frames.append(sse({"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": created,
                       "model": model, "choices": [],
                       "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": len(words),
                                 "total_tokens": prompt_tokens + len(words),
                                 "prompt_tokens_details": {"cached_tokens": 0}}}))
    frames.append(b"data: [DONE]\n\n")
    return frames


def responses_stream(model: str, prompt_tokens: int, reply: str = MOCK_REPLY) -> list[bytes]:
    """The SSE frames of a streamed /v1/responses reply (created .. completed)."""
    created = int(time.time())
    words = re.findall(r"\S+\s*", reply)
    item_id = "msg_mock"
    part = {"type": "output_text", "text": reply, "annotations": []}
    item = {"id": item_id, "type": "message", "status": "completed", "role": "assistant", "content": [part]}
    usage = {"input_tokens": prompt_tokens, "input_tokens_details": {"cached_tokens": 0},
             "output_tokens": len(words), "output_tokens_details": {"reasoning_tokens": 0},
             "total_tokens": prompt_tokens + len(words)}
    base = {"id": "resp_mock", "object": "response", "created_at": created, "model": model}
    events = [
        ("response.created", {"response": {**base, "status": "in_progress", "output": []}}),
        ("response.in_progress", {"response": {**base, "status": "in_progress", "output": []}}),
        ("response.output_item.added", {"output_index": 0,
                                        "item": {**item, "status": "in_progress", "content": []}}),
        ("response.content_part.added", {"item_id": item_id, "output_index": 0, "content_index": 0,
                                         "part": {**part, "text": ""}}),
    ]
    events += [("response.output_text.delta", {"item_id": item_id, "output_index": 0,
                                               "content_index": 0, "delta": word}) for word in words]
    events += [
        ("response.output_text.done", {"item_id": item_id, "output_index": 0, "content_index": 0,
                                       "text": reply}),
        ("response.content_part.done", {"item_id": item_id, "output_index": 0, "content_index": 0,
                                        "part": part}),
        ("response.output_item.done", {"output_index": 0, "item": item}),
        ("response.completed", {"response": {**base, "status": "completed", "output": [item],
                                             "usage": usage}}),
    ]
    return [sse({"type": name, "sequence_number": index, **payload}, name)
            for index, (name, payload) in enumerate(events)]


class MockProvider:
    """A local OpenAI-compatible endpoint on 127.0.0.1:<ephemeral>: streamed
    chat completions and responses with a short fixed reply plus usage. Every
    request is logged (path, body bytes, message count) so a measurement can
    prove the product really sent its transcript."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        provider = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:
                pass

            def read_body(self) -> bytes:
                if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
                    body = b""
                    while True:
                        size = int(self.rfile.readline().strip().split(b";")[0] or b"0", 16)
                        if size == 0:
                            self.rfile.readline()
                            return body
                        body += self.rfile.read(size)
                        self.rfile.readline()
                return self.rfile.read(int(self.headers.get("Content-Length") or 0))

            def send_json(self, status: int, payload: dict) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                provider.log(self.path, 0, None)
                if self.path.rstrip("/").endswith("/models"):
                    self.send_json(200, {"object": "list", "data": [
                        {"id": MOCK_MODEL, "object": "model", "created": 0, "owned_by": "mock"}]})
                else:
                    self.send_json(404, {"error": {"message": f"unknown path {self.path}"}})

            def do_POST(self) -> None:
                body = self.read_body()
                try:
                    request = json.loads(body or b"{}")
                except json.JSONDecodeError:
                    request = {}
                messages = request.get("messages", request.get("input"))
                provider.log(self.path, len(body), len(messages) if isinstance(messages, list) else None)
                model = request.get("model") or MOCK_MODEL
                prompt_tokens = max(1, len(body) // 4)
                if self.path.endswith("/chat/completions"):
                    frames = chat_completion_stream(model, prompt_tokens)
                elif self.path.endswith("/responses"):
                    frames = responses_stream(model, prompt_tokens)
                else:
                    self.send_json(404, {"error": {"message": f"unknown path {self.path}"}})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for frame in frames:
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(frame), frame))
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def log(self, path: str, size: int, messages: int | None) -> None:
        with self.lock:
            self.requests.append({"path": path, "bytes": size, "messages": messages})

    def mark(self) -> int:
        with self.lock:
            return len(self.requests)

    def since(self, mark: int) -> list[dict]:
        with self.lock:
            return [dict(entry) for entry in self.requests[mark:]]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def mock_provider_entry(base_url: str) -> dict:
    return {"baseUrl": base_url, "api": "openai-completions", "apiKey": "mock",
            "models": [{"id": MOCK_MODEL, "name": "Mock 1", "reasoning": False, "input": ["text"],
                        "contextWindow": 200000, "maxTokens": 8192,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}


# -- synthetic transcript ---------------------------------------------------------

WORDS = ("the session kernel output file module parse value result check build test path config "
         "daemon worker socket render frame stream token cache index commit branch report table "
         "error retry timeout schema field record entry offset buffer queue limit count batch "
         "async handle request response payload status update merge diff line column").split()
CODE_LINES = (
    "import json, pathlib",
    "rows = [json.loads(line) for line in pathlib.Path(path).read_text().splitlines()]",
    "print(len(rows), sum(len(r.get('content', '')) for r in rows))",
    "result = subprocess.run(['git', 'status', '--short'], capture_output=True, text=True)",
    "print(result.stdout[-2000:])",
    "for name in sorted(os.listdir(root))[:40]:\n    print(name)",
    "df = pd.read_csv(source)\nprint(df.describe().T.head(20))",
    "matches = [l for l in open(target) if pattern.search(l)]\nprint(''.join(matches[:50]))",
    "data = requests_cache.get(key)\nassert data is not None, key",
    "summary = {k: len(v) for k, v in groups.items()}\nprint(json.dumps(summary, indent=2))",
)


def _prose(rng: random.Random, chars: int) -> str:
    out: list[str] = []
    length = 0
    while length < chars:
        sentence = " ".join(rng.choice(WORDS) for _ in range(rng.randint(6, 16)))
        sentence = sentence[0].upper() + sentence[1:] + "."
        out.append(sentence)
        length += len(sentence) + 1
    return " ".join(out)[:chars]


def _code(rng: random.Random, chars: int) -> str:
    out: list[str] = []
    while sum(len(line) + 1 for line in out) < chars:
        out.append(re.sub(r"\bpath\b", f"path_{rng.randint(0, 99)}", rng.choice(CODE_LINES)))
    return "\n".join(out)


def _tool_output(rng: random.Random, chars: int) -> str:
    out: list[str] = []
    while sum(len(line) + 1 for line in out) < chars:
        out.append(f"{rng.choice(WORDS)}/{rng.choice(WORDS)}_{rng.randint(0, 999)}.py:"
                   f"{rng.randint(1, 900)}: {' '.join(rng.choice(WORDS) for _ in range(rng.randint(3, 9)))}")
    return "\n".join(out)[:chars]


def _size(rng: random.Random, median: int, spread: float = 0.6, low: int = 20) -> int:
    return max(low, int(rng.lognormvariate(0, spread) * median))


def build_corpus(cwd: str, session_id: str, message_rows: int = 1100, seed: int = 20261001) -> list[dict]:
    """A deterministic v3 session: header, model + thinking-level rows, then
    tasks of user -> (assistant thinking/toolCall -> toolResult) x 1..4 ->
    assistant text, until `message_rows` message rows. Row shapes follow the
    TS session format (content toolCall blocks, toolName + details on tool
    results); sizes are lognormal, scaled down from a real long session's
    medians so the whole transcript (~90k tokens, a ~360 KB provider
    request) stays well inside the mock model's 200k window: a larger one
    makes TS compact before the turn, which would time compaction, not
    resume."""
    rng = random.Random(seed)
    clock = dt.datetime(2026, 9, 30, 9, 0, 0, tzinfo=dt.timezone.utc)
    epoch_ms = int(clock.timestamp() * 1000)
    rows: list[dict] = [{"type": "session", "version": 3, "id": session_id,
                         "timestamp": clock.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "cwd": cwd, "rlmDepth": 0}]
    parent: str | None = None
    counter = 0
    context_chars = 0

    def add(kind: str, fields: dict) -> None:
        nonlocal parent, counter, clock
        counter += 1
        clock += dt.timedelta(seconds=rng.randint(1, 40))
        entry_id = f"{counter:08x}"
        rows.append({"type": kind, "id": entry_id, "parentId": parent,
                     "timestamp": clock.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", **fields})
        parent = entry_id

    def now_ms() -> int:
        return epoch_ms + counter * 1000

    def usage(output: int) -> dict:
        return {"input": context_chars // 4, "output": output, "cacheRead": max(0, context_chars // 4 - 2000),
                "cacheWrite": 0, "totalTokens": context_chars // 4 + output,
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}

    add("model_change", {"provider": MOCK_PROVIDER, "modelId": MOCK_MODEL, "api": "openai-completions"})
    add("thinking_level_change", {"thinkingLevel": "off"})
    messages = 0
    task = 0
    while messages < message_rows:
        task += 1
        text = f"Task {task}: " + _prose(rng, _size(rng, 170))
        context_chars += len(text)
        add("message", {"message": {"role": "user", "content": [{"type": "text", "text": text}],
                                    "timestamp": now_ms()}})
        messages += 1
        for step in range(rng.randint(1, 4)):
            if messages + 3 > message_rows:
                break
            call_id = f"call_{task:04d}_{step}_{rng.getrandbits(48):012x}"
            content = [{"type": "thinking", "thinking": _prose(rng, _size(rng, 70))}]
            if rng.random() < 0.3:
                content.append({"type": "text", "text": _prose(rng, _size(rng, 70))})
            code = _code(rng, _size(rng, 130))
            content.append({"type": "toolCall", "id": call_id, "name": "ipython", "arguments": {"code": code}})
            context_chars += sum(len(json.dumps(block)) for block in content)
            add("message", {"message": {"role": "assistant", "content": content, "api": "openai-completions",
                                        "provider": MOCK_PROVIDER, "model": MOCK_MODEL,
                                        "usage": usage(len(code) // 4 + 40), "stopReason": "toolUse",
                                        "timestamp": now_ms()}})
            output = _tool_output(rng, _size(rng, 1200 if rng.random() < 0.05 else 150))
            context_chars += len(output)
            add("message", {"message": {"role": "toolResult", "toolCallId": call_id, "toolName": "ipython",
                                        "content": [{"type": "text", "text": output}],
                                        "details": {"durationMs": rng.randint(5, 4000), "status": "ok",
                                                    "stdout": output, "stderr": "", "kernelRestarted": False},
                                        "isError": False, "timestamp": now_ms()}})
            messages += 2
        reply = _prose(rng, _size(rng, 160))
        context_chars += len(reply)
        add("message", {"message": {"role": "assistant", "content": [{"type": "text", "text": reply}],
                                    "api": "openai-completions", "provider": MOCK_PROVIDER, "model": MOCK_MODEL,
                                    "usage": usage(len(reply) // 4), "stopReason": "stop",
                                    "timestamp": now_ms()}})
        messages += 1
    return rows


def corpus_facts(rows: list[dict], text: str) -> dict:
    content_chars = 0
    for row in rows:
        message = row.get("message")
        if isinstance(message, dict):
            content_chars += len(json.dumps(message.get("content", "")))
    return {"rows": len(rows), "messageRows": sum(1 for row in rows if row.get("type") == "message"),
            "bytes": len(text.encode()), "estTokens": content_chars // 4}


# -- processes -------------------------------------------------------------------

def _linux_status(pid: int) -> dict:
    info: dict = {}
    try:
        with open(f"/proc/{pid}/status") as handle:
            for line in handle:
                key, _, value = line.partition(":")
                if key in ("Name", "PPid", "VmRSS", "VmHWM", "State"):
                    info[key] = value.strip()
    except OSError:
        pass
    return info


def _linux_cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            return handle.read().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        return ""


def _linux_environ(pid: int) -> set[str]:
    try:
        with open(f"/proc/{pid}/environ", "rb") as handle:
            return set(handle.read().decode(errors="replace").split("\0"))
    except OSError:
        return set()


def _linux_children(pid: int) -> list[int]:
    children: list[int] = []
    try:
        for task in os.scandir(f"/proc/{pid}/task"):
            try:
                with open(f"/proc/{pid}/task/{task.name}/children") as handle:
                    children.extend(int(child) for child in handle.read().split())
            except OSError:
                continue
    except OSError:
        pass
    return children


def _linux_starttime(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            stat = handle.read().decode(errors="replace")
    except OSError:
        return None
    # Field 22 (starttime); the comm field may hold spaces and parens.
    fields = stat[stat.rfind(")") + 2:].split()
    return fields[19] if len(fields) > 19 else None


def _linux_info(pid: int, env: set[str], matched: bool) -> dict | None:
    status = _linux_status(pid)
    ident = _linux_starttime(pid)
    if not status or ident is None or status.get("State", "").startswith("Z"):
        return None
    return {"ppid": int(status.get("PPid", "0")), "name": status.get("Name", ""),
            "rssKb": int((status.get("VmRSS") or "0 kB").split()[0]),
            "hwmKb": int((status.get("VmHWM") or "0 kB").split()[0]),
            "cmd": _linux_cmdline(pid), "env": env, "envMatched": matched, "ident": ident}


def _mac_table() -> dict[int, dict]:
    """Every process from `ps` (no /proc on macOS). `ps -E` appends the
    environment to the command column, so `env` takes its tokens, and `cmd`
    is argv alone, as on Linux, from a second `ps` without -E: classify reads
    `cmd`, and an environment value such as UV_CACHE_DIR=~/.cache/uv must not
    read as argv. A process that started, ended or retitled itself between
    the two calls keeps the -E column as its `cmd`. `lstart` (always five
    words) is the start time that pins a pid's identity."""
    def ps(*flags: str, columns: str) -> list[str]:
        return subprocess.run(["ps", *flags, "-A", "-ww", "-o", columns],
                              capture_output=True, text=True).stdout.splitlines()

    argv_of: dict[int, tuple[str, str]] = {}
    for line in ps(columns="pid=,lstart=,command="):
        parts = line.split(None, 6)
        if len(parts) == 7 and parts[0].isdigit():
            argv_of[int(parts[0])] = (" ".join(parts[1:6]), parts[6])
    table: dict[int, dict] = {}
    for line in ps("-E", columns="pid=,ppid=,rss=,state=,lstart=,command="):
        parts = line.split(None, 9)
        if len(parts) < 10 or not parts[0].isdigit() or parts[3].startswith("Z"):
            continue
        pid, command, ident = int(parts[0]), parts[9], " ".join(parts[4:9])
        argv_ident, argv = argv_of.get(pid, (None, ""))
        cmd = argv.rstrip() if argv_ident == ident and argv.strip() and command.startswith(argv) else command
        table[pid] = {"ppid": int(parts[1]), "name": os.path.basename(command.split(" ", 1)[0]),
                      "rssKb": int(parts[2]), "hwmKb": None, "cmd": cmd,
                      "env": set(command.split()), "envMatched": False, "ident": ident}
    return table


def identity(pid: int) -> str | None:
    """A live pid's start time: (pid, identity) never names a reused pid."""
    if IS_LINUX:
        return _linux_starttime(pid)
    out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True).stdout
    return " ".join(out.split()) or None


def sandbox_processes(home: str, roots: dict[int, str] | None = None,
                      known: dict[int, str] | None = None) -> dict[int, dict]:
    """The sandbox's live processes: every pid whose environment carries
    HOME=<home> (macOS: and TMPDIR=<sandbox>/t, as `ps -E` mixes argv and
    environment in one column), every `known` pid (pid -> identity from an
    earlier scan) and every root (pid -> identity recorded when this script
    spawned it) still alive under that same identity, and all live
    descendants of those, so a child that lost its parent or its HOME stays
    tracked. A root or known pid now naming another process is neither
    admitted nor walked: its identity is never recaptured.
    pid -> {ppid, rssKb, hwmKb, name, cmd, env (KEY=VALUE tokens), envMatched, ident}."""
    tokens = {f"HOME={home}"}
    found: dict[int, dict] = {}
    if IS_LINUX:
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            env = _linux_environ(int(entry.name))
            if tokens <= env:
                info = _linux_info(int(entry.name), env, True)
                if info:
                    found[int(entry.name)] = info

        def lookup(pid: int) -> dict | None:
            return _linux_info(pid, _linux_environ(pid), False)

        children_of = _linux_children
    else:
        tokens.add(f"TMPDIR={Path(home).parent / 't'}")
        table = _mac_table()
        kids: dict[int, list[int]] = {}
        for pid, info in table.items():
            kids.setdefault(info["ppid"], []).append(pid)
            info["envMatched"] = tokens <= info["env"]
            if info["envMatched"]:
                found[pid] = info
        lookup = table.get

        def children_of(pid: int) -> list[int]:
            return kids.get(pid, [])

    for pid, ident in {**(known or {}), **(roots or {})}.items():
        if pid not in found:
            info = lookup(pid)
            if info and info["ident"] == ident:
                found[pid] = info
    stack = list(found)
    seen = set(stack)
    while stack:
        pid = stack.pop()
        if pid not in found:
            info = lookup(pid)
            if not info:
                continue
            found[pid] = info
        for child in children_of(pid):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    return found


def classify(pid: int, info: dict, tui_pid: int | None = None) -> str:
    """The role of a sandbox process (TS retitles every node process to
    `prime-agent`, so argv alone cannot tell the daemon from a worker)."""
    cmd, env = info.get("cmd", ""), info.get("env") or set()
    if pid == tui_pid:
        return "tui"
    if "rlm.repl" in cmd:
        return "kernel"
    if re.search(r"(^|/)uv\s", cmd) or "/uv/builds-v0/" in cmd:
        return "bootstrap"
    if "PRIME_AGENT_INTERNAL_DAEMON_WORKER=1" in env or re.search(r"prime-agent\s+worker(\s|$)", cmd):
        return "worker"
    if "--mode daemon" in cmd or "PI_CODING_AGENT=true" in env:
        return "daemon"
    if "prime-agent" in cmd or info.get("name") in ("node", "prime-agent"):
        return "cli"
    return "other"


def pid_alive(pid: int) -> bool:
    if IS_LINUX:
        state = _linux_status(pid).get("State", "")
        return bool(state) and not state.startswith("Z")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    out = subprocess.run(["ps", "-o", "state=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")


def reap(home: str, roots: dict[int, str] | None = None, exclude: set[int] = frozenset(),
         known: dict[int, str] | None = None, grace: float = 5.0,
         rounds: int = 6) -> tuple[list[dict], dict[int, dict]]:
    """SIGTERM then SIGKILL every sandbox process, by PID and identity, until
    two scans find none (a supervisor may respawn a worker once). Returns
    what was signalled and what survived (logged: it should be nothing)."""
    me = os.getpid()
    known = dict(known or {})

    def scan() -> dict[int, dict]:
        procs = {pid: info for pid, info in sandbox_processes(home, roots, known).items()
                 if pid not in exclude and pid > 1 and pid != me}
        known.update({pid: info["ident"] for pid, info in procs.items()})
        return procs

    signalled: list[dict] = []
    quiet_checks = 0
    for _ in range(rounds):
        procs = scan()
        if not procs:
            quiet_checks += 1
            if quiet_checks >= 2:
                break
            time.sleep(0.3)
            continue
        quiet_checks = 0
        for pid, info in procs.items():
            signalled.append({"pid": pid, "name": info.get("name") or info.get("cmd", "")[:40]})
            _signal(pid, signal.SIGTERM, home, info)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and any(pid_alive(pid) for pid in procs):
            time.sleep(0.1)
        for pid, info in procs.items():
            if pid_alive(pid):
                _signal(pid, signal.SIGKILL, home, info)
        time.sleep(0.2)
    survivors = scan()
    if survivors:
        log(f"warning: sandbox processes survived the reap: "
            f"{ {pid: info.get('name') for pid, info in survivors.items()} }")
    return signalled, survivors


def _signal(pid: int, sig: int, home: str, info: dict) -> None:
    # The scan's (pid, start time) must still name the same process, so a
    # pid reused in between is never hit; a pid found by its HOME is also
    # re-checked for it (Linux).
    if identity(pid) != info.get("ident"):
        return
    if IS_LINUX and info.get("envMatched") and f"HOME={home}" not in _linux_environ(pid):
        return
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def load_avg() -> list[float] | None:
    try:
        return [round(value, 2) for value in os.getloadavg()]
    except OSError:
        return None


# -- products and sandboxes --------------------------------------------------------

def resolve_products(ts_bin: str | None, rs_bin: str | None) -> dict[str, dict]:
    """The real files behind the launchers (symlinks resolved), and the argv
    that runs them directly."""
    products = {}
    ts_path = Path(os.path.realpath(ts_bin or TS_LAUNCHER))
    if ts_path.suffix in (".js", ".mjs", ".cjs"):
        node = shutil.which("node")
        if not node:
            raise SystemExit("error: the TS product is a node script but no `node` is on PATH")
        ts_argv = [os.path.realpath(node), str(ts_path)]
    else:
        ts_argv = [str(ts_path)]
    rs_path = Path(os.path.realpath(rs_bin or RS_BINARY))
    for name, path in (("ts", ts_path), ("rs", rs_path)):
        if not path.is_file():
            raise SystemExit(f"error: {LABELS[name]} not found at {path}")
    products["ts"] = {"label": LABELS["ts"], "path": str(ts_path), "argv": ts_argv, "version": None}
    products["rs"] = {"label": LABELS["rs"], "path": str(rs_path), "argv": [str(rs_path)], "version": None}
    return products


def socket_fits(base: Path) -> bool:
    """The deepest daemon socket below a sandbox in `base` fits sun_path,
    and the path has no whitespace (macOS matches `ps -E` tokens)."""
    return not re.search(r"\s", str(base)) and len(str(base).encode()) + SOCKET_TAIL <= SUN_PATH_MAX


def sandbox_base(override: str | None) -> tuple[Path, str]:
    """Where sandboxes go. Linux: /tmp. macOS: $TMPDIR when the deepest
    daemon socket below it still fits sun_path, else /tmp (the per-user
    $TMPDIR there is ~49 bytes already)."""
    if override:
        base = Path(os.path.abspath(override))
        if not socket_fits(base):
            raise SystemExit(f"error: --sandbox-base {base} has whitespace or is too long for the daemon "
                             f"socket paths below it ({SUN_PATH_MAX - SOCKET_TAIL} bytes at most)")
        return base, "--sandbox-base"
    if IS_MAC:
        tmp = Path(os.path.abspath(os.environ.get("TMPDIR") or "/tmp"))
        if socket_fits(tmp):
            return tmp, "$TMPDIR"
        return Path("/tmp"), "/tmp ($TMPDIR too long for daemon socket paths)"
    return Path("/tmp"), "/tmp"


def uv_cache_dir() -> str | None:
    if os.environ.get("UV_CACHE_DIR"):
        return os.environ["UV_CACHE_DIR"]
    uv = shutil.which("uv")
    if not uv:
        return None
    try:
        out = subprocess.run([uv, "cache", "dir"], capture_output=True, text=True, timeout=10,
                             env={**os.environ, "NO_COLOR": "1"}).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return re.sub(r"\x1b\[[0-9;]*m", "", out) or None


def base_env(environ: dict[str, str]) -> dict[str, str]:
    """The caller's env cut to the allow-list: no PRIME_AGENT_* / PI_* var
    (nor anything else product-relevant) can leak into a sandbox."""
    env = {key: environ[key] for key in ENV_KEEP if key in environ}
    assert not any(key.startswith(SCRUB_PREFIXES) for key in env)
    return env


class Sandbox:
    """One fresh, product-specific sandbox (HOME, TMPDIR, XDG_* inside)."""

    created: list["Sandbox"] = []

    def __init__(self, product: str, purpose: str, base: Path, mock_url: str, uv_cache: str | None) -> None:
        self.product = product
        self.purpose = purpose
        # pid -> identity, recorded when this script spawned the process.
        self.roots: dict[int, str] = {}
        self.known: dict[int, str] = {}
        self.env: dict[str, str] = {}
        base.mkdir(parents=True, exist_ok=True)
        self.root = Path(os.path.abspath(tempfile.mkdtemp(prefix="pb.", dir=str(base))))
        self.home = self.root / "h"
        self.tmp = self.root / "t"
        self.work = self.root / "w"
        self.agent_dir = self.home / ".prime" / "agent"
        Sandbox.created.append(self)
        try:
            self.setup(mock_url, uv_cache)
        except BaseException:
            self.teardown()
            raise

    def setup(self, mock_url: str, uv_cache: str | None) -> None:
        for sub in ("h", "t", "w", "x/config", "x/data", "x/cache", "x/state"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        self.agent_dir.mkdir(parents=True, mode=0o700)
        self.env = base_env(dict(os.environ))
        self.env.update({
            "HOME": str(self.home), "TMPDIR": str(self.tmp), "XDG_CONFIG_HOME": str(self.root / "x/config"),
            "XDG_DATA_HOME": str(self.root / "x/data"), "XDG_CACHE_HOME": str(self.root / "x/cache"),
            "XDG_STATE_HOME": str(self.root / "x/state"), "TERM": "xterm-256color",
            "PI_SKIP_VERSION_CHECK": "1", "DO_NOT_TRACK": "1", "PRIME_AGENT_TELEMETRY": "0",
        })
        if uv_cache:
            self.env["UV_CACHE_DIR"] = uv_cache
        if self.product == "rs":
            self.env.update({"PRIME_AGENT_DISABLE_SELF_UPDATE": "1", "PRIME_AGENT_RUST_INSTALLER_URL": DEAD_URL,
                             "PRIME_AGENT_DOWNLOAD_BASE_URL": DEAD_URL})
        self.write_agent_files(self.agent_dir, mock_url)

    def write_agent_files(self, agent_dir: Path, mock_url: str, extra_providers: dict | None = None) -> None:
        """models.json with the mock provider (plus copied real providers in
        live mode, 0600) and settings that skip onboarding and telemetry."""
        agent_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        providers = dict(extra_providers or {})
        providers[MOCK_PROVIDER] = mock_provider_entry(mock_url)
        models = agent_dir / "models.json"
        fd = os.open(models, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump({"providers": providers}, handle, indent=2)
        (agent_dir / "settings.json").write_text(json.dumps(
            {"onboardingShown": True, "telemetry": {"enabled": False, "noticeShown": True}}, indent=2) + "\n")

    def add_root(self, pid: int) -> None:
        """Track a process this script just spawned, under its identity now
        (a pid already gone is not tracked: its number may be reused)."""
        ident = identity(pid)
        if ident is not None:
            self.roots[pid] = ident

    def processes(self) -> dict[int, dict]:
        found = sandbox_processes(str(self.home), self.roots, self.known)
        self.known = {pid: info["ident"] for pid, info in found.items()}
        return found

    def reap(self, exclude: set[int] = frozenset()) -> list[dict]:
        signalled, survivors = reap(str(self.home), self.roots, exclude, self.known)
        self.roots = {pid: ident for pid, ident in self.roots.items()
                      if pid in survivors and survivors[pid]["ident"] == ident}
        self.known = {pid: info["ident"] for pid, info in survivors.items()}
        return signalled

    def teardown(self) -> None:
        """Every step runs even when one before it fails; the models.json
        copies (a live key under --live-sol) go first."""
        for models in self.root.glob("h/.prime/*/models.json"):
            try:
                models.unlink()
            except OSError as error:
                log(f"warning: could not delete {models}: {error}")
        if (self.root / "tm").exists():
            try:
                subprocess.run(["tmux", "-S", str(self.root / "tm"), "kill-server"], capture_output=True,
                               env=self.env, timeout=10)
            except (OSError, subprocess.SubprocessError) as error:
                log(f"warning: tmux kill-server for {self.root} failed: {error}")
        try:
            self.reap()
        except Exception as error:  # noqa: BLE001 - the directory still goes
            log(f"warning: reaping {self.root} failed: {error}")
        shutil.rmtree(self.root, ignore_errors=True)
        if self.root.exists():
            log(f"warning: could not remove sandbox {self.root}")
        if self in Sandbox.created:
            Sandbox.created.remove(self)


def teardown_all() -> None:
    """Tear every registered sandbox down; a second Ctrl-C cannot cut it short."""
    main_thread = threading.current_thread() is threading.main_thread()
    previous = signal.getsignal(signal.SIGINT) if main_thread else None
    if main_thread:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        for sandbox in list(Sandbox.created):
            try:
                sandbox.teardown()
            except Exception as error:  # noqa: BLE001 - teardown must reach every sandbox
                log(f"teardown of {sandbox.root} failed: {error}")
    finally:
        if main_thread and previous is not None:
            signal.signal(signal.SIGINT, previous)


# -- headless runs -------------------------------------------------------------------

def json_events(stdout: str) -> list[dict]:
    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def final_assistant(events: list[dict]) -> dict | None:
    """The last assistant message of a JSON event stream (message_end first,
    agent_end's message list as the fallback)."""
    last = None
    for event in events:
        message = event.get("message")
        if event.get("type") == "message_end" and isinstance(message, dict) and message.get("role") == "assistant":
            last = message
    if last is None:
        for event in events:
            if event.get("type") == "agent_end":
                for message in event.get("messages") or []:
                    if isinstance(message, dict) and message.get("role") == "assistant":
                        last = message
    return last


def replied(final: dict) -> bool:
    """A final assistant message that ended its turn with a reply: `stop`
    (not length, toolUse, error or aborted, and not a missing message)."""
    return final.get("role") == "assistant" and final.get("stopReason") in SUCCESS_STOP_REASONS


def reply_text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in content or [] if isinstance(part, dict)
                   and part.get("type") == "text" and isinstance(part.get("text"), str))


def run_headless(sandbox: Sandbox, argv: list[str], mock: MockProvider | None, poll: float,
                 timeout: float, run: int) -> dict:
    """One headless run: wall time to the agent_end line on stdout and to
    exit (a blocking wait4 in its own thread), the CLI's wait4 max RSS, and
    the peak summed RSS of every sandbox process, scanned every `poll` while
    the CLI runs. A run counts only with a final assistant message that
    replied (stopReason `stop`); against the mock, also only when the
    provider got a request and the reply is the mock's."""
    mark = mock.mark() if mock else 0
    stderr_path = sandbox.root / f"stderr-{run}.log"
    agent_end: list[float] = []
    lines: list[str] = []
    with open(stderr_path, "wb") as stderr:
        started = time.monotonic()
        proc = subprocess.Popen(argv, cwd=sandbox.work, env=sandbox.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=stderr, start_new_session=True)
        sandbox.add_root(proc.pid)

        def read() -> None:
            for raw in proc.stdout:
                line = raw.decode(errors="replace")
                lines.append(line)
                if not agent_end and '"agent_end"' in line:
                    try:
                        if json.loads(line).get("type") == "agent_end":
                            agent_end.append(time.monotonic() - started)
                    except json.JSONDecodeError:
                        pass

        exited: dict = {}

        def wait() -> None:
            _, status, rusage = os.wait4(proc.pid, 0)
            exited.update(at=time.monotonic() - started, status=status, rusage=rusage)

        reader = threading.Thread(target=read, daemon=True)
        waiter = threading.Thread(target=wait, daemon=True)
        reader.start()
        waiter.start()
        peak_rss = 0
        peak_count = 0
        while waiter.is_alive():
            if time.monotonic() - started > timeout:
                sandbox.reap()
                waiter.join(timeout=30)
                break
            procs = sandbox.processes()
            total = sum(info["rssKb"] for info in procs.values())
            if total > peak_rss:
                peak_rss, peak_count = total, len(procs)
            waiter.join(timeout=poll)
        reader.join(timeout=10)
        if not reader.is_alive():
            proc.stdout.close()
    if "status" in exited:
        proc.returncode = os.waitstatus_to_exitcode(exited["status"])
        sandbox.roots.pop(proc.pid, None)
    rusage = exited.get("rusage")
    max_rss = (rusage.ru_maxrss // 1024 if IS_MAC else rusage.ru_maxrss) if rusage else None
    requests = mock.since(mark) if mock else []
    events = json_events("".join(lines))
    final = final_assistant(events) or {}
    posted = [r for r in requests if r["path"].endswith(("/chat/completions", "/responses"))]
    ok = (proc.returncode == 0 and bool(agent_end) and replied(final)
          and (mock is None or (bool(posted) and reply_text(final).strip() == MOCK_REPLY)))
    sample = {"run": run, "ok": ok, "exitCode": proc.returncode,
              "agentEndS": round(agent_end[0], 4) if agent_end else None,
              "exitS": round(exited["at"], 4) if "at" in exited else None,
              "stopReason": final.get("stopReason"), "maxRssKb": max_rss,
              "peakSandboxRssKb": max(peak_rss, max_rss or 0), "peakProcesses": peak_count,
              "requestBytes": max((r["bytes"] for r in requests), default=None),
              "requests": [{"path": r["path"], "bytes": r["bytes"], "messages": r["messages"]} for r in requests]}
    if not ok:
        sample["stderrTail"] = stderr_path.read_text(errors="replace")[-2000:]
        sample["stdoutTail"] = "".join(lines)[-1000:]
    sample["_events"] = events
    return sample


def headless_argv(product: dict, extra: list[str], message: str) -> list[str]:
    return [*product["argv"], "-p", "--mode", "json", *extra, *HEADLESS_FLAGS,
            "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL, "--", message]


def strip_events(sample: dict) -> dict:
    sample.pop("_events", None)
    return sample


def headless_summary(samples: list[dict]) -> dict:
    good = [sample for sample in samples if sample["ok"]]
    return {key: summarize([sample[key] for sample in good])
            for key in ("agentEndS", "exitS", "maxRssKb", "peakSandboxRssKb", "requestBytes")}


def interleaved(runs: int, names: list[str]) -> list[tuple[int, str]]:
    """(run, product) pairs alternating the product order every run, so a
    drift in machine load hits both products alike."""
    order = []
    for run in range(runs):
        ordered = names if run % 2 == 0 else list(reversed(names))
        order.extend((run, name) for name in ordered)
    return order


# -- measurements ----------------------------------------------------------------------

class Bench:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.products = resolve_products(args.ts_bin, args.rs_bin)
        self.names = [name for name in PRODUCTS if name in args.products]
        self.base, self.base_reason = sandbox_base(args.sandbox_base)
        self.uv_cache = uv_cache_dir()
        self.mock = MockProvider()
        self.poll = args.poll if args.poll else (0.02 if IS_LINUX else 0.1)
        self.corpus: dict | None = None

    def sandbox(self, product: str, purpose: str) -> Sandbox:
        return Sandbox(product, purpose, self.base, self.mock.base_url, self.uv_cache)

    # 1. --version cold start
    def measure_version(self) -> dict:
        result = {}
        for name in self.names:
            product = self.products[name]
            sandbox = self.sandbox(name, "version")
            try:
                product["version"] = probe_version(product, sandbox)
                entry = {"ok": False, "method": None, "samples": [], "summary": None, "error": None}
                hyperfine = shutil.which("hyperfine")
                if hyperfine:
                    export = sandbox.root / "hyperfine.json"
                    command = shlex.join([*product["argv"], "--version"])
                    proc = subprocess.run([hyperfine, "-N", "--style", "none", "--warmup",
                                           str(self.args.version_warmup), "--runs", str(self.args.version_runs),
                                           "--export-json", str(export), "--", command],
                                          cwd=sandbox.work, env=sandbox.env, capture_output=True, text=True)
                    if proc.returncode == 0 and export.exists():
                        entry["method"] = "hyperfine"
                        entry["samples"] = [round(t, 5) for t in json.loads(export.read_text())["results"][0]["times"]]
                    else:
                        entry["error"] = f"hyperfine failed: {proc.stderr.strip()[-500:]}"
                if not entry["samples"]:
                    entry["method"] = "loop"
                    for index in range(self.args.version_warmup + self.args.version_runs):
                        started = time.perf_counter()
                        proc = subprocess.run([*product["argv"], "--version"], cwd=sandbox.work, env=sandbox.env,
                                              capture_output=True)
                        elapsed = time.perf_counter() - started
                        if proc.returncode != 0:
                            entry["error"] = f"--version exited {proc.returncode}"
                            break
                        if index >= self.args.version_warmup:
                            entry["samples"].append(round(elapsed, 5))
                entry["summary"] = {"wallS": summarize(entry["samples"])}
                entry["ok"] = len(entry["samples"]) == self.args.version_runs
                result[name] = entry
                log(f"version {name}: median {entry['summary']['wallS'] and entry['summary']['wallS']['median']}s "
                    f"({entry['method']})")
            finally:
                sandbox.teardown()
        return result

    # 2. headless one-shot (steady, then cold)
    def measure_oneshot(self) -> tuple[dict, dict]:
        steady: dict = {}
        cold: dict = {}
        sandboxes = {name: self.sandbox(name, "oneshot") for name in self.names}
        try:
            for name in self.names:
                argv = headless_argv(self.products[name], ["--no-session"], "say hi")
                first = strip_events(run_headless(sandboxes[name], argv, self.mock, self.poll,
                                                  self.args.run_timeout, run=-1))
                steady[name] = {"ok": False, "firstRun": first, "samples": [], "summary": None, "error": None}
                cold[name] = {"ok": False, "firstRun": None, "samples": [], "summary": None, "error": None}
                log(f"oneshot {name} first run: agent_end {first['agentEndS']}s ok={first['ok']}")
            for variant, store in (("steady", steady), ("cold", cold)):
                for run, name in interleaved(self.args.runs, self.names):
                    if variant == "cold":
                        sandboxes[name].reap()
                    argv = headless_argv(self.products[name], ["--no-session"], "say hi")
                    sample = strip_events(run_headless(sandboxes[name], argv, self.mock, self.poll,
                                                       self.args.run_timeout, run))
                    store[name]["samples"].append(sample)
                    log(f"oneshot[{variant}] {name} #{run}: agent_end {sample['agentEndS']}s "
                        f"rss {sample['maxRssKb'] // 1024}MB ok={sample['ok']}")
            for store in (steady, cold):
                for name in self.names:
                    entry = store[name]
                    entry["summary"] = headless_summary(entry["samples"])
                    entry["ok"] = bool(entry["samples"]) and all(sample["ok"] for sample in entry["samples"])
                    if not entry["ok"]:
                        entry["error"] = "a run failed (see samples[].stderrTail)"
        finally:
            for sandbox in sandboxes.values():
                sandbox.teardown()
        return steady, cold

    # 3. resume a large transcript
    def measure_resume(self) -> dict:
        result: dict = {}
        sandboxes = {name: self.sandbox(name, "resume") for name in self.names}
        transcripts: dict[str, tuple[Path, str]] = {}
        try:
            for name in self.names:
                sandbox = sandboxes[name]
                session_id = "019f0000-0000-7000-8000-" + hashlib.sha256(name.encode()).hexdigest()[:12]
                rows = build_corpus(str(sandbox.work), session_id, self.args.corpus_rows)
                text = "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows)
                # Same generator and seed for both products (only the cwd and
                # id differ), so the facts of either describe both.
                self.corpus = corpus_facts(rows, text)
                session_file = sandbox.agent_dir / "sessions" / f"{session_id}.jsonl"
                session_file.parent.mkdir(parents=True, exist_ok=True)
                transcripts[name] = (session_file, text)
                result[name] = {"ok": False, "firstRun": None, "samples": [], "summary": None, "error": None}

            def one(name: str, run: int) -> dict:
                session_file, text = transcripts[name]
                session_file.write_text(text)  # a pristine copy: every run appends to it
                argv = headless_argv(self.products[name], ["--resume", str(session_file)], "continue")
                sample = strip_events(run_headless(sandboxes[name], argv, self.mock, self.poll,
                                                   self.args.run_timeout, run))
                sent = max((request["messages"] or 0 for request in sample["requests"]), default=0)
                sample["requestMessages"] = sent
                # The resumed transcript must really reach the provider.
                if sample["ok"] and sent < self.corpus["messageRows"] // 2:
                    sample["ok"] = False
                    sample["error"] = f"provider saw {sent} messages, the transcript has {self.corpus['messageRows']}"
                return sample

            for name in self.names:
                result[name]["firstRun"] = one(name, -1)
                log(f"resume {name} first run: agent_end {result[name]['firstRun']['agentEndS']}s "
                    f"msgs {result[name]['firstRun']['requestMessages']} ok={result[name]['firstRun']['ok']}")
            for run, name in interleaved(self.args.runs, self.names):
                sample = one(name, run)
                result[name]["samples"].append(sample)
                log(f"resume {name} #{run}: agent_end {sample['agentEndS']}s msgs {sample['requestMessages']} "
                    f"ok={sample['ok']}")
            for name in self.names:
                entry = result[name]
                entry["summary"] = headless_summary(entry["samples"])
                entry["ok"] = bool(entry["samples"]) and all(sample["ok"] for sample in entry["samples"])
                if not entry["ok"]:
                    entry["error"] = "a run failed (see samples[].error / stderrTail)"
        finally:
            for sandbox in sandboxes.values():
                sandbox.teardown()
        return result

    # 4. interactive start-to-ready and idle RAM
    def tmux(self, sandbox: Sandbox, *args: str, check: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(["tmux", "-S", str(sandbox.root / "tm"), "-f", "/dev/null", *args],
                              env=sandbox.env, capture_output=True, text=True, check=check, timeout=30)

    def launch_tui(self, sandbox: Sandbox, name: str, session: str) -> tuple[float, int, int]:
        argv = [*self.products[name]["argv"], "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL]
        # Several words: tmux execs them directly (no shell), and `env -i`
        # hands the product exactly the sandbox env, whatever the server has.
        pane = ["env", "-i", *(f"{key}={value}" for key, value in sorted(sandbox.env.items())), *argv]
        started = time.monotonic()
        self.tmux(sandbox, "new-session", "-d", "-x", "200", "-y", "50", "-s", session, "-c", str(sandbox.work),
                  *pane, check=True)
        ids = self.tmux(sandbox, "display-message", "-p", "-t", session, "#{pid} #{pane_pid}").stdout.split()
        server_pid, pane_pid = int(ids[0]), int(ids[1])
        sandbox.add_root(pane_pid)
        return started, server_pid, pane_pid

    def wait_ready(self, sandbox: Sandbox, session: str, started: float, timeout: float) -> dict:
        first_frame = None
        frame = ""
        while time.monotonic() - started < timeout:
            capture = self.tmux(sandbox, "capture-pane", "-p", "-t", session)
            if capture.returncode != 0:
                break  # the pane (so the product) is gone
            frame = capture.stdout
            now = time.monotonic() - started
            if first_frame is None and frame.strip():
                first_frame = now
            if is_ready(frame):
                return {"readyS": round(now, 4), "firstFrameS": round(first_frame, 4), "frame": frame}
            time.sleep(0.02)
        return {"readyS": None, "firstFrameS": round(first_frame, 4) if first_frame else None, "frame": frame}

    def quit_tui(self, sandbox: Sandbox, session: str, pane_pid: int) -> tuple[float | None, bool]:
        """Send the quit keys; seconds from the last key to the TUI's exit."""
        for index, key in enumerate(QUIT_KEYS):
            if index:
                time.sleep(0.2)
            self.tmux(sandbox, "send-keys", "-t", session, key)
        started = time.monotonic()
        while time.monotonic() - started < 10:
            if not pid_alive(pane_pid):
                # tmux reaped it: the pid is free for reuse, so it stops
                # being a root the reap would signal unchecked.
                sandbox.roots.pop(pane_pid, None)
                return round(time.monotonic() - started, 3), True
            time.sleep(0.05)
        return None, False

    def measure_interactive(self) -> dict:
        result: dict = {}
        sandboxes = {name: self.sandbox(name, "interactive") for name in self.names}
        try:
            for name in self.names:
                result[name] = {"ok": False, "firstRun": None, "samples": [], "summary": None,
                                "readyFrame": None, "error": None}
                result[name]["firstRun"] = self.interactive_first_run(sandboxes[name], name)
            for run, name in interleaved(self.args.runs, self.names):
                sample = self.interactive_run(sandboxes[name], name, run)
                result[name]["samples"].append(sample)
                if sample.get("frame") and not result[name]["readyFrame"]:
                    result[name]["readyFrame"] = sample["frame"]
                sample.pop("frame", None)
                log(f"interactive {name} #{run}: ready {sample['readyS']}s idle "
                    f"{(sample['idleRssKb'] or 0) // 1024}MB {sample['idleByRole']} quit={sample['cleanQuit']}")
            for name in self.names:
                entry = result[name]
                good = [sample for sample in entry["samples"] if sample["ok"]]
                roles = sorted({role for sample in good for role in sample["idleByRole"]})
                entry["summary"] = {
                    "readyS": summarize([sample["readyS"] for sample in good]),
                    "firstFrameS": summarize([sample["firstFrameS"] for sample in good]),
                    "idleRssKb": summarize([sample["idleRssKb"] for sample in good]),
                    "afterQuitRssKb": summarize([sample["afterQuitRssKb"] for sample in good]),
                    "idleByRole": {role: summarize([sample["idleByRole"].get(role, 0) for sample in good])
                                   for role in roles},
                }
                # Warm samples mean something only once the bootstrap finished.
                entry["ok"] = (bool(entry["firstRun"] and entry["firstRun"]["ok"]) and bool(entry["samples"])
                               and all(sample["ok"] for sample in entry["samples"]))
                if not entry["ok"]:
                    entry["error"] = ("the first-run bootstrap failed (see firstRun.error)"
                                      if not entry["firstRun"]["ok"]
                                      else "a launch never reached the ready frame (see samples[].error)")
        finally:
            for sandbox in sandboxes.values():
                sandbox.teardown()
        return result

    def interactive_first_run(self, sandbox: Sandbox, name: str) -> dict:
        """The fresh sandbox's first launch: start-to-ready plus the one-time
        bootstrap (until the kernel is up and no uv process is left)."""
        started, server_pid, pane_pid = self.launch_tui(sandbox, name, "first")
        ready = self.wait_ready(sandbox, "first", started, self.args.bootstrap_timeout)
        bootstrap = None
        first_settled = None
        settled = 0
        while time.monotonic() - started < self.args.bootstrap_timeout:
            roles = [classify(pid, info, pane_pid) for pid, info in sandbox.processes().items() if pid != server_pid]
            if "kernel" in roles and "bootstrap" not in roles:
                first_settled = first_settled or time.monotonic() - started
                settled += 1
            else:
                first_settled, settled = None, 0
            if settled >= 2:  # seen settled twice, a second apart
                bootstrap = round(first_settled, 2)
                break
            time.sleep(1.0)
        self.quit_tui(sandbox, "first", pane_pid)
        self.tmux(sandbox, "kill-server")
        sandbox.reap()
        entry = {"ok": ready["readyS"] is not None and bootstrap is not None, "readyS": ready["readyS"],
                 "firstFrameS": ready["firstFrameS"], "bootstrapS": bootstrap, "error": None}
        if not entry["ok"]:
            entry["error"] = ("never reached the ready frame" if ready["readyS"] is None
                              else f"kernel bootstrap not done within {self.args.bootstrap_timeout}s")
            entry["lastFrame"] = ready["frame"][-3000:]
        log(f"interactive {name} first run: ready {entry['readyS']}s bootstrap {bootstrap}s")
        return entry

    def interactive_run(self, sandbox: Sandbox, name: str, run: int) -> dict:
        session = f"r{run}"
        started, server_pid, pane_pid = self.launch_tui(sandbox, name, session)
        ready = self.wait_ready(sandbox, session, started, self.args.ready_timeout)
        sample = {"run": run, "ok": ready["readyS"] is not None, "readyS": ready["readyS"],
                  "firstFrameS": ready["firstFrameS"], "idleRssKb": None, "idleByRole": {}, "processes": [],
                  "quitS": None, "cleanQuit": False, "afterQuitRssKb": None, "afterQuitRoles": [], "reaped": 0,
                  "frame": ready["frame"] if ready["readyS"] is not None else None}
        if ready["readyS"] is None:
            sample["error"] = "never reached the ready frame"
            sample["lastFrame"] = ready["frame"][-3000:]
        else:
            time.sleep(self.args.idle_seconds)
            procs = {pid: info for pid, info in sandbox.processes().items() if pid != server_pid}
            for pid, info in sorted(procs.items()):
                role = classify(pid, info, pane_pid)
                sample["processes"].append({"pid": pid, "ppid": info["ppid"], "role": role,
                                            "name": info["name"], "rssKb": info["rssKb"]})
                sample["idleByRole"][role] = sample["idleByRole"].get(role, 0) + info["rssKb"]
            sample["idleRssKb"] = sum(info["rssKb"] for info in procs.values())
        sample["quitS"], sample["cleanQuit"] = self.quit_tui(sandbox, session, pane_pid)
        time.sleep(1.0)
        left = {pid: info for pid, info in sandbox.processes().items() if pid != server_pid}
        sample["afterQuitRssKb"] = sum(info["rssKb"] for info in left.values())
        sample["afterQuitRoles"] = sorted(classify(pid, info) for pid, info in left.items())
        self.tmux(sandbox, "kill-session", "-t", session)
        sample["reaped"] = len(sandbox.reap(exclude={server_pid}))
        return sample

    # 5. live sol probe (opt-in)
    def measure_live_sol(self) -> dict:
        args = self.args
        providers = live_provider_copy(LIVE_MODELS_JSON, args.live_provider)
        # A login-pinned id (`antevon/gpt-6.1-sol`) is answered by the bare id.
        accepted = {args.live_model, args.live_model.split("/", 1)[-1]}
        result: dict = {}
        sandboxes = {name: self.sandbox(name, "live") for name in self.names}
        try:
            for name, sandbox in sandboxes.items():
                if name == "rs":
                    apply_rs_launcher_env(sandbox, self.mock.base_url, providers)
                else:
                    sandbox.write_agent_files(sandbox.agent_dir, self.mock.base_url, providers)
            for name in self.names:
                result[name] = {"ok": False, "samples": [], "summary": None, "error": None,
                                "env": "prime-agent-rs launcher" if name == "rs" else "sandbox"}
                warm = run_headless(sandboxes[name], headless_argv(self.products[name], ["--no-session"], "say hi"),
                                    self.mock, self.poll, args.run_timeout, run=-1)
                result[name]["warmupOk"] = warm["ok"]
            for run, name in interleaved(args.live_runs, self.names):
                sandbox = sandboxes[name]
                argv = [*self.products[name]["argv"], "-p", "--mode", "json", "--provider", args.live_provider,
                        "--model", args.live_model, "--thinking", args.live_thinking, "--cwd", str(sandbox.work),
                        "--no-session", "--no-skills", "--no-extensions", "--no-prompt-templates", "--no-themes",
                        "--no-tools", "--", args.live_brief]
                raw = run_headless(sandbox, argv, None, max(self.poll, 0.1), args.run_timeout, run)
                events = raw.pop("_events")
                message = final_assistant(events) or {}
                usage = message.get("usage") or {}
                models = response_models(events)
                sample = {"run": run, "ok": False, "exitCode": raw["exitCode"], "agentEndS": raw["agentEndS"],
                          "exitS": raw["exitS"], "responseModel": models[-1] if models else None,
                          "stopReason": message.get("stopReason"),
                          "usage": {key: usage.get(key) for key in
                                    ("input", "output", "cacheRead", "cacheWrite", "totalTokens")}}
                # A provider error still ends the agent cleanly: the reply
                # must also be a real one from the requested model.
                sample["ok"] = raw["ok"] and replied(message) and sample["responseModel"] in accepted
                if message.get("errorMessage"):
                    sample["errorMessage"] = redact(str(message["errorMessage"]))[:500]
                if not sample["ok"]:
                    sample["stderrTail"] = redact(raw.get("stderrTail") or "")[-1500:]
                result[name]["samples"].append(sample)
                log(f"liveSol {name} #{run}: agent_end {sample['agentEndS']}s model {sample['responseModel']} "
                    f"usage {sample['usage']}")
            for name in self.names:
                entry = result[name]
                good = [sample for sample in entry["samples"] if sample["ok"]]
                entry["summary"] = {"agentEndS": summarize([s["agentEndS"] for s in good]),
                                    "exitS": summarize([s["exitS"] for s in good]),
                                    "outputTokens": summarize([s["usage"]["output"] for s in good])}
                entry["ok"] = bool(entry["samples"]) and all(sample["ok"] for sample in entry["samples"])
        finally:
            for sandbox in sandboxes.values():
                sandbox.teardown()
        return result


def probe_version(product: dict, sandbox: Sandbox) -> str | None:
    """`--version` output (TS prints it on stderr in a fresh sandbox)."""
    out = subprocess.run([*product["argv"], "--version"], cwd=sandbox.work, env=sandbox.env,
                         capture_output=True, text=True, timeout=60)
    lines = (out.stdout.strip() or out.stderr.strip()).splitlines()
    return lines[-1].strip() if out.returncode == 0 and lines else None


def is_ready(frame: str) -> bool:
    return bool(READY_PROMPT.search(frame)) and "manage" in frame and bool(READY_STATUS.search(frame))


def response_models(events: list[dict]) -> list[str]:
    """Every responseModel value in a JSON event stream, in order."""
    found: list[str] = []

    def walk(value: object) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "responseModel" and isinstance(item, str):
                    found.append(item)
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(events)
    return found


def live_provider_copy(models_json: Path, provider: str) -> dict:
    """The live provider's entry from the real models.json, for the
    sandbox's 0600 copy. Only that provider is copied. A `!command` apiKey
    is resolved here, once, with the caller's real env (the command reads
    the caller's home, which a sandbox HOME hides) and written as the
    literal key; it is never printed."""
    providers = json.loads(models_json.read_text()).get("providers", {})
    if provider not in providers or provider == MOCK_PROVIDER:
        raise SystemExit(f"error: provider {provider} is not in {models_json}")
    entry = json.loads(json.dumps(providers[provider]))
    key = entry.get("apiKey")
    if isinstance(key, str) and key.startswith("!"):
        out = subprocess.run(key[1:], shell=True, capture_output=True, text=True, timeout=60)
        if out.returncode != 0 or not out.stdout.strip():
            raise SystemExit(f"error: the {provider} apiKey command failed (exit {out.returncode})")
        entry["apiKey"] = out.stdout.strip()
    if isinstance(entry.get("apiKey"), str) and len(entry["apiKey"]) >= 8:
        SECRETS.add(entry["apiKey"])
    return {provider: entry}


def redact(text: str) -> str:
    for secret in SECRETS:
        text = text.replace(secret, "<redacted>")
    return re.sub(r"(sk-|Bearer\s+|eyJ)[A-Za-z0-9._\-]{8,}", r"\1<redacted>", text)


def apply_rs_launcher_env(sandbox: Sandbox, mock_url: str, providers: dict) -> None:
    """Give the Rust sandbox the env the prime-agent-rs launcher would hand a
    real run (computed by the installed launcher itself, under the sandbox's
    HOME/TMPDIR, so every dir it names sits in the sandbox), and seed that
    agent dir."""
    effective = None
    if RS_LAUNCHER.is_file():
        proc = subprocess.run([str(RS_LAUNCHER)], env={**sandbox.env, "PRIME_AGENT_RS_PRINT_ENV": "1"},
                              capture_output=True, text=True, timeout=30)
        if proc.returncode == 0:
            effective = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
            effective.pop("binary", None)
    if effective is None:
        socket_dir = sandbox.tmp / f"pa-rs-{os.getuid()}"
        socket_dir.mkdir(mode=0o700, exist_ok=True)
        agent_dir = sandbox.home / ".prime" / "agent-rs"
        effective = {"PRIME_AGENT_CODING_AGENT_DIR": str(agent_dir), "PRIME_AGENT_SOCKET_DIR": str(socket_dir),
                     "PRIME_AGENT_DAEMON_SOCKET": str(socket_dir / "daemon.sock"),
                     "PRIME_AGENT_KERNEL_VENV": str(agent_dir / "kernel-venv"),
                     "PRIME_AGENT_DISABLE_SELF_UPDATE": "1", "PRIME_AGENT_RUST_INSTALLER_URL": DEAD_URL,
                     "PRIME_AGENT_DOWNLOAD_BASE_URL": DEAD_URL, "PI_SKIP_VERSION_CHECK": "1"}
    for key, value in effective.items():
        if key.endswith(("_DIR", "_SOCKET", "_VENV")) and not Path(value).resolve().is_relative_to(
                sandbox.root.resolve()):
            raise SystemExit(f"error: the Rust launcher env puts {key} outside the sandbox: {value}")
    sandbox.env.update(effective)
    sandbox.write_agent_files(Path(effective["PRIME_AGENT_CODING_AGENT_DIR"]), mock_url, providers)


# -- machine facts and output ------------------------------------------------------------

def tool_version(argv: list[str]) -> str | None:
    if not shutil.which(argv[0]):
        return None
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return re.sub(r"\x1b\[[0-9;]*m", "", (out.stdout or out.stderr).strip().splitlines()[0]) if (
        out.stdout or out.stderr).strip() else None


def machine_facts() -> dict:
    cpu_model = None
    ram = None
    if IS_LINUX:
        try:
            cpu_model = next((line.split(":", 1)[1].strip() for line in open("/proc/cpuinfo")
                              if line.startswith("model name")), None)
            ram = next((int(line.split()[1]) * 1024 for line in open("/proc/meminfo")
                        if line.startswith("MemTotal:")), None)
        except OSError:
            pass
    elif IS_MAC:
        cpu_model = tool_version(["sysctl", "-n", "machdep.cpu.brand_string"])
        memsize = tool_version(["sysctl", "-n", "hw.memsize"])
        ram = int(memsize) if memsize and memsize.isdigit() else None
    return {"hostname": socket.gethostname(), "os": platform.platform(), "system": platform.system(),
            "release": platform.release(), "machine": platform.machine(),
            "macVersion": platform.mac_ver()[0] or None, "cpuModel": cpu_model, "cpuCount": os.cpu_count(),
            "ramBytes": ram, "loadAvgBefore": load_avg(), "loadAvgAfter": None,
            "tools": {"hyperfine": tool_version(["hyperfine", "--version"]), "tmux": tool_version(["tmux", "-V"]),
                      "node": tool_version(["node", "--version"]), "uv": tool_version(["uv", "--version"]),
                      "python": platform.python_version()}}


def _cell(summary: dict | None, scale: float = 1.0, digits: int = 3) -> str:
    if not summary:
        return "n/a"
    return f"{summary['median'] * scale:.{digits}f} ({summary['p90'] * scale:.{digits}f})"


def _ratio(ts: dict | None, rs: dict | None) -> str:
    if not ts or not rs or not ts.get("median"):
        return "n/a"
    return f"{rs['median'] / ts['median']:.2f}x"


def render_markdown(result: dict) -> str:
    host = result["host"]
    products = result["products"]
    measurements = result["measurements"]
    mb = 1 / 1024
    lines = [
        f"# prime-agent side-by-side bench: {host['hostname']} ({result['startedAt']})",
        "",
        f"- Host: {host['os']}, {host['cpuModel'] or '?'}, {host['cpuCount']} CPUs, "
        f"{(host['ramBytes'] or 0) / 2**30:.0f} GiB RAM; load avg before {host['loadAvgBefore']}, "
        f"after {host['loadAvgAfter']}",
    ]
    for name in PRODUCTS:
        if name in products:
            lines.append(f"- {products[name]['label']}: {products[name]['version'] or '?'} "
                         f"(`{products[name]['path']}`)")
    config = result["config"]
    lines += [f"- Runs: {config['runs']} per measurement, TS and Rust interleaved (version: {config['versionRuns']} "
              f"after {config['versionWarmup']} warmup); medians with p90 in parentheses; mock provider on 127.0.0.1",
              "", "| Measurement | Metric | TS | Rust | Rust/TS |", "|---|---|---|---|---|"]

    def row(label: str, metric: str, key: str, *path: str, scale: float = 1.0, digits: int = 3) -> None:
        block = measurements.get(key) or {}
        ts = _get(block.get("ts"), *path)
        rs = _get(block.get("rs"), *path)
        if ts is None and rs is None:
            return
        lines.append(f"| {label} | {metric} | {_cell(ts, scale, digits)} | {_cell(rs, scale, digits)} | "
                     f"{_ratio(ts, rs)} |")

    row("`--version`", "wall s", "version", "summary", "wallS")
    row("one-shot `-p` (steady)", "to agent_end s", "oneshot", "summary", "agentEndS")
    row("one-shot `-p` (steady)", "CLI max RSS MB", "oneshot", "summary", "maxRssKb", scale=mb, digits=0)
    row("one-shot `-p` (steady)", "peak sandbox RSS MB", "oneshot", "summary", "peakSandboxRssKb", scale=mb,
        digits=0)
    row("one-shot `-p` (steady)", "provider request KB", "oneshot", "summary", "requestBytes", scale=1 / 1024,
        digits=1)
    row("one-shot `-p` (cold, reaped)", "to agent_end s", "oneshotCold", "summary", "agentEndS")
    row("one-shot `-p` (cold, reaped)", "peak sandbox RSS MB", "oneshotCold", "summary", "peakSandboxRssKb",
        scale=mb, digits=0)
    corpus = result.get("corpus") or {}
    rows = corpus.get("messageRows")
    row(f"resume {rows or '?'}-row transcript", "to agent_end s", "resume", "summary", "agentEndS")
    row(f"resume {rows or '?'}-row transcript", "CLI max RSS MB", "resume", "summary", "maxRssKb", scale=mb,
        digits=0)
    row("interactive", "start-to-ready s", "interactive", "summary", "readyS")
    row("interactive", f"idle RSS MB (all procs, {config['idleSeconds']}s idle)", "interactive", "summary",
        "idleRssKb", scale=mb, digits=0)
    row("interactive", "RSS left after quit MB", "interactive", "summary", "afterQuitRssKb", scale=mb, digits=0)
    row("live sol (real provider)", "to agent_end s", "liveSol", "summary", "agentEndS")

    firsts = [(key, name, (measurements.get(key) or {}).get(name, {}).get("firstRun"))
              for key in ("oneshot", "resume") for name in PRODUCTS]
    firsts = [(key, name, first) for key, name, first in firsts if first]
    if firsts:
        lines += ["", "First headless run in each fresh sandbox (one-time setup, not in the samples above): "
                  + "; ".join(f"{key} {LABELS[name]} agent_end {first['agentEndS']} s, exit {first['exitS']} s"
                              for key, name, first in firsts)]
    interactive = measurements.get("interactive") or {}
    if interactive:
        lines += ["", "First interactive launch in a fresh sandbox (one-time kernel bootstrap, not in the "
                  "samples above):", "", "| Product | start-to-ready s | kernel bootstrap done s |", "|---|---|---|"]
        for name in PRODUCTS:
            first = (interactive.get(name) or {}).get("firstRun")
            if first:
                lines.append(f"| {LABELS[name]} | {first['readyS']} | {first['bootstrapS']} |")
        roles = sorted({role for name in PRODUCTS for role in
                        (((interactive.get(name) or {}).get("summary") or {}).get("idleByRole") or {})})
        if roles:
            lines += ["", "Idle RSS by role, MB (median):", "", "| Role | TS | Rust |", "|---|---|---|"]
            for role in roles:
                cells = []
                for name in PRODUCTS:
                    summary = (((interactive.get(name) or {}).get("summary") or {}).get("idleByRole") or {}).get(role)
                    cells.append(f"{summary['median'] / 1024:.0f}" if summary else "-")
                lines.append(f"| {role} | {cells[0]} | {cells[1]} |")
    live = measurements.get("liveSol") or {}
    if live:
        lines += ["", "Live sol probe:", "", "| Product | runs ok | agent_end s | output tokens | responseModel |",
                  "|---|---|---|---|---|"]
        for name in PRODUCTS:
            entry = live.get(name)
            if entry:
                models = sorted({s["responseModel"] or "?" for s in entry["samples"]})
                ok = sum(1 for s in entry["samples"] if s["ok"])
                lines.append(f"| {LABELS[name]} | {ok}/{len(entry['samples'])} | "
                             f"{_cell(entry['summary']['agentEndS'])} | "
                             f"{_cell(entry['summary']['outputTokens'], digits=0)} | {', '.join(models)} |")
    ref = UPSTREAM_REFERENCE
    lines += ["", f"Upstream reference (their sandbox, mock provider): interactive startup "
              f"{ref['interactiveStartupS']['ts']} s TS vs {ref['interactiveStartupS']['rs']} s Rust; idle RSS "
              f"{ref['idleRssMb']['scope']} {ref['idleRssMb']['ts']} MB vs {ref['idleRssMb']['rs']} MB; resume of "
              f"a 1,078-row transcript {ref['resume1078RowsS']['ts']} s vs {ref['resume1078RowsS']['rs']} s."]
    failed = [f"{key}/{name}" for key, block in measurements.items() for name, entry in block.items()
              if not entry.get("ok")]
    if failed:
        lines += ["", f"**Incomplete:** {', '.join(failed)} (see the JSON for errors)."]
    return "\n".join(lines) + "\n"


def _get(entry: dict | None, *path: str) -> dict | None:
    value = entry
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value if isinstance(value, dict) else None


# -- main ------------------------------------------------------------------------------------

def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path("bench-results"),
                        help="directory for bench-<host>-<utc>.json/.md (default ./bench-results)")
    parser.add_argument("--runs", type=int, default=10, help="measured runs per product (oneshot, resume, interactive)")
    parser.add_argument("--version-runs", type=int, default=20)
    parser.add_argument("--version-warmup", type=int, default=2)
    parser.add_argument("--only", default=",".join(MEASUREMENTS),
                        help=f"comma list of measurements (default all: {','.join(MEASUREMENTS)})")
    parser.add_argument("--products", default="ts,rs", help="comma list: ts,rs")
    parser.add_argument("--ts-bin", help="TS cli.js or binary (default: the file behind ~/.local/bin/prime-agent)")
    parser.add_argument("--rs-bin", help="Rust binary (default: prime-agent-oneiron-rs/current/prime-agent)")
    parser.add_argument("--idle-seconds", type=float, default=10.0)
    parser.add_argument("--corpus-rows", type=int, default=1100, help="message rows in the resume transcript")
    parser.add_argument("--ready-timeout", type=float, default=90.0)
    parser.add_argument("--bootstrap-timeout", type=float, default=900.0)
    parser.add_argument("--run-timeout", type=float, default=180.0)
    parser.add_argument("--poll", type=float, default=None, help="RSS poll interval s (default 0.02 Linux, 0.1 macOS)")
    parser.add_argument("--sandbox-base", help="parent dir for sandboxes (default /tmp, or a short $TMPDIR on macOS)")
    parser.add_argument("--live-sol", action="store_true", help="also run the sol-shaped probe on the real provider")
    parser.add_argument("--live-runs", type=int, default=3)
    parser.add_argument("--live-provider", default="cpa-r")
    parser.add_argument("--live-model", default="gpt-6.1-sol")
    parser.add_argument("--live-thinking", default="low")
    parser.add_argument("--live-brief", default="Reply with exactly the word pong and nothing else.")
    args = parser.parse_args(argv)
    args.only = [item.strip() for item in args.only.split(",") if item.strip()]
    args.products = [item.strip() for item in args.products.split(",") if item.strip()]
    unknown = [item for item in args.only if item not in MEASUREMENTS] + \
              [item for item in args.products if item not in PRODUCTS]
    if unknown:
        parser.error(f"unknown measurement/product: {', '.join(unknown)}")
    if args.runs < 1 or args.version_runs < 1:
        parser.error("--runs and --version-runs must be positive")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    for tool in ("tmux",) if "interactive" in args.only else ():
        if not shutil.which(tool):
            raise SystemExit(f"error: {tool} is required for the interactive measurement")

    def interrupted(signum: int, frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    started_at = utc_now()
    stamp = utc_stamp()
    host = machine_facts()
    bench = Bench(args)
    log(f"sandboxes under {bench.base} ({bench.base_reason}); mock provider {bench.mock.base_url}")
    measurements: dict = {}
    try:
        if "version" in args.only:
            measurements["version"] = bench.measure_version()
        if "oneshot" in args.only:
            measurements["oneshot"], measurements["oneshotCold"] = bench.measure_oneshot()
        if "resume" in args.only:
            measurements["resume"] = bench.measure_resume()
        if "interactive" in args.only:
            measurements["interactive"] = bench.measure_interactive()
        if args.live_sol:
            measurements["liveSol"] = bench.measure_live_sol()
        for name in bench.names:
            if not bench.products[name]["version"]:
                sandbox = bench.sandbox(name, "version-probe")
                try:
                    bench.products[name]["version"] = probe_version(bench.products[name], sandbox)
                finally:
                    sandbox.teardown()
    except KeyboardInterrupt:
        log("interrupted: tearing the sandboxes down")
        return 130
    finally:
        teardown_all()
        bench.mock.close()
    host["loadAvgAfter"] = load_avg()
    result = {
        "schema": SCHEMA, "startedAt": started_at, "finishedAt": utc_now(),
        "ok": all(entry.get("ok") for block in measurements.values() for entry in block.values()),
        "host": host,
        "config": {"runs": args.runs, "versionRuns": args.version_runs, "versionWarmup": args.version_warmup,
                   "idleSeconds": args.idle_seconds, "pollSeconds": bench.poll,
                   "bootstrapTimeoutSeconds": args.bootstrap_timeout, "measurements": args.only,
                   "products": bench.names, "sandboxBase": f"{bench.base} ({bench.base_reason})",
                   "uvCacheDir": bench.uv_cache, "mockReply": MOCK_REPLY, "upstreamReference": UPSTREAM_REFERENCE,
                   "liveSol": ({"provider": args.live_provider, "model": args.live_model,
                                "thinking": args.live_thinking, "brief": args.live_brief, "runs": args.live_runs}
                               if args.live_sol else None)},
        "products": {name: bench.products[name] for name in bench.names},
        "corpus": bench.corpus,
        "measurements": measurements,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    host_tag = re.sub(r"[^A-Za-z0-9.-]", "-", host["hostname"].split(".")[0]) or "host"
    json_path = args.out / f"bench-{host_tag}-{stamp}.json"
    md_path = args.out / f"bench-{host_tag}-{stamp}.md"
    json_path.write_text(json.dumps(result, indent=2) + "\n")
    markdown = render_markdown(result)
    md_path.write_text(markdown)
    print(markdown)
    print(f"wrote {json_path}\nwrote {md_path}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
