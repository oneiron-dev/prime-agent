# Factory mode

Factory mode coordinates work outside the conversation runtime. It is optional, runs in a separate process, and requires Node 22.13+ with `node:sqlite`; ordinary Prime startup is unaffected. Execution records and adapter contracts are independent of Prime sessions so the factory can later move into Oneiron.

The factory stores a versioned plan and SQLite journal on the controller. Local or SSH host runners own foreground processes and durable receipts. Models provide decisions through a separate command; their latency does not block capacity refill.

## Start a factory

Create a JSON plan with `version: 1`, `tickets`, `slots`, `actions`, and optional `roles`. Each action declares its ticket, dependencies, source fingerprint, command argv/cwd, host requirements, and `kind`:

- `process`: a successful foreground process can satisfy this gate.
- `decision`: successful execution still requires an explicit evidence-bearing acceptance decision. Give it a description and acceptance criteria.

An optional `command.env` string map adds explicit child environment values. Keys must be POSIX variable names and values cannot contain NUL. The map is immutable once the action starts and is part of durable host manifest identity. The host merges it over inherited values, then sets `PRIME_FACTORY_ATTEMPT_ID` and `PRIME_FACTORY_SOURCE_FINGERPRINT` from the manifest. Callers cannot override those custody fields. Put non-secret execution settings here; environment values are stored in plan and receipt files. Project adapters supply owned-runtime policy; the portable runner does not choose it.

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

The first form saves a proposal. The second applies the cached valid accept/reject decision without another model request when the context is unchanged; a defer leaves the wake unresolved. Each request includes one action, current attempt, dependency states and bounded explicitly supplied evidence. A decision is bound to its observed plan revision and attempt. Missing criteria, missing substantive evidence or uncertain process custody cannot be converted into automatic semantic acceptance.

Evidence uses separate citation and model-input budgets:

- Supply at most 32 evidence records. Each ref must be unique, nonempty, free of control characters and at most 4000 UTF-8 bytes.
- The sum of all inline `content` strings is at most 64 KiB (65536 UTF-8 bytes). There is no per-document character cap. Each content string must contain substantive, nonempty text.
- The complete serialized decision packet is at most 96 KiB (98304 UTF-8 bytes), including evidence refs, JSON escaping and all action, attempt, ticket, dependency and wake metadata.
- Proposal `evidenceRefs` contains at most 32 unique, nonempty, bounded refs. Every ref must identify supplied evidence or the supplied journal receipt. Accept/reject requires at least one citation; semantic acceptance still requires explicit criteria and substantive supplied evidence beyond a process receipt. Defer can use an empty list.
- Proposal response text is at most 256 KiB (262144 UTF-8 bytes), checked before JSON parsing.

Each manual `--evidence` option names one raw UTF-8 document, not a JSON array of evidence records. Repeat the option to supply more documents; their absolute paths become refs. Each file is at most 65536 bytes, and the shared record/ref and aggregate content checks run before factory lookup.

Increasing the record count does not increase the byte budgets. The factory checks content and packet limits before inference and does not silently truncate evidence. Limit errors name the field and show the actual count or UTF-8 byte size and its limit.

Management uses the existing Prime model registry and auth configuration without starting a session or daemon. Requests, proposals, evidence pointers and usage are saved privately under the factory's `decisions/` directory. A receipt marked `modelIdentitySource: sdk` records the SDK selector in `responseModel`; that historical field is not serving identity. New receipts also contain `servingIdentity`, with the transport-reported response model, response ID and source `provider-response`, or explicit `unknown` when absent. These fields are captured automatically from the provider transport, not supplied by the model or an external identity attestation. They report gateway response metadata, not cryptographic upstream identity. Historical receipts are not relabeled. Generic management records unexpected serving labels honestly; unlike a stricter project writer policy, it does not add a serving-family allowlist gate. Dollar values in SDK usage are list-price estimates, not subscription cash charges.

Manual decisions use `decide <dir> <action> accept|reject --actor ... --reason ... --ref ...`. `import <dir> plan.json --expected-revision N` adds/upserts future work; omitted records persist. Started inputs and source identities cannot be silently changed. To repair rejected work, add a replacement action, then use `supersede <dir> rejected-id replacement-id --expected-revision N --actor ... --reason ... --ref ...`. This preserves history and redirects only eligible unstarted dependencies.

`events <dir> --after <sequence>` gives compact ordered journal events. Wakes, `managementRequests` and `managementMutationBlockers` are visible in status. Core status describes core command attempts and judgment requests only. Zero core attempts does **not** prove that no coordinator is running. For Oneiron, use the continuation's composite status command as the canonical operator view. Separate working requests, exact-evidence/deadline waits, judgment recovery and executable backlog; do not combine them as “inactive.” Management does not spawn permanent lane/ticket managers or resume an existing wave.

### Serializing plan changes

Imports and supersession check the global revision inside the same SQLite transaction as mutation. A real change waits while any management request is `CLAIMED`, or the latest request for an unresolved wake is `PROPOSED`. Apply a valid proposal first, or explicitly reconcile its authority as described below. Claims do not expire. This barrier does not stop ticks, existing valid action execution, other judgments or cached proposal application.

A no-op import keeps the revision. A successful real change records `previousRevision`, `revision` and `invalidatedWakeIds` in its event. The continuation must regenerate **every** affected pending binding at the new revision from preserved, verified receipts, not repeat source execution or blindly re-infer. Stale bindings cannot be applied.

Coordinators can use an exact-once token:

```sh
prime-agent factory import /absolute/factory next-plan.json \
  --expected-revision 3 --mutation-id durable-outbox-request-id
```

The token and hash of the exact serialized plan plus expected revision commit with the plan. A crash after commit but before outbox acknowledgement can replay that exact token/payload and receive its recorded revision without another import. A changed payload or expected revision under the same token fails. `FactoryStore.planMutation(id)` is a read-only receipt lookup, including while paused; the engine still blocks mutation commands while paused. Use a new token for a genuinely new plan decision. A coordinator model must not hold a core judgment claim while trying to import its own plan.

### Bounded automatic judgment dispatch

`manage --watch` opts into a finite automatic consumer of judgment wakes. It reuses the one-wake management operation in a separate foreground process. It never runs inside `serve`, schedules command actions, or delays slot refill.

```sh
# Preparation only: this is not permission to resume an owner-paused factory.
prime-agent factory manage /absolute/factory --watch --apply \
  --max-requests 10 --max-passes 60 --interval-ms 1000 \
  --evidence-directory /absolute/factory/management-evidence
```

Without `--apply`, automatic management saves proposals only. The default limits are 10 admissions and 60 passes, with 1000 ms between passes. Every admitted request counts, including provider failures, validation errors and defer. Limits are 1–100 requests, 1–10000 passes, and 50–60000 ms between passes. One request is in flight per consumer. The Prime model adapter has no retries and a 125-second abort bound. The pass limit also ends an empty or paused watch. Start another bounded consumer explicitly when needed; restarting it does not clear consumed contexts.

Automatic mode requires a file named `<wake-id>.json` in the evidence directory (default: `<factory>/management-evidence`). Each file contains this exact binding shape:

```json
{
  "version": 1,
  "wakeId": 7,
  "actionId": "review-exact-head",
  "attemptId": "terminal-attempt-id",
  "planRevision": 3,
  "evidence": [
    {"ref": "/absolute/review.json", "content": "Substantive exact-output review evidence", "sha256": "SHA256_OF_UTF8_CONTENT"}
  ]
}
```

Use the lowercase SHA-256 hex digest of each exact UTF-8 content string, not the example placeholder. The serialized binding file is at most 256 KiB (262144 bytes), including hashes, metadata and whitespace. Supply one to 32 distinct, nonempty evidence records within the same 64 KiB aggregate content and 96 KiB packet budgets described above. `factory:attempt:` refs are reserved for journal receipts and cannot be supplied as substantive evidence. The model receives the validated inline snapshot; it does not fetch the ref. The request receipt records the refs and verified hashes. The exact binding scope and content hashes remain authoritative and are checked again before inference and application.

Missing bindings, bindings for another wake/action/attempt/revision, empty factories, local pause and external owner pause cause no automatic model call. Invalid hashes or malformed bindings fail closed. Automatic mode skips uncertain custody and failed process gates; those require explicit reconciliation or planning, not acceptance or retry by a model. A project adapter or operator must generate a binding after the exact terminal wake exists. This core consumer does not discover reviews or construct project evidence. The Oneiron binder is a separate deterministic preparation step; it is not an automatic end-to-end workflow.

The journal atomically consumes `(wake, plan revision, attempt, evidence refs/content hashes)` before inference. All manual and automatic consumers share this guard. Role changes and switching `--apply` do not bypass it. An additional per-wake guard prevents simultaneous requests with different evidence. Finished defer/error contexts stay consumed across restart. Changed evidence for the current attempt can admit a new request only when no prior request remains in flight. A global revision change alone cannot replay the same wake/attempt/evidence, including a prior defer or error.

A crashed or disconnected request remains `CLAIMED`. It never expires, and even changed evidence cannot automatically replay that wake. Inspect its journal and private request/response/proposal receipts. A dead local process does not prove the provider did not execute. There is no automatic reset or replay. The explicit `reconcile-management` command below can release reconciled judgment authority while retaining the original claim, result, dedupe key and evidence. Do not delete a claim to make the loop continue.

Pause, plan revision, latest attempt and unresolved wake are checked again immediately before inference and application. The Prime adapter repeats the check after asynchronous authentication. Cached proposals use the same guards and can only apply while they remain the latest management evidence context for that wake. Application and the request's `APPLIED` state are recorded in the same transaction. SIGINT/SIGTERM stop further inference and application; an already admitted request may finish within its timeout and remains consumed. Stopping management does not remove an owner pause or stop the separate scheduling process.

These commands describe source functionality. They do not mean a new release has been built, installed or selected, or that a live Wave has been imported or resumed.

## Explicit judgment recovery

`factory resolve` concerns command-process custody only. It does not recover a management request. Recovery must not remove an owner fence, kill an unknown actor, or assume that a missing PID or timeout proves the provider did not execute.

1. Inspect the exact request ID, wake, attempt, original plan revision and all preserved request/response/proposal files.
2. Reconcile the prior manager through its supervisor or authoritative actor record. Establish that its exact identity stopped and cannot resume factory authority. Inspect the provider request outcome separately. `UNKNOWN` is blocked.
3. Save the authoritative actor and provider evidence as immutable local JSON receipts, then record their exact byte hashes. Preserve output files and hash them too. An operator or authorized coordinator attests the provenance of these receipts. The factory verifies scope, shape and bytes; this is **not** cryptographic proof of remote-process termination or provider truth.
4. Run `reconcile-management` with the current revision and the original request-bound bundle. It changes only `CLAIMED`/`PROPOSED` to `RECONCILED`. It does not accept product output, release a command attempt, remove a wake, change the plan, delete files or call a model. Late responses from the reconciled actor cannot apply.
5. If preserved substantive output suffices, apply an explicit guarded decision without inference. Otherwise the continuation must prepare changed substantive evidence, including reconciled request evidence when relevant, regenerate bindings and admit a new judgment context. A plan change alone does not authorize replay of unchanged evidence. The original context remains consumed, even after reconciliation.

The bundle has this shape (replace the example IDs and hashes with observed evidence):

```json
{
  "version": 1,
  "requestId": "management-request-id",
  "wakeId": 7,
  "attemptId": "terminal-attempt-id",
  "planRevision": 3,
  "priorActor": {
    "identity": "exact-supervisor-identity",
    "stopped": true,
    "authorityRevoked": true,
    "ref": "/absolute/actor-receipt.json",
    "sha256": "SHA256_OF_ACTOR_RECEIPT_BYTES"
  },
  "providerRequest": {
    "disposition": "completed",
    "ref": "/absolute/provider-receipt.json",
    "sha256": "SHA256_OF_PROVIDER_RECEIPT_BYTES"
  },
  "artifacts": [
    {"ref": "/absolute/factory/decisions/management-request-id/response.json", "sha256": "SHA256_OF_PRESERVED_OUTPUT_BYTES"}
  ]
}
```

Actor receipt JSON requires `{version:1,requestId,actorIdentity,stopped:true,authorityRevoked:true}`. Provider receipt JSON requires `{version:1,requestId,disposition}`, where disposition is `completed`, `cancelled`, or `not-submitted`. Both receipts must match the bundle. Bundle scope must match the original journal request. Referenced files must be absolute regular files, each at most 1000000 bytes, with valid SHA-256 hashes. Preserve one to eight distinct request/output artifacts. An empty artifact list is allowed only when authoritative evidence proves `not-submitted`, including a crash before request files existed. Do not fabricate output for that case.

```sh
prime-agent factory reconcile-management /absolute/factory management-request-id \
  --expected-revision 3 --actor authorized-coordinator \
  --reason "Reconciled exact actor authority, provider request and preserved output" \
  --ref /absolute/reconciliation.json

# Only if independently verified substantive output already satisfies the action:
prime-agent factory decide /absolute/factory action-id accept \
  --expected-revision 3 --expected-attempt terminal-attempt-id --expected-wake 7 \
  --actor authorized-coordinator --reason "Reviewed exact preserved output" \
  --ref /absolute/acceptance-evidence.json
```

These are evidence-bearing operations, not authorizations to alter a paused production factory. Both local and external pause continue to block them. Preserve every prior receipt and reconciliation event.

## Recovery

The journal persists submission intent before host launch. Action, slot and workspace claims are atomic across controller processes. Detached host supervisors outlive a controller crash. A restarted controller uses launch/terminal receipts and process identity to recover; ordinary completion needs no model call.

Unreachable hosts, missing receipts and vanished supervisors remain uncertain and retain their claims. Expiry or a missing PID does not authorize a retry. `resolve <dir> attempt-id --actor ... --reason ... --ref ...` is an explicit assertion that evidence establishes safe retry; it does not kill unknown remote work. Contradictory terminal evidence records a conflict and pauses scheduling.

Stopping the foreground scheduling service gracefully pauses new dispatch. Existing supervised jobs can finish and their receipts remain recoverable. Publication, project acceptance policy, workspace staging, external issue updates, and containment of deliberately detached descendants belong to explicit project adapters. This command does not perform them implicitly.
