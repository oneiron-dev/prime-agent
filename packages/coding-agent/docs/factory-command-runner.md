# Factory command runner

Factory mode is an optional foreground service, separate from Prime sessions. The portable journal and scheduler can later move into Oneiron; this adapter is the host execution boundary.

The Node distribution requires Node 22.13 or later with `node:sqlite`. Each execution host needs Python 3 on a POSIX system. Ordinary Prime and `factory help` do not load SQLite.

## Host configuration

Pass a hosts JSON file to `prime factory init`:

```json
{
  "arch": {
    "type": "local",
    "runnerRoot": "/home/lexi/.local/share/oneiron-factory/attempts"
  },
  "mini": {
    "type": "ssh",
    "sshHost": "configured-mini-alias",
    "runnerRoot": "/Users/olety/.local/share/oneiron-factory/attempts",
    "python": "python3"
  }
}
```

Host keys must match plan slot hosts. SSH uses existing configuration and batch authentication. Job argv and cwd travel as JSON; the adapter never interpolates them into remote shell commands. The configured Python executable receives a fixed standard-library runner. No remote package installation is required.

`init <directory> <plan.json> --hosts <hosts.json>` writes `config.json` and `factory.db` in a new, explicit directory and starts paused. Keep runner roots outside source worktrees.

`resume <directory>` checks the controller runtime pin, prints and saves ledger catch-up, recomputes the frontier and runs one scheduling tick. It restores pending continuation artifacts without advancing a coordinator turn. It does not re-admit UNCERTAIN attempts. Resume is not a bare unpause; start `run` or `serve` afterward only for continuous scheduling.

Resume exits with code 1 for an external owner pause, an unaccepted runtime mismatch, or `idle_with_backlog` (READY actions remain with none RUNNING after the tick). The idle case records a wake. Use `--accept-runtime-change <reason>` only for an intentional runtime replacement; it journals a new controller pin without rewriting action runtime requirements.

An optional absolute `--pause-file` blocks every dispatch while that file exists. `resume` cannot remove or override it. `pause` stops future dispatch; already started commands keep running. SIGINT/SIGTERM or loss of the launching CLI persist a local scheduling pause. Resume explicitly after restarting to catch up from the journal and attempt one tick, not just clear that pause.

## Command and custody contract

Commands must run in the foreground and finish their work before their process tree exits. Foreground Cargo gates and foreground Claude invocations fit this contract. Commands that daemonize, use `setsid`, or spawn detached descendants are unsupported: those descendants can escape the monitored process group. This adapter does **not** provide arbitrary-process containment. Use a dedicated external adapter with its own durable completion proof for detached work.

Each attempt gets an exclusively created directory containing an immutable manifest, supervisor and child identities, stdout/stderr files, and atomic launch/terminal receipts. The detached supervisor survives a factory process crash. Replaying a launch for the same attempt never starts it again. A missing receipt, unreachable host, changed identity or surviving process group leaves custody uncertain.

Optional `command.timeoutMs` sends TERM and then KILL to the command process group. It is not a containment mechanism for escaped descendants. Log bytes go directly to files rather than accumulating in the scheduler.

`resolve <directory> <attempt-id> --actor ... --reason ... --ref ...` records external evidence permitting a retry; it does not prove cleanup itself or kill processes. Confirm the old worker is finished before using it.

## Source evidence

`fingerprint <host> <absolute-cwd> --hosts <hosts.json>` returns a `git:<sha256>` value using HEAD, its tree, a binary diff against HEAD, and sorted nonignored untracked paths, modes, bytes and symlink targets. The runner uses the same calculation immediately before launching. A mismatch or failed source verification records exit 125 without starting the command. Successful verification is a point-in-time check, not a worktree lock; use exclusive worktrees and existing gate/CAS wrappers.

When such a command finishes, its receipt preserves the submitted input fingerprint and records a separate output artifact fingerprint. Opaque fingerprints are labels only and require an explicitly validating wrapper for source formats other than Git.

Process exit is distinct from semantic acceptance. A `decision` action waits for an evidence-backed decision even after exit zero. `manage` runs a model in a separate process and proposes a decision; `--apply` is explicit. Role configuration belongs in the plan, with Astra low for ticket ownership and xhigh/max for escalations.

Use `factory help` for the JSON command interface. `events --after <sequence>` pages the durable journal. Plan imports preserve existing attempts; rejected actions can be explicitly superseded with a replacement and an evidence reference.
