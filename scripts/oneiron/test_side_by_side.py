#!/usr/bin/env python3
"""Contract tests for scripts/oneiron/side_by_side.py (run: python3 scripts/oneiron/test_side_by_side.py)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import side_by_side  # noqa: E402

VERSION = "0.9.8-oneiron.20261001.1"
PLATFORM = "linux-x64"

# The fake binary prints the exe-adjacent manifest version (as the real one
# does), or the isolation env it was launched with, so the launcher's exports
# are asserted on what the process really saw.
FAKE_BINARY = """#!/bin/sh
if [ "$1" = "--version" ]; then
  sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$(dirname "$0")/package.json"; exit 0
fi
if [ "$1" = "env" ]; then
  printf '%s\\n' "SOCKET_DIR=$PRIME_AGENT_SOCKET_DIR" "DAEMON_SOCKET=$PRIME_AGENT_DAEMON_SOCKET" \\
    "KERNEL_VENV=$PRIME_AGENT_KERNEL_VENV" "SKIP=$PI_SKIP_VERSION_CHECK" "PACKAGE_DIR=${PI_PACKAGE_DIR-unset}" \\
    "NO_UPDATE=$PRIME_AGENT_DISABLE_SELF_UPDATE" "INSTALLER=$PRIME_AGENT_RUST_INSTALLER_URL" \\
    "DOWNLOAD=$PRIME_AGENT_DOWNLOAD_BASE_URL" "KERNEL_PYTHON=${PRIME_AGENT_KERNEL_PYTHON-unset}"
  exit 0
fi
exit 3
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


class SideBySideTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prefix = self.root / "share" / "prime-agent-oneiron-rs"
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.ts_target = self.root / "ts-cli.js"
        self.ts_target.write_text("ts")
        (self.bin_dir / "prime-agent").symlink_to(self.ts_target)
        self.sock_dir = self.root / "sock"
        self.fake_tmp = self.root / "tmp"
        self.fake_tmp.mkdir()
        self.saved_env = {key: os.environ.get(key) for key in
                          ("PRIME_AGENT_RS_SOCKET_DIR", "PRIME_AGENT_RS_KERNEL_VENV",
                           "PRIME_AGENT_DAEMON_SOCKET", "PRIME_AGENT_KERNEL_VENV", "PI_PACKAGE_DIR",
                           "PRIME_AGENT_KERNEL_PYTHON", "PRIME_AGENT_RUST_INSTALLER_URL", "TMPDIR",
                           "PRIME_AGENT_RS_PRINT_ENV")}
        os.environ["TMPDIR"] = str(self.fake_tmp)
        os.environ["PRIME_AGENT_RS_SOCKET_DIR"] = str(self.sock_dir)
        os.environ["PRIME_AGENT_RS_KERNEL_VENV"] = str(self.root / "venv-rs")
        # Inherited TS-side or upstream values must never reach the Rust process.
        os.environ["PRIME_AGENT_DAEMON_SOCKET"] = "/tmp/prime-agent-ts/daemon.sock"
        os.environ["PRIME_AGENT_KERNEL_VENV"] = "/ts/kernel-venv"
        os.environ["PI_PACKAGE_DIR"] = "/ts/package"
        os.environ["PRIME_AGENT_KERNEL_PYTHON"] = "/ts/python"
        os.environ["PRIME_AGENT_RUST_INSTALLER_URL"] = "https://example.invalid/install.sh"

    def tearDown(self) -> None:
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def run_main(self, *argv: str) -> int:
        return side_by_side.main(["--prefix", str(self.prefix), "--bin-dir", str(self.bin_dir), *argv])

    def launcher_env(self) -> dict[str, str]:
        out = subprocess.run([str(self.bin_dir / "prime-agent-rs"), "env"], check=True,
                             capture_output=True, text=True).stdout
        return dict(line.split("=", 1) for line in out.splitlines())

    def test_install_activates_an_isolated_launcher_and_leaves_ts_alone(self) -> None:
        stage = make_stage(self.root)
        self.assertEqual(self.run_main("install", "--stage-dir", str(stage)), 0)

        self.assertEqual(os.readlink(self.prefix / "current"), VERSION)
        self.assertEqual(os.readlink(self.bin_dir / "prime-agent"), str(self.ts_target))
        self.assertEqual(self.launcher_env(), {
            "SOCKET_DIR": str(self.sock_dir.resolve()),
            "DAEMON_SOCKET": str(self.sock_dir.resolve() / "daemon.sock"),
            "KERNEL_VENV": str((self.root / "venv-rs").resolve()),
            "SKIP": "1",
            "PACKAGE_DIR": "unset",
            "NO_UPDATE": "1",
            "INSTALLER": "http://127.0.0.1:1/oneiron-self-update-disabled",
            "DOWNLOAD": "http://127.0.0.1:1/oneiron-feed-disabled",
            "KERNEL_PYTHON": "unset",
        })
        self.assertEqual(oct(self.sock_dir.stat().st_mode & 0o777), oct(0o700))
        receipt = json.loads((self.prefix / "receipts" / f"{VERSION}-{PLATFORM}" /
                              "INSTALL-RECEIPT.json").read_text())
        self.assertEqual(
            {key: receipt[key] for key in ("schema", "version", "platform", "activated", "current",
                                           "versionCheck")},
            {"schema": side_by_side.RECEIPT_SCHEMA, "version": VERSION, "platform": PLATFORM,
             "activated": True, "current": {"before": None, "after": VERSION},
             "versionCheck": {"stdout": VERSION, "exitCode": 0, "ok": True}})
        self.assertEqual(receipt["tsLauncher"]["before"], {"kind": "symlink", "target": str(self.ts_target)})
        self.assertEqual(receipt["tsLauncher"]["before"], receipt["tsLauncher"]["after"])

    def test_version_stamp_pins_the_installed_manifest(self) -> None:
        stage = make_stage(self.root, "0.9.8")
        self.assertEqual(self.run_main("install", "--stage-dir", str(stage), "--version", VERSION), 0)
        self.assertEqual(json.loads((self.prefix / VERSION / "package.json").read_text()), {"version": VERSION})
        self.assertEqual(json.loads((stage / "package.json").read_text()), {"version": "0.9.8"})
        receipt = json.loads((self.prefix / "receipts" / f"{VERSION}-{PLATFORM}" /
                              "INSTALL-RECEIPT.json").read_text())
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
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        newer = "0.9.8-oneiron.20261001.2"
        (self.root / "b").mkdir()
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root / "b", newer))), 0)
        receipt = json.loads((self.prefix / "receipts" / f"{newer}-{PLATFORM}" /
                              "INSTALL-RECEIPT.json").read_text())
        self.assertEqual(receipt["current"], {"before": VERSION, "after": newer})
        self.assertEqual(os.readlink(self.prefix / "current"), newer)

    def test_no_activate_copies_without_launcher_or_current(self) -> None:
        self.assertEqual(self.run_main("install", "--no-activate", "--stage-dir", str(make_stage(self.root))), 0)
        self.assertTrue((self.prefix / VERSION / "prime-agent").is_file())
        self.assertFalse((self.prefix / "current").exists())
        self.assertFalse((self.bin_dir / "prime-agent-rs").exists())

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

    def test_prefix_overlapping_the_ts_tree_is_refused(self) -> None:
        with self.assertRaisesRegex(SystemExit, "overlaps protected TS state"):
            side_by_side.check_prefix(side_by_side.TS_PREFIX / "rs", self.bin_dir)

    def test_launcher_follows_a_safe_alias_and_exports_its_canonical_target(self) -> None:
        # Aliases resolve before the checks (macOS TMPDIR itself sits behind
        # /var -> /private/var); ownership and TS overlap are judged on the
        # canonical target, which is what the process receives.
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.sock_dir.rmdir()
        self.sock_dir.symlink_to(elsewhere)
        self.assertEqual(self.launcher_env()["SOCKET_DIR"], str(elsewhere.resolve()))

    def run_launcher(self, **env: str) -> subprocess.CompletedProcess:
        home = self.root / "home"
        home.mkdir(exist_ok=True)
        return subprocess.run([str(self.bin_dir / "prime-agent-rs"), "env"], capture_output=True, text=True,
                              env={**os.environ, "HOME": str(home), **env})

    def test_launcher_refuses_relative_overrides_without_creating_anything(self) -> None:
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        for name in ("PRIME_AGENT_RS_SOCKET_DIR", "PRIME_AGENT_RS_KERNEL_VENV"):
            result = self.run_launcher(**{name: "relative/dir"})
            self.assertEqual((result.returncode, result.stdout), (1, ""))
            self.assertIn(f"{name} must be an absolute path", result.stderr)
        self.assertFalse((self.root / "relative").exists())

    def test_launcher_refuses_ts_socket_dir_directly_and_through_an_alias(self) -> None:
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        ts_sock = self.fake_tmp / f"prime-agent-{os.getuid()}"
        ts_sock.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(ts_sock)
        for override in (ts_sock, ts_sock / "inner", alias / "inner", self.root / "home" / ".prime" / "x"):
            result = self.run_launcher(PRIME_AGENT_RS_SOCKET_DIR=str(override))
            self.assertEqual(result.returncode, 1, override)
            self.assertIn("overlaps TS state", result.stderr)
        self.assertEqual(sorted(os.listdir(ts_sock)), [])

    def test_launcher_refuses_the_ts_kernel_venv(self) -> None:
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        home = self.root / "home"
        for override in (home / ".prime" / "agent" / "kernel-venv",
                         home / ".prime" / "agent" / "kernel-venv" / "nested",
                         home / ".local" / "share" / "prime" / "agent" / "kernel-venv"):
            result = self.run_launcher(PRIME_AGENT_RS_KERNEL_VENV=str(override))
            self.assertEqual(result.returncode, 1, override)
            self.assertIn("overlaps the TS kernel venv", result.stderr)

    def test_launcher_print_env_reports_the_effective_isolation(self) -> None:
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        os.environ.pop("PRIME_AGENT_RS_KERNEL_VENV")
        effective = side_by_side.launcher_env(self.bin_dir / "prime-agent-rs")
        self.assertEqual(
            {key: effective[key] for key in ("PRIME_AGENT_SOCKET_DIR", "PRIME_AGENT_DAEMON_SOCKET",
                                             "PRIME_AGENT_KERNEL_VENV", "PRIME_AGENT_DISABLE_SELF_UPDATE")},
            {"PRIME_AGENT_SOCKET_DIR": str(self.sock_dir.resolve()),
             "PRIME_AGENT_DAEMON_SOCKET": f"{self.sock_dir.resolve()}/daemon.sock",
             "PRIME_AGENT_KERNEL_VENV": str(Path.home().resolve() / ".prime" / "agent" / "kernel-venv-rs"),
             "PRIME_AGENT_DISABLE_SELF_UPDATE": "1"})
        self.assertEqual(effective["binary"], str((self.prefix / VERSION / "prime-agent").resolve()))

    def test_installer_refuses_protected_destinations(self) -> None:
        ts_sock = self.fake_tmp / f"prime-agent-{os.getuid()}"
        for prefix in (side_by_side.HOME / ".prime" / "rs", ts_sock / "rs", side_by_side.TS_PREFIX):
            with self.assertRaisesRegex(SystemExit, "overlaps protected TS state"):
                side_by_side.check_prefix(prefix, self.bin_dir)
        with self.assertRaisesRegex(SystemExit, "sits inside protected TS state"):
            side_by_side.check_prefix(self.prefix, side_by_side.HOME / ".prime" / "bin")
        self.assertFalse(ts_sock.exists())

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

    def test_venv_fingerprint_moves_when_site_packages_change(self) -> None:
        venv = self.root / "venv"
        site = venv / "lib" / "python3.13" / "site-packages"
        site.mkdir(parents=True)
        (venv / "bin").mkdir()
        (venv / "pyvenv.cfg").write_text("home = /usr/bin\n")
        before = side_by_side.venv_fingerprint(venv)
        (site / "newpkg").mkdir()
        self.assertNotEqual(side_by_side.venv_fingerprint(venv), before)
        self.assertIsNone(side_by_side.venv_fingerprint(self.root / "absent"))

    def test_response_models_reads_every_event(self) -> None:
        stream = "\n".join([
            json.dumps({"type": "session", "id": "x"}),
            "not json",
            json.dumps({"type": "message_end", "message": {"responseModel": "gpt-6.1-sol"}}),
            json.dumps({"type": "agent_end", "messages": [{"role": "assistant", "responseModel": "gpt-6.1-sol"}]}),
        ])
        self.assertEqual(side_by_side.response_models(stream), ["gpt-6.1-sol", "gpt-6.1-sol"])


if __name__ == "__main__":
    unittest.main()
