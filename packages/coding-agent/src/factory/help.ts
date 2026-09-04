export const FACTORY_HELP = `Usage:
  prime factory init <directory> <plan.json> --hosts <hosts.json> [--pause-file <absolute-path>]
  prime factory import <directory> <plan.json>
  prime factory status <directory>
  prime factory events <directory> [--after <sequence>]
  prime factory fingerprint <host> <absolute-cwd> --hosts <hosts.json>
  prime factory tick <directory>
  prime factory run <directory> [--interval-ms <milliseconds>]
  prime factory serve <directory> [--interval-ms <milliseconds>]
  prime factory pause <directory> [reason]
  prime factory resume <directory>
  prime factory manage <directory> [action-id] [--role ticketOwner] [--apply]
  prime factory supersede <directory> <rejected-action> <replacement-action> --actor <actor> --reason <reason> --ref <evidence>
  prime factory resolve <directory> <attempt-id> --actor <actor> --reason <reason> --ref <evidence>
  prime factory decide <directory> <action-id> <accept|reject> --actor <actor> --reason <reason> --ref <evidence>

Factory mode is optional and runs separately from Prime sessions. State and results are JSON.
New factories start paused. Resume is explicit and never removes an external owner pause file.
run/serve stay in the foreground; SIGINT/SIGTERM persist a scheduling pause while detached attempts retain receipts; resume explicitly.
Each configured host needs Python 3 on a POSIX system. Factory storage needs Node 22.13+ with node:sqlite.
Hosts JSON: {"local":{"type":"local","runnerRoot":"/absolute/attempts"}}
SSH host: {"type":"ssh","sshHost":"arch","runnerRoot":"/absolute/attempts","python":"python3"}
Only foreground commands are supported; daemonized/detached descendants require another adapter.
Plans use argv arrays and absolute cwd paths. Use fingerprint for verified Git source identity.
resolve requires evidence that any previous process tree is gone; it does not kill or inspect it for you.
manage returns a proposal unless --apply is explicit; it runs separately from the scheduling loop.
Opaque source fingerprints are labels only; use an explicit validating wrapper for other source formats.`;
