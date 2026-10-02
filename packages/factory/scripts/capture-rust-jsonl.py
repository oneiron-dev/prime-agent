#!/usr/bin/env python3
"""Capture real Rust `prime-agent` seat streams and session files for the factory parser fixtures.

Every case runs the factory's exact native seat argv (`nativeSeatArgv` in src/agent-command.ts: `-p --mode json
--json-event-profile factory-completed ... --offline ... --no-extensions --no-skills`, the prompt on stdin) twice:
owned custody (the seat process runs the session) and daemon custody (`--daemon-hosted`: a sandbox daemon holds the
session). The scripted faux provider answers (PRIME_AGENT_FAUX_SCRIPT for owned seats, the daemon worker's
PRIME_AGENT_HOSTED_DAEMON_SCRIPT for daemon seats), so no provider is called.

Sandboxed: HOME, TMPDIR, the daemon socket and its worker socket dir live in a fresh directory under --sandbox-root,
the environment is rebuilt from scratch (no PRIME_AGENT_* or PI_* variable leaks in), and the sandbox daemon is shut
down over its own socket (then killed through the identity held since its hello if it outlives the bound) before
the directory is removed. Nothing touches a real agent dir, socket or daemon. The sandbox root never resolves into
the canonical shared temp dir (/tmp; /private/tmp on macOS).

    python3 scripts/capture-rust-jsonl.py <prime-agent binary> test/fixtures/rust-jsonl [--sandbox-root DIR]

The sandbox root defaults to $PA_SANDBOX_ROOT, else ~/.cache/pa-sb (never the shared /tmp).

Writes `<custody>-<case>.stdout.jsonl`, `<custody>-<case>.session.jsonl` and `<custody>-<case>.exit` per case.
"""
import argparse
import json
import os
import pathlib
import shutil
import select
import signal
import socket
import subprocess
import sys
import tempfile
import typing

# One scripted turn per case; the same script drives the owned and the daemon seat.
CASES = {
    # A writer turn that ends with the exact completion line.
    "writer-done": {"responses": ["Implemented the change.\nPR BODY:\nAdded the function.\nDONE capture-one"]},
    # A reviewer that runs a tool (the kernel's ipython, which must succeed), then answers with its verdict; thinking
    # rides the final message.
    "review-tool-then-verdict": {"responses": [
        {"content": [{"type": "thinking", "thinking": "Read the diff first."},
                     {"type": "toolCall", "id": "call-1", "name": "ipython",
                      "arguments": {"code": "print('factory-capture')"}}]},
        {"content": [{"type": "thinking", "thinking": "The diff is fine."},
                     {"type": "text", "text": "Checked every hunk.\nVERDICT: LANDABLE"}]},
    ]},
    # A provider error that persists, after the reply already wrote the completion line: JSON mode still streams
    # agent_end, and no final may be accepted. The error repeats for every call, so a daemon worker's automatic retries
    # meet the same error until they give up.
    "provider-error": {"responses": [{"text": "DONE capture-one", "stopReason": "error",
                                      "errorMessage": "upstream unavailable"}],
                       "repeatLastResponse": True},
    # A reply cut off at the length limit is not a terminal reply either.
    "length-cutoff": {"responses": [{"text": "DONE capture-one", "stopReason": "length"}]},
}
CUSTODIES = ("owned", "daemon")
PROMPT = "Review this diff for ticket capture-one.\n"
# The first tool call provisions the sandbox's kernel environment (uv downloads the runtime's packages once).
SEAT_TIMEOUT_S = 900
TOOL_OUTPUT = "factory-capture\n"
SHUTDOWN_BOUND_S = 60
# Off the shared /tmp: sandboxes and sockets stay under the user's cache.
DEFAULT_SANDBOX_ROOT = pathlib.Path(os.environ.get("PA_SANDBOX_ROOT") or pathlib.Path.home() / ".cache" / "pa-sb")


def seat_argv(binary: str, custody: str, work: pathlib.Path, session_dir: pathlib.Path) -> list[str]:
    """The factory's native seat argv (src/agent-command.ts `nativeSeatArgv`), in its order."""
    hosting = ["--daemon-hosted"] if custody == "daemon" else []
    return [binary, "-p", "--mode", "json", "--json-event-profile", "factory-completed", *hosting, "--offline",
            "--provider", "faux", "--model", "faux-1", "--thinking", "low", "--cwd", str(work), "--no-extensions",
            "--no-skills", "--session-dir", str(session_dir), "--append-system-prompt", "You are the capture seat."]


def tool_results(stdout: str) -> list[tuple[bool, str]]:
    """Each tool_execution_end of a captured stream: (isError, its text)."""
    results = []
    for line in stdout.splitlines():
        event = json.loads(line)
        if event.get("type") == "tool_execution_end":
            text = "".join(block.get("text", "") for block in event["result"]["content"] if block.get("type") == "text")
            results.append((bool(event.get("isError")), text))
    return results


def daemon_request(sock_path: pathlib.Path, command: dict,
                   on_hello: typing.Callable[[dict], None] | None = None) -> tuple[dict, list[dict]]:
    """Send one command envelope; return the hello and every line until the response (or the close). `on_hello`
    sees the hello before the command goes out (the daemon is provably up and answering then)."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(SHUTDOWN_BOUND_S)
        client.connect(str(sock_path))
        reader = client.makefile("r", encoding="utf-8")
        hello = json.loads(reader.readline())
        if on_hello is not None:
            on_hello(hello)
        envelope = {"type": "command", "id": "capture-1", "protocol": {"name": "prime-agent.daemon", "version": 7},
                    "command": command}
        client.sendall((json.dumps(envelope) + "\n").encode())
        lines = []
        for line in reader:
            frame = json.loads(line)
            lines.append(frame)
            if frame.get("type") == "response" and frame.get("id") == "capture-1":
                break
        return hello, lines


# `ps` renders `lstart` in its locale and timezone: pin both so one process always reads the same.
PS_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C", "TZ": "UTC"}


def ps_start_time(pid: int) -> str | None:
    """A process's start time as `ps` reports it (the macOS identity); None when it is gone."""
    listed = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, env=PS_ENV)
    start = " ".join(listed.stdout.split())
    return start if listed.returncode == 0 and start else None


class Supervisor:
    """The sandbox daemon's supervisor, its identity acquired from its hello and kept until it is gone: Linux a
    pidfd opened before /proc confirms the process runs for this sandbox, macOS the start time `ps` reported,
    checked again right before any signal. A recycled pid is never signalled."""

    def __init__(self, pid: int, marker: str):
        self.pid, self.pidfd, self.start = pid, None, None
        if hasattr(os, "pidfd_open"):
            self.pidfd = os.pidfd_open(pid)
            proc = pathlib.Path(f"/proc/{pid}")
            owned = marker.encode() in (proc / "environ").read_bytes() + (proc / "cmdline").read_bytes()
            if not owned or self.exited(0):
                self.close()
                raise ProcessLookupError(f"pid {pid} is not this sandbox's supervisor")
        else:
            listed = subprocess.run(["ps", "-ww", "-E", "-o", "command=", "-p", str(pid)], capture_output=True,
                                    text=True, env=PS_ENV)
            self.start = ps_start_time(pid)
            if marker not in listed.stdout or self.start is None:
                raise ProcessLookupError(f"pid {pid} is not this sandbox's supervisor")

    def exited(self, bound_s: float) -> bool:
        """Whether the supervisor exits within the bound, awaited on the exit itself (the pidfd; a macOS kqueue)."""
        if self.pidfd is not None:
            poller = select.poll()
            poller.register(self.pidfd, select.POLLIN)
            return bool(poller.poll(int(bound_s * 1000)))
        if ps_start_time(self.pid) != self.start:
            return True
        queue = select.kqueue()
        try:
            watch = select.kevent(self.pid, filter=select.KQ_FILTER_PROC,
                                  flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
            return bool(queue.control([watch], 1, bound_s))
        except ProcessLookupError:
            return True
        finally:
            queue.close()

    def kill(self) -> None:
        """SIGKILL, identity-gated (the pidfd; on macOS only while the recorded start time still holds)."""
        try:
            if self.pidfd is not None:
                signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
            elif ps_start_time(self.pid) == self.start:
                os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def close(self) -> None:
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None


def stop_sandbox_daemon(sock_path: pathlib.Path, root: pathlib.Path) -> None:
    """Force-shut the sandbox daemon over its own socket and wait for its supervisor to exit; SIGKILL it (through
    the identity acquired from its hello, before the shutdown went out) if it outlives the bound."""
    if not sock_path.exists():
        return
    held: list[Supervisor] = []

    def hold(hello: dict) -> None:
        pid = hello.get("supervisorPid")
        if isinstance(pid, int):
            try:
                held.append(Supervisor(pid, str(root)))
            except OSError as error:
                print(f"the sandbox daemon's supervisor cannot be held: {error}", file=sys.stderr)

    try:
        daemon_request(sock_path, {"type": "shutdown", "force": True}, on_hello=hold)
    except (OSError, ValueError):
        pass
    for supervisor in held:
        try:
            if not supervisor.exited(SHUTDOWN_BOUND_S):
                supervisor.kill()
                supervisor.exited(SHUTDOWN_BOUND_S)
        finally:
            supervisor.close()


# The canonical shared temp dir (Linux /tmp; macOS /tmp is a link to /private/tmp).
SHARED_TMP = pathlib.Path(os.path.realpath("/tmp"))


def refuse_shared_tmp(root: pathlib.Path) -> None:
    """Sandboxes never go under the shared temp dir (a quota-limited tmpfs other jobs need): the root, every link in
    it resolved, is compared with the canonical shared temp."""
    resolved = pathlib.Path(os.path.realpath(root.expanduser()))
    if resolved == SHARED_TMP or SHARED_TMP in resolved.parents:
        raise SystemExit(f"refusing a sandbox root under the shared temp dir {SHARED_TMP}: {resolved}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("binary")
    parser.add_argument("out")
    parser.add_argument("--sandbox-root", type=pathlib.Path, default=DEFAULT_SANDBOX_ROOT,
                        help=f"parent of the throwaway sandbox (default: {DEFAULT_SANDBOX_ROOT})")
    args = parser.parse_args()
    # The seats run in the sandbox checkout: a relative binary path resolves here, not there.
    binary = os.path.abspath(args.binary) if os.sep in args.binary else args.binary
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    refuse_shared_tmp(args.sandbox_root)
    args.sandbox_root.mkdir(parents=True, exist_ok=True)
    root = pathlib.Path(tempfile.mkdtemp(prefix="fcap-", dir=args.sandbox_root))
    home, tmp, work, scripts = root / "h", root / "t", root / "w", root / "scripts"
    for path in (home, tmp, work, scripts):
        path.mkdir(parents=True)
    sock_path = root / "d.sock"
    git_env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "GIT_AUTHOR_NAME": "Test",
               "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "Test",
               "GIT_COMMITTER_EMAIL": "test@example.invalid", "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True, env=git_env)
    (work / "README.md").write_text("capture\n")
    subprocess.run(["git", "-C", str(work), "add", "README.md"], check=True, env=git_env)
    subprocess.run(["git", "-C", str(work), "commit", "-qm", "initial"], check=True, env=git_env)
    # The kernel provisions its environment with uv; nothing else from this host's PATH reaches a seat.
    uv = shutil.which("uv")
    tool_path = os.pathsep.join([*([os.path.dirname(uv)] if uv else []), "/usr/bin", "/bin"])
    try:
        for custody in CUSTODIES:
            for name, script in CASES.items():
                session_dir = root / "sessions" / custody / name
                env = {"PATH": tool_path, "HOME": str(home), "TMPDIR": str(tmp), "TZ": "UTC",
                       "LANG": "C.UTF-8", "PRIME_AGENT_DAEMON_SOCKET": str(sock_path),
                       "PRIME_AGENT_SOCKET_DIR": str(root / "s")}
                if custody == "owned":
                    env["PRIME_AGENT_FAUX_SCRIPT"] = json.dumps(script)
                else:
                    script_path = scripts / f"{name}.json"
                    script_path.write_text(json.dumps({"engine": "faux", **script}))
                    env["PRIME_AGENT_HOSTED_DAEMON_SCRIPT"] = str(script_path)
                result = subprocess.run(seat_argv(binary, custody, work, session_dir), input=PROMPT, env=env,
                                        cwd=str(work), capture_output=True, text=True, timeout=SEAT_TIMEOUT_S)
                print(f"{custody}-{name}: rc={result.returncode} stdout={len(result.stdout)}B "
                      f"stderr={result.stderr.strip()[:300]!r}")
                stem = f"{custody}-{name}"
                (out / f"{stem}.stdout.jsonl").write_text(result.stdout)
                sessions = sorted(session_dir.glob("*.jsonl")) if session_dir.exists() else []
                if len(sessions) != 1:
                    raise SystemExit(f"{stem}: expected one session file, found {len(sessions)}")
                (out / f"{stem}.session.jsonl").write_text(sessions[0].read_text())
                (out / f"{stem}.exit").write_text(f"{result.returncode}\n")
                if name == "review-tool-then-verdict" and tool_results(result.stdout) != [(False, TOOL_OUTPUT)]:
                    raise SystemExit(f"{stem}: the tool call did not succeed: {tool_results(result.stdout)}")
    finally:
        stop_sandbox_daemon(sock_path, root)
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
