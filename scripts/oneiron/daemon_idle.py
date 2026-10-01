"""Is the side-by-side Rust daemon idle? One targeted wire request, never discovery.

rollout and rollback swap <prefix>/current under whatever Rust supervisor is
running. A supervisor with live sessions keeps serving them from the old
binary while every new prime-agent-rs run starts the new one, and a newer
client may restart the stale supervisor under them. So both steps refuse
unless the Rust supervisor is idle, and idle is proven, never assumed:

  absent         no socket file at the Rust socket path
  not-listening  a socket file nobody accepts on (a supervisor that died)
  idle           a supervisor of THIS install answered `list` with no sessions
  busy           it answered with live sessions
  foreign        something else answered (wrong protocol, a different socket
                 path in its hello, or an executable outside the prefix); it is
                 never sent a command
  unknown        no hello, a failed or timed-out `list`, or not a socket
  refused        the path overlaps TS state; it is never connected to

Only absent, not-listening and idle permit the swap. The check speaks the
daemon wire (newline-delimited JSON: the supervisor's `daemon_hello`, then a
`command` envelope carrying `{"type": "list"}`, answered by a `response` with
`data.sessions`, the live residents) to the one Rust socket path, the way
pa-cli's `probe_daemon` does. It never scans for daemons and never touches
the TS socket dir.

It stops nothing unless asked (`inspect(..., retire=True)`, behind
--retire-idle-daemon): a supervisor of another version with the same
protocol and schema stays `current` to new clients and spawns every worker
from its own binary, so after a swap it keeps new sessions on the old
version until it exits. Retiring sends `shutdown` (never forced) on the
same connection that just found it idle and ours.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import time
import uuid
from pathlib import Path

import side_by_side as sbs

DAEMON_PROTOCOL_NAME = "prime-agent.daemon"
IDLE_STATES = frozenset({"absent", "not-listening", "idle"})
CONNECT_TIMEOUT_SECONDS = 2.0
# pa-cli's probe_daemon waits 1.5s for the hello and 30s for `list` (a busy
# supervisor answers list from every worker's state).
HELLO_TIMEOUT_SECONDS = 5.0
LIST_TIMEOUT_SECONDS = 30.0


def default_socket_path() -> Path:
    """The supervisor socket prime-agent-rs exports (its launcher logic:
    PRIME_AGENT_RS_SOCKET_DIR, else ${TMPDIR:-/tmp}/pa-rs-<uid>)."""
    tmp = (os.environ.get("TMPDIR") or "/tmp").rstrip("/") or "/"
    sock_dir = os.environ.get("PRIME_AGENT_RS_SOCKET_DIR") or f"{tmp}/pa-rs-{os.getuid()}"
    if not os.path.isabs(sock_dir):
        raise SystemExit(f"error: PRIME_AGENT_RS_SOCKET_DIR must be an absolute path: {sock_dir}")
    return Path(sock_dir).resolve() / "daemon.sock"


class LineReader:
    """Newline-delimited JSON objects off one connection, each read bounded
    by a deadline; lines that are not JSON objects are skipped."""

    def __init__(self, conn: socket.socket) -> None:
        self.conn = conn
        self.buffer = b""

    def next_matching(self, wanted: dict, deadline: float) -> dict | None:
        while True:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict) and all(message.get(key) == value for key, value in wanted.items()):
                    return message
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.conn.settimeout(remaining)
            try:
                chunk = self.conn.recv(65536)
            except (socket.timeout, OSError):
                return None
            if not chunk:
                return None
            self.buffer += chunk


def hello_identity(hello: dict) -> dict:
    runtime = hello.get("runtime") if isinstance(hello.get("runtime"), dict) else {}
    return {
        "protocol": hello.get("protocol"),
        "schemaId": hello.get("schemaId"),
        "appVersion": hello.get("appVersion"),
        "supervisorPid": hello.get("supervisorPid"),
        "supervisorProcessStartId": hello.get("supervisorProcessStartId"),
        "helloSocketPath": hello.get("socketPath"),
        "buildId": runtime.get("buildId"),
        "executablePath": runtime.get("executablePath"),
    }


def foreign_reason(identity: dict, socket_path: Path, prefix: Path) -> str | None:
    """Why this hello is not the Rust supervisor of this install, or None."""
    protocol = identity["protocol"]
    if not isinstance(protocol, dict) or protocol.get("name") != DAEMON_PROTOCOL_NAME:
        return f"protocol {protocol!r} is not {DAEMON_PROTOCOL_NAME}"
    hello_socket = identity["helloSocketPath"]
    if not isinstance(hello_socket, str) or Path(hello_socket).resolve() != socket_path.resolve():
        return f"its hello names socket {hello_socket!r}, not {socket_path}"
    executable = identity["executablePath"]
    if not isinstance(executable, str):
        return "its hello carries no runtime executable path"
    # Linux reports a replaced binary as "<path> (deleted)".
    executable_path = Path(executable.removesuffix(" (deleted)")).resolve()
    if not sbs.is_within(executable_path, prefix.resolve()):
        return f"its executable {executable} is not under {prefix}"
    return None


def command_envelope(hello: dict, command: str) -> tuple[str, bytes]:
    request_id = f"oneiron-{command}-{uuid.uuid4().hex[:12]}"
    envelope = {"type": "command", "id": request_id, "protocol": hello["protocol"],
                "clientId": f"oneiron-rollout:{uuid.uuid4()}", "command": {"type": command, "id": request_id}}
    return request_id, (json.dumps(envelope) + "\n").encode()


def wait_until_gone(socket_path: Path, deadline: float) -> bool:
    """True once nothing accepts on socket_path (the supervisor removes its
    socket on exit); False if something still does at the deadline."""
    while True:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        with probe:
            probe.settimeout(CONNECT_TIMEOUT_SECONDS)
            try:
                probe.connect(str(socket_path))
            except OSError:
                return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def inspect(socket_path: Path, prefix: Path, *, retire: bool = False) -> dict:
    """The Rust supervisor at socket_path, classified (see the module doc).

    retire=True also stops it, but only when this same connection found it
    idle and ours: `shutdown` (never forced), then a bounded wait until the
    socket stops accepting. Recorded under "retire"."""
    socket_path = Path(os.path.abspath(socket_path))
    report: dict = {"socket": str(socket_path)}
    for root in sbs.protected_roots():
        if sbs.overlaps(socket_path, root):
            return {**report, "state": "refused", "detail": f"the socket path overlaps TS state at {root}"}
    try:
        mode = socket_path.lstat().st_mode
    except FileNotFoundError:
        return {**report, "state": "absent"}
    if not stat.S_ISSOCK(mode):
        return {**report, "state": "unknown", "detail": "the path exists but is not a socket"}
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    with conn:
        conn.settimeout(CONNECT_TIMEOUT_SECONDS)
        try:
            conn.connect(str(socket_path))
        except (ConnectionRefusedError, FileNotFoundError):
            return {**report, "state": "not-listening"}
        except OSError as error:
            return {**report, "state": "unknown", "detail": f"connect: {error}"}
        reader = LineReader(conn)
        hello = reader.next_matching({"type": "daemon_hello"}, time.monotonic() + HELLO_TIMEOUT_SECONDS)
        if hello is None:
            return {**report, "state": "unknown", "detail": "no daemon_hello"}
        report.update(hello_identity(hello))
        problem = foreign_reason(report, socket_path, prefix)
        if problem:
            return {**report, "state": "foreign", "detail": problem}
        request_id, request = command_envelope(hello, "list")
        try:
            conn.sendall(request)
        except OSError as error:
            return {**report, "state": "unknown", "detail": f"send list: {error}"}
        response = reader.next_matching({"type": "response", "id": request_id},
                                        time.monotonic() + LIST_TIMEOUT_SECONDS)
        if response is None:
            return {**report, "state": "unknown", "detail": "no response to list"}
        data = response.get("data")
        sessions = data.get("sessions") if isinstance(data, dict) else None
        if response.get("success") is not True or not isinstance(sessions, list):
            return {**report, "state": "unknown", "detail": f"list failed: {response.get('error')!r}"}
        report.update(state="busy" if sessions else "idle", sessionCount=len(sessions))
        if not retire or sessions:
            return report
        request_id, request = command_envelope(hello, "shutdown")
        try:
            conn.sendall(request)
        except OSError as error:
            return {**report, "retire": {"acknowledged": False, "stopped": False, "detail": f"send: {error}"}}
        response = reader.next_matching({"type": "response", "id": request_id},
                                        time.monotonic() + HELLO_TIMEOUT_SECONDS)
    acknowledged = response is not None and response.get("success") is True
    stopped = acknowledged and wait_until_gone(socket_path, time.monotonic() + LIST_TIMEOUT_SECONDS)
    return {**report, "retire": {"acknowledged": acknowledged, "stopped": stopped}}
