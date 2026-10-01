#!/usr/bin/env python3
"""Capture real Rust `prime-agent -p --mode json` streams and session files for the factory parser fixtures.

Sandboxed: HOME and TMPDIR are fresh temporary directories, the environment is rebuilt from scratch
(no PRIME_AGENT_* or PI_* variable leaks in), and the scripted faux provider answers (PRIME_AGENT_FAUX_SCRIPT), so
no daemon, no real agent dir and no provider is touched. The argv is the factory's native seat argv without
`--json-event-profile`, which this base of the agent does not accept yet: the captures are the `all` profile, and the
tests derive the `factory-completed` stream from them by dropping `message_update` and `tool_execution_update`.

    python3 scripts/capture-rust-jsonl.py <path to prime-agent> test/fixtures/rust-jsonl
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

if len(sys.argv) != 3:
    sys.exit("usage: capture-rust-jsonl.py <prime-agent binary> <output dir>")
BIN = sys.argv[1]
ROOT = pathlib.Path(tempfile.mkdtemp(prefix="factory-capture-"))
OUT = pathlib.Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

home, tmp, work = ROOT / "h", ROOT / "t", ROOT / "w"
for path in (home, tmp, work):
    path.mkdir(parents=True)
git_env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
           "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid", "GIT_CONFIG_NOSYSTEM": "1"}
subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True, env=git_env)
(work / "README.md").write_text("capture\n")
subprocess.run(["git", "-C", str(work), "add", "README.md"], check=True, env=git_env)
subprocess.run(["git", "-C", str(work), "commit", "-qm", "initial"], check=True, env=git_env)

CASES = {
    # A writer turn that ends with the exact completion line.
    "writer-done": {"responses": ["Implemented the change.\nPR BODY:\nAdded the function.\nDONE capture-one"]},
    # A reviewer that runs a tool, then answers with its verdict; thinking rides the final message.
    "review-tool-then-verdict": {"responses": [
        {"content": [{"type": "thinking", "thinking": "Read the diff first."},
                     {"type": "toolCall", "id": "call-1", "name": "bash", "arguments": {"command": "echo factory-capture"}}]},
        {"content": [{"type": "thinking", "thinking": "The diff is fine."},
                     {"type": "text", "text": "Checked every hunk.\nVERDICT: LANDABLE"}]},
    ]},
    # A provider error: JSON mode still streams agent_end, and no final may be accepted.
    "provider-error": {"responses": [{"text": "partial", "stopReason": "error", "errorMessage": "upstream unavailable"}]},
    # A reply cut off at the length limit is not a terminal reply either.
    "length-cutoff": {"responses": [{"text": "DONE capture-one", "stopReason": "length"}]},
}

for name, script in CASES.items():
    session_dir = ROOT / "sessions" / name
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(tmp), "TZ": "UTC", "LANG": "C.UTF-8",
           "PRIME_AGENT_FAUX_SCRIPT": json.dumps(script)}
    argv = [BIN, "-p", "--mode", "json", "--offline", "--provider", "faux", "--model", "faux-1", "--thinking", "low",
            "--cwd", str(work), "--no-extensions", "--no-skills", "--session-dir", str(session_dir),
            "--append-system-prompt", "You are the capture seat."]
    result = subprocess.run(argv, input="Review this diff for ticket capture-one.\n", env=env, cwd=str(work),
                            capture_output=True, text=True, timeout=120)
    print(f"{name}: rc={result.returncode} stdout={len(result.stdout)}B stderr={result.stderr.strip()[:300]!r}")
    (OUT / f"{name}.stdout.jsonl").write_text(result.stdout)
    sessions = sorted(session_dir.glob("*.jsonl")) if session_dir.exists() else []
    if sessions:
        (OUT / f"{name}.session.jsonl").write_text(sessions[0].read_text())
    (OUT / f"{name}.exit").write_text(f"{result.returncode}\n")
shutil.rmtree(ROOT)
