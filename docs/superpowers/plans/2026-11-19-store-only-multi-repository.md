# Store-only multi-repository implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task by task. This document authorizes planning only.

**Goal:** Support a feature spanning code repositories with every OpenSpec artifact in a separate Store, while preserving the existing single-repository workflow.

**Architecture:** Separate planning source, implementation Git repository, and machine runtime. Keep local execution as the default; introduce explicit Store-backed component execution using pinned Store plans and independently pinned code commits. Reuse current coordination, dependency, supervision, review, and delivery gates.

**Tech stack:** Strict TypeScript/ESM, Git, existing OpenSpec JSON adapter, YAML, `node:test`; no new runtime dependency proposed.

**Spec:** User requirements and proposed decisions below. No product implementation is included in this change.

## Requirements and proposed decisions

- **Single repository:** Preserve repository-local `openspec/`, existing commands, configuration, fingerprints, and recovery behavior.
- **Multiple code repositories:** Store shared and component plans, `runner.yaml`, `execution.yaml`, specifications, completion updates, coordination records, and archives exclusively in the Store. Do not create, copy, or require these files in code repositories or their worktrees.
- **Proposed layout:** Keep the shared change under `Store/openspec/changes/<feature>/`; place component OpenSpec projects under `Store/components/<component>/openspec/`. Each component root has its own configuration, changes, and canonical specs. This reuses existing OpenSpec project layouts and keeps different repositories' specs/configuration distinct.
- **Explicit routing:** A version-2 linked manifest retains each component's code `repository`, `change`, and `deliveryBranch`, adding `planning: { repository: STORE_ID, openspecRoot: "components/api/openspec" }`. All component planning repositories must identify the selected Store. Machine paths remain in local maps.
- **Runtime:** For Store mode, put bindings, logs, reports, protected plan snapshots, and default worktrees beneath the Store checkout's excluded `.openspec-runner/` directory, partitioned by component and independent code-clone identity. Code repositories receive ordinary Git commits/worktree metadata only; no runner configuration, artifact mirrors, or installed runner skills are required there. Local mode retains its current runtime layout.
- **Compatibility:** Continue reading version-1 linked manifests/records and executing their original local-component semantics. New Store-backed manifests/records use version 2; never silently reinterpret an active assignment or rewrite historical records. Conversion requires idle execution, explicit migration, and fresh approval.
- **Scope:** Keep existing supported shared harnesses, dependency milestones, explicit Git synchronization, PR publication, and consent boundaries. Do not expand harness support as part of this work.

## Current coupling confirmed in source

| Area | Current assumption | Required separation |
|---|---|---|
| `src/plan.ts` | `loadPlan(root, change)` reads config, tasks, and execution settings from one root | Read the Store plan independently of the code checkout |
| `src/runner.ts`, `src/feature.ts` | Launch/review/recovery reload plans from code worktrees; integration commits task checkboxes with code | Use pinned planning inputs; commit code separately from Store progress |
| `src/component.ts`, `src/coordination.ts`, `src/submission.ts` | Import and acceptance require plans at code base/result commits | Validate Store plan identity separately from code ancestry and result evidence |
| `src/coordination-delivery.ts`, `src/coordination-archive.ts` | Delivery checks component plans in code; component archives target code repositories | Verify code against approved Store plans; archive in Store only |
| CLI, doctor, dashboard, summaries, skills | Discover local `openspec/` and code-repository runner state | Resolve the explicit execution context consistently |

The local knowledge graph corroborates the plan-loading call chain but was indexed on 2026-09-15; current source is authoritative.

## Implementation sequence

### 1. Introduce planning and execution contexts — completed

**Files:** Create `src/planning-source.ts`, `src/execution-context.ts`, `test/planning-source.test.mjs`, `test/execution-context.test.mjs`; modify `src/plan.ts`, `src/system.ts`.

- [x] Define `PlanningSource` as a discriminated local/Store source. A Store source binds repository identity, full revision, relative OpenSpec root, change, selected file bytes, and fingerprint; machine checkout paths are resolved separately. Add `loadSourcePlan(source: PlanningSource): Plan` and `resolveExecutionContext(input: ExecutionContextInput): ExecutionContext`. Input contains `implementationRoot` and optional Store mode selection `{ storeRoot, featureId, componentId, assignmentId }`; output separates implementation repository, planning source, runtime directory, and worktree root.
- [x] Reuse existing parsing/fingerprint rules for local mode. Read Store bytes from the approved Git revision through the existing context adapter; validate nested roots, configuration, supplements, path containment, and symlink rejection. OpenSpec validation runs from the selected planning project, never the code checkout.
- [x] Test local output parity, Store plans with no code `openspec/`, different component configurations, invalid/redirected roots, and missing capabilities. Test that independent clones have separate runtimes while linked worktrees share the proper ownership scope. Run build and these tests.

### 2. Version shared planning contracts and imports — completed

**Files:** `src/coordination-state.ts`, `src/coordination.ts`, `src/component.ts`, `src/component-state.ts`, `src/feature-state.ts`, `src/windows-context.ts`; tests in `test/coordination-state.test.mjs`, `test/component.test.mjs`, `test/windows-delegated-context.test.mjs`.

- [x] Add strict version-2 manifest, approval, assignment, submission, and event validation/replay alongside existing version-1 decoders. Bind each approved component plan and its selected Store files separately from the code base SHA; bind every behavior-setting/configuration input, not just model settings.
- [x] Approve committed component plans from their Store roots. Import checks code repository identity/base and approved Store bytes independently; reserve runtime and protected snapshots in the Store execution context. Preserve exact-history, revocation, dependency, consent, and retirement checks.
- [x] Test v1 compatibility, v2 round trips, no absolute paths in portable records, plan/config drift, wrong Store/code identity, stale approval, mixed-version authority rejection, and interrupted import/retirement. Extend Windows protection inventory tests for the new snapshot location. Run build and affected tests.

### 3. Execute and recover without code-local planning files — completed

**Files:** `src/runner.ts`, `src/feature.ts`, `src/worker.ts`, `src/feature-state.ts`, `src/component-retirement.ts`, `src/harnesses/types.ts`, harness adapters and permission helpers; tests in `test/runner.test.mjs`, `test/feature.test.mjs`, `test/worker-startup.test.mjs`, `test/codex-windows-permissions.test.mjs`.

- [x] Thread execution context through launch, worker/begin/report commands, status, retry, review, repair, cleanup, retirement, and expected-state checks. Preserve existing command behavior when no Store context is provided. Keep implementation Git operations on the code repository and planning reads on pinned Store bytes. Bind action/worker identities and locking to both the selected Store assignment and actual code clone; reject conflicting Store authorities for the same active code clone.
- [x] Give workers explicit read-only planning locations and bundled skill instructions; do not depend on skills installed in code repositories. Update harness permissions for narrowly scoped Store runtime/report writes and immutable planning reads, including Windows protection and Claude's restrictions on `.git` paths.
- [x] In Store mode, integrate and verify code without editing `tasks.md`; record successful integration and per-task evidence in Store-owned runtime. Derive dependency satisfaction and submission readiness from integrated evidence. Recover a committed integration from its marker, ancestry, clean tree, and journal, rather than a checkbox in the code commit.
- [x] Test implementation/review/repair, dependency scheduling, task/repair recovery, process ownership, context tampering, and late reports after replacement with no `openspec/` or `.openspec-runner/` created in any code checkout. Preserve existing local merge-plus-checkbox tests. Run build and affected tests.

**Verification:** Build passed; affected execution suites: 89 tests, 88 passed, one skipped, no failures (2026-11-19).

### 4. Make acceptance the durable Store progress boundary — in progress

**Files:** `src/component.ts`, `src/submission.ts`, `src/coordination.ts`, `src/coordination-state.ts`, `src/coordination-delivery.ts`, `src/coordination-review.ts`, `src/coordination-operation.ts`; tests in `test/coordination-acceptance.test.mjs`, `test/coordination-review.test.mjs`, `test/coordination-delivery.test.mjs`.

- [x] Export version-2 per-task integration evidence binding assignment, task, worker commit, integration commit, review, and checks. Validate exact approved task coverage and available code ancestry; do not treat submitted completion booleans alone as proof.
- [x] Replace v2 `committedPlan(codeCommit)` checks with pinned Store-plan validation plus independent code verification. Keep checks running in exact code checkouts; retain combined/final tuple verification and normal/squash/rebase delivery checks.
- [x] Commit coordinator acceptance and component task checkbox updates atomically in the Store after successful independent checks. Local integration can appear ahead of canonical acceptance; shared feature milestones still follow recorded component merges/final verification. Keep fingerprints insensitive to runner-owned checkbox updates.
- [x] Test forged/incomplete evidence, failed checks, Store planning drift, concurrent component submissions, expected-head conflicts, and interruption/retry without duplicate records or partial checkbox updates. Run build and affected tests.

**Verification:** Build passed; affected suites: 127 tests, 36 passed, 91 platform skips, no failures. Independent Store/code clone acceptance with CRLF checkout also passed (2026-11-19).

### 5. Archive all approved planning scopes in the Store

**Files:** `src/coordination-archive.ts`, `src/coordination.ts`, `src/coordination-state.ts`, `src/archive-paths.ts`; tests in `test/coordination-delivery.test.mjs`, `test/archive-paths.test.mjs`.

- [ ] For v2, resolve component and shared archive targets to their approved Store roots and canonical Store branch. Keep Store archive bases distinct from delivered code SHAs. Prepare one ordered Store transaction covering the approved scopes so separate component archive branches cannot lose each other's changes.
- [ ] Retain exact path/content validation, explicit archive consent, interruption inspection/recovery, and canonical-delivery evidence. Archival may change only the selected Store changes, archives, specs, and coordination records; it never creates an archive commit in a code repository.
- [ ] Test three component roots plus the shared root, partial recovery, unrelated Store edits, and final archive delivery with unchanged code branch heads. Keep v1 archive tests. Run build and affected tests.

### 6. Expose both workflows and prove the complete scenario

**Files:** `src/cli.ts`, `src/linked-cli.ts`, `src/doctor.ts`, `src/execution-settings.ts`, `src/dashboard-reader.ts`, dashboard action/collector modules, `src/summary-evidence.ts`, `src/summary-shared.ts`, `docs/examples/linked-feature-inputs.mjs`, relevant runner skills, `README.md`, team guides; create `test/store-only-multi-repo.test.mjs` and extend existing CLI/dashboard/summary tests.

- [ ] Add explicit Store setup via `init --store CHECKOUT --file MANIFEST` to create configuration only in declared Store roots. Pass `--store`, feature, and component identity through Store-backed component execution and generated worker commands. Keep existing local commands unchanged; snapshots/settings changes remain subject to existing approval rules.
- [ ] Make doctor, dashboard, summaries, and action previews resolve the same planning/runtime context. Report the Store plan and mapped code repository separately; absence of code-local OpenSpec configuration is valid in Store mode. Update skills and the checked example builder with both workflows and migration guidance.
- [ ] Add a four-repository CLI acceptance fixture: one Store and three initially OpenSpec-free code repos. Cover approval, independent and dependent assignments, implementation, repair/review, receipt exchange, acceptance, combined checks, all three deliveries, final consent, and Store-only archival. Repeat with an independent machine/clone map; assert no OpenSpec artifacts or runner setup appear in code worktrees and code commits contain implementation changes only.
- [ ] Verify previews with `--dry-run --json` leave all four repositories/runtime trees unchanged; assert status/summary reconstruction from synchronized Store records and retrieved code commits. Run `pnpm test` and `pnpm pack --dry-run` before submission.

## Review focus / completion criteria

- Local workflows and all version-1 fixtures retain their original semantics (tasks 1, 2, 3, 5).
- Neither code commits nor code worktrees acquire OpenSpec plans, configuration, progress, or archives (tasks 3, 5, 6).
- Relevant Store edits invalidate stale approval; unrelated component progress does not (tasks 1, 2, 4).
- Crashes between code integration and Store acceptance recover without false completion or lost updates (tasks 3, 4).
- Multiple clones, Windows path/protection rules, and external runtime permissions preserve ownership/isolation (tasks 1, 2, 3, 6).
