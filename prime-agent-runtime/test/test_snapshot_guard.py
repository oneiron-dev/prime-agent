"""The file-handle snapshot guard: a namespace snapshot never persists an open
or closed file handle, and a restore never runs a dill reducer that could
reopen (and, for write modes, truncate) a durable file."""

from __future__ import annotations

import json
import os
import pickle
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SRC = os.path.join(os.path.dirname(__file__), "..", "src")


class SnapshotFileHandleGuardTest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, SRC)
        self.addCleanup(sys.path.remove, SRC)
        import rlm.repl as repl_module

        self.repl = repl_module
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.path = os.path.join(self.dir, "kernel-state.dill")
        self.manifest = os.path.join(self.dir, "kernel-state.json")

    def snap(self, ns, **kwargs):
        options = dict(max_bytes=1 << 20, max_variable_bytes=1 << 20, prune_oversized=False)
        options.update(kwargs)
        return self.repl._snapshot_state(ns, self.path, self.manifest, **options)

    def durable(self, name: str, text: str = "SURVIVE") -> str:
        target = os.path.join(self.dir, name)
        with open(target, "w") as fh:
            fh.write(text)
        return target

    def read(self, target: str) -> str:
        with open(target) as fh:
            return fh.read()

    def test_direct_handles_of_every_mode_are_skipped_then_purged_after_commit(self):
        target = self.durable("durable.txt")
        closed_target = self.durable("closed.txt")
        closed_writer = open(closed_target, "w")
        closed_writer.close()
        with open(closed_target, "w") as fh:
            fh.write("SURVIVE")
        reader = open(target, "r")
        appender = open(target, "a")
        binary = open(target, "rb")
        for handle in (reader, appender, binary):
            self.addCleanup(handle.close)
        alias = reader
        ns = {"keep": 7, "reader": reader, "appender": appender, "binary": binary, "closed": closed_writer, "alias": alias}
        result = self.snap(ns)
        handles = ["alias", "appender", "binary", "closed", "reader"]
        reason = "unsafe file handle (io.IOBase)"
        self.assertEqual(
            result,
            {
                "saved": ["keep"],
                # Newest data binding first: the namespace's insertion order reversed.
                "skipped": [{"name": name, "reason": reason} for name in ("alias", "closed", "binary", "appender", "reader")],
                "pruned": [],
                "purgedFileHandles": handles,
                "bytes": os.path.getsize(self.path),
            },
        )
        self.assertEqual(ns, {"keep": 7})
        with open(self.manifest) as fh:
            manifest = json.load(fh)
        self.assertEqual(
            (manifest["version"], manifest["savedNames"], manifest["purgedFileHandles"], manifest["pruned"]),
            (2, ["keep"], handles, []),
        )
        # The purge drops bindings; it never closes a handle or touches its file.
        self.assertFalse(reader.closed)
        self.assertEqual(self.read(target), "SURVIVE")

        restored: dict = {}
        self.assertEqual(self.repl._restore_state(restored, self.path), {"restored": ["keep"], "failed": []})
        self.assertEqual(restored, {"keep": 7})
        self.assertEqual(self.read(closed_target), "SURVIVE")

    def test_purge_clears_cached_outputs_of_the_purged_handles(self):
        handle = open(self.durable("cached.txt"), "r")
        self.addCleanup(handle.close)
        other = object()
        ns = {"f": handle, "Out": {1: handle, 2: other}}
        self.snap(ns)
        self.assertEqual(ns, {"Out": {2: other}})

    def test_handles_survive_a_failed_manifest_write(self):
        handle = open(self.durable("kept.txt"), "r")
        self.addCleanup(handle.close)
        ns = {"f": handle, "keep": 1}
        with mock.patch("json.dump", side_effect=OSError("disk full")):
            result = self.snap(ns)
        self.assertEqual(result, {"error": "manifest write failed: disk full"})
        # Purge runs only after the payload and manifest commit.
        self.assertEqual(ns, {"f": handle, "keep": 1})

    def test_nested_file_handle_reducer_is_skipped_but_not_purged(self):
        handle = open(self.durable("nested.txt"), "r")
        self.addCleanup(handle.close)
        nested = {"f": handle}
        ns = {"nested": nested, "keep": 3}
        result = self.snap(ns)
        self.assertEqual(
            result,
            {
                "saved": ["keep"],
                "skipped": [{"name": "nested", "reason": "unsafe dill file-handle reducer"}],
                "pruned": [],
                "purgedFileHandles": [],
                "bytes": os.path.getsize(self.path),
            },
        )
        self.assertEqual(ns, {"nested": nested, "keep": 3})

    def test_custom_class_holding_a_handle_is_skipped(self):
        handle = open(self.durable("custom.txt"), "r")
        self.addCleanup(handle.close)

        class Holder:
            def __init__(self, fh):
                self.fh = fh

        result = self.snap({"holder": Holder(handle)})
        self.assertEqual(result["skipped"], [{"name": "holder", "reason": "unsafe dill file-handle reducer"}])
        self.assertEqual(result["saved"], [])

    def test_legacy_write_handle_reducer_is_rejected_before_dill_loads(self):
        import dill

        target = self.durable("legacy-write.txt")
        writer = open(target, "w")
        writer.write("SURVIVE")
        writer.close()
        blob = dill.dumps(writer)
        self.assertTrue(self.repl._has_filehandle_reducer(blob))
        with open(self.path, "wb") as fh:
            dill.dump({"f": blob, "keep": dill.dumps(9), "bad": 12}, fh)
        ns: dict = {}
        result = self.repl._restore_state(ns, self.path)
        self.assertEqual(
            result,
            {
                "restored": ["keep"],
                "failed": [
                    {"name": "f", "reason": "unsafe legacy dill file-handle reducer rejected"},
                    {"name": "bad", "reason": "corrupt snapshot variable: not bytes"},
                ],
            },
        )
        self.assertEqual(ns, {"keep": 9})
        self.assertEqual(self.read(target), "SURVIVE")

    def test_framed_record_with_a_handle_reducer_is_rejected(self):
        import dill

        target = self.durable("framed-write.txt")
        writer = open(target, "w")
        writer.close()
        with open(target, "w") as fh:
            fh.write("SURVIVE")
        records = {"f": dill.dumps(writer), "keep": dill.dumps("kept")}
        with open(self.path, "wb") as fh:
            fh.write(self.repl._SNAPSHOT_MAGIC)
            for name, blob in records.items():
                encoded = name.encode("utf-8")
                fh.write(len(encoded).to_bytes(4, "little") + encoded + len(blob).to_bytes(8, "little") + blob)
        ns: dict = {}
        result = self.repl._restore_state(ns, self.path)
        self.assertEqual(
            result,
            {"restored": ["keep"], "failed": [{"name": "f", "reason": "unsafe legacy dill file-handle reducer rejected"}]},
        )
        self.assertEqual(ns, {"keep": "kept"})
        self.assertEqual(self.read(target), "SURVIVE")

    def test_reducer_detection_reads_the_pickle_opcodes(self):
        detect = self.repl._has_filehandle_reducer
        module, name = b"dill._dill", b"_create_filehandle"
        # GLOBAL (protocols 0-3) and STACK_GLOBAL (4+) references both count.
        by_global = b"\x80\x02c" + module + b"\n" + name + b"\n)R."
        by_stack_global = (
            b"\x80\x04\x8c" + bytes([len(module)]) + module + b"\x8c" + bytes([len(name)]) + name + b"\x93)R."
        )
        for payload in (by_global, by_stack_global):
            self.assertTrue(detect(payload), payload)
        # A real dill pickle of a file handle, by either reference opcode.
        import dill

        handle = open(self.durable("real.txt"), "r")
        self.addCleanup(handle.close)
        for protocol in (2, 4):
            self.assertTrue(detect(dill.dumps(handle, protocol=protocol)), protocol)
        # The name as plain data is not a reducer.
        self.assertFalse(detect(pickle.dumps(["dill._dill", "_create_filehandle"], protocol=4)))
        self.assertFalse(detect(pickle.dumps("_create_filehandle", protocol=2)))
        self.assertFalse(detect(pickle.dumps({"a": 1})))
        # A suspicious blob that does not disassemble fails closed.
        self.assertTrue(detect(b"\x80\x05_create_filehandle\xff\xff"))

    def test_compaction_keeps_recent_data_and_prunes_all_aggregate_overflow(self):
        import math

        ns = {"math": math, "old": "o" * 5_000, "middle": "m" * 5_000, "new": "n" * 5_000}
        result = self.snap(ns, max_bytes=7_000, max_variable_bytes=6_000, prune_oversized=True)
        self.assertEqual((result["saved"], result["pruned"]), (["math", "new"], ["middle", "old"]))
        self.assertEqual(set(ns), {"math", "new"})
        self.assertLessEqual(result["bytes"], 7_000)

    def test_autosnapshot_skips_aggregate_overflow_without_pruning(self):
        ns = {"old": "o" * 5_000, "new": "n" * 5_000}
        result = self.snap(ns, max_bytes=7_000, max_variable_bytes=6_000)
        self.assertEqual(
            (result["saved"], result["skipped"], result["pruned"]),
            (["new"], [{"name": "old", "reason": "exceeds aggregate snapshot size cap"}], []),
        )
        self.assertEqual(set(ns), {"old", "new"})

    def test_rebinding_keeps_the_original_insertion_position(self):
        ns = {"first": "a" * 5_000, "second": "b" * 5_000}
        ns["first"] = "c" * 5_000
        result = self.snap(ns, max_bytes=7_000, max_variable_bytes=6_000)
        self.assertEqual(result["saved"], ["second"])


class PackedSidecarSnapshotGuardTest(unittest.TestCase):
    """The guard as it ships (the d1ee412fe principle): the runtime staged by
    the release packer's own copy, shipped-content filter included, driven
    through the REPL protocol across two kernels."""

    def test_the_packed_runtime_never_reopens_a_closed_write_handle(self):
        from test_repl import ReplProcess, one

        repo = Path(__file__).resolve().parents[2]
        sys.path.insert(0, str(repo / "scripts"))
        self.addCleanup(sys.path.remove, str(repo / "scripts"))
        import package_release

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        staged = Path(tmp.name) / "prime-agent-runtime"
        package_release.copy_tree(
            repo / "prime-agent-runtime",
            staged,
            extra_excluded_names=package_release.RUNTIME_EXCLUDED_NAMES,
            extra_excluded_suffixes=package_release.RUNTIME_EXCLUDED_SUFFIXES,
        )
        env = {"PYTHONPATH": str(staged / "src")}
        target = os.path.join(tmp.name, "durable.txt")
        snapshot = os.path.join(tmp.name, "kernel-state.dill")
        manifest = os.path.join(tmp.name, "kernel-state.json")

        first = ReplProcess(env)
        self.addCleanup(first.close)
        first.ready()
        events = first.execute("c1", f"handle = open({target!r}, 'w')\nhandle.close()\nkeep = 7")
        self.assertEqual(one(events, "done")["status"], "ok")
        with open(target, "w") as fh:
            fh.write("SURVIVE")
        first.send({"type": "snapshot", "id": "s1", "path": snapshot, "manifest_path": manifest})
        captured = one(first.until_done("s1"), "done")

        second = ReplProcess(env)
        self.addCleanup(second.close)
        second.ready()
        second.send({"type": "restore", "id": "r1", "path": snapshot})
        restored = one(second.until_done("r1"), "done")
        revived = one(second.execute("c2", "('handle' in globals(), keep)"), "result")
        with open(target) as fh:
            survived = fh.read()
        self.assertEqual(
            (
                captured["saved"],
                captured["skipped"],
                captured["purgedFileHandles"],
                restored["restored"],
                revived["text"],
                survived,
            ),
            (["keep"], [{"name": "handle", "reason": "unsafe file handle (io.IOBase)"}], ["handle"], ["keep"], "(False, 7)", "SURVIVE"),
        )



if __name__ == "__main__":
    unittest.main()
