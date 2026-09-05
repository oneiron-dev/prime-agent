# Oneiron writer policy and automatic model provenance

The latest owner OAuth-only policy restores `cpa-r/gpt-6-astra` at `xhigh` for routine writing and coordination. It supersedes the briefly ratified, undeployed Fable-default preparation. Fable is reserved for explicitly requested architecture/post-wave work, not routine writer stages. This policy does not resume Wave work or change historical receipts. Initial ONE-1914 triage remains Astra at `low`, with `max` available for escalation.

## Explicit pinned profile

Every new writer stage requires `writerProfile: {path, sha256}`. Missing profiles do not silently select a model. `defaultOneironWriterProfile(runtimePin)` returns:

```json
{
  "version": 1,
  "mode": "primary",
  "requested": {
    "provider": "cpa-r",
    "model": "gpt-6-astra",
    "effort": "xhigh"
  },
  "approvedResponseModels": ["gpt-6-astra"],
  "runtime": {"path": "/absolute/reviewed-runtime.json", "sha256": "EXACT_SHA256"}
}
```

Routine writer profiles accept only the direct `cpa-r/gpt-6-astra` route and only gateway-reported `gpt-6-astra`. The old `cpa-a/claude-fable-5-1-exp` preparation profile is rejected for new routine writer work. The factory does not delete or restore any owner-managed registry alias.

CPA's latest owner-managed policy routes Astra through Arch Codex OAuth only. Experiential was removed and no paid fallback was added. The factory does not introduce promotional-capacity assumptions, paid fallback, credential changes, gateway restart, or a second model-quota scheduler. Gateway availability/cooldown policy remains separate from the explicit whole-attempt retry below.

## The factory records the model

No writer prompt asks the model to record, report, infer, or attest its own identity. No model footer or hand-written telemetry packet is needed.

The provider transport copies wire metadata into the existing assistant message:

- `model` stays the requested SDK selector. Existing replay and model-selection semantics do not change.
- `responseModel` is the model identifier reported by the provider response.
- `responseModelSource: "provider-response"` identifies transport capture, not model-generated text.
- `responseId` associates the observation with the response in that same supervised writer transcript.

Anthropic capture reads `message_start.message.model`. OpenAI Responses capture reads the **terminal** `response.completed` or `response.incomplete` model. It does not use `response.created.model`; the inspected gateway can synthesize the requested alias there.

Agent-core forwards the completed provider message, and print mode serializes the complete event. The factory parses `message_end` events from that foreground JSON stream. It writes `result.writerProvenance`, including requested profile, per-response observed identity, response IDs, runtime/profile/transcript pins, manifest/source identity, and session directory.

For each successful assistant response, the factory requires:

1. The pinned requested provider and selector.
2. A transport response ID, without duplicates in this transcript.
3. A `provider-response` model value in the exact approved set.
4. A successful terminal writer turn. Intermediate tool-use turns remain recorded.

The result records observed model families even when policy rejects them. Astra is the only approved routine writer family; Fable or any other response in an attempt blocks acceptance. `upstreamIdentityAttested` remains false. This is **gateway-reported model-family provenance**, not a cryptographic upstream attestation, account-routing proof, or evidence of which Astra subscription served the call.

Missing wire metadata, a legacy routing alias, or an unexpected model produces `identityAccepted: false` with explicit blockers. The transcript and output remain preserved. The binder cannot accept that writer receipt as completed authoring. The factory must reconcile it or explicitly authorize a fresh whole-attempt retry. It never infers serving identity from the requested `AssistantMessage.model`, text content or a process exit code.

Initial Astra-low triage also records its actual transport model/source/ID automatically. New triage acceptance requires gateway-reported `gpt-6-astra`, not just its requested SDK selector. Generic management and continuation retain their own automatic transport provenance through the core interfaces.

## One pinned runtime for all native project stages

`OneironManifest.factoryRuntime` is optional for read-only preparation but required for **native execution of every project stage**. A writer profile's runtime pin must equal this shared pin. The same verified CLI runs the writer, project status checks, model-admission pause checks, and publication-guard status calls. No project status or writer helper selects `prime-agent` from PATH.

The shared `factory/runtime.ts` envelope is:

```json
{
  "version": 1,
  "cliArgv": ["/absolute/node", "/absolute/reviewed-install/dist/bundle/cli.js"],
  "files": [{"path": "/absolute/runtime-component", "sha256": "EXACT_SHA256"}],
  "capabilities": ["provider-response-model-v1"]
}
```

`readFactoryRuntime` verifies actual bytes with bounded streaming hashes. Both Node and CLI must be pinned. Every JavaScript bundle chunk in the CLI directory must be included. The deployment manifest must also pin required adapter, lazy-import, manager/coordinator and helper assets. Bundle symlinks fail closed. The capability string alone is not evidence that a release implements the feature.

Native project execution also requires its currently executing adapter module and entry point to occur in the runtime pin list. A different or older actor cannot borrow another release's capability claim. Verification runs at bounded actor admission/launch, not before every Git operation.

### Native owned frontend, not merely `--offline`

A pinned CLI with `--offline` can still use a shared daemon. Factory model actors therefore apply `factoryOwnedEnvironment()` in code. It sets the existing native `PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND=1` environment switch. It does not invent a daemon-free CLI flag or ask the agent to choose its process route.

The helper supplies child-only empty overrides for inherited native owned-worker, daemon-worker/catalog, IPC recovery, orphan-journal and session-lease authority fields. It leaves the parent's environment unchanged and preserves normal environment and factory attempt IDs. It never forges `PRIME_AGENT_INTERNAL_OWNED_WORKER=1`; that flag needs an IPC owner channel and is set only by the native frontend when it creates its worker.

`cli-main` invokes the owned frontend before any early-daemon path. The frontend starts the same Node executable, Node arguments and CLI entry with an IPC-owned worker, waits for completion, forwards termination and reaps its tracked resources. Its worker bypasses daemon-client routing. This native supervised child uses its own process group; it is not an unsupported unowned detached job. The factory command remains a foreground supervisor until that native worker closes.

The writer passes this environment directly to its process launch. The coordinator uses the generic command action's `env` map. Pinned factory status checks and publication-guard status calls use the same child-context isolation; factory status is a non-session command and does not start an owned model worker or daemon.

The earlier selected `.4` CLI does not expose this new transport metadata. It is not eligible for the new writer policy merely because Astra appears in its catalog. The coordinator, scheduler, manager and project actuators must use the reviewed new runtime identity after deployment. Retained RLM catalog staleness does not prove that native CLI model discovery failed.

## Explicit whole-attempt Astra retry

A retry is a new action, manifest, permit, output directory and session. It never reuses an interrupted output directory or continues an old writer session. Its profile is:

- `mode: "astra-retry"`.
- Requested `cpa-r/gpt-6-astra`, effort `xhigh`.
- Approved response models: only `gpt-6-astra`.
- The same shared runtime pin as the new manifest.

The writer stage must include a pinned `retryReconciliation` document with `version:1`, `decision:"retry-whole-attempt"`, ticket, prior action/attempt IDs, exact `priorManifest` and `priorTerminal` pins, `processProof`, nonempty `retainedEvidence`, `workspaceDisposition:"retained"|"restored"`, the complete `reconciledSource`, current custody and owner-authorization pins, `noLiveProcesses:true`, `noDuplicateExecution:true`, and a future `expiresAt`.

These are explicit reconciliation evidence, not proof manufactured from a missing PID. The prior attempt must be the latest unsuccessful terminal attempt for the prior action, with released claims. Successful accepted work cannot be replayed. An uncertain or abandoned process is not accepted as a terminal result by this writer retry adapter. Reconcile it through the existing custody procedure first. Only one explicit reconciled Astra retry from a failed primary Astra attempt is permitted; a chain of retries is not silently authorized.

A retained workspace must equal the prior terminal output fingerprint. A restored workspace must equal the full original source identity. Both checks include the candidate head/tree/branch/remote and full workspace fingerprint. Surviving writer transcript/receipt files must appear in retained evidence. The external process proof must cover the old process tree and duplicate authority; a dead manager alone is insufficient.

The generic command runner sets `PRIME_FACTORY_ATTEMPT_ID` and `PRIME_FACTORY_SOURCE_FINGERPRINT` from its durable manifest, overriding inherited values. These are bookkeeping identifiers, not a sandbox. The retry validator checks the actual current journal record: exact executing action/manifest/source/output, current attempt ID, latest-attempt uniqueness and unreleased SUBMITTED/RUNNING custody. It permits that **one current retry attempt** while still rejecting every competing same-ticket live claim. This avoids rejecting a legitimate retry merely because it correctly holds its own workspace claim.

## Tests and limits

Focused fixture tests cover provider transport capture, unknown/unapproved identities, rejection of Fable drift and legacy profiles, no use of model self-reports, mixed-response rejection, complete runtime chunk pins, and exact retry reconciliation. A real FactoryEngine plus CommandAdapter test executes a supervised retry with a mocked writer response. It proves that its own real running claim is allowed, inherited identity spoofing is overwritten, and a separate same-ticket claim blocks execution before the writer runs.

These tests make no live provider request, publish no product change and do not remove the owner pause. Source-level provider → agent-core → print serialization was inspected. The final packaged-loopback test belongs to reviewed deployment; neither catalog discovery nor injected fixtures should be described as live provider validation.

All output still requires source reconciliation, signed commit/rebind, affected gates, controlled publication and completed current-head review. Model provenance alone never accepts product output. The owner pause, pending ticket transfer, historical red gates and missing docs Codex coverage remain unchanged.
