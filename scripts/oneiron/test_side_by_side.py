#!/usr/bin/env python3
"""Contract tests for scripts/oneiron/side_by_side.py, gate.sh and test_policy_gate.py
(run: python3 scripts/oneiron/test_side_by_side.py). No real product, TS state or cargo is touched."""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import side_by_side  # noqa: E402
import test_policy_gate  # noqa: E402

VERSION = "0.9.8-oneiron.20261001.1"
PLATFORM = "linux-x64"
# A fixture mtime far in the past: any later write moves it, even one that
# lands in the same clock tick as the fixture's creation.
OLD_NS = 1_000_000_000 * 10**9
# Fixture roots stay short so their socket dirs fit sun_path natively on
# macOS too: its $TMPDIR (/var/folders/…/T/) alone is 57 bytes canonical.
SHORT_TMP = "/tmp" if sys.platform == "darwin" else None

# The fake binary prints the exe-adjacent manifest version (as the real one
# does), the isolation env it was launched with, or (for `-p`) one JSON event
# carrying the requested model as its responseModel. FAKE_MUTATE_FILE, when
# set, is rewritten in place first: a stand-in for a run that writes TS state
# (and, with FAKE_MTIME_REF, puts the old mtime back to hide it).
FAKE_BINARY = """#!/bin/sh
if [ "$1" = "--version" ]; then
  sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$(dirname "$0")/package.json"; exit 0
fi
if [ "$1" = "env" ]; then
  printf '%s\\n' "SOCKET_DIR=$PRIME_AGENT_SOCKET_DIR" "DAEMON_SOCKET=$PRIME_AGENT_DAEMON_SOCKET" \\
    "KERNEL_VENV=$PRIME_AGENT_KERNEL_VENV" "SKIP=$PI_SKIP_VERSION_CHECK" "PACKAGE_DIR=${PI_PACKAGE_DIR-unset}" \\
    "NO_UPDATE=$PRIME_AGENT_DISABLE_SELF_UPDATE" "INSTALLER=$PRIME_AGENT_RUST_INSTALLER_URL" \\
    "DOWNLOAD=$PRIME_AGENT_DOWNLOAD_BASE_URL" "KERNEL_PYTHON=${PRIME_AGENT_KERNEL_PYTHON-unset}" \\
    "AGENT_DIR=$PRIME_AGENT_CODING_AGENT_DIR" "SESSION_DIR=${PRIME_AGENT_SESSION_DIR-unset}" \\
    "RLM_SESSION_DIR=${RLM_SESSION_DIR-unset}" "RLM_HARNESS_STATE_DIR=${RLM_HARNESS_STATE_DIR-unset}" \\
    "RLM_GLOBAL_HARNESS_STATE_DIR=${RLM_GLOBAL_HARNESS_STATE_DIR-unset}" \\
    "PA_COMPACTION_TRACE=${PA_COMPACTION_TRACE-unset}" "PA_MCP_LOGIN_URL_FILE=${PA_MCP_LOGIN_URL_FILE-unset}" \\
    "PA_DAEMON_EVENT_LOG=${PA_DAEMON_EVENT_LOG-unset}" "ROSTER=${PRIME_AGENT_UPDATE_ROSTER-unset}" \\
    "INTERNAL=$(env | sed -n 's/^\\(PRIME_AGENT_INTERNAL_[A-Za-z0-9_]*\\)=.*/\\1/p' | tr '\\n' ' ')" \\
    "PYCACHE=$PYTHONPYCACHEPREFIX"
  exit 0
fi
if [ "$1" = "-p" ]; then
  model=
  while [ $# -gt 0 ]; do
    if [ "$1" = "--model" ]; then model=$2; fi
    shift
  done
  if [ -n "${FAKE_MUTATE_FILE:-}" ]; then printf 'y' > "$FAKE_MUTATE_FILE"; fi
  if [ -n "${FAKE_MTIME_REF:-}" ]; then touch -m -r "$FAKE_MTIME_REF" "$FAKE_MUTATE_FILE"; fi
  printf '{"type":"message_end","message":{"role":"assistant","responseModel":"%s"}}\\n' "${model#*/}"
  exit 0
fi
exit 3
"""


NO_LOCK = "the TS skills dir has no LOCK.host.json"

# A stand-in for prime-skill-hubs' scripts/render-host.py with the same
# contract: hubs/ copied to <output>/hubs, the Mac agent root rewritten to
# --prime-agent-dir, an arch-linux adapter line appended, LOCK.host.json
# stamped with the checkout's HEAD.
FAKE_RENDER = """#!/usr/bin/env python3
import argparse, hashlib, json, shutil, subprocess
from pathlib import Path
REPO = Path(__file__).resolve().parents[1]
OLD = b"/Users/olety/.prime/agent"
parser = argparse.ArgumentParser()
parser.add_argument("--prime-agent-dir", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--profile", default="generic")
args = parser.parse_args()
out, new = Path(args.output).resolve(), str(Path(args.prime_agent_dir).resolve()).encode()
shutil.copytree(REPO / "hubs", out / "hubs")
changes = []
for path in sorted((out / "hubs").rglob("*")):
    if path.is_file() and OLD in path.read_bytes():
        changes.append({"path": str(path.relative_to(out)), "kind": "prime-agent-root-rewrite"})
        path.write_bytes(path.read_bytes().replace(OLD, new))
if args.profile == "arch-linux":
    adapter = out / "hubs" / "beta" / "SKILL.md"
    adapter.write_text(adapter.read_text() + "\\n## Arch Linux host gate\\n")
    changes.append({"path": str(adapter), "kind": "profile-adapter-append"})
files = [{"path": str(path.relative_to(out)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
         for path in sorted((out / "hubs").rglob("*")) if path.is_file()]
head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
lock = {"schema_version": "1.0.0", "host_profile": args.profile, "prime_agent_dir": new.decode(),
        "hubs": sorted(path.name for path in (out / "hubs").iterdir()), "source_commit": head,
        "changes": changes, "files": files}
(out / "LOCK.host.json").write_text(json.dumps(lock, sort_keys=True, indent=2) + "\\n")
"""


def make_stage(parent: Path, version: str = VERSION) -> Path:
    stage = parent / f"prime-agent-{version}-{PLATFORM}"
    (stage / "prime-agent-runtime" / "src" / "rlm").mkdir(parents=True)
    (stage / "skills").mkdir()
    (stage / "package.json").write_text(json.dumps({"version": version}))
    binary = stage / "prime-agent"
    binary.write_text(FAKE_BINARY)
    binary.chmod(0o755)
    return stage


def files_of(root: Path) -> dict[str, str]:
    return {str(path.relative_to(root)): path.read_text() for path in sorted(root.rglob("*")) if path.is_file()}


def write_executable(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


class Fixture(unittest.TestCase):
    """A throwaway HOME, TMPDIR, /tmp stand-in and XDG data home with a fake
    TS agent dir; the module's HOME-derived roots point into it."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=SHORT_TMP)
        self.root = Path(self.tmp.name).resolve()
        self.saved_env = dict(os.environ)
        self.saved_module = {name: getattr(side_by_side, name)
                             for name in ("HOME", "TS_AGENT_DIR", "SYSTEM_TMP", "SOCKET_PLATFORM")}
        self.saved_cwd = os.getcwd()
        self.home = self.root / "home"
        self.ts_agent = self.home / ".prime" / "agent"
        self.fake_tmp = self.root / "tmp"
        self.system_tmp = self.root / "systmp"
        self.data_home = self.root / "xdg-data"
        for path in (self.fake_tmp, self.system_tmp):
            path.mkdir()
        side_by_side.HOME = self.home
        side_by_side.TS_AGENT_DIR = self.ts_agent
        side_by_side.SYSTEM_TMP = self.system_tmp
        (self.ts_agent / "skills" / "grok").mkdir(parents=True)
        (self.ts_agent / "skills" / "grok" / "SKILL.md").write_text("# grok\n")
        (self.ts_agent / "models.json").write_text('{"providers": {}}')
        (self.ts_agent / "settings.json").write_text('{"theme": "dark"}')
        (self.ts_agent / "auth.json").write_text('{"secret": true}')
        self.prefix = self.root / "share" / "prime-agent-oneiron-rs"
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.ts_target = self.root / "ts-cli.js"
        self.ts_target.write_text("ts")
        (self.bin_dir / "prime-agent").symlink_to(self.ts_target)
        self.agent_dir = self.root / "agent-rs"
        self.sock_dir = self.root / "sock"
        self.venv = self.root / "venv-rs"
        self.stages = 0
        for name in ("PRIME_AGENT_RS_PRINT_ENV", "FAKE_MUTATE_FILE"):
            os.environ.pop(name, None)
        os.environ.update({
            "HOME": str(self.home), "TMPDIR": str(self.fake_tmp), "XDG_DATA_HOME": str(self.data_home),
            "PRIME_AGENT_RS_AGENT_DIR": str(self.agent_dir), "PRIME_AGENT_RS_SOCKET_DIR": str(self.sock_dir),
            "PRIME_AGENT_RS_KERNEL_VENV": str(self.venv),
            # Inherited TS-side or upstream values must never reach the Rust process.
            "PRIME_AGENT_SESSION_DIR": str(self.ts_agent / "sessions"),
            "PRIME_AGENT_DAEMON_SOCKET": "/tmp/prime-agent-ts/daemon.sock",
            "PRIME_AGENT_KERNEL_VENV": "/ts/kernel-venv", "PI_PACKAGE_DIR": "/ts/package",
            "PRIME_AGENT_KERNEL_PYTHON": "/ts/python",
            "PRIME_AGENT_RUST_INSTALLER_URL": "https://example.invalid/install.sh",
            "RLM_SESSION_DIR": str(self.ts_agent / "sessions" / "s1"),
            "RLM_HARNESS_STATE_DIR": str(self.ts_agent / "harness"),
            "RLM_GLOBAL_HARNESS_STATE_DIR": str(self.ts_agent / "harness-global"),
            "PA_COMPACTION_TRACE": str(self.ts_agent / "trace.jsonl"),
            "PA_MCP_LOGIN_URL_FILE": str(self.ts_agent / "login-url"),
            "PA_DAEMON_EVENT_LOG": str(self.ts_agent / "events.jsonl"),
            "PRIME_AGENT_UPDATE_ROSTER": str(self.ts_agent / "update-restarts" / "roster.json"),
            "PRIME_AGENT_INTERNAL_DAEMON_WORKER": "1", "PRIME_AGENT_INTERNAL_SESSION_HANDOFF": "/ts/handoff",
            # A TS-chosen bytecode cache must not survive into the Rust process either.
            "PYTHONPYCACHEPREFIX": "/ts/pycache",
        })

    def tearDown(self) -> None:
        os.chdir(self.saved_cwd)
        for name, value in self.saved_module.items():
            setattr(side_by_side, name, value)
        os.environ.clear()
        os.environ.update(self.saved_env)
        self.tmp.cleanup()

    @contextlib.contextmanager
    def env(self, **values: str):
        saved = {name: os.environ.get(name) for name in values}
        os.environ.update(values)
        try:
            yield
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def run_main(self, *argv: str) -> int:
        return side_by_side.main(["--prefix", str(self.prefix), "--bin-dir", str(self.bin_dir), *argv])

    def stage(self, version: str = VERSION) -> Path:
        self.stages += 1
        parent = self.root / f"stage-{self.stages}"
        parent.mkdir()
        return make_stage(parent, version)

    def install(self, *extra: str, version: str = VERSION) -> None:
        self.assertEqual(self.run_main("install", "--stage-dir", str(self.stage(version)), *extra), 0)

    def receipt(self, version: str = VERSION, name: str = "INSTALL-RECEIPT.json") -> dict:
        return json.loads((self.prefix / "receipts" / f"{version}-{PLATFORM}" / name).read_text())


class InstallerTests(Fixture):
    def test_install_activates_an_isolated_launcher_and_leaves_ts_alone(self) -> None:
        self.install()
        self.assertEqual(os.readlink(self.prefix / "current"), VERSION)
        self.assertEqual(os.readlink(self.bin_dir / "prime-agent"), str(self.ts_target))
        receipt = self.receipt()
        self.assertEqual(
            {key: receipt[key] for key in ("schema", "version", "platform", "activated", "current",
                                           "versionCheck", "agentDir")},
            {"schema": side_by_side.RECEIPT_SCHEMA, "version": VERSION, "platform": PLATFORM,
             "activated": True, "current": {"before": None, "after": VERSION},
             "versionCheck": {"stdout": VERSION, "exitCode": 0, "ok": True},
             "agentDir": {"path": str(self.agent_dir), "seeded": {
                 "models.json": f"linked -> {self.ts_agent / 'models.json'}",
                 "skills": {"skillsSource": "snapshot-fallback", "reason": NO_LOCK,
                            "snapshotOf": str(self.ts_agent / "skills"), "skipped": [], "replaced": None},
                 "settings.json": f"copied once from {self.ts_agent / 'settings.json'}"}}})
        self.assertEqual(receipt["tsLauncher"]["before"], {"kind": "symlink", "target": str(self.ts_target)})
        self.assertEqual(receipt["tsLauncher"]["before"], receipt["tsLauncher"]["after"])

    def test_version_stamp_pins_the_installed_manifest(self) -> None:
        stage = make_stage(self.root, "0.9.8")
        self.assertEqual(self.run_main("install", "--stage-dir", str(stage), "--version", VERSION), 0)
        self.assertEqual(json.loads((self.prefix / VERSION / "package.json").read_text()), {"version": VERSION})
        self.assertEqual(json.loads((stage / "package.json").read_text()), {"version": "0.9.8"})
        receipt = self.receipt()
        self.assertEqual((receipt["version"], receipt["stagedVersion"], receipt["versionCheck"]["ok"]),
                         (VERSION, "0.9.8", True))

    def test_version_stamp_must_extend_the_staged_version(self) -> None:
        stage = make_stage(self.root, "0.9.8")
        with self.assertRaisesRegex(SystemExit, "must extend the staged version"):
            self.run_main("install", "--stage-dir", str(stage), "--version", "0.9.9-oneiron.20261001.1")
        self.assertFalse(self.prefix.exists())

    def test_installs_are_immutable(self) -> None:
        stage = make_stage(self.root)
        self.assertEqual(self.run_main("install", "--stage-dir", str(stage)), 0)
        with self.assertRaisesRegex(SystemExit, "immutable"):
            self.run_main("install", "--stage-dir", str(stage))

    def test_second_release_records_the_previous_current(self) -> None:
        self.install()
        newer = "0.9.8-oneiron.20261001.2"
        self.install(version=newer)
        self.assertEqual(self.receipt(newer)["current"], {"before": VERSION, "after": newer})
        self.assertEqual((os.readlink(self.prefix / "current"), os.readlink(self.prefix / "previous")),
                         (newer, VERSION))

    def test_no_activate_copies_without_launcher_or_current(self) -> None:
        self.install("--no-activate")
        self.assertTrue((self.prefix / VERSION / "prime-agent").is_file())
        self.assertFalse((self.prefix / "current").exists())
        self.assertFalse((self.bin_dir / "prime-agent-rs").exists())
        self.assertFalse(self.agent_dir.exists())

    def test_tarball_install_matches_the_staged_layout(self) -> None:
        stage = make_stage(self.root)
        tarball = self.root / f"{stage.name}.tar.gz"
        with tarfile.open(tarball, "w:gz") as archive:
            for path in sorted(stage.rglob("*")):
                archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)
        self.assertEqual(self.run_main("install", "--tarball", str(tarball)), 0)
        self.assertEqual(
            sorted(str(p.relative_to(self.prefix / VERSION)) for p in (self.prefix / VERSION).rglob("*")),
            sorted(str(p.relative_to(stage)) for p in stage.rglob("*")))

    def test_tarball_members_are_checked_before_anything_is_extracted(self) -> None:
        stage = make_stage(self.root)
        outside = self.root / "outside.txt"

        def link(info: tarfile.TarInfo) -> None:
            info.type, info.linkname = tarfile.SYMTYPE, str(outside)

        def hardlink(info: tarfile.TarInfo) -> None:
            info.type, info.linkname = tarfile.LNKTYPE, "package.json"

        def fifo(info: tarfile.TarInfo) -> None:
            info.type = tarfile.FIFOTYPE

        for label, name, shape in (("symlink", "evil", link), ("hardlink", "evil", hardlink),
                                   ("fifo", "evil", fifo), ("parent", "../evil", None),
                                   ("absolute", str(outside), None), ("duplicate", "package.json", None)):
            with self.subTest(label):
                tarball = self.root / f"{stage.name}.tar.gz"
                with tarfile.open(tarball, "w:gz") as archive:
                    for path in sorted(stage.rglob("*")):
                        archive.add(path, arcname=str(path.relative_to(stage)), recursive=False)
                    info = tarfile.TarInfo(name)
                    if shape is not None:
                        shape(info)
                    archive.addfile(info, io.BytesIO(b"") if info.isfile() else None)
                with self.assertRaisesRegex(SystemExit, "unsafe tarball member"):
                    self.run_main("install", "--tarball", str(tarball))
                self.assertFalse(outside.exists())
                self.assertFalse(self.prefix.exists())

    def test_install_seeds_an_isolated_agent_dir_once(self) -> None:
        self.install()
        self.assertEqual(os.readlink(self.agent_dir / "models.json"), str(self.ts_agent / "models.json"))
        self.assertEqual(files_of(self.agent_dir / "skills"), {"grok/SKILL.md": "# grok\n"})
        self.assertEqual(json.loads((self.agent_dir / "settings.json").read_text()), {"theme": "dark"})
        # python-cache: the bytecode cache the install's launcher run created.
        self.assertEqual(sorted(os.listdir(self.agent_dir)), ["models.json", "python-cache", "settings.json", "skills"])
        # A later install keeps the Rust side's own settings edits.
        (self.agent_dir / "settings.json").write_text('{"theme": "light"}')
        self.install(version="0.9.8-oneiron.20261001.2")
        self.assertEqual(json.loads((self.agent_dir / "settings.json").read_text()), {"theme": "light"})

    def test_skills_snapshot_copies_files_never_links_and_leaves_ts_skills_alone(self) -> None:
        skills = self.ts_agent / "skills"
        (skills / "grok" / "src" / "grok").mkdir(parents=True)
        (skills / "grok" / "src" / "grok" / "__init__.py").write_text("X = 1\n")
        for junk in ("grok/__pycache__/m.cpython-313.pyc", "grok/src/grok.egg-info/PKG-INFO",
                     "grok/.venv/pyvenv.cfg", "grok/node_modules/x/index.js", "grok/.pytest_cache/README.md"):
            (skills / junk).parent.mkdir(parents=True, exist_ok=True)
            (skills / junk).write_text("junk")
        (skills / "grok" / ".venv" / "python").symlink_to(sys.executable)
        (self.ts_agent / "shared.md").write_text("# shared\n")
        (skills / "linked.md").symlink_to("../shared.md")  # relative, to a file outside the skills dir
        extra = self.root / "extra-skill"
        extra.mkdir()
        (extra / "SKILL.md").write_text("# extra\n")
        (skills / "extra").symlink_to(extra)  # a dir elsewhere
        (skills / "loop").symlink_to(".")
        (skills / "dangling.md").symlink_to("missing.md")
        ts_before = side_by_side.tree_identity(self.ts_agent)
        self.install()
        snapshot = self.agent_dir / "skills"
        self.assertEqual(files_of(snapshot), {"extra/SKILL.md": "# extra\n", "grok/SKILL.md": "# grok\n",
                                              "grok/src/grok/__init__.py": "X = 1\n", "linked.md": "# shared\n"})
        self.assertEqual(side_by_side.tree_links(snapshot), [])
        self.assertEqual(self.receipt()["agentDir"]["seeded"]["skills"],
                         {"skillsSource": "snapshot-fallback", "reason": NO_LOCK,
                          "snapshotOf": str(skills), "replaced": None,
                          "skipped": [str(skills / "dangling.md"), f"{skills / 'loop'} (link cycle)"]})
        # The kernel's editable install and imports write beside the skill
        # source: in the snapshot, never in the TS tree.
        (snapshot / "grok" / "__pycache__").mkdir()
        (snapshot / "grok" / "__pycache__" / "x.cpython-313.pyc").write_bytes(b"pyc")
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)

    def test_old_skills_link_is_replaced_by_a_snapshot(self) -> None:
        self.agent_dir.mkdir()
        (self.agent_dir / "skills").symlink_to(self.ts_agent / "skills")
        ts_before = side_by_side.tree_identity(self.ts_agent)
        self.install()
        self.assertFalse((self.agent_dir / "skills").is_symlink())
        self.assertEqual(files_of(self.agent_dir / "skills"), {"grok/SKILL.md": "# grok\n"})
        self.assertEqual(self.receipt()["agentDir"]["seeded"]["skills"]["replaced"],
                         f"link -> {self.ts_agent / 'skills'}")
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)

    def test_existing_snapshot_is_kept_unless_refreshed(self) -> None:
        self.install()
        (self.agent_dir / "skills" / "local.md").write_text("mine")
        (self.ts_agent / "skills" / "new").mkdir()
        (self.ts_agent / "skills" / "new" / "SKILL.md").write_text("# new\n")
        second, third = "0.9.8-oneiron.20261001.2", "0.9.8-oneiron.20261001.3"
        self.install(version=second)
        self.assertEqual(files_of(self.agent_dir / "skills"), {"grok/SKILL.md": "# grok\n", "local.md": "mine"})
        self.assertEqual(self.receipt(second)["agentDir"]["seeded"]["skills"],
                         "kept (install --refresh-skills replaces it)")
        self.install("--refresh-skills", version=third)
        self.assertEqual(files_of(self.agent_dir / "skills"), {"grok/SKILL.md": "# grok\n", "new/SKILL.md": "# new\n"})
        self.assertEqual(self.receipt(third)["agentDir"]["seeded"]["skills"]["replaced"], "snapshot")
        self.assertEqual(sorted(os.listdir(self.agent_dir)), ["models.json", "python-cache", "settings.json", "skills"])

    def test_every_destination_role_refuses_every_protected_root(self) -> None:
        roots = side_by_side.protected_roots()
        self.assertEqual(roots, [
            self.fake_tmp / f"prime-agent-{os.getuid()}", self.system_tmp / f"prime-agent-{os.getuid()}",
            self.fake_tmp / "prime-agent-user", self.system_tmp / "prime-agent-user", self.ts_agent,
            self.data_home / "prime" / "agent", self.home / ".local" / "share" / "prime" / "agent",
            self.home / ".local" / "share" / "prime-agent-oneiron"])
        stage = make_stage(self.root)
        before = side_by_side.tree_identity(self.root)
        for root in roots:
            for target in (root, root / "inner", root.parent):
                for role, argv, env in (("prefix", ["--prefix", str(target)], {}),
                                        ("bin dir", ["--bin-dir", str(target)], {}),
                                        ("agent dir", [], {"PRIME_AGENT_RS_AGENT_DIR": str(target)}),
                                        ("socket dir", [], {"PRIME_AGENT_RS_SOCKET_DIR": str(target)}),
                                        ("kernel venv", [], {"PRIME_AGENT_RS_KERNEL_VENV": str(target)})):
                    with self.subTest(role=role, target=str(target)), self.env(**env):
                        with self.assertRaisesRegex(SystemExit, f"refusing {role} .*: it overlaps TS state at"):
                            self.run_main(*argv, "install", "--stage-dir", str(stage))
        self.assertEqual(side_by_side.tree_identity(self.root), before)

    def test_relative_and_dotted_paths_are_refused_before_any_write(self) -> None:
        os.chdir(self.root)
        stage = make_stage(self.root)
        before = side_by_side.tree_identity(self.root)
        absolute = "must be an absolute path"
        components = "must not hold empty, . or .. components"
        values = (("relative/dir", absolute), (f"{self.root}/./x", components),
                  (f"{self.root}/x/../y", components), (f"{self.root}//x", components))
        for name in ("PRIME_AGENT_RS_AGENT_DIR", "PRIME_AGENT_RS_SOCKET_DIR", "PRIME_AGENT_RS_KERNEL_VENV",
                     "TMPDIR", "--prefix", "--bin-dir", "XDG_DATA_HOME"):
            for value, message in values:
                if name == "XDG_DATA_HOME" and message == absolute:
                    continue  # a relative XDG_DATA_HOME is ignored, as the XDG spec says
                argv = [name, value] if name.startswith("--") else []
                env = {} if name.startswith("--") else {name: value}
                with self.subTest(name=name, value=value), self.env(**env):
                    with self.assertRaisesRegex(SystemExit, f"{re.escape(name)} {message}"):
                        self.run_main(*argv, "install", "--stage-dir", str(stage))
        self.assertEqual(side_by_side.tree_identity(self.root), before)

    def test_installer_refuses_a_link_to_a_missing_dir(self) -> None:
        link = self.root / "dangling"
        link.symlink_to(self.fake_tmp / f"prime-agent-{os.getuid()}")
        stage = make_stage(self.root)
        for name in ("PRIME_AGENT_RS_AGENT_DIR", "PRIME_AGENT_RS_SOCKET_DIR", "PRIME_AGENT_RS_KERNEL_VENV"):
            for value in (link, link / "inner"):
                with self.subTest(name=name, value=str(value)), self.env(**{name: str(value)}):
                    with self.assertRaisesRegex(SystemExit, f"{re.escape(str(link))} is a link but not to a dir"):
                        self.run_main("install", "--stage-dir", str(stage))
        self.assertEqual(os.listdir(self.fake_tmp), [])
        self.assertFalse(self.prefix.exists())

    def test_seeding_never_writes_into_the_xdg_ts_agent_dir(self) -> None:
        xdg_agent = self.data_home / "prime" / "agent"
        xdg_agent.mkdir(parents=True)
        with self.env(PRIME_AGENT_RS_AGENT_DIR=str(xdg_agent)):
            with self.assertRaisesRegex(SystemExit, "refusing agent dir .*: it overlaps TS state"):
                self.run_main("install", "--stage-dir", str(make_stage(self.root)))
        self.assertEqual(os.listdir(xdg_agent), [])
        self.assertFalse(self.prefix.exists())

    def test_installer_refuses_links_out_of_the_agent_dir(self) -> None:
        sessions = self.ts_agent / "sessions" / "--cwd--"
        sessions.mkdir(parents=True)
        (sessions / "s.jsonl").write_text("{}\n")
        stage = make_stage(self.root)
        ts_before = side_by_side.tree_identity(self.ts_agent)
        cases = {
            "sessions": lambda link: link.symlink_to(self.ts_agent / "sessions"),
            "sessions/--cwd--/s.jsonl": lambda link: link.symlink_to(sessions / "s.jsonl"),
            "models.json": lambda link: link.symlink_to(self.ts_agent / "sessions"),  # a dir, not a file
        }
        for rel, make in cases.items():
            with self.subTest(rel):
                shutil.rmtree(self.agent_dir, ignore_errors=True)
                link = self.agent_dir / rel
                link.parent.mkdir(parents=True)
                make(link)
                with self.assertRaisesRegex(SystemExit, "only models.json may be a link in it, found: "
                                                        f"{re.escape(str(link))}$"):
                    self.run_main("install", "--stage-dir", str(stage))
                self.assertFalse(self.prefix.exists())
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)

    @unittest.skipIf(os.geteuid() == 0, "root reads a mode-000 dir")
    def test_installer_refuses_an_agent_dir_it_cannot_scan(self) -> None:
        locked = self.agent_dir / "locked"
        locked.mkdir(parents=True)
        locked.chmod(0)
        try:
            with self.assertRaisesRegex(SystemExit, f"cannot scan {re.escape(str(self.agent_dir))} for links"):
                self.run_main("install", "--stage-dir", str(make_stage(self.root)))
        finally:
            locked.chmod(0o700)
        self.assertFalse(self.prefix.exists())

    def test_installer_admits_uv_links_in_the_kernel_venv_but_no_dir_leading_out(self) -> None:
        os.environ.pop("PRIME_AGENT_RS_KERNEL_VENV")
        venv = self.agent_dir / "kernel-venv"
        site = venv / "lib" / "python3.13" / "site-packages"
        site.mkdir(parents=True)
        (venv / "bin").mkdir()
        (venv / "lib64").symlink_to("lib")
        (venv / "bin" / "python").symlink_to(sys.executable)
        self.install()
        ts_site = self.ts_agent / "kernel-venv" / "lib" / "python3.13" / "site-packages"
        ts_site.mkdir(parents=True)
        shutil.rmtree(site)
        site.symlink_to(ts_site)
        newer = self.stage("0.9.8-oneiron.20261001.2")
        with self.assertRaisesRegex(SystemExit, f"refusing kernel venv {re.escape(str(venv))}: "
                                                f"a linked dir in it leads out of it: {re.escape(str(site))}$"):
            self.run_main("install", "--stage-dir", str(newer))
        with self.env(PRIME_AGENT_RS_KERNEL_VENV=str(self.agent_dir)):
            with self.assertRaisesRegex(SystemExit, "it holds the agent dir"):
                self.run_main("install", "--stage-dir", str(newer))
        self.assertEqual(os.listdir(ts_site), [])

    def test_installer_refuses_links_in_the_prefix(self) -> None:
        self.prefix.mkdir(parents=True)
        (self.prefix / "receipts").symlink_to(self.ts_agent)
        ts_before = side_by_side.tree_identity(self.ts_agent)
        with self.assertRaisesRegex(SystemExit, "only `current` and `previous` may be links in it, "
                                                "found: .*/receipts$"):
            self.run_main("install", "--stage-dir", str(make_stage(self.root)))
        self.assertEqual(os.listdir(self.prefix), ["receipts"])
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)

    def test_launcher_may_not_alias_the_ts_launcher(self) -> None:
        (self.bin_dir / "prime-agent-rs").symlink_to(self.ts_target)
        with self.assertRaisesRegex(SystemExit, "would alias the TS prime-agent launcher"):
            self.run_main("install", "--stage-dir", str(make_stage(self.root)))
        self.assertFalse(self.prefix.exists())

    def test_launcher_is_never_written_through_a_planted_temp_link(self) -> None:
        protected = self.ts_agent / "settings.json"
        protected.chmod(0o600)
        before = (protected.read_bytes(), stat.S_IMODE(protected.stat().st_mode))
        planted = self.bin_dir / f".prime-agent-rs.tmp-{os.getpid()}"
        planted.symlink_to(protected)
        self.install()
        self.assertEqual((protected.read_bytes(), stat.S_IMODE(protected.stat().st_mode)), before)
        launcher = self.bin_dir / "prime-agent-rs"
        self.assertFalse(launcher.is_symlink())
        self.assertEqual(stat.S_IMODE(launcher.stat().st_mode), 0o755)
        self.assertTrue(launcher.read_text().startswith("#!/bin/sh\n# prime-agent-rs:"))
        self.assertEqual(sorted(path.name for path in self.bin_dir.iterdir()),
                         sorted(["prime-agent", "prime-agent-rs", planted.name]))
        self.assertEqual(os.readlink(planted), str(protected))

    def test_version_labels_cannot_escape_the_prefix(self) -> None:
        stage = make_stage(self.root, "0.9.8")
        for version in ("0.9.8-/../../escape", "0.9.8-a/b", "0.9.8-.."):
            with self.assertRaisesRegex(SystemExit, "not a plain release version"):
                self.run_main("install", "--stage-dir", str(stage), "--version", version)
        self.assertFalse(self.prefix.exists())

    def test_symlinked_stage_assets_are_refused_and_the_target_is_untouched(self) -> None:
        outside = self.root / "outside.json"
        outside.write_text(json.dumps({"version": "0.9.8"}))
        stage = make_stage(self.root, "0.9.8")
        (stage / "package.json").unlink()
        (stage / "package.json").symlink_to(outside)
        with self.assertRaisesRegex(SystemExit, "holds a symlink"):
            self.run_main("install", "--stage-dir", str(stage), "--version", VERSION)
        self.assertEqual(json.loads(outside.read_text()), {"version": "0.9.8"})
        self.assertFalse(self.prefix.exists())

    def test_tree_identity_sees_an_in_place_same_size_rewrite(self) -> None:
        tree = self.root / "venv"
        module = tree / "lib" / "m.py"
        module.parent.mkdir(parents=True)
        module.write_text("x")
        os.utime(module, ns=(OLD_NS, OLD_NS))
        before = side_by_side.tree_identity(tree)
        module.write_text("y")
        after = side_by_side.tree_identity(tree)
        self.assertNotEqual(after, before)
        self.assertEqual(side_by_side.identity_changes(before, after), ["lib/m.py"])
        self.assertEqual(side_by_side.identity_digest(before)["entries"], 3)
        self.assertIsNone(side_by_side.tree_identity(self.root / "absent"))

    def test_tree_identity_sees_a_same_size_replacement_with_its_mtime_restored(self) -> None:
        tree = self.root / "venv"
        module = tree / "lib" / "m.py"
        module.parent.mkdir(parents=True)
        module.write_text("x")
        os.utime(module, ns=(OLD_NS, OLD_NS))
        before = side_by_side.tree_identity(tree)
        replacement = module.with_name(".m.py.new")
        replacement.write_text("y")
        os.utime(replacement, ns=(OLD_NS, OLD_NS))
        os.replace(replacement, module)
        os.utime(module.parent, ns=(OLD_NS, OLD_NS))
        after = side_by_side.tree_identity(tree)

        def row(lines: list[str], path: str) -> list[str]:
            return next(line.split("\t") for line in lines if line.split("\t", 1)[0] == path)

        # Path, type, size and mtime all match; the inode and ctime do not.
        self.assertEqual(row(after, "lib/m.py")[:4], row(before, "lib/m.py")[:4])
        self.assertIn("lib/m.py", side_by_side.identity_changes(before, after))

    def test_response_models_reads_every_event(self) -> None:
        stream = "\n".join([
            json.dumps({"type": "session", "id": "x"}),
            "not json",
            json.dumps({"type": "message_end", "message": {"responseModel": "gpt-6.1-sol"}}),
            json.dumps({"type": "agent_end", "messages": [{"role": "assistant", "responseModel": "gpt-6.1-sol"}]}),
        ])
        self.assertEqual(side_by_side.response_models(stream), ["gpt-6.1-sol", "gpt-6.1-sol"])


class SkillHubTests(Fixture):
    """Hub categories rendered for the Rust agent dir from a fake hubs checkout
    whose TS deploy (alpha, beta and the lock at the top of skills/) was made
    at an older commit than its HEAD."""

    def setUp(self) -> None:
        super().setUp()
        os.environ.update({"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
        self.ts_skills = self.ts_agent / "skills"
        self.repo = self.root / "hubs-repo"
        write_executable(self.repo / "scripts" / "render-host.py", FAKE_RENDER)
        alpha = self.repo / "hubs" / "alpha"
        alpha.mkdir(parents=True)
        (alpha / "SKILL.md").write_text("# alpha v1\nsee /Users/olety/.prime/agent/skills/alpha/ROUTES.md\n")
        (alpha / "ROUTES.md").write_text("routes\n")
        (self.repo / "hubs" / "beta").mkdir()
        (self.repo / "hubs" / "beta" / "SKILL.md").write_text("# beta\n")
        self.git("init", "--quiet")
        self.commit = self.commit_all("hubs v1")
        rendered = self.root / "ts-render"
        subprocess.run([sys.executable, str(self.repo / "scripts" / "render-host.py"), "--prime-agent-dir",
                        str(self.ts_agent), "--output", str(rendered), "--profile", "arch-linux"], check=True)
        for hub in ("alpha", "beta"):
            (rendered / "hubs" / hub).rename(self.ts_skills / hub)
        (rendered / "LOCK.host.json").rename(self.ts_skills / "LOCK.host.json")
        (alpha / "SKILL.md").write_text("# alpha v2\n")
        self.commit_all("hubs v2")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=test", "-c",
                               "user.email=test@example.invalid", "-c", "commit.gpgsign=false", *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit_all(self, message: str) -> str:
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    def test_hubs_are_rendered_for_the_rust_agent_dir_at_the_ts_lock_commit(self) -> None:
        repo_before = side_by_side.tree_identity(self.repo)
        ts_before = side_by_side.tree_identity(self.ts_agent)
        self.install("--skill-hubs", str(self.repo))
        skills = self.agent_dir / "skills"
        files = files_of(skills)
        lock = json.loads(files.pop("LOCK.host.json"))
        self.assertEqual(files, {"alpha/SKILL.md": f"# alpha v1\nsee {self.agent_dir}/skills/alpha/ROUTES.md\n",
                                 "alpha/ROUTES.md": "routes\n", "beta/SKILL.md": "# beta\n\n## Arch Linux host gate\n",
                                 "grok/SKILL.md": "# grok\n"})
        self.assertEqual({key: lock[key] for key in ("prime_agent_dir", "source_commit", "host_profile", "hubs")},
                         {"prime_agent_dir": str(self.agent_dir), "source_commit": self.commit,
                          "host_profile": "arch-linux", "hubs": ["alpha", "beta"]})
        self.assertEqual(self.receipt()["agentDir"]["seeded"]["skills"], {
            "skillsSource": "hub-render", "hubsRepo": str(self.repo), "hubsCommit": self.commit,
            "hostProfile": "arch-linux", "hubs": ["alpha", "beta"],
            "lockSha256": side_by_side.sha256_file(skills / "LOCK.host.json"),
            "snapshotOf": str(self.ts_skills), "skipped": [], "replaced": None})
        # The checkout (its HEAD, branch and refs included) and the TS tree are only read.
        self.assertEqual(side_by_side.tree_identity(self.repo), repo_before)
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)

    def test_skills_fall_back_to_a_snapshot_when_the_hubs_cannot_be_rendered(self) -> None:
        lock_path = self.ts_skills / "LOCK.host.json"
        lock_text = lock_path.read_text()
        lock = json.loads(lock_text)
        missing = "0" * 40
        tampered = {**lock, "files": [{**entry, "sha256": "0" * 64} if entry["path"] == "hubs/alpha/ROUTES.md"
                                      else entry for entry in lock["files"]]}
        absent = self.root / "absent"
        cases = (
            ("no checkout", lambda: None, absent, f"^no hubs checkout at {re.escape(str(absent))}$"),
            ("missing commit", lambda: lock_path.write_text(json.dumps({**lock, "source_commit": missing})),
             self.repo, f"^checking out {missing} failed"),
            ("no lock", lock_path.unlink, self.repo, f"^{NO_LOCK}$"),
            ("malformed lock", lambda: lock_path.write_text(json.dumps({**lock, "files": None})), self.repo,
             "^the TS LOCK.host.json is not a render-host.py lock \\(files and changes records\\)$"),
            ("render differs", lambda: lock_path.write_text(json.dumps(tampered)), self.repo,
             f"^the render differs from the TS deploy at {self.commit} in 1 files, e.g. hubs/alpha/ROUTES.md$"),
        )
        for index, (name, prepare, repo, reason) in enumerate(cases, start=1):
            with self.subTest(name):
                lock_path.write_text(lock_text)
                prepare()
                agent_dir = self.root / f"agent-{index}"
                version = f"0.9.8-oneiron.20261001.{index}"
                with self.env(PRIME_AGENT_RS_AGENT_DIR=str(agent_dir)):
                    self.install("--skill-hubs", str(repo), version=version)
                seeded = self.receipt(version)["agentDir"]["seeded"]["skills"]
                self.assertRegex(seeded.pop("reason"), reason)
                self.assertEqual(seeded, {"skillsSource": "snapshot-fallback", "snapshotOf": str(self.ts_skills),
                                          "skipped": [], "replaced": None})
                self.assertEqual(files_of(agent_dir / "skills"), files_of(self.ts_skills))

    def test_skills_fall_back_to_a_snapshot_when_the_renderer_cannot_start(self) -> None:
        with mock.patch.object(side_by_side.sys, "executable", str(self.root / "no-python")):
            self.install("--skill-hubs", str(self.repo))
        seeded = self.receipt()["agentDir"]["seeded"]["skills"]
        self.assertRegex(seeded.pop("reason"), "^render-host.py could not start: ")
        self.assertEqual(seeded, {"skillsSource": "snapshot-fallback", "snapshotOf": str(self.ts_skills),
                                  "skipped": [], "replaced": None})
        self.assertEqual(files_of(self.agent_dir / "skills"), files_of(self.ts_skills))


class LauncherTests(Fixture):
    """The generated launcher, run through its #!/bin/sh line; the subclasses
    run it under `bash --posix` and dash."""

    shell: tuple[str, ...] = ()

    def setUp(self) -> None:
        super().setUp()
        self.install()

    def run_launcher(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run([*self.shell, str(self.bin_dir / "prime-agent-rs"), *args], capture_output=True,
                              text=True, cwd=self.root, env={**os.environ, **env})

    def launcher_env(self, **env: str) -> dict[str, str]:
        result = self.run_launcher("env", **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return dict(line.split("=", 1) for line in result.stdout.splitlines())

    def assert_refused(self, pattern: str, **env: str) -> None:
        result = self.run_launcher("env", **env)
        self.assertEqual((result.returncode, result.stdout), (1, ""), env)
        self.assertRegex(result.stderr, pattern)

    def test_launcher_exports_the_isolation_env_and_clears_inherited_sinks(self) -> None:
        self.assertEqual(self.launcher_env(), {
            "SOCKET_DIR": str(self.sock_dir),
            "DAEMON_SOCKET": str(self.sock_dir / "daemon.sock"),
            "KERNEL_VENV": str(self.venv),
            "SKIP": "1",
            "PACKAGE_DIR": "unset",
            "NO_UPDATE": "1",
            "INSTALLER": "http://127.0.0.1:1/oneiron-self-update-disabled",
            "DOWNLOAD": "http://127.0.0.1:1/oneiron-feed-disabled",
            "KERNEL_PYTHON": "unset",
            "AGENT_DIR": str(self.agent_dir),
            "SESSION_DIR": "unset",
            "RLM_SESSION_DIR": "unset",
            "RLM_HARNESS_STATE_DIR": "unset",
            "RLM_GLOBAL_HARNESS_STATE_DIR": "unset",
            "PA_COMPACTION_TRACE": "unset",
            "PA_MCP_LOGIN_URL_FILE": "unset",
            "PA_DAEMON_EVENT_LOG": "unset",
            "ROSTER": "unset",
            "INTERNAL": "",
            "PYCACHE": str(self.agent_dir / "python-cache"),
        })
        self.assertEqual(stat.S_IMODE(self.sock_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.agent_dir / "python-cache").stat().st_mode), 0o700)

    def test_launcher_follows_a_safe_alias_and_exports_its_canonical_target(self) -> None:
        # Aliases resolve before the checks (macOS TMPDIR itself sits behind
        # /var -> /private/var); ownership and TS overlap are judged on the
        # canonical target, which is what the process receives.
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.sock_dir.rmdir()
        self.sock_dir.symlink_to(elsewhere)
        self.assertEqual(self.launcher_env()["SOCKET_DIR"], str(elsewhere))

    def test_launcher_refuses_every_protected_root_for_every_role(self) -> None:
        roots = side_by_side.protected_roots()
        self.assertEqual(len(roots), 8)
        before = {path: side_by_side.tree_identity(path) for path in (self.home, self.fake_tmp, self.system_tmp)}
        for root in roots:
            for target in (root, root / "inner", root.parent):
                for role, name in (("socket dir", "PRIME_AGENT_RS_SOCKET_DIR"),
                                   ("agent dir", "PRIME_AGENT_RS_AGENT_DIR"),
                                   ("kernel venv", "PRIME_AGENT_RS_KERNEL_VENV")):
                    with self.subTest(role=role, target=str(target)):
                        self.assert_refused(f"refusing {role} .*: it overlaps TS state at", **{name: str(target)})
        self.assertEqual({path: side_by_side.tree_identity(path) for path in before}, before)

    def test_launcher_refuses_relative_and_dotted_paths_without_creating_anything(self) -> None:
        before = side_by_side.tree_identity(self.root)
        absolute = "must be an absolute path"
        components = "must not hold empty, . or .. components"
        values = (("relative/dir", absolute), (f"{self.root}/./x", components),
                  (f"{self.root}/x/../y", components), (f"{self.root}//x", components))
        for name in ("PRIME_AGENT_RS_SOCKET_DIR", "PRIME_AGENT_RS_AGENT_DIR", "PRIME_AGENT_RS_KERNEL_VENV",
                     "HOME", "TMPDIR", "XDG_DATA_HOME"):
            for value, message in values:
                if name == "XDG_DATA_HOME" and message == absolute:
                    continue  # a relative XDG_DATA_HOME is ignored, as the XDG spec says
                with self.subTest(name=name, value=value):
                    self.assert_refused(f"{name} {message}", **{name: value})
        self.assertEqual(side_by_side.tree_identity(self.root), before)

    def test_launcher_refuses_a_missing_dir_dotdot_into_the_ts_socket_dir(self) -> None:
        ts_sock = self.fake_tmp / f"prime-agent-{os.getuid()}"
        ts_sock.mkdir()
        ts_sock.chmod(0o755)
        self.assert_refused("PRIME_AGENT_RS_SOCKET_DIR must not hold empty, . or .. components",
                            PRIME_AGENT_RS_SOCKET_DIR=f"{self.fake_tmp}/missing/../prime-agent-{os.getuid()}")
        self.assertEqual(stat.S_IMODE(ts_sock.stat().st_mode), 0o755)
        self.assertEqual(os.listdir(self.fake_tmp), [ts_sock.name])

    def test_launcher_refuses_a_link_to_a_missing_dir(self) -> None:
        link = self.root / "dangling"
        link.symlink_to(self.fake_tmp / f"prime-agent-{os.getuid()}")
        for name in ("PRIME_AGENT_RS_SOCKET_DIR", "PRIME_AGENT_RS_AGENT_DIR", "PRIME_AGENT_RS_KERNEL_VENV"):
            for value in (link, link / "inner"):
                with self.subTest(name=name, value=str(value)):
                    self.assert_refused(f"{re.escape(str(link))} is a link but not to a dir", **{name: str(value)})
        self.assertEqual(os.listdir(self.fake_tmp), [])

    def test_launcher_refuses_links_out_of_the_agent_dir(self) -> None:
        sessions = self.ts_agent / "sessions" / "--cwd--"
        sessions.mkdir(parents=True)
        (sessions / "s.jsonl").write_text("{}\n")
        ts_before = side_by_side.tree_identity(self.ts_agent)
        cases = {
            "sessions": self.ts_agent / "sessions",
            "sessions/--cwd--/s.jsonl": sessions / "s.jsonl",
            "models.json": self.ts_agent / "sessions",  # a dir, not a file
            "skills": self.ts_agent / "skills",  # the old layout's link
        }
        for index, (rel, target) in enumerate(cases.items()):
            with self.subTest(rel):
                agent_dir = self.root / f"agent-case-{index}"
                link = agent_dir / rel
                link.parent.mkdir(parents=True)
                link.symlink_to(target)
                self.assert_refused(f"refusing agent dir {re.escape(str(agent_dir))}: only models.json may be a "
                                    f"link in it, found: {re.escape(str(link))}$",
                                    PRIME_AGENT_RS_AGENT_DIR=str(agent_dir))
        self.assertEqual(self.launcher_env()["AGENT_DIR"], str(self.agent_dir))  # models.json -> a file: fine
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)

    def test_launcher_refuses_links_whose_names_hold_a_newline(self) -> None:
        os.environ.pop("PRIME_AGENT_RS_KERNEL_VENV")
        venv = self.agent_dir / "kernel-venv"
        (venv / "lib").mkdir(parents=True)
        escape = venv / "escape\n"
        escape.symlink_to(self.ts_agent)
        self.assert_refused(f"refusing kernel venv {re.escape(str(venv))}: a linked dir in it leads out of it: "
                            f"{re.escape(str(escape))}")
        escape.unlink()
        named = self.agent_dir / "esc\nape"
        named.symlink_to(self.ts_agent)
        self.assert_refused(f"refusing agent dir {re.escape(str(self.agent_dir))}: only models.json may be a link "
                            f"in it, found: {re.escape(str(named))}")
        named.unlink()
        self.assertEqual(self.launcher_env()["KERNEL_VENV"], str(venv))

    def test_launcher_refuses_a_python_cache_that_leads_out_of_the_agent_dir(self) -> None:
        # Bytecode is written wherever the cache resolves: a link out of the
        # Rust agent dir (into TS state, here) is refused before any run.
        cache = self.agent_dir / "python-cache"
        cache.rmdir()  # the install's own launcher run created it, empty
        cache.symlink_to(self.ts_agent, target_is_directory=True)
        before = side_by_side.tree_identity(self.ts_agent)
        self.assert_refused(f"refusing Python cache {re.escape(str(self.ts_agent))}: it resolves outside the "
                            f"agent dir {re.escape(str(self.agent_dir))}")
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), before)

    def test_launcher_refuses_a_link_below_the_python_cache(self) -> None:
        # Python follows a dir link below the cache root too (bytecode for
        # /tmp/x.py lands at <cache>/tmp/x.pyc): a planted <cache>/tmp -> TS
        # state is an agent-dir link like any other.
        link = self.agent_dir / "python-cache" / "tmp"
        link.symlink_to(self.ts_agent, target_is_directory=True)
        before = side_by_side.tree_identity(self.ts_agent)
        self.assert_refused(f"refusing agent dir {re.escape(str(self.agent_dir))}: only models.json may be a link "
                            f"in it, found: {re.escape(str(link))}$")
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), before)

    @unittest.skipIf(os.geteuid() == 0, "root reads a mode-000 dir")
    def test_launcher_refuses_an_agent_dir_it_cannot_scan(self) -> None:
        locked = self.agent_dir / "locked"
        locked.mkdir()
        locked.chmod(0)
        try:
            self.assert_refused(f"cannot scan the agent dir {re.escape(str(self.agent_dir))} for links")
        finally:
            locked.chmod(0o700)

    def test_launcher_admits_uv_links_in_the_kernel_venv_but_no_dir_leading_out(self) -> None:
        os.environ.pop("PRIME_AGENT_RS_KERNEL_VENV")
        venv = self.agent_dir / "kernel-venv"
        site = venv / "lib" / "python3.13" / "site-packages"
        site.mkdir(parents=True)
        (venv / "bin").mkdir()
        (venv / "lib64").symlink_to("lib")
        (venv / "bin" / "python").symlink_to(sys.executable)
        self.assertEqual(self.launcher_env()["KERNEL_VENV"], str(venv))
        ts_site = self.ts_agent / "kernel-venv" / "lib" / "python3.13" / "site-packages"
        ts_site.mkdir(parents=True)
        shutil.rmtree(site)
        site.symlink_to(ts_site)
        self.assert_refused(f"refusing kernel venv {re.escape(str(venv))}: a linked dir in it leads out of it: "
                            f"{re.escape(str(site))}$")
        self.assert_refused("it holds the agent dir", PRIME_AGENT_RS_KERNEL_VENV=str(self.agent_dir))
        self.assertEqual(os.listdir(ts_site), [])


    def render_for(self, platform: str) -> None:
        """Rewrite the launcher as the installer renders it on `platform`."""
        side_by_side.SOCKET_PLATFORM = platform
        side_by_side.write_launcher(self.bin_dir, self.prefix)

    def test_launcher_default_socket_dir_is_short_on_darwin_and_tmpdir_on_linux(self) -> None:
        # A macOS-deep TMPDIR: under it the longest socket path would not fit.
        deep_tmp = self.fake_tmp / ("T" * 60)
        deep_tmp.mkdir()
        uid = os.getuid()
        for platform, expected in (("darwin", self.system_tmp / f"pa-rs-{uid}"),
                                   ("linux", self.fake_tmp / f"pa-rs-{uid}")):
            with self.subTest(platform=platform):
                self.render_for(platform)
                tmpdir = str(deep_tmp) if platform == "darwin" else str(self.fake_tmp)
                env = self.launcher_env(PRIME_AGENT_RS_SOCKET_DIR="", TMPDIR=tmpdir)
                self.assertEqual((env["SOCKET_DIR"], env["DAEMON_SOCKET"]),
                                 (str(expected), str(expected / "daemon.sock")))
                self.assertEqual(stat.S_IMODE(expected.stat().st_mode), 0o700)

    def test_launcher_socket_budget_is_bytes_with_the_nul_per_platform(self) -> None:
        name = side_by_side.LONGEST_SOCKET_NAME
        for platform, limit in (("darwin", 104), ("linux", 108)):
            self.render_for(platform)
            at_limit = dir_of_bytes(self.root, limit - 1 - len(name) - 1, "a")
            over = dir_of_bytes(self.root, limit - len(name) - 1, "b")
            # Two-byte characters: under the limit in characters, over it in bytes.
            wide = dir_of_bytes(self.root, limit - len(name) - 1, "\u00e9")
            self.assertLess(len(str(wide / name)) + 1, limit)
            with self.subTest(platform=platform, case="at the limit"):
                self.assertEqual(self.launcher_env(PRIME_AGENT_RS_SOCKET_DIR=str(at_limit))["SOCKET_DIR"],
                                 str(at_limit))
            for case, path in (("one byte over", over), ("multi-byte", wide)):
                with self.subTest(platform=platform, case=case):
                    result = self.run_launcher("env", PRIME_AGENT_RS_SOCKET_DIR=str(path))
                    size = len(os.fsencode(path / name))
                    self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", (
                        f"prime-agent-rs: refusing socket dir {path}: its longest socket path ({path}/{name}) is "
                        f"{size} bytes plus the NUL, over the {limit}-byte {platform} sun_path limit; set "
                        f"PRIME_AGENT_RS_SOCKET_DIR to a shorter directory (at most {limit - 2 - len(name)} bytes, "
                        f"e.g. /tmp/pa-rs-{os.getuid()})\n")))
                    self.assertFalse(path.exists(), "nothing is created for a refused socket dir")

    def test_launcher_counts_the_canonical_socket_dir(self) -> None:
        # A short alias of an over-budget dir: the exported (canonical)
        # spelling is what binds, so that is what is counted.
        self.render_for("linux")
        deep = dir_of_bytes(self.root, 108 - len(side_by_side.LONGEST_SOCKET_NAME) - 1, "c")
        deep.mkdir()
        alias = self.root / "s"
        alias.symlink_to(deep)
        self.assert_refused(f"refusing socket dir {re.escape(str(deep))}: its longest socket path",
                            PRIME_AGENT_RS_SOCKET_DIR=str(alias))

    def test_launcher_refuses_ts_socket_dirs_on_darwin_too(self) -> None:
        self.render_for("darwin")
        for base in (self.fake_tmp, self.system_tmp):
            with self.subTest(base=str(base)):
                self.assert_refused("refusing socket dir .*: it overlaps TS state at",
                                    PRIME_AGENT_RS_SOCKET_DIR=str(base / f"prime-agent-{os.getuid()}"))


class LauncherUnderPosixBashTests(LauncherTests):
    shell = ("bash", "--posix")


@unittest.skipUnless(shutil.which("dash"), "dash is not installed")
class LauncherUnderDashTests(LauncherTests):
    shell = ("dash",)


def dir_of_bytes(root: Path, size: int, char: str) -> Path:
    """A path under `root` exactly `size` bytes long (UTF-8), padded with
    `char` (a multi-byte `char` is evened out with leading `x`s)."""
    pad = size - len(os.fsencode(root)) - 1
    width = len(char.encode())
    if pad < width:
        raise AssertionError(f"{root} leaves no room for a {size}-byte dir of {char!r}")
    path = root / ("x" * (pad % width) + char * (pad // width))
    assert len(os.fsencode(path)) == size, path
    return path


class SocketBudgetTests(Fixture):
    """The installer's twin of the launcher's socket dir rules
    (runtime_dirs: install, rollout, rollback and the idle check)."""

    def dirs(self, platform: str, **env: str) -> dict[str, Path]:
        side_by_side.SOCKET_PLATFORM = platform
        with self.env(**env):
            return side_by_side.runtime_dirs()

    def test_default_socket_dir_is_short_on_darwin_and_tmpdir_on_linux(self) -> None:
        deep_tmp = self.fake_tmp / ("T" * 60)
        deep_tmp.mkdir()
        uid = os.getuid()
        self.assertEqual(
            [self.dirs("darwin", PRIME_AGENT_RS_SOCKET_DIR="", TMPDIR=str(deep_tmp))["socket dir"],
             self.dirs("linux", PRIME_AGENT_RS_SOCKET_DIR="")["socket dir"],
             self.dirs("darwin")["socket dir"], self.dirs("linux")["socket dir"]],
            [self.system_tmp / f"pa-rs-{uid}", self.fake_tmp / f"pa-rs-{uid}", self.sock_dir, self.sock_dir])

    def test_socket_budget_is_bytes_with_the_nul_per_platform(self) -> None:
        name = side_by_side.LONGEST_SOCKET_NAME
        self.assertEqual(len(name), 32)
        for platform, limit in (("darwin", 104), ("linux", 108)):
            at_limit = dir_of_bytes(self.root, limit - 1 - len(name) - 1, "a")
            over = dir_of_bytes(self.root, limit - len(name) - 1, "b")
            wide = dir_of_bytes(self.root, limit - len(name) - 1, "\u00e9")
            with self.subTest(platform=platform, case="at the limit"):
                self.assertEqual(self.dirs(platform, PRIME_AGENT_RS_SOCKET_DIR=str(at_limit))["socket dir"],
                                 at_limit)
            for case, path in (("one byte over", over), ("multi-byte", wide)):
                with self.subTest(platform=platform, case=case):
                    size = len(os.fsencode(path / name))
                    with self.assertRaises(SystemExit) as refused:
                        self.dirs(platform, PRIME_AGENT_RS_SOCKET_DIR=str(path))
                    self.assertEqual(str(refused.exception), (
                        f"error: refusing socket dir {path}: its longest socket path ({path}/{name}) is {size} "
                        f"bytes plus the NUL, over the {limit}-byte {platform} sun_path limit; set "
                        f"PRIME_AGENT_RS_SOCKET_DIR to a shorter directory (at most {limit - 2 - len(name)} bytes, "
                        f"e.g. /tmp/pa-rs-{os.getuid()})"))

    def test_an_over_budget_socket_dir_refuses_the_install_before_any_write(self) -> None:
        stage = make_stage(self.root)
        before = side_by_side.tree_identity(self.root)
        over = dir_of_bytes(self.root, 104 - len(side_by_side.LONGEST_SOCKET_NAME) - 1, "b")
        side_by_side.SOCKET_PLATFORM = "darwin"
        with self.env(PRIME_AGENT_RS_SOCKET_DIR=str(over)):
            with self.assertRaisesRegex(SystemExit, "over the 104-byte darwin sun_path limit"):
                self.run_main("install", "--stage-dir", str(stage))
        self.assertEqual(side_by_side.tree_identity(self.root), before)

    def test_ts_socket_dirs_stay_refused_on_darwin(self) -> None:
        for base in (self.fake_tmp, self.system_tmp):
            with self.subTest(base=str(base)):
                with self.assertRaisesRegex(SystemExit, "refusing socket dir .*: it overlaps TS state at"):
                    self.dirs("darwin", PRIME_AGENT_RS_SOCKET_DIR=str(base / f"prime-agent-{os.getuid()}"))


class ProbeTests(Fixture):
    def setUp(self) -> None:
        super().setUp()
        self.install()
        self.ts_venv = self.ts_agent / "kernel-venv"
        self.ts_module = self.ts_venv / "lib" / "python3.13" / "site-packages" / "pkg" / "existing.py"
        self.ts_module.parent.mkdir(parents=True)
        self.ts_module.write_text("x")
        os.utime(self.ts_module, ns=(OLD_NS, OLD_NS))
        (self.ts_venv / "lib64").symlink_to("lib")

    def probe(self, prefix: Path | None = None) -> tuple[int, dict]:
        prefix = prefix or self.prefix
        with contextlib.redirect_stdout(io.StringIO()):
            code = side_by_side.main(["--prefix", str(prefix), "--bin-dir", str(self.bin_dir), "probe"])
        receipt = json.loads((prefix / "receipts" / f"{VERSION}-{PLATFORM}" / "PROBE-RECEIPT.json").read_text())
        return code, receipt

    def checks(self, **failed: bool) -> dict[str, bool]:
        return {name: failed.get(name, True) for name in (
            "agentDirOutsideTsState", "socketDirOutsideTsState", "kernelVenvOutsideTsState",
            "launcherRunsProbedRelease", "selfUpdateDisabled", "tsLauncherUnchanged", "tsKernelVenvsUnchanged")}

    def test_probe_passes_an_isolated_run(self) -> None:
        code, receipt = self.probe()
        self.assertEqual((code, receipt["ok"]), (0, True))
        self.assertEqual(receipt["isolation"]["checks"], self.checks())
        self.assertEqual({name: (run["ok"], run.get("responseModels")) for name, run in receipt["runs"].items()},
                         {"version": (True, None), "oneShot": (True, ["gpt-6.1-sol"])})
        venvs = receipt["isolation"]["tsKernelVenvs"]
        self.assertEqual([venv["path"] for venv in venvs], [str(path) for path in side_by_side.ts_kernel_venvs()])
        self.assertEqual(venvs[0]["before"], venvs[0]["after"])
        self.assertEqual((venvs[0]["before"]["entries"], venvs[0]["changed"]), (7, []))
        self.assertEqual([(venv["before"], venv["after"]) for venv in venvs[1:]], [(None, None), (None, None)])

    def test_probe_fails_when_a_ts_venv_file_changes_in_place(self) -> None:
        with self.env(FAKE_MUTATE_FILE=str(self.ts_module)):
            code, receipt = self.probe()
        self.assertEqual((code, receipt["ok"]), (1, False))
        self.assertEqual(self.ts_module.stat().st_size, 1)  # same size: only the identity moved
        self.assertEqual(receipt["isolation"]["checks"], self.checks(tsKernelVenvsUnchanged=False))
        self.assertTrue(receipt["runs"]["oneShot"]["ok"])
        self.assertEqual(receipt["isolation"]["tsKernelVenvs"][0]["changed"],
                         ["lib/python3.13/site-packages/pkg/existing.py"])

    def test_probe_fails_when_a_ts_venv_file_changes_in_place_and_its_mtime_is_put_back(self) -> None:
        reference = self.root / "old-mtime"
        reference.write_text("")
        os.utime(reference, ns=(OLD_NS, OLD_NS))
        with self.env(FAKE_MUTATE_FILE=str(self.ts_module), FAKE_MTIME_REF=str(reference)):
            code, receipt = self.probe()
        self.assertEqual((code, self.ts_module.read_text()), (1, "y"))
        self.assertEqual((self.ts_module.stat().st_size, self.ts_module.stat().st_mtime_ns), (1, OLD_NS))
        self.assertEqual(receipt["isolation"]["checks"], self.checks(tsKernelVenvsUnchanged=False))
        self.assertEqual(receipt["isolation"]["tsKernelVenvs"][0]["changed"],
                         ["lib/python3.13/site-packages/pkg/existing.py"])

    def test_probe_fails_when_the_launcher_runs_another_release(self) -> None:
        other = self.root / "share" / "other-rs"
        self.assertEqual(side_by_side.main(["--prefix", str(other), "--bin-dir", str(self.bin_dir), "install",
                                            "--no-activate", "--stage-dir", str(self.stage())]), 0)
        (other / "current").symlink_to(VERSION)
        code, receipt = self.probe(other)
        self.assertEqual((code, receipt["ok"]), (1, False))
        self.assertEqual(receipt["isolation"]["checks"], self.checks(launcherRunsProbedRelease=False))
        self.assertEqual(receipt["isolation"]["effective"]["binary"], str(self.prefix / VERSION / "prime-agent"))

    def test_probe_refuses_a_linked_receipts_dir(self) -> None:
        shutil.rmtree(self.prefix / "receipts")
        (self.prefix / "receipts").symlink_to(self.ts_agent)
        ts_before = side_by_side.tree_identity(self.ts_agent)
        with self.assertRaisesRegex(SystemExit, "only `current` and `previous` may be links in it, "
                                                "found: .*/receipts$"):
            self.probe()
        self.assertEqual(side_by_side.tree_identity(self.ts_agent), ts_before)


GATE = HERE / "gate.sh"
STUB_CARGO = """#!/bin/sh
echo "cargo $*" >> "$STUB_OUT/log"
case "$1" in
  build) exit "${STUB_BUILD_EXIT:-0}" ;;
  test)
    env > "$STUB_OUT/env"
    printf '%s\\n' "$PATH" > "$STUB_OUT/path"
    for name in prime-agent sol pa_gate_tool pa_gate_first pa_gate_last; do
      printf '%s=%s\\n' "$name" "$(command -v "$name" || echo absent)"
    done > "$STUB_OUT/which"
    pa_gate_tool > "$STUB_OUT/tool"
    readlink "$(command -v pa_gate_first)" > "$STUB_OUT/first-link"
    exit "${STUB_TEST_EXIT:-0}" ;;
esac
exit 64
"""
STUB_BOOTSTRAP = """#!/bin/sh
echo "bootstrap $*" >> "$STUB_OUT/log"
exit "${STUB_BOOTSTRAP_EXIT:-0}"
"""


def gate_copy(repo: Path, offload: Path, offload_roots: Path) -> Path:
    """gate.sh at <repo>/scripts/oneiron/, its offload kit and accepted
    worktree roots pointed at test paths: the real kit exists on Arch, where
    the real gate would hand cargo to the build boxes."""
    text = GATE.read_text()
    for line, value in (("offload=/home/lexi/w8-opus/offload", f"offload={offload}"),
                        ('offload_roots="/home/lexi/code/oneiron-impl-waves/repos/prime-agent/.claude/worktrees '
                         '/home/lexi/w8-opus"', f'offload_roots="{offload_roots}"')):
        assert text.count(f"\n{line}\n") == 1, line
        text = text.replace(f"\n{line}\n", f"\n{value}\n")
    copy = repo / "scripts" / "oneiron" / "gate.sh"
    write_executable(copy, text)
    return copy


class GateTests(unittest.TestCase):
    """gate.sh's local mode (no offload kit): the sandboxed test step with stub
    cargo/sccache/bootstrap binaries on PATH, no build, no real sccache server,
    no product run."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.gate = gate_copy(self.root / "repo", self.root / "no-offload-kit", self.root / "no-worktrees")
        self.out = self.root / "out"
        self.out.mkdir()
        stubs = self.root / "stubs"
        write_executable(stubs / "cargo", STUB_CARGO)
        write_executable(stubs / "sccache", "#!/bin/sh\nexit 0\n")
        write_executable(self.root / "target" / "debug" / "prime-agent", STUB_BOOTSTRAP)
        # d1 and d3 hold a `prime-agent` (shadowed); d2 sits between them and
        # its pa_gate_tool must keep winning over d3's.
        self.dirs = [self.root / name for name in ("d1", "d2", "d3")]
        write_executable(self.dirs[0] / "prime-agent", "#!/bin/sh\nexit 99\n")
        write_executable(self.dirs[0] / "pa_gate_first", "#!/bin/sh\necho d1\n")
        write_executable(self.dirs[1] / "pa_gate_tool", "#!/bin/sh\necho d2\n")
        for name in ("prime-agent", "sol"):
            write_executable(self.dirs[2] / name, "#!/bin/sh\nexit 99\n")
        write_executable(self.dirs[2] / "pa_gate_tool", "#!/bin/sh\necho d3\n")
        write_executable(self.dirs[2] / "pa_gate_last", "#!/bin/sh\necho d3\n")
        self.path = [str(stubs), *map(str, self.dirs), "/usr/bin", "/bin"]
        self.env = {"PATH": ":".join(self.path), "HOME": str(self.root / "home"),
                    "GATE_TARGET_DIR": str(self.root / "target"), "STUB_OUT": str(self.out), "LANG": "C"}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_gate(self, **env: str) -> tuple[subprocess.CompletedProcess, Path]:
        result = subprocess.run(["bash", str(self.gate), "crates", "pa-core", "--", "some_filter"],
                                capture_output=True, text=True, env={**self.env, **env})
        self.assertTrue(result.stdout.startswith("gate: local mode\n"), result.stdout)
        sandbox = Path(re.search(r"^gate: sandbox (\S+)$", result.stdout, re.M)[1])
        self.addCleanup(shutil.rmtree, sandbox, ignore_errors=True)
        return result, sandbox

    def log(self) -> list[str]:
        return (self.out / "log").read_text().splitlines()

    BUILD = "cargo build --locked --workspace --bins"
    BOOTSTRAP = "bootstrap --prime-agent-bootstrap"
    TEST = "cargo test --locked -p pa-core --no-fail-fast some_filter"

    def test_gate_fails_when_the_build_fails(self) -> None:
        result, sandbox = self.run_gate(STUB_BUILD_EXIT="7")
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual(self.log(), [self.BUILD])
        self.assertNotIn("passed", result.stdout)
        self.assertFalse(sandbox.exists())

    def test_gate_fails_when_the_bootstrap_fails(self) -> None:
        result, sandbox = self.run_gate(STUB_BOOTSTRAP_EXIT="9")
        self.assertEqual(result.returncode, 9, result.stdout + result.stderr)
        self.assertEqual(self.log(), [self.BUILD, self.BOOTSTRAP])
        self.assertNotIn("passed", result.stdout)
        self.assertFalse(sandbox.exists())

    def test_gate_builds_bootstraps_and_tests_in_order(self) -> None:
        result, sandbox = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.log(), [self.BUILD, self.BOOTSTRAP, self.TEST])
        self.assertTrue(result.stdout.endswith("gate: crates passed\n"), result.stdout)
        self.assertFalse(sandbox.exists())

    def test_gate_keeps_a_failed_sandbox_only_on_request(self) -> None:
        result, sandbox = self.run_gate(STUB_TEST_EXIT="5")
        self.assertEqual((result.returncode, sandbox.exists()), (5, False))
        result, sandbox = self.run_gate(STUB_TEST_EXIT="5", GATE_KEEP_SANDBOX="1")
        self.assertEqual((result.returncode, sandbox.exists()), (5, True))
        self.assertIn(f"gate: kept sandbox {sandbox}", result.stdout)

    def test_gate_scrubs_product_and_harness_env_but_keeps_an_explicit_ts_binary(self) -> None:
        inherited = {"PRIME_AGENT_CODING_AGENT_DIR": "/ts/agent", "PI_CODING_AGENT_DIR": "/ts/agent",
                     "RLM_SESSION_DIR": "/ts/s", "RLM_HARNESS_STATE_DIR": "/ts/h", "RLM_CUSTOM": "/ts/c",
                     "RLM_GLOBAL_HARNESS_STATE_DIR": "/ts/g", "PA_COMPACTION_TRACE": "/ts/trace",
                     "PA_MCP_LOGIN_URL_FILE": "/ts/url", "PA_DAEMON_EVENT_LOG": "/ts/log",
                     "PA_TS_REFERENCE": "1", "DO_NOT_TRACK": "1", "PA_TS_BINARY": "/ts/bin/prime-agent"}
        result, sandbox = self.run_gate(**inherited)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        seen = dict(line.split("=", 1) for line in (self.out / "env").read_text().splitlines() if "=" in line)
        self.assertEqual({name: value for name, value in seen.items()
                          if name.startswith(("PRIME_AGENT_", "PI_", "RLM_", "PA_")) or name == "DO_NOT_TRACK"},
                         {"PA_TS_BINARY": "/ts/bin/prime-agent"})
        self.assertEqual((seen["HOME"], seen["TMPDIR"]), (f"{sandbox}/h", f"{sandbox}/t"))

    def test_gate_shadows_each_prime_agent_dir_in_place(self) -> None:
        result, sandbox = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.out / "path").read_text().strip().split(":"),
                         [self.path[0], f"{sandbox}/bin/1", self.path[2], f"{sandbox}/bin/2", "/usr/bin", "/bin"])
        self.assertEqual(dict(line.split("=", 1) for line in (self.out / "which").read_text().splitlines()), {
            "prime-agent": "absent", "sol": "absent", "pa_gate_tool": str(self.dirs[1] / "pa_gate_tool"),
            "pa_gate_first": f"{sandbox}/bin/1/pa_gate_first", "pa_gate_last": f"{sandbox}/bin/2/pa_gate_last"})
        self.assertEqual((self.out / "tool").read_text(), "d2\n")
        self.assertEqual((self.out / "first-link").read_text().strip(), str(self.dirs[0] / "pa_gate_first"))


class OffloadGateTests(unittest.TestCase):
    """gate.sh's offload mode against a fake offload kit: its bin/cargo
    records each call (what the build boxes would run, and from where), and a
    decoy `cargo` earlier on PATH would record any local run."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.out = self.root / "out"
        self.out.mkdir()
        self.kit = self.root / "offload"
        self.worktrees = self.root / "worktrees"
        self.repo = self.worktrees / "lane-x"
        self.gate = gate_copy(self.repo, self.kit, self.worktrees)
        # As the real wrapper: a `[factory-cargo] <host> slot …` line on
        # stderr for the build box that runs an offloaded call
        # (STUB_SLOT_HOST="" stands for a local fallback, which prints none).
        write_executable(self.kit / "bin" / "cargo", """#!/bin/sh
printf '%s|%s|%s|%s\\n' "$*" "$W7_CARGO_WORK" "${W7_CARGO_LOCAL-unset}" "$(pwd -P)" >> "$STUB_OUT/log"
case "$2" in
  test|clippy)
    host=${STUB_SLOT_HOST-box1}
    [ -z "$host" ] || echo "[factory-cargo] $host slot 1/2; at most 8 Cargo jobs" >&2
    exit "${STUB_EXIT:-0}" ;;
esac
""")
        (self.kit / "hosts").write_text("box1:2:8:/home/b/w8-build;\nbox2:2:8:/home/b/w8-build\n")
        self.write_env_sh()
        write_executable(self.root / "decoy" / "cargo", '#!/bin/sh\necho "LOCAL $*" >> "$STUB_OUT/log"\nexit 99\n')
        self.env = {"PATH": f"{self.root / 'decoy'}:/usr/bin:/bin", "HOME": str(self.root / "home"), "LANG": "C",
                    "STUB_OUT": str(self.out), "W7_CARGO_LOCAL": "1",
                    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True, env=self.env)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_env_sh(self, *, path: bool = True, work: bool = True, hosts: str = "") -> None:
        lines = [f"export PATH={self.kit / 'bin'}:$PATH"] if path else []
        lines += [f"export W7_CARGO_WORK={self.kit}"] if work else []
        lines += [f"export W7_CARGO_HOSTS='{hosts}'"] if hosts else []
        (self.kit / "env.sh").write_text("".join(f"{line}\n" for line in lines))

    def run_gate(self, gate: Path | None = None, *args: str, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(gate or self.gate), *args], capture_output=True, text=True,
                              env={**self.env, **env})

    def log(self) -> list[str]:
        log = self.out / "log"
        return log.read_text().splitlines() if log.exists() else []

    def remote(self, args: str) -> str:
        return f"+1.98.1 {args}|{self.kit}|unset|{self.repo}"

    def test_offload_tests_run_on_the_build_boxes_with_no_local_build(self) -> None:
        result = self.run_gate(None, "crates", "pa-core", "pa-cli", "--", "some_filter")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "gate: offload mode (build boxes)\ngate: crates passed\n")
        self.assertEqual(self.log(), [self.remote("test --locked -p pa-core -p pa-cli --no-fail-fast some_filter")])

    def test_offload_clippy_runs_remotely_and_fmt_through_the_wrapper(self) -> None:
        for step in ("fmt", "clippy", "test"):
            result = self.run_gate(None, step)
            self.assertEqual((result.returncode, result.stdout),
                             (0, f"gate: offload mode (build boxes)\ngate: {step} passed\n"), result.stderr)
        self.assertEqual(self.log(), [self.remote("fmt --all --check"),
                                      self.remote("clippy --workspace --all-targets --locked -- -D warnings"),
                                      self.remote("test --locked --workspace --no-fail-fast")])

    def test_offload_failure_is_the_gate_result(self) -> None:
        result = self.run_gate(None, "test", STUB_EXIT="3")
        self.assertEqual(result.returncode, 3)
        self.assertNotIn("passed", result.stdout)

    def test_offload_refuses_every_case_the_wrapper_would_run_here(self) -> None:
        refuse = "gate: offload mode, refusing to run cargo on this host: "
        outside = gate_copy(self.root / "elsewhere" / "lane-y", self.kit, self.worktrees)
        nested = gate_copy(self.worktrees / "a" / "b", self.kit, self.worktrees)
        bare = gate_copy(self.worktrees / "not-a-repo", self.kit, self.worktrees)
        for repo in (outside.parents[2], nested.parents[2]):
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True, env=self.env)
        cases = (
            ("wrapper not first", {"path": False}, None,
             f"cargo on PATH is {self.root / 'decoy' / 'cargo'}, not {self.kit / 'bin' / 'cargo'}"),
            ("no W7_CARGO_WORK", {"work": False}, None, "W7_CARGO_WORK is unset"),
            *((name, {}, gate, f"{gate.parents[2]} is not a worktree the wrapper offloads from")
              for name, gate in (("outside the accepted roots", outside), ("nested below a worktree", nested),
                                 ("not a git worktree", bare))),
        )
        for name, env_sh, gate, message in cases:
            for step in ("test", "clippy"):
                with self.subTest(name, step=step):
                    self.write_env_sh(**env_sh)
                    result = self.run_gate(gate, step)
                    self.assertEqual((result.returncode, result.stdout),
                                     (1, "gate: offload mode (build boxes)\n"), result.stderr)
                    self.assertIn(refuse + message, result.stderr)
                    self.assertEqual(self.log(), [])

    def test_offload_refuses_without_a_remote_build_host(self) -> None:
        refuse = "gate: offload mode, refusing to run cargo on this host: "
        no_host = f"no build host in {self.kit}/hosts (or W7_CARGO_HOSTS)"
        hosts = self.kit / "hosts"
        cases = (
            ("empty hosts file", "", {}, no_host),
            ("malformed entries only", "box1;box2:0:8:/w;box3:2:8:", {}, no_host),
            ("a local entry", "local:1:8:/w;box1:2:8:/w", {}, "the wrapper's hosts list a local entry"),
            # The file wins over W7_CARGO_HOSTS, as in the wrapper.
            ("file over env", "local:1:8:/w", {"hosts": "box1:2:8:/w"}, "the wrapper's hosts list a local entry"),
            ("no file, no env", None, {}, no_host),
        )
        for name, text, env_sh, message in cases:
            for step in ("test", "clippy"):
                with self.subTest(name, step=step):
                    if text is None:
                        hosts.unlink(missing_ok=True)
                    else:
                        hosts.write_text(text)
                    self.write_env_sh(**env_sh)
                    result = self.run_gate(None, step)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn(refuse + message, result.stderr)
                    self.assertEqual(self.log(), [])
        self.write_env_sh(hosts="box1:2:8:/w")
        self.assertEqual(self.run_gate(None, "test").returncode, 0)
        self.assertEqual(self.log(), [self.remote("test --locked --workspace --no-fail-fast")])

    def test_offload_fails_when_cargo_ran_on_this_host(self) -> None:
        for slot_host in ("", "local"):
            for step in ("test", "clippy"):
                with self.subTest(slot_host=slot_host, step=step):
                    result = self.run_gate(None, step, STUB_SLOT_HOST=slot_host)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertNotIn("passed", result.stdout)
                    self.assertIn("gate: offload mode, but cargo ran on this host, not a build box (exit 0); failing",
                                  result.stderr)
        result = self.run_gate(None, "test")
        self.assertEqual(result.returncode, 0)
        self.assertIn("[factory-cargo] box1 slot 1/2; at most 8 Cargo jobs\n", result.stderr)

    def test_offload_refuses_an_explicit_ts_reference(self) -> None:
        message = ("gate: PA_TS_BINARY is set, but an explicit TS reference cannot travel to the build boxes; "
                   "run that comparison in local mode on the Mac")
        for args in (("test",), ("crates", "pa-cli"), ("all",)):
            with self.subTest(args=args):
                result = self.run_gate(None, *args, PA_TS_BINARY="/ts/bin/prime-agent")
                self.assertEqual((result.returncode, result.stdout), (1, "gate: offload mode (build boxes)\n"))
                self.assertIn(message, result.stderr)
                self.assertEqual(self.log(), [])
        result = self.run_gate(None, "clippy", PA_TS_BINARY="/ts/bin/prime-agent")
        self.assertEqual(result.returncode, 0, result.stderr)


class PolicyGateTests(unittest.TestCase):
    def test_checker_gets_the_resolved_sha_not_the_ref(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            write_executable(out / "stubs" / "node", '#!/bin/sh\nprintf %s "$TEST_POLICY_BASE" > "$STUB_OUT/base"\n')
            head = subprocess.run(["git", "-C", str(test_policy_gate.ROOT), "rev-parse", "HEAD"], check=True,
                                  capture_output=True, text=True).stdout.strip()
            saved = dict(os.environ)
            os.environ.update({"TEST_POLICY_BASE": "HEAD", "STUB_OUT": str(out),
                               "PATH": f"{out / 'stubs'}:{os.environ['PATH']}"})
            try:
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    code = test_policy_gate.main([])
            finally:
                os.environ.clear()
                os.environ.update(saved)
            self.assertEqual((code, (out / "base").read_text()), (0, head))
            self.assertIn(f"against HEAD ({head[:12]})", printed.getvalue())


if __name__ == "__main__":
    unittest.main()
