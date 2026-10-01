#!/usr/bin/env python3
"""Side-by-side install of the Oneiron Rust prime-agent beside the TS build.

  install  copy a staged release layout (scripts/package_release.py output) to
           ~/.local/share/prime-agent-oneiron-rs/<version>/, write the
           ~/.local/bin/prime-agent-rs launcher, flip <prefix>/current, and
           write receipts/<version>-<platform>/INSTALL-RECEIPT.json
  probe    run the installed launcher: --version, a sol-shaped one-shot on
           cpa-r (the reply's responseModel must match), optionally a tools run
           that bootstraps the separate kernel venv; writes PROBE-RECEIPT.json

The TS product is never touched: the `prime-agent` launcher, its install tree
(~/.local/share/prime-agent-oneiron/), its daemon socket dir and its kernel
venv. The launcher gives every Rust process its own socket dir
(PRIME_AGENT_SOCKET_DIR, a fork-only knob read by pa-daemon's socket_dir()),
its own supervisor socket (PRIME_AGENT_DAEMON_SOCKET) and its own kernel venv
(PRIME_AGENT_KERNEL_VENV). Self-update is shut three ways: the fork-only
PRIME_AGENT_DISABLE_SELF_UPDATE guard refuses `update` and the TUI `/update`
(both would otherwise fetch and run upstream's takeover installer), the
installer and download URLs point at a dead loopback endpoint, and
PI_SKIP_VERSION_CHECK silences release notices. Never run upstream
install-rust.sh instead: it stops every TS daemon and replaces
~/.local/bin/prime-agent.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
HOME = Path.home()
DEFAULT_PREFIX = HOME / ".local" / "share" / "prime-agent-oneiron-rs"
DEFAULT_BIN_DIR = HOME / ".local" / "bin"
TS_PREFIX = HOME / ".local" / "share" / "prime-agent-oneiron"
LAUNCHER_NAME = "prime-agent-rs"
TS_LAUNCHER_NAME = "prime-agent"
RECEIPT_SCHEMA = "prime-agent-oneiron-rs.install/1"
PROBE_SCHEMA = "prime-agent-oneiron-rs.probe/1"
REQUIRED_STAGE_PATHS = ("prime-agent", "package.json", "prime-agent-runtime/src/rlm", "skills")

# POSIX sh, so the same launcher runs under dash (Arch) and bash 3.2 (macOS).
# The socket dir name stays short: macOS sun_path holds 104 bytes and $TMPDIR
# there is ~49, so `prime-agent-rs-<uid>/worker-<12>-<12>.sock` would overflow
# where `pa-rs-<uid>/…` fits. RS-specific overrides only; the generic names
# are always rewritten so an inherited TS value can never leak in.
LAUNCHER_TEMPLATE = """#!/bin/sh
# prime-agent-rs: the side-by-side Rust prime-agent (Oneiron fork).
# Written by scripts/oneiron/side_by_side.py install; reinstall instead of editing.
# Own socket dir + socket, own kernel venv, self-update shut. The TS
# `prime-agent` launcher, its daemons and its kernel venv are never touched.
set -e
prefix={prefix}
uid=$(id -u)
tmp=${{TMPDIR:-/tmp}}
sock_dir=${{PRIME_AGENT_RS_SOCKET_DIR:-${{tmp%/}}/pa-rs-$uid}}
if [ ! -e "$sock_dir" ]; then (umask 077 && mkdir -p "$sock_dir"); fi
if [ -L "$sock_dir" ] || [ ! -d "$sock_dir" ] || [ ! -O "$sock_dir" ]; then
  echo "prime-agent-rs: refusing socket dir $sock_dir (not a directory owned by uid $uid)" >&2
  exit 1
fi
chmod 700 "$sock_dir"
PRIME_AGENT_SOCKET_DIR=$sock_dir
PRIME_AGENT_DAEMON_SOCKET=$sock_dir/daemon.sock
PRIME_AGENT_KERNEL_VENV=${{PRIME_AGENT_RS_KERNEL_VENV:-$HOME/.prime/agent/kernel-venv-rs}}
PRIME_AGENT_DISABLE_SELF_UPDATE=1
PRIME_AGENT_RUST_INSTALLER_URL=http://127.0.0.1:1/oneiron-self-update-disabled
PRIME_AGENT_DOWNLOAD_BASE_URL=http://127.0.0.1:1/oneiron-feed-disabled
PI_SKIP_VERSION_CHECK=1
export PRIME_AGENT_SOCKET_DIR PRIME_AGENT_DAEMON_SOCKET PRIME_AGENT_KERNEL_VENV PRIME_AGENT_DISABLE_SELF_UPDATE \\
  PRIME_AGENT_RUST_INSTALLER_URL PRIME_AGENT_DOWNLOAD_BASE_URL PI_SKIP_VERSION_CHECK
unset PI_PACKAGE_DIR PRIME_AGENT_KERNEL_PYTHON
dir=$(cd "$prefix/current" && pwd -P)
exec "$dir/prime-agent" "$@"
"""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def link_state(path: Path) -> dict:
    """What a path is right now, without following it (the TS launcher proof)."""
    if path.is_symlink():
        return {"kind": "symlink", "target": os.readlink(path)}
    if path.exists():
        return {"kind": "file", "sha256": sha256_file(path)}
    return {"kind": "absent"}


def git_facts(root: Path) -> dict:
    def run(*args: str) -> str | None:
        try:
            return subprocess.run(["git", "-C", str(root), *args], check=True,
                                  capture_output=True, text=True).stdout.strip() or None
        except (OSError, subprocess.CalledProcessError):
            return None

    base = None
    rust_base = root / "RUST-BASE.md"
    if rust_base.is_file():
        for line in rust_base.read_text().splitlines():
            if line.startswith("- Base commit:"):
                base = line.split("`")[1] if "`" in line else line.split(":", 1)[1].strip()
                break
    return {"head": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(run("status", "--porcelain")), "rustBase": base}


def check_prefix(prefix: Path, bin_dir: Path) -> None:
    resolved = prefix.resolve()
    ts = TS_PREFIX.resolve()
    if resolved == ts or is_within(resolved, ts) or is_within(ts, resolved):
        raise SystemExit(f"error: prefix {prefix} overlaps the TS install tree {TS_PREFIX}")
    if (bin_dir / LAUNCHER_NAME).resolve() == (bin_dir / TS_LAUNCHER_NAME).resolve():
        raise SystemExit("error: the prime-agent-rs launcher would alias the TS prime-agent launcher")


def read_stage(stage_dir: Path) -> tuple[str, str]:
    for rel in REQUIRED_STAGE_PATHS:
        if not (stage_dir / rel).exists():
            raise SystemExit(f"error: staged layout {stage_dir} lacks {rel}")
    if not os.access(stage_dir / "prime-agent", os.X_OK):
        raise SystemExit(f"error: {stage_dir / 'prime-agent'} is not executable")
    version = json.loads((stage_dir / "package.json").read_text()).get("version", "").strip()
    if not version:
        raise SystemExit(f"error: {stage_dir / 'package.json'} has no version")
    prefix = f"prime-agent-{version}-"
    platform = stage_dir.name[len(prefix):] if stage_dir.name.startswith(prefix) else None
    if not platform:
        raise SystemExit(f"error: staged dir name {stage_dir.name} is not prime-agent-{version}-<platform>")
    return version, platform


def extract_tarball(tarball: Path, into: Path) -> Path:
    with tarfile.open(tarball) as archive:
        try:
            archive.extractall(into, filter="data")
        except TypeError:
            # Python without the extraction-filter backport (stock macOS 3.9):
            # the release tarball holds only files and dirs, so refuse anything
            # else and any member that would land outside the scratch dir.
            root = into.resolve()
            for member in archive.getmembers():
                if not (member.isfile() or member.isdir()) or not is_within(
                        (root / member.name).resolve(), root):
                    raise SystemExit(f"error: unsafe tarball member {member.name!r} in {tarball}")
            archive.extractall(into)
    stage = into / tarball.name.removesuffix(".tar.gz")
    stage.mkdir(exist_ok=True)
    for entry in list(into.iterdir()):
        if entry != stage:
            entry.rename(stage / entry.name)
    return stage


def write_launcher(bin_dir: Path, prefix: Path) -> Path:
    bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / LAUNCHER_NAME
    temp = bin_dir / f".{LAUNCHER_NAME}.tmp-{os.getpid()}"
    temp.write_text(LAUNCHER_TEMPLATE.format(prefix=shlex.quote(str(prefix))))
    temp.chmod(0o755)
    os.replace(temp, launcher)
    return launcher


def flip_current(prefix: Path, version: str) -> str | None:
    current = prefix / "current"
    before = os.readlink(current) if current.is_symlink() else None
    temp = prefix / f".current.tmp-{os.getpid()}"
    if temp.is_symlink() or temp.exists():
        temp.unlink()
    temp.symlink_to(version)
    os.replace(temp, current)
    return before


def stamp_manifest(package_json: Path, version: str) -> None:
    """Pin the exe-adjacent manifest version (the binary reports it over the
    compiled-in one, as upstream's commit-stamped continuous builds do)."""
    manifest = json.loads(package_json.read_text())
    manifest["version"] = version
    package_json.write_text(json.dumps(manifest, indent=2) + "\n")


def install(args: argparse.Namespace) -> int:
    prefix = args.prefix.expanduser()
    bin_dir = args.bin_dir.expanduser()
    check_prefix(prefix, bin_dir)
    ts_launcher = bin_dir / TS_LAUNCHER_NAME
    ts_before = link_state(ts_launcher)

    with tempfile.TemporaryDirectory(prefix="pa-rs-install-") as scratch:
        stage = extract_tarball(args.tarball, Path(scratch)) if args.tarball else args.stage_dir
        staged_version, platform = read_stage(stage)
        version = args.version or staged_version
        if version != staged_version and not version.startswith(f"{staged_version}-"):
            raise SystemExit(f"error: --version {version} must extend the staged version {staged_version} "
                             f"(e.g. {staged_version}-oneiron.YYYYMMDD.N)")
        target = prefix / version
        if target.exists():
            raise SystemExit(f"error: {target} already exists; installs are immutable, bump the build number")
        prefix.mkdir(parents=True, exist_ok=True)
        temp_target = prefix / f".{version}.tmp-{os.getpid()}"
        if temp_target.exists():
            shutil.rmtree(temp_target)
        shutil.copytree(stage, temp_target, symlinks=True)
        if version != staged_version:
            stamp_manifest(temp_target / "package.json", version)
        os.rename(temp_target, target)

    current_before = None
    launcher = bin_dir / LAUNCHER_NAME
    if args.activate:
        current_before = flip_current(prefix, version)
        launcher = write_launcher(bin_dir, prefix)

    ts_after = link_state(ts_launcher)
    if ts_after != ts_before:
        raise SystemExit(f"error: {ts_launcher} changed during the install ({ts_before} -> {ts_after})")

    version_check = None
    if args.activate:
        result = subprocess.run([str(launcher), "--version"], capture_output=True, text=True)
        version_check = {"stdout": result.stdout.strip(), "exitCode": result.returncode,
                         "ok": result.returncode == 0 and result.stdout.strip() == version}

    receipt_dir = prefix / "receipts" / f"{version}-{platform}"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "version": version,
        "stagedVersion": staged_version,
        "platform": platform,
        "installedAt": utc_now(),
        "host": socket.gethostname(),
        "source": git_facts(ROOT),
        "installDir": str(target),
        "binary": {"sha256": sha256_file(target / "prime-agent"),
                   "bytes": (target / "prime-agent").stat().st_size},
        "tarball": ({"path": str(args.tarball), "sha256": sha256_file(args.tarball)}
                    if args.tarball else None),
        "activated": args.activate,
        "current": {"before": current_before, "after": version if args.activate else current_before},
        "launcher": ({"path": str(launcher), "sha256": sha256_file(launcher)} if args.activate else None),
        "tsLauncher": {"path": str(ts_launcher), "before": ts_before, "after": ts_after,
                       "unchanged": True},
        "versionCheck": version_check,
    }
    (receipt_dir / "INSTALL-RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"installed {version} ({platform}) at {target}")
    print(f"receipt {receipt_dir / 'INSTALL-RECEIPT.json'}")
    if version_check and not version_check["ok"]:
        print(f"error: {launcher} --version printed {version_check['stdout']!r}", file=sys.stderr)
        return 1
    return 0


def response_models(stdout: str) -> list[str]:
    """Every responseModel value in a JSON-lines event stream, in order."""
    found: list[str] = []

    def walk(value: object) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "responseModel" and isinstance(item, str):
                    found.append(item)
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            walk(json.loads(line))
        except json.JSONDecodeError:
            continue
    return found


def dir_listing(path: Path) -> list[str] | None:
    return sorted(entry.name for entry in path.iterdir()) if path.is_dir() else None


def timed(command: list[str], cwd: Path) -> dict:
    started = time.monotonic()
    result = subprocess.run(command, capture_output=True, text=True, cwd=cwd)
    return {"command": command, "exitCode": result.returncode,
            "seconds": round(time.monotonic() - started, 3),
            "stdout": result.stdout, "stderr": result.stderr[-4000:]}


def one_shot(launcher: Path, args: argparse.Namespace, cwd: Path, tools: bool, brief: str) -> dict:
    command = [str(launcher), "-p", "--mode", "json", "--provider", args.provider,
               "--model", args.model, "--thinking", args.thinking, "--cwd", str(cwd),
               "--no-session", "--no-skills", "--no-extensions", "--no-prompt-templates",
               "--no-themes"]
    if not tools:
        command.append("--no-tools")
    command += ["--", brief]
    run = timed(command, cwd)
    models = response_models(run["stdout"])
    expected = args.model.split("/", 1)[-1]
    run["responseModels"] = models
    run["ok"] = run["exitCode"] == 0 and bool(models) and all(model == expected for model in models)
    run["stdoutLines"] = len(run["stdout"].splitlines())
    return run


def probe(args: argparse.Namespace) -> int:
    prefix = args.prefix.expanduser()
    launcher = args.bin_dir.expanduser() / LAUNCHER_NAME
    current = prefix / "current"
    if not current.is_symlink():
        raise SystemExit(f"error: {current} is not an installed release")
    version = json.loads((current / "package.json").read_text())["version"]
    platform = next((name.split(f"{version}-", 1)[1] for name in os.listdir(prefix / "receipts")
                     if name.startswith(f"{version}-")), "unknown")
    tmp = Path(os.environ.get("TMPDIR", "/tmp"))
    uid = os.getuid()
    ts_socket_dir = tmp / f"prime-agent-{uid}"
    rs_socket_dir = tmp / f"pa-rs-{uid}"
    ts_venv = HOME / ".prime" / "agent" / "kernel-venv"
    rs_venv = HOME / ".prime" / "agent" / "kernel-venv-rs"
    ts_venv_mtime = ts_venv.stat().st_mtime if ts_venv.exists() else None

    with tempfile.TemporaryDirectory(prefix="pa-rs-probe-") as scratch:
        cwd = Path(scratch)
        version_run = timed([str(launcher), "--version"], cwd)
        version_run["ok"] = version_run["exitCode"] == 0 and version_run["stdout"].strip() == version
        runs = {"version": version_run,
                "oneShot": one_shot(launcher, args, cwd, tools=False,
                                    brief="Reply with exactly the word pong and nothing else.")}
        if args.tools:
            runs["toolsRun"] = one_shot(
                launcher, args, cwd, tools=True,
                brief="Use the ipython tool to evaluate 6*7, then reply with only the number.")

    receipt = {
        "schema": PROBE_SCHEMA,
        "version": version,
        "platform": platform,
        "probedAt": utc_now(),
        "host": socket.gethostname(),
        "launcher": str(launcher),
        "provider": args.provider,
        "model": args.model,
        "runs": runs,
        "isolation": {
            "rsSocketDir": {"path": str(rs_socket_dir), "entries": dir_listing(rs_socket_dir)},
            "tsSocketDir": {"path": str(ts_socket_dir), "entries": dir_listing(ts_socket_dir)},
            "rsKernelVenv": {"path": str(rs_venv), "exists": rs_venv.exists()},
            "tsKernelVenv": {"path": str(ts_venv), "mtimeUnchanged":
                             (ts_venv.stat().st_mtime if ts_venv.exists() else None) == ts_venv_mtime},
            "tsLauncher": link_state(args.bin_dir.expanduser() / TS_LAUNCHER_NAME),
        },
    }
    receipt["ok"] = all(run["ok"] for run in runs.values())
    receipt_dir = prefix / "receipts" / f"{version}-{platform}"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    # The full event stream rides beside the receipt; the receipt keeps a tail.
    for name, run in runs.items():
        (receipt_dir / f"probe-{name}.out").write_text(run["stdout"])
        run["stdoutFile"] = str(receipt_dir / f"probe-{name}.out")
        run["stdout"] = run["stdout"][-4000:]
    (receipt_dir / "PROBE-RECEIPT.json").write_text(json.dumps(receipt, indent=2) + "\n")
    for name, run in runs.items():
        models = run.get("responseModels")
        detail = f" responseModel={models[-1]}" if models else ""
        print(f"{name}: {'ok' if run['ok'] else 'FAIL'} ({run['seconds']}s){detail}")
    print(f"receipt {receipt_dir / 'PROBE-RECEIPT.json'}")
    return 0 if receipt["ok"] else 1


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    parser.add_argument("--bin-dir", type=Path, default=DEFAULT_BIN_DIR)
    commands = parser.add_subparsers(dest="command", required=True)

    install_cmd = commands.add_parser("install", help="install a staged release side by side")
    source = install_cmd.add_mutually_exclusive_group(required=True)
    source.add_argument("--stage-dir", type=Path, help="scripts/package_release.py staged layout dir")
    source.add_argument("--tarball", type=Path, help="prime-agent-<version>-<platform>.tar.gz")
    install_cmd.add_argument("--version", help="stamp this version into the installed package.json "
                             "(must extend the staged version, e.g. 0.9.8-oneiron.20261001.1)")
    install_cmd.add_argument("--no-activate", dest="activate", action="store_false",
                             help="copy the release without flipping current or writing the launcher")

    probe_cmd = commands.add_parser("probe", help="probe the installed launcher")
    probe_cmd.add_argument("--provider", default="cpa-r")
    probe_cmd.add_argument("--model", default="gpt-6.1-sol")
    probe_cmd.add_argument("--thinking", default="low")
    probe_cmd.add_argument("--tools", action="store_true",
                           help="also run a tools turn (bootstraps the separate kernel venv)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    return install(args) if args.command == "install" else probe(args)


if __name__ == "__main__":
    sys.exit(main())
