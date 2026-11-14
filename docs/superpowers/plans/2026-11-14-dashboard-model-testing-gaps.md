# Dashboard Model Assignment Gaps Testing Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development when executing this plan. Track steps with the checkboxes.

**Goal** — Reproduce the Windows baseline, exercise the untested editor and Ink paths, and collect live harness evidence where the required environments are available.

**Architecture** — Extend existing fixture suites for deterministic checks. Use disposable OpenSpec changes and the installed harnesses for live checks. Record fixture results, live results, and unavailable environments with the command and evidence for each.

**Tech stack** — Node.js 22.13 or newer, pnpm 11.7.0, `node:test`, Git, Ink, Windows and native Linux harnesses.

**Scope** — [Original plan and re-check](2026-11-14-dashboard-model-assignments.md#remaining-gaps-from-the-2026-11-14-re-check). [Companion implementation plan](2026-11-14-dashboard-model-implementation-gaps.md).

## Global constraints

- Start the baseline and existing-guard tests independently of the implementation plan. Run regression tests owned by that plan after its changes land.
- Keep discovery probes prompt-free. Use a disposable worker only for the explicit startup checks. Capture versions, elapsed time, exit status, and relevant model and effort evidence with credentials and sensitive configuration omitted.
- Record an unavailable runtime or account as unverified. Fixture output and a single-model account cannot establish live multi-model support.

## Review focus

- Fixture Git trust, module resolution, and NTFS operations must work in the same test environment (Task 1).
- A previously reviewed write must reject newly introduced lifecycle blockers (Task 2).
- The narrow Ink workflow must preserve review and confirmation across a change of model (Task 3).
- A configured probe and a managed worker can see different provider catalogs (Task 4).
- Successful Copilot discovery must release the probe and its CLI child (Task 5).

### Task 1 — Reproduce the full Windows suite

Files — `package.json`, `test/helpers/run-tests.mjs`, `test/helpers/feature-fixture.mjs`.

- [x] On native Windows with the pinned pnpm available, record `node --version`, `pnpm --version`, and `git --version`. Check that the test temp root supports Git init and commit, NTFS hard links and junctions, and that extensionless fixture executables run in their intended module mode. Keep fixture directories outside the repository's ESM package scope. If Git trust is required, scope it to the disposable fixture root for the test process.
- [x] Run `pnpm run build`, followed by `node test/helpers/run-tests.mjs test/dashboard-catalog.test.mjs test/dashboard-layout.test.mjs test/dashboard-actions.test.mjs test/execution-settings.test.mjs`. Verify all focused cases pass. Investigate setup or timeout failures before treating them as product regressions.
- [x] Run `pnpm test` and record pass, fail, skip, and cancellation counts, plus names and reasons for any relevant skips or failures. The baseline is reproduced when the run exits zero and the relevant Windows and dashboard cases execute. Capture fixture-backed `--json` and `--dry-run` evidence for the changed CLI paths.

### Task 2 — Cover assignment write guards

Files — `test/execution-settings.test.mjs`, `test/helpers/feature-fixture.mjs`. Reuse valid binding fixtures from `test/component.test.mjs` or `test/windows-delegated-context.test.mjs` as appropriate for the platform.

- [ ] Add table-driven cases for YAML aliases, the wrong planning checkout, unacknowledged termination, an in-progress integration transaction, a completed repair awaiting integration, completed and archived feature state, and a valid imported binding without dashboard Store context. Use real schema-valid state for lifecycle cases so assertions reach the intended guard.
- [ ] Assert each case rejects during preview, preserves execution file bytes, and leaves no temporary publication behind. For guards whose state can change after preview, obtain a token before introducing the condition and assert apply rejects. Check the expected blocker in each case so a parser or fixture failure cannot pass the test.
- [x] Run `node test/helpers/run-tests.mjs test/execution-settings.test.mjs`. Check the separate completed implementation attempt regression from the implementation plan in the same run once available.

### Task 3 — Drive picker and confirmation at narrow terminal widths

Files — `test/dashboard-layout.test.mjs`, `test/dashboard-actions.test.mjs`, `test/helpers/feature-fixture.mjs`.

- [x] Reuse the existing Ink keyboard driver at 40 and 80 columns for setup, launch, retry, task edit, and approval. Assert that the selected model, effort, field errors, and confirmation remain reachable at each width and the submitted action receives the expected settings.
- [ ] In a seeded form with a low-effort model, select a model that advertises only high effort. Assert the old effort disappears from the field and submitted payload. Check that deliberately selecting an incompatible effort remains blocked.
- [ ] Drive feature-level bulk editing with two explicit task IDs. Assert preview shows both proposed changes, Escape preserves bytes, and a second preview followed by Enter passes the exact reviewed token and updates only the selected assignments. Reload the dashboard and check the saved values.
- [x] Run `node test/helpers/run-tests.mjs test/dashboard-layout.test.mjs test/dashboard-actions.test.mjs test/execution-settings.test.mjs`; expect a zero exit with the new cases executed.

### Task 4 — Verify Codex context parity and Claude discovery

References — `src/codex.ts`, `src/harnesses/codex.ts`, `src/harnesses/claude.ts`, `src/dashboard-action-runner.ts`.

- [ ] Run `node bin/openspec-runner.js models --agent codex --catalog --json` from a disposable planning checkout and record its reported scope, visible selectors, and effort metadata. Probe again with the managed worker's actual working directory and effective provider and configuration. Check the reported scope each time because the runner CLI can normalize the working directory to the repository root. Use the same app-server discovery request directly in the worker environment if the CLI would resolve back to the planning root. Record parity or attribute differences to the observed context.
- [ ] Run `node bin/openspec-runner.js models --agent claude --catalog --json` using the installed CLI. In a disposable harness, run the official Agent SDK's `Query.supportedModels()` against the same executable and configuration without submitting a prompt. Compare selectors and effort, then close the query and check that it and its children exit within the bounded deadline.
- [ ] Start disposable supervised Claude workers for a discovered selector with advertised effort and with omitted effort. Record CLI acceptance and any reported runtime model and effort. Record startup acceptance separately from values actually observed in the worker.

### Task 5 — Verify native Linux and live Copilot behavior

References — `src/harnesses/copilot-model-probe.ts`, `src/harnesses/copilot.ts`, `src/harnesses/copilot-settings.ts`, `src/harnesses/copilot-vscode.ts`.

- [ ] On native Linux with native Node.js, Copilot CLI, and the optional SDK, run `node bin/openspec-runner.js models --agent copilot --catalog --json`. Repeat normally and interrupt an in-flight probe. Record catalog results and check process snapshots for lingering SDK probe or Copilot CLI children after both shutdown paths.
- [ ] On an authenticated account with multiple selectable models, compare the CLI picker and the runner catalog. Start a disposable worker with a discovered non-`auto` selector. Record the requested selector, startup result, and observed model if reported.
- [ ] Check whether the installed CLI supports explicit effort for worker startup. If it does, test an advertised value directly in a disposable CLI session and record acceptance and evidence that the setting was honored. Assert the current runner still rejects effort through its existing validation. Capture any support finding for a separate execution decision.
- [ ] If the optional VS Code bridge is pursued, test the intended profile and extension host, consent granted and denied, and whether an enumerated model maps to a selector accepted by the generated `.agent.md`. Record the profile and host used for each case.

## Completion evidence

- [ ] Record the Windows suite result and focused test outcomes in the original plan's re-check. For live cases, include the environment, command, outcome, and evidence or exact blocker. Update an open item only when its corresponding acceptance check has run.


## Windows execution notes

- Node v24.21.0, pnpm 11.7.0, Git 2.51.1.windows.1. The native fixture run passed 15 cases covering the five Ink workflows at 40, 80, and 140 columns, YAML alias rejection, and existing assignment guards. Narrow coverage exposed a truncated copy status, which now appears first in the confirmation footer.
- The Windows normalized CLI probes returned eight Codex selectors, five Claude selectors, and only Copilot auto. These were repository-checkout probes. Managed worker comparison, Claude SDK and supervised startup, and Copilot multi-model worker verification remain open.
- Copilot help advertises --reasoning-effort with model-dependent values. Startup and effective effort remain unverified. Native Linux is excluded by request. The optional VS Code bridge was not exercised.

- Full suite exited zero with 346 passed, 123 skipped, and zero failures or cancellations. The final focused run passed all 44 cases. The new lifecycle fixture covers wrong checkout, completed and archiving state, a pending transaction, a successful repair, and uncertain termination. Valid imported binding coverage and complete temporary publication assertions remain open. The seeded effort switch and bulk Ink confirmation remain open.
