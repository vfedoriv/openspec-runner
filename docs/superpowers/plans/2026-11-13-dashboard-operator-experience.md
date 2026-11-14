# Dashboard operator experience implementation plan

**Goal** Help an operator find what needs attention, understand what changed, and reach the relevant evidence without leaving the dashboard.

**Design** Extend the existing Overview, Features, Sessions, and Attention views. Derive guidance from collected runner and Store evidence and route operations through the existing action dispatcher. Use the current terminal layout and keep noninteractive snapshots compatible.

## Shared behavior

- Preserve explicit review and confirmation for writes. Opening a view, selecting a row, and refreshing never dispatch a write.
- Preserve selection by stable row identity. An action target that disappears or changes must be reviewed again. Stale evidence can be inspected with its age and source shown.
- Keep one primary action per item. Show secondary actions in the existing menu. Prefer short labels and show the exact target in details.
- Support narrow terminals and keyboard-only navigation. Escape returns to the previous view or cancels an input. Keep current global shortcuts available where they do not conflict with an open picker.
- Use additive optional fields for version-1 dashboard snapshots. Keep view preferences out of `--once` and `--json` output and out of repository files.

## 1. Put “Needs you” on Overview

**Files** `src/dashboard-view.ts`, `src/dashboard-ui.tsx`, `src/dashboard-layout.ts`, and dashboard view/UI tests.

- [ ] Add a pure Overview row builder that produces stable rows with a category, label, target ID, and optional existing action ID. Build candidates from recovery entries, lifecycle status, readiness, and current action availability. Treat CLI suggestions as evidence for selecting a target; dispatch only an action reconstructed by the existing allowlist.
- [ ] Put unresolved integration and repair conflicts first, then actionable failures, approvals, and eligible integrations. Prefer a single integration item for an exact suggested selection. Show eligible launch suggestions after work that requires a decision. Rank ties by feature name and stable ID.
- [ ] Show passive waits in **In progress**, including accepted reports awaiting exit or stop evidence. Show source failures as inspection items. Deduplicate Attention, recovery, and lifecycle signals for the same operation and target. If evidence establishes several distinct issues, keep each separately reachable.
- [ ] Enter opens evidence for conflicts, failures, and waits. For eligible reviewable operations, Enter opens the existing form or review flow, including its exact-task selection and explicit confirmation. Recheck the current action and never silently substitute a different attempt. If there is no actionable work, show the reason or link to the first-run guidance from Phase 4.
- [ ] Test a mixed snapshot with a conflict, final approval, ready integration, and a waiting worker. Assert ordering, deduplication, exact target selection, stale-source suppression of executable actions, and no launch or write from opening Overview. Test that changing the selected attempt during refresh invalidates an open action.

## 2. Add a feature timeline

**Files** `src/dashboard-types.ts`, `src/dashboard-reader.ts`, `src/dashboard-view.ts`, `src/dashboard-ui.tsx`, and dashboard reader/UI tests.

- [ ] Add a **View timeline** action to local feature rows. Group the timeline by change and show task attempts and managed review/repair jobs together. Derive entries for launch, accepted report, recorded worker exit or agent stop, integrated result, plan/final approval, and archive when corresponding records exist.
- [ ] Audit recorded timestamps for each event. Use persisted event times where available. Put undated milestones in a labeled section with their recorded identity and state. A log line or snapshot collection time cannot establish when a runner transition occurred. Preserve reported and integrated as distinct events. Keep historical attempts selectable even when hidden in Sessions by default.
- [ ] Use stable event IDs and deterministic ordering. Start with recent events, allow scrolling to older entries, and keep the selected event anchored during refresh. Enter opens the related attempt, report, integration, or approval evidence. Display source freshness when a cached timeline is retained.
- [ ] Test retries, equal timestamps, undated legacy records, a report followed by an exit receipt, and a review/repair cycle. Verify that a refresh does not duplicate events, move the selection, or imply that a worker report completed integration.

## 3. Open or copy the exact worktree or log

**Files** `src/dashboard-actions.ts`, `src/dashboard-action-runner.ts`, `src/platform-command.ts` or the existing platform adapter modules, and dashboard action tests.

- [ ] Add **Open task worktree**, **Open integration worktree**, **Open saved log**, and context-specific **Copy path** actions. Resolve each path from the exact current session, feature, or recovery entry. Clearly label which worktree will open. Also expose the plain path in details for terminals without clipboard support.
- [ ] Re-read saved target identity and path before invoking a platform helper. Check expected file/directory type and canonical location against the corresponding runner worktree or log root. Disable open actions for missing paths, changed attempts, or stale evidence. Retained evidence may still show the original path for reference.
- [ ] Use native file and clipboard adapters with argument arrays or stdin. Detect unsupported desktop or remote terminal environments and provide the selectable path. Avoid launching a shell or evaluating stored paths as commands.
- [ ] Test paths with spaces and shell metacharacters, redirected paths, missing files, stale rows, and unsupported clipboard/open helpers. Use fake adapters in automated tests. Verify manual behavior on supported Windows and POSIX desktop environments.

## 4. Guide the first run

**Files** `src/dashboard-reader.ts`, `src/dashboard-actions.ts`, `src/dashboard-view.ts`, `src/dashboard-ui.tsx`, and dashboard tests.

- [ ] Derive the first actionable step from the collected evidence. Missing runner config leads to project setup. A configured repository with no numbered change leads to instructions for creating an OpenSpec change and numbered `tasks.md`. A valid task list without `execution.yaml` leads to starter preview and creation. A configured change with invalid artifacts leads to the relevant error or explicit validation.
- [ ] Use the existing project setup and feature actions, with the same harness choices, checks, and confirmations. After success, refresh and advance the guidance from the new evidence. Keep the exact failed step and error available for retry.
- [ ] Show guidance only when it applies to the actual repository or selected change. Distinguish onboarding from a filter hiding all rows, a failed collection, an explicitly scoped `--change`, and a repository whose work is complete.
- [ ] Test a fresh repository, missing config, malformed task list, task-only change, completed change, and an OpenSpec validation failure. Verify that setup and starter creation run only after confirmation.

## 5. Make filters discoverable and easy to reset

**Files** `src/dashboard-ui.tsx`, `src/dashboard-view.ts`, `src/dashboard-layout.ts`, and dashboard UI tests.

- [ ] Replace exact-text status, harness, and owner prompts with searchable pickers populated from the selected view's unfiltered rows. Include **Any**, keep a selected value visible if refresh removes its last matching row, and show result counts before applying. Preserve activity search as its own control.
- [ ] Store search, filters, sort, and visibility toggles independently per view for the current dashboard session. Restore each view's previous selection when still available. Provide a documented one-key reset for the current view. Persisting preferences across launches can follow if users need it.
- [ ] Distinguish **No matching rows** from **No data yet** and show which filters are active. Offer reset on the empty state and explain hidden completed work or older attempts where relevant.
- [ ] Test switching views with incompatible status filters, selecting owners with spaces, clearing one filter, resetting all filters in the current view, and refresh while a picker is open. Verify that narrow layouts keep selection, empty-state feedback, and reset instructions readable.

## Release sequence and verification

Ship Overview first. Timeline and path actions can follow independently once their evidence and target identities are established. Land first-run guidance and filter improvements together if they share the same empty-state work.

- [ ] Run the affected dashboard tests and `pnpm test` for each phase. Confirm that `dashboard --once` and `dashboard --json` remain read-only and compatible with existing consumers.
- [ ] Walk through four disposable scenarios with the keyboard in standard and narrow terminals. Use a fresh repository, a running feature with a retry, a conflicted integration with a reported worker waiting for exit, and completed work hidden by filters.
- [ ] Update `docs/dashboard-guide.md` with shortcuts, view examples, path-opening fallbacks, and what each recovery or timeline entry represents.
