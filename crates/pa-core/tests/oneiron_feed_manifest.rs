#![cfg(unix)]
//! Fork-only (Oneiron): the side-by-side release feed, gated against the
//! update reader a later native updater would use on it.
//!
//! `scripts/oneiron/side_by_side.py package` stamps a `package_release.py`
//! layout into `feed/releases/v<version>/manifest.json` and the feed-level
//! `latest.json`. Their rows must satisfy `parse_channel_manifest` (a known
//! platform, `file == prime-agent-<version>-<platform>.tar.gz`, a 64-hex
//! `sha256`); a row that does not is silently dropped by the reader, so this
//! runs the real packer on a fixture layout and parses what it wrote.

use std::path::{Path, PathBuf};
use std::process::Command;

use pa_core::update::install::current_platform_alias;
use pa_core::update::release::{
    parse_channel_manifest, sha256_hex, LatestRelease, ReleaseArtifact,
};

const BASE: &str = "0.9.8";
const VERSION: &str = "0.9.8-oneiron.20261001.1";

/// Stands in for the Rust binary on darwin: `--version` reads the
/// exe-adjacent manifest (`PI_PACKAGE_DIR` wins) and falls back to the
/// compiled version.
const FAKE_BINARY: &str = r#"#!/bin/sh
dir=${PI_PACKAGE_DIR:-$(dirname "$0")}
if [ "$1" = --version ] && [ -f "$dir/package.json" ]; then
  sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$dir/package.json"; exit 0
fi
if [ "$1" = --version ]; then echo 0.9.8; exit 0; fi
exit 3
"#;

/// The same `--version` logic as a real ELF: a Linux release ships a
/// split-debug ELF with its paired decoder (the packer runs upstream's
/// split-debug gates on it), so the fixture compiles and splits one.
const FAKE_ELF_SOURCE: &str = r#"
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
"#;

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the workspace root")
        .to_path_buf()
}

fn run(command: &mut Command) {
    let output = command.output().expect("spawn the fixture command");
    assert!(
        output.status.success(),
        "{command:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().expect("a parent dir")).expect("create the fixture dir");
    std::fs::write(path, body).expect("write the fixture file");
}

/// The binary `package_release.py` stages on this host, and on Linux the
/// split-debug decoder it writes beside it.
fn shipped_binary(work: &Path, platform: &str) -> (PathBuf, Option<PathBuf>) {
    if platform != "linux-x64" {
        let binary = work.join("prime-agent");
        write(&binary, FAKE_BINARY);
        run(Command::new("chmod").arg("755").arg(&binary));
        return (binary, None);
    }
    let source = work.join("prime-agent.c");
    write(&source, FAKE_ELF_SOURCE);
    let raw = work.join("cargo-prime-agent");
    run(Command::new("gcc")
        .args(["-g", "-Wl,--build-id", "-o"])
        .arg(&raw)
        .arg(&source));
    let dist = work.join("dist");
    run(Command::new("python3")
        .arg(workspace_root().join("scripts/release/split_debug.py"))
        .arg("--binary")
        .arg(&raw)
        .arg("--shipped")
        .arg(dist.join("prime-agent"))
        .arg("--out")
        .arg(&dist)
        .args(["--version", BASE, "--target", "x86_64-unknown-linux-gnu"]));
    (
        dist.join("prime-agent"),
        Some(dist.join(format!("prime-agent-{BASE}-linux-x64.debug.gz"))),
    )
}

/// What `package_release.py --out-dir <out>` leaves on this host.
fn package_release_output(out: &Path, platform: &str, binary: &Path) {
    let stage = out.join(format!("prime-agent-{BASE}-{platform}"));
    run(Command::new("python3")
        .arg(workspace_root().join("scripts/release/bundle_catalog.py"))
        .args(["generate", "--fixture", "--out"])
        .arg(&stage));
    write(
        &stage.join("prime-agent-runtime/pyproject.toml"),
        "[project]\nname = 'rlm'\n",
    );
    write(
        &stage.join("prime-agent-runtime/src/rlm/repl.py"),
        "# repl\n",
    );
    write(&stage.join("skills/demo/SKILL.md"), "# demo\n");
    write(&stage.join("README.md"), "readme\n");
    write(&stage.join("LICENSE"), "license\n");
    write(
        &stage.join("package.json"),
        &format!("{{\n  \"name\": \"prime-agent\",\n  \"version\": \"{BASE}\"\n}}\n"),
    );
    let staged = stage.join("prime-agent");
    std::fs::copy(binary, &staged).expect("stage the fixture binary");
    let executable = sha256_hex(&std::fs::read(&staged).expect("read the fixture binary"));
    let binaries = serde_json::json!({"version": format!("v{BASE}"), "binaries": [{
        "platform": platform, "file": format!("prime-agent-{BASE}-{platform}.tar.gz"),
        "sha256": "0".repeat(64), "executableSha256": executable}]});
    write(&out.join("binaries.json"), &binaries.to_string());
}

fn git(repo: &Path, args: &[&str]) {
    run(Command::new("git")
        .arg("-C")
        .arg(repo)
        .args([
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .args(["-c", "commit.gpgsign=false"])
        .args(args));
}

#[test]
fn oneiron_feed_manifests_parse_as_native_channel_manifests() {
    // The packer runs the staged binary, so it only packages for the host it
    // runs on, and we release from exactly two hosts; anywhere else there is
    // nothing to package.
    let platform = current_platform_alias();
    if !matches!(platform, "linux-x64" | "darwin-arm64") {
        eprintln!(
            "skipped: Oneiron releases are packaged on linux-x64 and darwin-arm64, not {platform}"
        );
        return;
    }
    let dir = tempfile::TempDir::new().expect("temp dir");
    let (binary, decoder) = shipped_binary(dir.path(), platform);
    let out = dir.path().join("package-out");
    package_release_output(&out, platform, &binary);
    let source = dir.path().join("source");
    write(&source.join("README.md"), "fixture source\n");
    git(&source, &["init", "-q"]);
    git(&source, &["add", "."]);
    git(&source, &["commit", "-q", "-m", "fixture"]);

    let prefix = dir.path().join("prefix");
    let mut package = Command::new("python3");
    package
        .arg(workspace_root().join("scripts/oneiron/side_by_side.py"))
        .arg("--prefix")
        .arg(&prefix)
        .args(["package", "--version", VERSION, "--allow-fixture-catalog"])
        .arg("--package-dir")
        .arg(&out)
        .arg("--source-root")
        .arg(&source);
    if let Some(decoder) = &decoder {
        package.arg("--decoder").arg(decoder);
    }
    run(&mut package);

    let release = prefix.join(format!("feed/releases/v{VERSION}"));
    let file = format!("prime-agent-{VERSION}-{platform}.tar.gz");
    let archive = std::fs::read(release.join(&file)).expect("the published archive");
    let expected = Some(LatestRelease {
        version: VERSION.to_string(),
        artifacts: vec![ReleaseArtifact {
            platform: platform.to_string(),
            file,
            sha256: sha256_hex(&archive),
        }],
    });
    for manifest in [
        release.join("manifest.json"),
        prefix.join("feed/latest.json"),
    ] {
        let body = std::fs::read(&manifest).expect("the published manifest");
        assert_eq!(
            parse_channel_manifest(&body),
            expected,
            "{}",
            manifest.display()
        );
    }
}
