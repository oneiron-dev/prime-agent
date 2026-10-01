"""The kernel half of the host's memory ceiling: the ready features, the
trim_memory request on the FIFO queue, and the out-of-band memory_notice and
memory_report requests the reader thread answers while a cell runs."""

from __future__ import annotations

import os
import signal
import sys
import unittest

from test_repl import SRC, ReplProcess, one, stream_text


class MemoryRequestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repl = ReplProcess()
        self.addCleanup(self.repl.close)
        self.ready_event, _ = self.repl.ready()

    def test_trim_memory_drops_largest_groups_above_the_floor(self):
        self.assertEqual(self.ready_event["features"], ["trim_memory", "memory_notice", "memory_report"])
        self.repl.execute("t1", "a = b'x' * 3000\nalias = a\nb = [bytes([i]) * 1000 for i in range(4)]\nc = b'z' * 500\nimport os")
        self.repl.send({"type": "trim_memory", "id": "t2", "target_bytes": 0, "min_bytes": 1000, "count": 2})
        report = one(self.repl.until_done("t2"), "done")
        self.assertEqual(report["dropped"], [])
        self.assertEqual([v["name"] for v in report["largest"]], ["b", "a, alias"])
        self.assertEqual((report["largest"][0]["length"], report["more"]), (4, 1))
        self.repl.send({"type": "trim_memory", "id": "t3", "target_bytes": 10**9, "min_bytes": 1000})
        done = one(self.repl.until_done("t3"), "done")
        self.assertEqual([(v["name"], v["type"]) for v in done["dropped"]], [("b", "list"), ("a, alias", "bytes")])
        self.assertEqual(done["freed_bytes"], sum(v["bytes"] for v in done["dropped"]))
        events = self.repl.execute("t4", "sorted(n for n in ('a', 'alias', 'b', 'c', 'os') if n in globals())")
        self.assertEqual(one(events, "result")["text"], "['c', 'os']")
        for rid, field, value in (("t5", "target_bytes", -1), ("t6", "min_bytes", True), ("t7", "count", 1.5)):
            self.repl.send({"type": "trim_memory", "id": rid, field: value})
            self.assertEqual(
                one(self.repl.until_done(rid), "done"),
                {"event": "done", "id": rid, "status": "error", "reason": f"{field} must be a non-negative integer"},
            )

    def test_interrupted_cell_releases_its_frame_locals(self):
        self.repl.execute("f1", "import gc, threading, weakref\ngc.disable()\nclass Big: pass\nrefs = []")
        # Parked on an event nothing sets: only the interrupt ends the cell.
        hold = "def hold():\n    big = Big()\n    refs.append(weakref.ref(big))\n    print('holding')\n    threading.Event().wait()\nhold()"
        self.repl.send({"type": "execute", "id": "f2", "code": hold})
        while "holding" not in stream_text([self.repl.read_event()], "stdout"):
            pass
        self.repl.send({"type": "interrupt"})
        error = one(self.repl.until_done("f2"), "error")
        self.assertEqual(
            (error["ename"], error["line"]), ("KeyboardInterrupt", {"lineno": 5, "source": "threading.Event().wait()"})
        )
        events = self.repl.execute("f3", "refs[0]() is None")
        self.assertEqual(one(events, "result")["text"], "True")

    def test_error_names_the_running_cells_own_line(self):
        self.repl.execute("e1", "def boom():\n    raise ValueError('x')")
        error = one(self.repl.execute("e2", "y = 1\nboom()"), "error")
        # The call in this cell, not the raise inside the earlier cell's function.
        self.assertEqual(error["line"], {"lineno": 2, "source": "boom()"})
        syntax = one(self.repl.execute("e3", "def ("), "error")
        self.assertNotIn("line", syntax)
        long_line = "x = " + "1 + " * 80 + "1/0"
        clipped = one(self.repl.execute("e4", long_line), "error")
        self.assertEqual(clipped["line"], {"lineno": 1, "source": long_line[:200] + "..."})

    def test_memory_notice_rides_the_killed_bash_output(self):
        events = self.repl.execute("n1", "from rlm import bash\nh = bash('tail -f /dev/null')\nh.pid")
        pid = int(one(events, "result")["text"])
        self.repl.send({"type": "memory_notice", "id": "n2", "pids": [pid + 100000], "text": "other"})
        self.assertEqual(
            one(self.repl.until_done("n2"), "done"),
            {"event": "done", "id": "n2", "status": "ok", "matched": False, "awaited": False},
        )
        self.repl.send({"type": "memory_notice", "id": "n3", "pids": [pid], "text": "idle"})
        idle = one(self.repl.until_done("n3"), "done")
        self.assertEqual((idle["matched"], idle["awaited"]), (True, False))
        # The print is scheduled to run once the cell is suspended inside `await h`.
        code = "import asyncio\nasyncio.get_running_loop().call_soon(print, 'awaiting')\nr = await h\n(r.exit_code, r.output.strip())"
        self.repl.send({"type": "execute", "id": "n4", "code": code})
        while "awaiting" not in stream_text([self.repl.read_event()], "stdout"):
            pass
        self.repl.send({"type": "memory_notice", "id": "n5", "pids": [pid], "text": "Memory limit: stopped"})
        self.assertTrue(one(self.repl.until_done("n5"), "done")["awaited"])
        os.killpg(pid, signal.SIGKILL)
        self.assertEqual(one(self.repl.until_done("n4"), "result")["text"], "(-9, 'Memory limit: stopped')")

    def test_memory_notice_is_validated_off_the_queue(self):
        self.repl.send({"type": "memory_notice", "id": "bad", "pids": [True], "text": "x"})
        self.assertEqual(
            self.repl.read_event(),
            {
                "event": "error",
                "id": None,
                "ename": "ProtocolError",
                "evalue": "memory_notice request needs string id and text and an int pids list",
                "traceback": [],
            },
        )

    def test_memory_report_answers_while_a_cell_runs(self):
        self.repl.execute("m1", "import asyncio, threading\nblob = b'x' * 5000\nitems = list(range(10))")
        self.repl.send({"type": "memory_report", "id": "m2", "count": 1})
        idle = one(self.repl.until_done("m2"), "done")
        self.assertEqual((idle["line"], [v["name"] for v in idle["names"]], idle["more"]), (None, ["blob"], 1))
        # Parked on events nothing sets, blocked in the thread or suspended at
        # an await: only the interrupt ends each cell.
        for rid, park in (("m3", "threading.Event().wait()"), ("m5", "await asyncio.Event().wait()")):
            source = f"print('parked', flush=True); {park}"
            self.repl.send({"type": "execute", "id": rid, "code": f"x = 1\n{source}"})
            while "parked" not in stream_text([self.repl.read_event()], "stdout"):
                pass
            self.repl.send({"type": "memory_report", "id": f"{rid}-report"})
            self.assertEqual(one(self.repl.until_done(f"{rid}-report"), "done")["line"], {"lineno": 2, "source": source})
            self.repl.send({"type": "interrupt"})
            self.assertEqual(one(self.repl.until_done(rid), "error")["line"], {"lineno": 2, "source": source})


class TrimMemoryUnitTest(unittest.TestCase):
    def setUp(self) -> None:
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        from rlm import memory

        self.memory = memory

    def test_numpy_views_drop_with_their_owner(self):
        import numpy as np

        base = np.zeros(400_000, dtype=np.uint8)
        ns = {"base": base, "view": base[10:], "small": np.zeros(10, dtype=np.float32)}
        result = self.memory.trim_memory(ns, set(), target_bytes=1, min_bytes=1_000)
        self.assertEqual(
            result["dropped"],
            [{"name": "base, view", "bytes": 400_000, "type": "ndarray", "shape": [400_000], "dtype": "uint8"}],
        )
        self.assertEqual(
            result["largest"], [{"name": "small", "bytes": 40, "type": "ndarray", "shape": [10], "dtype": "float32"}]
        )
        self.assertEqual(set(ns), {"small"})

    def test_trim_releases_cached_outputs_and_the_last_exception(self):
        big = b"x" * 50_000
        other = b"y" * 10
        ns = {"big": big, "Out": {1: big, 2: other}}
        sys.last_value = ValueError("held")
        self.memory.trim_memory(ns, {"Out"}, target_bytes=1, min_bytes=1_000)
        self.assertEqual((ns, sys.last_value), ({"Out": {2: other}}, None))

    def test_broken_size_hooks_fall_back_to_the_walk(self):
        class Broken:
            @property
            def nbytes(self):
                raise RuntimeError("no size")

        class Mutating(list):
            def __iter__(self):
                raise RuntimeError("changed size during iteration")

        groups = self.memory.sized_groups({"broken": Broken(), "mutating": Mutating([1, 2])}, set())
        self.assertEqual(sorted(group["type"] for group in groups), ["Broken", "Mutating"])
        self.assertTrue(all(group["bytes"] > 0 for group in groups))

    def test_skip_set_dunders_and_unsized_values_are_never_sized(self):
        import math

        groups = self.memory.sized_groups(
            {"__builtins__": {}, "rlm": b"x" * 100, "math": math, "fn": len, "kept": b"y" * 100}, {"rlm"}
        )
        self.assertEqual([group["names"] for group in groups], [["kept"]])


if __name__ == "__main__":
    unittest.main()
