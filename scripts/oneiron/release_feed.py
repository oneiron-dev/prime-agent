"""The Oneiron release feed for the side-by-side Rust build (`side_by_side.py package`).

Wraps scripts/package_release.py output (the staged exe-adjacent layout
`prime-agent-<base>-<platform>/` beside its binaries.json) into an Oneiron
release, without building anything:

  <feed>/releases/v<ver>/prime-agent-<ver>-<platform>.tar.gz   one per platform
  <feed>/releases/v<ver>/prime-agent-<ver>-linux-x64.debug.gz  Linux decoder (never install payload)
  <feed>/releases/v<ver>/SHA256SUMS                            every artifact above
  <feed>/releases/v<ver>/manifest.json                         release manifest
  <feed>/latest.json                                           the stable release's manifest
  <feed>/stable                                                "v<ver>\\n"

<ver> is `<base>-oneiron.YYYYMMDD.N`: package.json is stamped with it (and
the source commit) before tarring, the tarball is packed with upstream's
deterministic packer (assemble_artifacts.pack_tarball: sorted members, fixed
owner/mtime/modes, gzip mtime 0), and its layout is package_release.py's
otherwise. The compiled-in version stays <base>: both versions are probed
on the staged binary, so packaging runs on the host that built it
(linux-x64 on Arch with its split-debug decoder, darwin-arm64 on the Mac).

manifest.json carries the TS feed's release fields (version, package,
source) plus the Rust channel-manifest rows a later native updater reads
(pa-core update::release: `version` = "v<ver>", `binaries` rows with
`platform`, a bare `file` = prime-agent-<ver>-<platform>.tar.gz and a 64-hex
`sha256`); the extra row fields are ignored by that parser. The npm
`tarball`/`tarballs` fields of the TS feed are not carried: this is not an
npm package. A later native updater fetches `<base>/<file>` at the feed
root, so serving this feed to it needs root aliases (out of scope here).

Releases are immutable per platform: re-running with the same inputs is a
no-op, different bytes for a published platform are refused, and a second
platform joins a release only from the same source commit and tree.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import side_by_side as sbs

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))
import package_release  # noqa: E402  (puts scripts/release on sys.path)
from assemble_artifacts import (  # noqa: E402
    decoder_facts,
    fail_if_decoder_in_archive,
    fail_if_decoder_in_tree,
    pack_tarball,
)
from bundle_catalog import BUNDLED_CATALOG_FILES, fixture_catalog_bodies, validate_bundled_catalog_dir  # noqa: E402

FEED_SCHEMA = "prime-agent-oneiron-rs.feed/1"
# The two hosts we build on; each packages its own platform.
SUPPORTED_PLATFORMS = {"linux-x64": "x86_64-unknown-linux-gnu", "darwin-arm64": "aarch64-apple-darwin"}
ONEIRON_VERSION = re.compile(r"^(?P<base>[0-9]+\.[0-9]+\.[0-9]+)-oneiron\.(?P<date>[0-9]{8})\.(?P<build>[0-9]+)$")


def host_platform() -> str:
    return package_release.release_platform()


def feed_dir_for(args: argparse.Namespace, prefix: Path) -> Path:
    """--feed-dir (default <prefix>/feed), canonical and checked against TS
    state like every other destination (side_by_side.refuse_ts_state)."""
    raw = os.path.expanduser(args.feed_dir) if args.feed_dir else str(prefix / "feed")
    return sbs.refuse_ts_state("feed dir", sbs.checked_path("--feed-dir", raw))


def version_key(version: str) -> tuple:
    """Semver precedence: numeric core, a release above its prereleases,
    numeric prerelease identifiers compared as numbers (oneiron.20261001.10
    sorts after oneiron.20261001.9)."""
    core, _, pre = version.removeprefix("v").partition("-")
    numbers = tuple(int(part) for part in core.split("."))
    if not pre:
        return (numbers, 1, ())
    return (numbers, 0, tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in pre.split(".")))


def read_sums(path: Path) -> dict[str, str]:
    sums: dict[str, str] = {}
    if not path.is_file():
        return sums
    for line in path.read_text().splitlines():
        if line.strip():
            digest, name = line.split(None, 1)
            sums[name.strip()] = digest.strip()
    return sums


def utc_from_mtime(path: Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"error: git {' '.join(args)} failed in {root}: {result.stderr.strip()}")
    return result.stdout.strip()


def dirty_digest(root: Path) -> str:
    """One sha256 over a checkout's uncommitted state: the binary diff
    against HEAD (tracked content and mode changes) plus every untracked,
    unignored entry by name, kind and mode, with a file's content hash or
    a symlink's target, so an allowed dirty release names exactly what it
    carried."""
    diff = subprocess.run(["git", "-C", str(root), "diff", "HEAD", "--binary"], capture_output=True, check=True)
    digest = hashlib.sha256(diff.stdout)
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    for name in sorted(filter(None, untracked)):
        path = root / name
        if path.is_symlink():
            entry = f"link {os.readlink(path)}"
        else:
            entry = f"file {path.stat().st_mode & 0o7777:o} {sbs.sha256_file(path)}"
        digest.update(f"\0{name}\0{entry}".encode())
    return digest.hexdigest()


def source_facts(root: Path, allow_dirty: bool) -> dict:
    """What the release attests it was built from. The binary carries no
    commit of its own, so this is the checkout the operator packages from,
    recorded as such (`attestedBy`); a dirty one is refused unless
    explicitly allowed, and then its exact uncommitted state is digested."""
    root = root.resolve()
    dirty = bool(git(root, "status", "--porcelain"))
    if dirty and not allow_dirty:
        raise SystemExit(f"error: {root} has uncommitted changes; commit them or pass --allow-dirty")
    return {"commit": git(root, "rev-parse", "HEAD"), "tree": git(root, "rev-parse", "HEAD^{tree}"),
            "build": git(root, "describe", "--always", "--dirty"), "dirty": dirty,
            "dirtySha256": dirty_digest(root) if dirty else None,
            "attestedBy": "packaging-checkout", "rustBase": sbs.git_facts(root)["rustBase"]}


def read_package_dir(package_dir: Path) -> tuple[str, str, Path, str]:
    """(base version, platform, staged layout, executable sha256) from a
    package_release.py --out-dir: its binaries.json names exactly one row."""
    manifest_path = package_dir / "binaries.json"
    if not manifest_path.is_file():
        raise SystemExit(f"error: {package_dir} has no binaries.json (scripts/package_release.py --out-dir)")
    manifest = json.loads(manifest_path.read_text())
    rows = manifest.get("binaries") or []
    if len(rows) != 1:
        raise SystemExit(f"error: {manifest_path} must name exactly one platform, found {len(rows)}")
    base = str(manifest.get("version", "")).removeprefix("v")
    platform = rows[0].get("platform", "")
    stage = package_dir / f"prime-agent-{base}-{platform}"
    if stage.is_symlink() or not stage.is_dir():
        raise SystemExit(f"error: staged layout {stage} is missing")
    return base, platform, stage, rows[0].get("executableSha256", "")


def catalog_facts(stage: Path, allow_fixture: bool) -> dict:
    """The bundled catalogs, validated again as staged; the synthetic
    --fixture snapshot passes every count gate, so it is caught by content."""
    counts = validate_bundled_catalog_dir(stage)
    fixture = all((stage / name).read_text() == body for name, body in fixture_catalog_bodies().items())
    if fixture and not allow_fixture:
        raise SystemExit("error: the staged catalogs are bundle_catalog.py's synthetic --fixture snapshot; "
                         "package from real catalogs (--catalog-assets from bundle_catalog.py generate "
                         "--catalog-dir/--network)")
    return {"fixture": fixture, "counts": counts,
            **{name: sbs.sha256_file(stage / name) for name in BUNDLED_CATALOG_FILES}}


def probe_version(binary: Path, package_dir: Path | None) -> str:
    """What the binary reports with the manifest resolution pointed at
    `package_dir` (an empty dir reads the compiled-in version) or, for None,
    at its own directory, the way an install runs it."""
    env = {key: value for key, value in os.environ.items() if not key.startswith(("PRIME_AGENT_", "PI_"))}
    if package_dir is not None:
        env["PI_PACKAGE_DIR"] = str(package_dir)
    result = subprocess.run([str(binary), "--version"], capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise SystemExit(f"error: {binary} --version failed: {result.stderr.strip()}")
    return result.stdout.strip()


def decoder_row(decoder: Path, binary: Path, base: str, version: str, platform: str, into: Path) -> tuple[dict, Path]:
    """Pair the split-debug decoder with the shipped ELF (upstream's GNU
    build-id gate) and copy it under the release version's name."""
    facts = decoder_facts(argparse.Namespace(target=SUPPORTED_PLATFORMS[platform], version=base,
                                             decoder=decoder, binary=binary))
    renamed = into / f"prime-agent-{version}-{platform}.debug.gz"
    shutil.copyfile(decoder, renamed)
    return {**facts, "file": renamed.name}, renamed


def place_artifact(source: Path, target: Path, sha256: str) -> None:
    """Copy an artifact into the release dir; one already there must be the
    same bytes (a re-run), never replaced. The copy goes through an
    exclusive temp (side_by_side.replacing), so a planted link is never
    written through."""
    if target.exists() or target.is_symlink():
        if target.is_symlink() or sbs.sha256_file(target) != sha256:
            raise SystemExit(f"error: {target} already exists with different bytes; releases are immutable, "
                             "bump the build number")
        return
    with source.open("rb") as reader, sbs.replacing(target) as writer:
        shutil.copyfileobj(reader, writer)


def publish(feed_dir: Path, version: str, base: str, source: dict, row: dict, tarball: Path,
            decoder: tuple[dict, Path] | None, promote: bool) -> dict:
    """Add one platform to releases/v<version>/ and move the feed pointers;
    under the feed lock, artifacts first, then SHA256SUMS, manifest.json and
    the pointers (each replaced atomically). A re-run of an already published
    platform with the same bytes changes nothing but may still promote. A
    linked release dir is refused before the lock file is created, and
    again under the lock."""
    sbs.plain_dir(feed_dir, "releases", f"v{version}")
    with sbs.locked(feed_dir):
        release_dir = sbs.plain_dir(feed_dir, "releases", f"v{version}")
        manifest_path = release_dir / "manifest.json"
        manifest = (json.loads(manifest_path.read_text()) if manifest_path.is_file() else
                    {"schema": FEED_SCHEMA, "version": f"v{version}", "package": "prime-agent",
                     "baseVersion": base, "source": source, "binaries": [], "decoders": []})
        if manifest.get("version") != f"v{version}":
            raise SystemExit(f"error: {manifest_path} names {manifest.get('version')}, not v{version}")
        if manifest.get("source") != source:
            raise SystemExit(f"error: v{version} was published from {manifest.get('source')}, not {source}; "
                             "every platform of a release comes from the same source")
        existing = [entry for entry in manifest["binaries"] if entry["platform"] == row["platform"]]
        if existing and existing[0]["sha256"] != row["sha256"]:
            raise SystemExit(f"error: v{version} already publishes {row['platform']} with different bytes "
                             f"({existing[0]['sha256']}); releases are immutable, bump the build number")
        release_dir.mkdir(parents=True, exist_ok=True)
        place_artifact(tarball, release_dir / row["file"], row["sha256"])
        if decoder is not None:
            place_artifact(decoder[1], release_dir / decoder[0]["file"], decoder[0]["sha256"])
        state = "unchanged" if existing else "published"
        if not existing:
            manifest["binaries"] = sorted(manifest["binaries"] + [row], key=lambda entry: entry["file"])
            if decoder is not None:
                manifest["decoders"] = sorted(manifest["decoders"] + [decoder[0]],
                                              key=lambda entry: entry["file"])
            manifest["buildAt"] = min(entry["buildAt"] for entry in manifest["binaries"])
            artifacts = sorted(manifest["binaries"] + manifest["decoders"], key=lambda entry: entry["file"])
            sums = "".join(f"{entry['sha256']}  {entry['file']}\n" for entry in artifacts)
            sbs.replace_file(release_dir / "SHA256SUMS", sums.encode())
            sbs.write_json_atomic(manifest_path, manifest)
        # The pointers only move forward.
        promoted = False
        stable_path = feed_dir / "stable"
        stable = stable_path.read_text().strip().removeprefix("v") if stable_path.is_file() else None
        if promote and (stable is None or version_key(version) >= version_key(stable)):
            sbs.write_json_atomic(feed_dir / "latest.json", manifest)
            sbs.replace_file(stable_path, f"v{version}\n".encode())
            promoted = True
        elif promote:
            print(f"note: the feed's stable pointer names the newer v{stable}; left in place")
    return {"state": state, "release": str(release_dir), "manifest": manifest, "promoted": promoted}


def package(args: argparse.Namespace) -> int:
    feed_dir = feed_dir_for(args, sbs.cli_prefix(args))
    version = args.version
    sbs.check_version(version)
    base, platform, stage, expected_executable = read_package_dir(args.package_dir.expanduser())
    match = ONEIRON_VERSION.match(version)
    if not match or match["base"] != base:
        raise SystemExit(f"error: --version {version} must be {base}-oneiron.YYYYMMDD.N (the staged build is {base})")
    if platform not in SUPPORTED_PLATFORMS:
        raise SystemExit(f"error: platform {platform} is not one we release ({', '.join(SUPPORTED_PLATFORMS)})")
    if platform != host_platform():
        raise SystemExit(f"error: package {platform} on the host that built it (this is {host_platform()}): "
                         "the staged binary is run to probe its versions")
    if platform.startswith("linux-") and not args.decoder:
        raise SystemExit("error: a Linux release carries its split-debug decoder: pass --decoder "
                         f"<prime-agent-{base}-{platform}.debug.gz> (scripts/package_release.py writes it)")
    if not platform.startswith("linux-") and args.decoder:
        raise SystemExit("error: --decoder is only for Linux releases")
    package_release.validate(stage, base)
    fail_if_decoder_in_tree(stage)
    executable_sha256 = sbs.sha256_file(stage / "prime-agent")
    if executable_sha256 != expected_executable:
        raise SystemExit(f"error: {stage / 'prime-agent'} does not match binaries.json executableSha256")
    catalog = catalog_facts(stage, args.allow_fixture_catalog)
    source = source_facts(args.source_root, args.allow_dirty)

    with tempfile.TemporaryDirectory(prefix="pa-rs-package-") as scratch_name:
        scratch = Path(scratch_name)
        release_stage = scratch / f"prime-agent-{version}-{platform}"
        shutil.copytree(stage, release_stage)
        package_json = release_stage / "package.json"
        manifest = json.loads(package_json.read_text())
        manifest.update({"version": version, "commit": source["commit"]})
        package_json.write_text(json.dumps(manifest, indent=2) + "\n")
        empty = scratch / "empty"
        empty.mkdir()
        compiled = probe_version(release_stage / "prime-agent", empty)
        if compiled != base:
            raise SystemExit(f"error: the binary's compiled-in version is {compiled!r}, binaries.json says {base!r}")
        stamped = probe_version(release_stage / "prime-agent", None)
        if stamped != version:
            raise SystemExit(f"error: the stamped binary reports {stamped!r}, not {version!r}")
        tarball = scratch / f"prime-agent-{version}-{platform}.tar.gz"
        pack_tarball(release_stage, tarball, sorted(os.listdir(release_stage)))
        fail_if_decoder_in_archive(tarball)
        row = {"platform": platform, "target": SUPPORTED_PLATFORMS[platform], "file": tarball.name,
               "sha256": sbs.sha256_file(tarball), "executableSha256": executable_sha256,
               "bytes": tarball.stat().st_size, "compiledVersion": compiled,
               "buildAt": utc_from_mtime(stage / "prime-agent"), "catalog": catalog,
               "decoder": "attached" if args.decoder else "not-applicable"}
        # Linux: upstream's split-debug gates (no DWARF left in the shipped
        # ELF, the decoder paired by GNU build ID) run on every release.
        decoder = (decoder_row(args.decoder.expanduser(), stage / "prime-agent", base, version, platform, scratch)
                   if args.decoder else None)
        result = publish(feed_dir, version, base, source, row, tarball, decoder, args.promote)

    print(f"{result['state']} {row['file']} ({row['sha256']}) in {result['release']}")
    if result["promoted"]:
        print(f"feed {feed_dir} latest.json/stable -> v{version}")
    return 0
