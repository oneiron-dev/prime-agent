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

/// Stands in for the Rust binary: `--version` reads the exe-adjacent
/// manifest (`PI_PACKAGE_DIR` wins) and falls back to the compiled version.
const FAKE_BINARY: &str = r#"#!/bin/sh
dir=${PI_PACKAGE_DIR:-$(dirname "$0")}
if [ "$1" = --version ] && [ -f "$dir/package.json" ]; then
  sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$dir/package.json"; exit 0
fi
if [ "$1" = --version ]; then echo 0.9.8; exit 0; fi
exit 3
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

/// What `package_release.py --out-dir <out>` leaves on this host.
fn package_release_output(out: &Path, platform: &str) {
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
    let binary = stage.join("prime-agent");
    write(&binary, FAKE_BINARY);
    run(Command::new("chmod").arg("755").arg(&binary));
    let executable = sha256_hex(&std::fs::read(&binary).expect("read the fixture binary"));
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
    let out = dir.path().join("package-out");
    package_release_output(&out, platform);
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
    if platform == "linux-x64" {
        package.arg("--no-decoder");
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
