# Oneiron ticket loop

The factory is a DAG launcher; this adapter is the one command it launches per ticket stage. There is no dispatcher seat, no permit, no custody record and no typed decision. Tests are the only gate. Every seat prompt carries the same three sentences on initiative, so the passivity fix lives in words, not in checks.

## The loop

`factory launch` reads the ticket DAG (`w7-manifest.json`: tickets with `blocked_by`) and the contracts (`mint-plan.json`: `creates[]` with `contract` and `acceptance`) and imports two actions per ticket:

- `<key>:submit` depends on every blocker's `submit` (every blocker's `merge` under `noStacks`). It cuts a worktree, has Muse write the context pack, runs one writer session until the last line of its reply is exactly `DONE <key>`, runs the tests of the touched crates, reviews the head by tier, publishes, requests CodeRabbit, waits bounded for Qodo and Codex, and runs a writer round over every bot comment.
- `<key>:merge` depends on `<key>:submit` and every blocker's `merge`. It waits for the blockers, syncs the native stack, or prepares the lone pull request outside the merge mutex and squash-merges its exact head once its required checks pass, and removes the worktree.

A blocker that is neither a ticket of this launch nor one the factory already knows fails the whole launch before anything is written, naming the ticket and the missing id. Earlier it was dropped silently and its dependent started at once.

There is no lane cap: every ready action launches in the same tick. Only cargo runs queue, on the four build slots, and only merges serialize.

No clock ends work that is still happening. A seat and a cargo run are guarded by `idleMs` alone: the deadline moves forward on every byte the child writes, so only a stream that has gone silent is killed. A kill is logged as `seat idle`, journaled in `state.json` under `idleKills`, and the round continues in the same session. Writer rounds are unbounded. The `submit` and `merge` actions carry a 72-hour backstop that no real ticket reaches.

### The worktree

`git worktree add -B w7/<key> <work>/wt/<key> <base>` after `git fetch origin`. The base is `origin/main`, or the blocker's branch when exactly one blocker is unmerged and submitted; then `gh stack init --base main <chain...> w7/<key>` adopts the chain in this worktree, so the chain is a native GitHub stack. With two or more unmerged blockers the runner waits until at most one remains. `.w7/` is excluded from git; it holds the pack.

With `noStacks` the base is always `origin/main`: the runner waits until every blocker merged, publishes with `gh pr create --base main`, merges with `gh pr merge --squash`, and never calls `gh stack`.

### Where cargo runs

Builds belong on a Mac, not on the writers' host. `buildHosts` is an ordered list; the wrapper shipped at `dist/factory/bin/cargo` goes first on the PATH of the ticket runner and of every seat, so it catches both the runner's own test step and the writers' own `cargo` calls.

A call whose git toplevel is `<work>/wt/<key>` is offloaded. Under a per-ticket lock, the first host with a free slot takes it: each host admits `slots` calls at once (one lock per slot, held through the sync, the run and the sync-back) and caps every call at `jobs` Cargo jobs (a larger `-j` is lowered, a smaller one kept, build commands get an explicit `--jobs`). The worktree is synced with `rsync -a --delete --exclude target --exclude .git` to `<root>/wt/<key>`, the same arguments run in the same relative directory, output streams back, and the exit code is the remote one. The remote `target/` is excluded from the sync, so it stays a per-ticket build cache. `fmt`, `fix` and `clippy` sync the tree back. `RUST_TEST_THREADS`, `RUSTFLAGS`, `RUSTDOCFLAGS`, `CARGO_INCREMENTAL` and `CARGO_PROFILE` travel with the call, `CARGO_BUILD_JOBS` is the host's budget, and `CARGO_TARGET_DIR` does not travel. The entry `{"sshHost": "local", "root": ...}` is this host: cargo runs here with `CARGO_TARGET_DIR=<root>/target/<key>`. Login shells on the build hosts are fish, so every remote command is `/bin/bash -s` with the script on stdin.

When every slot of every reachable host is busy the call waits (`WAIT_CAPACITY` on stderr once a minute) instead of overrunning a host. A host that cannot be reached is skipped for the rest of the call. A call from anywhere else, an empty `buildHosts`, no host reachable at all, or `W7_CARGO_LOCAL=1` runs the real cargo on the ticket host unchanged. The wrapper runs on bash 3.2 and uses `flock(1)`, or perl's `flock(2)` where that is missing.

### Seats

The defaults stay in source (`DEFAULT_SEATS`, all on `cpa-r`: writer `gpt-6-astra` xhigh, pack `muse-spark-1.3-contributor` max, grok `grok-4.6` xhigh, opus `claude-opus-5` xhigh). A launch picks its models in `launcher.json` `seats`, for example `{"writer":{"provider":"cpa-r","model":"gpt-6-sol","thinking":"xhigh"},"grok":{"provider":"cpa-r","model":"gpt-6-astra","thinking":"xhigh"}}`, with `tier: "two"` on every manifest row for one reviewer on the `grok` slot. The seats are copied into every `ticket.json`; a ticket cannot override one. A seat always passes `--provider`, and the runner host must define that provider and model in its own `~/.prime/agent/models.json`: add a new model id there before a launch names it.

### Opening a seat

Seats spawn with `--daemon-hosted`, so the daemon owns the session instead of the launcher. The seat is listed as running in `prime-agent` and in the agents view, and can be opened from another terminal while the launcher keeps consuming its JSON event stream. Check it with `prime-agent` and the agents view, or `prime-agent session list`.

The session outlives the round that created it: the next round attaches to it with `-c`. A seat that finishes and is left alone is evicted by the daemon's ordinary idle policy (`idleEvictionMinutes`, 90 by default); a seat with a client attached or a turn in flight is never evicted. If the daemon is stopped, its workers stop with it: the seat process sees its stream end and exits non-zero, the launcher logs that round's exit code, and the next round starts a fresh session from the same session directory. Nothing is lost silently, and the ticket's own `state.json` decides where the stage resumes.

### The pack

Muse (`cpa-r/muse-spark-1.3-contributor`, thinking `max`) reads the docs mirror, `impl-notes/` and the worktree and returns the pack as its final message; the runner writes it to `.w7/CONTEXT.md`. The prompt says: "Docs might be stale. Implementation notes live in impl-notes/. Read them too when gathering context."

### The writer

The `writer` seat (Astra, `cpa-r/gpt-6-astra` xhigh, by default) through prime-agent print mode with the owned frontend; the prompt travels on stdin, so a large one never hits the argument limit. One session is continued with `-c` until the reply is terminal. A reply is terminal only when its last non-empty line, outside any code fence, is exactly `DONE <key>` or `BLOCKED <key>: <why>`; the final text is the last assistant reply of a turn that reached `agent_end` with stop reason `stop` and no tool call, never the raw stream. Every other reply continues the session: Jev and the Grok advisor only classify it as a plain continuation or a named split remainder, never as done or blocked, and each decision lands in `routing.jsonl`. There is no round cap: a writer holding an ultralarge packet may work for many hours and no count may stop it. The only exit that is not the writer's own is twenty consecutive rounds whose seat wrote nothing at all, which is a seat that cannot start rather than a model that is still working. `BLOCKED <key>: <why>` fails the stage.

A runner restarted after a crash continues the writer session it already had. An owner note in `<ticket>/resume-note.md` rides the next writer round and is then renamed `resume-note.<time>.delivered.md`, so it arrives once.

Productive waiting belongs to the factory. A writer that starts a durable validation registers it in `<ticket>/pending-jobs/<session>.json` (job id, controller pid and start identity, terminal path) before it yields; the runner waits for the job's own atomic terminal record with no model round and no deadline, then resumes the same session with the exit code. A registered job wins over the reply text, so pending work is never DONE, and a controller that vanishes without its terminal record fails the stage as a custody failure. The system prompt carries the seat policy sentence ("Use cpa-r/muse-spark-1.3-contributor with thinking max for context-gathering RLM subagents, never Astra; an Astra xhigh child only for a genuinely hard sub-task."), the initiative sentences and the writer rules (one coherent implementation, the smallest falsifying test, a plan is not work, do the whole contract, never edit the docs repo, notes in `impl-notes/<ticket>.md`, no attribution lines). A `SPLIT: <what remains>` line in the final message is written to `split.json`; `serve` imports it as one follow-up ticket `<key>-split` blocked by `<key>`. The machine never judges size.

### Tests

`cargo test --no-fail-fast -p <crate>...` for every crate under `crates/` touched since the base, with `CARGO_TARGET_DIR=<work>/target/<key>` and `CARGO_BUILD_JOBS`. The run takes one of `buildSlots` pid-lock files under `<work>/build-slots/` and waits while free space is under `diskFloorGiB`. It is guarded by `idleMs`, not by a wall clock, so a long link or a slow test suite is never cut. A run that reports zero tests is not a pass. A failure gets one fix round in the `fix-<label>` session, then the tests again; a second failure rejects the stage. A run killed for silence is an infrastructure failure: it fails the stage without a fix round and is never a test verdict.

With `skipFactoryTests` (which needs `noStacks`) the factory runs no cargo tests of its own, so a ticket that touches no crate no longer fails "zero tests ran"; the merge waits for the pull request's required checks instead, and a pull request with no required check reported never passes that gate.

### Review by tier

The tier comes from the ticket (`tier`: one/bots, two, three), else from routing: a touched seam (custody, auth, persistence, migration, crypto, concurrency, abi, public_api by path) forces both reviewers; otherwise Jev decides above the band, the Grok advisor takes the band, and a size default answers when neither is reachable. Tier two is the `grok` seat; tier three is the `grok` and `opus` seats in parallel; tier one runs no reviewer. The slot names are only names: the launcher decides their models. Each reviewer runs in its own session and must return exactly one standalone `VERDICT: LANDABLE` or `VERDICT: DEFECTS` line outside code fences; a reply without one is continued in the same session, never read as a pass. A reviewer whose seat never started is recorded unavailable and skipped; one that ran tools or answered and then failed, refused, or overflowed its context stops the stage with its session named for a same-session resume. Owner recovery: `sessions/<session>.resume` continues the review's original session file in place, and `sessions/<session>.completed.json` reconsumes a saved terminal verdict only when it binds this worktree, the clean head, the message and its seat stream. Defects get one fix round, tests again, then the reviewers once more on the new head unless routing calls the delta trivial. A second DEFECTS verdict is recorded in the pull request body; it does not loop. Routing answers land in `routing.jsonl`.

### Publication

A lone ticket: `git push -u origin w7/<key>`, `gh pr create --base main`, an existing open pull request is reused. A stacked ticket: `gh stack submit --auto --open --remote origin`, then `gh pr edit` sets the title and body. The body is the writer's `PR BODY:` section plus contract, acceptance, row, tier and verdicts; attribution lines are stripped from it. Commit messages are scanned for attribution and the hits are logged in `state.json`. No raw force push happens in this stage.

### Bots

One `gh pr comment <pr> --body "@coderabbitai review"`; a failed request is recorded and ignored. The runner then polls `gh api` every minute for up to `botsMs` (default 45 minutes) until Qodo and Codex have each posted a substantive review on the head or a terminal not-completed notice (skipped, rate-limited, failed); a pending, queued or in-progress notice keeps it polling, because Qodo rewrites that post in place. Every bot comment on the pull request, from every bot, then goes unfiltered to the `bots` writer session, which first fetches the latest reviews, comments and threads of all bots plus the internal findings, deduplicates them with their ids kept, fixes what is real, replies on each inline thread with `gh api .../replies`, and posts one summary that maps every id to its disposition and reports only validation that ran. If the head moved, the tests run again and the branch is pushed (`gh stack push` for a stack). `skipBots` skips the request, the wait and the round.

### Merge

After every blocker's `merge` accepted: for a stack, under the global merge mutex, `gh stack sync` then `gh stack merge --squash --yes`; a sync conflict gets one fix round (the writer rebases and resolves, then tests) and one more sync.

A lone pull request is prepared under a per-ticket lock outside the global mutex: fetch, check that the head contains `origin/main`, update a branch that is merely behind with `gh pr update-branch` or give a conflicting one a fix round that merges `origin/main` (a merge commit, conflicts resolved), run the full gate on the new bytes, push the exact tested head with a plain `git push`, confirm the remote branch and wait for the pull request API to show that head, then wait (bounded by `ciMs`, 45 minutes) for its required checks (`gh pr checks --required`); a failed required check rejects the stage. With `preMergeReview` the review seat then reads that exact head once more, and only `VERDICT: LANDABLE` goes on. The global mutex `<work>/merge-lock/` covers only the final recheck of head, base and checks and `gh pr merge --squash --subject <key>: <title> --body-file PR-BODY.md --match-head-commit <head>`; a trunk that moved releases it and the candidate is prepared again. There is no force push anywhere. A pull request GitHub already reports as merged is accepted as merged.

Owner recovery of a committed merge repair that was interrupted before its push: `sessions/merge-repair.resume.json` with `head`, `remoteHead`, `fixSessionPath` and, per mode, `messageId`. Mode `post-ci-repair` answers a failed required check and also carries `failedCiHead`, `runId` and `jobId`, verified against GitHub; mode `initial-fix-merge` binds a fix-merge writer that ended BLOCKED and later completed with its exact DONE line; no mode binds a failed merge-test gate after the fix session finished. The repair head then takes the full gate, an ordinary push and the propagation wait.

## Files

- `launcher.json` (passed to `factory launch`, stored in `config.json`): `host` (a configured factory host), `repo` (the engine checkout that owns the worktrees), `docs` (optional docs mirror), `work` (worktrees, targets, ticket directories), `remote` (`origin`), `trunk` (`main`), `githubRepo` (`owner/name`, else derived from the remote URL), `buildSlots` (4), `cargoJobs` (4), `diskFloorGiB` (100), `idleMs` (30 min, minimum 1 min), `buildHosts` (ordered `{sshHost, root, slots, jobs}`, `slots` 2 and `jobs` `cargoJobs` by default, `sshHost: "local"` for this host; empty keeps cargo on this host), `seats` (`writer`, `pack`, `grok`, `opus`: `{provider, model, thinking}` for prime-agent, or `{command: [...]}` for any executable that takes the prompt as its last argument), `timeouts` (`ghMs` 5 min for gh and git, `botsMs` 45 min for the bot poll, `ciMs` 45 min for the required checks before a merge), and four launch settings, all off by default: `noStacks`, `skipFactoryTests` (needs `noStacks`), `skipBots`, `preMergeReview`. There is no seat, test or round limit to set.
- `<work>/tickets/<key>/ticket.json`: the ticket run the launcher wrote (contract, acceptance, tier, blockers, launcher settings).
- `<work>/tickets/<key>/state.json`: base, stack chain, writer final text, tests, review tier and verdicts, pull request, bots, bot round, merged, failure.
- `<work>/tickets/<key>/run.log`, `logs/` (seat streams, cargo, gh), `routing.jsonl`, `split.json`, `PR-BODY.md`, `sessions/` (one directory per writer or review session), `pending-jobs/`, `resume-note.md`.
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

Running `factory launch` again on tickets the ledger already knows is the supported way to correct a DAG: every `ticket.json` is rewritten with today's blockers and launcher settings, and every action that has not started is re-imported with its new dependencies. Actions that already started keep their spec and come back in the `frozen` list. A runner that is already waiting on its blockers re-reads `blockedBy` from `ticket.json` on every iteration, so the fix reaches it without a restart.

`factory resolve <directory> <attempt-id...>` takes several attempt ids, so one mass restart carries one piece of evidence.

`factory recover-admit <directory> <selected-plan.json> --select <action> [--supersede <rejected>] --expected-revision <n> --mutation-id <id> --actor --reason --ref` admits exactly one owner-selected action while the factory stays paused, for sequential shipping without a resume window. It refuses while any claim is live, uncertain or unreleased, commits the SUBMITTED claim and the mutation receipt before the launch, and never launches a replayed mutation id again.

## Exception watchdog

`node <install>/lib/node_modules/prime-agent/dist/factory/watchdog.js --factory <dir> --session <owner-session>` reads `factory status` and the durable event cursor with no model call and messages that session (`prime-agent send`) only for a new actionable exception: a rejected or uncertain attempt, a runner identity missing twice without a terminal receipt, a `user_prompt_too_long` or explicit review refusal failure, `factory serve` disappearing, or local free space crossing below `diskFloorGiB`. What exists at the first pass is baselined silently. The outbox is written before the send and cleared only after the daemon accepted it, so delivery is at least once with a stable key per incident. A failed send retries with a backoff up to 15 minutes; after eight failures that item pauses at the head of the outbox and later alerts wait behind it, because the send carries no idempotency key: check the daemon and `deliveries.jsonl`, then clear the item's `deliveryPaused`, `attempts` and `nextAttemptAt` in `state.json`. `errors.log` names the pause. State lives in `<factory>/watchdog/`. The user unit template `dist/factory/factory-exception-watchdog@.service` runs one instance per factory; its header says how to install it.

`status` shows `<key>:submit` and `<key>:merge` per ticket. A rejected stage leaves `state.json` with `failure`; fix the cause, then `supersede` it with a replacement action or `resolve` an uncertain attempt. Restart after a crash with `resume` then `serve`; a live runner is reattached, a finished one is read from its receipt, and a running ticket resumes from its `state.json` steps.

## Tests

```sh
node --import tsx ../../node_modules/vitest/dist/cli.js --run test/factory-oneiron-ticket.test.ts test/factory-launcher.test.ts test/factory-routing.test.ts test/factory-oneiron-review.test.ts test/factory-cargo-wrapper.test.ts test/factory-watchdog.test.ts
```

The runner test uses a real git repository with a local bare remote, fake `gh` and `cargo` executables on `PATH`, and a fake seat command; it runs one ticket from worktree to merge and stacks a child on its submitted parent. It also kills a silent seat, keeps a talking one, and drives a writer past the old round cap. The wrapper test runs the real `bin/cargo` against fake `ssh` and `rsync` executables and asserts the host order, the synced path, the remote directory and the argument mapping. No model, GitHub or real cargo call happens.
