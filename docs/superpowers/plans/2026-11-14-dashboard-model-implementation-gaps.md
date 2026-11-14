# Dashboard Model Assignment Gaps Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development when executing this plan. Track steps with the checkboxes.

**Goal** — Close the assignment write and dashboard presentation gaps from the model assignment re-check.

**Architecture** — Reuse runner state, adapter validation, dashboard previews, and existing desktop clipboard transport. Keep provenance and catalog availability display-only and preserve the existing approval and attempt records.

**Tech stack** — TypeScript, Ink, YAML, and `node:test`.

**Scope** — [Original plan and re-check](2026-11-14-dashboard-model-assignments.md#remaining-gaps-from-the-2026-11-14-re-check). [Companion testing plan](2026-11-14-dashboard-model-testing-gaps.md).

## Global constraints

- Preserve v1 `reasoningEffort`, v2 `effort`, the keep/set/inherit patch semantics, and the existing launch and approval precedence.
- Preserve the legacy `models --json` projections, approval identity, committed-plan gates, and persisted attempt history.
- Use Node.js 22.13 or newer. Run `pnpm run build` before focused tests and `pnpm test` before submitting. Add a focused regression with each behavior change.

## Review focus

- An exited worker with a completed result must retain its integration path (Task 1).
- An effort-only edit may have a known harness and a model that will resolve only at launch (Task 2).
- A model can inherit its value while effort comes from the task (Task 3).
- A failed refresh can leave an older result visible with its original fetch time (Task 4).
- Clipboard failure must leave the reviewed payload and its confirmation available (Task 5).

### Task 1 — Block edits while a completed task awaits integration

Files — `src/execution-settings.ts`, `src/runner.ts`, `test/execution-settings.test.mjs`.

- [x] Add a fixture where an unsatisfied task has a latest, completed implementation attempt with a report and an exited worker, before any integration transaction exists. Assert dry-run rejects without writing. Obtain a token before recording completion and assert applying that token also rejects and preserves the file bytes.
- [x] Share the runner's latest-attempt and satisfaction semantics in the editor guard. Check for a completed result awaiting integration inside the existing edit path, which runs under the runner lock on confirmation. Keep already integrated or satisfied work and older superseded attempts out of this check.
- [x] Assert edits remain available after integration for another unfinished task and after an attempt fails without leaving active work. Run `node test/helpers/run-tests.mjs test/execution-settings.test.mjs` after rebuilding.

### Task 2 — Validate effort when the model is inherited

Files — `src/execution-settings.ts`, `src/harnesses/types.ts`, `src/harnesses/claude.ts`, `src/harnesses/codex.ts`, `test/execution-settings.test.mjs`.

- [x] Add effort-only fixtures for a missing model and no concrete project or approved default. Cover accepted v1 Codex and v2 Claude effort, clear to inherit, and rejection of invalid input before write. Add a fixture with a resolvable model to check existing effective values.
- [x] Audit `assignmentsFrom` and the adapter resolvers before adding validation. The parser already checks effort syntax, Claude's adapter also checks identifier format and schema spelling, and Codex checks advertised model-specific effort during launch. Reuse any applicable model-independent adapter checks for changed effort fields even when the effective model is unresolved. Add an optional adapter validation hook only where it expresses an existing rule the parser cannot enforce. Keep per-model checks at the point where a real model is known and make that deferral visible on the preview. Avoid a synthetic model or a hard-coded provider catalog.
- [x] Assert unresolved effort remains marked for validation at launch or approval, with no fabricated effective model or settings. Run the editor, harness, and launch resolver tests with `node test/helpers/run-tests.mjs test/execution-settings.test.mjs test/harness.test.mjs test/runner.test.mjs` after rebuilding.

### Task 3 — Show model and effort provenance independently

Files — `src/execution-settings.ts`, `src/dashboard-action-runner.ts`, `src/dashboard-view.ts`, `test/execution-settings.test.mjs`, `test/dashboard-actions.test.mjs`, `test/dashboard-ui.test.mjs`.

- [x] Add a preview case with an inherited model and explicit effort and one with an explicit model and default effort. Assert the model and effort sources independently.
- [x] Add `modelSource` and `effortSource` to task edit preview rows and managed approval preview rows. Derive them from the actual resolution and inputs, including legacy spelling and `session`, and distinguish task setting, project or approved default, harness default, and unresolved values. Check model-dependent inheritance before attributing effort to an implementation default.
- [x] Summarize available sources in feature, task, and session details. Keep requested and observed model evidence separate. Assert older records with missing provenance and sessions with no observed model remain readable. Run the three listed test files with the repository test harness after rebuilding.

### Task 4 — Show catalog context and the status of retained selectors

Files — `src/model-catalog.ts`, `src/dashboard-catalog.ts`, `src/dashboard-ui.tsx`, `test/dashboard-catalog.test.mjs`, `test/dashboard-layout.test.mjs`.

- [x] Render query scope and fetch time in the Models panel. Assert a failed refresh retains the prior timestamp and cached notice.
- [x] Carry discovery outcome and completeness into the picker presentation. Keep the selector selectable and label whether it was absent from the returned results or could not be checked. For partial, cached, or failed results, qualify the message to match the evidence from that probe. Assert discovered, configured, and saved rows remain deduplicated by selector within the harness.
- [x] Run `node test/helpers/run-tests.mjs test/dashboard-catalog.test.mjs test/dashboard-layout.test.mjs` after rebuilding. Confirm the new metadata leaves space for results at 40 columns.

### Task 5 — Copy reviewed approval settings

Files — `src/dashboard-ui.tsx`, `src/dashboard-action-runner.ts`, `src/dashboard-paths.ts`, `test/dashboard-actions.test.mjs`, `test/dashboard-layout.test.mjs`, `docs/dashboard-guide.md`.

- [x] Add a **Copy settings JSON** control to the managed approval preview. Use the exact reviewed form payload submitted on stdin, never reconstruct it from resolved task settings or display text. Factor the existing clipboard command construction so both paths and JSON use the same platform transport and pass text literally on stdin.
- [x] Assert the copied JSON round-trips through the existing file input, copy never approves or saves anything, and copy leaves the original confirmation valid. On an unavailable or failed clipboard helper, show an error and retain the selectable JSON. Document the control and manual fallback.
- [x] Run the dashboard action and layout tests, then `pnpm test`. Record the exit status and exercise `execution-settings --dry-run --json`, `feature approve --dry-run --json`, and `models --catalog --json` through their fixture-backed entry points.


## Verification results

Native Windows: pnpm test exited 0 with 344 passed and 123 skipped. The seven-file focused run passed all 128 cases, including fixture-backed CLI previews and confirmation. The final assignment guard and detail assertions were rerun separately and passed.
