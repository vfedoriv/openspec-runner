# Store Gap Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Track completion with checkboxes.

**Goal:** Close the four gaps identified in the Store-only implementation review without regressing single-repository operation.

**Architecture:** Validate live Store authority on every non-abort repair integration. Share one case-insensitive artifact policy across task and repair integration, worker history and receipts. Namespace v2 coordinator journals and private checkouts by feature and preserve safe recovery boundaries for existing journals.

**Tech Stack:** TypeScript ESM, Node.js node:test, Git temporary repositories, PowerShell Windows test harness, pnpm.

**Spec:** The four findings in the preceding user-approved review: repair continuation bypasses authority; repair can commit staged planning/runtime artifacts; task integration misses artifact case variants; coordinator operation journals collide across features. Original invariants are recorded in `docs/superpowers/plans/2026-11-19-store-only-multi-repository.md`.

## Global constraints

- All implementation and review subagents use `gpt-6.1-sol` with `low` effort; no nested subagents. Parent coordinates and verifies, and does not implement product changes.
- Work on the user's local `dev` branch. No push. Preserve untracked `.idea/encodings.xml` and `.idea/inspectionProfiles/`.
- Single-repository local operation and version-1 portable records retain their semantics. No dependency updates, generated `dist/` commits, or portable record schema changes.
- Multi-repository planning/configuration/progress/runtime/archive stays in the Store. Code Git metadata may retain existing opaque ownership/worktree registrations.
- Every fix must have a regression observed failing before implementation, then passing. Use real temporary Git repositories and existing fake executable/Windows wrappers.
- No automatic rerun of ambiguous external commands, journal deletion, or silent adoption of another feature's state.
- Use strict existing TypeScript style. Inspect local source only. Mark completed steps in this plan.

## Review focus

1. A repair interrupted before or after commit must not resume under revoked, replaced, dependency-stale or semantically drifted Store authority; abort remains available.
2. Forbidden artifacts staged during checks/conflict resolution must be rejected before any code commit, including case variants and intermediate history.
3. Rejection must preserve transaction evidence and allow explicit recovery; ordinary generated build output outside forbidden roots remains compatible.
4. Two features using identical action/operation/component IDs must have disjoint journals and exact checkouts, including failed and completed retries.
5. Existing unscoped journals must never cause silent external-command replay or cross-feature adoption; v1/local behavior remains tested.

## Execution and verification

Execute tasks sequentially because Tasks 1 and 2 share `src/feature.ts`. Each implementer reads its extracted task brief and constraints, writes a report in this plan's ignored workspace, commits only its files, and returns test evidence. A fresh task reviewer checks spec compliance and quality before the next task. Parent independently checks diffs and runs final verification. The user already authorized plan creation followed by execution; no further handoff confirmation is needed.

Use `node node_modules/typescript/bin/tsc` for focused builds; `node test/helpers/run-tests.mjs <files>` for focused suites; `pnpm with current test` for the final full suite and `pnpm with current pack --dry-run --json` for packaging. The installed pnpm launcher can select its current version without changing `package.json`. On Windows, privileged execution may require the existing `standard-windows-child.ps1` test wrapper. Preserve the existing 600-second four-repository test watchdog.

### Task 1: Enforce live authority during repair recovery

**Files:** Modify `src/feature.ts`; extend `test/store-execution.test.mjs` or create `test/store-repair-authority.test.mjs`; use existing Store feature fixtures.

**Interfaces:** Consume `Runner.assertExecutionAuthority(change: string): void`. No new public CLI or persisted fields. Later Task 2 retains this guard.

- [x] Add regressions for a pending repair transaction followed by assignment revocation and by committed component/shared semantic drift. Continuing must reject before merge/check/commit/state advancement, retaining the transaction and integration HEAD. Include the already-committed-but-not-reconciled recovery path, replacement/dependency staleness where feasible, valid unchanged continuation, and permitted abort under stale authority.
- [x] Build and run the focused regression before changing implementation. Expected: the stale continuation test fails because authority is skipped for existing transactions. Record exact RED result.
- [x] In `Feature.integrate`, call live authority for every non-abort path, including interrupted transactions and already-integrated retries. Preserve identity checks and abort safeguards; do not use `current(s)` to require a clean checkout during conflict recovery.
- [x] Run the affected Store repair and existing feature suites. Expected: new authority regressions and local repair/recovery tests pass.
- [x] Self-review, update these checkboxes, commit with an imperative subject, and report BASE/HEAD, files, RED/GREEN commands/results and limitations.

### Task 2: Apply one artifact policy before integration commits

**Files:** Modify `src/store-submission.ts`, `src/runner.ts`, `src/feature.ts`; extend `test/store-submission.test.mjs`; create `test/store-integration-artifacts.test.mjs` or extend existing Store integration fixtures.

**Interfaces:** Consume existing `assertStoreCodeTree(root, commit)` and `assertStoreCodeHistory(root, base, commit)`. Produce `assertStoreCodeIndex(root: string): void` in `src/store-submission.ts`, sharing the same top-level forbidden-root predicate (`openspec`, `.openspec-runner`, case-insensitive). Other implementation details follow existing adapter conventions.

- [ ] Add regressions for task and repair integration where verification/conflict resolution stages forbidden paths, covering lowercase roots, `OpenSpec`, `.OPENSPEC-RUNNER`, and paths outside the active change. Assert rejection before commit, retained evidence, unchanged HEAD, and no integrated success state. Include a permitted staged implementation file as a positive control.
- [ ] Add focused index helper coverage for deletions, renamed files, case aliases, and forbidden directories already present in the complete staged tree. Existing worker/history rejection must continue to cover intermediate artifacts later removed.
- [ ] Run the reproductions before implementation. Expected: repair accepts a forbidden staged file and the task guard misses a case variant; record RED outputs.
- [ ] Implement the index helper by inspecting the full staged Git tree/path inventory with null-delimited output and the common case-insensitive policy. Apply it after checks and immediately before task/repair commits in Store mode. Validate recovered committed integration history before marking task/repair integrated so crash recovery cannot adopt polluted commits. Preserve local mode's legitimate OpenSpec checkbox commits.
- [ ] Build and run affected Store submission/integration/repair and existing local feature/runner suites. Expected: all regressions pass, local checkbox behavior unchanged. Preserve Task 1's authority guard.
- [ ] Update checkboxes, self-review, commit, and report exact RED/GREEN evidence.

### Task 3: Isolate coordinator journals and checkouts by feature

**Files:** Create `src/coordination-runtime.ts`; modify `src/coordination-operation.ts`, `src/coordination-review.ts`, `src/coordination-archive.ts`, and any directly related acceptance/delivery checkout consumers; create `test/coordination-runtime.test.mjs`; extend relevant coordination/archive tests and `docs/store-only-workflow.md`.

**Interfaces:** Produce a centralized resolver for feature-scoped coordinator paths, e.g. `coordinationRuntimePath({ store, area, operationId, componentId? }): string`. Validate IDs using the manifest version and feature ID. v2 layout: `<Store runtime>/coordination/features/<featureId>/<area>/<operationId>[/<componentId>]`; journal callers append `.json` consistently. Keep the Store-wide mutation lock to serialize canonical branch changes. Keep v1 paths unchanged.

- [ ] Audit and inventory all journal readers/writers, inspection/recovery readers and private checkout paths. Include generic operations, tuple reviews, archives and their receipt-saved paths. All v2 callers must use the same resolver, including `archiveJournalPath`; scope direct generic-operation checkout consumers too.
- [ ] Add failing tests with two features sharing identical action/operation/component IDs: one must not reuse the other's saved data, block on its different input, execute in its checkout, or inspect/recover its archive. Verify same-feature retries retain their identity and interruption guards. Use both a focused real-Git helper reproduction and relevant real coordinator fixtures.
- [ ] Run the regressions before implementation. Expected: the unscoped helper returns feature A's data for feature B or throws an identity conflict; record RED outputs.
- [ ] Implement v2 feature-scoped paths. Treat preexisting unscoped v2 journals conservatively: when a scoped journal is absent and the legacy candidate exists, reject with a specific legacy-journal reconciliation diagnostic rather than automatically rerunning or adopting it. Inspection/recovery must report the same issue. Do not delete/move legacy state automatically. Keep v1 resolution unchanged; scoped state already present remains authoritative for that feature.
- [ ] Document the layout and legacy reconciliation procedure: stop relevant operations, inspect legacy journal ownership and recorded checkout paths against the feature's records, retain a backup, and explicitly relocate only after ownership is established. If identity cannot be established, retain evidence and reconcile manually; no blanket deletion or rerun advice. Explain the conservative block on reused legacy operation IDs.
- [ ] Build and run the new runtime tests and existing coordination acceptance/review/delivery/archive suites. Expected: feature isolation, same-feature recovery, legacy safety and v1 compatibility pass.
- [ ] Update checkboxes, self-review, commit, and report the path inventory and RED/GREEN evidence.

### Task 4: Verify the combined changes and complete review

**Owner:** Parent coordinates verification and a fresh low-effort Sol reviewer; any fixes are delegated to an implementer.

- [ ] Verify each task's diff and report, with a fresh spec-compliance and quality review gate. Fix Important findings through the original implementer, with targeted regression evidence.
- [ ] Run `pnpm with current test` on the combined final source. Expected: zero failures; record actual passes/skips. Confirm the four-repository lifecycle, clone reconstruction, repair, recovery, local mode and archival still pass.
- [ ] Run package dry run, `git diff --check`, inspect the affected CLI preview/status/recovery commands with JSON where applicable, and verify untracked IDE files remain untouched.
- [ ] Dispatch one fresh whole-change review from base `7fb334c` through final implementation HEAD. Delegate any necessary final fixes, then verify those fixes and rerun checks appropriate to changed behavior.
- [ ] Record final evidence and remaining limitations in this plan; leave all completed steps checked and changes committed on local `dev`, without pushing.
