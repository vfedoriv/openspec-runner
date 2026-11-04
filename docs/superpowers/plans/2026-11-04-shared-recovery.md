# Shared recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution.

**Goal:** Reuse a component clone after explicit retirement, then archive nested
Store plans without weakening approval or delivery evidence.

**Architecture:** Retirement journals exact local binding/feature/runner bytes
before marking the binding retiring and removing only the snapshotted active
state files. Retired bindings remain tombstones until a different approved
assignment is imported. Archive scope derives its portable OpenSpec directory
from the approved contract; all paths remain relative to the Git repository.

**Tech Stack:** Existing TypeScript/Node ESM, Git, node:test; no dependencies.

**Authority:** User selected explicit retirement followed by nested archival and
authorized remaining design decisions and continuous implementation.

## Global constraints

- Preserve reports, logs, context, worktrees, branches and submission exports.
- Block retirement for active/uncertain workers, integration, or archive work.
- Do not change coordination approval renewal, publication, or Windows delegation.
- Reuse current `dev` checkout; leave changes uncommitted for user review.

## Review focus

1. Late old worker commands cannot mutate replacement state.
2. Partial retirement retains a recoverable snapshot and blocks dispatch.
3. A retry cannot remove changed state or retire a newer assignment.
4. Nested archive roots cannot escape or select a sibling OpenSpec tree.
5. Old root-level receipts remain valid; nested scope survives recovery/replay.

### Task 1: Explicit local retirement

Files: new `src/component-retirement.ts`; modify `src/component-state.ts`,
`src/component.ts`, `src/linked-cli.ts`, and `test/component.test.mjs`.

Interfaces: `Component.retirementPreview({change, assignmentId, owner, reason})`
returns a token-bound local snapshot; `Component.retire({...input, token})`
retains evidence and retires the binding. CLI `component retire` supports
`--dry-run --json` and requires matching assignment/owner/reason/confirmation.

- [x] Add failing replacement, stale token, active/uncertain job, transaction,
  interrupted retirement, immutable evidence and old-worker rejection tests.
- [x] Implement journaled retirement and import of a different approved binding.
- [x] Exercise focused tests on Linux, portable state validation and CLI checks.

### Task 2: Nested Store archival

Files: `src/coordination-archive.ts`, `src/coordination.ts`,
`src/coordination-state.ts`, new shared archive-path helper, archive tests.

Interfaces: derive one exact approved OpenSpec root from pinned contract paths.
Archive targets carry optional `openspecRoot`; absent means `openspec` for old
receipts. Prepare, scope verification, replay and delivery all use that root.

- [x] Add failing nested preparation/delivery/recovery and sibling-scope tests.
- [x] Implement exact-root selection and OpenSpec invocation in that directory's
  parent within the disposable checkout; portable paths retain the prefix.
- [x] Run archive and coordination regression tests.

### Task 3: Documentation and verification

- [x] Document retirement previews, retained evidence, retries and limitations;
  replace the fresh-clone requirement and nested-archive limitation accurately.
- [x] Run full Windows and Linux suites, build, package dry run and diff checks.
- [x] Obtain independent whole-change review and resolve significant findings.

Commits are deferred to the user's next explicit commit request.

Verification: Windows 289 passed / 122 skipped; Linux 394 passed / 20 skipped; zero failures. See `docs/SHARED_RECOVERY_VERIFICATION.md`.
