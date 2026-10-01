#!/usr/bin/env python3
"""Fork test-policy gate: scripts/check-test-policy.mjs against oneiron/main, minus the pin's baseline.

The check compares changed test files with TEST_POLICY_BASE (default here:
oneiron/main, the TS fork). Upstream's Rust main carries Python runtime tests
written after our fork point, so at the pinned base the check already reports
violations that are upstream's, not ours. They are recorded in
test-policy-baseline.txt (keyed without line numbers, so edits elsewhere in a
file do not churn the key); this gate fails only on violations beyond it.
Re-pinning the Rust base re-records it: --write-baseline.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BASELINE = Path(__file__).with_name("test-policy-baseline.txt")
VIOLATION = re.compile(r"^(?P<path>\S+?):(?P<line>\d+) (?P<rest>\[[a-z-]+\] .*)$")


def violation_keys(output: str) -> list[str]:
    keys = []
    for line in output.splitlines():
        match = VIOLATION.match(line.strip())
        if match:
            keys.append(f"{match['path']} {match['rest']}")
    return keys


def read_baseline() -> Counter:
    if not BASELINE.is_file():
        return Counter()
    lines = (line.strip() for line in BASELINE.read_text().splitlines())
    return Counter(line for line in lines if line and not line.startswith("#"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write-baseline", action="store_true",
                        help="record the current violations as the baseline (re-pin only)")
    args = parser.parse_args(argv)
    base = os.environ.get("TEST_POLICY_BASE", "oneiron/main")
    # check-test-policy.mjs silently falls back to another base when this one
    # does not resolve; refuse instead, and name the exact commit checked.
    resolved = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"],
                              capture_output=True, text=True)
    if resolved.returncode != 0 or not resolved.stdout.strip():
        print(f"error: TEST_POLICY_BASE {base} does not resolve to a commit here "
              f"(add the fork remote: git remote add oneiron git@github.com:oneiron-dev/prime-agent.git; "
              f"git fetch oneiron)", file=sys.stderr)
        return 1
    base_sha = resolved.stdout.strip()
    # The checker gets the resolved commit, not the ref: a ref that moves
    # mid-run must not make the reported sha differ from the one checked.
    result = subprocess.run(["node", str(ROOT / "scripts" / "check-test-policy.mjs")], cwd=ROOT,
                            env={**os.environ, "TEST_POLICY_BASE": base_sha},
                            capture_output=True, text=True)
    output = result.stdout + result.stderr
    found = Counter(violation_keys(output))
    if result.returncode != 0 and not found:
        sys.stderr.write(output)
        print(f"error: check-test-policy.mjs failed without parseable violations (exit {result.returncode})",
              file=sys.stderr)
        return 1
    if args.write_baseline:
        header = f"# check-test-policy.mjs violations at the pinned Rust base (TEST_POLICY_BASE={base} = {base_sha}).\n"
        BASELINE.write_text(header + "".join(f"{key}\n" for key in sorted(found.elements())))
        print(f"recorded {sum(found.values())} baseline violations in {BASELINE.name}")
        return 0
    new = found - read_baseline()
    if new:
        print(f"New test-policy violations against {base} ({base_sha[:12]}) beyond the pin baseline:", file=sys.stderr)
        for key in sorted(new.elements()):
            print(f"  {key}", file=sys.stderr)
        return 1
    print(f"Test policy gate passed against {base} ({base_sha[:12]}): 0 new violations "
          f"({sum(found.values())} pinned upstream baseline).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
