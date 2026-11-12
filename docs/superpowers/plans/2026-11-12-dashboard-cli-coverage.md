# Dashboard CLI coverage implementation plan

**Goal** Let an operator complete the routine OpenSpec Runner workflow in the dashboard, from a numbered task list through integration, review, archival, and summary export.

**Approach** Extend the row actions menu with task-specific forms and confirmation screens. Reuse CLI entry points and domain checks so operations have the same behavior in both interfaces. A command palette that accepts arbitrary CLI arguments would expose more commands quickly, but would make users learn the same flags and would lose the link between a selected row and the operation's target. Keep the command display as a fallback for advanced workflows.

## Coverage audit

| CLI workflow | Dashboard today | Planned coverage |
|---|---|---|
| `init`, `doctor`, `models`, `planning-rules` | Configuration errors in Attention. No setup or diagnostic actions. | Phase 1 adds project initialization and diagnostics from Overview, including when there are no rows. |
| `init-execution`, `validate`, `status`, `feature status` | Status is represented in feature, task, and session details. No starter or validation action. A new change with no execution file can appear only as an error. | Phase 1 adds starter preview/create and explicit validation. Keep details as the normal status view. |
| `launch`, `retry`, `recover`, `attach` | Launch/retry preview and command display. Existing session focus covers part of attach. No task recovery action. | Phase 2 adds confirmed launch/retry/recover and resume instructions when focus is unavailable. |
| `integrate`, `reconcile`, `cleanup` | Command display. Status may suggest integration candidates. | Phase 2 adds exact-task integration, transaction continue/abort, reconciliation, and inspected cleanup. |
| `feature start/adopt`, `feature approve` | Managed state is visible. No start/adopt action. Plan approval preview is disabled. | Phase 3 adds registration and approval from a reviewed settings file. |
| `feature review/fix/integrate/recover`, `feature approve --final`, `feature archive` | Review/fix preview. Final approval/archive previews are disabled. No repair integration or feature-job recovery action. | Phase 3 adds managed job execution, repair integration/recovery, final approval, and archive/resume. |
| Local and shared `summary` | Saved status and some display-only commands. | Phase 1 adds reading saved local summaries. Phase 4 adds refresh, export, publish, and presentation brief, with shared equivalents where supported. |
| `coordination` and `component` | Shared status and assignment evidence when Store context is available. No linked workflow execution. | Phase 4 adds exact record inspection and common component/operator handoffs. Track coordinator administration and delivery workflows as a follow-on. |
| `worker`, `begin`, `report`, their feature equivalents, and `hook` | Session and report evidence. | Keep invocation in the supervised worker protocol. Show saved evidence and supported recovery in the dashboard. |

The local workflow is the first release target. Phase 4 extends it to shared team workflows. CLI automation, scripted inputs, external Git delivery, and manual merge-conflict resolution retain their existing entry points.

## Phase 1. Project actions and planning

**Files** `src/dashboard-actions.ts`, `src/dashboard-action-runner.ts`, `src/dashboard-ui.tsx`, `src/dashboard-reader.ts`, `src/dashboard-types.ts`, and corresponding dashboard tests.

- [ ] Add an Overview project actions entry available with zero rows. Keep `a` on the current selection for row actions. Group longer menus by the operator's workflow and keep unavailable actions visible with their reason.
- [ ] Introduce typed action requests for inspection, checks, and confirmed changes. Resolve the action and target from the current repository, snapshot, and dashboard options. Construct arguments in trusted code and run the packaged CLI with argument arrays. Treat proposed commands, user input, subprocess output, and persisted state as data. Keep display-only commands separate from runnable actions.
- [ ] Add a review screen for changes. Show the operation, checkout, exact target and inputs, and consequential effects. Require explicit confirmation and allow Escape before dispatch. Once dispatched, keep progress visible across refresh and navigation. Give long-running changes a separate process lifecycle from today's 30-second preview. Output truncation must not kill a mutation. Surface uncertain outcomes and refresh state before another attempt. Never automatically retry a state-changing action.
- [ ] Add **Check project**, **List models**, and **Planning guidance** using the existing CLI commands and harness choices. Expose project setup with explicit harness selection, the CLI's Copilot model requirements, and notice that `init` installs or refreshes project skill files.
- [ ] Discover a valid local `tasks.md` without `execution.yaml` as a feature row with a missing-settings blocker and no ready tasks. Add **Preview starter settings** and **Create execution.yaml** using `init-execution`. Refresh after creation and preserve the exclusive-write guarantee if the file appeared after preview. Add **Validate change** as an explicit check that runs OpenSpec. Add **View saved summary** using the inspection mode without creating artifacts.
- [ ] Test keyboard access with an empty repository, cancellation before dispatch, a newly discovered change, a destination collision, and CLI errors shown without losing the selected row. Test forged action arguments, stale rows, duplicate confirmation, and retained focus/diff behavior. Verify that browsing, refresh, `--once`, and `--json` never dispatch actions.

## Phase 2. Local task execution and integration

**Files** Dashboard action, runner, UI, and snapshot modules. Extend `src/cli.ts` or `src/runner.ts` only where an existing operation lacks the precondition or output needed for a reliable confirmation.

- [ ] Add **Launch** and **Retry** to successful previews. Preserve the exact task IDs, harness, base, model, and effort used in preview. Support unmanaged overrides through the CLI's existing options. Review changed plan, resolved settings, checkout, or attempt identity again before dispatch. Keep the latest-plan checks in the runner. Show launched attempts and manual worker commands where the CLI returns them.
- [ ] Add task **Recover preparation** only for the applicable attempt and show that setup may run again. Keep **Focus saved terminal** tied to the inspected attempt, and expose existing resume instructions for manual or unavailable terminals. Session selection must never attach to a newer attempt by accident.
- [ ] Add **Integrate selected tasks** with the editable suggested IDs and inspected integration checkout, head, and attempts. Use separate **Continue integration** and **Abort integration** actions tied to the current transaction. Surface conflicts and failed checks with the worktree path and recovery instructions. Disclose when integration's configured cleanup can also run.
- [ ] Add **Reconcile committed plan** with the changed plan identity and the effect on existing attempts. Use the existing reconciliation checks. Add **Inspect cleanup** for selected tasks and **Inspect all cleanup** when eligible. Show affected worktree paths, terminal effects, and ignored/untracked content warnings. Apply one inspected attempt at a time with the CLI's original scope, attempt ID, and token. Keep already removed and ineligible attempts as result rows. Check the current dry-run lock behavior before labeling it read-only.
- [ ] Where a CLI operation currently addresses only the latest task or transaction, add a narrow expected-identity check inside the runner's existing lock before enabling the corresponding dashboard change. A fresh snapshot alone leaves a race between confirmation and mutation.
- [ ] Test exact launch settings after preview, repeated keypresses, drift between preview and confirmation, manual terminal output, recovery of an interrupted attempt, integration conflict/continue/abort, automatic cleanup results, and stale cleanup token rejection. Verify that closing the UI or reaching an output limit does not silently terminate an in-flight operation or launch it twice.

## Phase 3. Managed feature lifecycle

**Files** Dashboard action and UI modules, `src/feature.ts`, and dashboard/feature tests.

- [ ] Add **Start managed feature** and **Adopt existing work** using the CLI's distinct modes and eligibility checks. Show the difference and require explicit selection.
- [ ] Add **Check plan for approval** with a user-selected settings JSON file. Show the committed plan fingerprint, base, resolved role/task settings, check commands, and repair limit. The current preview runs OpenSpec, so start it as an explicit check with that effect shown before execution. Present its token-bound result and submit approval using the exact file and token. Reopen the review if either changes.
- [ ] Add **Start review**, **Start repair**, and supported job retry using existing job previews. Add repair integration by attempt, continue/abort by transaction, and **Record stopped job** using feature recovery. Show approved roles and the repair round budget where relevant. Surface reports and findings in the selected job's result.
- [ ] Add **Run final checks**, **Approve final result**, **Archive**, and **Resume archive**. Make check execution explicit because final and archive previews can run project commands that write to the integration worktree. Show head, review identity, findings, intended archive scope, and the effects of any repeated checks during confirmation. Require a distinct action for archival. In-progress archival must use the existing recovery path. Delegated local changes must retain the CLI's restrictions on local approval and archival.
- [ ] Test a managed flow from registration to archive in a temporary repository with fake harnesses and OpenSpec. Cover stale approval tokens, changed settings files, blocking findings, repair transactions, interrupted archive, and rejection of locally forbidden delegated operations.

## Phase 4. Summaries and shared workflows

**Files** Dashboard action, runner, UI and coordination modules, `src/summary-cli.ts`, `src/linked-cli.ts`, and corresponding dashboard/CLI tests.

- [ ] Add summary refresh, export, publish, and presentation brief actions to eligible feature/task rows and the shared equivalents. Require a reviewed output directory for exports and briefs. Use the CLI's source digest and expected revision for publish. Preview the destination and report partial outputs if a multi-file write fails.
- [ ] Add Store status and record inspection, component status/inspect, and component import/export/retire to the relevant shared feature or assignment rows. Add coordinator receipt import and submission acceptance to the corresponding evidence rows. Preserve `--store`/`--map` context across refresh and execution. Build arguments from the selected Store, record, and repository identity. Show owner, observed Store revision, expected head, destination, and operation ID as applicable. Pass existing CLI confirmation tokens unchanged and keep operation IDs stable for explicit recovery.
- [ ] Keep Store initialization, approval/assignment/revocation, combined and final review, delivery attestation, shared completion, and shared archive operations available as contextual CLI instructions. Evaluate them as a follow-on after routine handoffs work end to end. Reuse the same confirmation and evidence model when adding them.
- [ ] Test separate Store and worker checkouts, stale Store head, mismatched owner/repository, changed receipt or summary input, retired assignments, and exact revision/operation reuse. Exercise Windows and POSIX fixtures for paths with spaces and the supported process backends.

## Release checks for each phase

- [ ] Run `pnpm run build`, the affected dashboard and CLI tests, and `pnpm test`. Exercise the underlying CLI with `--json` or `--dry-run` where supported.
- [ ] Walk through the new flows interactively in a disposable repository. Check narrow terminal rendering, keyboard-only confirmation and cancellation, and the state after failed or interrupted operations.
- [ ] Update the dashboard guide and command coverage table. Call out which actions run checks, write files, create workers, modify Git state, or delete worktrees. Keep noninteractive dashboard snapshots compatible with existing readers.
