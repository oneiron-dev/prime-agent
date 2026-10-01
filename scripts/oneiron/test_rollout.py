#!/usr/bin/env python3
"""Contract tests for `side_by_side.py rollout|rollback|status` (rollout.py, daemon_idle.py).

Run: python3 scripts/oneiron/test_rollout.py. Every path is a temp dir (HOME,
TMPDIR, the TS launcher and agent dir, the prefix, the feed); the Rust
"daemon" is a scripted unix-socket server speaking the hello/list frames;
the binary is release_feed's fake. No network, no real daemon, no real prefix.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

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
            "PRIME_AGENT_RS_KERNEL_VENV", "FAKE_PROBE_FAIL", "PI_PACKAGE_DIR", "PRIME_AGENT_KERNEL_PYTHON")


class FakeRustDaemon:
    """A scripted supervisor on a unix socket: each connection gets the hello,
    `list` gets `sessions`, and `shutdown` removes the socket (as the real
    supervisor does on exit) before it answers. It serves exactly
    `connections` connections and records every request it reads."""

    def __init__(self, path: Path, hello: dict, sessions: list, connections: int) -> None:
        self.path = path
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(8)
        self.hello, self.sessions, self.received = hello, sessions, []
        self.thread = threading.Thread(target=self.serve, args=(connections,), daemon=True)
        self.thread.start()

    def serve(self, connections: int) -> None:
        for _ in range(connections):
            conn, _ = self.server.accept()
            with conn, conn.makefile("rb") as reader:
                conn.sendall((json.dumps(self.hello) + "\n").encode())
                for line in reader:
                    request = json.loads(line)
                    self.received.append(request)
                    kind = request["command"]["type"]
                    response = {"type": "response", "id": request["id"], "command": kind, "success": True}
                    if kind == "list":
                        response["data"] = {"sessions": self.sessions}
                    else:
                        self.server.close()
                        self.path.unlink()
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
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.fake_tmp = self.root / "tmp"
        self.fake_tmp.mkdir()
        self.saved_env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ("FAKE_PROBE_FAIL", "PI_PACKAGE_DIR", "PRIME_AGENT_KERNEL_PYTHON"):
            os.environ.pop(key, None)
        os.environ.update({
            "HOME": str(self.home), "TMPDIR": str(self.fake_tmp),
            "XDG_DATA_HOME": str(self.home / ".local" / "share"),
            "PRIME_AGENT_RS_AGENT_DIR": str(self.root / "agent-rs"),
            # Short: a unix socket path must fit sun_path.
            "PRIME_AGENT_RS_SOCKET_DIR": str(self.root / "s"),
            "PRIME_AGENT_RS_KERNEL_VENV": str(self.root / "venv-rs"),
        })
        self.saved = (side_by_side.HOME, side_by_side.TS_PREFIX, side_by_side.TS_AGENT_DIR,
                      release_feed.host_platform)
        side_by_side.HOME = self.home
        side_by_side.TS_PREFIX = self.home / ".local" / "share" / "prime-agent-oneiron"
        side_by_side.TS_AGENT_DIR = self.home / ".prime" / "agent"
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
        (side_by_side.HOME, side_by_side.TS_PREFIX, side_by_side.TS_AGENT_DIR,
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
                                   "--source-root", str(self.source), "--allow-fixture-catalog",
                                   "--no-decoder"), 0)

    def receipt(self, version: str, name: str = "ACTIVATION-RECEIPT.json") -> dict:
        return json.loads((self.prefix / "receipts" / f"{version}-{PLATFORM}" / name).read_text())

    def launcher_version(self) -> str:
        return subprocess.run([str(self.bin_dir / "prime-agent-rs"), "--version"], check=True,
                              capture_output=True, text=True).stdout.strip()

    def rust_hello(self, executable: Path | None = None) -> dict:
        return {"type": "daemon_hello", "socketPath": str(self.socket_path),
                "protocol": {"name": "prime-agent.daemon", "version": 7}, "schemaId": "protocol-7-schema-28",
                "appVersion": V1, "supervisorPid": 4242, "supervisorProcessStartId": "start-1",
                "runtime": {"buildId": "build-1",
                            "executablePath": str(executable or self.prefix / V1 / "prime-agent")},
                "clientId": "c", "serverCapabilities": []}

    def daemon(self, sessions: list, connections: int, hello: dict | None = None) -> FakeRustDaemon:
        self.socket_path.parent.mkdir(exist_ok=True)
        return FakeRustDaemon(self.socket_path, hello or self.rust_hello(), sessions, connections)


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
            "checks": {"releaseVerified": True, "idleBeforeInstall": True, "executableSha256Matches": True,
                       "probeOk": True, "idleBeforeSelect": True, "launcherVersion": True,
                       "tsLauncherUnchanged": True},
            "before": {"current": None, "previous": None, "launcher": {"kind": "absent"}, "tsLauncher": ts_before},
            "after": {"current": V1, "previous": None, "launcher": launcher_after, "tsLauncher": ts_before},
            "install": {"dir": str(self.prefix / V1), "reused": False,
                        "executableSha256": manifest["binaries"][0]["executableSha256"]},
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
            "checks": {"executableMatchesReceipt": True, "idleBeforeSelect": True, "launcherVersion": True,
                       "tsLauncherUnchanged": True},
            "launcherVersion": {"stdout": V1, "exitCode": 0}})
        self.assertEqual(receipt["executable"]["recorded"], receipt["executable"]["sha256"])
        # Rolling back again toggles forward.
        self.assertEqual(self.main("rollback"), 0)
        self.assertEqual((os.readlink(self.prefix / "current"), self.launcher_version()), (V2, V2))
        self.assertEqual(self.main("rollout", "--version", V2), 0)  # already current: a no-op

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
            "appVersion": V1, "supervisorPid": 4242, "supervisorProcessStartId": "start-1",
            "helloSocketPath": str(self.socket_path), "buildId": "build-1",
            "executablePath": str(self.prefix / V1 / "prime-agent")})
        # The exact wire envelope: protocol echoed from the hello, a list
        # command and nothing else.
        request = daemon.received[0]
        self.assertEqual({key: request[key] for key in ("type", "protocol", "command")},
                         {"type": "command", "protocol": {"name": "prime-agent.daemon", "version": 7},
                          "command": {"type": "list", "id": request["id"]}})

    def test_an_old_idle_supervisor_is_reported_and_retired_only_on_request(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        old_hello = self.rust_hello(executable=self.prefix / V1 / "prime-agent")

        daemon = self.daemon(sessions=[], connections=2, hello=old_hello)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        daemon.finish()
        self.assertEqual([request["command"]["type"] for request in daemon.received], ["list", "list"])
        self.assertEqual(self.receipt(V2)["notice"],
                         f"the Rust supervisor at {self.socket_path} still runs {V1}; new sessions start on it "
                         "until it exits (--retire-idle-daemon stops it when idle)")
        self.assertTrue(self.socket_path.exists())
        self.socket_path.unlink()

        # Rolling back to V1, the version that supervisor runs: nothing to retire.
        daemon = self.daemon(sessions=[], connections=1, hello=old_hello)
        self.assertEqual(self.main("rollback", "--retire-idle-daemon"), 0)
        daemon.finish()
        self.assertEqual([request["command"]["type"] for request in daemon.received], ["list"])
        receipt = self.receipt(V1, "ROLLBACK-RECEIPT.json")
        self.assertEqual(("retire" in receipt["rustDaemon"], "notice" in receipt), (False, False))
        self.assertTrue(self.socket_path.exists())

    def test_retire_idle_daemon_stops_the_old_supervisor_after_the_swap(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        daemon = self.daemon(sessions=[], connections=3,
                             hello=self.rust_hello(executable=self.prefix / V1 / "prime-agent"))
        self.assertEqual(self.main("rollout", "--version", V2, "--retire-idle-daemon"), 0)
        daemon.finish()
        self.assertEqual([request["command"]["type"] for request in daemon.received],
                         ["list", "list", "list", "shutdown"])
        receipt = self.receipt(V2)
        self.assertEqual((receipt["status"], receipt["rustDaemon"]["retire"]["retire"], "notice" in receipt),
                         ("activated", {"acknowledged": True, "stopped": True}, False))
        self.assertFalse(self.socket_path.exists())

    def test_a_foreign_daemon_is_never_sent_a_command(self) -> None:
        self.publish(V1)
        foreign = [self.rust_hello(executable=self.root / "elsewhere" / "prime-agent"),
                   {**self.rust_hello(), "socketPath": str(self.root / "other.sock")},
                   {**self.rust_hello(), "protocol": {"name": "something-else", "version": 7}}]
        for hello in foreign:
            with self.subTest(hello=hello):
                daemon = self.daemon(sessions=[], connections=1, hello=hello)
                self.assertEqual(self.main("rollout", "--version", V1), 1)
                daemon.finish()
                self.socket_path.unlink()
                self.assertEqual(daemon.received, [])
                observed = self.receipt(V1)["rustDaemon"]["idleBeforeInstall"]
                self.assertEqual((observed["state"], self.receipt(V1)["status"]), ("foreign", "refused"))
        self.assertFalse((self.prefix / V1).exists())

    def test_a_socket_inside_ts_state_is_never_connected_to(self) -> None:
        self.publish(V1)
        ts_dir = self.fake_tmp / f"prime-agent-{os.getuid()}"
        ts_dir.mkdir()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(ts_dir / "daemon.sock"))
        server.listen(1)
        with server:
            for skip in ([], ["--force-idle-check-skip"]):
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
        # An executable that no longer matches its receipt is not selected.
        binary = self.prefix / V1 / "prime-agent"
        binary.write_text(binary.read_text() + "# changed\n")
        self.assertEqual(self.main("rollback"), 1)
        receipt = self.receipt(V1, "ROLLBACK-RECEIPT.json")
        self.assertEqual((receipt["status"], receipt["phase"], receipt["checks"]),
                         ("failed", "verify", {"executableMatchesReceipt": False}))
        self.assertEqual(os.readlink(self.prefix / "current"), V2)

    def test_rollback_refuses_while_the_rust_daemon_is_busy(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        daemon = self.daemon(sessions=[{"sessionId": "a"}], connections=1,
                             hello=self.rust_hello(executable=self.prefix / V2 / "prime-agent"))
        self.assertEqual(self.main("rollback"), 1)
        daemon.finish()
        self.assertEqual(self.receipt(V1, "ROLLBACK-RECEIPT.json")["status"], "refused")
        self.assertEqual(os.readlink(self.prefix / "current"), V2)

    def test_status_reports_versions_pointers_receipts_and_the_feed(self) -> None:
        self.publish(V1)
        self.publish(V2)
        self.assertEqual(self.main("rollout", "--version", V1), 0)
        self.assertEqual(self.main("rollout", "--version", V2), 0)
        output = subprocess.run([sys.executable, str(Path(side_by_side.__file__)), "--prefix", str(self.prefix),
                                 "--bin-dir", str(self.bin_dir), "status", "--json"],
                                check=True, capture_output=True, text=True).stdout
        state = json.loads(output)
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
