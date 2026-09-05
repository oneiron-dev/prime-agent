# Oneiron durable coordinator continuation

This opt-in consumer connects the existing Oneiron coordinator to the existing factory. It does not replace `factory serve`, schedule product processes, author product source, or merge PRs. The owner-ratified normal policy uses `cpa-r/gpt-6-astra` through Arch CPA Codex OAuth only. Routine CEO/coordinator work uses `medium`; named broader replanning or difficult cross-ticket conflict uses `high`; unresolved architecture or correctness uses `xhigh`. Writer work remains `xhigh`. Initial triage and bounded ticket judgments remain `low`. This is the normal policy, not a trial. Fable is reserved for explicitly requested architecture or post-wave work, not routine writer manifests. No promotional or paid fallback is configured. This consumer adds no model quota scheduler or paid-balance bypass. A whole-attempt Astra retry after a failed primary Astra attempt still requires full reconciliation.

## Execution and custody

`OneironContinuation` uses narrow `oneiron_continuation_*` tables in the **same `factory.db`**. Its cursor names one ticket and one current stage. Its outbox records a coordinator request and the complete command context before dispatch. The existing `CommandAdapter` owns that foreground coordinator command, timeout, process-group supervision, and host launch/terminal receipts. Each request has a distinct controller workspace and session directory outside product source.

A coordinator command uses the shared, hash-verified `FactoryRuntimeIdentity.cliArgv`, then:

```text
--print --mode json --offline --provider cpa-r --model gpt-6-astra
--thinking SELECTED_COORDINATOR_EFFORT --cwd REQUEST_WORKSPACE --session-dir REQUEST_SESSION
--no-extensions --no-skills --tools ipython
--append-system-prompt BOUNDED_COORDINATOR_CONTRACT -- BOUNDED_PACKET
```

The command also carries `env:factoryOwnedEnvironment()` through the existing command-runner manifest. That shared helper selects the native `PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND=1` route and clears the audited inherited owned/daemon/lease/orphan authority keys with child-only empty environment overrides. It preserves the parent environment and the runner’s reserved factory attempt identity. `--offline` alone does **not** disable shared-daemon routing. The owned frontend starts its IPC worker through the same pinned Node/CLI entry and retains worker custody. No second launcher, shell environment wrapper, daemon restart or service is introduced.

The coordinator uses the native `ipython` tool. File access uses Python APIs; foreground helpers use the REPL `bash` handle interface. There are no legacy `read`, `write`, or `bash` tool names in this runtime.

The factory streams the full native JSON log from HDD and extracts only completed native `message_end` assistant metadata: provider, SDK selector, `responseModel`, `responseModelSource`, `responseId`, and stop reason. Repeated `message_update` snapshots never enter the derived receipt. The raw log remains on HDD and is hash-bound; it is not loaded or rejected as a small inline evidence artifact. The shared writer/coordinator reader limits raw bytes to 256 MiB, a line to 8 MiB, events to 250,000, completed assistant records to 256, each metadata string to 1,024 bytes, and derived JSON to 256 KiB. Invalid UTF-8/JSON, partial lifecycle, file drift, missing or unapproved identity, and non-completion stay rejected. These bounds are explicit safety limits, not model self-report duties. It saves `model-provenance.json` with the factory-selected requested route and effort, decision class/reason/source, SDK selectors, reported serving identities, response IDs, and transcript hash. Requested effort comes from the admitted command metadata, never a model self-report; provider serving identity does not attest observed effort. Unknown/missing transport identity blocks successor application. The coordinator must never certify its own model. A gateway report is not authenticated upstream identity. `model-provenance.json` explicitly covers native transport metadata only. The separate `response-artifact.json` pins the actual consumed response and marks normal versus reconciled-artifact origin. It sets `modelAuthorshipAttested:false`. Root-produced factual extracts or response derivations never inherit model authorship from the original stdout; explicit reconciliation remains required.

Opening or supervising the consumer never resumes a factory or removes its external owner pause. The product scheduler remains separate and uses the same pinned release. The continuation runtime, stage `factoryRuntime`, writer profile runtime, adapter argv, supervisor entry, and helper files must refer to that same reviewed deployment. Pinning an entrypoint alone is insufficient; the shared runtime envelope verifies Node, CLI, lazy modules and release assets.

## Concrete transitions

For a successful terminal stage, the consumer calls the existing `bindOneironEvidence`. It validates the exact prepared manifest, terminal attempt, stage receipt, source and custody. It stores the binding in SQLite and makes an atomic immutable file projection. The projection is keyed by wake, revision and evidence digest. It then calls the existing bounded `manageFactoryWake` with `apply:true`. No owner must create the binding file.

The manager accepts or rejects the **stage**, not the product. An accepted or rejected stage produces one bounded actionable coordinator packet. The coordinator returns pinned instructions, not an arbitrary factory plan. The deterministic consumer calls `prepareOneiron` and imports its single next action through core serialized `applyPlan(plan, expectedRevision, requestId)`.

| Completed stage | Configured next work and owner |
| --- | --- |
| Triage | The coordinator preserves material/debt obligations and prepares an Astra repair, missing-evidence collection, or exact-source review-acceptance. Triage cannot produce closure. |
| Writer | The coordinator reconciles the whole writer process/output/evidence. It performs only authorized signed-commit metadata work, checks the clean signed candidate, refreshes custody/source/permit pins, and prepares the first affected gate. It must not author product bytes. |
| Gate | Another affected exact-source gate, or controlled `publish-update` of the existing PR. Rejected work needs a separate repair plan, not a green label. |
| `publish-update` | The coordinator makes one actual exact-head Qodo/Codex review request through its pinned authorized helper. Its request receipt is mandatory before `collect`. The existing publication adapter retains native remote-head/topology CAS. |
| Collect | Bounded triage carrying previous obligations, or a further collection. Pending/skipped/quota/empty review is not completed review. A deterministic evidence producer owns any wait. |
| Changed-head triage | Repair unresolved material, collect missing coverage, or prepare exact-source review-acceptance. No old-head review credit. |
| Review-acceptance | Only an accepted receipt with `acceptanceEligible:true` can hand final merge and Linear-close custody to the authorized coordinator. The handoff is explicitly `productDone:false`. The factory does neither operation. |
| `publish-ready` | Exact-source review-acceptance; readiness does not accept the product. |

A rejected non-writer stage can lead to a pinned repair/triage/collection/gate stage. A rejected writer uses a separately authorized whole-attempt Astra retry with its exact unsuccessful terminal receipt and full prior process/workspace/evidence reconciliation. It does not require a fabricated successful project receipt. The existing writer validator requires current-source material triage; preserved changed bytes cannot claim an old-source triage receipt. The tested retry path restores the exact original source before retry. If preservation needs fresh triage, retain custody and prepare that current-source evidence through the authorized project workflow; do not bypass the source guard. An unknown writer identity cannot be fixed by supplemental agent testimony.

## Configuration

The exact schema is `OneironContinuationConfig` in `src/factory/adapters/oneiron-continuation.ts`:

- `version:1`, stable `id`, `ticketId`, and the prepared `initialActionId`.
- Absolute `factoryDirectory` and exact existing `ownerPauseFile`.
- `coordinator.actor`: the actual transferred ticket owner, also used for terminal closure custody.
- `coordinator.runtime`: the shared runtime envelope pin. `coordinator.workspace` is an isolated controller **base** directory, not product source. `host` and `runnerRoot` must match an existing local controller host in `config.json`.
- `coordinator.authorization`: the existing owner authorization pin. Each successor permit must cite this exact pin. This grants only its written scope; it cannot clear pauses.
- `coordinator.instructions`: a pinned concrete helper/authority packet. It must identify the existing signed-commit/rebind workflow, actual bot request command and consume-once deadline owner, exact-source gate preparation, native publication preparation, core judgment recovery, and final merge/Linear-close actor. It must contain real reviewed paths and command arguments, not placeholder commands. It grants no product-source authorship to the coordinator.
- `coordinator.timeoutMs`: 1,000–1,800,000 ms. The existing host runner enforces it for the foreground group.
- Optional `coordinator.effortOverrides`: up to 1,000 unique exact-action entries `{actionId,decisionClass,reason}`. Reasons must contain 20–2,000 characters of substantive scope. `broader-replanning` and `cross-ticket-conflict` map to `high`; `unresolved-architecture` and `unresolved-correctness` map to `xhigh`. Omitted and unmatched actions always use routine `medium`. Raw effort overrides and ambiguous/duplicate scopes fail closed.
- `adapterArgv` and `adapterPins`: exact Oneiron entry invocation and its reviewed release files.
- `supervisor.actor`, concrete `.service` `unit`, `argv` containing the absolute Node/continuation-entry prefix, and absolute `configPath` naming this JSON file. The consumer appends a hash-pinned finite watch invocation. Do not include the config hash in the config itself.

### Effort for future actions

The coordinator does not need to rewrite a live config or restart its cursor to select a justified higher effort for newly prepared work. A verified stage successor response may include top-level `coordinatorDecision:{actionId,decisionClass,reason}` with the same bounded schema as a config override. Obtain the exact action ID from `prepareOneiron` for the pinned next manifest. The actuator rejects metadata for another action or for a non-stage instruction. Config and successor scopes must agree if both apply.

After successful CAS import, the next request reads the instruction from the existing APPLIED predecessor outbox record. The factory maps its class to effort and stores `packet.coordinatorDecision` with `requestedProfile`, `scopeActionId`, `decisionClass`, `reason`, `source` (`default`, `config-action`, or `successor-instruction`) and `sourceRequestId`. The exact stored profile drives CLI `--thinking`, status and the private provenance receipt. The coordinator never reports its own effort. This metadata cannot alter/replay an already admitted request. Without a matching explicit instruction, the next request stays medium; no inference-based automatic escalation is added.

A configuration is immutable once its cursor is registered. A different config does not silently take over its live request. Reconcile and explicitly transfer custody before changing the configured actor/runtime.

The authorized helper packet is operational configuration, not generated semantic code. After owner release, an operator may install and start the controller once. Routine bindings, stage acceptance, successor planning, rebind, gates, publication, changed-head review and repair do not require repeated owner prompts. During the current preparation phase, no controller is installed/started and no owner fence is changed.

## Commands and finite supervision

Use the compiled entry in the same pinned package, or its source equivalent in the existing project environment:

```sh
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts help
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts status CONFIG_JSON CONFIG_SHA256
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts unit CONFIG_JSON CONFIG_SHA256
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts step CONFIG_JSON CONFIG_SHA256 --execute
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts watch CONFIG_JSON CONFIG_SHA256 --execute --max-passes 60 --interval-ms 1000
```

The uppercase arguments describe required pins, not runnable production values. `status` is the canonical **composite** controller view: core actions, attempts, judgments and mutation blockers; continuation outbox/custody, runner terminal receipts, deterministic waits and supervision receipts; and verified runtime identity. Zero core attempts does not mean zero coordinator processes.

`unit` only prints a user-systemd unit. It does not install, enable or start it. The generated unit uses `Restart=on-failure`, `RestartSec=30`, `RestartPreventExitStatus=78`, and `KillMode=process` so the existing detached host runner can retain its own foreground process custody. Deployment must use this deliberate supervisor or an equivalent existing supervisor with the same exit-code protocol:

- A finite watch defaults to 60 passes at 1,000 ms. Limits are 1–10,000 passes and 50–60,000 ms.
- It saves a SQLite and file supervision receipt with a concrete next actor and exact hash-pinned command.
- Exit **75** means the supervisor rearms the next finite session. Empty, paused, working, or unchanged-wait sessions still obey the finite budget. Rearm does not grant execution through a pause.
- Exit **78** means configuration/admission failed. Do not hot-loop or silently change runtime/configuration.
- Exit **0** means a terminal closure-custody handoff, not a completed product. The named authorized coordinator owns the handoff instructions.
- SIGINT/SIGTERM block later model admission, judgment application and plan import. Admitted host runners keep their receipts; stop does not imply remote cancellation.

## Coordinator response contract

`OneironSuccessor` contains exact `requestId`, observed `planRevision`, bounded `reason`, one to 32 citation pins, and one of these `next` instructions:

- `stage`: a manifest pin, permit pin, configured `host` and `slotId`, plus the required rebind or review-request pin. The consumer regenerates the action through `prepareOneiron`; it does not execute a raw model-authored plan.
- `wait`: a named deterministic evidence-producing actor, an absolute file path, its `observedSha256` or `null` if absent, and pinned custody instructions. Unchanged bytes cause no new coordinator inference, including after systemd restart or unrelated global revision changes. New bytes produce one new bounded packet with `triggerEvidence`. A wait must already have a real producer or consume-once deadline/reminder; the consumer does not invent a collector or ask a model every 30 seconds.
- `resume-judgment`: pinned substantive supplemental evidence records within the shared 64 KiB UTF-8 content budget (including the canonical stage receipt) and 32-record binding budget, and optional `{requestId,reconciliation}` for the core `ManagementReconciliation` path. This never deletes claims. The next pass regenerates the verified stage binding with the new evidence before bounded management.
- `reject-failed-stage`: a pin of the exact journal terminal receipt. Only a proven terminal nonzero stage can use this explicit coordinator rejection. Unknown process custody cannot.
- `closure-handoff`: the exact accepted review-acceptance receipt, actual authorized actor and pinned final merge/Linear-close instructions.

After all foreground helper work finishes, write a separate candidate JSON. Invoke `packet.responseSubmitArgv` with `PACKET_SHA256 CANDIDATE_JSON CANDIDATE_SHA256` appended. This runs the shared native validator before atomic immutable publication to `responsePath`. Do not write the final path directly. The helper validates response shape, exact request/revision, all citation hashes, supplemental content and byte budgets. It never opens the factory DB, dispatches a model, applies a judgment, or imports a plan. Consume repeats these checks and remains authoritative for current custody, permits, semantic transitions and CAS.

```sh
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts validate PACKET_JSON PACKET_SHA256 CANDIDATE_JSON CANDIDATE_SHA256
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts submit PACKET_JSON PACKET_SHA256 CANDIDATE_JSON CANDIDATE_SHA256
```

`FACTORY_EVIDENCE_LIMITS` is the shared source of truth. A citation list allows 32 references, each with a path/ref at most 4,000 UTF-8 bytes. Citations hash opaque retained artifacts without loading them as inline model evidence. Supplemental text and the canonical stage receipt together have a 65,536-byte UTF-8 content budget. Their combined binding allows 32 records. One document may exceed the old 16,000-character limit when the aggregate fits. Whole model packets/prompts are bounded at 98,304 UTF-8 bytes. Serialized bindings and coordinator response JSON are each bounded at 262,144 UTF-8 bytes. Reasons are at most 4,000 UTF-8 bytes. Errors name the exact field and actual/limit. The factory never truncates text or deletes obligations to fit a budget; create an explicit factual derivation that retains its original pin when required. The factory requires a successful exact host terminal receipt and factory-captured transport model events before consuming the response. A response file alone is not proof of a finished coordinator process.

### Signed rebind receipt

A writer-to-gate instruction requires a pinned JSON receipt with:

```text
version:1
writerReceipt:{path,sha256}
outputFingerprint:<exact writer output fingerprint>
sourceFingerprint:<new signed clean source fingerprint>
signedCommitVerified:true
clean:true
processReconciled:true
retainedEvidence:[pins]
authorization:<the configured authorization pin>
```

The consumer verifies every pin, then uses native source fingerprinting, `git status --porcelain` and `git verify-commit` on the rebound candidate. Publication independently repeats its stronger signed-range, author/committer, branch and remote checks. The reconciliation record is an authorized project custody assertion, not a signature service or proof that the model authored correct code. Gate/review evidence remains required.

### Changed-head review request receipt

`publish-update` to `collect` requires `{version:1,head,repo,pr,reviewers:["qodo","codex"],refs:[actualRequestRefs]}` pinned to the published candidate. This records an actual authorized request; it is not completion. The collector and review parser still require substantive completed exact-head Qodo **and** Codex coverage. Preserve historical RED checks, unresolved finding ledgers and the missing docs Codex gap.

## Crash and revision rules

- Binding bytes live in SQLite before projection. A partial process does not expose a partial binding; unchanged projections are immutable and recreated safely.
- A coordinator outbox state of `DISPATCHED` is a once-only claim. Normal restart calls only `CommandAdapter.inspect`, never `launch` again. Missing PID, transport timeout, missing receipt or disappeared controller is not replay permission.
- A revoked outbox request cannot admit a late response. The consumer rechecks request authority after host inspection, CAS-admits the response, and checks it again before actuator effects.
- Failed-stage rejection has a private actuator marker. Recovery acknowledges only the matching committed journal decision with the exact request marker, attempt, actor, reason and evidence ref. A generic manual `REJECTED` state is not enough.
- A valid finished response survives controller death. Core imports use the request ID as the atomic mutation token. A crash after import but before cursor acknowledgement reads `planMutation(requestId)` and advances the cursor without another import, model call or process.
- Active or latest unconsumed judgments globally block plan mutation. A retained response waits for the authorized coordinator's core application/reconciliation. No second semantic plan is inferred just to evade that lock.
- A revision change before import marks the **known completed response** stale and produces a refresh-only packet. The coordinator must revalidate/repin it; it must not repeat a commit, source edit, review request or publication. The actuator uses the new core CAS. Every relevant terminal wake is rebound at its new revision before management. An unchanged deferred/error evidence context is still consumed across revisions.
- Missing/invalid bindings, failed terminals, deferred judgments and claimed management requests produce one bounded diagnostic coordinator packet per exact condition. They do not silently idle or ask the owner. A genuine unknown custody result remains a named reconciliation obligation; no model can reinterpret it as safe retry.

### Explicit coordinator outbox recovery

The separate coordinator outbox is not a `ManagementClaim`. Core `factory resolve` and `reconcile-management` do not reset it. Use the proof-backed continuation command only after real process/provider/workspace reconciliation:

```sh
node --import tsx src/factory/adapters/oneiron-continuation-entry.ts reconcile CONFIG_JSON CONFIG_SHA256 REQUEST_ID PROOF_JSON PROOF_SHA256 --execute
```

`OneironCoordinatorReconciliation` requires the exact request and configured authorization; pinned prior-actor `{requestId,identity,stopped:true,authorityRevoked:true}` evidence; pinned provider `{requestId,disposition}` evidence; pinned workspace `{requestId,path,fullWorkspaceReconciled:true,noEffects}` evidence; and retained artifact pins. `disposition:"not-submitted"` permits a distinct new request only with `noEffects:true`. `disposition:"completed"` requires pinned exact host terminal, successor response and factory-captured stdout model metadata. The latter can restore consumption without dispatching any command. Unknown provider disposition is intentionally not a valid reset.

## Validation limits

Focused tests use real SQLite journals, the existing binder/management CAS and real Oneiron stage functions with mocked models, Git signing and network publication. Separate fixture coverage exercises the existing command runner with a fake native CLI. These tests do not establish live OAuth Astra serving availability or quota/reset behavior, real bot request/completion, production signing, remote publication, systemd installation, Linear closure or owner custody transfer.

No fully autonomous live workflow is claimed. Production remains empty/paused until the existing explicit owner release and custody procedure. Final merge and Linear close belong to the named authorized coordinator, not an invented automatic merge action.
