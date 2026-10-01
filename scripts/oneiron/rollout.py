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
stop it only with --retire-idle-daemon, after the swap, when it is still idle
and runs another version; otherwise the receipt notes that it keeps new
sessions on its version until it exits. Each run holds the prefix lock from
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
import shlex
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
    """One rollout/rollback record: the current phase, per-phase timings, and
    the outcome, written whether the run succeeds, is refused or fails."""

    def __init__(self, schema: str, **fields: object) -> None:
        self.started = time.monotonic()
        self.data: dict = {"schema": schema, **fields, "host": socket.gethostname(), "startedAt": sbs.utc_now(),
                           "finishedAt": None, "status": "running", "phase": None, "failure": None,
                           "checks": {}, "timings": {}}

    @contextlib.contextmanager
    def phase(self, name: str) -> Iterator[None]:
        self.data["phase"] = name
        started = time.monotonic()
        try:
            yield
        finally:
            self.data["timings"][name] = round(time.monotonic() - started, 3)

    def run(self, steps) -> int:
        """Run steps(); record success, a refusal or a failure (SystemExit
        from the shared install/probe code is a failure with its message)."""
        try:
            steps()
            self.data["status"] = "done"
        except Refused as refusal:
            self.data.update(status="refused", failure={"phase": self.data["phase"], "message": str(refusal)})
        except SystemExit as error:
            message = str(error.code).removeprefix("error: ") if error.code not in (None, 0) else "exited"
            self.data.update(status="failed", failure={"phase": self.data["phase"], "message": message})
        self.data["finishedAt"] = sbs.utc_now()
        self.data["timings"]["total"] = round(time.monotonic() - self.started, 3)
        return 0 if self.data["status"] == "done" else 1


def write_receipt(directory: Path, name: str, receipt: dict) -> Path:
    """Write directory/name; an earlier receipt there is kept, renamed to
    <stem>.<its UTC mtime>.json, never overwritten."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    if path.exists():
        stamp = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        path.rename(directory / f"{path.stem}.{stamp}.json")
    sbs.write_json_atomic(path, receipt)
    return path


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


def retire_old_daemon(receipt: Receipt, args: argparse.Namespace, prefix: Path, version: str) -> None:
    """The swap does not reach a running supervisor: one of another version
    but the same protocol and schema is still `current` to new clients, and
    it spawns every worker from its own (old) binary. On request, and only
    when it is idle and ours on the retiring connection, stop it, so the
    next prime-agent-rs run starts `version`; otherwise say so."""
    observed = receipt.data["rustDaemon"]["idleBeforeSelect"]
    if observed["state"] not in ("idle", "busy") or observed.get("appVersion") == version:
        return
    if args.retire_idle_daemon:
        result = daemon_idle.inspect(rust_socket(args), prefix, retire=True)
        receipt.data["rustDaemon"]["retire"] = result
        if result.get("retire", {}).get("stopped"):
            return
    receipt.data["notice"] = (f"the Rust supervisor at {observed['socket']} still runs "
                              f"{observed.get('appVersion')}; new sessions start on it until it exits"
                              + ("" if args.retire_idle_daemon else " (--retire-idle-daemon stops it when idle)"))
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
    prefix = args.prefix.expanduser()
    bin_dir = args.bin_dir.expanduser()
    sbs.check_prefix(prefix, bin_dir)
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
    # rollout or rollback is turned away before it records anything.
    with sbs.locked(prefix):
        if sbs.read_link(prefix / "current") == version:
            print(f"{version} is already current; nothing to do")
            return 0
        receipt = Receipt(ACTIVATION_SCHEMA, version=version, platform=platform, feedDir=str(feed_dir),
                          before=pointer_state(prefix, bin_dir))
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
                    receipt.data["agentDir"] = sbs.seed_agent_dir(sbs.rs_agent_dir(), sbs.TS_AGENT_DIR)
                with receipt.phase("probe"):
                    probe_unselected(receipt, prefix, bin_dir, version, platform, args, scratch)
                with receipt.phase("idle-recheck"):
                    idle_gate(receipt, "idleBeforeSelect", args, prefix)
                with receipt.phase("select"):
                    sbs.select_version(prefix, bin_dir, version)
                with receipt.phase("post-check"):
                    post_check(receipt, prefix, bin_dir, version)
                with receipt.phase("old-daemon"):
                    retire_old_daemon(receipt, args, prefix, version)

        code = receipt.run(steps)
        receipt.data["after"] = pointer_state(prefix, bin_dir)
        if receipt.data["status"] == "done":
            receipt.data["status"] = "activated"
        path = write_receipt(prefix / "receipts" / f"{version}-{platform}", "ACTIVATION-RECEIPT.json",
                             receipt.data)
    report(receipt.data, path)
    return code


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
    result = sbs.run_probe(launcher, version, platform, prefix / "receipts" / f"{version}-{platform}",
                           bin_dir / sbs.TS_LAUNCHER_NAME, args)
    receipt.data["probe"] = {"ok": result["ok"], "receipt": str(prefix / "receipts" / f"{version}-{platform}" /
                                                                "PROBE-RECEIPT.json"),
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
    prefix = args.prefix.expanduser()
    bin_dir = args.bin_dir.expanduser()
    sbs.check_prefix(prefix, bin_dir)
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

    with sbs.locked(prefix):
        receipt = Receipt(ROLLBACK_SCHEMA, fromVersion=current, toVersion=target, platform=platform,
                          before=pointer_state(prefix, bin_dir))
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
                sbs.select_version(prefix, bin_dir, target)
            with receipt.phase("post-check"):
                post_check(receipt, prefix, bin_dir, target)
            with receipt.phase("old-daemon"):
                retire_old_daemon(receipt, args, prefix, target)

        code = receipt.run(steps)
        receipt.data["after"] = pointer_state(prefix, bin_dir)
        if receipt.data["status"] == "done":
            receipt.data["status"] = "rolled-back"
        path = write_receipt(prefix / "receipts" / f"{target}-{platform}", "ROLLBACK-RECEIPT.json", receipt.data)
    report(receipt.data, path)
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
    prefix = args.prefix.expanduser()
    bin_dir = args.bin_dir.expanduser()
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
    expected_launcher = sbs.LAUNCHER_TEMPLATE.format(prefix=shlex.quote(str(prefix)))
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
