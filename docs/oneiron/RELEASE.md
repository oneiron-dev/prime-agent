# Releasing the side-by-side Rust build (Oneiron)

How a Rust build becomes a feed release and then the version `prime-agent-rs` runs.
Rolling back is in [ROLLBACK.md](ROLLBACK.md). The side-by-side contract (own agent dir,
socket dir, kernel venv, self-update shut) is in `RUST-BASE.md`.

Everything goes through one script, `scripts/oneiron/side_by_side.py`. Never run upstream
`install-rust.sh`, `prime-agent update`, or any `curl … | sh`: each of them replaces
`~/.local/bin/prime-agent` and stops every TS daemon.

## Paths

| Path | What |
|---|---|
| `~/.local/share/prime-agent-oneiron-rs/<version>/` | One immutable install per version |
| `~/.local/share/prime-agent-oneiron-rs/current` | The version `prime-agent-rs` runs (a symlink) |
| `~/.local/share/prime-agent-oneiron-rs/previous` | The version `current` pointed at before the last swap |
| `~/.local/share/prime-agent-oneiron-rs/receipts/<version>-<platform>/` | `INSTALL`/`PROBE`/`ACTIVATION`/`ROLLBACK-RECEIPT.json` |
| `~/.local/share/prime-agent-oneiron-rs/feed/` | The release feed (below) |
| `~/.local/bin/prime-agent-rs` | The launcher. `~/.local/bin/prime-agent` stays the TS build |

## Versions

`<base>-oneiron.YYYYMMDD.N`, for example `0.9.8-oneiron.20261002.1`. `<base>` is the Cargo
version the binary was compiled with. Bump `N` for every new payload, packaging-only changes
included. The packer stamps the version into the exe-adjacent `package.json`, and the binary
reports that version. The compiled-in version stays `<base>`; the manifest records both.

## 1. Build and package (on each host)

Linux x64 on the Arch box, then darwin-arm64 on the Mac. Each host packages its own build.

```sh
# real catalogs, never the --fixture snapshot (package refuses it)
python3 scripts/release/bundle_catalog.py generate --catalog-dir <prime-agent-catalog checkout> --out /tmp/catalog
cargo build --release -p pa-cli
python3 scripts/package_release.py --skip-build --catalog-assets /tmp/catalog --out-dir /tmp/pkg
python3 scripts/oneiron/side_by_side.py package --package-dir /tmp/pkg \
    --version 0.9.8-oneiron.20261002.1 \
    --decoder target/release/dist/prime-agent-0.9.8-linux-x64.debug.gz   # Linux only
```

`package` builds nothing. It checks the staged layout against `binaries.json` and re-validates
the catalogs. It refuses a dirty checkout unless you pass `--allow-dirty`, which is then
recorded. It runs the staged binary to confirm the compiled version is `<base>` and the stamped
version is `<version>`. Then it packs a deterministic tarball (upstream's packer: sorted
members, fixed owner, mtime and modes) and writes:

```
feed/releases/v<version>/prime-agent-<version>-<platform>.tar.gz
feed/releases/v<version>/prime-agent-<version>-linux-x64.debug.gz   (Linux; diagnosis only, never installed)
feed/releases/v<version>/SHA256SUMS
feed/releases/v<version>/manifest.json
feed/latest.json, feed/stable                                       (moved only forward)
```

`manifest.json` has `version` (`v<version>`), `package`, `baseVersion`, `source`
(`commit`, `tree`, `build`, `dirty`, `rustBase`), `buildAt`, `binaries` (one row per platform:
`platform`, `target`, `file`, `sha256`, `executableSha256`, `bytes`, `compiledVersion`,
`buildAt`, `catalog`, `decoder`) and `decoders`. The `version` and `binaries` rows are what
the Rust updater's channel-manifest parser reads (`pa-core` `update::release`;
`crates/pa-core/tests/oneiron_feed_manifest.rs` checks this).

Re-running `package` with the same inputs changes nothing. Different bytes for a platform that
is already published are refused, so bump `N`. A second platform joins a release only if it was
built from the same commit and tree. To get both platforms into one feed, copy the feed dir to
the Mac (for example with rsync), run `package --feed-dir <copy>` there, and copy it back. There
is no upload step.

## 2. Roll out (on each host)

```sh
python3 scripts/oneiron/side_by_side.py status
python3 scripts/oneiron/side_by_side.py rollout [--version <version>] [--tools]
```

In order:

1. **Verify.** Reads the release's row for this host's platform. `manifest.json`,
   `SHA256SUMS` and the tarball's sha256 must all agree. The hash is taken on a private copy,
   and that copy is what gets installed.
2. **Idle check.** The rollout connects only to the Rust supervisor socket
   (`${PRIME_AGENT_RS_SOCKET_DIR:-$TMPDIR/pa-rs-<uid>}/daemon.sock`, or `--rust-socket`). It
   checks the hello identity: the protocol, the socket path, and an executable under the
   prefix. Then it sends one `list` and refuses while there are live sessions. Anything that
   is not this install's supervisor is never sent a command. The TS socket dir is never
   connected to. Nothing is ever stopped. `--force-idle-check-skip` proceeds anyway and records
   that it did. Live sessions keep running the old binary until their supervisor restarts.
3. **Install** to `<prefix>/<version>/`. The executable must match the release row. If an
   earlier attempt left the same version installed but unselected, it is reused.
4. **Probe before selecting.** A scratch launcher (the real template) points at the new
   install. `--version` and a one-shot on `cpa-r`/`gpt-6.1-sol` must succeed; this is a real
   provider call. `--tools` also runs a kernel turn. If the probe fails, the version stays
   installed and unselected.
5. **Select.** The idle check runs again. Then `previous` is set to the old `current`,
   `current` is flipped, and the launcher is rewritten.
6. **Post-check.** `prime-agent-rs --version` must print the version, and the TS launcher must
   be unchanged.
7. **Old supervisor.** See below.

`receipts/<version>-<platform>/ACTIVATION-RECEIPT.json` records the status (`activated`,
`refused` or `failed`), the phase it stopped in, the release hashes and source, both idle
checks with the observed daemon identity, the `current`/`previous`/launcher/TS-launcher state
before and after, the probe summary, the checks, and per-phase timings. An earlier receipt of
the same name is kept beside it under its timestamp.

A running Rust supervisor is not restarted by the swap. If it runs another version but the same
protocol and schema, new `prime-agent-rs` clients still treat it as current, and it starts every
new session's worker from its own, older binary until it exits. The receipt's `notice` says so.
`--retire-idle-daemon` stops it after the swap, on the connection that just found it idle and
belonging to this install (`shutdown`, never forced). The next `prime-agent-rs` run then starts
the selected version. A supervisor with live sessions is never stopped.

## Not in this release

- Native self-update (`prime-agent update` against this feed) stays disabled. The launcher
  sets `PRIME_AGENT_DISABLE_SELF_UPDATE=1`. A managed root, an HTTP feed with root archive
  aliases and an Oneiron stable-train policy come in a later, separately verified lane.
- Homebrew and uploads anywhere.
