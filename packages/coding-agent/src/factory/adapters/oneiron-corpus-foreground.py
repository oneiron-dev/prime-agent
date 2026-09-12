#!/usr/bin/env python3
"""Run the hash-pinned legacy collector with inherited-group GH transport only.

Collection, pagination, normalization and original receipt formats remain legacy
code. Never edit or globally monkeypatch subprocess. The factory runner owns the
process group and applies group TERM/KILL on timeout or loss of custody.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def load_collector(path: Path, expected: str):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Legacy collector hash changed")
    spec = importlib.util.spec_from_file_location("oneiron_legacy_collector", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load legacy collector")
    module = importlib.util.module_from_spec(spec)
    # Compile the verified bytes, rather than reopening a mutable path.
    module.__file__ = str(path)
    exec(compile(data, str(path), "exec"), module.__dict__)
    return module


def foreground_class(legacy):
    class ForegroundGH(legacy.GH):
        def run(self, argv, input_obj=None):
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise legacy.FetchError("absolute deadline expired")
            env = dict(os.environ, NO_COLOR="1", CLICOLOR="0", GH_FORCE_TTY="0", GH_PAGER="cat")
            started = time.monotonic()
            child = subprocess.Popen(
                argv, stdin=subprocess.PIPE if input_obj is not None else subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                start_new_session=False, close_fds=True,
            )
            try:
                out, err = child.communicate(
                    legacy.canonical(input_obj) if input_obj is not None else None, timeout=remaining,
                )
            except subprocess.TimeoutExpired:
                child.terminate()
                try:
                    child.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
                raise legacy.FetchError(f"deadline timeout: {argv[:4]}") from None
            self.calls.append({
                "argv": argv, "rc": child.returncode, "seconds": round(time.monotonic() - started, 3),
                "stdout_sha256": legacy.sha_bytes(out), "stderr_sha256": legacy.sha_bytes(err),
            })
            if child.returncode:
                raise legacy.FetchError(f"gh rc={child.returncode}: {err[-2000:].decode(errors='replace')}")
            try:
                return json.loads(out)
            except (ValueError, UnicodeDecodeError) as exc:
                raise legacy.FetchError("non-JSON gh output") from exc
    return ForegroundGH


def main(argv):
    if len(argv) < 3:
        raise ValueError("Expected legacy-helper.py SHA256 followed by collector options")
    helper = Path(argv[0]).resolve(strict=True)
    legacy = load_collector(helper, argv[1])
    legacy.GH = foreground_class(legacy)
    rc = legacy.main(argv[2:])
    if rc == 0:
        output = Path(argv[argv.index("--output-dir") + 1])
        # The legacy receipt truthfully retains script_sha256 for the original helper.
        legacy.write_x(output / "foreground-adapter-receipt.json", legacy.canonical({
            "schema": "oneiron.factory.foreground-corpus.v1", "helper": str(helper),
            "helper_sha256": argv[1], "shim_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "adaptation": "GH.run only; inherited process group; no detached descendants",
            "corpus_sha256": hashlib.sha256((output / "corpus.json").read_bytes()).hexdigest(),
            "process_group": os.getpgrp(), "read_only": True,
        }))
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
