# Factory mode

Factory mode coordinates work outside the conversation runtime. It is optional, runs in a separate process, and requires Node 22.13+ with `node:sqlite`; ordinary Prime startup is unaffected. Execution records and adapter contracts are independent of Prime sessions so the factory can later move into Oneiron.

The factory stores a versioned plan and SQLite journal on the controller. Local or SSH host runners own foreground processes and durable receipts. Models provide decisions through a separate command; their latency does not block capacity refill.

## Start a factory

Create a JSON plan with `version: 1`, `tickets`, `slots`, `actions`, and optional `roles`. Each action declares its ticket, dependencies, source fingerprint, command argv/cwd, host requirements, and `kind`:

- `process`: a successful foreground process can satisfy this gate.
- `decision`: successful execution still requires an explicit evidence-bearing acceptance decision. Give it a description and acceptance criteria.

Actions must use separate workspaces when running concurrently on the same host. Claims exclude a second active attempt on the same host and normalized declared cwd. Symlink aliases are not resolved by that journal guard; configure canonical workspace paths.

Example host configuration:

```json
{
  "controller": {"type":"local","runnerRoot":"/absolute/factory-runners"},
  "worker": {"type":"ssh","sshHost":"configured-ssh-alias","python":"/usr/bin/python3","runnerRoot":"/absolute/worker-runners"}
}
```

```sh
prime-agent factory fingerprint controller /absolute/worktree --hosts hosts.json
prime-agent factory init /absolute/factory plan.json --hosts hosts.json
prime-agent factory status /absolute/factory
prime-agent factory resume /absolute/factory
prime-agent factory serve /absolute/factory
```

Initialization is paused. Resume is explicit. `--pause-file /absolute/owner-pause` adds an independent external fence: its existence blocks dispatch and mutations regardless of local resume. Archive that sentinel only as part of the owner's explicit resume procedure. Do not remove an existing wave pause to run an unrelated fixture.

A `git:` fingerprint measures HEAD/tree, the tracked diff and nonignored untracked entries. Use `fingerprint` to calculate it on the selected host before planning the action. Runners check it before launch and record resulting output identity separately. Opaque fingerprints are identifiers only; they need a project-specific verification wrapper if used for code work. See [command runner contract](factory-command-runner.md) for the exact foreground/process and source boundaries.

## Decisions and changing plans

Models are configured per role, outside the engine. For example, a `ticketOwner` role may specify provider `cpa-r`, model `gpt-6-astra`, and effort `low`; a `coordinator` role may use the same model at `xhigh`. Existing first-party implementation/review tools run as foreground command actions. Role declarations do not by themselves launch models or import live tickets.

Run an owner only when a wake requires judgment:

```sh
prime-agent factory manage /absolute/factory action-id --role ticketOwner --evidence /absolute/review.json
prime-agent factory manage /absolute/factory action-id --role ticketOwner --evidence /absolute/review.json --apply
```

The first form saves a proposal. The second applies a valid accept/reject decision; a defer leaves the wake unresolved. Each request includes one action, current attempt, dependency states and bounded explicitly supplied evidence. A decision is bound to its observed plan revision and attempt. Missing criteria, missing substantive evidence or uncertain process custody cannot be converted into automatic semantic acceptance.

Management uses the existing Prime model registry and auth configuration without starting a session or daemon. Requests, proposals, evidence pointers and usage are saved privately under the factory's `decisions/` directory. A receipt marked `modelIdentitySource: sdk` records the SDK-reported model; it is not independent verification of a gateway's raw model identity. Dollar values in SDK usage are list-price estimates, not subscription cash charges.

Manual decisions use `decide <dir> <action> accept|reject --actor ... --reason ... --ref ...`. `import <dir> plan.json` adds/upserts future work; omitted records persist. Started inputs and source identities cannot be silently changed. To repair rejected work, add a replacement action, then use `supersede <dir> rejected-id replacement-id --actor ... --reason ... --ref ...`. This preserves history and redirects only eligible unstarted dependencies.

`events <dir> --after <sequence>` gives compact ordered journal events. Wakes are visible in status. The first version runs model management on demand; it does not automatically spawn permanent lane/ticket managers or resume an existing wave.

## Recovery

The journal persists submission intent before host launch. Action, slot and workspace claims are atomic across controller processes. Detached host supervisors outlive a controller crash. A restarted controller uses launch/terminal receipts and process identity to recover; ordinary completion needs no model call.

Unreachable hosts, missing receipts and vanished supervisors remain uncertain and retain their claims. Expiry or a missing PID does not authorize a retry. `resolve <dir> attempt-id --actor ... --reason ... --ref ...` is an explicit assertion that evidence establishes safe retry; it does not kill unknown remote work. Contradictory terminal evidence records a conflict and pauses scheduling.

Stopping the foreground scheduling service gracefully pauses new dispatch. Existing supervised jobs can finish and their receipts remain recoverable. Publication, project acceptance policy, workspace staging, external issue updates, and containment of deliberately detached descendants belong to explicit project adapters. This command does not perform them implicitly.
