# Rust base (Oneiron fork)

The Oneiron fork of prime-agent on the Rust product. Upstream replaced the TypeScript product on
`main` with the Rust port (`39bc99a91`, 2026-09-30); this branch line follows it. The TS fork
(`main`, deployed as `0.9.6-oneiron.*`) stays the launcher until cutover.

## Pin

- Base commit: `5784abc2aef523a78d5a8850a0c0be89883388b2`
- Upstream: PrimeIntellect-ai/prime-agent `main`, "pa-tui: drain the kitty stack past the alt-screen
  leave at exit (#3247)", 2026-10-01 01:56 UTC. Upstream ci, continuous, nightly and CodeQL were
  green on this sha.
- Branches on the fork (oneiron-dev/prime-agent): `rust-base-5784abc2a` points at the pin;
  `rust-oneiron` is the integration branch every lane PRs into.
- Never base on the `v0.9.8` tag (`7d442aafa`, the last TS release) and never merge upstream `main`
  into the TS branches.
- Toolchain: Rust 1.98.1, the version upstream CI pins (`.github/workflows/ci.yml`). An older
  stable trips clippy lints that 1.98 does not raise.

## Carried upstream patches

Cherry-picked with `-x`, so each commit names its upstream source. Drop a patch when its PR
merges upstream; a rebase onto a base that contains the merged change drops it automatically
when the diff is identical, otherwise drop it by hand.

| PR | Title | Upstream head | Find locally | State at pin |
|---|---|---|---|---|
| #3197 | retry silently dropped provider streams | `e4e7641b7` | `git log --grep 'cherry picked from commit e4e7641b7'` | open |
| #3201 | models: merge custom model compat over provider compat | `697c48def` | `git log --grep 'cherry picked from commit 697c48def'` | open |

## Fork-only changes

| Change | Where | Why |
|---|---|---|
| `PRIME_AGENT_SOCKET_DIR` | `crates/pa-daemon/src/platform/paths.rs` | Worker sockets always live in the socket dir, not beside a custom `PRIME_AGENT_DAEMON_SOCKET`; without this a side-by-side install's workers listen inside the TS `prime-agent-<uid>/` dir. Unset keeps TS parity. |
| `PRIME_AGENT_DISABLE_SELF_UPDATE` | `crates/pa-core/src/update/installer.rs`, `crates/pa-cli/src/self_update.rs` | Upstream's `update` / `/update` fetch and run the takeover installer (stops every TS daemon, replaces `~/.local/bin/prime-agent`); a side-by-side install must refuse. |
| `--no-extensions` accepted | `crates/pa-cli/src/args.rs` | Upstream removed extensions (#3189); the `sol` wrapper and factory still pass the flag. |
| Side-by-side install + probe | `scripts/oneiron/side_by_side.py` | Installs a staged release beside the TS build and writes receipts. |
| Test-policy gate | `scripts/check-test-policy.mjs` (from the TS fork), `scripts/oneiron/test_policy_gate.py` | Runs the fork's test policy with `TEST_POLICY_BASE=oneiron/main` and fails only on violations beyond the 4 upstream ones present at the pin (`scripts/oneiron/test-policy-baseline.txt`). |

## Side-by-side contract (until cutover)

- Install tree `~/.local/share/prime-agent-oneiron-rs/<version>/` (immutable per version) with
  `current -> <version>`; launcher `~/.local/bin/prime-agent-rs`.
- The launcher exports `PRIME_AGENT_SOCKET_DIR=${TMPDIR:-/tmp}/pa-rs-<uid>` (0700, owner-checked),
  `PRIME_AGENT_DAEMON_SOCKET=<that dir>/daemon.sock` and
  `PRIME_AGENT_KERNEL_VENV=~/.prime/agent/kernel-venv-rs`. It always overwrites those generic
  names; override only with `PRIME_AGENT_RS_SOCKET_DIR` / `PRIME_AGENT_RS_KERNEL_VENV`. The short
  `pa-rs-<uid>` name keeps macOS worker socket paths under the 104-byte `sun_path` limit.
- Self-update is shut. Upstream's `prime-agent update` and the TUI `/update` fetch and run the
  takeover installer, so the launcher sets `PRIME_AGENT_DISABLE_SELF_UPDATE=1`. That fork-only guard
  refuses both, plus the staged native updater. It also points `PRIME_AGENT_RUST_INSTALLER_URL` and
  `PRIME_AGENT_DOWNLOAD_BASE_URL` at a dead loopback endpoint (`http://127.0.0.1:1/…`) so the
  installer fails closed even without the guard, and sets `PI_SKIP_VERSION_CHECK=1` (notices
  only). A raw binary run without the launcher has none of this.
- `~/.local/bin/prime-agent`, the TS install tree, the TS socket dir and the TS kernel venv are
  never written. Never run upstream `install-rust.sh` or any `curl … | sh`: it stops every TS
  daemon and replaces `~/.local/bin/prime-agent`.
- Sessions, `models.json` and auth stay shared in `~/.prime/agent` (same session format, v3). Do
  not resume on Rust a TS session whose last compaction was remote: Rust ignores
  `remoteCompaction`, and the only history left is the placeholder summary.
- During the trial, never run `prime-agent-rs update` or a daemon stop without an explicit
  `--daemon-socket`. Daemon discovery's state root also covers `~/.prime/agent`.
- Known leak: child processes of a Rust session (bash tool, kernel) inherit the launcher's env.
  TS reads `PRIME_AGENT_KERNEL_VENV`, so a TS `sol --tools` started from inside a `prime-agent-rs`
  session runs its kernel from `kernel-venv-rs`. The TS kernel venv stays untouched. This goes
  away at cutover, when Rust moves to the default venv.

## Gates (local; upstream CI only runs on `main`)

```
make check                                    # fmt, clippy -D warnings, test --workspace, release build (Rust 1.98.1)
python3 scripts/oneiron/test_policy_gate.py   # TEST_POLICY_BASE=oneiron/main
python3 scripts/oneiron/test_side_by_side.py
```

## Re-pinning

1. `git fetch upstream`. Pick a `main` sha whose ci/continuous runs are green, then
   `git branch rust-base-<sha9> <sha>` and push it.
2. Rebase onto it on a new branch: `git rebase --onto rust-base-<new> rust-base-<old> <copy of rust-oneiron>`.
   Patches whose upstream PRs merged drop out; check what remains with
   `git cherry -v upstream/main`.
3. Run the gates, then `python3 scripts/oneiron/test_policy_gate.py --write-baseline` if upstream's
   runtime tests changed. Update this file's Pin section.
4. Moving `rust-oneiron` to the rebased line is a force-update, so it needs the owner's word.
