# prime-agent-factory

The durable work factory for Prime Agent, as its own Node package. It keeps a DAG of foreground commands in a SQLite
journal, launches them on configured hosts through a portable Python runner, and settles each attempt by its
receipt. The Oneiron ticket runner on top of it cuts worktrees, drives the model seats, tests, reviews, publishes
and merges one ticket per pair of actions. Model seats run the `prime-agent` binary as a subprocess (print mode,
JSON event stream); the factory links no agent code.

`prime-agent-factory help` prints the full command reference.

## Requirements

- Node 22.13 or newer (`node:sqlite`). Bun is refused.
- Python 3 on every configured host (the command runner and the agent resolver are standard-library Python).
- git, gh and ssh for the ticket runner; bash, rsync and perl for the cargo wrapper on build hosts.
- A `prime-agent` binary that accepts `--json-event-profile`, `--no-extensions` and, for daemon custody,
  `--daemon-hosted` on every runner host.

## Install and run

```sh
cd packages/factory
npm ci
npm run build                      # dist/ plus dist/bin/cargo (executable)
node dist/cli-entry.js help        # or the `prime-agent-factory` bin once installed
```

The package has no runtime npm dependency. `npm run check` runs the typecheck, the test suite and the fork's test
policy gate (`TEST_POLICY_BASE=oneiron/main`). The suite builds the package into a temporary directory first and
runs its CLI tests against that build. From source, `node --import tsx src/cli-entry.ts <command>` works too.

`scripts/capture-rust-jsonl.py <prime-agent> test/fixtures/rust-jsonl` regenerates the captured Rust streams the
parser tests read (sandboxed HOME and TMPDIR, scripted faux provider, no network).

## Which agent binary the seats run

Native seats (`{"provider","model","thinking"}`) spawn the agent binary directly, as
`<agent> -p --mode json --json-event-profile factory-completed ... --no-extensions --no-skills`, with the prompt on
stdin (a review diff can exceed the per-argument limit). `launch` picks the binary, first match wins:

1. `prime-agent-factory launch ... --prime-agent-bin <path-or-command>`
2. `launcher.primeAgentBin` in launcher.json, else the binary an earlier launch recorded (a relaunch never switches
   binaries through the environment)
3. `PRIME_AGENT_FACTORY_AGENT_BIN`
4. `prime-agent` on PATH

It resolves the choice on the launcher host (over SSH for an SSH host; a relative path is refused there), stores
the absolute path in the factory config and every ticket.json, and pins its bytes in the journal (`agent_pinned`).
Every stage then runs that path. A launcher script such as `prime-agent-rs` is kept as written, never resolved
through its symlinks, so the environment it pins (socket, agent dir) stays in force. `resume` re-checks the pin
and journals a changed (`agent_changed`) or missing (`agent_unavailable`) binary; drift is never refused, like the
factory's own runtime pin, which covers Node and this package's modules only.

A seat `{"command": [...]}` runs that command with the prompt as its last argument instead. A launch whose seats are
all commands needs no agent binary.

```sh
PRIME_AGENT_FACTORY_AGENT_BIN=/absolute/path/prime-agent-rs \
  prime-agent-factory launch /absolute/factory w7-manifest.json mint-plan.json --launcher launcher.json
```

## Seat custody

`launcher.seatHosting` decides who owns a native seat's session.

- `owned` (default): the seat process runs the session itself. Killing a seat that went silent (`idleMs`) ends its
  turn; the next round continues the same session file with `-c`.
- `daemon`: seats pass `--daemon-hosted`; the agent daemon holds the session, which stays attachable from another
  terminal. Killing a silent seat only detaches its client, and the resident turn can still be running. So a seat
  whose stream does not show its turn's `agent_end` (killed for silence, or a client that died before or during
  the turn) stops the ticket with a custody failure instead of prompting that session again, unless the client
  never started at all: settle the turn (attach and wait for it, or stop it), then resolve the attempt. Use it
  when attachability matters more than unattended continuation.

Every seat's environment drops inherited worker authority (`PRIME_AGENT_INTERNAL_*`) and the runner's routing
credentials (`TYPESAFE_JEV_API_KEY`, `FACTORY_ADVISOR_API_KEY`). The TS build's legacy owned-worker frontend switch
is gone: the Rust binary has no such frontend.

## Watchdog

`dist/watchdog.js` is the exception-only watchdog (`assets/factory-exception-watchdog@.service` installs it as a
systemd user unit). It reads the factory through this package's own entry (`status`, `events`) and delivers
messages through the agent binary (`send --json`): `--agent-bin`, else the recorded `launcher.primeAgentBin` when
the launcher host is local, else `PRIME_AGENT_FACTORY_AGENT_BIN`, else `prime-agent`. An SSH launcher host's
recorded path names a binary over there, so the watchdog of such a factory refuses to start without `--agent-bin`
or `PRIME_AGENT_FACTORY_AGENT_BIN`. Every pass re-reads the factory config, so a relaunch that switched binaries
reaches a running watchdog (and a running `serve`, for the follow-ups it imports). A running `serve` (or `run`)
records itself in `<factory>/serve.json`: its pid, its process start identity and this package's entry. The
watchdog counts it as running only while that same process lives and the entry is the one the watchdog itself
runs; no command line is parsed.

## Migrating from `prime-agent factory`

The TypeScript build ran the factory as `prime-agent factory <command> ...`; the commands, options, plan, launcher
and hosts formats are unchanged here. What changes:

- Invoke `prime-agent-factory <command> ...` (or `node <package>/dist/cli-entry.js <command> ...`).
- Native seats run the selected agent binary, not the TypeScript CLI beside the factory module; pass
  `--prime-agent-bin` (or set `PRIME_AGENT_FACTORY_AGENT_BIN`) at the next `launch` so every ticket.json records it.
  Already-started actions keep their recorded argv, which points at the old ticket entry.
- Seats are client-owned by default (see Seat custody); the TS build's seats were IPC-owned workers of the factory
  process.
- The watchdog's `--cli` option is replaced by `--agent-bin`, and its unit points at `dist/watchdog.js` here.
- A new factory gets a version 2 runtime pin (`factoryArgv` instead of `cliArgv`) and a separate agent pin. Existing
  factory state is not migrated; a TS factory keeps running on the TS build.

## Not in this package yet

- A `prime-agent factory` command in the Rust binary that runs this package; invoke `prime-agent-factory` directly.
- Adoption telemetry for factory invocations.
- Seat environment for a warm agent daemon: under `seatHosting: "daemon"` a worker the daemon already runs keeps
  its own environment, so a seat's `PATH` and `W7_CARGO_*` overlay reaches it only once the daemon honors a
  client's launch environment.
- Migration of an existing TypeScript factory's state; such a factory keeps running on the TypeScript build.
