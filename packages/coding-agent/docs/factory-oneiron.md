# Oneiron ticket loop

The factory is a DAG launcher; this adapter is the one command it launches per ticket stage. There is no dispatcher seat, no permit, no custody record and no typed decision. Tests are the only gate. Every seat prompt carries the same three sentences on initiative, so the passivity fix lives in words, not in checks.

## The loop

`factory launch` reads the ticket DAG (`w7-manifest.json`: tickets with `blocked_by`) and the contracts (`mint-plan.json`: `creates[]` with `contract` and `acceptance`) and imports two actions per ticket:

- `<key>:submit` depends on every blocker's `submit`. It cuts a worktree, has Muse write the context pack, runs one Astra xhigh writer until it says `DONE <key>`, runs the tests of the touched crates, reviews the head by tier, publishes, requests CodeRabbit, waits bounded for Qodo and Codex, and runs a fresh writer round over every bot comment.
- `<key>:merge` depends on `<key>:submit` and every blocker's `merge`. It waits for the blockers, syncs the native stack or squash-merges the lone pull request under one merge mutex, and removes the worktree.

There is no lane cap: every ready action launches in the same tick. Only cargo runs queue, on the four build slots, and only merges serialize.

### The worktree

`git worktree add -B w7/<key> <work>/wt/<key> <base>` after `git fetch origin`. The base is `origin/main`, or the blocker's branch when exactly one blocker is unmerged and submitted; then `gh stack init --base main <chain...> w7/<key>` adopts the chain in this worktree, so the chain is a native GitHub stack. With two or more unmerged blockers the runner waits until at most one remains. `.w7/` is excluded from git; it holds the pack.

### The pack

Muse (`cpa-r/muse-spark-1.3-contributor`, thinking `max`) reads the docs mirror, `impl-notes/` and the worktree and returns the pack as its final message; the runner writes it to `.w7/CONTEXT.md`. The prompt says: "Docs might be stale. Implementation notes live in impl-notes/. Read them too when gathering context."

### The writer

Astra (`cpa-r/gpt-6-astra`, thinking `xhigh`) through prime-agent print mode with the owned frontend, one session continued with `-c` until the final message contains `DONE <key>` (at most `writerRounds`, default 12). `BLOCKED <key>` fails the stage. The system prompt carries the seat policy sentence ("Use cpa-r/muse-spark-1.3-contributor with thinking max for context-gathering RLM subagents, never Astra; an Astra xhigh child only for a genuinely hard sub-task."), the initiative sentences and the writer rules (one coherent implementation, the smallest falsifying test, a plan is not work, do the whole contract, never edit the docs repo, notes in `impl-notes/<ticket>.md`, no attribution lines). A `SPLIT: <what remains>` line in the final message is written to `split.json`; `serve` imports it as one follow-up ticket `<key>-split` blocked by `<key>`. The machine never judges size.

### Tests

`cargo test --no-fail-fast -p <crate>...` for every crate under `crates/` touched since the base, with `CARGO_TARGET_DIR=<work>/target/<key>` and `CARGO_BUILD_JOBS`. The run takes one of `buildSlots` pid-lock files under `<work>/build-slots/` and waits while free space is under `diskFloorGiB`. A run that reports zero tests is not a pass. A failure gets one fix round by a fresh writer session, then the tests again; a second failure rejects the stage.

### Review by tier

The tier comes from the ticket (`tier`: one/bots, two, three), else from routing: a touched seam (custody, auth, persistence, migration, crypto, concurrency, abi, public_api by path) forces both reviewers; otherwise Jev decides above the band, the Grok advisor takes the band, and a size default answers when neither is reachable. Tier two is Grok 4.6 xhigh; tier three is Grok plus Opus xhigh in parallel; tier one runs no reviewer. Each reviewer reads the diff once and answers `VERDICT: LANDABLE` or `VERDICT: DEFECTS`. An unavailable reviewer is recorded and skipped, never a blocker. Defects get one fix round, tests again, then the reviewers once more on the new head unless routing calls the delta trivial. A second DEFECTS verdict is recorded in the pull request body; it does not loop. Routing answers land in `routing.jsonl`.

### Publication

A lone ticket: `git push -u origin w7/<key>`, `gh pr create --base main`, an existing open pull request is reused. A stacked ticket: `gh stack submit --auto --open --remote origin`, then `gh pr edit` sets the title and body. The body is the writer's `PR BODY:` section plus contract, acceptance, row, tier and verdicts; attribution lines are stripped from it. Commit messages are scanned for attribution and the hits are logged in `state.json`. No raw force push happens in this stage.

### Bots

One `gh pr comment <pr> --body "@coderabbitai review"`; a failed request is recorded and ignored. The runner then polls `gh api` every minute for up to `botsMs` (default 45 minutes) until Qodo and Codex have each posted a substantive review on the head or a not-completed notice (skipped, rate-limited, processing). Every bot comment on the pull request, from every bot, then goes unfiltered to a fresh writer session, which fixes what is real, replies on each inline thread with `gh api .../replies`, and posts one summary comment. If the head moved, the tests run again and the branch is pushed (`gh stack push` for a stack).

### Merge

After every blocker's `merge` accepted: for a stack, `gh stack sync` then `gh stack merge --squash --yes`; a sync conflict gets one fix round (the writer rebases and resolves, then tests) and one more sync. For a lone pull request, `gh pr merge --squash --subject <key>: <title> --body-file PR-BODY.md`; when that fails, a branch that is merely behind is updated with `gh pr update-branch`, otherwise one fix round merges `origin/main` into the branch (a merge commit, conflicts resolved, tests again) followed by a plain `git push`, then one more merge. There is no force push anywhere. Merges on one host serialize through `<work>/merge-lock/`. A pull request GitHub already reports as merged is accepted as merged.

## Files

- `launcher.json` (passed to `factory launch`, stored in `config.json`): `host` (a configured factory host), `repo` (the engine checkout that owns the worktrees), `docs` (optional docs mirror), `work` (worktrees, targets, ticket directories), `remote` (`origin`), `trunk` (`main`), `githubRepo` (`owner/name`, else derived from the remote URL), `buildSlots` (4), `cargoJobs` (4), `diskFloorGiB` (100), `seats` (`writer`, `pack`, `grok`, `opus`: `{provider, model, thinking}` for prime-agent, or `{command: [...]}` for any executable that takes the prompt as its last argument), `timeouts` (`seatMs` 1 h, `testMs` 40 min, `ghMs` 5 min, `botsMs` 45 min, `writerRounds` 12).
- `<work>/tickets/<key>/ticket.json`: the ticket run the launcher wrote (contract, acceptance, tier, blockers, launcher settings).
- `<work>/tickets/<key>/state.json`: base, stack chain, writer final text, tests, review tier and verdicts, pull request, bots, bot round, merged, failure.
- `<work>/tickets/<key>/run.log`, `logs/` (seat streams, cargo, gh), `routing.jsonl`, `split.json`, `PR-BODY.md`.
- `<work>/wt/<key>`: the worktree; `<work>/target/<key>`: its cargo target.

Routing reads `TYPESAFE_JEV_API_KEY` (and optional `TYPESAFE_JEV_URL`), `FACTORY_ADVISOR_BASE_URL`, `FACTORY_ADVISOR_API_KEY`, `FACTORY_ADVISOR_MODEL` from the runner's environment. Bearer keys only travel to HTTPS or private HTTP endpoints. Seat children never receive those keys.

## Running one ticket

```sh
# once per host: a factory with one local host
echo '{"arch":{"type":"local","runnerRoot":"/home/lexi/w7-build/attempts"}}' > hosts.json
echo '{"version":1,"tickets":[],"slots":[],"actions":[]}' > empty-plan.json
prime-agent factory init /home/lexi/w7-build/factory empty-plan.json --hosts hosts.json

# the DAG and the contracts, from the wave pack
prime-agent factory launch /home/lexi/w7-build/factory w7-manifest.json mint-plan.json --launcher launcher.json

# catch up from the ledger, unpause, one tick; then keep scheduling
prime-agent factory resume /home/lexi/w7-build/factory
prime-agent factory serve /home/lexi/w7-build/factory
```

`status` shows `<key>:submit` and `<key>:merge` per ticket. A rejected stage leaves `state.json` with `failure`; fix the cause, then `supersede` it with a replacement action or `resolve` an uncertain attempt. Restart after a crash with `resume` then `serve`; a live runner is reattached, a finished one is read from its receipt, and a running ticket resumes from its `state.json` steps.

## Tests

```sh
node --import tsx ../../node_modules/vitest/dist/cli.js --run test/factory-oneiron-ticket.test.ts test/factory-launcher.test.ts test/factory-routing.test.ts test/factory-oneiron-review.test.ts
```

The runner test uses a real git repository with a local bare remote, fake `gh` and `cargo` executables on `PATH`, and a fake seat command; it runs one ticket from worktree to merge and stacks a child on its submitted parent. No model, GitHub or cargo call happens.
