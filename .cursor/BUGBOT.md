# Review rules

These rules mirror the repo standards in AGENTS.md - update both whenever
either changes.

## Repository identity

- Repository commits use only the ambient Git identity. Never configure or override author/committer names or emails for repository history. Missing identity is an error to report, not repair with configuration.
- Never add `Co-authored-by` or other assistant attribution trailers.

## Performance and the critical path

- First paint and user-visible frames must never await network, disk sync, telemetry delivery, or background bookkeeping. Hand work to its owning background worker and return.
- Telemetry delivery is fire-and-forget from startup, session creation, tab opening, and render paths. Timeout, retry, and ordering belong to the delivery worker.
- A changed fire-and-forget boundary needs a red-first test with a hanging sink. Offline or mocked delivery alone cannot prove paint stays unblocked. Keep `the_startup_flush_never_blocks_the_first_frame` as the launch-path guard.

## No legacy or migration scaffolding

- When a migration or refactor completes within a PR, its staging scaffolding must be deleted, not kept: no type aliases where two names point at one type, no re-exports "for compatibility" without a live external consumer, no migration-era vocabulary ("staged", "legacy", "new-style") surviving in names, comments, or test titles.
- Flag any parameter, option type, or constant that has exactly one legal value at every call site. That is ceremony, not configuration.
- Flag exported symbols, fields, and methods with zero non-test consumers. Speculative surface is worse than dead code in security-relevant modules: it implies invariants that do not exist.
- Flag predicates that are provably equivalent to an existing check, and call sites that check the same condition twice under two spellings.

## Comments

- Comments must be short, human-readable, and only where the code cannot say it. Reject comments that restate code, narrate control flow, or describe deleted mechanisms or history.
- Doc comments must describe current behavior, not the history of how it got there.

## Module organization

- One concern per module, named for what it owns. Reject new `utils.rs`/`common.rs` grab-bag modules.
- A new concern lands as a new module beside its siblings (for example `crates/pa-core/src/kernel/manager/` or `crates/pa-core/src/cron/store/`), not as more lines in an already-large orchestration file; when a PR grows such a file, suggest splitting by responsibility.
- When code moves into a new module, its related tests and docs move with it.
- Prefer private modules with an explicitly exported crate API; internals are `pub(crate)`. New traits need doc comments explaining their role and how implementations are expected to behave.

## File size (advisory)

- Flag new or grown Rust files past ~2,000 lines (tests included) as advisory guidance: cite the growth and suggest splitting by responsibility. Size is ADVISORY per the operator's ruling - a soft cap that informs review and never blocks a merge; the repo's `codebase-health` PR check reports the same as warnings only.
- Generated files are exempt from the size rule (see Generated files).

## Dependency direction

- Workspace dependencies flow one way, from the composition root (`pa-cli`) toward lower crates. Flag cycles, reverse edges, or new edges that contradict the Crates table in AGENTS.md.
- `pa-types` is the only shared vocabulary crate: flag domain types duplicated into or re-exported from higher crates.
- A new dependency (workspace edge or third-party crate) is an architectural change: flag it unless the PR states why existing crates cannot host the functionality, commits the regenerated `Cargo.lock` in the same change, and keeps `make deny` clean.
- Flag cross-crate `pub use`/re-exports that widen the public API surface. `pa-tui` renders from wire types and must not link the session engine (its only workspace dependency is `pa-types`); `pa-cli` wires crates and contains no business logic.

## Change hygiene

- One logical change per PR: flag PRs that mix a feature with unrelated lint fixes or refactors, and fixes that do not ride with the change that introduced them.
- If a change forces edits across many crate internals, the crate boundary is what needs fixing: flag that instead of the edits.
- Risky raw APIs route through the in-house wrappers, not new raw call sites: process control (signals/process groups), file locking, permissions, and shell selection go through `pa-core`'s `platform` wall; durable renames go through `rename_onto`; TS-parity hashing (tool-call id normalization) uses `pa-ai`'s in-house `short_hash`; environment-variable resolution goes through its owning module (telemetry overrides in `pa-telemetry`, provider API keys in `pa-ai`), not duplicated ad-hoc parsing. Flag a raw call site that bypasses these walls.

## Tests

- Add a regression test only when it captures meaningful behavior that fails before the fix; do not require one for trivial or documentation-only changes.
- Reject incidental or duplicate coverage and copy/string snapshot assertions that merely restate labels or descriptions; assert text only when the text is the behavior.
- A bug fix that captures meaningful behavior lands with a regression test that fails without the fix (no test required for trivial or documentation-only fixes).
- Tests must wait for observable readiness: flag fixed sleeps, polling loops, and retry-to-green wrappers used as readiness signals. A timeout may bound failure; it must not make the test pass.
- Flag skipped or disabled tests without a reason stated at the test; flag tests that should use isolated ports and temporary paths but do not, and tests that leave shared state unrestored.

## Lint discipline

- Zero-warning posture: the merge gates run clippy at `-D warnings`, so any new warning is a merge blocker. Flag new warnings and any suppression added to hide one.
- Every inline `#[allow(...)]` or lint exception states its reason in a comment next to it; flag unexplained or broad exceptions. Advisory ignores in `deny.toml` need a reason and a review date.
- New lint families land whole-site: enabling a family requires fixing every current site in the same change. Flag partial enablements.

## Branding and wire compatibility

- Brand user-visible docs, CLI help, errors, onboarding, TUI labels and quoted user-facing comments as Prime Agent, not pi/pi-mono/pi-ai or Prime Intellect.
- Preserve byte-compatible TS wire identifiers (`PI_PACKAGE_DIR`, settings/env keys, provider IDs such as `prime-inference`, and `ai.primeintellect.prime-agent` namespaces). Parity beats branding on the wire; require the PR to list preserved identifiers.

## Generated files

- The model catalog is hand-maintained data: `crates/pa-ai/src/models_generated.rs` mirrors the TS `packages/ai/src/models.generated.ts` object literal (no generator, no generated JSON — edit it by hand exactly like its TS source), and the parity fixture `crates/pa-models/tests/fixtures/catalog.v1.json` refreshes with `scripts/generate-catalog-fixture.py` from the real `PrimeIntellect-ai/prime-agent-catalog` snapshot. Flag edits that would reintroduce a generator or hand-tweak the fixture rows.
- Bulk data files are exempt from the size guidance; the exemption's reason is that the file mirrors an upstream data source.
