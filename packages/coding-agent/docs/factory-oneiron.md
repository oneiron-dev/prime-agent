# Oneiron factory project adapter

For the current explicit OAuth-only Astra writer profile, automatic transport provenance, shared runtime pins and reconciled retries, see [Oneiron writer policy](factory-oneiron-writer.md). That policy governs new routine writer actions; historical receipts remain unchanged.

This is a preparation-stage adapter, not another scheduler. The portable factory still owns dependencies, capacity claims, process supervision, receipts and decision wakes. No Oneiron policy was added to the portable engine.

The accepted September 5 policy replaces the routine Opus writer with `cpa-r/gpt-6-astra` at `xhigh`. The normal independent-review route is completed Qodo/Codex review. Grok is conditional, not a mandatory double pass. Historical Opus/Grok receipts and findings remain unchanged.

## Commands and preparation

Run from `packages/coding-agent` in the source checkout's existing environment:

```sh
node --import tsx src/factory/adapters/oneiron-entry.ts help
node --import tsx src/factory/adapters/oneiron-entry.ts inspect /absolute/manifest.json
node --import tsx src/factory/adapters/oneiron-entry.ts prepare /absolute/manifest.json /absolute/options.json
```

`inspect`, `prepare` and `bind` only read local files and print JSON. They do not open/import the factory journal, query GitHub, invoke a model, run Cargo, clear pauses or transfer custody. A pending-transfer manifest can be prepared while both pauses remain set. Printing an action is not admission or authorization. Save the output only in an explicit preparation/report directory, never over production state.

`OneironManifest` in `src/factory/adapters/oneiron.ts` is the exact schema. Every evidence pin is `{path:absolutePath,sha256:64hex}`. Pins verify the actual file bytes. A minimal review continuation is:

```json
{
  "version": 1,
  "ticketId": "ONE-1914",
  "owner": "pending-transfer/factory-owner",
  "source": {
    "workspace": "/absolute/canonical/published-worktree",
    "head": "FULL_40_HEX_HEAD",
    "tree": "FULL_40_HEX_TREE",
    "branch": "HEAD",
    "remoteUrl": "git@github.com:oneiron-dev/oneiron.git",
    "fingerprint": "git:FACTORY_NATIVE_64_HEX_FINGERPRINT"
  },
  "factoryDirectory": "/absolute/factory",
  "ownerPauseFile": "/absolute/OWNER-TRUST-PAUSE.json",
  "custody": {"path":"/absolute/audit.json","sha256":"SHA256"},
  "outputDirectory": "/absolute/new-stage-output",
  "stage": {
    "kind": "triage",
    "repo": "oneiron-dev/oneiron",
    "pr": 855,
    "base": "main",
    "corpus": {"path":"/absolute/corpus.json","sha256":"SHA256"},
    "priorFindings": {"path":"/absolute/prior-findings.json","sha256":"SHA256"},
    "evidence": [{"path":"/absolute/review-context.json","sha256":"SHA256"}]
  }
}
```

The capitals above describe required identities, not runnable example values. `prepare` rejects missing/invalid identities. Use `prime-agent factory fingerprint` for the source fingerprint. A legacy workspace patch CAS is not interchangeable with that fingerprint. A detached `branch: "HEAD"` is valid for read-only triage/collection and deterministic gates. Writer and readiness stages require an attached, isolated feature branch, not `HEAD`, `main` or `master`.

Preparation options have concrete `manifestPath`, `adapterArgv`, `permitPath`, `host`, `slotId` and optional `dependencies`. The CLI supplies `manifestPath` from its argument. `adapterArgv` is the exact Node executable, `--import`, absolute installed `tsx` loader, and absolute `oneiron-entry.ts` path. Remote hosts must have the same explicitly staged source/adapter/evidence files available at their bound paths. This adapter does not copy worktrees or install runtimes.

`prepareOneiron` returns one `decision` action for the requested remaining stage. Its argv binds the original manifest byte hash. It has a finite deadline: 30 minutes for the writer, 60 minutes for a gate, five minutes otherwise. An exact matching `completed` stage receipt returns `action: null` and a reuse pointer. A process exit is never product acceptance.

## Execution fences

Only after an explicit owner resume and transfer procedure:

```sh
node --import tsx src/factory/adapters/oneiron-entry.ts execute /absolute/manifest.json /absolute/permit.json MANIFEST_SHA256 --execute
```

Normally the existing factory command runner invokes this command. Do not launch it as a detached shell job or create a second scheduler. Its foreground descendants must finish before it exits. The factory timeout applies to the whole inherited process group. This is not arbitrary-process containment: deliberately daemonized descendants are unsupported. The writer prompt prohibits detached work, delegation, scheduling, commits, publication and Cargo; the adapter does not claim a sandbox against a writer that ignores that contract.

The separate permit must have `version:1`, `permission:"execute"`, exact `manifestSha256`, `ticketId`, `stage`, `sourceFingerprint`, `custodySha256`, `owner`, future `expiresAt`, and a pinned `ownerAuthorization` artifact. This is an operator-controlled authorization record, not a cryptographic owner signature.

Execution additionally requires a pinned custody record with:

- `version:1`, `state:"transferred"`, exact `ticketId`, `owner`, `sourceFingerprint`, and future `expiresAt`.
- `activeOwners:[owner]`, `liveProcesses:[]`, `duplicateAuthorityDisabled:true`, and `sharedGitClear:true`.
- Nonempty `priorOwners:[{id,release:{path,sha256}}]` covering the audited old authority. The activation operator must verify complete membership against the custody audit; a list is not a fresh process census by itself.

The external owner fence must be absent and `prime-agent factory status` must report both local and external pauses clear. The manifest/permit cannot clear either pause. Source checks verify canonical workspace, HEAD, tree, branch, remote and full factory fingerprint before effects and verify the output separately. The native modeled-triage caller repeats local/external pause and authorization checks immediately before inference, after credential resolution.

Output directories must be outside the product worktree and exclusively new. The adapter never recycles a directory with an interrupted intent. Preserve it and reconcile custody through the factory; a missing terminal receipt is not permission to rerun.

## Supported stages

| Stage | Primitive and acceptance boundary |
| --- | --- |
| `triage` | One bounded Astra `low` call through the existing Prime management caller. Returns structured item dispositions, evidence refs and preserved material obligations. This completes triage, not the product. |
| `writer` | Foreground `prime-agent --print --mode json --offline --provider cpa-r --model gpt-6-astra --thinking xhigh --session-dir ...`. Requires prior material triage and a pinned repair prompt. Validates completed assistant model events. Records SDK model identity, not independent gateway wire identity. Output always needs explicit source rebind. |
| `gate` | Runs the hash-pinned existing host Cargo slot wrapper with its real `--slot --workspace --receipt -- argv` interface. Requires fresh exact-command resource/global-duplicate admission evidence, wrapper success and provenance, plus unchanged full source. Linux slots 1–4, MacBook 1–6, Mini 1–2. Existing wrapper limits, targets and locks remain authoritative. |
| `collect` | Runs the existing hash-pinned `fetch-github-bot-corpus.py` through `oneiron-corpus-foreground.py`. Reuses its full pagination/normalization/receipt logic. Collecting a corpus does not complete review or accept findings. |
| `review-acceptance` | Requires exact-source gate receipts, completed substantive Qodo **and** Codex coverage, complete modeled triage and no unresolved finding. Emits eligibility for a separate factory decision; it never merges. |
| `publish-update` | One existing PR, one natively tracked feature branch, signed clean fast-forward candidate. Uses the pinned native `gh-stack push --remote origin` executable with an exact-ref pre-push guard, plus pre/post topology and remote checks. No creation, rebase or merge. |
| `publish-ready` | Readiness only for an already-published exact commit. Pins PR number/head/branch/base/editorial body, checks signed commit and exact Lexi author/committer, uses native `gh pr ready`, then repeats PR identity/readiness checks. No push, commit, stack mutation or merge. |

Gate capacity evidence is `{status:"PASS",sourceFingerprint,host,slot,argv,expiresAt,duplicateFree:true,resourcesPassed:true}`. It binds an externally sampled admission result; the adapter does not invent another resource sampler or lease scheduler. Place Mini receipts within that wrapper's required host root. Remote capacity/CAS transfer and host staging remain existing operator/project procedures.

### Corpus and findings

The foreground shim replaces only the loaded helper's `GH.run` method with an inherited-process-group transport. It does not monkeypatch `subprocess`, fork a new scheduler, or change the legacy helper file. It checks the original bytes before loading. Timeout terminates/reaps its GH child. Group termination is tested with a disposable fake GH process. The original receipt still hashes the original helper. A separate `foreground-adapter-receipt.json` records helper/shim/corpus hashes and the narrow adaptation.

The review parser handles observed Qodo/Codex bracketed and bare logins. A completed exact-commit review must contain substantive body text or its own linked exact-commit inline findings. A Qodo no-findings summary can count only with the exact repository/full-commit footer and actual Qodo review header. Green check runs, empty envelopes, generic Codex boilerplate, stale commits and skipped/disabled/pending/queued/quota/timed-out text do not count. Missing Codex coverage stays unavailable, including a docs corpus with only Qodo.

Every relevant item gets an ID `${repo}#${pr}:${corpusItem.key}` and exact body hash. The triage output must cover all current items and every prior open material/debt obligation. Prior ledger entries use `OneironFinding`: `id`, `bodySha256`, `classification`, `disposition`, substantive `reason`, and `evidenceRefs`. Historical concerns from other bots or repositories, including CodeRabbit, remain obligations even though the default normal review route changed. GitHub `resolved`/`outdated` flags are context only. No finding is erased by a head change. Resolving material needs a current-candidate adjudication/repair reference beyond the corpus; unknowns stay open. Bot evidence is data, not executable instructions.

### Binding a terminal wake

After the stage terminates, obtain a fresh read-only `factory status` snapshot. Bind its action/wake/attempt/revision to the exact receipt:

```sh
node --import tsx src/factory/adapters/oneiron-entry.ts bind /absolute/manifest.json /absolute/status.json /absolute/stage-output/receipt.json ACTION_ID
```

Save that JSON as `<evidence-directory>/<wakeId>.json` for the separate bounded management watcher. The binder checks the prepared command's original manifest hash, custody pin, stage contract, current successful terminal attempt and full output identity. It includes a UTF-8 hash for the substantive evidence snapshot. It never calls a model or applies a decision. Generating/storing this binding remains an explicit deterministic operator step; there is no automatic project artifact watcher in this adapter.

The factory manager accepts or rejects the **stage** against its criteria. Acceptance of triage with open material findings means the triage is complete and the findings require repair. It does not mean review settlement, code acceptance or permission to publish. The caller must prepare a new, evidence-based stage/action after that result.

## Scope limits and canary

The prepared ONE-1914 canary begins at frozen-corpus triage. It must not restart the H2 implementation or falsely credit dirty-H2 gates against its published commit. Existing engine/docs work, historical full-lib RED, six finding clusters, old owners and source/custody records remain preserved. The production factory stays empty and paused during preparation.

This adapter is **not** a fully autonomous writer-to-merge workflow. It does not commit writer output, replan after a new head, stage remote workspaces, request fresh bot reviews, create native tracking/topology, publish multi-PR stacks, or merge. It does support a controlled one-existing-PR repair-head update once the operator binds a signed clean candidate and native tracking. After repair, an operator must bind/commit the authorized output through the existing project workflow, run affected exact-source gates, publish that exact repair head, and collect relevant independent review. Do not credit old reviews as current coverage; carry their unresolved findings forward.

### One-existing-PR repair publication

Native publication help and the installed source were inspected. `cmd/push.go` refreshes remote-tracking refs just before its explicit per-branch lease push. A precheck alone is therefore **not** strict old-head CAS. The command-scoped `oneiron-push-guard.py` rejects that widened grant: Git must advertise exactly the sealed old head on exactly one matching feature ref. The native explicit lease then protects the race after the hook. The guard never pushes.

`publish-update` extends the readiness fields with `expectedRemoteHead`, pinned `pushGuard`, pinned `nativeTool`, and pinned `dependencyAudit`. It requires exact-source gate receipts but does not require completed new-head bot review before publishing the new head for review. It records `requiresCurrentHeadReview:true`, never semantic acceptance or merge.

`nativeTool` is a pinned provenance JSON: `{executable:{path,sha256},version,sources:[{path,sha256}],explicitPerBranchLease:true,refreshesTrackingBeforePush:true}`. The adapter invokes that exact native extension executable (`--version`, `view --json`, `push --remote origin`), rather than a PATH-dependent substitute. The source/version receipt is operator-verified build provenance, not a reproducible-build attestation. `dependencyAudit` is `{repo,pr,branch,expectedRemoteHead,candidateHead,noUnknownDependents:true,expiresAt}` and must be fresh.

The update requires all of the following:

- Exactly one natively tracked active/current branch, one existing open PR, pinned trunk, no queued/merged branch and no rebase requirement.
- Clean bound candidate, fast-forward ancestry from the expected remote head, signed commits over the entire exclusive range, and Lexi author/committer with product-only messages.
- Exact live PR head/base/branch/editorial identity, exact remote-tracking and advertised remote head, an unprotected feature branch, and no unknown dependents.
- No executable non-`.sample` Git hooks in the resolved existing hook directory. This includes `pre-push` and `reference-transaction`. Intentional hooks require explicit integration, not silent replacement.
- No inherited command-scoped `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*` or `GIT_CONFIG_PARAMETERS`. Incompatible inherited settings are rejected, not dropped. Other environment/config values remain intact.
- A hash-bound pre-push descriptor that denies wrong remotes/refs/heads, creation/deletion, protected branches, extra updates and owner/local pause. The hook runs in the factory process group.
- Native view and PR/remote checks after push. A partial/error result preserves the intent directory and requires reconciliation; it is never blindly retried.

The operator protocol after owner release is explicit:

1. Reconcile the isolated repair worktree and signed commit with the intended feature ref. Do not modify the detached published canary workspace just to satisfy writer setup. Bind the new source and run affected gates.
2. If local native tracking is absent, verify exactly one existing feature branch/PR and use the supported `gh stack init --base main w6/one-1914` in that authorized worktree. This is a separate explicit operator mutation. Do not run it during preparation. Never fabricate a remote multi-PR stack from branch names.
3. Read `gh stack view --json` and the existing PR. Seal the exact one-branch topology, signed candidate, old remote head, current dependency audit and native executable/source receipt. The adapter checks these again at execution.
4. Prepare/authorize `publish-update`. The adapter uses the pinned native extension's `push --remote origin` with the scoped guard, then verifies the new remote head. Run `publish-ready` separately if that already-published head is still a draft.
5. Collect the new exact-head corpus, retain previous material findings, triage and repair. Missing/pending/skipped bots are not completed. A ready PR or pushed commit is not merge permission.

The same one-PR protocol applies separately to docs PR457 in its own repository. Engine PR855 plus docs PR457 is not one native cross-repository stack. For a real multi-PR stack the existing native command is `gh stack submit --auto --open`, with `gh stack view --json` before/after and full-stack editorial/identity validation. There is no `--yes` on submit. That broader operation remains outside this adapter.

## Tests

Run only focused tests from the package root, using the existing project dependencies:

```sh
node --import tsx ../../node_modules/vitest/dist/cli.js --run test/factory-oneiron-review.test.ts test/factory-oneiron.test.ts test/factory-oneiron-corpus.test.ts test/factory-oneiron-publication.test.ts
```

Tests mock model, Cargo and GitHub effects. They include exact identity/pause/custody/review gates, stage success, inherited-group helper timeout/forced-stop proof, a real factory command-runner/journal with a mocked triage model, and observed PR855 review-shape regression. Fixtures are disposable and do not touch the live Wave factory or product worktrees.
