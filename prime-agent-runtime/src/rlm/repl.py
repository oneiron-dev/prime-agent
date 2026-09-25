"""Minimal CPython REPL runtime speaking newline-delimited JSON over stdio.

Entry point: ``python -m rlm.repl``. The protocol is documented in repl.md
next to this file. Cells execute with top-level await in one persistent
``__main__`` namespace on a single asyncio event loop.
"""

from __future__ import annotations

import ast
import codecs
import contextvars
import ctypes
import inspect
import io
import json
import linecache
import os
import platform
import signal
import sys
import threading
import time
import traceback
import types
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from .bash import _kill_live_handles, record_memory_notice

PROTOCOL_VERSION = 3
# Request types beyond the version-3 base; the ready event lists them so a host can gate on them.
FEATURES = ("trim_memory", "memory_notice", "memory_report")

DEFAULT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 8 * 1024 * 1024

# Plain ASCII, never a pickle start: _restore_state sniffs it to tell v2 framed
# payloads from legacy (single dill-pickled dict) ones.
_SNAPSHOT_MAGIC = b"PRIME-AGENT-KERNEL-SNAPSHOT-V2\n"

# Stream writes must fit one protocol frame: the host buffers whole lines
# before its per-execution truncation, and raw fd writes already arrive as
# 64 KiB pump chunks.
_STREAM_FRAME_TEXT_CAP = 64 * 1024
# The host truncates results at a smaller per-execution maxChars, so this only
# bounds a pathological repr or exception text in transit.
_RESULT_TEXT_CAP = 1_048_576
_RESULT_TRUNCATION_MARKER = f"\n[... result truncated at {_RESULT_TEXT_CAP} characters ...]"
# Oversized display and host_request payloads fail the cell instead of wedging host memory.
_PAYLOAD_CAP = 16 * 1024 * 1024

# Names the session bootstrap re-creates on every start; never snapshotted.
_ALWAYS_SKIP = {"rlm", "mcp", "bash", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
# IPython-injected names that may appear in a snapshot payload; never restored.
_RESTORE_SKIP = {"In", "Out", "get_ipython"}

_protocol_fd: int = -1
_write_lock = threading.Lock()
_loop: asyncio.AbstractEventLoop | None = None
_serve_task: asyncio.Task[Any] | None = None


class _CellExecution:
    def __init__(self) -> None:
        import asyncio

        self.finished = asyncio.Event()
        self.owner: asyncio.Task[Any] | None = None


# Asyncio tasks copy cell context at creation, so detached tasks retain their
# output attribution and completion barrier. Threads start with a fresh context.
_current_cell: contextvars.ContextVar[str | None] = contextvars.ContextVar("_current_cell", default=None)
_current_cell_execution: contextvars.ContextVar[_CellExecution | None] = contextvars.ContextVar(
    "_current_cell_execution", default=None
)
_active: dict[str, Any] = {"task": None, "rid": None, "interrupted": False}
_cell_counter = 0
# Code filename of the cell being executed, so its line can be named in errors and memory reports.
_cell_file: str | None = None
# The user namespace, for the memory report the reader thread answers.
_user_ns: dict[str, Any] | None = None
_pending_host: dict[str, "asyncio.Future[dict[str, Any]]"] = {}
# Set on the loop thread once stdin hits EOF or a shutdown request arrives; no
# host reply can arrive after that, so waiting (and future) host_request calls fail.
_host_closed = False

# Interrupt bookkeeping shared between the reader thread and the loop thread.
_interrupt_lock = threading.Lock()
_inflight: set[str] = set()
_pending_interrupts: dict[str, Any] = {"ids": set(), "any": False}
_sigint_target: str | None = None
_finishing_rid: str | None = None
_handoff_interrupted = False


def _send(event: dict[str, Any]) -> None:
    """Write one protocol frame; the locked single write keeps frames atomic."""
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    with _write_lock:
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(_protocol_fd, view) :]
        except OSError:
            pass


def _check_payload(event: str, data: dict[str, Any]) -> None:
    """Fail the calling cell when a `data` payload would not fit one protocol frame.

    Strict-dumps validation: default allow_nan=True would let NaN/Infinity
    serialize as non-JSON text and tear the host's protocol framing (a
    non-serializable value raises TypeError here before any bytes are
    written, so NaN is the only corruption vector). The encoded length
    enforces the frame cap; _send re-serializes.
    """
    if len(json.dumps(data, allow_nan=False)) > _PAYLOAD_CAP:
        raise ValueError(f"{event} payload exceeds the {_PAYLOAD_CAP}-character frame cap")


def emit(data: dict[str, Any]) -> None:
    """Ship one display event carrying a dict of MIME type -> JSON payload.

    Thread-safe; the event is tagged with the cell running at call time.
    """
    if not isinstance(data, dict) or not data or not all(isinstance(k, str) for k in data):
        raise TypeError("emit() requires a non-empty dict keyed by MIME type strings")
    _check_payload("display", data)
    _send({"event": "display", "id": _current_cell.get(), "data": data})


def is_active() -> bool:
    """True when this process serves the repl protocol (not merely imported)."""
    return _protocol_fd >= 0


def current_cell_completion_context() -> tuple[asyncio.Event, asyncio.Task[Any] | None] | None:
    """Return the calling cell's completion barrier and owning execution task."""
    execution = _current_cell_execution.get()
    if execution is None:
        return None
    return execution.finished, execution.owner


def active_cell_task() -> asyncio.Task[Any] | None:
    """The cell body task executing right now, or None between cells (global
    state, not the cell contextvar — detached tasks keep stale context copies)."""
    import asyncio

    with _interrupt_lock:
        task = _active["task"]
    return task if isinstance(task, asyncio.Task) and not task.done() else None


async def host_request(data: dict[str, Any]) -> dict[str, Any]:
    """Send one typed request to the host and await its raw reply dict."""
    if _loop is None:
        raise RuntimeError("repl runtime is not serving")
    if _host_closed:
        raise RuntimeError("host connection closed; host_request cannot be answered")
    _check_payload("host_request", data)
    rid = uuid.uuid4().hex
    future: asyncio.Future[dict[str, Any]] = _loop.create_future()
    _pending_host[rid] = future
    try:
        _send({"event": "host_request", "id": rid, "data": data})
        return await future
    finally:
        _pending_host.pop(rid, None)


def _fail_pending_host_requests() -> None:
    """Loop-thread half of teardown: no host reply can arrive anymore, so every
    awaiting cell must unblock or the queued shutdown would never be served."""
    global _host_closed
    _host_closed = True
    for future in _pending_host.values():
        if not future.done():
            future.set_exception(RuntimeError("host connection closed; host_request cannot be answered"))


def _resolve_host_reply(rid: str, data: dict[str, Any]) -> None:
    """Reader-thread half of the host bridge; late/unknown replies are dropped."""
    assert _loop is not None

    def deliver() -> None:
        future = _pending_host.get(rid)
        if future is not None and not future.done():
            future.set_result(data)

    _loop.call_soon_threadsafe(deliver)


class _Pump:
    """Reads one captured-output pipe and ships its bytes as stream events."""

    def __init__(self, read_fd: int, write_fd: int, stream: str) -> None:
        self._read_fd = read_fd
        # Private write end: a cell closing/reclaiming fd 1/2 cannot hijack drain tokens.
        self._token_fd = os.dup(write_fd)
        self._stream = stream
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()
        self._watch: tuple[bytes, threading.Event] | None = None
        self._buf = b""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def drain(self) -> None:
        """Block until every byte written to the fd so far has been shipped."""
        token = b"\xff<drain:" + uuid.uuid4().hex.encode() + b">\xff"
        seen = threading.Event()
        with self._lock:
            self._watch = (token, seen)
        try:
            os.write(self._token_fd, token)
            # Backstop only: a dead pump (read end closed under it) can never set seen.
            while not seen.wait(0.1):
                if not self._thread.is_alive():
                    return
        except OSError:
            return
        finally:
            with self._lock:
                self._watch = None

    def _run(self) -> None:
        while True:
            try:
                chunk = os.read(self._read_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self._feed(chunk)

    def _feed(self, chunk: bytes) -> None:
        data = self._buf + chunk
        self._buf = b""
        with self._lock:
            watch = self._watch
        if watch is None:
            self._emit(data)
            return
        token, seen = watch
        while True:
            i = data.find(token)
            if i == -1:
                break
            self._emit(data[:i])
            self._finish_decode()
            seen.set()
            data = data[i + len(token) :]
        # Hold back a tail that could be the start of a token split across reads.
        hold = 0
        for k in range(min(len(data), len(token) - 1), 0, -1):
            if data.endswith(token[:k]):
                hold = k
                break
        if hold:
            self._buf = data[len(data) - hold :]
            data = data[: len(data) - hold]
        self._emit(data)

    def _emit(self, data: bytes) -> None:
        if not data:
            return
        text = self._decoder.decode(data)
        if text:
            # Raw fd bytes have no provable owner (os.write, C extensions,
            # subprocesses, threads from earlier cells): never credit a cell.
            _send({"event": self._stream, "id": None, "text": text})

    def _finish_decode(self) -> None:
        text = self._decoder.decode(b"", final=True)
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        if text:
            _send({"event": self._stream, "id": None, "text": text})


class _TaggedBuffer(io.RawIOBase):
    """Binary proxy for _TaggedWriter.buffer: bytes go to the raw fd channel.

    Byte ownership cannot be proven at this layer, so buffer writes ride the
    captured pipe and surface as id:null stream events (drained before done
    like any other raw fd write).
    """

    def __init__(self, fallback_fd: int) -> None:
        self._fallback_fd = fallback_fd

    def write(self, data: Any) -> int:
        # memoryview (unlike bytes()) rejects int, matching a real buffer's TypeError.
        view = memoryview(data).cast("B")
        total = len(view)
        # Pipe writes can be short for payloads above the pipe capacity.
        while view:
            view = view[os.write(self._fallback_fd, view) :]
        return total

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True


class _TaggedWriter(io.TextIOBase):
    """sys.stdout/sys.stderr replacement tagging writes with the writer's cell id.

    Python-level writes carry write-time provenance from the _current_cell
    contextvar (asyncio tasks inherit the spawning cell's id; user threads see
    None) and ship straight to the protocol, bypassing the fd pipe. fileno()
    and .buffer expose the captured pipe so subprocesses, C-level writers, and
    sys.stdout.buffer.write() keep working through the raw channel
    (null-attributed).
    """

    def __init__(self, stream: str, fallback_fd: int) -> None:
        self._stream = stream
        self._fallback_fd = fallback_fd
        # Keeps one write()'s frames contiguous under concurrent writers.
        self._frame_lock = threading.Lock()
        self._buffer = _TaggedBuffer(fallback_fd)

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            cell_id = _current_cell.get()
            with self._frame_lock:
                for start in range(0, len(text), _STREAM_FRAME_TEXT_CAP):
                    _send(
                        {
                            "event": self._stream,
                            "id": cell_id,
                            "text": text[start : start + _STREAM_FRAME_TEXT_CAP],
                        }
                    )
        return len(text)

    def flush(self) -> None:
        pass

    def fileno(self) -> int:
        return self._fallback_fd

    def writable(self) -> bool:
        return True

    @property
    def buffer(self) -> _TaggedBuffer:
        return self._buffer

    @property
    def encoding(self) -> str:
        return "utf-8"

    @property
    def errors(self) -> str:
        return "replace"


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    """Retrieve a killed task's exception so no never-retrieved noise is logged."""
    if not task.cancelled():
        task.exception()


def _sigint_handler(signum: int, frame: types.FrameType | None) -> None:
    # asyncio loads by the time any task can be active (main() imports it), so
    # this is a cached sys.modules hit even inside the signal handler.
    import asyncio

    global _handoff_interrupted
    task = _active["task"]
    # No lock (the main thread may hold it): the rid equality revalidates the
    # target so a SIGINT delayed past its request's finish cannot hit a later cell.
    if task is None or task.done() or _active["rid"] != _sigint_target:
        if _sigint_target is not None and _sigint_target == _active["rid"]:
            # Handoff: the task is done but _run_guarded's finally has not run
            # yet, so the main thread may be inside loop internals where raising
            # would kill the serve loop. Record it; the finishing phase consumes it.
            _handoff_interrupted = True
            return
        # Post-run repr/drain is synchronous main-thread work: raise into it.
        # The equality revalidation drops a SIGINT delayed past the done send.
        if _sigint_target is not None and _sigint_target == _finishing_rid:
            raise KeyboardInterrupt
        return
    _active["interrupted"] = True
    # Handler runs in the main (loop) thread: current_task is whose step the signal interrupted.
    running = asyncio.current_task(_loop) if _loop is not None else None
    if running is task:
        # The active request's own step (sync bytecode or an EINTR-woken syscall): raise into it.
        raise KeyboardInterrupt
    # Loop idle in select() or another task mid-step: cancel the active task (same thread, safe).
    task.cancel()
    if running is not None and running is not _serve_task:
        # A background task blocked in sync code occupies the only thread and would keep the
        # cancel from ever running: raise into it to unwind its step; it dies with the KI.
        running.add_done_callback(_consume_task_exception)
        raise KeyboardInterrupt


def _request_interrupt(target: str | None) -> None:
    """Deliver an interrupt now, or park it for the request it targets.

    Runs on the reader thread. Without a target id the interrupt applies to
    the running request, else to the next queued one; with a target id it
    applies to that request only. A request finishing its post-run repr/drain
    is still interrupted (never parked: parking would hit the NEXT request).
    Interrupts for finished or unknown requests are dropped.
    """
    global _sigint_target
    with _interrupt_lock:
        task = _active["task"]
        rid = _active["rid"]
        if rid is not None and (target is None or target == rid):
            # Active, or in the done-task handoff before _run_guarded's finally:
            # either way the rid still owns the interrupt (parking here would
            # leak it onto the next request); the handler decides delivery.
            _sigint_target = rid
        elif _finishing_rid is not None and (target is None or target == _finishing_rid):
            _sigint_target = _finishing_rid
        elif target is not None:
            if target in _inflight:
                _pending_interrupts["ids"].add(target)
            return
        elif _inflight:
            _pending_interrupts["any"] = True
            return
        else:
            return
    # SIGINT must land on the main thread, where cells execute. Windows has no
    # signal.pthread_kill: fall back to cancelling the active task on the loop
    # (sync-blocked cells and the finishing repr/drain cannot be broken there;
    # best-effort parity).
    if hasattr(signal, "pthread_kill"):
        signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
        if _loop is not None:
            # Wake the selector so a cancel scheduled by the handler runs promptly.
            _loop.call_soon_threadsafe(lambda: None)
        return
    if _loop is not None:

        def cancel_active() -> None:
            current = _active["task"]
            if current is task and current is not None and not current.done():
                _active["interrupted"] = True
                current.cancel()

        _loop.call_soon_threadsafe(cancel_active)


def _consume_pending_interrupt(rid: str) -> bool:
    """Check-and-clear any interrupt parked for this request."""
    pending = _pending_interrupts["any"] or rid in _pending_interrupts["ids"]
    _pending_interrupts["any"] = False
    _pending_interrupts["ids"].discard(rid)
    return pending


def _consume_handoff_interrupt() -> bool:
    """Check-and-clear an interrupt that landed in the done-task handoff."""
    global _handoff_interrupted
    with _interrupt_lock:
        pending = _handoff_interrupted
        _handoff_interrupted = False
        return pending


def _finish_locked(rid: str) -> None:
    """Drop a finished request; a parked untargeted interrupt survives while others are inflight."""
    global _finishing_rid, _handoff_interrupted, _sigint_target
    if _finishing_rid == rid:
        # An unconsumed handoff interrupt dies with its request (state requests
        # have no cancellable post-run work); it must never hit the next request.
        _finishing_rid = None
        _handoff_interrupted = False
    if _sigint_target == rid:
        # The target dies with its request: a later request reusing this id must
        # not match a stale target when a delayed/external SIGINT arrives.
        _sigint_target = None
    _inflight.discard(rid)
    _pending_interrupts["ids"].discard(rid)
    if not _inflight:
        _pending_interrupts["any"] = False


def _finish_request(rid: str) -> None:
    with _interrupt_lock:
        _finish_locked(rid)


_RUNTIME_FILE = __file__


def _cell_stack(stack: traceback.StackSummary) -> traceback.StackSummary | None:
    """Frames from the first cell frame on, minus runtime-internal frames.

    Returns None when no cell frame exists (e.g. a compile-time SyntaxError).
    """
    start = next((i for i, f in enumerate(stack) if f.filename.startswith("<cell-")), None)
    if start is None:
        return None
    return traceback.StackSummary.from_list([f for f in stack[start:] if f.filename != _RUNTIME_FILE])


def _safe_str(exc: BaseException) -> str:
    try:
        return str(exc)
    except BaseException:  # noqa: BLE001 - a broken __str__ must not kill the runtime
        return "<exception str() failed>"


def _cap_text(text: str) -> str:
    if len(text) > _RESULT_TEXT_CAP:
        return text[:_RESULT_TEXT_CAP] + _RESULT_TRUNCATION_MARKER
    return text


_LINE_SOURCE_CAP = 200


def _line_of(filename: str, lineno: int | None) -> dict[str, Any] | None:
    if not lineno:
        return None
    source = linecache.getline(filename, lineno).strip()
    if len(source) > _LINE_SOURCE_CAP:
        source = source[:_LINE_SOURCE_CAP] + "..."
    return {"lineno": lineno, "source": source}


def _with_cell_line(event: dict[str, Any], stack: traceback.StackSummary | None) -> dict[str, Any]:
    """Add the running cell's innermost traceback line (a call into an earlier cell names this cell's call)."""
    filename = _cell_file
    for frame in reversed(stack or []):
        if filename is not None and frame.filename == filename:
            line = _line_of(filename, frame.lineno)
            if line:
                event["line"] = line
            break
    return event


def _error_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    # No cell frame (e.g. SyntaxError): exception-only keeps filename, source, and caret.
    te = traceback.TracebackException.from_exception(exc)
    stack = _cell_stack(te.stack)
    if stack is None:
        lines = traceback.format_exception_only(type(exc), exc)
    else:
        te.stack = stack
        lines = list(te.format())
    event = {
        "event": "error",
        "id": cell_id,
        "ename": type(exc).__name__,
        "evalue": _cap_text(_safe_str(exc)),
        "traceback": [_cap_text(line) for line in lines],
    }
    return _with_cell_line(event, stack)


def _clear_frames(exc: BaseException | None) -> None:
    """Release the locals an interrupted cell's frames still hold (its data would outlive it)."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        traceback.clear_frames(exc.__traceback__)
        exc = exc.__cause__ or exc.__context__


def _interrupt_event(cell_id: str, exc: BaseException) -> dict[str, Any]:
    """Report a cancelled await-suspended cell as a KeyboardInterrupt."""
    stack = _cell_stack(traceback.extract_tb(exc.__traceback__))
    lines = []
    if stack:
        lines = ["Traceback (most recent call last):\n"]
        lines.extend(stack.format())
    lines.append("KeyboardInterrupt\n")
    event = {"event": "error", "id": cell_id, "ename": "KeyboardInterrupt", "evalue": "", "traceback": lines}
    return _with_cell_line(event, stack)


def _compile_cell(code: str, filename: str) -> tuple[list[types.CodeType], bool]:
    """Compile a cell; a trailing expression compiles separately in eval mode."""
    linecache.cache[filename] = (len(code), None, code.splitlines(keepends=True), filename)
    tree = ast.parse(code, filename)
    trailing: ast.Expression | None = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        trailing = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    codes: list[types.CodeType] = []
    if tree.body:
        codes.append(compile(tree, filename, "exec", flags=flags, dont_inherit=True))
    if trailing is not None:
        codes.append(compile(trailing, filename, "eval", flags=flags, dont_inherit=True))
    return codes, trailing is not None


async def _run_codes(codes: list[types.CodeType], ns: dict[str, Any]) -> Any:
    value: Any = None
    for code_obj in codes:
        value = eval(code_obj, ns)  # noqa: S307 - executing the model's cell is the runtime's job
        if code_obj.co_flags & inspect.CO_COROUTINE:
            value = await value
    return value


async def _run_guarded(task: asyncio.Task[Any], rid: str) -> tuple[str, Any, dict[str, Any] | None]:
    """Await a request task; returns (status, value, error event or None)."""
    import asyncio

    with _interrupt_lock:
        _active["interrupted"] = False
        _active["rid"] = rid
        _active["task"] = task
        if _consume_pending_interrupt(rid):
            # Interrupt parked before activation: cancel before the first step.
            _active["interrupted"] = True
            task.cancel()
    try:
        value = await task
        return "ok", value, None
    except asyncio.CancelledError as exc:
        if _active["interrupted"]:
            event = _interrupt_event(rid, exc)
            _clear_frames(exc)
            return "error", None, event
        return "error", None, _error_event(rid, exc)
    except BaseException as exc:  # noqa: BLE001 - every cell failure becomes an error event
        event = _error_event(rid, exc)
        if _active["interrupted"] and isinstance(exc, KeyboardInterrupt):
            _clear_frames(exc)
        return "error", None, event
    finally:
        with _interrupt_lock:
            global _finishing_rid
            # The rid stays inflight and interrupt-targetable through the
            # post-run repr/drain; the handler closes the window via _finish_request.
            # Set before clearing _active: the lock-free handler must always see
            # the rid in one of the two slots, never a torn in-between state.
            _finishing_rid = rid
            _active["task"] = None
            _active["rid"] = None


async def _handle_execute(req: dict[str, Any], ns: dict[str, Any]) -> None:
    global _cell_counter, _cell_file
    cell_id = req["id"]
    _cell_counter += 1
    filename = f"<cell-{_cell_counter}>"
    _cell_file = filename
    execution = _CellExecution()
    cell_token = _current_cell.set(cell_id)
    execution_token = _current_cell_execution.set(execution)
    try:
        codes, has_trailing = _compile_cell(req["code"], filename)
        assert _loop is not None
        task = _loop.create_task(_run_codes(codes, ns))
        execution.owner = task
        status, value, error = await _run_guarded(task, cell_id)
        result_text: str | None = None
        try:
            if _consume_handoff_interrupt() and status == "ok":
                # SIGINT landed between the task's completion and the finishing
                # phase: it targeted this request, so cancel its remaining work.
                status, error = "error", _error_event(cell_id, KeyboardInterrupt())
            if status == "ok" and has_trailing and value is not None:
                try:
                    ns["_"] = value
                    result_text = repr(value)
                except BaseException as exc:  # noqa: BLE001 - a broken __repr__ is a cell error
                    status, error = "error", _error_event(cell_id, exc)
            if result_text is not None:
                result_text = _cap_text(result_text)
            _drain_output()
        finally:
            # Close the interrupt window before the protocol sends so a
            # handler-raised KeyboardInterrupt can never tear a frame mid-_send.
            _finish_request(cell_id)
        if result_text is not None:
            _send({"event": "result", "id": cell_id, "text": result_text})
        if error is not None:
            _send(error)
        _send({"event": "done", "id": cell_id, "status": status})
    finally:
        _cell_file = None
        execution.owner = None
        execution.finished.set()
        _current_cell_execution.reset(execution_token)
        _current_cell.reset(cell_token)


def _drain_output() -> None:
    # Per-stream, and ValueError too: a cell may close sys.stdout/sys.stderr, and
    # flushing a closed file raises ValueError, or rebind them to a flush-less
    # object (AttributeError); neither may kill the serve loop nor skip flushing
    # the other stream.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError, AttributeError):
            pass
    _pump_out.drain()
    _pump_err.drain()


class _SnapshotSizeLimitExceeded(Exception):
    pass


class _CappedWriter:
    def __init__(self, sink: Any, limit: int) -> None:
        self._sink = sink
        self._limit = limit
        self.written = 0

    def write(self, chunk: Any) -> int:
        size = len(chunk)
        if self.written + size > self._limit:
            raise _SnapshotSizeLimitExceeded()
        self._sink.write(chunk)
        self.written += size
        return size


def _has_filehandle_reducer(blob: bytes | bytearray) -> bool:
    """Reject dill reducers that can reopen or truncate durable files."""
    if b"_create_filehandle" not in blob:
        return False
    import pickletools

    strings: list[str] = []
    try:
        for opcode, arg, _pos in pickletools.genops(blob):
            if opcode.name == "GLOBAL" and arg == "dill._dill _create_filehandle":
                return True
            if opcode.name in {"UNICODE", "BINUNICODE", "SHORT_BINUNICODE", "BINUNICODE8"}:
                strings.append(arg)
                if len(strings) > 2:
                    strings.pop(0)
            elif opcode.name == "STACK_GLOBAL" and strings == ["dill._dill", "_create_filehandle"]:
                return True
    except Exception:  # noqa: BLE001 - a suspicious, undisassemblable blob fails closed
        return True
    return False


def _read_snapshot_records(fh: Any) -> dict[str, bytes]:
    """Framing damage is a corrupt snapshot: a restore error, never a partial namespace.
    Length fields are bounds-checked before their reads, so a corrupt header cannot force a huge allocation."""
    fh.seek(0, os.SEEK_END)
    size = fh.tell()
    fh.seek(len(_SNAPSHOT_MAGIC))
    records: dict[str, bytes] = {}
    while fh.tell() < size:
        header = fh.read(4)
        if len(header) < 4:
            raise ValueError("truncated snapshot record")
        name_len = int.from_bytes(header, "little")
        if fh.tell() + name_len + 8 > size:
            raise ValueError("truncated snapshot record")
        name = fh.read(name_len)
        raw_len = fh.read(8)
        blob_len = int.from_bytes(raw_len, "little")
        if len(raw_len) < 8 or fh.tell() + blob_len > size:
            raise ValueError("truncated snapshot record")
        blob = fh.read(blob_len)
        if len(blob) < blob_len:
            raise ValueError("truncated snapshot record")
        records[name.decode("utf-8")] = blob
    return records


def _snapshot_state(
    ns: dict[str, Any],
    path: str,
    manifest_path: str,
    max_bytes: int,
    max_variable_bytes: int,
    prune_oversized: bool,
    committed: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    import datetime
    import tempfile

    try:
        import dill
    except Exception as err:  # noqa: BLE001 - dill is provisioned by the host, not a hard dep
        return {"error": f"dill unavailable: {err}"}
    dill.settings["recurse"] = True

    saved: list[str] = []
    skipped: list[dict[str, str]] = []
    oversized: list[str] = []
    unsafe_handles: list[str] = []
    total = 0
    missing = object()
    candidate_names = [
        name for name in list(ns.keys())
        if isinstance(name, str) and not name.startswith("_") and name not in _ALWAYS_SKIP
    ]
    # Imports/helpers are cheap and useful across turns. For data, prefer the
    # newest top-level bindings: dict insertion order is the namespace's only
    # recency signal.
    stable_names = [
        name for name in candidate_names
        if name in ns and (isinstance(ns[name], types.ModuleType) or callable(ns[name]))
    ]
    stable_name_set = set(stable_names)
    data_names = [name for name in candidate_names if name not in stable_name_set]
    candidate_names = stable_names + list(reversed(data_names))

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temps: list[str] = []

    def stage_temp(target: str, mode: str):
        # Unique same-directory temps: a fixed '.tmp' name could alias the other
        # final path (clobbering it) or collide with a concurrent snapshot.
        fd, name = tempfile.mkstemp(
            dir=os.path.dirname(target) or ".", prefix=os.path.basename(target) + ".", suffix=".tmp"
        )
        temps.append(name)
        try:
            return os.fdopen(fd, mode), name
        except BaseException:
            os.close(fd)  # fdopen never took ownership: the raw fd would leak
            raise

    def discard_temps() -> None:
        for stale in temps:
            try:
                os.remove(stale)
            except OSError:
                pass

    # Stage both temps before replacing anything: any failure up to the first
    # replace leaves the previous payload+manifest pair fully intact.
    stage = "write"
    parked: list[int] = []
    handler_installed = False
    previous = None
    try:
        try:
            if max_bytes < len(_SNAPSHOT_MAGIC):
                # Even the header alone busts the cap: keep the committed-payload <= cap invariant.
                return {"error": "write failed: snapshot exceeds aggregate snapshot size cap"}
            fh, tmp = stage_temp(path, "wb")
            with fh:
                # Single pass: each variable is dill-serialized exactly once, streamed
                # into the staged temp. The record header is charged against the aggregate
                # cap up front, so a completed record can never overflow it (no prefix re-dump).
                total = fh.write(_SNAPSHOT_MAGIC)
                for name in candidate_names:
                    value = ns.get(name, missing)
                    if value is missing:
                        # A background thread deleted the name after the key listing.
                        skipped.append({"name": name, "reason": "deleted during snapshot"})
                        continue
                    if isinstance(value, io.IOBase):
                        skipped.append({"name": name, "reason": "unsafe file handle (io.IOBase)"})
                        unsafe_handles.append(name)
                        continue
                    encoded = name.encode("utf-8")
                    # Record header: 4-byte name length + 8-byte blob length, plus the name itself.
                    budget = max_bytes - total - 12 - len(encoded)
                    # Prune mode measures at the full per-variable cap: only that cap decides
                    # pruned-ness, and the write always re-measures — in-place mutation
                    # defeats any name-based size tracking from an earlier dump.
                    limit = max_variable_bytes if prune_oversized else min(max_variable_bytes, budget)
                    buffer = io.BytesIO()
                    try:
                        dill.dump(value, _CappedWriter(buffer, limit))
                        blob = buffer.getvalue()
                        if _has_filehandle_reducer(blob):
                            skipped.append({"name": name, "reason": "unsafe dill file-handle reducer"})
                            continue
                    except _SnapshotSizeLimitExceeded:
                        if not prune_oversized and budget < max_variable_bytes:
                            skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                        else:
                            skipped.append({"name": name, "reason": "exceeds per-variable snapshot size cap"})
                            oversized.append(name)
                        continue
                    except Exception as err:  # noqa: BLE001 - one unpicklable name must not abort the snapshot
                        skipped.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
                        continue
                    if total + 12 + len(encoded) + len(blob) > max_bytes:
                        # Only reachable in prune mode, where the measurement cap ignores the budget.
                        skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
                        if prune_oversized:
                            oversized.append(name)
                        continue
                    fh.write(len(encoded).to_bytes(4, "little"))
                    fh.write(encoded)
                    fh.write(len(blob).to_bytes(8, "little"))
                    fh.write(blob)
                    total += 12 + len(encoded) + len(blob)
                    saved.append(name)
                saved.sort()
                pruned = sorted(name for name in oversized if name in ns) if prune_oversized else []
                manifest = {
                    "version": 2,
                    "savedNames": saved,
                    "skipped": skipped,
                    "pruned": pruned,
                    "purgedFileHandles": sorted(unsafe_handles),
                    "bytes": total,
                    "pythonVersion": sys.version.split()[0],
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
                stage = "manifest write"
                fh, manifest_tmp = stage_temp(manifest_path, "w")
                with fh:
                    json.dump(manifest, fh)
        except BaseException as err:  # noqa: BLE001 - Exception -> error dict, rest propagates
            if not isinstance(err, Exception):
                raise  # e.g. KeyboardInterrupt: clean up (outer finally), then propagate
            return {"error": f"{stage} failed: {err}"}

        # A SIGINT-raised KeyboardInterrupt anywhere from the first commit through the
        # last cleanup removal would desync payload/manifest/namespace or misreport a
        # committed snapshot: park SIGINT until the end; it is consumed, see below.
        previous = signal.signal(signal.SIGINT, lambda signum, frame: parked.append(signum))
        handler_installed = True
        try:
            os.replace(tmp, path)
        except OSError as err:
            return {"error": f"write failed: {err}"}
        try:
            os.replace(manifest_tmp, manifest_path)
        except OSError as err:
            # Fail before the prune deletions so a bad manifest path never destroys state.
            return {"error": f"manifest write failed: {err}"}
        purge_names = sorted(set(pruned + unsafe_handles))
        purge_ids = {id(ns[name]) for name in purge_names if name in ns}
        for name in purge_names:
            ns.pop(name, None)
        output_cache = ns.get("Out")
        if isinstance(output_cache, dict):
            for key in list(output_cache):
                if id(output_cache[key]) in purge_ids:
                    del output_cache[key]
        import gc

        gc.collect()
        result = {
            "saved": saved,
            "skipped": skipped,
            "pruned": pruned,
            "purgedFileHandles": sorted(unsafe_handles),
            "bytes": total,
        }
        # Publish while still parked: a later KeyboardInterrupt into this task finds the committed result (see _handle_state).
        if committed is not None:
            committed.append(result)
    finally:
        # The one guaranteed cleanup point (unique owned names: after a successful
        # commit the renamed temps no longer exist, so this is a no-op). It runs with
        # SIGINT still parked; the nested finally makes the restore the guaranteed
        # last action even when cleanup itself fails.
        try:
            discard_temps()
        finally:
            if handler_installed:
                signal.signal(signal.SIGINT, previous)
                # The parked SIGINT is consumed, not re-raised: with the manifest committed and
                # the namespace pruned, the destructive snapshot has succeeded, and re-raising
                # would misreport it as failed and risk the host discarding the only copy of
                # the pruned variables. The interrupt targeted this now-complete request.
    return result


def _revive_with_live_globals(
    value: Any,
    ns: dict[str, Any],
    backfill: list[tuple[str, Any]] | None = None,
    memo: dict[int, Any] | None = None,
) -> Any:
    """Rebind restored __main__ callables onto the live namespace, collecting
    names their saved globals carry but ns lacks as backfill for the caller
    to apply at commit (live ns values always win)."""
    import functools

    if memo is None:
        memo = {}
    if id(value) in memo:
        return memo[id(value)]

    def revive(dep: Any) -> Any:
        return _revive_with_live_globals(dep, ns, backfill, memo)

    if isinstance(value, functools.partial):
        # No placeholder memo entry: a partial is immutable, so it could never be patched;
        # every cycle passes through a function, which is memoized before recursing.
        rebuilt = revive(value.func)
        changed = rebuilt is not value.func
        args = []
        keywords = {}
        for arg in value.args:
            revived = revive(arg)
            changed = changed or revived is not arg
            args.append(revived)
        for key, arg in value.keywords.items():
            revived = revive(arg)
            changed = changed or revived is not arg
            keywords[key] = revived
        if not changed:
            return memo.setdefault(id(value), value)
        rebuilt_partial = functools.partial(rebuilt, *args, **keywords)
        rebuilt_partial.__dict__.update(value.__dict__)
        return memo.setdefault(id(value), rebuilt_partial)
    atoms = (int, float, str, bytes, bool, type(None))
    # dill loads __main__.__dict__ by reference, so a saved globals() IS the live ns: never walk it.
    if value is ns:
        return value
    if isinstance(value, (list, dict)):
        # Memoized before recursing and revived in place: cycles and identity come for free.
        # Skipping atoms keeps the walk over million-element containers near dill.loads cost.
        memo[id(value)] = value
        for key, item in enumerate(value) if isinstance(value, list) else value.items():
            revived = item if type(item) in atoms else revive(item)
            if revived is not item:
                value[key] = revived
        return value
    if type(value) is tuple:
        items = tuple(item if type(item) in atoms else revive(item) for item in value)
        if all(new is old for new, old in zip(items, value)):
            items = value
        return memo.setdefault(id(value), items)
    if not isinstance(value, types.FunctionType) or value.__module__ != "__main__":
        return value
    # Defaults and cell contents are revived only after the rebound function is memoized, so a
    # function reachable from its own defaults or closure resolves to it. Cells are revived in
    # place: holders this walk never sees (attribute-held siblings) must keep sharing them.
    rebound = types.FunctionType(value.__code__, ns, value.__name__, None, value.__closure__)
    memo[id(value)] = rebound
    if backfill is not None:
        for name, dep in value.__globals__.items():
            # Snapshots never save _-prefixed or skip-listed names; backfill must not smuggle them past that policy.
            if name in ns or name.startswith("_") or name in _ALWAYS_SKIP or name in _RESTORE_SKIP:
                continue
            backfill.append((name, revive(dep)))
    if value.__defaults__:
        rebound.__defaults__ = tuple(revive(dep) for dep in value.__defaults__)
    if value.__kwdefaults__:
        rebound.__kwdefaults__ = {key: revive(dep) for key, dep in value.__kwdefaults__.items()}
    for cell in value.__closure__ or ():
        if id(cell) in memo:
            continue
        memo[id(cell)] = cell
        try:
            contents = cell.cell_contents
        except ValueError:
            continue
        cell.cell_contents = revive(contents)
    rebound.__doc__ = value.__doc__
    rebound.__dict__.update({key: revive(attr) for key, attr in value.__dict__.items()})
    rebound.__annotations__ = value.__annotations__
    rebound.__qualname__ = value.__qualname__
    rebound.__module__ = value.__module__
    # PEP 695 generics carry their type params here on 3.12+; plain 3.11
    # functions lack the attribute entirely, hence the getattr guard.
    params = getattr(value, "__type_params__", None)
    if params is not None:
        rebound.__type_params__ = params
    return rebound


def _restore_state(
    ns: dict[str, Any], path: str, committed: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"restored": [], "failed": [], "reason": "snapshot not found"}
    try:
        import dill
    except Exception as err:  # noqa: BLE001
        return {"error": f"dill unavailable: {err}"}
    try:
        with open(path, "rb") as fh:
            if fh.read(len(_SNAPSHOT_MAGIC)) == _SNAPSHOT_MAGIC:
                payload = _read_snapshot_records(fh)
            else:
                # Legacy: one dill-pickled dict; old snapshot files must keep restoring.
                fh.seek(0)
                payload = dill.load(fh)
    except Exception as err:  # noqa: BLE001 - a corrupt snapshot yields an empty restore
        return {"error": f"load failed: {_safe_str(err)}"}
    if not isinstance(payload, dict):
        return {"error": "corrupt snapshot: not a dict"}

    staged: dict[str, Any] = {}
    failed: list[dict[str, str]] = []
    for name, blob in payload.items():
        if name in _RESTORE_SKIP:
            continue
        if not isinstance(blob, (bytes, bytearray)):
            failed.append({"name": name, "reason": "corrupt snapshot variable: not bytes"})
            continue
        # Legacy snapshots may reduce handles through dill._dill._create_filehandle.
        # Reject before dill.loads so restore cannot reopen/truncate durable files.
        if _has_filehandle_reducer(blob):
            failed.append({"name": name, "reason": "unsafe legacy dill file-handle reducer rejected"})
            continue
        try:
            staged[name] = dill.loads(blob)
        except Exception as err:  # noqa: BLE001 - revive every other name regardless
            failed.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
    # Revive every staged name before parking: a failure must never abort the
    # apply halfway and leave the namespace half old, half new.
    prepared: dict[str, Any] = {}
    backfill: list[tuple[str, Any]] = []
    revive_failed: list[dict[str, str]] = []
    for name, value in staged.items():
        try:
            prepared[name] = _revive_with_live_globals(value, ns, backfill)
        except Exception as err:  # noqa: BLE001 - one broken revival must not abort the restore
            revive_failed.append({"name": name, "reason": f"{type(err).__name__}: {_safe_str(err)[:200]}"})
    result = {"restored": sorted(prepared), "failed": failed + revive_failed}
    # Park SIGINT across the whole apply so it is all-or-nothing; the parked interrupt is consumed by the commit (as in snapshot).
    previous = signal.signal(signal.SIGINT, lambda signum, frame: None)
    try:
        for name, value in prepared.items():
            ns[name] = value
        for name, value in backfill:
            # prepared names already sit in ns here: a restored value always beats backfill.
            if name not in ns:
                ns[name] = value
        # Publish while still parked: a later KeyboardInterrupt into this task finds the committed result (see _handle_state).
        if committed is not None:
            committed.append(result)
    finally:
        signal.signal(signal.SIGINT, previous)
    return result


async def _handle_state(req: dict[str, Any], ns: dict[str, Any]) -> None:
    """Run snapshot/restore as an interruptible task and reply in the done event."""
    import asyncio

    rid = req["id"]
    committed: list[dict[str, Any]] = []

    async def run() -> dict[str, Any]:
        if req["type"] == "snapshot":
            prune = req.get("prune_oversized", False)
            if not isinstance(prune, bool):
                return {"error": "prune_oversized must be a boolean"}
            for field in ("max_bytes", "max_variable_bytes"):
                # Any present value must be a non-negative int; a JSON null is not a valid way to ask
                # for the default, and a negative cap would prune every user variable from ns.
                if field in req and (
                    isinstance(req[field], bool) or not isinstance(req[field], int) or req[field] < 0
                ):
                    return {"error": f"{field} must be a non-negative integer"}
            # realpath resolves symlinks, so aliased paths cannot silently clobber the payload.
            if os.path.realpath(req["path"]) == os.path.realpath(req["manifest_path"]):
                return {"error": "path and manifest_path must differ"}
            return _snapshot_state(
                ns,
                req["path"],
                req["manifest_path"],
                req.get("max_bytes", DEFAULT_SNAPSHOT_MAX_BYTES),
                req.get("max_variable_bytes", DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES),
                prune,
                committed,
            )
        return _restore_state(ns, req["path"], committed)

    assert _loop is not None
    task = _loop.create_task(run())
    outcome: tuple[str, Any, dict[str, Any] | None] | None = None
    try:
        outcome = await _run_guarded(task, rid)
        _finish_request(rid)  # no post-run repr/drain: close the interrupt window now
    except KeyboardInterrupt:
        # A finishing-targeted SIGINT can raise anywhere between _run_guarded's
        # finally publishing _finishing_rid and _finish_request clearing it; the
        # handler only raises once _finishing_rid is set, so the task is already
        # complete (destructively so for a pruning snapshot). Consume the
        # interrupt and report the task's real outcome; escaping to the backstop
        # would misreport a committed snapshot as failed.
        _finish_request(rid)
        if outcome is None:
            # The KeyboardInterrupt pre-empted _run_guarded's return: recover
            # the completed task's outcome with _run_guarded's failure mapping.
            try:
                outcome = ("ok", task.result(), None)
            except asyncio.CancelledError as exc:
                event = _interrupt_event(rid, exc) if _active["interrupted"] else _error_event(rid, exc)
                outcome = ("error", None, event)
            except BaseException as exc:  # noqa: BLE001 - every request failure becomes an error event
                outcome = ("error", None, _error_event(rid, exc))
    status, result, error = outcome
    if (
        committed
        and _active["interrupted"]
        and error is not None
        and error.get("ename") == "KeyboardInterrupt"
    ):
        # Recover only a protocol interrupt that landed after the commit; a user KeyboardInterrupt keeps interrupted reporting.
        status, result, error = "ok", committed[0], None
    if status != "ok":
        reason = "interrupted" if error and error.get("ename") == "KeyboardInterrupt" else (
            f"{error.get('ename')}: {error.get('evalue')}" if error else "failed"
        )
        _send({"event": "done", "id": rid, "status": "error", "reason": reason})
        return
    if "error" in result:
        _send({"event": "done", "id": rid, "status": "error", "reason": result["error"]})
        return
    _send({"event": "done", "id": rid, "status": "ok", **result})


def _list_names(ns: dict[str, Any]) -> list[str]:
    """User-defined top-level names, filtered like the snapshot."""
    # Non-string keys (globals()[1] = 1) are not user-listable names.
    return sorted(
        name for name in ns if isinstance(name, str) and not name.startswith("_") and name not in _ALWAYS_SKIP
    )


async def _handle_list_names(req: dict[str, Any], ns: dict[str, Any]) -> None:
    _send({"event": "done", "id": req["id"], "status": "ok", "names": _list_names(ns)})


# Sizing walks at most this many objects per top-level value, then extrapolates.
_SIZE_WALK_NODES = 100_000
# A memory report races a kill: it walks less and extrapolates more.
_REPORT_WALK_NODES = 10_000
_SIZE_WALK_DEPTH = 32
_UNSIZED_TYPES = (types.ModuleType, type, types.FunctionType, types.BuiltinFunctionType, types.MethodType)


_ATOMS = (int, float, complex, bool, type(None), bytes, bytearray, str)


def _direct_size(value: Any) -> int | None:
    """In-memory bytes of atoms and of array-likes that report their own size, else None."""
    if type(value) in _ATOMS:
        return sys.getsizeof(value)
    if isinstance(value, memoryview):
        return value.nbytes
    module = type(value).__module__ or ""
    try:
        if module.startswith("pandas"):
            usage = value.memory_usage(deep=True)
            return int(usage.sum()) if hasattr(usage, "sum") else int(usage)
        if module.startswith("polars"):
            return int(value.estimated_size())
        nbytes = getattr(value, "nbytes", None)
        if callable(nbytes):
            nbytes = nbytes()
    except Exception:  # noqa: BLE001 - a broken size hook falls back to the walk
        return None
    return nbytes if isinstance(nbytes, int) and not isinstance(nbytes, bool) else None


def _deep_size(value: Any, seen: set[int], budget: list[int], depth: int = 0) -> int:
    """Bounded walk: containers and instance dicts; a list longer than the budget is extrapolated."""
    if id(value) in seen or isinstance(value, _UNSIZED_TYPES):
        return 0
    seen.add(id(value))
    budget[0] -= 1
    direct = _direct_size(value)
    if direct is not None:
        return direct
    try:
        size = sys.getsizeof(value)
    except Exception:  # noqa: BLE001
        size = 0
    if depth >= _SIZE_WALK_DEPTH:
        return size
    try:
        if isinstance(value, dict):
            children: Any = [item for pair in value.items() for item in pair]
            count = 2 * len(value)
        elif isinstance(value, (list, tuple, set, frozenset)) or type(value).__name__ == "deque":
            children, count = value, len(value)
        else:
            attrs = getattr(value, "__dict__", None)
            if not isinstance(attrs, dict):
                return size
            children, count = list(attrs.values()), len(attrs)
        walked = total = 0
        for child in children:
            if budget[0] <= 0:
                break
            total += _deep_size(child, seen, budget, depth + 1)
            walked += 1
    except Exception:  # noqa: BLE001 - a mutating or broken container keeps what was measured
        return size
    if 0 < walked < count:
        total = total * count // walked
    return size + total


def _array_owner(value: Any) -> Any:
    """The array that owns a view's memory (numpy .base chain), so views and bases drop together."""
    for _ in range(8):
        base = getattr(value, "base", None) if (type(value).__module__ or "").startswith("numpy") else None
        if base is None or not (type(base).__module__ or "").startswith("numpy"):
            return value
        value = base
    return value


_ARRAY_MODULES = ("numpy", "pandas", "polars", "torch")
_SIZED_CONTAINERS = (list, tuple, set, frozenset, dict)


def _shape_fields(value: Any) -> dict[str, Any]:
    """Shape and dtype of an array or frame (numpy, pandas, polars, torch), or a container's length."""
    try:
        if (type(value).__module__ or "").split(".")[0] in _ARRAY_MODULES:
            fields: dict[str, Any] = {}
            shape = getattr(value, "shape", None)
            if isinstance(shape, tuple):
                fields["shape"] = [int(n) for n in shape]
            dtype = getattr(value, "dtype", None)
            if dtype is not None:
                fields["dtype"] = str(dtype).removeprefix("torch.")
            elif getattr(value, "dtypes", None) is not None:
                kinds = list(dict.fromkeys(str(kind) for kind in list(value.dtypes)))
                fields["dtype"] = "/".join(kinds[:3]) + ("/..." if len(kinds) > 3 else "")
            return fields
        if isinstance(value, _SIZED_CONTAINERS) or type(value).__name__ == "deque":
            return {"length": len(value)}
    except Exception:  # noqa: BLE001 - a broken attribute leaves the size and type
        pass
    return {}


def _sized_groups(ns: dict[str, Any], walk_nodes: int = _SIZE_WALK_NODES) -> list[dict[str, Any]]:
    """Top-level names grouped by the object that holds their memory, largest first."""
    groups: dict[int, dict[str, Any]] = {}
    for name, value in list(ns.items()):
        if not isinstance(name, str) or (name.startswith("__") and name.endswith("__")) or name in _ALWAYS_SKIP:
            continue
        if isinstance(value, _UNSIZED_TYPES):
            continue
        owner = _array_owner(value)
        group = groups.get(id(owner))
        if group is None:
            group = groups[id(owner)] = {
                "names": [],
                "ids": set(),
                "bytes": _deep_size(owner, set(), [walk_nodes]),
                "type": type(value).__name__,
                "details": _shape_fields(value),
            }
        group["names"].append(name)
        group["ids"].add(id(value))
    return sorted(groups.values(), key=lambda group: group["bytes"], reverse=True)


def _sized_entry(group: dict[str, Any]) -> dict[str, Any]:
    return {"name": ", ".join(group["names"]), "bytes": group["bytes"], "type": group["type"], **group["details"]}


def _release_heap() -> None:
    """Hand freed heap pages back to the OS so the host's measurement sees the drop."""
    try:
        if sys.platform.startswith("linux"):
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        elif sys.platform == "darwin":
            ctypes.CDLL("/usr/lib/libSystem.B.dylib").malloc_zone_pressure_relief(None, 0)
    except (OSError, AttributeError):
        pass


def _trim_memory(ns: dict[str, Any], target_bytes: int, min_bytes: int, count: int = 3) -> dict[str, Any]:
    """Drop the largest top-level values (never one under min_bytes) until target_bytes are freed."""
    import gc

    groups = _sized_groups(ns)
    dropped: list[dict[str, Any]] = []
    freed = 0
    purge_ids: set[int] = set()
    for group in groups:
        if freed >= target_bytes or group["bytes"] < min_bytes:
            break
        for name in group["names"]:
            ns.pop(name, None)
        purge_ids |= group["ids"]
        freed += group["bytes"]
        dropped.append(_sized_entry(group))
    output_cache = ns.get("Out")
    if isinstance(output_cache, dict):
        for key in [key for key, value in output_cache.items() if id(value) in purge_ids]:
            del output_cache[key]
    for attr in ("last_type", "last_value", "last_traceback", "last_exc"):
        if hasattr(sys, attr):
            setattr(sys, attr, None)
    kept = groups[len(dropped) :]
    del groups
    gc.collect()
    _release_heap()
    largest = [_sized_entry(group) for group in kept[:count]]
    return {"dropped": dropped, "largest": largest, "more": max(0, len(kept) - count), "freed_bytes": freed}


async def _handle_trim_memory(req: dict[str, Any], ns: dict[str, Any]) -> None:
    fields = {}
    for field, default in (("target_bytes", 0), ("min_bytes", 0), ("count", 3)):
        value = req.get(field, default)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            _send({"event": "done", "id": req["id"], "status": "error", "reason": f"{field} must be a non-negative integer"})
            return
        fields[field] = value
    result = _trim_memory(ns, fields["target_bytes"], fields["min_bytes"], fields["count"])
    _send({"event": "done", "id": req["id"], "status": "ok", **result})


async def _handle_request(
    handler: Callable[[dict[str, Any], dict[str, Any]], Awaitable[None]],
    req: dict[str, Any],
    ns: dict[str, Any],
) -> None:
    # Backstop: one broken request (e.g. RecursionError in compile) fails alone, never the serve loop.
    try:
        await handler(req, ns)
    except BaseException as exc:  # noqa: BLE001 - any per-request failure becomes error+done
        rid = req["id"]
        with _interrupt_lock:
            # Only a still-inflight request (never reached _run_guarded, e.g. compile
            # failure) owns a parked interrupt; after _run_guarded finished it, a parked
            # "any" belongs to the next request and must survive.
            if rid in _inflight:
                _consume_pending_interrupt(rid)
            _finish_locked(rid)
        _send(_error_event(rid, exc))
        _send({"event": "done", "id": rid, "status": "error"})


async def _serve(queue: asyncio.Queue[dict[str, Any]], ns: dict[str, Any]) -> None:
    while True:
        req = await queue.get()
        # A cell (or a snapshot-restored prior handler) may have rebound SIGINT; the
        # protocol handler must own it before each request. Mid-cell rebinds remain
        # that cell's own problem for that cell only.
        signal.signal(signal.SIGINT, _sigint_handler)
        rtype = req.get("type")
        if rtype == "shutdown":
            rid = req.get("id")
            # MCP children must close before the loop dies; close() is internally bounded under the host's 5s deadline.
            mcp_mod = sys.modules.get("rlm.mcp")
            if mcp_mod is not None:
                try:
                    await mcp_mod.close()
                except BaseException as exc:
                    print(f"MCP shutdown failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            # Kill live bash children now; atexit would wait on parked executor threads.
            _kill_live_handles()
            if isinstance(rid, str):
                _send({"event": "done", "id": rid, "status": "ok"})
            return
        if rtype == "execute":
            await _handle_request(_handle_execute, req, ns)
        elif rtype in ("snapshot", "restore"):
            await _handle_request(_handle_state, req, ns)
        elif rtype == "list_names":
            await _handle_request(_handle_list_names, req, ns)
        elif rtype == "trim_memory":
            await _handle_request(_handle_trim_memory, req, ns)


_REQUIRED_FIELDS = {
    "execute": ("id", "code"),
    "snapshot": ("id", "path", "manifest_path"),
    "restore": ("id", "path"),
    "list_names": ("id",),
    "trim_memory": ("id",),
    "shutdown": (),
}


def _handle_memory_notice(req: dict[str, Any]) -> None:
    """Reader-thread half of the child step: record why these pids die, then acknowledge.

    Out-of-band like interrupt: the host kills the group right after this
    acknowledgement, so the bash() call that owned it can return the reason.
    """
    rid, pids, text = req.get("id"), req.get("pids"), req.get("text")
    if (
        not isinstance(rid, str)
        or not isinstance(text, str)
        or not isinstance(pids, list)
        or not all(isinstance(pid, int) and not isinstance(pid, bool) for pid in pids)
    ):
        _protocol_error("memory_notice request needs string id and text and an int pids list")
        return
    matched, awaited = record_memory_notice(pids, text)
    _send({"event": "done", "id": rid, "status": "ok", "matched": matched, "awaited": awaited})


def _running_line() -> dict[str, Any] | None:
    """The line the running cell executes now: its innermost frame in its own code, read from another thread."""
    filename = _cell_file
    if filename is None:
        return None
    frame = sys._current_frames().get(threading.main_thread().ident)
    while frame is not None and frame.f_code.co_filename != filename:
        frame = frame.f_back
    if frame is None:
        # Suspended at an await: the cell's frames hang off its task's await chain.
        task = _active["task"]
        awaitable: Any = task.get_coro() if task is not None else None
        for _ in range(64):
            inner = getattr(awaitable, "cr_frame", None)
            if inner is not None and inner.f_code.co_filename == filename:
                frame = inner
            awaitable = getattr(awaitable, "cr_await", None)
            if awaitable is None:
                break
    return _line_of(filename, frame.f_lineno) if frame is not None else None


def _handle_memory_report(req: dict[str, Any]) -> None:
    """Answer off the request queue, like interrupt: the host asks right before it ends the kernel,
    usually while a cell is still running, for the running line and the names it holds."""
    rid, count = req.get("id"), req.get("count", 30)
    if not isinstance(rid, str) or isinstance(count, bool) or not isinstance(count, int) or count < 0:
        _protocol_error("memory_report request needs a string id and a non-negative int count")
        return

    def report() -> None:
        try:
            line = _running_line()
            groups = _sized_groups(_user_ns if _user_ns is not None else {}, _REPORT_WALK_NODES)
            names = [_sized_entry(group) for group in groups[:count]]
            more = max(0, len(groups) - count)
            _send({"event": "done", "id": rid, "status": "ok", "line": line, "names": names, "more": more})
        except Exception as exc:  # noqa: BLE001 - the host falls back to what it already knows
            _send({"event": "done", "id": rid, "status": "error", "reason": _safe_str(exc)})

    # Its own thread: sizing a large namespace must not hold up interrupts on the reader thread.
    threading.Thread(target=report, name="rlm-memory-report", daemon=True).start()


def _protocol_error(message: str) -> None:
    _send({"event": "error", "id": None, "ename": "ProtocolError", "evalue": message, "traceback": []})


def _handle_request_line(raw: bytes, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    req = json.loads(raw)
    if not isinstance(req, dict):
        raise ValueError("request is not a JSON object")
    rtype = req.get("type")
    if rtype == "interrupt":
        if "id" in req and not isinstance(req["id"], str):
            _protocol_error("interrupt request id must be a string")
            return
        _request_interrupt(req.get("id"))
        return
    if rtype == "memory_notice":
        _handle_memory_notice(req)
        return
    if rtype == "memory_report":
        _handle_memory_report(req)
        return
    if rtype == "host_reply":
        # Bypass the FIFO queue: the awaiting cell IS the in-flight
        # execute, so a queued reply would deadlock behind it.
        rid = req.get("id")
        data = req.get("data")
        if isinstance(rid, str) and isinstance(data, dict):
            _resolve_host_reply(rid, data)
        else:
            _protocol_error("host_reply request needs string id and dict data")
        return
    if not isinstance(rtype, str) or rtype not in _REQUIRED_FIELDS:
        _protocol_error(f"unknown request type: {rtype!r}")
        return
    missing = [f for f in _REQUIRED_FIELDS[rtype] if not isinstance(req.get(f), str)]
    if missing:
        _protocol_error(f"{rtype} request needs string fields: {', '.join(missing)}")
        return
    if rtype in ("execute", "snapshot", "restore"):
        with _interrupt_lock:
            # A reused in-flight id would corrupt interrupt/finish bookkeeping.
            duplicate = req["id"] in _inflight
            if not duplicate:
                _inflight.add(req["id"])
        # The protocol write can block on backpressure: never send under the lock.
        if duplicate:
            _protocol_error(f"duplicate in-flight request id: {req['id']!r}")
            return
    if rtype == "shutdown":
        # No host reply follows a shutdown; a cell awaiting host_request
        # must fail now or it would block _serve from ever consuming this.
        _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, req)


def _read_requests(stdin_fd: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
    assert _loop is not None
    with os.fdopen(stdin_fd, "rb") as stream:
        for raw in stream:
            raw = raw.strip()
            if not raw:
                continue
            try:
                # The whole per-line handling sits inside the backstop: hostile
                # input (RecursionError from pathological nesting, unhashable
                # field types, ...) must never kill the reader thread.
                _handle_request_line(raw, queue)
            except BaseException as err:  # noqa: BLE001
                _protocol_error(f"{type(err).__name__}: {_safe_str(err)}")
    # Host closed stdin: shut the runtime down.
    _loop.call_soon_threadsafe(_fail_pending_host_requests)
    _loop.call_soon_threadsafe(queue.put_nowait, {"type": "shutdown"})


def _resolve_owner_pid() -> int:
    raw = os.environ.get("PRIME_AGENT_KERNEL_OWNER_PID", "")
    try:
        owner = int(raw)
    except ValueError:
        owner = 0
    return owner if owner > 0 else os.getppid()


def _owner_alive_posix(owner: int, initial_ppid: int) -> bool:
    # Reparenting is the race-free parent-death signal when the owner is the
    # parent; the kill-0 probe covers an env-designated non-parent owner.
    if initial_ppid == owner and os.getppid() != initial_ppid:
        return False
    try:
        os.kill(owner, 0)
    except ProcessLookupError:
        return False
    except OSError:
        pass  # EPERM etc.: alive but unprobeable
    return True


def _wait_owner_windows(owner: int) -> None:
    # Blocks until the owner exits. os.kill(pid, 0) on Windows TERMINATES the
    # target, so a SYNCHRONIZE handle wait is the only sound probe.
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    handle = k32.OpenProcess(SYNCHRONIZE, False, owner)
    if not handle:
        return  # already gone (or unprobeable): exit rather than run ownerless
    try:
        k32.WaitForSingleObject(handle, INFINITE)
    finally:
        k32.CloseHandle(handle)


def _owner_watchdog(owner: int, initial_ppid: int) -> None:
    if os.name == "nt":
        _wait_owner_windows(owner)
    else:
        while _owner_alive_posix(owner, initial_ppid):
            time.sleep(1.0)
    # Event-loop-independent by design: a synchronous cell monopolizes the
    # loop, so the queued EOF shutdown can never run; hard-exit from here.
    try:
        _kill_live_handles()
    except BaseException:  # noqa: BLE001
        pass
    os._exit(1)


def _start_owner_watchdog() -> None:
    threading.Thread(
        target=_owner_watchdog, args=(_resolve_owner_pid(), os.getppid()), daemon=True
    ).start()


_pump_out: _Pump
_pump_err: _Pump


def _setup_fds() -> int:
    """Reserve stdout for the protocol; route fds 1/2 through captured pipes."""
    global _protocol_fd, _pump_out, _pump_err
    _protocol_fd = os.dup(1)
    os.set_inheritable(_protocol_fd, False)
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    os.dup2(out_w, 1)
    os.dup2(err_w, 2)
    os.close(out_w)
    os.close(err_w)
    sys.stdout = _TaggedWriter("stdout", fallback_fd=os.dup(1))
    sys.stderr = _TaggedWriter("stderr", fallback_fd=os.dup(2))
    stdin_fd = os.dup(0)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    sys.stdin = open(os.devnull, "r")  # user input() sees EOF, never protocol frames
    _pump_out = _Pump(out_r, 1, "stdout")
    _pump_err = _Pump(err_r, 2, "stderr")
    return stdin_fd


def main() -> None:
    global _loop, _serve_task, _user_ns
    stdin_fd = _setup_fds()
    _start_owner_watchdog()

    # Alias the executing module so an in-cell `from rlm.repl import emit`
    # binds the live module, not a second copy.
    sys.modules.setdefault("rlm.repl", sys.modules[__name__])
    # A real __main__ module makes dill pickle user functions/classes by value.
    user_module = types.ModuleType("__main__")
    user_module.__dict__["__builtins__"] = __builtins__
    sys.modules["__main__"] = user_module
    _user_ns = user_module.__dict__

    _send(
        {
            "event": "ready",
            "protocol": PROTOCOL_VERSION,
            "python": platform.python_version(),
            "features": list(FEATURES),
        }
    )

    # The event-loop stack (asyncio plus its ssl, concurrent.futures, and
    # logging imports) is the heaviest part of this module's boot chain; load
    # it after the ready event so kernel startup stays lean. The loop, reader
    # thread, and serve task all come up here before the host's first request
    # can be served, and every function that references asyncio runs only
    # after this point.
    import asyncio
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    threading.Thread(target=_read_requests, args=(stdin_fd, queue), daemon=True).start()

    _serve_task = _loop.create_task(_serve(queue, user_module.__dict__))
    # _sigint_handler has no task to target before serving starts, so installing
    # it earlier would silently swallow a Ctrl-C during this boot window; the
    # default handler must stay in charge until the loop and serve task exist.
    signal.signal(signal.SIGINT, _sigint_handler)
    # A KeyboardInterrupt escaping a cell or background task stops
    # run_until_complete; the interrupt is already recorded, so resume serving.
    while not _serve_task.done():
        try:
            _loop.run_until_complete(_serve_task)
        except KeyboardInterrupt:
            continue
    _loop.close()


if __name__ == "__main__":
    main()
