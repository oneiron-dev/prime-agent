export const FACTORY_HELP = `Usage:
  prime factory init <directory> <plan.json> --hosts <hosts.json> [--pause-file <absolute-path>]
  prime factory launch <directory> <w7-manifest.json> <mint-plan.json> --launcher <launcher.json>
  prime factory import <directory> <plan.json> --expected-revision <revision> [--mutation-id <id>]
  prime factory recover-admit <directory> <selected-plan.json> --select <action-id> [--supersede <rejected-action-id>] --expected-revision <revision> --mutation-id <id> --actor <actor> --reason <reason> --ref <evidence>
  prime factory status <directory>
  prime factory events <directory> [--after <sequence>]
  prime factory fingerprint <host> <absolute-cwd> --hosts <hosts.json> [--timeout-ms <milliseconds>]
  prime factory tick <directory>
  prime factory run <directory> [--interval-ms <milliseconds>]
  prime factory serve <directory> [--interval-ms <milliseconds>]
  prime factory pause <directory> [reason]
  prime factory resume <directory>
  prime factory supersede <directory> <rejected-action> <replacement-action> --expected-revision <revision> --actor <actor> --reason <reason> --ref <evidence>
  prime factory resolve <directory> <attempt-id...> --actor <actor> --reason <reason> --ref <evidence>

Factory mode is optional and runs separately from Prime sessions. State and results are JSON.
The factory is a DAG launcher: an action is one foreground command; exit 0 accepts it and readies its dependents, any other exit rejects it.
launch reads the ticket DAG (tickets with blocked_by) and the contracts, and imports two actions per ticket: submit and merge.
A blocker that is neither in the launch nor already known to the factory fails the whole launch, naming the ticket and the id.
submit cuts a worktree, has Muse write the context pack, runs the writer until the last line of its reply is exactly DONE <key> (or BLOCKED <key>: <why>), tests the touched crates, reviews by tier, publishes and closes the bot round.
merge waits for the blockers, syncs the native stack, or prepares the lone PR outside the merge mutex and squash-merges its exact head once its required checks pass. A writer's SPLIT: leftover becomes one follow-up ticket while serve runs.
launcher.json: {"host":"arch","repo":"/abs/oneiron","docs":"/abs/oneiron-docs","work":"/abs/w7-build","buildSlots":4,"diskFloorGiB":100,"idleMs":1800000,"buildHosts":[{"sshHost":"user@host","root":"/abs/build","slots":2,"jobs":4}],"seats":{...},"noStacks":false,"skipFactoryTests":false,"skipBots":false,"preMergeReview":false}
noStacks: every ticket branches from the trunk and its submit waits for every blocker's merge; no gh stack call runs.
skipFactoryTests (needs noStacks): no factory cargo tests; the merge waits for the PR's required checks. skipBots: no CodeRabbit, bot wait or bot round.
preMergeReview: one more review of the exact head on the review seat (grok) right before the merge; only VERDICT: LANDABLE merges.
launch on known tickets rewrites every ticket.json and re-imports the actions that have not started; started ones keep their spec.
No clock ever ends a working seat: idleMs kills a seat or cargo run only after its stream has been silent that long, and writer rounds are unbounded.
buildHosts, in order, run every cargo call made inside <work>/wt/<key>, the runner's own and the writers': the first host with a free slot wins, each call is capped at the host's jobs, a call waits while every reachable host is full, and with none reachable cargo runs here. sshHost "local" runs cargo here into <root>/target/<key>.
New factories start paused. Resume prints the ledger catch-up, recomputes the frontier, unpauses and runs one scheduling tick.
Resume exits 1 for an owner pause or idle_with_backlog (READY work with nothing RUNNING after the tick); the latter opens a wake.
A changed installed runtime is journaled at resume and never refused. Resume never removes an external owner pause file.
run/serve stay in the foreground; SIGINT/SIGTERM persist a scheduling pause while detached attempts retain receipts; resume explicitly.
Each configured host needs Python 3 on a POSIX system. Factory storage needs Node 22.13+ with node:sqlite.
Hosts JSON: {"local":{"type":"local","runnerRoot":"/absolute/attempts"}}
SSH host: {"type":"ssh","sshHost":"arch","runnerRoot":"/absolute/attempts","python":"python3"}
recover-admit admits exactly one owner-selected action while the durable factory stays paused, refusing any live, uncertain or unreleased claim.
Its plan may hold only the selected replacement action and its exact slot; existing ticket ownership, roles, actions and slots cannot change.
Without --supersede the action must already be READY and unchanged; an empty version-1 plan is enough.
With --supersede the old action must be REJECTED; the replacement keeps its ticket and dependencies, and only unstarted dependents are rewired.
A durable SUBMITTED claim and the mutation receipt commit before the launch; a replay never launches the same attempt again, and an ambiguous launch stays UNCERTAIN for reconciliation.
External owner pause files are never overridden. tick, serve and resume are unchanged.
Only foreground commands are supported; daemonized/detached descendants require another adapter.
Plans use argv arrays and absolute cwd paths. Use fingerprint for verified Git source identity.
fingerprint --timeout-ms accepts integers 1..120000 (default 20000 ms); launch and inspect deadlines are unchanged.
resolve intentionally retries and requires evidence that any previous process tree is gone; it does not kill or inspect it for you.
resolve accepts several attempt ids so one mass restart carries one piece of evidence.
supersede explicitly replaces rejected work; it preserves history and does not accept the replacement or dependencies.
Plan imports keep started actions and source identities immutable; no-op imports keep the revision.
Opaque source fingerprints are labels only; use an explicit validating wrapper for other source formats.`;
