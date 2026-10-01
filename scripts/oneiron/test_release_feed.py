#!/usr/bin/env python3
"""Contract tests for `side_by_side.py package` (release_feed.py).

Run: python3 scripts/oneiron/test_release_feed.py. Everything happens in temp
dirs: a fake package_release.py output, a throwaway git checkout as the
source, and a temp feed. No network, no real prefix, no daemon.
"""

from __future__ import annotations

import contextlib
import gzip
import io
import json
import os
import platform as host
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_feed  # noqa: E402
import side_by_side  # noqa: E402
# release_feed put scripts/release on the path.
from bundle_catalog import fixture_catalog_bodies, validate_bundled_catalog_dir  # noqa: E402

BASE = "0.9.8"
VERSION = "0.9.8-oneiron.20261001.1"
PLATFORM = "linux-x64"
SCRIPTS = Path(__file__).resolve().parent.parent

# Stands in for the Rust binary: `--version` reads the exe-adjacent manifest
# (PI_PACKAGE_DIR wins, as in pa-cli config::version) and falls back to the
# compiled-in version; `-p` (the probe's one-shot) answers as the requested
# model unless FAKE_PROBE_FAIL is set.
FAKE_BINARY = """#!/bin/sh
dir=${PI_PACKAGE_DIR:-$(dirname "$0")}
case "$1" in
--version)
  if [ -f "$dir/package.json" ]; then
    sed -n 's/^ *"version": *"\\([^"]*\\)".*/\\1/p' "$dir/package.json"
  else
    echo @COMPILED@
  fi
  exit 0 ;;
-p)
  [ -z "$FAKE_PROBE_FAIL" ] || exit 1
  model=
  while [ $# -gt 0 ]; do
    if [ "$1" = --model ]; then model=$2; fi
    shift
  done
  printf '{"type":"message_end","message":{"responseModel":"%s"}}\\n' "${model##*/}"
  exit 0 ;;
esac
exit 3
"""

# A real ELF (for the Linux decoder pairing) with the same --version logic.
FAKE_ELF_SOURCE = r"""
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  char exe[4096], path[4200], buf[65536];
  const char *dir = getenv("PI_PACKAGE_DIR");
  if (argc < 2 || strcmp(argv[1], "--version") != 0) return 3;
  if (!dir || !*dir) {
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n < 0) return 4;
    exe[n] = 0;
    dir = dirname(exe);
  }
  snprintf(path, sizeof path, "%s/package.json", dir);
  FILE *f = fopen(path, "r");
  if (!f) { puts("0.9.8"); return 0; }
  size_t len = fread(buf, 1, sizeof buf - 1, f);
  buf[len] = 0;
  fclose(f);
  char *key = strstr(buf, "\"version\"");
  char *start = key ? strchr(key + 9, '"') : NULL;
  char *end = start ? strchr(start + 1, '"') : NULL;
  if (!end) return 5;
  *end = 0;
  puts(start + 1);
  return 0;
}
"""


def make_package_dir(parent: Path, platform: str = PLATFORM, base: str = BASE, compiled: str = BASE,
                     binary: Path | None = None, readme: str = "readme\n") -> Path:
    """What `package_release.py --out-dir <parent>` leaves: the staged layout
    and its binaries.json (the tarball itself is not needed)."""
    stage = parent / f"prime-agent-{base}-{platform}"
    (stage / "prime-agent-runtime" / "src" / "rlm").mkdir(parents=True)
    (stage / "prime-agent-runtime" / "pyproject.toml").write_text("[project]\nname = 'rlm'\n")
    (stage / "prime-agent-runtime" / "src" / "rlm" / "repl.py").write_text("# repl\n")
    (stage / "skills" / "demo").mkdir(parents=True)
    (stage / "skills" / "demo" / "SKILL.md").write_text("# demo\n")
    (stage / "README.md").write_text(readme)
    (stage / "LICENSE").write_text("license\n")
    for name, body in fixture_catalog_bodies().items():
        (stage / name).write_text(body)
    (stage / "package.json").write_text(json.dumps({
        "name": "prime-agent", "version": base, "description": "Prime Agent: the RLM coding agent (Rust build)",
        "bin": {"prime-agent": "prime-agent"}, "piConfig": {"name": "prime-agent", "configDir": ".prime/agent"},
    }, indent=2) + "\n")
    target = stage / "prime-agent"
    if binary is None:
        target.write_text(FAKE_BINARY.replace("@COMPILED@", compiled))
    else:
        shutil.copy2(binary, target)
    target.chmod(0o755)
    (parent / "binaries.json").write_text(json.dumps({"version": f"v{base}", "binaries": [{
        "platform": platform, "file": f"prime-agent-{base}-{platform}.tar.gz", "sha256": "0" * 64,
        "executableSha256": side_by_side.sha256_file(target)}]}, indent=2) + "\n")
    return parent


def make_source_repo(path: Path, marker: str = "one") -> Path:
    path.mkdir(parents=True)
    (path / "RUST-BASE.md").write_text("- Base commit: `5784abc2aef523a78d5a8850a0c0be89883388b2`\n")
    (path / "marker").write_text(marker)
    git = ["git", "-C", str(path), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
           "-c", "commit.gpgsign=false"]
    subprocess.run([*git, "init", "-q"], check=True)
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "fixture"], check=True)
    return path


def git_out(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


class FeedFixture(unittest.TestCase):
    """A temp prefix (whose feed/ is the default feed), one source checkout,
    and host_platform pinned to the platform under test."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prefix = self.root / "share" / "prime-agent-oneiron-rs"
        self.feed = self.prefix / "feed"
        self.source = make_source_repo(self.root / "src")
        self.saved_host = release_feed.host_platform
        release_feed.host_platform = lambda: PLATFORM

    def tearDown(self) -> None:
        release_feed.host_platform = self.saved_host
        self.tmp.cleanup()

    def package(self, package_dir: Path, *extra: str, version: str = VERSION, source: Path | None = None) -> int:
        return side_by_side.main([
            "--prefix", str(self.prefix), "package", "--package-dir", str(package_dir), "--version", version,
            "--source-root", str(source or self.source), "--allow-fixture-catalog", *extra])

    def release(self, version: str = VERSION) -> Path:
        return self.feed / "releases" / f"v{version}"


class PackageTests(FeedFixture):
    def test_package_publishes_a_stamped_release_and_moves_the_feed_pointers(self) -> None:
        package_dir = make_package_dir(self.root / "pkg")
        stage = package_dir / f"prime-agent-{BASE}-{PLATFORM}"
        self.assertEqual(self.package(package_dir, "--no-decoder"), 0)

        release = self.release()
        tarball = release / f"prime-agent-{VERSION}-{PLATFORM}.tar.gz"
        self.assertEqual(sorted(os.listdir(release)), ["SHA256SUMS", "manifest.json", tarball.name])
        manifest = json.loads((release / "manifest.json").read_text())
        stage_binary = stage / "prime-agent"
        catalog = {name: side_by_side.sha256_file(stage / name) for name in fixture_catalog_bodies()}
        self.assertEqual(manifest, {
            "schema": release_feed.FEED_SCHEMA,
            "version": f"v{VERSION}",
            "package": "prime-agent",
            "baseVersion": BASE,
            "source": {"commit": git_out(self.source, "rev-parse", "HEAD"),
                       "tree": git_out(self.source, "rev-parse", "HEAD^{tree}"),
                       "build": git_out(self.source, "describe", "--always", "--dirty"),
                       "dirty": False, "rustBase": "5784abc2aef523a78d5a8850a0c0be89883388b2"},
            "binaries": [{
                "platform": PLATFORM, "target": "x86_64-unknown-linux-gnu", "file": tarball.name,
                "sha256": side_by_side.sha256_file(tarball),
                "executableSha256": side_by_side.sha256_file(stage_binary),
                "bytes": tarball.stat().st_size, "compiledVersion": BASE,
                "buildAt": release_feed.utc_from_mtime(stage_binary),
                "catalog": {"fixture": True, "counts": validate_bundled_catalog_dir(stage), **catalog},
                "decoder": "omitted"}],
            "decoders": [],
            "buildAt": release_feed.utc_from_mtime(stage_binary),
        })
        self.assertEqual((release / "SHA256SUMS").read_text(),
                         f"{side_by_side.sha256_file(tarball)}  {tarball.name}\n")
        self.assertEqual(json.loads((self.feed / "latest.json").read_text()), manifest)
        self.assertEqual((self.feed / "stable").read_text(), f"v{VERSION}\n")

        # Upstream's layout (files at the root, the binary 0755, everything
        # root-owned at mtime 0) with only package.json restamped.
        with tarfile.open(tarball) as archive:
            members = archive.getmembers()
            stamped = json.loads(archive.extractfile("package.json").read())
            binary_bytes = archive.extractfile("prime-agent").read()
        self.assertEqual(sorted(member.name for member in members),
                         sorted(str(path.relative_to(stage)) for path in stage.rglob("*")))
        self.assertEqual({(member.uid, member.gid, member.mtime) for member in members}, {(0, 0, 0)})
        self.assertEqual({member.name: oct(member.mode) for member in members if member.mode == 0o755
                          and member.isfile()}, {"prime-agent": oct(0o755)})
        self.assertEqual(stamped, {**json.loads((stage / "package.json").read_text()),
                                   "version": VERSION, "commit": manifest["source"]["commit"]})
        self.assertEqual(binary_bytes, stage_binary.read_bytes())
        # The staged layout itself is left as package_release.py wrote it.
        self.assertEqual(json.loads((stage / "package.json").read_text())["version"], BASE)

    def test_repackaging_is_byte_identical_and_a_no_op(self) -> None:
        package_dir = make_package_dir(self.root / "pkg")
        self.assertEqual(self.package(package_dir, "--no-decoder"), 0)
        tarball = self.release() / f"prime-agent-{VERSION}-{PLATFORM}.tar.gz"
        first = {path.name: path.read_bytes() for path in self.release().iterdir()}
        self.assertEqual(self.package(package_dir, "--no-decoder"), 0)
        self.assertEqual({path.name: path.read_bytes() for path in self.release().iterdir()}, first)
        # A fresh feed from the same inputs gets the same archive bytes.
        other_prefix = self.root / "other"
        self.assertEqual(side_by_side.main([
            "--prefix", str(other_prefix), "package", "--package-dir", str(package_dir), "--version", VERSION,
            "--source-root", str(self.source), "--allow-fixture-catalog", "--no-decoder"]), 0)
        self.assertEqual((other_prefix / "feed" / "releases" / f"v{VERSION}" / tarball.name).read_bytes(),
                         tarball.read_bytes())

    def test_a_published_platform_is_never_replaced(self) -> None:
        self.assertEqual(self.package(make_package_dir(self.root / "pkg"), "--no-decoder"), 0)
        before = {path.name: path.read_bytes() for path in self.release().iterdir()}
        changed = make_package_dir(self.root / "pkg2", readme="changed\n")
        with self.assertRaisesRegex(SystemExit, "immutable, bump the build number"):
            self.package(changed, "--no-decoder")
        self.assertEqual({path.name: path.read_bytes() for path in self.release().iterdir()}, before)

    def test_a_second_platform_joins_only_from_the_same_source(self) -> None:
        self.assertEqual(self.package(make_package_dir(self.root / "linux"), "--no-decoder"), 0)
        release_feed.host_platform = lambda: "darwin-arm64"
        other_source = make_source_repo(self.root / "src2", marker="two")
        darwin = make_package_dir(self.root / "darwin", platform="darwin-arm64")
        with self.assertRaisesRegex(SystemExit, "same source"):
            self.package(darwin, source=other_source)
        self.assertEqual(self.package(darwin), 0)
        manifest = json.loads((self.release() / "manifest.json").read_text())
        self.assertEqual([(row["platform"], row["target"], row["decoder"]) for row in manifest["binaries"]],
                         [("darwin-arm64", "aarch64-apple-darwin", "not-applicable"),
                          ("linux-x64", "x86_64-unknown-linux-gnu", "omitted")])
        self.assertEqual((self.release() / "SHA256SUMS").read_text(),
                         "".join(f"{row['sha256']}  {row['file']}\n" for row in manifest["binaries"]))
        self.assertEqual(json.loads((self.feed / "latest.json").read_text()), manifest)

    def test_the_version_is_the_oneiron_form_of_the_staged_base(self) -> None:
        package_dir = make_package_dir(self.root / "pkg")
        for version in ("0.9.9-oneiron.20261001.1", "0.9.8-rc.1", "0.9.8", "0.9.8-oneiron.2026101.1"):
            with self.assertRaisesRegex(SystemExit, "must be 0.9.8-oneiron.YYYYMMDD.N"):
                self.package(package_dir, "--no-decoder", version=version)
        self.assertFalse(self.feed.exists())

    def test_packaging_refuses_inputs_it_cannot_vouch_for(self) -> None:
        cases = [
            ("wrong host", make_package_dir(self.root / "darwin", platform="darwin-arm64"),
             ["--allow-fixture-catalog", "--no-decoder"], "on the host that built it"),
            ("no decoder choice", make_package_dir(self.root / "a"), ["--allow-fixture-catalog"],
             "carries its split-debug decoder"),
            ("fixture catalog", make_package_dir(self.root / "b"), ["--no-decoder"],
             "synthetic --fixture snapshot"),
            ("compiled version", make_package_dir(self.root / "c", compiled="0.9.7"),
             ["--allow-fixture-catalog", "--no-decoder"], "compiled-in version is '0.9.7'"),
        ]
        for label, package_dir, extra, message in cases:
            with self.subTest(label), self.assertRaisesRegex(SystemExit, message):
                side_by_side.main(["--prefix", str(self.prefix), "package", "--package-dir", str(package_dir),
                                   "--version", VERSION, "--source-root", str(self.source), *extra])
        self.assertFalse(self.feed.exists())

    def test_the_staged_binary_must_be_the_one_binaries_json_names(self) -> None:
        package_dir = make_package_dir(self.root / "pkg")
        binary = package_dir / f"prime-agent-{BASE}-{PLATFORM}" / "prime-agent"
        binary.write_text(binary.read_text() + "# swapped\n")
        with self.assertRaisesRegex(SystemExit, "does not match binaries.json executableSha256"):
            self.package(package_dir, "--no-decoder")
        self.assertFalse(self.feed.exists())

    def test_a_dirty_source_needs_allow_dirty_and_is_recorded(self) -> None:
        (self.source / "marker").write_text("edited")
        package_dir = make_package_dir(self.root / "pkg")
        with self.assertRaisesRegex(SystemExit, "uncommitted changes"):
            self.package(package_dir, "--no-decoder")
        self.assertEqual(self.package(package_dir, "--no-decoder", "--allow-dirty"), 0)
        source = json.loads((self.release() / "manifest.json").read_text())["source"]
        self.assertEqual((source["dirty"], source["build"].endswith("-dirty")), (True, True))

    def test_feed_pointers_never_move_back(self) -> None:
        newer = "0.9.8-oneiron.20261001.10"
        self.assertEqual(self.package(make_package_dir(self.root / "a"), "--no-decoder", version=newer), 0)
        self.assertEqual(self.package(make_package_dir(self.root / "b"), "--no-decoder",
                                      version="0.9.8-oneiron.20261001.9"), 0)
        self.assertEqual((self.feed / "stable").read_text(), f"v{newer}\n")
        self.assertEqual(json.loads((self.feed / "latest.json").read_text())["version"], f"v{newer}")
        self.assertEqual(sorted(os.listdir(self.feed / "releases")),
                         ["v0.9.8-oneiron.20261001.10", "v0.9.8-oneiron.20261001.9"])

    def test_a_feed_inside_ts_state_is_refused(self) -> None:
        with self.assertRaisesRegex(SystemExit, "overlaps protected TS state"):
            self.package(make_package_dir(self.root / "pkg"), "--no-decoder",
                         "--feed-dir", str(side_by_side.TS_PREFIX / "feed"))


@unittest.skipUnless(host.system() == "Linux" and shutil.which("gcc") and shutil.which("readelf"),
                     "the split-debug decoder is a GNU/Linux ELF artifact (needs gcc + binutils)")
class LinuxDecoderTests(FeedFixture):
    def build_split(self, name: str, marker: str) -> tuple[Path, Path]:
        """A real ELF through upstream's split_debug.py, as package_release.py
        does on Linux: the shipped image and its decoder."""
        work = self.root / name
        work.mkdir()
        source = work / "prime-agent.c"
        source.write_text(FAKE_ELF_SOURCE + f"\n/* {marker} */\nconst char *marker = \"{marker}\";\n")
        raw = work / "raw"
        subprocess.run(["gcc", "-g", "-Wl,--build-id", "-o", str(raw), str(source)], check=True)
        out = work / "dist"
        subprocess.run([sys.executable, str(SCRIPTS / "release" / "split_debug.py"), "--binary", str(raw),
                        "--shipped", str(out / "prime-agent"), "--out", str(out), "--version", BASE,
                        "--target", "x86_64-unknown-linux-gnu"], check=True, capture_output=True)
        return out / "prime-agent", out / f"prime-agent-{BASE}-{PLATFORM}.debug.gz"

    def test_the_decoder_is_paired_by_build_id_and_published_beside_the_tarball(self) -> None:
        shipped, decoder = self.build_split("good", "one")
        _, other_decoder = self.build_split("other", "two")
        package_dir = make_package_dir(self.root / "pkg", binary=shipped)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            self.package(package_dir, "--decoder", str(other_decoder))
        self.assertIn("decoder build ID does not match shipped ELF", stderr.getvalue())
        self.assertFalse(self.feed.exists())

        self.assertEqual(self.package(package_dir, "--decoder", str(decoder)), 0)
        manifest = json.loads((self.release() / "manifest.json").read_text())
        published = self.release() / f"prime-agent-{VERSION}-{PLATFORM}.debug.gz"
        self.assertEqual(published.read_bytes(), decoder.read_bytes())
        self.assertEqual(manifest["decoders"], [{
            "target": "x86_64-unknown-linux-gnu", "file": published.name,
            "sha256": side_by_side.sha256_file(decoder),
            "buildId": manifest["decoders"][0]["buildId"],
            "executableSha256": side_by_side.sha256_file(shipped)}])
        self.assertEqual(manifest["binaries"][0]["decoder"], "attached")
        self.assertEqual(sorted((self.release() / "SHA256SUMS").read_text().splitlines()),
                         sorted(f"{row['sha256']}  {row['file']}" for row in
                                manifest["binaries"] + manifest["decoders"]))
        with gzip.open(published) as handle, tarfile.open(
                self.release() / manifest["binaries"][0]["file"]) as archive:
            self.assertEqual(handle.read(4), b"\x7fELF")
            self.assertFalse(any(name.endswith((".debug", ".debug.gz")) for name in archive.getnames()))


if __name__ == "__main__":
    unittest.main()
