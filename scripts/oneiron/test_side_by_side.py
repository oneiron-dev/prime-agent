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
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import side_by_side  # noqa: E402
import test_policy_gate  # noqa: E402

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
    "DOWNLOAD=$PRIME_AGENT_DOWNLOAD_BASE_URL" "KERNEL_PYTHON=${PRIME_AGENT_KERNEL_PYTHON-unset}" \\
    "AGENT_DIR=$PRIME_AGENT_CODING_AGENT_DIR" "SESSION_DIR=${PRIME_AGENT_SESSION_DIR-unset}"
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


def write_executable(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


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
                           "PRIME_AGENT_RS_PRINT_ENV", "PRIME_AGENT_RS_AGENT_DIR", "PRIME_AGENT_SESSION_DIR")}
        os.environ["TMPDIR"] = str(self.fake_tmp)
        # A fake TS agent dir to seed from, and a temp Rust agent dir.
        self.ts_agent = self.root / "ts-agent"
        (self.ts_agent / "skills" / "grok").mkdir(parents=True)
        (self.ts_agent / "models.json").write_text('{"providers": {}}')
        (self.ts_agent / "settings.json").write_text('{"theme": "dark"}')
        (self.ts_agent / "auth.json").write_text('{"secret": true}')
        self.saved_ts_agent = side_by_side.TS_AGENT_DIR
        side_by_side.TS_AGENT_DIR = self.ts_agent
        self.agent_dir = self.root / "agent-rs"
        os.environ["PRIME_AGENT_RS_AGENT_DIR"] = str(self.agent_dir)
        os.environ["PRIME_AGENT_SESSION_DIR"] = str(self.ts_agent / "sessions")
        os.environ["PRIME_AGENT_RS_SOCKET_DIR"] = str(self.sock_dir)
        os.environ["PRIME_AGENT_RS_KERNEL_VENV"] = str(self.root / "venv-rs")
        # Inherited TS-side or upstream values must never reach the Rust process.
        os.environ["PRIME_AGENT_DAEMON_SOCKET"] = "/tmp/prime-agent-ts/daemon.sock"
        os.environ["PRIME_AGENT_KERNEL_VENV"] = "/ts/kernel-venv"
        os.environ["PI_PACKAGE_DIR"] = "/ts/package"
        os.environ["PRIME_AGENT_KERNEL_PYTHON"] = "/ts/python"
        os.environ["PRIME_AGENT_RUST_INSTALLER_URL"] = "https://example.invalid/install.sh"

    def tearDown(self) -> None:
        side_by_side.TS_AGENT_DIR = self.saved_ts_agent
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
            "AGENT_DIR": str(self.agent_dir.resolve()),
            "SESSION_DIR": "unset",
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
             "PRIME_AGENT_KERNEL_VENV": str(self.agent_dir.resolve() / "kernel-venv"),
             "PRIME_AGENT_DISABLE_SELF_UPDATE": "1"})
        self.assertEqual(effective["binary"], str((self.prefix / VERSION / "prime-agent").resolve()))

    def test_install_seeds_an_isolated_agent_dir_once(self) -> None:
        self.assertEqual(self.run_main("install", "--stage-dir", str(make_stage(self.root))), 0)
        self.assertEqual(
            {name: os.readlink(self.agent_dir / name) for name in ("models.json", "skills")},
            {"models.json": str(self.ts_agent / "models.json"), "skills": str(self.ts_agent / "skills")})
        self.assertEqual(json.loads((self.agent_dir / "settings.json").read_text()), {"theme": "dark"})
        self.assertFalse((self.agent_dir / "settings.json").is_symlink())
        self.assertFalse((self.agent_dir / "auth.json").exists())
        # A later install keeps the Rust side's own settings edits.
        (self.agent_dir / "settings.json").write_text('{"theme": "light"}')
        (self.root / "b").mkdir()
        self.assertEqual(self.run_main("install", "--stage-dir",
                                       str(make_stage(self.root / "b", "0.9.8-oneiron.20261001.2"))), 0)
        self.assertEqual(json.loads((self.agent_dir / "settings.json").read_text()), {"theme": "light"})

    def test_agent_dir_overlapping_the_ts_agent_dir_is_refused(self) -> None:
        stage = make_stage(self.root)
        os.environ["PRIME_AGENT_RS_AGENT_DIR"] = str(self.ts_agent / "rs")
        with self.assertRaisesRegex(SystemExit, "overlaps the TS agent dir"):
            self.run_main("install", "--stage-dir", str(stage))
        self.assertFalse((self.ts_agent / "rs").exists())
        os.environ["PRIME_AGENT_RS_AGENT_DIR"] = str(self.agent_dir)
        shutil.rmtree(self.prefix)
        self.assertEqual(self.run_main("install", "--stage-dir", str(stage)), 0)
        home = self.root / "home"
        result = self.run_launcher(PRIME_AGENT_RS_AGENT_DIR=str(home / ".prime" / "agent"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("overlaps the TS agent dir", result.stderr)

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


class GateTests(unittest.TestCase):
    """gate.sh's sandboxed test step with stub cargo/sccache/bootstrap binaries
    on PATH: no build, no real sccache server, no product run."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
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
        self.path = [str(stubs), *map(str, self.dirs), "/usr/bin"]
        self.env = {"PATH": ":".join(self.path), "HOME": str(self.root / "home"),
                    "GATE_TARGET_DIR": str(self.root / "target"), "STUB_OUT": str(self.out), "LANG": "C"}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_gate(self, **env: str) -> tuple[subprocess.CompletedProcess, Path]:
        result = subprocess.run(["bash", str(GATE), "crates", "pa-core", "--", "some_filter"], capture_output=True,
                                text=True, env={**self.env, **env})
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
                         [self.path[0], f"{sandbox}/bin/1", self.path[2], f"{sandbox}/bin/2", "/usr/bin"])
        self.assertEqual(dict(line.split("=", 1) for line in (self.out / "which").read_text().splitlines()), {
            "prime-agent": "absent", "sol": "absent", "pa_gate_tool": str(self.dirs[1] / "pa_gate_tool"),
            "pa_gate_first": f"{sandbox}/bin/1/pa_gate_first", "pa_gate_last": f"{sandbox}/bin/2/pa_gate_last"})
        self.assertEqual((self.out / "tool").read_text(), "d2\n")
        self.assertEqual((self.out / "first-link").read_text().strip(), str(self.dirs[0] / "pa_gate_first"))


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
