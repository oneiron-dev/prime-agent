#!/usr/bin/env python3
"""Reject a native single-PR push unless Git advertises the sealed old ref.

This hook never pushes. The native CLI's explicit force-with-lease protects the
race after this check. Its earlier tracking-ref refresh cannot widen this grant.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def validate(guard, remote, url, lines):
    branch = guard["branch"]
    if branch in ("HEAD", "main", "master", *guard.get("protectedBranches", [])) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./-]*", branch):
        raise ValueError("Unapproved publication branch")
    if any(part in ("", ".", "..") for part in branch.split("/")):
        raise ValueError("Invalid publication branch")
    old = guard["expectedRemoteHead"]
    head = guard["candidateHead"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", sha) and sha != "0" * 40 for sha in (old, head)):
        raise ValueError("Creation/deletion or invalid commit is forbidden")
    if old == head:
        raise ValueError("No changed commit to publish")
    ref = "refs/heads/" + branch
    expected = [ref, head, ref, old]
    if remote != guard["remote"] or url != guard["remoteUrl"] or len(lines) != 1 or lines[0].split() != expected:
        raise ValueError("Native push remote/ref/candidate/advertised old-head mismatch")


def main():
    raw = Path(os.environ["ONEIRON_PUSH_GUARD"]).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != os.environ["ONEIRON_PUSH_GUARD_SHA256"]:
        raise ValueError("Publication guard identity changed")
    guard = json.loads(raw)
    if guard["version"] != 1 or Path(guard["ownerPauseFile"]).exists():
        raise ValueError("Owner pause blocks publication")
    validate(guard, sys.argv[1], sys.argv[2], sys.stdin.read().splitlines())
    # Recheck the local journal too, after native fetch and immediately before push.
    cli = guard["factoryCli"]
    if not isinstance(cli, list) or len(cli) != 2 or not all(isinstance(path, str) and os.path.isabs(path) for path in cli):
        raise ValueError("Publication requires the pinned factory CLI")
    environment = guard["factoryEnvironment"]
    if not isinstance(environment, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in environment.items()):
        raise ValueError("Publication factory environment is invalid")
    state = json.loads(subprocess.run([*cli, "factory", "status", guard["factoryDirectory"]], env={**os.environ, **environment}, check=True, capture_output=True, text=True, timeout=10).stdout)
    if state.get("paused") is not False or state.get("ownerPaused") is not False or Path(guard["ownerPauseFile"]).exists():
        raise ValueError("Factory pause blocks publication")
    with open(guard["receipt"], "x", encoding="utf8") as output:
        json.dump({"version": 1, "passed": True, "guardSha256": digest, "candidateHead": guard["candidateHead"], "expectedRemoteHead": guard["expectedRemoteHead"]}, output)
        output.flush()
        os.fsync(output.fileno())


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
