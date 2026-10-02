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
    --decoder target/release/dist/prime-agent-0.9.8-linux-x64.debug.gz   # Linux: required
```

`package` builds nothing. It checks the staged layout against `binaries.json` and re-validates
the catalogs. On Linux it runs upstream's split-debug gates on every release: no DWARF left in
the shipped ELF, and the `--decoder` paired with it by GNU build ID. There is no way to publish
a Linux release without its decoder. It runs the staged binary to confirm the compiled version
is `<base>` and the stamped version is `<version>`. Then it packs a deterministic tarball
(upstream's packer: sorted members, fixed owner, mtime and modes) and writes:

```
feed/releases/v<version>/prime-agent-<version>-<platform>.tar.gz
feed/releases/v<version>/prime-agent-<version>-linux-x64.debug.gz   (Linux; diagnosis only, never installed)
feed/releases/v<version>/SHA256SUMS
feed/releases/v<version>/manifest.json
feed/latest.json, feed/stable                                       (moved only forward)
```

`manifest.json` has `version` (`v<version>`), `package`, `baseVersion`, `source`
(`commit`, `tree`, `build`, `dirty`, `dirtySha256`, `attestedBy`, `rustBase`), `buildAt`,
`binaries` (one row per platform: `platform`, `target`, `file`, `sha256`, `executableSha256`,
`bytes`, `compiledVersion`, `buildAt`, `catalog`, `decoder`) and `decoders`. The `version` and
`binaries` rows are what the Rust updater's channel-manifest parser reads (`pa-core`
`update::release`; `crates/pa-core/tests/oneiron_feed_manifest.rs` checks this).

**Source provenance.** The binary carries no commit of its own, so `source` describes the
checkout `package` runs from (`attestedBy: "packaging-checkout"`), not the build. Package from
the same checkout, unchanged, that you built from. A dirty checkout is refused unless you pass
`--allow-dirty`; then `dirtySha256` digests the exact uncommitted state (the diff against HEAD
plus every untracked file), and a second platform must carry the same one.

Re-running `package` with the same inputs changes nothing in the release. It still moves the
feed pointers forward, so a release first published with `--no-promote` can be promoted by
running `package` again without it. Different bytes for a platform that is already published
are refused, so bump `N`. A second platform joins a release only from the same source facts.
To get both platforms into one feed, copy the feed dir to the Mac (for example with rsync), run
`package --feed-dir <copy>` there, and copy it back. There is no upload step. The feed dir is
checked like every other destination (`RUST-BASE.md`, the protected set): by its canonical
spelling, it may not equal, sit in or contain TS state. Below the feed root, `releases/` and
each release dir must be real directories; a symlinked one is refused before anything is
written through it. The install prefix may hold no link but `current` and `previous`, so a
symlinked `receipts/` there is refused too.

## 2. Roll out (on each host)

```sh
python3 scripts/oneiron/side_by_side.py status
python3 scripts/oneiron/side_by_side.py rollout [--version <version>] [--tools] [--refresh-skills] [--skill-hubs <dir>]
```

First, before anything is written, the same checks as `install`: the prefix, the bin dir and
the agent dir, socket dir and kernel venv the launcher will use are checked against TS state,
the prefix may hold no link but `current` and `previous`, and the agent dir no link but
`models.json`. Then, in order (the whole run holds the install prefix's lock, so a second
`rollout` or `rollback` started meanwhile is turned away before it writes anything):

1. **Verify.** Reads the release's row for this host's platform. `manifest.json`,
   `SHA256SUMS` and the tarball's sha256 must all agree. The hash is taken on a private copy,
   and that copy is what gets installed.
2. **Idle check.** The rollout connects only to the Rust supervisor socket
   (`${PRIME_AGENT_RS_SOCKET_DIR:-<tmp>/pa-rs-<uid>}/daemon.sock`, `<tmp>` being `/tmp` on
   macOS and `$TMPDIR` (else `/tmp`) elsewhere, or `--rust-socket`). A socket dir whose longest
   socket path (`<dir>/w-<12 hex>-<12 hex>.sock`, plus the NUL) would not fit the platform's
   `sun_path` (104 bytes on macOS, 108 on Linux) is refused before anything is written, as the
   launcher refuses it. It
   checks the hello identity: the protocol, the socket path, and an executable that is an
   install's `prime-agent` under the prefix. Then it sends one `list` and refuses while there
   are live sessions. Anything that is not this install's supervisor is never sent a command.
   A path in a TS socket dir (`prime-agent-<uid>` or `prime-agent-user` under `$TMPDIR` or
   `/tmp`, whatever `$TMPDIR` says now) is never connected to. Nothing is stopped here.
   `--force-idle-check-skip` proceeds anyway and records that it did. Live sessions keep
   running the old binary until their supervisor restarts.
3. **Install** to `<prefix>/<version>/`. The executable must match the release row. If an
   earlier attempt left the same version installed but unselected, it is reused only when its
   whole payload (every file, its content and executable bit) equals the verified tarball's.
   The receipt records that payload digest; `rollback` checks it later. The agent dir is then
   seeded the way `install` seeds it (`RUST-BASE.md`): a `models.json` link, its own skills
   (hub categories rendered for it, the rest a snapshot; kept unless `--refresh-skills`), a
   one-time `settings.json` copy, never `auth.json`.
4. **Probe before selecting.** A scratch launcher (the real template) points at the new
   install. `--version` and a one-shot on `cpa-r`/`gpt-6.1-sol` must succeed; this is a real
   provider call. `--tools` also runs a kernel turn. If the probe fails, the version stays
   installed and unselected. The launcher sets `PYTHONPYCACHEPREFIX` to
   `~/.prime/agent-rs/python-cache`: the kernel imports bundled Python skills in place, and
   their bytecode must not land inside the immutable install. The launcher refuses to start
   when that cache resolves outside the agent dir (a symlink out of it).
5. **Select.** The idle check runs again. Then, under the lock, one last look: `current`,
   `previous` and the launcher must still be what the run started from, and the install's
   payload digest must still equal the one verified at install time. Only then is the
   launcher rewritten, `previous` set to the old `current`, and `current` flipped. A launcher
   that cannot be written leaves `current` where it was.
6. **Post-check.** `prime-agent-rs --version` must print the version, and the TS launcher must
   be unchanged.
7. **Old supervisor.** See below.

`receipts/<version>-<platform>/ACTIVATION-RECEIPT.json` records the status (`activated`,
`refused` or `failed`), the phase it stopped in, the release hashes and source, both idle
checks with the observed daemon identity, the `current`/`previous`/launcher/TS-launcher state
before and after, the probe summary, the checks, and per-phase timings. It is journaled: written
as `running` before the first check, again on entering every phase and right before the swap,
then with the outcome. Any error (a permission or archive error included) is recorded as
`failed` with its type. A receipt still saying `running` means the run died in the phase it
names; `status` and the `current` symlink tell what happened. An earlier receipt of the same
name is kept beside it under its timestamp.

Rolling out the version that is already current runs every phase again (the swap is then a
no-op). That re-verifies it, and finishes an activation that was interrupted.

A running Rust supervisor is not restarted by the swap, and these scripts never stop one: they
only ever send it `list`. If it runs another release but the same protocol and schema, new
`prime-agent-rs` clients still treat it as current, and it starts every new session's worker
from its own, older binary until it exits. Its release is read from its executable path (the
hello's `appVersion` is the compiled Cargo version, the same for every Oneiron build of one
base). The receipt's `notice` says which release it still runs. Making the new release take
over daemon-hosted sessions needs that supervisor stopped while it is idle. The daemon wire has
no stop that refuses while sessions are live, decided together with session admission
(`shutdown` is unconditional), so a `list`-then-`shutdown` from outside can stop a session
created in between. That stop stays an operator decision outside these scripts until the
daemon offers an idle-only shutdown.

A release that changes the schema is different: the first `prime-agent-rs` client that ensures
the daemon (the TUI or a `--daemon-hosted` run, not these scripts) treats the older supervisor
as stale, replaces it when no session is active, and refuses to start while one is (it prints
the `shutdown --force` hint). Schema revision 31 (the typed worker-startup failure, the
`--tools`/`--no-tools`/`--no-builtin-tools` selection, and the session policy that
`--daemon-hosted` carries for `--offline` and `--no-skills`) is such a change. All three share
one schema id: a daemon from a revision-31 build that lacks one of them stays current for a newer
client, which refuses the flags that daemon does not advertise until it is stopped.

## Not in this release

- Native self-update (`prime-agent update` against this feed) stays disabled. The launcher
  sets `PRIME_AGENT_DISABLE_SELF_UPDATE=1`. A managed root, an HTTP feed with root archive
  aliases and an Oneiron stable-train policy come in a later, separately verified lane.
- Homebrew and uploads anywhere.
