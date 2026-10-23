# Store-linked components implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement portable, Git-backed shared feature coordination and delegated component execution across independent clones.

**Architecture:** Keep OpenSpec context resolution, immutable coordination records, coordinator actions, and local component binding in separate modules. Reuse Runner and Feature supervision, integration, review, and repair; never export runtime paths or worker sessions. Operators own clone/fetch/push and PR handoffs.

**Tech Stack:** Strict TypeScript ESM, existing yaml dependency, Node test runner, Git and OpenSpec adapters.

**Spec:** `docs/superpowers/specs/2026-10-04-store-linked-components-design.md`

## Global Constraints

- Records are immutable and versioned with `version: 1`.
- The coordinator is the single author of authoritative assignments, acceptance, revocation, and completion records.
- One component has at most one active assignment.
- Machine checkout mappings are supplied explicitly and are never committed to the Store.
- Mutations require the declared coordination branch and expected head; no implicit network synchronization or force pushes.
- Approval requires explicit consent bound to exact preview tokens; hashes alone are not consent.
- Shared fingerprints normalize task checkbox state and exclude growing coordination records.
- Local resource overlays may change locations/adapters, never approved scope, setup, checks, or model settings.
- Delivery completion and archive status are separate; delegated execution cannot archive or complete a shared feature.
- Existing unmanaged and managed repository-local behavior remains compatible.
- Use test-first behavior coverage, temporary Git repositories and independent clones. Run `pnpm test` and exercise new CLI JSON/dry-run commands.

## Review Focus

- Malformed records, path traversal, symlinks and unsupported versions must fail before side effects (Task 1).
- A replaced Store checkout must not replace pinned execution context (Task 2).
- Duplicate identity with changed payload must fail while byte-identical retry succeeds (Tasks 1 and 3).
- Replaced upstream acceptance must invalidate unmerged dependents and tuple-bound reviews (Task 4).
- Squash/rebase delivery and unrelated changes must compare accepted path blobs, and completion must bind the exact merged tuple (Task 5).

### Task 1: OpenSpec context, shared contracts and durable records

**Files:** Create `src/openspec-context.ts`, `src/coordination-state.ts`, `test/coordination-state.test.mjs`, `test/openspec-context.test.mjs`.

**Interfaces:** Export typed version-1 manifest, approval, assignment, submission and event contracts from coordination-state. Export `CoordinationStore` for reading/writing records and deriving status. Export `resolveContext` and `pinContext` from openspec-context; contracts carry repository identity, source revision, relevant content fingerprint and portable file content, never machine paths. Later tasks consume these exports. Keep APIs object-based and document exact signatures in the implementation report.

- [x] Write tests proving documented OpenSpec root/reference JSON resolution, actionable missing-capability diagnostics, inclusion of active shared contract, deterministic committed-context fingerprints and unrelated Store edits preserving them.
- [x] Write tests for manifest schema, required shared-task mapping, dependency cycle/unknown component rejection, record versions, unsafe IDs/paths/symlinks, immutable identity and exact-byte receipt preservation.
- [x] Run focused tests and observe missing behavior failures.
- [x] Implement adapter using documented OpenSpec JSON root/artifact paths; explicit Store selection does not route implementation repositories. Pin relevant contract, specs/config/guidance at a full Git revision and normalize checkboxes.
- [x] Implement strict manifest/record decoding, stable digest, immutable atomic writes, expected branch/head mutation guards and replay-derived status. Preserve rejected/stale receipts for inspection. Support recoverable record commits/operation identity; do not automatically publish.
- [x] Run focused tests, then `pnpm test`; report signatures and remaining integration points.

### Task 2: Assignment issuance, import and managed execution binding

**Files:** Create `src/coordination.ts`, `src/component.ts`, `test/component.test.mjs`; modify `src/feature-state.ts`, `src/feature.ts`, `src/runner.ts` as needed.

**Interfaces:** Consume Task 1 exports. Export `Coordination` with init/status/approval-preview/approve/assignment-preview/assign/revoke methods and `Component` with inspect/import/status methods, object-based arguments. Component runtime binding is separately versioned under the Git common directory. Reuse exact resolved FeatureApproval role/task settings.

- [x] Test approval binds committed manifest/contract/component plans/base/settings/checks/repair limits, requires matching explicit token and is invalidated by relevant drift.
- [x] Test full-component assignment on correct coordination branch, one active assignment, import into a differently located independent clone, wrong identity/base/plan/history rejection and revocation reporting.
- [x] Test imports freeze role/task/setup/check settings, validate harness capability and materialize read-only context; changed registered Store checkout cannot affect worker/reviewer/repair prompts.
- [x] Observe red tests before implementation.
- [x] Implement coordinator snapshot approval and assignments. Require explicit local repository maps and owner labels. Dependency gates can initially consume replayed milestones, completed in Task 4.
- [x] Implement import preview and idempotent reservation/recovery, bind existing managed local execution to imported approval without deriving settings from session, and append pinned context paths to all worker prompts. Reject scope/settings overlays and block delegated final approval/archive.
- [x] Run focused and full suite; report APIs for next tasks.

### Task 3: Portable submission export and independent acceptance

**Files:** Extend `src/component.ts`, `src/coordination.ts`; create `test/coordination-acceptance.test.mjs`.

**Interfaces:** `Component` gains submission preview/export; `Coordination` gains import-submission/acceptance-preview/accept methods. Consume immutable Task 1 receipt records and Task 2 approval/import binding.

- [x] Test completed export requires integrated canonical tasks, clean integration head, fresh exact-commit review without blocking findings and successful required verification; blocked/failed export needs a concrete reason but no result SHA.
- [x] Test receipts have portable identity/owner/base/full commit/branch/fingerprints/tasks/review/check evidence with no runtime paths or session metadata.
- [x] Test coordinator accepts in a clone with no remote runtime/worktree, checks exact commit availability/repository/base ancestry/planning integrity/not archived/task completion and independently executes required acceptance checks in its own checkout.
- [x] Test stale/revoked assignments, forged review commit, failed checks, changed receipt identity, byte-identical import retries and interruption recovery before/after recorded acceptance.
- [x] Observe red, implement export/import/acceptance previews and token-guarded mutations, then run focused/full suite. Acceptance must not imply merged/delivered.

### Task 4: Dependency milestones and combined review

**Files:** Extend `src/coordination.ts`, `src/coordination-state.ts`; create `test/coordination-review.test.mjs`.

**Interfaces:** Coordinator gains combined verification/review preview/record methods bound to sorted exact component commit tuples, and dependency diagnostics in status/assignment preview.

- [x] Test accepted versus merged dependencies gate assignment separately and assignments record exact satisfying upstream commits.
- [x] Test changed upstream acceptance invalidates affected unmerged downstream acceptance and combined review transitively, while retaining merged historical facts and requiring renewed plans/approval for further implementation.
- [x] Test all components accepted unlocks combined checks/review, blocking findings prevent readiness, and tuple change invalidates readiness/final-review evidence.
- [x] Observe red; implement combined checks in coordinator-owned exact-commit checkouts, explicit review findings tied to tuple, status blocker/next-action and ready-for-delivery/awaiting-merges transitions.
- [x] Run focused and full suite. Shared task checkboxes are changed only by declared merge/final-verification milestones.

### Task 5: Merge evidence, final approval/completion and separate archival

**Files:** Extend `src/coordination.ts`, `src/coordination-state.ts`; create `test/coordination-delivery.test.mjs`.

**Interfaces:** Coordinator gains merge preview/record, final verification/review, completion preview/approve and archive preview/prepare/delivery-record actions.

- [x] Test delivery branch reachability, normal ancestor evidence, explicit squash/rebase operator attestation and PR URL, accepted changed-path blob/deletion comparison allowing unrelated path changes, and mismatch requiring fresh delivered-snapshot review/acceptance.
- [x] Test missing merges block completion, final checks/review bind exact merged tuple, token requires explicit user consent, and tuple changes invalidate final approval.
- [x] Test shared tasks remain incomplete on acceptance and follow approved milestone mappings; completion does not imply archive delivery.
- [x] Test explicit archive scope approval, OpenSpec-produced post-merge archives in component/Store checkouts, interrupted preparation receipts/scope checks and prepared versus canonical-delivered archive status.
- [x] Observe red; implement explicit transitions and recoverable operation identities without fetching/pushing or claiming live hosting-provider PR state.
- [x] Run focused and full suite.

### Task 6: CLI, workflow skills and checked user documentation

**Files:** Modify `src/cli.ts`, `docs/user-guide.md`, `docs/team-workflow.md`, `docs/README.md`, `README.md`, existing planning/coordination skills; add delegated component skill and `test/coordination-cli.test.mjs`.

**Interfaces:** Wire Task 1–5 APIs into `coordination <action>` and `component <action>` with explicit `--store`, feature ID, local map/file arguments, `--expected-head`, `--confirm`, `--dry-run`, `--json`. Export stable help and JSON fields for resolved roots, acceptance/delivery/archive state, blocker and next action.

- [x] Write CLI tests for init/status/approval/assignment/import/export/accept/review/merge/completion/archive happy path and dry-run mutation-free behavior, including independent clones and offline status reconstruction.
- [x] Observe red then wire commands, reject invalid options, and install delegated skill through init.
- [x] Document executable examples with complete manifest/settings/map/receipt/review shapes, explicit Git handoffs and retry/revocation/publication-failure/acceptance/merge/archive recovery paths. Replace proposed claims only where implemented and keep diagrams aligned.
- [x] Exercise checked CLI examples with JSON/dry-run, run `pnpm test` and `pnpm pack --dry-run`, then report requirement coverage.
