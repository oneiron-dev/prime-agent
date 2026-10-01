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
| A timed-out prompt route keeps its admission | `crates/pa-daemon/src/prompt_admission.rs` | Upstream's 10-minute `prompt_and_wait` route budget is shorter than TS's 24-hour worker forward and deleted the admission with the route, so `cancel_prompt_admission` answered `unknown` for a turn still running. The record now stays until one read has fetched the worker's status; `--daemon-hosted` relies on it to tell its own running turn from a queued or lost prompt. No wire field changes. |
| Headless selection skips `provider_retry_outcome` | `crates/pa-core/src/session_engine/headless.rs` | Upstream's one-row retry disclosure (a sanctioned TS divergence) is persisted after the episode's last assistant and hid it from text-mode selection; TS, which keeps only the per-attempt rows, prints the recovered answer. |
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
  with a link to `models.json` (no Rust writer; it loads unchanged), its own `skills/` and a
  one-time copy of `settings.json`. The hub categories the TS `skills/LOCK.host.json` lists are
  rendered for the Rust agent dir, as the TS deploy was: prime-skill-hubs' `scripts/render-host.py`
  (from `--skill-hubs`, default `~/code/prime-skill-hubs`, read through a shared clone) at the
  lock's `source_commit` and `host_profile`, laid out as `<hub>/` plus the lock at the top, and
  checked byte for byte against the TS lock outside the rewritten agent-root paths. Every other
  entry is a snapshot. Without the checkout or the commit (the Mac), or on any mismatch, the whole
  TS dir is a snapshot and the receipt says `skillsSource: snapshot-fallback` with the reason; a
  render records `hubsCommit` and `lockSha256`. Either way the result is files only (a link becomes
  a copy of what it names; `__pycache__`, `*.egg-info`, `.venv`, `node_modules` stay behind): the
  kernel installs Python skills editable and imports them, writing beside the source, so a link
  would write into the TS tree. Existing skills are kept, `install --refresh-skills` rebuilds them,
  and an old-layout `skills` link is replaced on the next install. It never copies `auth.json`
  (cpa providers carry their keys in `models.json`; a copied OAuth refresh token would still race
  TS).
  Consequence: during the trial, Rust and TS sessions are separate stores. Sharing them needs the
  fork-only shared-store guard (`PRIME_AGENT_SHARED_STORE`), a follow-up lane.
- The launcher exports `PRIME_AGENT_CODING_AGENT_DIR=~/.prime/agent-rs`,
  `PRIME_AGENT_SOCKET_DIR=${TMPDIR:-/tmp}/pa-rs-<uid>` (0700, owner-checked),
  `PRIME_AGENT_DAEMON_SOCKET=<that dir>/daemon.sock` and
  `PRIME_AGENT_KERNEL_VENV=~/.prime/agent-rs/kernel-venv`. It always overwrites the generic names
  and clears inherited session dirs and harness/debug sinks (`RLM_SESSION_DIR`,
  `RLM_HARNESS_STATE_DIR`, `RLM_GLOBAL_HARNESS_STATE_DIR`, `PA_COMPACTION_TRACE`,
  `PA_MCP_LOGIN_URL_FILE`, `PA_DAEMON_EVENT_LOG`), an inherited restart roster
  (`PRIME_AGENT_UPDATE_ROSTER`) and every `PRIME_AGENT_INTERNAL_*` switch. Override only with
  `PRIME_AGENT_RS_AGENT_DIR` / `PRIME_AGENT_RS_SOCKET_DIR` / `PRIME_AGENT_RS_KERNEL_VENV`. The
  short `pa-rs-<uid>` name keeps macOS worker socket paths under the 104-byte `sun_path` limit.
- One protected set for every path the installer or launcher writes (prefix, receipts, bin dir,
  agent dir, socket dir, kernel venv): `PROTECTED_STATE` in `side_by_side.py`, which also renders
  the launcher's list. It is the TS socket dirs `<tmp>/prime-agent-<uid>` and
  `<tmp>/prime-agent-user` (under `$TMPDIR` and `/tmp`), the TS agent dir `~/.prime/agent` and its
  XDG location `${XDG_DATA_HOME:-~/.local/share}/prime/agent`, and the TS install tree. No path may
  equal, sit in or contain one. Paths must be absolute with no empty, `.` or `..` component, are
  judged by their canonical target (a link to a missing dir is refused), and are all checked before
  anything is written. The agent dir may hold no link but `models.json` (to a regular file), a
  linked dir in the kernel venv must stay inside it (uv's `lib64 -> lib`), and the prefix may hold
  no link but `current`. A tree that cannot be scanned is refused.
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

## Gates (upstream CI only runs on `main`)

```
scripts/oneiron/gate.sh all     # fmt, clippy -D warnings, policy (TEST_POLICY_BASE=oneiron/main), workspace tests
scripts/oneiron/gate.sh crates pa-core pa-daemon -- <filter>   # focused
```

`gate.sh` runs in one of two modes and prints which.

- Offload (`gate: offload mode (build boxes)`), wherever `/home/lexi/w8-opus/offload/env.sh` exists
  (Arch; owner rule: no compiles there). It sources that file, so the offload cargo wrapper is
  first on PATH and `W7_CARGO_WORK` is set, and runs clippy and tests on the build boxes as
  `cargo +1.98.1 …` (the toolchain travels in the command; `RUSTUP_TOOLCHAIN` does not). No local
  build, bootstrap or sandbox: the remote run gets none of this host's env, and the boxes run no TS
  fleet. `fmt` stays local. The wrapper silently runs cargo on this host when it is not first on
  PATH, `W7_CARGO_WORK` is unset, the worktree is not directly under
  `…/prime-agent/.claude/worktrees/` (or `/home/lexi/w8-opus/`), or its hosts file
  (`…/offload/hosts`, else `W7_CARGO_HOSTS`) lists no build box or a `local` one, so the gate
  refuses to run cargo at all in those cases. Each offloaded call also has to show the wrapper's
  `[factory-cargo] <box> slot` line on stderr; without one cargo ran here and the gate fails. An
  explicit `PA_TS_BINARY` cannot travel (the wrapper forwards a fixed env list), so the test steps
  refuse it: run that comparison in local mode on the Mac. A remote failure that is not the code
  (sync, ssh, toolchain): say so and rerun once; never fall back to a local run. `cargo build`
  stays local (`-j 8`, the gate target dir).
- Local (`gate: local mode`), without the offload kit (the Mac). Never run a bare `cargo test
  --workspace` on a machine with a live TS fleet: the kernel e2e suites bootstrap the ambient kernel
  venv and probe the default daemon socket dir. The gate builds, bootstraps and tests under a
  throwaway HOME and TMPDIR, with the product env scrubbed (`PRIME_AGENT_*`, `PI_*`, `RLM_*`,
  `PA_*`; an explicit `PA_TS_BINARY` is kept), TZ=UTC and the TS binary off PATH, the way a CI
  runner sees it. A failed build or bootstrap fails the gate.

## Re-pinning

1. `git fetch upstream`. Pick a `main` sha whose ci/continuous runs are green, then
   `git branch rust-base-<sha9> <sha>` and push it.
2. Rebase onto it on a new branch: `git rebase --onto rust-base-<new> rust-base-<old> <copy of rust-oneiron>`.
   Patches whose upstream PRs merged drop out; check what remains with
   `git cherry -v upstream/main`.
3. Run the gates, then `python3 scripts/oneiron/test_policy_gate.py --write-baseline` if upstream's
   runtime tests changed. Update this file's Pin section.
4. Moving `rust-oneiron` to the rebased line is a force-update, so it needs the owner's word.
