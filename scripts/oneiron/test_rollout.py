#!/usr/bin/env python3
"""Contract tests for `side_by_side.py rollout|rollback|status` (rollout.py, daemon_idle.py).

Run: python3 scripts/oneiron/test_rollout.py. Every path is a temp dir (HOME,
TMPDIR, the system temp root, the TS launcher and agent dir, the prefix, the
feed); the Rust "daemon" is a scripted unix-socket server speaking the
hello/list/shutdown frames; the binary is release_feed's fake. No network,
no real daemon, no real prefix.
"""

from __future__ import annotations

import contextlib
import fcntl
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daemon_idle  # noqa: E402
import release_feed  # noqa: E402
import rollout  # noqa: E402
import side_by_side  # noqa: E402
import test_release_feed as fixtures  # noqa: E402

PLATFORM = fixtures.PLATFORM
V1 = "0.9.8-oneiron.20261001.1"
V2 = "0.9.8-oneiron.20261001.2"
ENV_KEYS = ("HOME", "TMPDIR", "XDG_DATA_HOME", "PRIME_AGENT_RS_AGENT_DIR", "PRIME_AGENT_RS_SOCKET_DIR",
            "PRIME_AGENT_RS_KERNEL_VENV", "FAKE_PROBE_FAIL", "FAKE_PROBE_MUTATE", "PI_PACKAGE_DIR",
            "PRIME_AGENT_KERNEL_PYTHON", "PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")


class FakeRustDaemon:
    """A scripted supervisor on a unix socket: connection N gets hellos[N]
    (the last one repeats) and `list` gets `sessions` (after on_list runs);
    any other command is answered with a failure. It serves exactly
    `connections` connections and records every request it reads."""

    def __init__(self, path: Path, hellos: list[dict], sessions: list, connections: int,
                 on_list: Callable[[], None] | None = None) -> None:
        self.path = path
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(8)
        self.hellos, self.sessions, self.on_list, self.received = hellos, sessions, on_list, []
        self.thread = threading.Thread(target=self.serve, args=(connections,), daemon=True)
        self.thread.start()

    def serve(self, connections: int) -> None:
        for index in range(connections):
            conn, _ = self.server.accept()
            with conn, conn.makefile("rb") as reader:
                conn.sendall((json.dumps(self.hellos[min(index, len(self.hellos) - 1)]) + "\n").encode())
                for line in reader:
                    request = json.loads(line)
                    self.received.append(request)
                    kind = request["command"]["type"]
                    response = {"type": "response", "id": request["id"], "command": kind, "success": kind == "list"}
                    if kind == "list":
                        if self.on_list is not None:
                            self.on_list()
                        response["data"] = {"sessions": self.sessions}
                    conn.sendall((json.dumps(response) + "\n").encode())

    def finish(self) -> None:
        self.thread.join(timeout=30)
        alive = self.thread.is_alive()
        self.server.close()
        if alive:
            raise AssertionError("the fake daemon did not see the expected connections")


class RolloutFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.fake_tmp = self.root / "tmp"
        self.fake_tmp.mkdir()
        self.system_tmp = self.root / "systmp"
        self.system_tmp.mkdir()
        self.saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ("FAKE_PROBE_FAIL", "FAKE_PROBE_MUTATE", "PI_PACKAGE_DIR", "PRIME_AGENT_KERNEL_PYTHON",
                    "PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX"):
            os.environ.pop(key, None)
        os.environ.update({
            "HOME": str(self.home), "TMPDIR": str(self.fake_tmp),
            "XDG_DATA_HOME": str(self.home / ".local" / "share"),
            "PRIME_AGENT_RS_AGENT_DIR": str(self.root / "agent-rs"),
            # Short: a unix socket path must fit sun_path.
            "PRIME_AGENT_RS_SOCKET_DIR": str(self.root / "s"),
            "PRIME_AGENT_RS_KERNEL_VENV": str(self.root / "venv-rs"),
        })
        self.saved = (side_by_side.HOME, side_by_side.TS_AGENT_DIR, side_by_side.SYSTEM_TMP,
                      release_feed.host_platform)
        side_by_side.HOME = self.home
        side_by_side.TS_AGENT_DIR = self.home / ".prime" / "agent"
        side_by_side.SYSTEM_TMP = self.system_tmp
        side_by_side.TS_AGENT_DIR.mkdir(parents=True)
        (side_by_side.TS_AGENT_DIR / "models.json").write_text('{"providers": {}}')
        (side_by_side.TS_AGENT_DIR / "auth.json").write_text('{"secret": true}')
        release_feed.host_platform = lambda: PLATFORM
        self.prefix = self.root / "share" / "prime-agent-oneiron-rs"
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.ts_target = self.root / "ts-cli.js"
        self.ts_target.write_text("ts")
        (self.bin_dir / "prime-agent").symlink_to(self.ts_target)
        self.socket_path = self.root / "s" / "daemon.sock"
        self.source = fixtures.make_source_repo(self.root / "src")

    def tearDown(self) -> None:
        (side_by_side.HOME, side_by_side.TS_AGENT_DIR, side_by_side.SYSTEM_TMP,
         release_feed.host_platform) = self.saved
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def main(self, *argv: str) -> int:
        return side_by_side.main(["--prefix", str(self.prefix), "--bin-dir", str(self.bin_dir), *argv])

    def publish(self, version: str) -> None:
        package_dir = fixtures.make_package_dir(self.root / f"pkg-{version}")
        self.assertEqual(self.main("package", "--package-dir", str(package_dir), "--version", version,
                                   "--source-root", str(self.source), "--allow-fixture-catalog"), 0)

    def receipt(self, version: str, name: str = "ACTIVATION-RECEIPT.json") -> dict:
        return json.loads((self.prefix / "receipts" / f"{version}-{PLATFORM}" / name).read_text())

    def launcher_version(self) -> str:
        return subprocess.run([str(self.bin_dir / "prime-agent-rs"), "--version"], check=True,
                              capture_output=True, text=True).stdout.strip()

    def rust_hello(self, version: str = V1, pid: int = 4242) -> dict:
        """The real supervisor's hello: appVersion is the compiled Cargo
        version, the release shows only in the executable path."""
        return {"type": "daemon_hello", "socketPath": str(self.socket_path),
                "protocol": {"name": "prime-agent.daemon", "version": 7}, "schemaId": "protocol-7-schema-28",
                "appVersion": "0.9.8", "supervisorPid": pid, "supervisorProcessStartId": f"start-{pid}",
                "runtime": {"buildId": "pa-daemon-rs-0.9.8",
                            "executablePath": str(self.prefix / version / "prime-agent")},
                "clientId": "c", "serverCapabilities": []}

    def daemon(self, sessions: list, connections: int, hellos: list[dict] | None = None,
               on_list: Callable[[], None] | None = None) -> FakeRustDaemon:
        self.socket_path.parent.mkdir(exist_ok=True)
        return FakeRustDaemon(self.socket_path, hellos or [self.rust_hello()], sessions, connections, on_list)


class RolloutTests(RolloutFixture):
    def test_rollout_verifies_installs_probes_then_selects(self) -> None:
        self.publish(V1)
        ts_before = side_by_side.link_state(self.bin_dir / "prime-agent")
        self.assertEqual(self.main("rollout", "--version", V1), 0)

        self.assertEqual((os.readlink(self.prefix / "current"), self.launcher_version()), (V1, V1))
        self.assertFalse((self.prefix / "previous").is_symlink())
        receipt = self.receipt(V1)
        release = self.prefix / "feed" / "releases" / f"v{V1}"
        manifest = json.loads((release / "manifest.json").read_text())
        launcher_after = side_by_side.link_state(self.bin_dir / "prime-agent-rs")
        self.assertEqual({key: receipt[key] for key in (
            "schema", "status", "phase", "failure", "version", "platform", "checks", "before", "after",
            "install", "launcherVersion")}, {
            "schema": rollout.ACTIVATION_SCHEMA, "status": "activated", "phase": "old-daemon", "failure": None,
            "version": V1, "platform": PLATFORM,
            "checks": {"releaseVerified": True, "idleBeforeInstall": True, "payloadMatchesRelease": True,
                       "probeOk": True, "idleBeforeSelect": True, "payloadUnchangedAtSelect": True,
                       "launcherVersion": True, "tsLauncherUnchanged": True},
            "before": {"current": None, "previous": None, "launcher": {"kind": "absent"}, "tsLauncher": ts_before},
            "after": {"current": V1, "previous": None, "launcher": launcher_after, "tsLauncher": ts_before},
            "install": {"dir": str(self.prefix / V1), "reused": False,
                        "executableSha256": manifest["binaries"][0]["executableSha256"],
                        "payloadSha256": side_by_side.payload_digest(self.prefix / V1)},
            "launcherVersion": {"stdout": V1, "exitCode": 0}})
        self.assertEqual(receipt["release"], {
            "dir": str(release), "manifestSha256": side_by_side.sha256_file(release / "manifest.json"),
            "sumsSha256": side_by_side.sha256_file(release / "SHA256SUMS"), "source": manifest["source"],
            "tarball": {"file": manifest["binaries"][0]["file"], "sha256": manifest["binaries"][0]["sha256"],
                        "bytes": manifest["binaries"][0]["bytes"]},
            "executableSha256": manifest["binaries"][0]["executableSha256"], "compiledVersion": "0.9.8"})
        self.assertEqual({key: value["state"] for key, value in receipt["rustDaemon"].items()},
                         {"idleBeforeInstall": "absent", "idleBeforeSelect": "absent"})
        self.assertEqual({name: run["ok"] for name, run in receipt["probe"]["runs"].items()},
                         {"version": True, "oneShot": True})
        # The probe ran the new install before it was selected.
        probe = json.loads((self.prefix / "receipts" / f"{V1}-{PLATFORM}" / "PROBE-RECEIPT.json").read_text())
        self.assertNotEqual(probe["launcher"], str(self.bin_dir / "prime-agent-rs"))
        self.assertEqual(sorted(receipt["timings"]),
                         sorted(["verify", "idle-check", "install", "agent-dir", "probe", "idle-recheck",
                                 "select", "post-check", "old-daemon", "total"]))
        # The probe's skill import left its bytecode in the Rust agent dir's
        # cache, not in the immutable install.
        self.assertEqual(list((self.prefix / V1).rglob("__pycache__")), [])
        cache = self.root / "agent-rs" / "python-cache"
        self.assertEqual([path.parent.relative_to(cache) for path in cache.rglob("demo_skill.*.pyc")],
                         [Path(*(self.prefix / V1 / "skills" / "demo").resolve().parts[1:])])
        # The agent dir is seeded (models.json linked, never auth.json); TS untouched.
        self.assertEqual(os.readlink(self.root / "agent-rs" / "models.json"),
                         str(side_by_side.TS_AGENT_DIR / "models.json"))
        self.assertFalse((self.root / "agent-rs" / "auth.json").exists())
        self.assertEqual(os.readlink(self.bin_dir / "prime-agent"), str(self.ts_target))

    def test_a_second_rollout_keeps_the_first_as_previous_and_rollback_returns_to_it(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout"), 0)  # the feed's stable pointer: V2
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        self.assertEqual((os.readlink(self.prefix / "current"), os.readlink(self.prefix / "previous")), (V2, V1))
        self.assertEqual(self.receipt(V2)["before"]["current"], V1)
        # The re-run's earlier receipt is kept beside the new one.
        self.assertEqual(len(list((self.prefix / "receipts" / f"{V2}-{PLATFORM}").glob("ACTIVATION-RECEIPT*.json"))), 2)

        self.assertEqual(self.main("rollback"), 0)
        self.assertEqual((os.readlink(self.prefix / "current"), os.readlink(self.prefix / "previous"),
                          self.launcher_version()), (V1, V2, V1))
        receipt = self.receipt(V1, "ROLLBACK-RECEIPT.json")
        self.assertEqual({key: receipt[key] for key in ("schema", "status", "failure", "fromVersion", "toVersion",
                                                        "checks", "launcherVersion")}, {
            "schema": rollout.ROLLBACK_SCHEMA, "status": "rolled-back", "failure": None,
            "fromVersion": V2, "toVersion": V1,
            "checks": {"vouchedByReceipt": True, "idleBeforeSelect": True, "payloadUnchangedAtSelect": True,
                       "launcherVersion": True, "tsLauncherUnchanged": True},
            "launcherVersion": {"stdout": V1, "exitCode": 0}})
        # V1's activation receipt vouches for exactly the installed payload,
        # which ran a probe (a skill import) without changing.
        activation = self.receipt(V1)
        installed = {"sha256": activation["release"]["executableSha256"],
                     "payloadSha256": activation["install"]["payloadSha256"]}
        self.assertEqual(receipt["executable"], {**installed, "vouchedBy": [
            {"file": "ACTIVATION-RECEIPT.json", "executableSha256": installed["sha256"],
             "payloadSha256": installed["payloadSha256"]}]})
        # Rolling back again toggles forward.
        self.assertEqual(self.main("rollback"), 0)
        self.assertEqual((os.readlink(self.prefix / "current"), self.launcher_version()), (V2, V2))

    def test_rolling_out_the_current_version_again_reverifies_and_completes_it(self) -> None:
        self.publish(V1)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        # A half-finished state: the launcher is gone. A re-run is not a
        # no-op: it runs every phase and leaves a complete activation.
        (self.bin_dir / "prime-agent-rs").unlink()
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["before"]["current"], receipt["after"]["current"],
                          receipt["install"]["reused"], self.launcher_version()), ("activated", V1, V1, True, V1))
        self.assertEqual(len(list((self.prefix / "receipts" / f"{V1}-{PLATFORM}").glob("ACTIVATION-RECEIPT*.json"))), 2)

    def test_a_busy_rust_daemon_refuses_the_rollout_before_anything_is_written(self) -> None:
        self.publish(V1)
        daemon = self.daemon(sessions=[{"sessionId": "a"}, {"sessionId": "b"}], connections=1)
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        daemon.finish()
        self.assertEqual([request["command"] for request in daemon.received],
                         [{"type": "list", "id": daemon.received[0]["id"]}])
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], receipt["rustDaemon"]["idleBeforeInstall"]["state"],
                          receipt["rustDaemon"]["idleBeforeInstall"]["sessionCount"]), ("refused", "idle-check", "busy", 2))
        self.assertFalse((self.prefix / V1).exists())
        self.assertFalse((self.prefix / "current").is_symlink())
        self.assertFalse((self.bin_dir / "prime-agent-rs").exists())

    def test_force_idle_check_skip_proceeds_past_a_busy_daemon_and_records_it(self) -> None:
        self.publish(V1)
        daemon = self.daemon(sessions=[{"sessionId": "a"}], connections=2)
        self.assertEqual(self.main("rollout", "--version", V1, "--force-idle-check-skip"), 0)
        daemon.finish()
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["idleCheckSkipped"], receipt["checks"]["idleBeforeSelect"]),
                         ("activated", True, False))
        self.assertEqual([request["command"]["type"] for request in daemon.received], ["list", "list"])

    def test_an_idle_rust_daemon_of_this_install_permits_the_swap(self) -> None:
        self.publish(V1)
        daemon = self.daemon(sessions=[], connections=2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        daemon.finish()
        observed = self.receipt(V1)["rustDaemon"]["idleBeforeInstall"]
        self.assertEqual(observed, {
            "socket": str(self.socket_path), "state": "idle", "sessionCount": 0,
            "protocol": {"name": "prime-agent.daemon", "version": 7}, "schemaId": "protocol-7-schema-28",
            "appVersion": "0.9.8", "supervisorPid": 4242, "supervisorProcessStartId": "start-4242",
            "helloSocketPath": str(self.socket_path), "buildId": "pa-daemon-rs-0.9.8",
            "executablePath": str(self.prefix / V1 / "prime-agent")})
        # The exact wire envelope: protocol echoed from the hello, a list
        # command and nothing else.
        request = daemon.received[0]
        self.assertEqual({key: request[key] for key in ("type", "protocol", "command")},
                         {"type": "command", "protocol": {"name": "prime-agent.daemon", "version": 7},
                          "command": {"type": "list", "id": request["id"]}})

    def test_an_old_supervisor_is_reported_and_left_running(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)

        daemon = self.daemon(sessions=[], connections=2, hellos=[self.rust_hello(V1)])
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        daemon.finish()
        # Only `list` ever reaches it: nothing here stops a supervisor.
        self.assertEqual([request["command"]["type"] for request in daemon.received], ["list", "list"])
        self.assertEqual(self.receipt(V2)["notice"],
                         f"the Rust supervisor at {self.socket_path} still runs {V1}; new sessions start on it, "
                         f"not on {V2}, until it exits")
        self.assertTrue(self.socket_path.exists())
        self.socket_path.unlink()

        # Rolling back to V1, the release that supervisor runs: nothing to note.
        daemon = self.daemon(sessions=[], connections=1, hellos=[self.rust_hello(V1)])
        self.assertEqual(self.main("rollback"), 0)
        daemon.finish()
        self.assertEqual([request["command"]["type"] for request in daemon.received], ["list"])
        self.assertNotIn("notice", self.receipt(V1, "ROLLBACK-RECEIPT.json"))
        self.assertTrue(self.socket_path.exists())

    def test_a_supervisor_already_on_the_selected_release_gets_no_notice(self) -> None:
        # Every Oneiron build of one base reports the same appVersion; the
        # running release is read from the executable path instead.
        self.publish(V2)
        daemon = self.daemon(sessions=[], connections=2, hellos=[self.rust_hello(V2)])
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        daemon.finish()
        self.assertEqual([request["command"]["type"] for request in daemon.received], ["list", "list"])
        self.assertNotIn("notice", self.receipt(V2))

    def test_a_foreign_daemon_is_never_sent_a_command(self) -> None:
        self.publish(V1)
        foreign = [{**self.rust_hello(), "runtime": {"buildId": "b", "executablePath": str(self.root / "x" / "pa")}},
                   {**self.rust_hello(), "socketPath": str(self.root / "other.sock")},
                   {**self.rust_hello(), "protocol": {"name": "something-else", "version": 7}}]
        for hello in foreign:
            with self.subTest(hello=hello):
                daemon = self.daemon(sessions=[], connections=1, hellos=[hello])
                self.assertEqual(self.main("rollout", "--version", V1), 1)
                daemon.finish()
                self.socket_path.unlink()
                self.assertEqual(daemon.received, [])
                observed = self.receipt(V1)["rustDaemon"]["idleBeforeInstall"]
                self.assertEqual((observed["state"], self.receipt(V1)["status"]), ("foreign", "refused"))
        self.assertFalse((self.prefix / V1).exists())

    def test_a_socket_inside_ts_state_is_never_connected_to(self) -> None:
        # The TS socket dir under this shell's TMPDIR, and under the fixed
        # system temp root when the TS daemon was started with another one.
        self.publish(V1)
        for tmp in (self.fake_tmp, self.system_tmp):
            ts_dir = tmp / f"prime-agent-{os.getuid()}"
            ts_dir.mkdir()
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(ts_dir / "daemon.sock"))
            server.listen(1)
            with server:
                for skip in ([], ["--force-idle-check-skip"]):
                    with self.subTest(tmp=tmp, skip=skip):
                        self.assertEqual(self.main("rollout", "--version", V1, "--rust-socket",
                                                   str(ts_dir / "daemon.sock"), *skip), 1)
                        self.assertEqual(self.receipt(V1)["rustDaemon"]["idleBeforeInstall"]["state"], "refused")
                server.setblocking(False)
                with self.assertRaises(BlockingIOError):
                    server.accept()  # no connection was ever queued
        self.assertFalse((self.prefix / V1).exists())

    def test_a_socket_nobody_listens_on_counts_as_no_daemon(self) -> None:
        self.publish(V1)
        self.socket_path.parent.mkdir()
        dead = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        dead.bind(str(self.socket_path))
        dead.close()
        self.assertEqual(daemon_idle.inspect(self.socket_path, self.prefix),
                         {"socket": str(self.socket_path), "state": "not-listening"})
        self.assertEqual(self.main("rollout", "--version", V1), 0)

    def test_a_tampered_or_inconsistent_release_is_refused_before_install(self) -> None:
        self.publish(V1)
        release = self.prefix / "feed" / "releases" / f"v{V1}"
        tarball = release / f"prime-agent-{V1}-{PLATFORM}.tar.gz"
        original = tarball.read_bytes()
        tarball.write_bytes(original + b"\0")
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"]), ("failed", "verify"))
        self.assertIn("the release says", receipt["failure"]["message"])
        tarball.write_bytes(original)
        sums = release / "SHA256SUMS"
        sums.write_text(sums.read_text().replace(sums.read_text()[:8], "00000000"))
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        self.assertIn("SHA256SUMS", self.receipt(V1)["failure"]["message"])
        self.assertFalse((self.prefix / V1).exists())

    def test_a_failed_probe_leaves_the_install_unselected_and_a_rerun_reuses_it(self) -> None:
        self.publish(V1)
        os.environ["FAKE_PROBE_FAIL"] = "1"
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], receipt["checks"]["probeOk"]),
                         ("failed", "probe", False))
        self.assertTrue((self.prefix / V1 / "prime-agent").is_file())
        self.assertFalse((self.prefix / "current").is_symlink())
        self.assertFalse((self.bin_dir / "prime-agent-rs").exists())
        del os.environ["FAKE_PROBE_FAIL"]
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual((self.receipt(V1)["install"]["reused"], os.readlink(self.prefix / "current")), (True, V1))

    def test_a_left_behind_install_is_reused_only_when_its_whole_payload_matches(self) -> None:
        self.publish(V1)
        os.environ["FAKE_PROBE_FAIL"] = "1"
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        del os.environ["FAKE_PROBE_FAIL"]
        # Same executable, one other file changed: not this release.
        readme = self.prefix / V1 / "README.md"
        readme.write_text("changed\n")
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], "payloadMatchesRelease" in receipt["checks"]),
                         ("failed", "install", False))
        self.assertIn("does not hold this release's payload", receipt["failure"]["message"])
        self.assertEqual(readme.read_text(), "changed\n")
        self.assertFalse((self.prefix / "current").is_symlink())

    def test_an_install_changed_after_verification_is_never_selected(self) -> None:
        # The probe (the installed binary itself) changes a file of the
        # install between the install check and the swap.
        self.publish(V1)
        os.environ["FAKE_PROBE_MUTATE"] = "1"
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], receipt["checks"]["payloadUnchangedAtSelect"],
                          receipt["after"]["current"]), ("failed", "select", False, None))
        self.assertIn("changed after it was verified", receipt["failure"]["message"])
        self.assertFalse((self.bin_dir / "prime-agent-rs").exists())

    def test_an_install_swapped_for_a_link_after_verification_is_never_selected(self) -> None:
        # Between the install check and the swap (here: during the idle
        # recheck), <prefix>/<version> becomes a link to an identical tree
        # elsewhere. Same bytes, but not the install.
        self.publish(V1)
        install, elsewhere = self.prefix / V1, self.root / "elsewhere" / V1

        def swap_for_a_link() -> None:
            if install.is_dir() and not install.is_symlink():
                elsewhere.parent.mkdir()
                install.rename(elsewhere)
                install.symlink_to(elsewhere, target_is_directory=True)

        daemon = self.daemon(sessions=[], connections=2, hellos=[self.rust_hello(V1)], on_list=swap_for_a_link)
        self.assertEqual(self.main("rollout", "--version", V1), 1)
        daemon.finish()
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], receipt["after"]["current"]),
                         ("failed", "select", None))
        self.assertIn("is not a plain directory", receipt["failure"]["message"])
        self.assertFalse((self.bin_dir / "prime-agent-rs").exists())

    def test_a_concurrent_run_is_turned_away_before_it_records_anything(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        receipts_before = {path.relative_to(self.prefix): path.read_bytes()
                           for path in (self.prefix / "receipts").rglob("*.json")}
        with (self.prefix / ".lock").open("a") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for argv in (("rollout", "--version", V1), ("rollback",)):
                with self.subTest(argv=argv), self.assertRaisesRegex(SystemExit, "another side_by_side.py run"):
                    self.main(*argv)
        self.assertEqual({path.relative_to(self.prefix): path.read_bytes()
                          for path in (self.prefix / "receipts").rglob("*.json")}, receipts_before)
        self.assertEqual((os.readlink(self.prefix / "current"), os.readlink(self.prefix / "previous")), (V2, V1))

    def test_an_unexpected_error_is_recorded_and_leaves_current_alone(self) -> None:
        self.publish(V1)
        real_write_launcher = side_by_side.write_launcher

        def unwritable_bin_dir(bin_dir: Path, prefix: Path) -> Path:
            if bin_dir == self.bin_dir:  # the probe's scratch launcher still works
                raise PermissionError(13, "Permission denied")
            return real_write_launcher(bin_dir, prefix)

        with mock.patch.object(side_by_side, "write_launcher", side_effect=unwritable_bin_dir):
            self.assertEqual(self.main("rollout", "--version", V1), 1)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], receipt["failure"]["message"], receipt["after"]["current"]),
                         ("failed", "select", "PermissionError: [Errno 13] Permission denied", None))
        self.assertFalse((self.prefix / "current").is_symlink())

    def test_a_crash_mid_run_leaves_the_phase_it_died_in_on_disk(self) -> None:
        self.publish(V1)
        with mock.patch.object(side_by_side, "flip_current", side_effect=KeyboardInterrupt), \
                self.assertRaises(KeyboardInterrupt):
            self.main("rollout", "--version", V1)
        receipt = self.receipt(V1)
        self.assertEqual((receipt["status"], receipt["phase"], receipt["finishedAt"]), ("running", "select", None))
        self.assertEqual(receipt["checks"]["payloadUnchangedAtSelect"], True)

    def test_a_symlinked_receipts_dir_is_refused_before_anything_is_written(self) -> None:
        self.publish(V1)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (self.prefix / "receipts").symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaisesRegex(SystemExit, "only `current` and `previous` may be links in it, "
                                                "found: .*/receipts$"):
            self.main("rollout", "--version", V1)
        self.assertEqual((os.listdir(elsewhere), (self.prefix / V1).exists()), ([], False))

    def test_a_receipts_dir_that_is_not_a_dir_is_refused_before_the_lock_file_exists(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        (self.prefix / ".lock").unlink()
        receipts = self.prefix / "receipts"
        # rollback's target receipt dir is a plain file; then all of receipts/ is.
        shutil.rmtree(receipts / f"{V1}-{PLATFORM}")
        (receipts / f"{V1}-{PLATFORM}").write_text("not a dir\n")
        with self.assertRaisesRegex(SystemExit, f"{V1}-{PLATFORM} is not a plain directory"):
            self.main("rollback")
        self.assertFalse((self.prefix / ".lock").exists())
        shutil.rmtree(receipts)
        receipts.write_text("not a dir\n")
        with self.assertRaisesRegex(SystemExit, "receipts is not a plain directory"):
            self.main("rollout", "--version", V1)
        self.assertEqual(((self.prefix / ".lock").exists(), os.readlink(self.prefix / "current")), (False, V2))

    def test_rollback_refuses_what_it_cannot_vouch_for(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        with self.assertRaisesRegex(SystemExit, "records no previous version"):
            self.main("rollback")
        with self.assertRaisesRegex(SystemExit, "is not installed"):
            self.main("rollback", "--to", "0.9.8-oneiron.20261001.7")
        with self.assertRaisesRegex(SystemExit, "already current"):
            self.main("rollback", "--to", V1)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        # A payload that no longer matches its receipt is not selected: the
        # executable, or any other file of the install.
        for name in ("prime-agent", "README.md"):
            with self.subTest(changed=name):
                changed = self.prefix / V1 / name
                original = changed.read_bytes()
                changed.write_bytes(original + b"# changed\n")
                self.assertEqual(self.main("rollback"), 1)
                receipt = self.receipt(V1, "ROLLBACK-RECEIPT.json")
                self.assertEqual((receipt["status"], receipt["phase"], receipt["checks"]),
                                 ("failed", "verify", {"vouchedByReceipt": False}))
                self.assertIn("is not what its receipts recorded", receipt["failure"]["message"])
                self.assertEqual(os.readlink(self.prefix / "current"), V2)
                changed.write_bytes(original)

    def test_rollback_rechecks_the_payload_right_before_the_swap(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        readme = self.prefix / V1 / "README.md"
        # The idle check is where the time goes; the install changes there.
        daemon = self.daemon(sessions=[], connections=1, hellos=[self.rust_hello(V2)],
                             on_list=lambda: readme.write_text("changed\n"))
        self.assertEqual(self.main("rollback"), 1)
        daemon.finish()
        receipt = self.receipt(V1, "ROLLBACK-RECEIPT.json")
        self.assertEqual((receipt["status"], receipt["phase"], receipt["checks"]["vouchedByReceipt"],
                          receipt["checks"]["payloadUnchangedAtSelect"]), ("failed", "select", True, False))
        self.assertEqual(os.readlink(self.prefix / "current"), V2)

    def test_rollback_accepts_a_version_the_install_command_activated(self) -> None:
        self.publish(V1)
        self.publish(V2)
        tarball = self.prefix / "feed" / "releases" / f"v{V1}" / f"prime-agent-{V1}-{PLATFORM}.tar.gz"
        self.assertEqual(self.main("install", "--tarball", str(tarball)), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        self.assertEqual(self.main("rollback"), 0)
        install = self.receipt(V1, "INSTALL-RECEIPT.json")
        self.assertEqual(self.receipt(V1, "ROLLBACK-RECEIPT.json")["executable"], {
            "sha256": install["binary"]["sha256"], "payloadSha256": install["payloadSha256"],
            "vouchedBy": [{"file": "INSTALL-RECEIPT.json", "executableSha256": install["binary"]["sha256"],
                           "payloadSha256": install["payloadSha256"]}]})
        self.assertEqual((os.readlink(self.prefix / "current"), self.launcher_version()), (V1, V1))

    def test_rollback_refuses_an_install_that_never_ran_as_current(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        # V2 installs, fails its probe and is never selected.
        os.environ["FAKE_PROBE_FAIL"] = "1"
        self.assertEqual(self.main("rollout", "--version", V2), 1)
        del os.environ["FAKE_PROBE_FAIL"]
        self.assertTrue((self.prefix / V2 / "prime-agent").is_file())
        self.assertEqual(self.main("rollback", "--to", V2), 1)
        receipt = self.receipt(V2, "ROLLBACK-RECEIPT.json")
        self.assertEqual((receipt["status"], receipt["phase"], receipt["checks"], receipt["executable"]["vouchedBy"]),
                         ("failed", "verify", {"vouchedByReceipt": False}, []))
        self.assertIn(f"no receipt shows {V2} ever ran as current", receipt["failure"]["message"])
        self.assertEqual(os.readlink(self.prefix / "current"), V1)

    def test_rollout_seeds_the_agent_dir_as_install_does_and_replaces_an_old_skills_link(self) -> None:
        # The installer's agent-dir rules: own skills (a snapshot here: no
        # hubs lock), never a link into the TS tree; the old layout's link is
        # the one link a seeding run may replace.
        ts_skills = side_by_side.TS_AGENT_DIR / "skills"
        (ts_skills / "grok").mkdir(parents=True)
        (ts_skills / "grok" / "SKILL.md").write_text("# grok\n")
        agent_dir = self.root / "agent-rs"
        agent_dir.mkdir()
        (agent_dir / "skills").symlink_to(ts_skills)
        self.publish(V1)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        skills = self.receipt(V1)["agentDir"]["seeded"]["skills"]
        self.assertEqual((skills["skillsSource"], skills["replaced"]), ("snapshot-fallback", f"link -> {ts_skills}"))
        self.assertFalse((agent_dir / "skills").is_symlink())
        self.assertEqual((agent_dir / "skills" / "grok" / "SKILL.md").read_text(), "# grok\n")

    def test_rollout_and_rollback_refuse_an_agent_dir_the_launcher_would_refuse(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        sessions = side_by_side.TS_AGENT_DIR / "sessions"
        sessions.mkdir()
        link = self.root / "agent-rs" / "sessions"
        link.symlink_to(sessions)
        receipts_before = {path.relative_to(self.prefix): path.read_bytes()
                           for path in (self.prefix / "receipts").rglob("*.json")}
        for argv in (("rollback",), ("rollout", "--version", V1)):
            with self.subTest(argv=argv), self.assertRaisesRegex(
                    SystemExit, f"only models.json may be a link in it, found: {link}$"):
                self.main(*argv)
        # Refused before the lock and the swap: no receipt, the pointers as they were.
        self.assertEqual({path.relative_to(self.prefix): path.read_bytes()
                          for path in (self.prefix / "receipts").rglob("*.json")}, receipts_before)
        self.assertEqual((os.readlink(self.prefix / "current"), os.readlink(self.prefix / "previous")), (V2, V1))
        self.assertEqual(os.listdir(sessions), [])

    def test_a_link_below_the_python_cache_never_carries_bytecode_into_ts_state(self) -> None:
        # The probe imports the bundled skill from <prefix>/<ver>/skills, so
        # its bytecode goes to <cache>/<that path>. A dir link planted at the
        # path's first component, into TS state, is refused before the run
        # writes anything (and the launcher would refuse it again).
        self.publish(V1)
        cache = self.root / "agent-rs" / "python-cache"
        cache.mkdir(parents=True)
        link = cache / self.prefix.parts[1]
        link.symlink_to(side_by_side.TS_AGENT_DIR, target_is_directory=True)
        ts_before = side_by_side.tree_identity(side_by_side.TS_AGENT_DIR)
        with self.assertRaisesRegex(SystemExit, f"only models.json may be a link in it, found: {link}$"):
            self.main("rollout", "--version", V1)
        self.assertEqual(side_by_side.tree_identity(side_by_side.TS_AGENT_DIR), ts_before)
        self.assertEqual(((self.prefix / V1).exists(), (self.prefix / "current").is_symlink()), (False, False))

    def test_rollback_refuses_while_the_rust_daemon_is_busy(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        daemon = self.daemon(sessions=[{"sessionId": "a"}], connections=1, hellos=[self.rust_hello(V2)])
        self.assertEqual(self.main("rollback"), 1)
        daemon.finish()
        self.assertEqual(self.receipt(V1, "ROLLBACK-RECEIPT.json")["status"], "refused")
        self.assertEqual(os.readlink(self.prefix / "current"), V2)

    def test_status_reports_versions_pointers_receipts_and_the_feed(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(self.main("status", "--json"), 0)
        state = json.loads(output.getvalue())
        self.assertEqual({key: state[key] for key in ("current", "previous", "feed")}, {
            "current": V2, "previous": V1,
            "feed": {"dir": str(self.prefix / "feed"), "stable": f"v{V2}", "latest": f"v{V2}",
                     "releases": [f"v{V1}", f"v{V2}"]}})
        self.assertEqual([(entry["version"], entry["platform"], entry["ok"],
                           sorted((item["file"], item["status"]) for item in entry["receipts"]))
                          for entry in state["installed"]],
                         [(version, PLATFORM, True, [("ACTIVATION-RECEIPT.json", "activated"),
                                                     ("PROBE-RECEIPT.json", "ok")]) for version in (V1, V2)])
        self.assertEqual((state["launcher"]["matchesTemplate"], state["tsLauncher"]["state"]),
                         (True, {"kind": "symlink", "target": str(self.ts_target)}))


if __name__ == "__main__":
    unittest.main()
