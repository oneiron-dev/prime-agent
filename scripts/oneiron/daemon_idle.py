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
                 path in its hello, or an executable that is not an install's
                 prime-agent under the prefix); it is never sent a command
  unknown        no hello, a failed or timed-out `list`, or not a socket
  refused        the path overlaps TS state (under $TMPDIR or /tmp); it is
                 never connected to

Only absent, not-listening and idle permit the swap. The check speaks the
daemon wire (newline-delimited JSON: the supervisor's `daemon_hello`, then a
`command` envelope carrying `{"type": "list"}`, answered by a `response` with
`data.sessions`, the live residents) to the one Rust socket path, the way
pa-cli's `probe_daemon` does. It never scans for daemons and never touches
the TS socket dir.

It sends nothing but `list`, and so it stops nothing. A supervisor of
another release with the same protocol and schema stays `current` to new
clients and spawns every worker from its own binary, so after a swap it
keeps new sessions on the old release until it exits; rollout records that
in its receipt. Stopping it safely needs a shutdown the supervisor refuses
while it hosts sessions, decided atomically with session admission. The
daemon wire has no such command (`shutdown` is unconditional), so these
scripts leave the supervisor alone.
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
    """The supervisor socket prime-agent-rs exports: the launcher's socket
    dir (PRIME_AGENT_RS_SOCKET_DIR, else /tmp/pa-rs-<uid> on macOS and
    ${TMPDIR:-/tmp}/pa-rs-<uid> elsewhere), with the launcher's checks
    (side_by_side.runtime_dirs)."""
    return sbs.runtime_dirs()["socket dir"] / "daemon.sock"


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


def install_of(identity: dict, prefix: Path) -> str | None:
    """The install (<prefix>/<version>/) whose executable the supervisor
    runs, or None when its executable is not in one. This, not the hello's
    appVersion (the compiled Cargo version, the same for every Oneiron build
    of one base), names the release. Linux reports a replaced binary as
    "<path> (deleted)"."""
    executable = identity.get("executablePath")
    if not isinstance(executable, str):
        return None
    try:
        relative = Path(executable.removesuffix(" (deleted)")).resolve().relative_to(prefix.resolve())
    except ValueError:
        return None
    return relative.parts[0] if len(relative.parts) == 2 and relative.parts[1] == "prime-agent" else None


def foreign_reason(identity: dict, socket_path: Path, prefix: Path) -> str | None:
    """Why this hello is not the Rust supervisor of this install, or None."""
    protocol = identity["protocol"]
    if not isinstance(protocol, dict) or protocol.get("name") != DAEMON_PROTOCOL_NAME:
        return f"protocol {protocol!r} is not {DAEMON_PROTOCOL_NAME}"
    hello_socket = identity["helloSocketPath"]
    if not isinstance(hello_socket, str) or Path(hello_socket).resolve() != socket_path.resolve():
        return f"its hello names socket {hello_socket!r}, not {socket_path}"
    if install_of(identity, prefix) is None:
        return f"its executable {identity['executablePath']!r} is not an install's prime-agent under {prefix}"
    return None


def inspect(socket_path: Path, prefix: Path) -> dict:
    """The Rust supervisor at socket_path, classified (see the module doc)."""
    socket_path = Path(os.path.abspath(socket_path))
    report: dict = {"socket": str(socket_path)}
    # Judged by its canonical spelling against the one protected set, the
    # TS socket dirs under $TMPDIR and /tmp included (side_by_side).
    root = sbs.ts_state_overlap(sbs.canonical("Rust socket", socket_path))
    if root is not None:
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
        request_id = f"oneiron-list-{uuid.uuid4().hex[:12]}"
        envelope = {"type": "command", "id": request_id, "protocol": hello["protocol"],
                    "clientId": f"oneiron-rollout:{uuid.uuid4()}", "command": {"type": "list", "id": request_id}}
        try:
            conn.sendall((json.dumps(envelope) + "\n").encode())
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
    return {**report, "state": "busy" if sessions else "idle", "sessionCount": len(sessions)}
