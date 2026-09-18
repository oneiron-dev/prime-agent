# Factory mode

Factory mode is a DAG launcher that runs outside the conversation runtime. It is optional, runs in a separate process, and requires Node 22.13+ with `node:sqlite`; ordinary Prime startup is unaffected.

The factory stores a versioned plan and a SQLite journal (`factory.db`) on the controller. Local or SSH host runners own foreground processes and durable receipts. An action is one foreground command: exit 0 accepts it and readies the actions that depend on it, any other exit rejects it and opens a wake. Nothing in the factory judges a result beyond that exit code; tests inside the command are the gate.

For the Oneiron ticket loop that runs on top of this launcher, read [factory-oneiron.md](factory-oneiron.md).

## Start a factory

Create a JSON plan with `version: 1`, `tickets`, `slots`, `actions`, and optional `roles`. Each action declares its ticket, dependencies, source fingerprint, command argv/cwd and host requirements. An empty plan (`{"version":1,"tickets":[],"slots":[],"actions":[]}`) is valid when `launch` will fill the DAG.

An optional `command.env` string map adds explicit child environment values. Keys must be POSIX variable names and values cannot contain NUL. The map is immutable once the action starts. The host merges it over inherited values, then sets `PRIME_FACTORY_ATTEMPT_ID` and `PRIME_FACTORY_SOURCE_FINGERPRINT` from the manifest.

Actions must use separate workspaces when running concurrently on the same host. Claims exclude a second active attempt on the same host and normalized declared cwd.

Example host configuration:

```json
{
  "controller": {"type":"local","runnerRoot":"/absolute/factory-runners"},
  "worker": {"type":"ssh","sshHost":"configured-ssh-alias","python":"/usr/bin/python3","runnerRoot":"/absolute/worker-runners"}
}
```

```sh
prime-agent factory init /absolute/factory plan.json --hosts hosts.json
prime-agent factory launch /absolute/factory w7-manifest.json mint-plan.json --launcher launcher.json
prime-agent factory status /absolute/factory
prime-agent factory resume /absolute/factory
prime-agent factory serve /absolute/factory
```

Initialization is paused. `launch` may load work into a paused factory. `resume` prints a per-ticket catch-up table, saves the catch-up as JSON, recomputes the scheduling frontier, unpauses and runs one scheduling tick. Use `run` or `serve` afterward for continuous scheduling. UNCERTAIN attempts remain operator work and are never automatically re-admitted.

`resume` exits with code 1 while an external owner pause exists, or when the tick leaves READY backlog with no RUNNING action (`idle_with_backlog`). The idle case records an incident wake. A changed installed runtime is journaled as `runtime_changed` and the factory continues; nothing refuses a worker for it.

`--pause-file /absolute/owner-pause` adds an independent external fence: its existence blocks new dispatch and plan changes. Tick reconciliation of active attempts still records running, terminal or uncertain state. `resume` neither removes nor overrides the pause file.

A `git:` fingerprint measures HEAD/tree, the tracked diff and nonignored untracked entries. Use `fingerprint` to calculate it on the selected host before planning the action. Runners check it before launch and record the resulting output identity separately. Opaque fingerprints are identifiers only. See [command runner contract](factory-command-runner.md).

## Changing plans

`import <dir> plan.json --expected-revision N` adds/upserts future work; omitted records persist. Started actions and source identities cannot be silently changed. To repair rejected work, add a replacement action, then use `supersede <dir> rejected-id replacement-id --expected-revision N --actor ... --reason ... --ref ...`. This preserves history and redirects only eligible unstarted dependencies.

Imports check the global revision inside the same SQLite transaction as the mutation. A no-op import keeps the revision. Coordinators can use an exact-once token:

```sh
prime-agent factory import /absolute/factory next-plan.json \
  --expected-revision 3 --mutation-id durable-outbox-request-id
```

The token and hash of the exact serialized plan plus expected revision commit with the plan. A replay of the same token and payload returns the recorded revision without another import; a changed payload under the same token fails.

`events <dir> --after <sequence>` gives compact ordered journal events. Wakes are visible in status.

## Recovery

The journal persists submission intent before host launch. Action, slot and workspace claims are atomic across controller processes. Detached host supervisors outlive a controller crash. A restarted controller uses launch/terminal receipts and process identity to recover; ordinary completion needs no operator.

Unreachable hosts, missing receipts and vanished supervisors remain uncertain and retain their claims. Expiry or a missing PID does not authorize a retry. `resolve <dir> attempt-id --actor ... --reason ... --ref ...` is an explicit assertion that evidence establishes safe retry; it does not kill unknown remote work. Contradictory terminal evidence records a conflict and pauses scheduling.

Stopping the foreground scheduling service gracefully pauses new dispatch. Existing supervised jobs can finish and their receipts remain recoverable.
