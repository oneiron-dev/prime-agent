#!/usr/bin/env python3
"""Side-by-side install of the Oneiron Rust prime-agent beside the TS build.

  install   copy a staged release layout (scripts/package_release.py output) to
            ~/.local/share/prime-agent-oneiron-rs/<version>/, write the
            ~/.local/bin/prime-agent-rs launcher, flip <prefix>/current, and
            write receipts/<version>-<platform>/INSTALL-RECEIPT.json
  probe     run the installed launcher: --version, a sol-shaped one-shot on
            cpa-r (the reply's responseModel must match), optionally a tools run
            that bootstraps the separate kernel venv; writes PROBE-RECEIPT.json
  package   stamp a package_release.py layout into a feed release
            (release_feed.py): feed/releases/v<version>/ with the tarball,
            SHA256SUMS and manifest.json, plus feed-level latest.json/stable
  rollout   install a feed release after verifying its sums, probe it before
            selecting it, then flip current; idle Rust daemon only; writes
            ACTIVATION-RECEIPT.json (rollout.py)
  rollback  select the previous (or a named) installed version again; writes
            ROLLBACK-RECEIPT.json (rollout.py)
  status    installed versions, current/previous, launcher, receipts, feed

The TS product is never touched: the `prime-agent` launcher, its install tree
(~/.local/share/prime-agent-oneiron/), its daemon socket dirs, its agent dir
and its kernel venv (PROTECTED_STATE, one policy for the installer and the
launcher). The launcher gives every Rust process its own agent dir
(PRIME_AGENT_CODING_AGENT_DIR), socket dir (PRIME_AGENT_SOCKET_DIR, a
fork-only knob read by pa-daemon's socket_dir()), supervisor socket
(PRIME_AGENT_DAEMON_SOCKET), kernel venv (PRIME_AGENT_KERNEL_VENV) and
bytecode cache (PYTHONPYCACHEPREFIX, inside the agent dir, so imports never
write into an immutable install); the installer seeds the agent dir with its
own skills (hub categories rendered for it, the rest a snapshot of the TS
skills).
Self-update is shut three ways: the fork-only
PRIME_AGENT_DISABLE_SELF_UPDATE guard refuses `update` and the TUI `/update`
(both would otherwise fetch and run upstream's takeover installer), the
installer and download URLs point at a dead loopback endpoint, and
PI_SKIP_VERSION_CHECK silences release notices. Never run upstream
install-rust.sh instead: it stops every TS daemon and replaces
~/.local/bin/prime-agent.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import datetime as dt
import fcntl
import fnmatch
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import BinaryIO, Iterator

ROOT = Path(__file__).resolve().parent.parent.parent
HOME = Path.home()
SYSTEM_TMP = Path("/tmp")
TS_AGENT_DIR = HOME / ".prime" / "agent"
# The TS product's state. No side-by-side destination (prefix, receipts, bin
# dir, agent dir, socket dir, kernel venv) may equal, sit inside or contain
# one, in the installer and the launcher alike: the launcher's list is
# rendered from this one. Bases: tmp = TMPDIR and /tmp (the TS daemon's
# os.tmpdir()), home = HOME, data = XDG_DATA_HOME and ~/.local/share.
PROTECTED_STATE = (
    ("tmp", "prime-agent-{uid}"),                  # TS daemon sockets
    ("tmp", "prime-agent-user"),                   # TS shared sockets
    ("home", ".prime/agent"),                      # TS agent dir
    ("data", "prime/agent"),                       # TS agent dir, XDG layout
    ("home", ".local/share/prime-agent-oneiron"),  # TS install tree
)
# Read-only inputs the Rust agent dir links to (no Rust writer: audit item 24).
SHARED_LINKS = ("models.json",)
# Build output and caches a skills snapshot leaves behind.
SKILLS_SNAPSHOT_SKIP = ("__pycache__", "*.egg-info", ".venv", "node_modules", ".pytest_cache")
# The hub categories' deploy lock (prime-skill-hubs scripts/render-host.py)
# at the top of a skills dir, and a hub name it may list.
HUB_LOCK = "LOCK.host.json"
HUB_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# Git env that would point the hubs clone at another repository.
GIT_LOCATION_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY")
LAUNCHER_NAME = "prime-agent-rs"
TS_LAUNCHER_NAME = "prime-agent"
RECEIPT_SCHEMA = "prime-agent-oneiron-rs.install/1"
PROBE_SCHEMA = "prime-agent-oneiron-rs.probe/1"
REQUIRED_STAGE_PATHS = ("prime-agent", "package.json", "prime-agent-runtime/src/rlm", "skills")

# POSIX sh, so the same launcher runs under dash (Arch) and bash 3.2 (macOS).
# The socket dir name stays short: macOS sun_path holds 104 bytes and $TMPDIR
# there is ~49, so `prime-agent-rs-<uid>/worker-<12>-<12>.sock` would overflow
# where `pa-rs-<uid>/…` fits. RS-specific overrides only; the generic names
# are always rewritten so an inherited TS value can never leak in. The
# checks mirror the installer's (checked_path, canonical, refuse_ts_state,
# check_agent_tree) and all run BEFORE anything is created.
LAUNCHER_TEMPLATE = """#!/bin/sh
# prime-agent-rs: the side-by-side Rust prime-agent (Oneiron fork).
# Written by scripts/oneiron/side_by_side.py install; reinstall instead of editing.
# Own agent dir, socket dir + socket and kernel venv; self-update shut. The
# TS `prime-agent` launcher, its daemons and its state are never touched.
set -e
prefix={prefix}
system_tmp={system_tmp}
uid=$(id -u)
die() {{ echo "prime-agent-rs: $*" >&2; exit 1; }}
# checked NAME P: P without trailing slashes. It must be absolute with no
# empty, . or .. component: a `..` past a missing dir would slip by canon
# and the overlap checks, then mkdir -p would resolve it into TS state.
checked() {{
  p=$2
  while [ "$p" != / ] && [ "${{p%/}}" != "$p" ]; do p=${{p%/}}; done
  case "$p" in /*) ;; *) die "$1 must be an absolute path: $2" ;; esac
  case "$p/" in //) ;; *//*|*/./*|*/../*) die "$1 must not hold empty, . or .. components: $2" ;; esac
  printf '%s\\n' "$p"
}}
# canon P: the physical spelling of absolute P (its deepest existing ancestor
# resolved with cd -P, the missing tail appended), so symlinked ancestors and
# aliases compare equal. A link to a missing dir is refused, not guessed at.
canon() {{
  p=$1 rest=
  while [ ! -d "$p" ]; do
    if [ -L "$p" ]; then die "$p is a link but not to a dir"; fi
    rest="/${{p##*/}}$rest"; p=${{p%/*}}; [ -n "$p" ] || p=/
  done
  p=$(cd -P "$p" && pwd)
  case "$p$rest" in /) echo / ;; *) printf '%s%s\\n' "${{p%/}}" "$rest" ;; esac
}}
# overlaps A B: A equals B, sits inside B, or contains B.
overlaps() {{
  case "$1/" in "${{2%/}}"/*) return 0 ;; esac
  case "$2/" in "${{1%/}}"/*) return 0 ;; esac
  return 1
}}
# refuse_ts_state ROLE P: the one protected set (side_by_side.PROTECTED_STATE)
# for every path the launcher creates or hands the binary.
refuse_ts_state() {{
  for root in {protected_roots}; do
    root=$(canon "$root")
    if overlaps "$2" "$root"; then die "refusing $1 $2: it overlaps TS state at $root"; fi
  done
}}

home=$(checked HOME "$HOME")
tmp=$(checked TMPDIR "${{TMPDIR:-$system_tmp}}")
case "${{XDG_DATA_HOME:-}}" in
  /*) data=$(checked XDG_DATA_HOME "$XDG_DATA_HOME") ;;
  *) data=$home/.local/share ;;
esac
sock_dir=$(checked PRIME_AGENT_RS_SOCKET_DIR "${{PRIME_AGENT_RS_SOCKET_DIR:-$tmp/pa-rs-$uid}}")
sock_dir=$(canon "$sock_dir")
refuse_ts_state "socket dir" "$sock_dir"
# Own agent dir: the TS fleet's ~/.prime/agent is shared mutable state the
# Rust daemon would sweep, migrate and rewrite (session archiving, update
# manifests, schedules, settings, OAuth refresh). The installer seeds it with
# a models.json link, its own skills and a one-time settings copy.
agent_dir=$(checked PRIME_AGENT_RS_AGENT_DIR "${{PRIME_AGENT_RS_AGENT_DIR:-$home/.prime/agent-rs}}")
agent_dir=$(canon "$agent_dir")
refuse_ts_state "agent dir" "$agent_dir"
kernel_venv=$(checked PRIME_AGENT_RS_KERNEL_VENV "${{PRIME_AGENT_RS_KERNEL_VENV:-$agent_dir/kernel-venv}}")
kernel_venv=$(canon "$kernel_venv")
refuse_ts_state "kernel venv" "$kernel_venv"
case "$agent_dir/" in "$kernel_venv"/*) die "refusing kernel venv $kernel_venv: it holds the agent dir" ;; esac
# The kernel imports bundled Python skills in place (editable installs from
# the release dir): their bytecode goes to this cache, never into the
# immutable install, whose payload digest rollout and rollback check. It
# must resolve inside the agent dir (the link scan below also refuses a
# python-cache link that stays inside it).
py_cache=$(canon "$agent_dir/python-cache")
case "$py_cache/" in
  "$agent_dir"/?*/) ;;
  *) die "refusing Python cache $py_cache: it resolves outside the agent dir $agent_dir" ;;
esac

# Nothing in the agent dir may alias out of it (`sessions -> <TS sessions>`
# would hand TS state to the Rust daemon): only models.json may be a link
# (read-only, no Rust writer), to a regular file. The kernel venv holds uv's
# links (its interpreter, lib64 -> lib): a linked dir there must stay inside
# the venv, or package installs would land elsewhere. A tree that cannot be
# fully scanned is refused too.
# Each link is judged with its name as an argument (find -exec), never as a
# line of find's output: a name may hold a newline.
if [ -d "$agent_dir" ]; then
  links=$(find "$agent_dir" -type l -exec sh -c '
    agent=$1 venv=$2; shift 2
    for link; do
      case "$link" in "$venv"/*) continue ;; esac
      if [ "$link" = "$agent/models.json" ] && [ -f "$link" ]; then continue; fi
      printf "%s\\n" "$link"
    done' sh "$agent_dir" "$kernel_venv" {{}} +) || die "cannot scan the agent dir $agent_dir for links"
  if [ -n "$links" ]; then die "refusing agent dir $agent_dir: only models.json may be a link in it, found: $links"; fi
fi
if [ -d "$kernel_venv" ]; then
  links=$(find "$kernel_venv" -type l -exec sh -c '
    venv=$1; shift
    for link; do
      [ -d "$link" ] || continue
      case "$(cd -P "$link" 2>/dev/null && pwd)/" in "$venv"/*) ;; *) printf "%s\\n" "$link" ;; esac
    done' sh "$kernel_venv" {{}} +) || die "cannot scan the kernel venv $kernel_venv for links"
  if [ -n "$links" ]; then die "refusing kernel venv $kernel_venv: a linked dir in it leads out of it: $links"; fi
fi

if [ ! -e "$sock_dir" ]; then (umask 077 && mkdir -p "$sock_dir"); fi
if [ -L "$sock_dir" ] || [ ! -d "$sock_dir" ] || [ ! -O "$sock_dir" ]; then
  die "refusing socket dir $sock_dir (not a directory owned by uid $uid)"
fi
chmod 700 "$sock_dir"
if [ ! -e "$agent_dir" ]; then (umask 077 && mkdir -p "$agent_dir"); fi
if [ ! -e "$py_cache" ]; then (umask 077 && mkdir -p "$py_cache"); fi

PRIME_AGENT_CODING_AGENT_DIR=$agent_dir
PRIME_AGENT_SOCKET_DIR=$sock_dir
PRIME_AGENT_DAEMON_SOCKET=$sock_dir/daemon.sock
PRIME_AGENT_KERNEL_VENV=$kernel_venv
PRIME_AGENT_DISABLE_SELF_UPDATE=1
PRIME_AGENT_RUST_INSTALLER_URL=http://127.0.0.1:1/oneiron-self-update-disabled
PRIME_AGENT_DOWNLOAD_BASE_URL=http://127.0.0.1:1/oneiron-feed-disabled
PI_SKIP_VERSION_CHECK=1
PYTHONPYCACHEPREFIX=$py_cache
export PRIME_AGENT_CODING_AGENT_DIR PRIME_AGENT_SOCKET_DIR PRIME_AGENT_DAEMON_SOCKET PRIME_AGENT_KERNEL_VENV \\
  PRIME_AGENT_DISABLE_SELF_UPDATE PRIME_AGENT_RUST_INSTALLER_URL PRIME_AGENT_DOWNLOAD_BASE_URL PI_SKIP_VERSION_CHECK \\
  PYTHONPYCACHEPREFIX
# Inherited state paths and debug sinks would point the Rust process at TS
# sessions, a TS session's harness state, or a parent's trace and log files;
# an inherited restart roster would be replayed by the Rust daemon.
unset PI_PACKAGE_DIR PRIME_AGENT_KERNEL_PYTHON PRIME_AGENT_SESSION_DIR PRIME_AGENT_CODING_AGENT_SESSION_DIR \\
  RLM_SESSION_DIR RLM_HARNESS_STATE_DIR RLM_GLOBAL_HARNESS_STATE_DIR \\
  PA_COMPACTION_TRACE PA_MCP_LOGIN_URL_FILE PA_DAEMON_EVENT_LOG PRIME_AGENT_UPDATE_ROSTER
# PRIME_AGENT_INTERNAL_* are supervisor-to-worker switches; the supervisor
# spawns its workers directly, and this launcher is a user entry point.
for name in $(env | sed -n 's/^\\(PRIME_AGENT_INTERNAL_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$name"; done
dir=$(cd "$prefix/current" && pwd -P)
if [ "${{PRIME_AGENT_RS_PRINT_ENV:-}}" = 1 ]; then
  # The probe's view of what a real run gets (no binary is started).
  printf '%s\\n' "PRIME_AGENT_CODING_AGENT_DIR=$PRIME_AGENT_CODING_AGENT_DIR" \\
    "PRIME_AGENT_SOCKET_DIR=$PRIME_AGENT_SOCKET_DIR" \\
    "PRIME_AGENT_DAEMON_SOCKET=$PRIME_AGENT_DAEMON_SOCKET" "PRIME_AGENT_KERNEL_VENV=$PRIME_AGENT_KERNEL_VENV" \\
    "PRIME_AGENT_DISABLE_SELF_UPDATE=$PRIME_AGENT_DISABLE_SELF_UPDATE" \\
    "PRIME_AGENT_RUST_INSTALLER_URL=$PRIME_AGENT_RUST_INSTALLER_URL" \\
    "PRIME_AGENT_DOWNLOAD_BASE_URL=$PRIME_AGENT_DOWNLOAD_BASE_URL" \\
    "PI_SKIP_VERSION_CHECK=$PI_SKIP_VERSION_CHECK" "PYTHONPYCACHEPREFIX=$PYTHONPYCACHEPREFIX" \\
    "binary=$dir/prime-agent"
  exit 0
fi
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


def payload_digest(directory: Path) -> str:
    """One sha256 over an install's whole payload: every dir and regular
    file by relative path, with each file's executable bit and content hash.
    Equal digests mean equal trees, so a reused or rolled-back install is
    checked in full, not just by its executable. The install dir itself
    must be a real directory: a link to an identical tree elsewhere is not
    the install."""
    if directory.is_symlink() or not directory.is_dir():
        raise SystemExit(f"error: {directory} is not a plain directory; an install is never a link")
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise SystemExit(f"error: {path} is neither a plain file nor a dir; installs hold only those")
        if path.is_dir():
            digest.update(f"d {relative}\n".encode())
        else:
            executable = "x" if os.access(path, os.X_OK) else "-"
            digest.update(f"f {relative} {executable} {sha256_file(path)}\n".encode())
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


def read_link(path: Path) -> str | None:
    return os.readlink(path) if path.is_symlink() else None


@contextlib.contextmanager
def replacing(path: Path, mode: int = 0o644) -> Iterator[BinaryIO]:
    """A new file that replaces `path` when the block completes. It is
    created beside `path` exclusively under a random name (mkstemp: O_EXCL,
    so no existing name, a stale temp or a planted link, is ever opened or
    followed), written, given `mode` (less the umask) and fsynced through
    its descriptor, then renamed over `path`, so a reader or a crash never
    sees half a file. A failed block removes it and leaves `path` as it was."""
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            yield handle
            handle.flush()
            umask = os.umask(0)
            os.umask(umask)
            os.fchmod(handle.fileno(), mode & ~umask)
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp)
        raise


def replace_file(path: Path, data: bytes, mode: int = 0o644) -> None:
    with replacing(path, mode) as handle:
        handle.write(data)


def write_json_atomic(path: Path, data: dict) -> None:
    replace_file(path, (json.dumps(data, indent=2) + "\n").encode())


def plain_dir(root: Path, *parts: str) -> Path:
    """root/parts..., refusing any part below `root` that exists as anything
    but a real directory: a symlinked `releases/` or `receipts/` would send
    the writes meant for this tree somewhere else (TS state included).
    Missing parts are left for the caller to create."""
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise SystemExit(f"error: {path} is not a plain directory; refusing to write through it")
    return path


@contextlib.contextmanager
def locked(directory: Path) -> Iterator[None]:
    """One writer at a time per install prefix (or feed): concurrent rollouts,
    rollbacks or packages would otherwise flip pointers over each other."""
    directory.mkdir(parents=True, exist_ok=True)
    fd = os.open(directory / ".lock", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(f"error: another side_by_side.py run holds {directory / '.lock'}") from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


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


def checked_path(name: str, raw: str) -> Path:
    """`raw` as a path, trailing slashes dropped. It must be absolute with no
    empty, `.` or `..` component: a `..` past a missing dir would slip by the
    canonical overlap checks (the launcher's `checked` is the same rule)."""
    text = raw.rstrip("/") or raw[:1]
    if not text.startswith("/"):
        raise SystemExit(f"error: {name} must be an absolute path: {raw}")
    if text != "/" and any(part in ("", ".", "..") for part in text.split("/")[1:]):
        raise SystemExit(f"error: {name} must not hold empty, . or .. components: {raw}")
    return Path(text)


def canonical(name: str, path: Path) -> Path:
    """The physical spelling of `path` (symlinked ancestors resolved). A link
    to a missing dir is refused, not guessed at, as the launcher's canon does."""
    probe = path
    while not probe.is_dir() and probe != probe.parent:
        if probe.is_symlink():
            raise SystemExit(f"error: {name} {path}: {probe} is a link but not to a dir")
        probe = probe.parent
    return path.resolve()


def tmp_dir() -> Path:
    return checked_path("TMPDIR", os.environ.get("TMPDIR") or str(SYSTEM_TMP))


def data_home() -> Path:
    raw = os.environ.get("XDG_DATA_HOME") or ""
    return checked_path("XDG_DATA_HOME", raw) if raw.startswith("/") else HOME / ".local" / "share"


def protected_roots() -> list[Path]:
    """PROTECTED_STATE under this process's TMPDIR, HOME and XDG_DATA_HOME."""
    bases = {"tmp": [tmp_dir(), SYSTEM_TMP], "home": [HOME], "data": [data_home(), HOME / ".local" / "share"]}
    return list(dict.fromkeys(base / rel.format(uid=os.getuid())
                              for kind, rel in PROTECTED_STATE for base in bases[kind]))


def shell_protected_roots() -> str:
    """PROTECTED_STATE as the launcher's word list (its own $tmp, $home, $data)."""
    bases = {"tmp": ("$tmp", "$system_tmp"), "home": ("$home",), "data": ("$data", "$home/.local/share")}
    return " ".join(f'"{base}/{rel.format(uid="$uid")}"' for kind, rel in PROTECTED_STATE for base in bases[kind])


def ts_state_overlap(path: Path) -> Path | None:
    """The protected root canonical `path` equals, sits inside or contains."""
    for root in protected_roots():
        root = canonical("protected root", root)
        if path == root or is_within(path, root) or is_within(root, path):
            return root
    return None


def outside_ts_state(role: str, raw: str) -> bool:
    return ts_state_overlap(canonical(role, Path(raw))) is None


def refuse_ts_state(role: str, path: Path) -> Path:
    """`path`, canonical, unless it overlaps TS state (the launcher's
    refuse_ts_state is the same rule over the same set)."""
    path = canonical(role, path)
    root = ts_state_overlap(path)
    if root is not None:
        raise SystemExit(f"error: refusing {role} {path}: it overlaps TS state at {root}")
    return path


def cli_prefix(args: argparse.Namespace) -> Path:
    """The canonical --prefix, checked against TS state."""
    prefix = checked_path("--prefix", os.path.expanduser(args.prefix or f"{HOME}/.local/share/prime-agent-oneiron-rs"))
    return refuse_ts_state("prefix", prefix)


def cli_dirs(args: argparse.Namespace) -> tuple[Path, Path]:
    """The canonical --prefix and --bin-dir, checked against TS state; the
    Rust launcher in the bin dir may not alias the TS one."""
    prefix = cli_prefix(args)
    bin_dir = refuse_ts_state("bin dir", checked_path(
        "--bin-dir", os.path.expanduser(args.bin_dir or f"{HOME}/.local/bin")))
    if (bin_dir / LAUNCHER_NAME).resolve() == (bin_dir / TS_LAUNCHER_NAME).resolve():
        raise SystemExit("error: the prime-agent-rs launcher would alias the TS prime-agent launcher")
    return prefix, bin_dir


def runtime_dirs() -> dict[str, Path]:
    """The agent dir, socket dir and kernel venv the launcher will hand the
    binary (same overrides, same defaults), canonical and checked."""
    env = os.environ.get
    agent_dir = refuse_ts_state("agent dir", checked_path(
        "PRIME_AGENT_RS_AGENT_DIR", env("PRIME_AGENT_RS_AGENT_DIR") or f"{HOME}/.prime/agent-rs"))
    socket_dir = refuse_ts_state("socket dir", checked_path(
        "PRIME_AGENT_RS_SOCKET_DIR", env("PRIME_AGENT_RS_SOCKET_DIR") or f"{tmp_dir()}/pa-rs-{os.getuid()}"))
    kernel_venv = refuse_ts_state("kernel venv", checked_path(
        "PRIME_AGENT_RS_KERNEL_VENV", env("PRIME_AGENT_RS_KERNEL_VENV") or f"{agent_dir}/kernel-venv"))
    if agent_dir == kernel_venv or is_within(agent_dir, kernel_venv):
        raise SystemExit(f"error: refusing kernel venv {kernel_venv}: it holds the agent dir")
    return {"agent dir": agent_dir, "socket dir": socket_dir, "kernel venv": kernel_venv}


def tree_links(root: Path, skip: Path | None = None) -> list[Path]:
    """Every symlink under `root` (none followed), the `skip` subtree aside.
    A subtree that cannot be read is an error, not an empty answer."""
    if not root.exists():
        return []

    def unreadable(error: OSError) -> None:
        raise SystemExit(f"error: cannot scan {root} for links: {error}")

    found = []
    for dirpath, dirnames, filenames in os.walk(root, onerror=unreadable):
        here = Path(dirpath)
        dirnames[:] = [name for name in dirnames if here / name != skip]
        found.extend(here / name for name in dirnames + filenames if (here / name).is_symlink())
    return found


def check_agent_tree(agent_dir: Path, kernel_venv: Path, *, old_skills_link: bool) -> None:
    """Nothing in the agent dir may alias out of it (`sessions -> <TS
    sessions>` would hand TS state to the Rust daemon): only models.json may
    be a link, to a regular file. The kernel venv holds uv's links (its
    interpreter, lib64 -> lib): a linked dir there must stay inside it.
    `old_skills_link` admits the pre-snapshot skills link the seeder is about
    to replace. The launcher applies the same rules."""
    allowed = {agent_dir / "skills"} if old_skills_link else set()
    bad = [link for link in tree_links(agent_dir, skip=kernel_venv) if link not in allowed
           and not (link == agent_dir / "models.json" and link.is_file())]
    if bad:
        raise SystemExit(f"error: refusing agent dir {agent_dir}: only models.json may be a link in it, "
                         f"found: {' '.join(map(str, bad))}")
    escapes = [link for link in tree_links(kernel_venv) if link.is_dir()
               and not (link.resolve() == kernel_venv or is_within(link.resolve(), kernel_venv))]
    if escapes:
        raise SystemExit(f"error: refusing kernel venv {kernel_venv}: a linked dir in it leads out of it: "
                         f"{' '.join(map(str, escapes))}")


# One path component: the version names the install dir, the `current`
# target and the receipt dir, so `/` and `..` must never reach a path.
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.+-]*)?$")
POINTER_LINK = re.compile(r"^(?:current|previous|\.(?:current|previous)\.tmp-[0-9]+)$")


def check_version(version: str) -> None:
    if not VERSION_PATTERN.match(version) or ".." in version:
        raise SystemExit(f"error: version {version!r} is not a plain release version (e.g. 0.9.8-oneiron.20261001.1)")


def check_prefix_tree(prefix: Path) -> None:
    """Every install, receipt and feed write must land inside the prefix: its
    only links are `current` and `previous` (and an interrupted flip's temp)
    naming a version."""
    bad = [link for link in tree_links(prefix)
           if not (link.parent == prefix and POINTER_LINK.match(link.name) and VERSION_PATTERN.match(os.readlink(link)))]
    if bad:
        raise SystemExit(f"error: refusing prefix {prefix}: only `current` and `previous` may be links in it, "
                         f"found: {' '.join(map(str, bad))}")


def inside_prefix(prefix: Path, path: Path) -> Path:
    if not is_within(path.resolve(), prefix) or path.resolve() == prefix:
        raise SystemExit(f"error: {path} would land outside {prefix}")
    return path


def receipt_dir(prefix: Path, version: str, platform: str) -> Path:
    """<prefix>/receipts/<version>-<platform>: no part of it may exist as a
    link or a non-dir (plain_dir), it must resolve inside the prefix and
    clear of TS state."""
    path = inside_prefix(prefix, plain_dir(prefix, "receipts", f"{version}-{platform}"))
    refuse_ts_state("receipts", path)
    return path


def check_no_symlinks(stage_dir: Path) -> None:
    """The staged tree must hold only regular files and dirs: a preserved
    symlink would let the install (or the version stamp) write outside it."""
    if stage_dir.is_symlink():
        raise SystemExit(f"error: staged layout {stage_dir} is a symlink")
    links = tree_links(stage_dir)
    if links:
        raise SystemExit(f"error: staged layout holds a symlink: {links[0]}")


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


def check_tar_members(tarball: Path, archive: tarfile.TarFile, into: Path) -> None:
    """Every member is checked before any byte is written: the release
    payload is plain files and dirs (assemble_artifacts' packer refuses
    links), so a link, device, fifo, absolute or `..` name, a member that
    would land outside the scratch dir `into`, or a member that appears
    twice (the second copy would overwrite the first) means the archive is
    not one we built."""
    root = into.resolve()
    seen = set()
    for member in archive.getmembers():
        name = os.path.normpath(member.name)
        if (not (member.isfile() or member.isdir()) or member.name.startswith("/")
                or ".." in Path(member.name).parts or name in seen
                or not is_within((root / member.name).resolve(), root)):
            raise SystemExit(f"error: unsafe tarball member {member.name!r} in {tarball}")
        seen.add(name)


def extract_tarball(tarball: Path, into: Path) -> Path:
    with tarfile.open(tarball) as archive:
        check_tar_members(tarball, archive, into)
        try:
            archive.extractall(into, filter="data")
        except TypeError:
            # Python without the extraction-filter backport (stock macOS
            # 3.9); the member check above already refused everything the
            # data filter would.
            archive.extractall(into)
    stage = into / tarball.name.removesuffix(".tar.gz")
    stage.mkdir(exist_ok=True)
    for entry in list(into.iterdir()):
        if entry != stage:
            entry.rename(stage / entry.name)
    return stage


def remove_entry(path: Path) -> None:
    """Remove `path` itself: a link is unlinked, never followed."""
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def copy_snapshot(source: Path, target: Path, skipped: list[str], exclude: frozenset[str] = frozenset()) -> None:
    """Copy the `source` tree to a new `target` with files and dirs only:
    every link becomes a copy of what it names, SKILLS_SNAPSHOT_SKIP names
    (and top-level `exclude` names) are left behind, and dangling links,
    link cycles and special files are recorded in `skipped`.
    (shutil.copytree checks relative link targets against the cwd, so it
    would drop or misjudge them.)"""
    active: set[Path] = set()

    def copy_dir(src: Path, dst: Path, exclude: frozenset[str] = frozenset()) -> None:
        real = src.resolve()
        if real in active:
            skipped.append(f"{src} (link cycle)")
            return
        active.add(real)
        dst.mkdir()
        for entry in sorted(os.scandir(src), key=lambda entry: entry.name):
            if entry.name in exclude or any(fnmatch.fnmatch(entry.name, pattern) for pattern in SKILLS_SNAPSHOT_SKIP):
                continue
            if entry.is_dir():
                copy_dir(Path(entry.path), dst / entry.name)
            elif entry.is_file():
                shutil.copy2(entry.path, dst / entry.name)
            else:
                skipped.append(entry.path)
        active.discard(real)

    copy_dir(source, target, exclude)


class HubRenderUnavailable(Exception):
    """Why the hub categories cannot be rendered for the Rust agent dir; the
    skills are then a plain snapshot of the TS dir, hub files included."""


def lock_records(lock: object, name: str) -> tuple[dict[str, str], set[str]]:
    """A render-host.py lock's files (path -> sha256) and the paths it
    rewrote the agent root in; any other shape cannot be compared."""
    files = lock.get("files") if isinstance(lock, dict) else None
    changes = lock.get("changes") if isinstance(lock, dict) else None
    if not (isinstance(files, list) and isinstance(changes, list)
            and all(isinstance(entry, dict) and isinstance(entry.get("path"), str)
                    and isinstance(entry.get("sha256"), str) for entry in files)
            and all(isinstance(change, dict) and isinstance(change.get("path"), str)
                    and isinstance(change.get("kind"), str) for change in changes)):
        raise HubRenderUnavailable(f"{name} is not a render-host.py lock (files and changes records)")
    return ({entry["path"]: entry["sha256"] for entry in files},
            {change["path"] for change in changes if change["kind"] == "prime-agent-root-rewrite"})


def render_hubs(ts_skills: Path, repo: Path, agent_dir: Path, scratch: Path) -> tuple[dict, Path]:
    """Render the TS skills dir's hub categories for `agent_dir` the way the
    TS deploy was made: the hubs checkout's own scripts/render-host.py, at
    the commit and host profile the TS LOCK.host.json records, rewrites the
    agent root inside hub files and writes a lock. The checkout is only read
    (a shared clone in `scratch` checks the commit out), and the render must
    match the TS lock byte for byte outside the rewritten files. Returns the
    TS lock and the render output (hubs/<hub>/…, LOCK.host.json)."""
    try:
        ts_lock = json.loads((ts_skills / HUB_LOCK).read_text())
    except FileNotFoundError:
        raise HubRenderUnavailable(f"the TS skills dir has no {HUB_LOCK}") from None
    except (OSError, ValueError) as error:
        raise HubRenderUnavailable(f"unreadable TS {HUB_LOCK}: {error!r}") from None
    ts_files, _ = lock_records(ts_lock, f"the TS {HUB_LOCK}")
    commit, profile, hubs = ts_lock.get("source_commit"), ts_lock.get("host_profile"), ts_lock.get("hubs")
    if not (isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit)
            and isinstance(profile, str) and re.fullmatch(r"[a-z0-9-]+", profile)
            and isinstance(hubs, list) and all(isinstance(hub, str) and HUB_NAME.match(hub) for hub in hubs)):
        raise HubRenderUnavailable(f"the TS {HUB_LOCK} names no plain commit, profile and hub names")
    if not (repo / ".git").exists():
        raise HubRenderUnavailable(f"no hubs checkout at {repo}")
    env = {name: value for name, value in os.environ.items() if name not in GIT_LOCATION_ENV}
    clone, out = scratch / "hubs", scratch / "rendered"

    def run(step: str, command: list[str]) -> None:
        try:
            result = subprocess.run(command, capture_output=True, text=True, env=env)
        except OSError as error:
            raise HubRenderUnavailable(f"{step} could not start: {error}") from None
        if result.returncode != 0:
            raise HubRenderUnavailable(f"{step} failed (exit {result.returncode}): {result.stderr.strip()[-500:]}")

    git = ["git", "-c", "core.hooksPath=/dev/null"]
    run(f"cloning {repo}", [*git, "clone", "--quiet", "--shared", "--no-checkout", str(repo), str(clone)])
    run(f"checking out {commit}", [*git, "-C", str(clone), "checkout", "--quiet", "--detach", commit])
    script = clone / "scripts" / "render-host.py"
    if not script.is_file():
        raise HubRenderUnavailable(f"{commit} has no scripts/render-host.py")
    run("render-host.py", [sys.executable, str(script), "--prime-agent-dir", str(agent_dir),
                           "--output", str(out), "--profile", profile])
    try:
        lock = json.loads((out / HUB_LOCK).read_text())
    except (OSError, ValueError) as error:
        raise HubRenderUnavailable(f"render-host.py wrote no readable {HUB_LOCK}: {error!r}") from None
    files, rewritten = lock_records(lock, f"the rendered {HUB_LOCK}")
    expected = {"source_commit": commit, "host_profile": profile, "hubs": hubs, "prime_agent_dir": str(agent_dir)}
    stamped = {key: lock.get(key) for key in expected}
    if stamped != expected:
        raise HubRenderUnavailable(f"the rendered {HUB_LOCK} says {stamped}, not {expected}")
    differ = sorted(path for path in ts_files.keys() | files.keys()
                    if path not in rewritten and ts_files.get(path) != files.get(path))
    if differ:
        raise HubRenderUnavailable(f"the render differs from the TS deploy at {commit} in {len(differ)} files, "
                                   f"e.g. {differ[0]}")
    if any(not (out / "hubs" / hub).is_dir() for hub in hubs) or any(path.is_symlink() for path in out.rglob("*")):
        raise HubRenderUnavailable("the render lacks a hub dir or holds a link")
    return ts_lock, out


def build_skills(source: Path, target: Path, agent_dir: Path, hubs_repo: Path) -> dict:
    """Replace `target` with the Rust agent dir's own skills, never a link:
    the kernel installs Python skills editable and imports them, so bytecode
    and build metadata land beside the skill source, which a link would put
    in the TS tree. Hub categories are rendered for the Rust agent dir
    (render_hubs) and laid out as the TS deploy is, <hub>/ and the lock at
    the top; every other entry is a snapshot (copy_snapshot). When the hubs
    cannot be rendered the whole TS dir is a snapshot, and the reason is
    recorded."""
    temp = target.with_name(f".{target.name}.tmp-{os.getpid()}")
    old = target.with_name(f".{target.name}.old-{os.getpid()}")
    skipped: list[str] = []
    remove_entry(temp)
    with tempfile.TemporaryDirectory(prefix="pa-rs-skills-") as scratch:
        try:
            ts_lock, rendered = render_hubs(source, hubs_repo, agent_dir, Path(scratch))
            record: dict[str, object] = {"skillsSource": "hub-render", "hubsRepo": str(hubs_repo),
                                         "hubsCommit": ts_lock["source_commit"],
                                         "hostProfile": ts_lock["host_profile"], "hubs": ts_lock["hubs"]}
        except HubRenderUnavailable as reason:
            ts_lock, rendered = {"hubs": []}, None
            record = {"skillsSource": "snapshot-fallback", "reason": str(reason)}
        try:
            exclude = frozenset([*ts_lock["hubs"], HUB_LOCK]) if rendered else frozenset()
            copy_snapshot(source, temp, skipped, exclude)
            if rendered:
                for hub in ts_lock["hubs"]:
                    shutil.copytree(rendered / "hubs" / hub, temp / hub, symlinks=True)
                shutil.copy2(rendered / HUB_LOCK, temp / HUB_LOCK)
                record["lockSha256"] = sha256_file(temp / HUB_LOCK)
            if target.is_symlink() or target.exists():
                os.rename(target, old)
            os.rename(temp, target)
        finally:
            remove_entry(temp)
    remove_entry(old)
    return {**record, "snapshotOf": str(source), "skipped": skipped}


def seed_agent_dir(agent_dir: Path, ts_agent_dir: Path, hubs_repo: Path, *, refresh_skills: bool) -> dict:
    """Create the Rust agent dir: a link to models.json (no Rust writer), its
    own skills (build_skills), a one-time copy of settings.json, nothing
    else (no auth, no sessions). Existing skills are kept unless
    `refresh_skills`; an old-layout skills link is always replaced."""
    agent_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    actions: dict[str, object] = {}
    for name in SHARED_LINKS:
        source, target = ts_agent_dir / name, agent_dir / name
        if target.exists() or target.is_symlink():
            actions[name] = "kept"
        elif source.exists():
            target.symlink_to(source)
            actions[name] = f"linked -> {source}"
        else:
            actions[name] = "absent in TS agent dir"
    source, target = ts_agent_dir / "skills", agent_dir / "skills"
    old_link = os.readlink(target) if target.is_symlink() else None
    if target.exists() and old_link is None and not refresh_skills:
        actions["skills"] = "kept (install --refresh-skills replaces it)"
    elif source.is_dir():
        replaced = f"link -> {old_link}" if old_link is not None else "snapshot" if target.exists() else None
        actions["skills"] = {**build_skills(source, target, agent_dir, hubs_repo), "replaced": replaced}
    else:
        if old_link is not None:
            target.unlink()
        actions["skills"] = "absent in TS agent dir"
    settings, settings_copy = ts_agent_dir / "settings.json", agent_dir / "settings.json"
    if settings_copy.exists() or settings_copy.is_symlink():
        actions["settings.json"] = "kept"
    elif settings.is_file():
        shutil.copyfile(settings, settings_copy)
        settings_copy.chmod(0o600)
        actions["settings.json"] = f"copied once from {settings}"
    else:
        actions["settings.json"] = "absent in TS agent dir"
    return {"path": str(agent_dir), "seeded": actions}


def launcher_text(prefix: Path) -> str:
    return LAUNCHER_TEMPLATE.format(prefix=shlex.quote(str(prefix)), system_tmp=shlex.quote(str(SYSTEM_TMP)),
                                    protected_roots=shell_protected_roots())


def write_launcher(bin_dir: Path, prefix: Path) -> Path:
    bin_dir.mkdir(parents=True, exist_ok=True)
    launcher = bin_dir / LAUNCHER_NAME
    replace_file(launcher, launcher_text(prefix).encode(), 0o755)
    return launcher


def replace_symlink(link: Path, target: str) -> None:
    temp = link.parent / f".{link.name}.tmp-{os.getpid()}"
    if temp.is_symlink() or temp.exists():
        temp.unlink()
    temp.symlink_to(target)
    os.replace(temp, link)


def flip_current(prefix: Path, version: str) -> str | None:
    """Point `current` at `version`; the version it leaves becomes `previous`
    (what `rollback` selects by default). `previous` moves first, so
    `current`, the pointer the launcher follows, is right at every instant."""
    before = read_link(prefix / "current")
    if before is not None and before != version:
        replace_symlink(prefix / "previous", before)
    replace_symlink(prefix / "current", version)
    return before


def select_version(prefix: Path, bin_dir: Path, version: str) -> str | None:
    """Make an installed version the one `prime-agent-rs` runs: (re)write the
    launcher, which follows `current` and is the same for every version,
    then flip current. A launcher that cannot be written leaves `current`
    where it was. Returns the version current left."""
    write_launcher(bin_dir, prefix)
    return flip_current(prefix, version)


def hubs_repo(args: argparse.Namespace) -> Path:
    return Path(os.path.expanduser(args.skill_hubs)) if args.skill_hubs else HOME / "code" / "prime-skill-hubs"


def stamp_manifest(package_json: Path, version: str) -> None:
    """Pin the exe-adjacent manifest version (the binary reports it over the
    compiled-in one, as upstream's commit-stamped continuous builds do)."""
    manifest = json.loads(package_json.read_text())
    manifest["version"] = version
    package_json.write_text(json.dumps(manifest, indent=2) + "\n")


@dataclasses.dataclass(frozen=True)
class Payload:
    """A release layout validated in scratch, not yet in the prefix."""
    stage: Path
    version: str
    staged_version: str
    platform: str


@contextlib.contextmanager
def staged_payload(tarball: Path | None, stage_dir: Path | None, version: str | None) -> Iterator[Payload]:
    """Extract (or take) a release layout and validate it; nothing is written
    outside a scratch dir until commit_payload."""
    with tempfile.TemporaryDirectory(prefix="pa-rs-install-") as scratch:
        stage = extract_tarball(tarball, Path(scratch)) if tarball else stage_dir
        check_no_symlinks(stage)
        staged_version, platform = read_stage(stage)
        version = version or staged_version
        check_version(version)
        if version != staged_version and not version.startswith(f"{staged_version}-"):
            raise SystemExit(f"error: --version {version} must extend the staged version {staged_version} "
                             f"(e.g. {staged_version}-oneiron.YYYYMMDD.N)")
        if not re.match(r"^[a-z0-9]+-[a-z0-9]+$", platform):
            raise SystemExit(f"error: platform {platform!r} is not a plain <os>-<arch> tag")
        yield Payload(stage, version, staged_version, platform)


def check_install_target(prefix: Path, version: str) -> Path:
    target = inside_prefix(prefix, prefix / version)
    if target.resolve().parent != prefix:
        raise SystemExit(f"error: {target} would land outside {prefix}")
    if target.exists() or target.is_symlink():
        raise SystemExit(f"error: {target} already exists; installs are immutable, bump the build number")
    return target


def commit_payload(prefix: Path, payload: Payload) -> Path:
    """Copy the payload to <prefix>/<version>/ (new dirs only; renamed into
    place whole, so a crash leaves a temp dir, never half an install)."""
    target = check_install_target(prefix, payload.version)
    prefix.mkdir(parents=True, exist_ok=True)
    temp_target = inside_prefix(prefix, prefix / f".{payload.version}.tmp-{os.getpid()}")
    if temp_target.exists():
        shutil.rmtree(temp_target)
    shutil.copytree(payload.stage, temp_target, symlinks=True)
    if payload.version != payload.staged_version:
        stamp_manifest(temp_target / "package.json", payload.version)
    os.rename(temp_target, target)
    return target


def install(args: argparse.Namespace) -> int:
    # Every destination is validated before anything is written: the prefix
    # (receipts included), the bin dir, and the agent dir, socket dir and
    # kernel venv the seeder and the launcher's --version run will create.
    prefix, bin_dir = cli_dirs(args)
    runtime = runtime_dirs()
    agent_dir = runtime["agent dir"]
    check_prefix_tree(prefix)
    refuse_ts_state("receipts", inside_prefix(prefix, prefix / "receipts"))
    check_agent_tree(agent_dir, runtime["kernel venv"], old_skills_link=True)
    ts_launcher = bin_dir / TS_LAUNCHER_NAME
    ts_before = link_state(ts_launcher)

    current_before = None
    launcher = bin_dir / LAUNCHER_NAME
    agent = None
    with staged_payload(args.tarball, args.stage_dir, args.version) as payload:
        version, staged_version, platform = payload.version, payload.staged_version, payload.platform
        check_install_target(prefix, version)
        receipts = receipt_dir(prefix, version, platform)  # refused before anything is written
        with locked(prefix):
            target = commit_payload(prefix, payload)
            if args.activate:
                agent = seed_agent_dir(agent_dir, TS_AGENT_DIR, hubs_repo(args), refresh_skills=args.refresh_skills)
                current_before = select_version(prefix, bin_dir, version)

    ts_after = link_state(ts_launcher)
    if ts_after != ts_before:
        raise SystemExit(f"error: {ts_launcher} changed during the install ({ts_before} -> {ts_after})")

    version_check = None
    if args.activate:
        result = subprocess.run([str(launcher), "--version"], capture_output=True, text=True)
        version_check = {"stdout": result.stdout.strip(), "exitCode": result.returncode,
                         "ok": result.returncode == 0 and result.stdout.strip() == version}

    receipts.mkdir(parents=True, exist_ok=True)
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
        "payloadSha256": payload_digest(target),
        "tarball": ({"path": str(args.tarball), "sha256": sha256_file(args.tarball)}
                    if args.tarball else None),
        "activated": args.activate,
        "current": {"before": current_before, "after": version if args.activate else current_before},
        "launcher": ({"path": str(launcher), "sha256": sha256_file(launcher)} if args.activate else None),
        "agentDir": agent,
        "tsLauncher": {"path": str(ts_launcher), "before": ts_before, "after": ts_after,
                       "unchanged": True},
        "versionCheck": version_check,
    }
    write_json_atomic(receipts / "INSTALL-RECEIPT.json", receipt)
    print(f"installed {version} ({platform}) at {target}")
    print(f"receipt {receipts / 'INSTALL-RECEIPT.json'}")
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


def tree_identity(root: Path) -> list[str] | None:
    """One line per entry under `root` (itself included, links not followed):
    relative path, type, size, mtime_ns, inode, mode, ctime_ns, and a link's
    target. A write anywhere in the tree, in place or not, changes at least
    one line: a writer can restore mtime but not ctime, and a replacement
    file has a new inode."""
    if not root.exists():
        return None

    def line(path: Path) -> str | None:
        try:
            info = path.lstat()
        except FileNotFoundError:  # removed mid-walk: its absence is the change
            return None
        kind = ("link" if stat.S_ISLNK(info.st_mode) else "dir" if stat.S_ISDIR(info.st_mode)
                else "file" if stat.S_ISREG(info.st_mode) else "other")
        target = os.readlink(path) if kind == "link" else ""
        return (f"{path.relative_to(root)}\t{kind}\t{info.st_size}\t{info.st_mtime_ns}\t{info.st_ino}"
                f"\t{info.st_mode:o}\t{info.st_ctime_ns}\t{target}")

    lines = [line(root)]
    for dirpath, dirnames, filenames in os.walk(root):
        lines.extend(line(Path(dirpath) / name) for name in dirnames + filenames)
    return sorted(entry for entry in lines if entry is not None)


def identity_digest(lines: list[str] | None) -> dict | None:
    """What a receipt keeps of a tree_identity: its size and digest."""
    if lines is None:
        return None
    return {"entries": len(lines), "sha256": hashlib.sha256("\n".join(lines).encode()).hexdigest()}


def identity_changes(before: list[str] | None, after: list[str] | None, limit: int = 20) -> list[str]:
    """The relative paths whose identity differs, for diagnosis (bounded)."""
    changed = set(before or []) ^ set(after or [])
    return sorted({entry.split("\t", 1)[0] for entry in changed})[:limit]


def launcher_env(launcher: Path) -> dict[str, str]:
    """What the launcher hands a real run (its print mode starts no binary)."""
    result = subprocess.run([str(launcher)], capture_output=True, text=True,
                            env={**os.environ, "PRIME_AGENT_RS_PRINT_ENV": "1"})
    if result.returncode != 0:
        raise SystemExit(f"error: {launcher} refused to start: {result.stderr.strip()}")
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def ts_kernel_venvs() -> list[Path]:
    """Where the TS product keeps its kernel venv (both agent-dir layouts)."""
    return list(dict.fromkeys([TS_AGENT_DIR / "kernel-venv", data_home() / "prime" / "agent" / "kernel-venv",
                               HOME / ".local" / "share" / "prime" / "agent" / "kernel-venv"]))


def probe(args: argparse.Namespace) -> int:
    prefix, bin_dir = cli_dirs(args)
    check_prefix_tree(prefix)
    current = prefix / "current"
    if not current.is_symlink():
        raise SystemExit(f"error: {current} is not an installed release")
    version = json.loads((current / "package.json").read_text())["version"]
    check_version(version)
    platform = next((name.split(f"{version}-", 1)[1] for name in os.listdir(prefix / "receipts")
                     if name.startswith(f"{version}-")), "unknown")
    receipt = run_probe(bin_dir / LAUNCHER_NAME, prefix, version, platform, bin_dir / TS_LAUNCHER_NAME, args)
    return 0 if receipt["ok"] else 1


def run_probe(launcher: Path, prefix: Path, version: str, platform: str, ts_launcher: Path,
              args: argparse.Namespace) -> dict:
    """Probe <prefix>/<version> through `launcher` (the installed one, or
    rollout's scratch launcher for a version not yet selected) and write
    PROBE-RECEIPT.json plus each run's full stdout into its receipt dir."""
    receipts = receipt_dir(prefix, version, platform)
    effective = launcher_env(launcher)
    rs_socket_dir = Path(effective["PRIME_AGENT_SOCKET_DIR"])
    rs_venv = Path(effective["PRIME_AGENT_KERNEL_VENV"])
    ts_socket_dir = tmp_dir() / f"prime-agent-{os.getuid()}"
    ts_venvs = ts_kernel_venvs()
    ts_launcher_before = link_state(ts_launcher)
    ts_venv_before = [tree_identity(venv) for venv in ts_venvs]

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
    }
    ts_launcher_after = link_state(ts_launcher)
    ts_venv_after = [tree_identity(venv) for venv in ts_venvs]
    checks = {
        "agentDirOutsideTsState": outside_ts_state("agent dir", effective["PRIME_AGENT_CODING_AGENT_DIR"]),
        "socketDirOutsideTsState": outside_ts_state("socket dir", str(rs_socket_dir)),
        "kernelVenvOutsideTsState": outside_ts_state("kernel venv", str(rs_venv)),
        # The launcher runs the release this probe reads the version of.
        "launcherRunsProbedRelease": Path(effective["binary"]) == (prefix / version / "prime-agent").resolve(),
        "selfUpdateDisabled": effective.get("PRIME_AGENT_DISABLE_SELF_UPDATE") == "1",
        "tsLauncherUnchanged": ts_launcher_before == ts_launcher_after,
        "tsKernelVenvsUnchanged": ts_venv_before == ts_venv_after,
    }
    receipt["isolation"] = {
        "effective": effective,
        "checks": checks,
        "rsSocketDir": {"path": str(rs_socket_dir), "entries": dir_listing(rs_socket_dir)},
        "tsSocketDir": {"path": str(ts_socket_dir), "entries": dir_listing(ts_socket_dir)},
        "rsKernelVenv": {"path": str(rs_venv), "exists": rs_venv.exists()},
        "tsKernelVenvs": [{"path": str(venv), "before": identity_digest(before), "after": identity_digest(after),
                           "changed": identity_changes(before, after)}
                          for venv, before, after in zip(ts_venvs, ts_venv_before, ts_venv_after)],
        "tsLauncher": ts_launcher_after,
    }
    receipt["ok"] = all(run["ok"] for run in runs.values()) and all(checks.values())
    receipts.mkdir(parents=True, exist_ok=True)
    # The full event stream rides beside the receipt; the receipt keeps a tail.
    for name, run in runs.items():
        replace_file(receipts / f"probe-{name}.out", run["stdout"].encode())
        run["stdoutFile"] = str(receipts / f"probe-{name}.out")
        run["stdout"] = run["stdout"][-4000:]
    write_json_atomic(receipts / "PROBE-RECEIPT.json", receipt)
    for name, run in runs.items():
        models = run.get("responseModels")
        detail = f" responseModel={models[-1]}" if models else ""
        print(f"{name}: {'ok' if run['ok'] else 'FAIL'} ({run['seconds']}s){detail}")
    for name, passed in checks.items():
        print(f"isolation {name}: {'ok' if passed else 'FAIL'}")
    print(f"receipt {receipts / 'PROBE-RECEIPT.json'}")
    return receipt


def add_seed_args(command: argparse.ArgumentParser) -> None:
    command.add_argument("--refresh-skills", action="store_true",
                         help="replace the agent dir's skills with a fresh build from the TS skills")
    command.add_argument("--skill-hubs", help="prime-skill-hubs checkout that renders the hub categories "
                         "(default ~/code/prime-skill-hubs; read only)")


def add_probe_args(command: argparse.ArgumentParser) -> None:
    command.add_argument("--provider", default="cpa-r")
    command.add_argument("--model", default="gpt-6.1-sol")
    command.add_argument("--thinking", default="low")
    command.add_argument("--tools", action="store_true",
                         help="also run a tools turn (bootstraps the separate kernel venv)")


def add_idle_args(command: argparse.ArgumentParser) -> None:
    command.add_argument("--rust-socket", type=Path,
                         help="the Rust supervisor socket to check (default: the launcher's "
                              "${PRIME_AGENT_RS_SOCKET_DIR:-$TMPDIR/pa-rs-<uid>}/daemon.sock)")
    command.add_argument("--force-idle-check-skip", action="store_true",
                         help="proceed even when the Rust daemon has live sessions or cannot be "
                              "checked (they keep running the old binary)")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--prefix", help="install tree (default ~/.local/share/prime-agent-oneiron-rs)")
    parser.add_argument("--bin-dir", help="launcher dir (default ~/.local/bin)")
    commands = parser.add_subparsers(dest="command", required=True)

    install_cmd = commands.add_parser("install", help="install a staged release side by side")
    source = install_cmd.add_mutually_exclusive_group(required=True)
    source.add_argument("--stage-dir", type=Path, help="scripts/package_release.py staged layout dir")
    source.add_argument("--tarball", type=Path, help="prime-agent-<version>-<platform>.tar.gz")
    install_cmd.add_argument("--version", help="stamp this version into the installed package.json "
                             "(must extend the staged version, e.g. 0.9.8-oneiron.20261001.1)")
    install_cmd.add_argument("--no-activate", dest="activate", action="store_false",
                             help="copy the release without flipping current or writing the launcher")
    add_seed_args(install_cmd)

    add_probe_args(commands.add_parser("probe", help="probe the installed launcher"))

    package_cmd = commands.add_parser("package", help="stamp a package_release.py layout into a feed release")
    package_cmd.add_argument("--package-dir", type=Path, required=True,
                             help="scripts/package_release.py --out-dir (binaries.json + the staged layout)")
    package_cmd.add_argument("--version", required=True, help="<base>-oneiron.YYYYMMDD.N, e.g. 0.9.8-oneiron.20261001.1")
    package_cmd.add_argument("--decoder", type=Path,
                             help="Linux (required): the split-debug prime-agent-<base>-linux-x64.debug.gz "
                                  "package_release.py made")
    package_cmd.add_argument("--feed-dir", help="default: <prefix>/feed")
    package_cmd.add_argument("--source-root", type=Path, default=ROOT,
                             help="the checkout the binary was built from (provenance; default: this repo)")
    package_cmd.add_argument("--allow-dirty", action="store_true",
                             help="package from a checkout with uncommitted changes (recorded as dirty)")
    package_cmd.add_argument("--allow-fixture-catalog", action="store_true",
                             help="accept the synthetic bundle_catalog.py --fixture catalogs (tests only)")
    package_cmd.add_argument("--no-promote", dest="promote", action="store_false",
                             help="publish the release without moving feed latest.json/stable")

    rollout_cmd = commands.add_parser("rollout", help="verify, install, probe and select a feed release")
    rollout_cmd.add_argument("--version", help="release to roll out (default: the feed's stable pointer)")
    rollout_cmd.add_argument("--feed-dir", help="default: <prefix>/feed")
    add_seed_args(rollout_cmd)
    add_probe_args(rollout_cmd)
    add_idle_args(rollout_cmd)

    rollback_cmd = commands.add_parser("rollback", help="select the previous (or a named) installed version")
    rollback_cmd.add_argument("--to", help="installed version to select (default: <prefix>/previous)")
    add_idle_args(rollback_cmd)

    status_cmd = commands.add_parser("status", help="installed versions, pointers, launcher, receipts, feed")
    status_cmd.add_argument("--feed-dir", help="default: <prefix>/feed")
    status_cmd.add_argument("--json", action="store_true", help="print the status as JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "install":
        return install(args)
    if args.command == "probe":
        return probe(args)
    # The release modules import this one for its primitives, so they load
    # here, at dispatch time, not at module import.
    if args.command == "package":
        import release_feed
        return release_feed.package(args)
    import rollout
    commands = {"rollout": rollout.rollout, "rollback": rollout.rollback, "status": rollout.status}
    return commands[args.command](args)


if __name__ == "__main__":
    # Run through the importable module, so the release modules (which
    # `import side_by_side`) share this one's state instead of a second copy.
    import side_by_side
    sys.exit(side_by_side.main())
