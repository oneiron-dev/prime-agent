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
| `--json-event-profile all\|factory-completed` | `crates/pa-cli/src/json_output.rs` | The TS fork's factory stream: the reduced profile drops the progressive `message_update`/`tool_execution_update` snapshots before serialization. |
| `--daemon-hosted` | `crates/pa-cli/src/hosted_print.rs`, `crates/pa-daemon/src/headless_client.rs` | The TS fork's resident print/json session (attachable while it runs; detach-only exit). Schema-30 commands only; flags the create contract cannot carry are refused. |
| Effective `--no-skills`/`--no-prompt-templates`/`--no-context-files` | `crates/pa-core/src/resources/mod.rs` (`ResourceLoadingPolicy`) | Upstream parses the flags but always discovered every resource; the `sol` wrapper and factory rely on `--no-skills` for prompt size. |
| Side-by-side install + probe | `scripts/oneiron/side_by_side.py` | Installs a staged release beside the TS build and writes receipts. |
| Test-policy gate | `scripts/check-test-policy.mjs` (from the TS fork), `scripts/oneiron/test_policy_gate.py` | Runs the fork's test policy with `TEST_POLICY_BASE=oneiron/main` and fails only on violations beyond the 4 upstream ones present at the pin (`scripts/oneiron/test-policy-baseline.txt`). |

## Side-by-side contract (until cutover)

- Install tree `~/.local/share/prime-agent-oneiron-rs/<version>/` (immutable per version) with
  `current -> <version>`; launcher `~/.local/bin/prime-agent-rs`.
- Own agent dir `~/.prime/agent-rs` (`PRIME_AGENT_CODING_AGENT_DIR`). The TS fleet's
  `~/.prime/agent` is shared mutable state, and a Rust daemon would act on it (audit,
  2026-10-01). It would move sessions into `sessions-archive`, delete TS update manifests at
  every boot, recover and back off TS schedules, rewrite `settings.json` wholesale, race OAuth
  refresh, and write differently-limited kernel snapshots. The installer seeds the Rust agent dir
  with links to `models.json` and `skills/` (read-only inputs: `models.json` loads unchanged) and
  a one-time copy of `settings.json`. It never copies `auth.json` (cpa providers carry their keys
  in `models.json`; a copied OAuth refresh token would still race TS).
  Consequence: during the trial, Rust and TS sessions are separate stores. Sharing them needs the
  fork-only shared-store guard (`PRIME_AGENT_SHARED_STORE`), a follow-up lane.
- The launcher exports `PRIME_AGENT_CODING_AGENT_DIR=~/.prime/agent-rs`,
  `PRIME_AGENT_SOCKET_DIR=${TMPDIR:-/tmp}/pa-rs-<uid>` (0700, owner-checked),
  `PRIME_AGENT_DAEMON_SOCKET=<that dir>/daemon.sock` and
  `PRIME_AGENT_KERNEL_VENV=~/.prime/agent-rs/kernel-venv`. It clears inherited session-dir
  overrides and always overwrites the generic names. Override only with
  `PRIME_AGENT_RS_AGENT_DIR` / `PRIME_AGENT_RS_SOCKET_DIR` / `PRIME_AGENT_RS_KERNEL_VENV`; each is
  validated before anything is created: absolute, canonical through symlinked ancestors, and no
  overlap with TS state. The short `pa-rs-<uid>` name keeps macOS worker socket paths under the
  104-byte `sun_path` limit.
- Self-update is shut. Upstream's `prime-agent update` and the TUI `/update` fetch and run the
  takeover installer, so the launcher sets `PRIME_AGENT_DISABLE_SELF_UPDATE=1`. That fork-only guard
  refuses both, plus the staged native updater. It also points `PRIME_AGENT_RUST_INSTALLER_URL` and
  `PRIME_AGENT_DOWNLOAD_BASE_URL` at a dead loopback endpoint (`http://127.0.0.1:1/…`) so the
  installer fails closed even without the guard, and sets `PI_SKIP_VERSION_CHECK=1` (notices
  only). A raw binary run without the launcher has none of this.
- `~/.local/bin/prime-agent`, the TS install tree, the TS socket dir and the TS kernel venv are
  never written. Never run upstream `install-rust.sh` or any `curl … | sh`: it stops every TS
  daemon and replaces `~/.local/bin/prime-agent`.
- Never point a Rust run at TS sessions (`--session-dir ~/.prime/agent/sessions`). A Rust daemon
  housekeeps whatever sessions dir it serves. When sessions are shared again, do not resume on
  Rust a TS session whose last compaction was remote: Rust ignores `remoteCompaction`, and the only
  history left is the placeholder summary.
- During the trial, never run a daemon stop without an explicit `--daemon-socket`.
- Known leak: child processes of a Rust session (bash tool, kernel) inherit the launcher's env.
  TS reads `PRIME_AGENT_KERNEL_VENV` and `PRIME_AGENT_CODING_AGENT_DIR`, so a TS `sol` started from
  inside a `prime-agent-rs` session runs against the Rust agent dir and venv. The TS state stays
  untouched; that TS run just sees Rust's store. This goes away at cutover.

## Gates (local; upstream CI only runs on `main`)

```
scripts/oneiron/gate.sh all     # fmt, clippy -D warnings, policy (TEST_POLICY_BASE=oneiron/main), sandboxed workspace tests
scripts/oneiron/gate.sh crates pa-core pa-daemon -- <filter>   # focused, same sandbox
```

Never run a bare `cargo test --workspace` on a machine with a live TS fleet. The kernel e2e suites
bootstrap the ambient kernel venv and probe the default daemon socket dir. `gate.sh` runs every test
under a throwaway HOME and TMPDIR, with the product env scrubbed, TZ=UTC and the TS binary off
PATH, the way a CI runner sees it.

## Re-pinning

1. `git fetch upstream`. Pick a `main` sha whose ci/continuous runs are green, then
   `git branch rust-base-<sha9> <sha>` and push it.
2. Rebase onto it on a new branch: `git rebase --onto rust-base-<new> rust-base-<old> <copy of rust-oneiron>`.
   Patches whose upstream PRs merged drop out; check what remains with
   `git cherry -v upstream/main`.
3. Run the gates, then `python3 scripts/oneiron/test_policy_gate.py --write-baseline` if upstream's
   runtime tests changed. Update this file's Pin section.
4. Moving `rust-oneiron` to the rebased line is a force-update, so it needs the owner's word.
