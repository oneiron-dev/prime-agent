export const FACTORY_HELP = `Usage:
  prime factory init <directory> <plan.json> --hosts <hosts.json> [--pause-file <absolute-path>]
  prime factory import <directory> <plan.json> --expected-revision <revision> [--mutation-id <id>]
  prime factory status <directory>
  prime factory events <directory> [--after <sequence>]
  prime factory fingerprint <host> <absolute-cwd> --hosts <hosts.json>
  prime factory tick <directory>
  prime factory run <directory> [--interval-ms <milliseconds>]
  prime factory serve <directory> [--interval-ms <milliseconds>]
  prime factory pause <directory> [reason]
  prime factory resume <directory>
  prime factory manage <directory> [action-id] [--role ticketOwner] [--evidence <file>] [--apply]
  prime factory manage <directory> --watch [--apply] [--evidence-directory <directory>] [--max-requests <count>] [--max-passes <count>] [--interval-ms <milliseconds>]
  prime factory supersede <directory> <rejected-action> <replacement-action> --expected-revision <revision> --actor <actor> --reason <reason> --ref <evidence>
  prime factory reconcile-management <directory> <request-id> --expected-revision <revision> --actor <actor> --reason <reason> --ref <absolute-reconciliation.json>
  prime factory resolve <directory> <attempt-id> --actor <actor> --reason <reason> --ref <evidence>
  prime factory decide <directory> <action-id> <accept|reject> --actor <actor> --reason <reason> --ref <evidence> [--expected-revision <revision>] [--expected-attempt <id>] [--expected-wake <id>]

Factory mode is optional and runs separately from Prime sessions. State and results are JSON.
New factories start paused. Resume is explicit and never removes an external owner pause file.
run/serve stay in the foreground; SIGINT/SIGTERM persist a scheduling pause while detached attempts retain receipts; resume explicitly.
Each configured host needs Python 3 on a POSIX system. Factory storage needs Node 22.13+ with node:sqlite.
Hosts JSON: {"local":{"type":"local","runnerRoot":"/absolute/attempts"}}
SSH host: {"type":"ssh","sshHost":"arch","runnerRoot":"/absolute/attempts","python":"python3"}
Only foreground commands are supported; daemonized/detached descendants require another adapter.
Plans use argv arrays and absolute cwd paths. Use fingerprint for verified Git source identity.
resolve requires evidence that any previous process tree is gone; it does not kill or inspect it for you.
manage returns a proposal unless --apply is explicit; --watch opts into bounded automatic wake handling, separate from serve.
Automatic handling needs exact per-wake evidence bindings. Requests are durably consumed, including defer/errors; crashes never authorize replay.
Plan mutations wait for active/unconsumed judgments; no-op imports keep the revision. Rebind pending wakes after real mutations.
reconcile-management requires hash-verified actor/provider/output receipts; UNKNOWN, missing PID and timeout never authorize replay.
Opaque source fingerprints are labels only; use an explicit validating wrapper for other source formats.`;

export const FACTORY_MANAGE_HELP = `Usage:
  prime-agent factory manage <directory> [action-id] [--role ticketOwner] [--evidence <file>] [--apply]
  prime-agent factory manage <directory> --watch [--role ticketOwner] [--apply] [--evidence-directory <directory>] [--max-requests <count>] [--max-passes <count>] [--interval-ms <milliseconds>]

Reviews one wake by default; --watch consumes bound judgment wakes in a separate foreground process, never inside serve.
Proposes unless --apply is explicit. A cached proposal can be applied without another model call. Defer/error preserves the wake and consumes that context.
Automatic evidence: <directory>/management-evidence/<wake-id>.json, or --evidence-directory. See factory.md for the exact hash-validated envelope.
Watch defaults: 10 request admissions, 60 passes, 1000 ms between passes. Limits: 1..100 requests, 1..10000 passes, 50..60000 ms.
Missing/stale evidence, empty/paused factories and uncertain custody cause no automatic model request. Signals stop new inference and application; in-flight requests remain bounded.
Interrupted claims never expire or automatically replay, even with changed evidence. Inspect managementRequests in factory status and the decisions/ receipts.`;
