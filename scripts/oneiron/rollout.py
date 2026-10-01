"""Receipt-managed rollout, rollback and status of the side-by-side Rust build.

  rollout   feed release -> verify (manifest row, SHA256SUMS, tarball sha256,
            on a private copy) -> idle check -> install (immutable
            <prefix>/<ver>/, or reuse one already installed with the same
            payload tree) -> probe the new version through a scratch launcher
            BEFORE it is selected -> idle re-check -> flip current, rewrite
            the launcher -> `prime-agent-rs --version` -> ACTIVATION-RECEIPT.json
  rollback  flip current to <prefix>/previous (or --to <ver>), an installed
            version whose executable and payload match a receipt that shows
            it once ran as current; rewrite the launcher;
            ROLLBACK-RECEIPT.json. Code only: sessions, settings and the
            kernel venv are not rolled back.
  status    installed versions, current/previous, the launcher, receipts,
            the TS launcher, the feed pointers

Both swaps refuse unless the Rust supervisor is idle (daemon_idle.py). They
never stop it: when it runs another release, the receipt notes that it keeps
new sessions on that release until it exits. Each run holds the prefix lock from
its first check to its receipt, so a concurrent run is turned away before it
records anything. Every refusal or failure after the arguments check out is
written as a receipt; an earlier receipt of the same name is kept beside it
under its timestamp. The TS launcher, install tree, socket dir and agent dir
are never written; the receipt proves the TS launcher unchanged.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

import daemon_idle
import release_feed
import side_by_side as sbs

ACTIVATION_SCHEMA = "prime-agent-oneiron-rs.activation/1"
PLATFORM_TAG = re.compile(r"^[a-z0-9]+-[a-z0-9]+$")
ROLLBACK_SCHEMA = "prime-agent-oneiron-rs.rollback/1"


class Refused(Exception):
    """A gate said no; nothing past the current phase was changed."""


class Receipt:
    """One rollout/rollback record, journaled as it goes: written `running`
    before the first check and again on entering every phase (so a crash
    leaves the phase it died in on disk, a selection included), then with
    the outcome, whether the run succeeds, is refused or fails. An earlier
    receipt of the same name is kept, renamed to <stem>.<its UTC mtime>.json."""

    def __init__(self, path: Path, schema: str, **fields: object) -> None:
        self.path = path
        self.started = time.monotonic()
        self.data: dict = {"schema": schema, **fields, "host": socket.gethostname(), "startedAt": sbs.utc_now(),
                           "finishedAt": None, "status": "running", "phase": None, "failure": None,
                           "checks": {}, "timings": {}}
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() or path.is_symlink():
            stamp = dt.datetime.fromtimestamp(path.lstat().st_mtime, dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            path.rename(path.parent / f"{path.stem}.{stamp}.json")
        self.persist()

    def persist(self) -> None:
        sbs.write_json_atomic(self.path, self.data)

    @contextlib.contextmanager
    def phase(self, name: str) -> Iterator[None]:
        self.data["phase"] = name
        self.persist()
        started = time.monotonic()
        try:
            yield
        finally:
            self.data["timings"][name] = round(time.monotonic() - started, 3)

    def run(self, steps) -> int:
        """Run steps(); record success, a refusal or a failure: SystemExit
        from the shared install/probe code with its message, any other
        error (a permission, archive, JSON or spawn error) with its type."""
        try:
            steps()
            self.data["status"] = "done"
        except Refused as refusal:
            self.data.update(status="refused", failure={"phase": self.data["phase"], "message": str(refusal)})
        except SystemExit as error:
            message = str(error.code).removeprefix("error: ") if error.code not in (None, 0) else "exited"
            self.data.update(status="failed", failure={"phase": self.data["phase"], "message": message})
        except Exception as error:  # noqa: BLE001 (every failure is recorded, never lost)
            self.data.update(status="failed", failure={"phase": self.data["phase"],
                                                       "message": f"{type(error).__name__}: {error}"})
        self.data["finishedAt"] = sbs.utc_now()
        self.data["timings"]["total"] = round(time.monotonic() - self.started, 3)
        return 0 if self.data["status"] == "done" else 1


def pointer_state(prefix: Path, bin_dir: Path) -> dict:
    return {"current": sbs.read_link(prefix / "current"), "previous": sbs.read_link(prefix / "previous"),
            "launcher": sbs.link_state(bin_dir / sbs.LAUNCHER_NAME),
            "tsLauncher": sbs.link_state(bin_dir / sbs.TS_LAUNCHER_NAME)}


def rust_socket(args: argparse.Namespace) -> Path:
    return args.rust_socket.expanduser() if args.rust_socket else daemon_idle.default_socket_path()


def idle_gate(receipt: Receipt, key: str, args: argparse.Namespace, prefix: Path) -> None:
    """Record the Rust supervisor's state under checks[key]; refuse unless it
    is idle (or the operator skipped the check). A socket path overlapping
    TS state is never skippable."""
    observed = daemon_idle.inspect(rust_socket(args), prefix)
    receipt.data.setdefault("rustDaemon", {})[key] = observed
    idle = observed["state"] in daemon_idle.IDLE_STATES
    receipt.data["checks"][key] = idle
    if observed["state"] == "refused":
        raise Refused(f"refusing to check {observed['socket']}: {observed['detail']}")
    if idle:
        return
    detail = observed.get("detail") or f"{observed.get('sessionCount')} live session(s)"
    if args.force_idle_check_skip:
        receipt.data["idleCheckSkipped"] = True
        print(f"warning: the Rust daemon at {observed['socket']} is {observed['state']} ({detail}); "
              "--force-idle-check-skip: whatever runs there keeps the old binary")
        return
    hint = ("wait until its sessions end" if observed["state"] == "busy"
            else "find out what answers there (this check never stops it)")
    raise Refused(f"the Rust daemon at {observed['socket']} is {observed['state']} ({detail}); "
                  f"{hint}, or pass --force-idle-check-skip")


def note_old_daemon(receipt: Receipt, prefix: Path, version: str) -> None:
    """The swap does not reach a running supervisor: one of another release
    but the same protocol and schema is still `current` to new clients, and
    it spawns every worker from its own (old) binary until it exits. Its
    release is told by its executable path (the hello's appVersion is the
    compiled Cargo version, the same for every Oneiron build of one base).
    Nothing here stops it (see daemon_idle); the receipt says it runs on."""
    observed = receipt.data["rustDaemon"]["idleBeforeSelect"]
    if observed["state"] not in ("idle", "busy"):
        return
    running = daemon_idle.install_of(observed, prefix)
    if running == version:
        return
    receipt.data["notice"] = (f"the Rust supervisor at {observed['socket']} still runs {running}; new sessions "
                              f"start on it, not on {version}, until it exits")
    print(f"note: {receipt.data['notice']}")


def installed_package_version(install_dir: Path) -> str | None:
    try:
        return json.loads((install_dir / "package.json").read_text()).get("version")
    except (OSError, ValueError):
        return None


def launcher_version(bin_dir: Path) -> dict:
    result = subprocess.run([str(bin_dir / sbs.LAUNCHER_NAME), "--version"], capture_output=True, text=True)
    return {"stdout": result.stdout.strip(), "exitCode": result.returncode}


def rollout(args: argparse.Namespace) -> int:
    # The install's checks, before anything is written: the prefix and bin
    # dir, the agent dir, socket dir and kernel venv the seeder and the
    # launcher will use, the links in the prefix and the agent dir, the feed.
    prefix, bin_dir = sbs.cli_dirs(args)
    runtime = sbs.runtime_dirs()
    sbs.check_prefix_tree(prefix)
    sbs.check_agent_tree(runtime["agent dir"], runtime["kernel venv"], old_skills_link=True)
    feed_dir = release_feed.feed_dir_for(args, prefix)
    platform = release_feed.host_platform()
    version = args.version
    if version is None:
        stable = feed_dir / "stable"
        if not stable.is_file():
            raise SystemExit(f"error: no --version and no {stable} pointer")
        version = stable.read_text().strip().removeprefix("v")
    sbs.check_version(version)

    # The whole run, receipt included, holds the prefix lock: a concurrent
    # rollout or rollback is turned away before it records anything. A
    # version that is already current runs through every phase again (that
    # re-verifies it and finishes an interrupted activation); the swap
    # itself is then a no-op. The receipt dir is refused before the lock
    # file is created, and checked again under the lock.
    sbs.receipt_dir(prefix, version, platform)
    with sbs.locked(prefix):
        receipt_dir = sbs.receipt_dir(prefix, version, platform)
        receipt = Receipt(receipt_dir / "ACTIVATION-RECEIPT.json", ACTIVATION_SCHEMA, version=version,
                          platform=platform, feedDir=str(feed_dir), before=pointer_state(prefix, bin_dir))
        checks = receipt.data["checks"]

        def steps() -> None:
            with tempfile.TemporaryDirectory(prefix="pa-rs-rollout-") as scratch_name:
                scratch = Path(scratch_name)
                with receipt.phase("verify"):
                    release = verify_release(feed_dir, version, platform, scratch)
                    receipt.data["release"] = {key: value for key, value in release.items() if key != "copy"}
                    checks["releaseVerified"] = True
                with receipt.phase("idle-check"):
                    idle_gate(receipt, "idleBeforeInstall", args, prefix)
                with receipt.phase("install"):
                    receipt.data["install"] = install_release(prefix, version, platform, release)
                    checks["payloadMatchesRelease"] = True
                with receipt.phase("agent-dir"):
                    receipt.data["agentDir"] = sbs.seed_agent_dir(runtime["agent dir"], sbs.TS_AGENT_DIR,
                                                                  sbs.hubs_repo(args),
                                                                  refresh_skills=args.refresh_skills)
                with receipt.phase("probe"):
                    probe_unselected(receipt, prefix, bin_dir, version, platform, args, scratch)
                with receipt.phase("idle-recheck"):
                    idle_gate(receipt, "idleBeforeSelect", args, prefix)
                with receipt.phase("select"):
                    select_checked(receipt, prefix, bin_dir, version, receipt.data["install"]["payloadSha256"])
                with receipt.phase("post-check"):
                    post_check(receipt, prefix, bin_dir, version)
                with receipt.phase("old-daemon"):
                    note_old_daemon(receipt, prefix, version)

        code = receipt.run(steps)
        receipt.data["after"] = pointer_state(prefix, bin_dir)
        if receipt.data["status"] == "done":
            receipt.data["status"] = "activated"
        receipt.persist()
    report(receipt.data, receipt.path)
    return code


def select_checked(receipt: Receipt, prefix: Path, bin_dir: Path, version: str, payload_sha256: str) -> None:
    """The swap, after one last look under the lock: `current`, `previous`
    and the launcher are still what the run started from, and the install
    still holds the payload verified earlier (a probe or a slow idle check
    ran in between). Then select."""
    pointers = ("current", "previous", "launcher")
    before, now = receipt.data["before"], pointer_state(prefix, bin_dir)
    if {key: now[key] for key in pointers} != {key: before[key] for key in pointers}:
        raise Refused("current, previous or the launcher changed while the run was checking; run it again")
    actual = sbs.payload_digest(prefix / version)
    receipt.data["checks"]["payloadUnchangedAtSelect"] = actual == payload_sha256
    if actual != payload_sha256:
        raise SystemExit(f"error: {prefix / version} changed after it was verified (payload {actual}, "
                         f"verified {payload_sha256}); nothing was selected")
    receipt.persist()  # the swap is about to happen: journal that first
    sbs.select_version(prefix, bin_dir, version)


def verify_release(feed_dir: Path, version: str, platform: str, scratch: Path) -> dict:
    """The release's row for this platform, agreeing across manifest.json,
    SHA256SUMS and the bytes. The tarball is hashed as a private copy, and
    that copy is what gets installed: a swap in the feed after the check
    cannot reach the install."""
    release_dir = feed_dir / "releases" / f"v{version}"
    manifest_path = release_dir / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"error: {release_dir} has no manifest.json")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("version") != f"v{version}":
        raise SystemExit(f"error: {manifest_path} names {manifest.get('version')!r}, not v{version}")
    rows = [row for row in manifest.get("binaries", []) if row.get("platform") == platform]
    expected_file = f"prime-agent-{version}-{platform}.tar.gz"
    if len(rows) != 1 or rows[0].get("file") != expected_file:
        raise SystemExit(f"error: {manifest_path} has no single {platform} row for {expected_file}")
    row = rows[0]
    sums_path = release_dir / "SHA256SUMS"
    listed = release_feed.read_sums(sums_path).get(expected_file)
    if listed != row.get("sha256"):
        raise SystemExit(f"error: {sums_path} lists {expected_file} as {listed}, manifest.json as {row.get('sha256')}")
    source = release_dir / expected_file
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f"error: {source} is missing")
    copy = scratch / expected_file
    shutil.copyfile(source, copy)
    actual = sbs.sha256_file(copy)
    if actual != row["sha256"]:
        raise SystemExit(f"error: {source} is {actual}, the release says {row['sha256']}")
    return {"dir": str(release_dir), "manifestSha256": sbs.sha256_file(manifest_path),
            "sumsSha256": sbs.sha256_file(sums_path), "source": manifest.get("source"),
            "tarball": {"file": expected_file, "sha256": actual, "bytes": copy.stat().st_size},
            "executableSha256": row.get("executableSha256"), "compiledVersion": row.get("compiledVersion"),
            "copy": copy}


def install_release(prefix: Path, version: str, platform: str, release: dict) -> dict:
    """Install the verified copy, or reuse <prefix>/<version>/ when an earlier
    (unselected) attempt already installed exactly this payload: the whole
    tree must equal the verified tarball's, not just the executable."""
    target = prefix / version
    expected = release["executableSha256"]
    with sbs.staged_payload(release["copy"], None, None) as payload:
        if (payload.version, payload.platform) != (version, platform):
            raise SystemExit(f"error: the tarball holds {payload.version} ({payload.platform}), "
                             f"not {version} ({platform})")
        actual = sbs.sha256_file(payload.stage / "prime-agent")
        if actual != expected:
            raise SystemExit(f"error: the tarball's prime-agent is {actual}, the release says {expected}")
        digest = sbs.payload_digest(payload.stage)
        reused = target.exists() or target.is_symlink()
        if not reused:
            sbs.commit_payload(prefix, payload)
        if target.is_symlink() or not target.is_dir() or sbs.payload_digest(target) != digest:
            raise SystemExit(f"error: {target} does not hold this release's payload; installs are immutable, "
                             "bump the build number")
    return {"dir": str(target), "reused": reused, "executableSha256": expected, "payloadSha256": digest}


def probe_unselected(receipt: Receipt, prefix: Path, bin_dir: Path, version: str, platform: str,
                     args: argparse.Namespace, scratch: Path) -> None:
    """Probe the new version before anything points at it: a scratch launcher
    (the real template) whose prefix's `current` is the new install."""
    probe_prefix = scratch / "probe-prefix"
    probe_prefix.mkdir()
    (probe_prefix / "current").symlink_to(prefix / version)
    launcher = sbs.write_launcher(scratch / "probe-bin", probe_prefix)
    result = sbs.run_probe(launcher, prefix, version, platform, bin_dir / sbs.TS_LAUNCHER_NAME, args)
    receipt.data["probe"] = {"ok": result["ok"],
                             "receipt": str(sbs.receipt_dir(prefix, version, platform) / "PROBE-RECEIPT.json"),
                             "runs": {name: {"ok": run["ok"], "exitCode": run["exitCode"], "seconds": run["seconds"]}
                                      for name, run in result["runs"].items()},
                             "isolation": result["isolation"]["checks"]}
    receipt.data["checks"]["probeOk"] = result["ok"]
    if not result["ok"]:
        raise SystemExit(f"error: the probe of {version} failed; it stays installed but unselected")


def post_check(receipt: Receipt, prefix: Path, bin_dir: Path, version: str) -> None:
    observed = launcher_version(bin_dir)
    checks = receipt.data["checks"]
    checks["launcherVersion"] = observed == {"stdout": version, "exitCode": 0}
    checks["tsLauncherUnchanged"] = (sbs.link_state(bin_dir / sbs.TS_LAUNCHER_NAME)
                                     == receipt.data["before"]["tsLauncher"])
    receipt.data["launcherVersion"] = observed
    if not checks["launcherVersion"]:
        raise SystemExit(f"error: {bin_dir / sbs.LAUNCHER_NAME} --version printed {observed}; "
                         "select the previous version with `side_by_side.py rollback`")
    if not checks["tsLauncherUnchanged"]:
        raise SystemExit(f"error: {bin_dir / sbs.TS_LAUNCHER_NAME} changed during the run")


def receipt_platform(prefix: Path, version: str) -> str | None:
    """The platform of `version`'s receipts dir (receipts/<version>-<os>-<arch>)."""
    receipts = prefix / "receipts"
    names = sorted(os.listdir(receipts)) if receipts.is_dir() else []
    return next((name[len(version) + 1:] for name in names
                 if name.startswith(f"{version}-") and PLATFORM_TAG.match(name[len(version) + 1:])), None)


def vouching_receipts(prefix: Path, version: str, platform: str) -> list[dict]:
    """What the receipts that show `version` once ran as `current` recorded
    about its payload: a rollout that ended `activated`, an install that
    activated and passed its --version check, a rollback that ended
    `rolled-back` (earlier copies kept under their timestamps count too).
    A failed or refused rollout, or an install that never activated, does
    not vouch for anything."""
    directory = prefix / "receipts" / f"{version}-{platform}"
    vouchers = []
    for path in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            receipt = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(receipt, dict):
            continue
        schema = receipt.get("schema")
        if schema == ACTIVATION_SCHEMA and receipt.get("status") == "activated":
            executable = (receipt.get("release") or {}).get("executableSha256")
            payload = (receipt.get("install") or {}).get("payloadSha256")
        elif schema == sbs.RECEIPT_SCHEMA and receipt.get("activated") \
                and (receipt.get("versionCheck") or {}).get("ok"):
            executable = (receipt.get("binary") or {}).get("sha256")
            payload = receipt.get("payloadSha256")
        elif schema == ROLLBACK_SCHEMA and receipt.get("status") == "rolled-back":
            executable = (receipt.get("executable") or {}).get("sha256")
            payload = (receipt.get("executable") or {}).get("payloadSha256")
        else:
            continue
        if isinstance(executable, str):
            vouchers.append({"file": path.name, "executableSha256": executable, "payloadSha256": payload})
    return vouchers


def rollback(args: argparse.Namespace) -> int:
    # The launcher's own checks, made before the swap rather than after it:
    # a rolled-back launcher that refuses to start is no rollback.
    prefix, bin_dir = sbs.cli_dirs(args)
    runtime = sbs.runtime_dirs()
    sbs.check_prefix_tree(prefix)
    sbs.check_agent_tree(runtime["agent dir"], runtime["kernel venv"], old_skills_link=False)
    current = sbs.read_link(prefix / "current")
    target = args.to or sbs.read_link(prefix / "previous")
    if target is None:
        raise SystemExit(f"error: {prefix / 'previous'} records no previous version; pass --to <version>")
    sbs.check_version(target)
    if target == current:
        raise SystemExit(f"error: {target} is already current")
    install_dir = prefix / target
    binary = install_dir / "prime-agent"
    if install_dir.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK) \
            or installed_package_version(install_dir) != target:
        raise SystemExit(f"error: {target} is not installed in {prefix}")
    platform = receipt_platform(prefix, target) or release_feed.host_platform()

    sbs.receipt_dir(prefix, target, platform)  # refused before the lock file exists; again under it
    with sbs.locked(prefix):
        receipt_dir = sbs.receipt_dir(prefix, target, platform)
        receipt = Receipt(receipt_dir / "ROLLBACK-RECEIPT.json", ROLLBACK_SCHEMA, fromVersion=current,
                          toVersion=target, platform=platform, before=pointer_state(prefix, bin_dir))
        checks = receipt.data["checks"]

        def steps() -> None:
            with receipt.phase("verify"):
                if sbs.read_link(prefix / "current") != current:
                    raise Refused("current moved before the rollback took the lock; run it again")
                vouchers = vouching_receipts(prefix, target, platform)
                actual = {"sha256": sbs.sha256_file(binary), "payloadSha256": sbs.payload_digest(install_dir)}
                receipt.data["executable"] = {**actual, "vouchedBy": vouchers}
                checks["vouchedByReceipt"] = any(
                    voucher["executableSha256"] == actual["sha256"]
                    and voucher["payloadSha256"] in (None, actual["payloadSha256"]) for voucher in vouchers)
                if not vouchers:
                    raise SystemExit(f"error: no receipt shows {target} ever ran as current (an activated rollout "
                                     "or install, or a rollback); roll it out instead")
                if not checks["vouchedByReceipt"]:
                    raise SystemExit(f"error: {install_dir} (executable {actual['sha256']}, payload "
                                     f"{actual['payloadSha256']}) is not what its receipts recorded")
            with receipt.phase("idle-check"):
                idle_gate(receipt, "idleBeforeSelect", args, prefix)
            with receipt.phase("select"):
                select_checked(receipt, prefix, bin_dir, target, receipt.data["executable"]["payloadSha256"])
            with receipt.phase("post-check"):
                post_check(receipt, prefix, bin_dir, target)
            with receipt.phase("old-daemon"):
                note_old_daemon(receipt, prefix, target)

        code = receipt.run(steps)
        receipt.data["after"] = pointer_state(prefix, bin_dir)
        if receipt.data["status"] == "done":
            receipt.data["status"] = "rolled-back"
        receipt.persist()
    report(receipt.data, receipt.path)
    return code


def report(receipt: dict, path: Path) -> None:
    failure = receipt["failure"]
    print(f"{receipt['status']}" + (f" at {failure['phase']}: {failure['message']}" if failure else ""))
    print(f"current {receipt['before']['current']} -> {receipt['after']['current']}")
    print(f"receipt {path}")
    if failure:
        print(f"error: {failure['message']}", file=sys.stderr)


def receipt_summary(path: Path) -> dict:
    try:
        receipt = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        return {"file": path.name, "error": str(error)}
    status = receipt.get("status") or ("ok" if receipt.get("ok") or receipt.get("activated") else None)
    return {"file": path.name, "schema": receipt.get("schema"), "status": status,
            "at": receipt.get("finishedAt") or receipt.get("probedAt") or receipt.get("installedAt")}


def status(args: argparse.Namespace) -> int:
    prefix, bin_dir = sbs.cli_dirs(args)
    feed_dir = release_feed.feed_dir_for(args, prefix)
    receipts = prefix / "receipts"
    installed = []
    entries = sorted(os.listdir(prefix)) if prefix.is_dir() else []
    for name in sorted((name for name in entries if sbs.VERSION_PATTERN.match(name)), key=release_feed.version_key):
        install_dir = prefix / name
        platform = receipt_platform(prefix, name)
        receipt_dir = receipts / f"{name}-{platform}"
        installed.append({
            "version": name, "platform": platform,
            "ok": (not install_dir.is_symlink() and os.access(install_dir / "prime-agent", os.X_OK)
                   and installed_package_version(install_dir) == name),
            "receipts": [receipt_summary(path) for path in sorted(receipt_dir.glob("*.json"))]
            if platform else []})
    launcher = bin_dir / sbs.LAUNCHER_NAME
    expected_launcher = sbs.launcher_text(prefix)
    feed = {"dir": str(feed_dir),
            "stable": (feed_dir / "stable").read_text().strip() if (feed_dir / "stable").is_file() else None,
            "latest": (json.loads((feed_dir / "latest.json").read_text()).get("version")
                       if (feed_dir / "latest.json").is_file() else None),
            "releases": sorted((path.name for path in (feed_dir / "releases").iterdir()
                                if path.name.startswith("v") and sbs.VERSION_PATTERN.match(path.name[1:])),
                               key=release_feed.version_key) if (feed_dir / "releases").is_dir() else []}
    state = {
        "prefix": str(prefix),
        "current": sbs.read_link(prefix / "current"),
        "previous": sbs.read_link(prefix / "previous"),
        "installed": installed,
        "launcher": {"path": str(launcher), "state": sbs.link_state(launcher),
                     "matchesTemplate": launcher.is_file() and not launcher.is_symlink()
                     and launcher.read_text() == expected_launcher},
        "tsLauncher": {"path": str(bin_dir / sbs.TS_LAUNCHER_NAME),
                       "state": sbs.link_state(bin_dir / sbs.TS_LAUNCHER_NAME)},
        "feed": feed,
    }
    if args.json:
        print(json.dumps(state, indent=2))
        return 0
    print(f"prefix    {state['prefix']}")
    print(f"current   {state['current']}")
    print(f"previous  {state['previous']}")
    for entry in installed:
        marks = ", ".join(f"{item['file']}={item.get('status')}" for item in entry["receipts"]) or "no receipts"
        print(f"  {entry['version']:<32} {entry['platform'] or '?':<13} {'ok' if entry['ok'] else 'BROKEN'}  {marks}")
    launcher_state = state["launcher"]
    print(f"launcher  {launcher_state['path']} ({launcher_state['state']['kind']}, "
          f"{'matches the template' if launcher_state['matchesTemplate'] else 'NOT the installer template'})")
    ts_state = state["tsLauncher"]["state"]
    print(f"TS        {state['tsLauncher']['path']} -> {ts_state.get('target') or ts_state['kind']}")
    print(f"feed      {feed['dir']} stable={feed['stable']} latest={feed['latest']} releases={len(feed['releases'])}")
    return 0
