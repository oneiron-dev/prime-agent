export const FACTORY_HELP = `Usage:
  prime factory init <directory> <plan.json> --hosts <hosts.json> [--pause-file <absolute-path>]
  prime factory import <directory> <plan.json> --expected-revision <revision> [--mutation-id <id>]
  prime factory status <directory>
  prime factory events <directory> [--after <sequence>]
  prime factory fingerprint <host> <absolute-cwd> --hosts <hosts.json> [--timeout-ms <milliseconds>]
  prime factory tick <directory>
  prime factory run <directory> [--interval-ms <milliseconds>]
  prime factory serve <directory> [--interval-ms <milliseconds>]
  prime factory pause <directory> [reason]
  prime factory resume <directory>
  prime factory supersede <directory> <rejected-action> <replacement-action> --expected-revision <revision> --actor <actor> --reason <reason> --ref <evidence>
  prime factory resolve <directory> <attempt-id> --actor <actor> --reason <reason> --ref <evidence>

Factory mode is optional and runs separately from Prime sessions. State and results are JSON.
The factory is a DAG launcher: an action is one foreground command; exit 0 accepts it and readies its dependents, any other exit rejects it.
New factories start paused. Resume prints the ledger catch-up, recomputes the frontier, unpauses and runs one scheduling tick.
Resume exits 1 for an owner pause or idle_with_backlog (READY work with nothing RUNNING after the tick); the latter opens a wake.
A changed installed runtime is journaled at resume and never refused. Resume never removes an external owner pause file.
run/serve stay in the foreground; SIGINT/SIGTERM persist a scheduling pause while detached attempts retain receipts; resume explicitly.
Each configured host needs Python 3 on a POSIX system. Factory storage needs Node 22.13+ with node:sqlite.
Hosts JSON: {"local":{"type":"local","runnerRoot":"/absolute/attempts"}}
SSH host: {"type":"ssh","sshHost":"arch","runnerRoot":"/absolute/attempts","python":"python3"}
Only foreground commands are supported; daemonized/detached descendants require another adapter.
Plans use argv arrays and absolute cwd paths. Use fingerprint for verified Git source identity.
fingerprint --timeout-ms accepts integers 1..120000 (default 20000 ms); launch and inspect deadlines are unchanged.
resolve intentionally retries and requires evidence that any previous process tree is gone; it does not kill or inspect it for you.
supersede explicitly replaces rejected work; it preserves history and does not accept the replacement or dependencies.
Plan imports keep started actions and source identities immutable; no-op imports keep the revision.
Opaque source fingerprints are labels only; use an explicit validating wrapper for other source formats.`;
