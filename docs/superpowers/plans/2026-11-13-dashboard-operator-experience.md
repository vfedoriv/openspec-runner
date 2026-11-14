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

- [x] Add a pure Overview row builder that produces stable rows with a category, label, target ID, and optional existing action ID. Build candidates from recovery entries, lifecycle status, readiness, and current action availability. Treat CLI suggestions as evidence for selecting a target; dispatch only an action reconstructed by the existing allowlist.
- [x] Put unresolved integration and repair conflicts first, then actionable failures, approvals, and eligible integrations. Prefer a single integration item for an exact suggested selection. Show eligible launch suggestions after work that requires a decision. Rank ties by feature name and stable ID.
- [x] Show passive waits in **In progress**, including accepted reports awaiting exit or stop evidence. Show source failures as inspection items. Deduplicate Attention, recovery, and lifecycle signals for the same operation and target. If evidence establishes several distinct issues, keep each separately reachable.
- [x] Enter opens evidence for conflicts, failures, and waits. For eligible reviewable operations, Enter opens the existing form or review flow, including its exact-task selection and explicit confirmation. Recheck the current action and never silently substitute a different attempt. When the list is empty, point to project actions.
- [x] Link the Overview empty state to the guided first-run flow once Phase 4 lands.
- [x] Verify conflict ordering, approval and wait display, and stale action suppression.
- [x] Extend tests for mixed snapshots with ready integration, exact target dispatch, deduplication, and selection changes during refresh.


## 2. Add a feature timeline

**Files** `src/dashboard-types.ts`, `src/dashboard-reader.ts`, `src/dashboard-view.ts`, `src/dashboard-ui.tsx`, and dashboard reader/UI tests.

- [x] Add a **View timeline** action to local feature rows. Group the timeline by change and show task attempts and managed review/repair jobs together. Derive entries for launch, accepted report, recorded worker exit or agent stop, integrated result, plan/final approval, and archive when corresponding records exist.
- [x] Audit recorded timestamps for each event. Use persisted event times where available. Label undated milestones individually with their recorded identity and state. A log line or snapshot collection time cannot establish when a runner transition occurred. Preserve reported and integrated as distinct events. Keep historical attempts selectable even when hidden in Sessions by default.
- [x] Use stable event IDs and deterministic ordering. Start with recent events, allow scrolling to older entries, and keep the selected event anchored during refresh. Enter opens the related attempt, report, integration, or approval evidence. Display source freshness when a cached timeline is retained.
- [x] Test historical retries, equal timestamps, undated reports, recorded exits, and a repair integration. Verify deterministic results after refresh and that a report does not imply integration.
- [x] Exercise keyboard selection retention and evidence navigation during a live refresh.

## 3. Open or copy the exact worktree or log

**Files** `src/dashboard-actions.ts`, `src/dashboard-action-runner.ts`, `src/platform-command.ts` or the existing platform adapter modules, and dashboard action tests.

- [x] Add **Open task worktree**, **Open integration worktree**, **Open saved log**, and context-specific **Copy path** actions. Resolve each path from the exact current session, feature, or recovery entry. Clearly label which worktree will open. Also expose the plain path in details for terminals without clipboard support.
- [x] Re-read saved target identity and path before invoking a platform helper. Check expected file/directory type and canonical location against the corresponding runner worktree or log root. Reject open requests for missing paths, changed attempts, or stale evidence. Retained evidence may still show the original path for reference.
- [x] Use native file and clipboard adapters with argument arrays or stdin. Detect unsupported desktop or remote terminal environments and provide the selectable path. Avoid launching a shell or evaluating stored paths as commands.
- [x] Test spaces and shell metacharacters, missing paths, type and root checks, and unsupported desktop or remote environments.
- [x] Verify redirected paths, changed saved targets, and literal path transport through a test helper.
- [x] Verify native Windows worktree opening in Explorer and exact path copying with the system clipboard.
- [ ] Verify native open and copy on a POSIX desktop with the required helpers installed.

## 4. Guide the first run

**Files** `src/dashboard-reader.ts`, `src/dashboard-actions.ts`, `src/dashboard-view.ts`, `src/dashboard-ui.tsx`, and dashboard tests.

- [x] Derive the first actionable step from the collected evidence. Missing runner config leads to project setup. A configured repository with no numbered change leads to instructions for creating an OpenSpec change and numbered `tasks.md`. A valid task list without `execution.yaml` leads to starter preview and creation. A configured change with invalid artifacts leads to the relevant error or explicit validation.
- [x] Use the existing project setup and feature actions, with the same harness choices, checks, and confirmations. After success, refresh and advance the guidance from the new evidence. Keep the exact failed step and error available for retry.
- [x] Show guidance only when it applies to the actual repository or selected change. Distinguish onboarding from a filter hiding all rows, a failed collection, an explicitly scoped `--change`, and a repository whose work is complete.
- [x] Test guidance for missing and invalid config, missing or scoped changes, malformed tasks, starter creation, and completed work. Existing dashboard action tests verify confirmation before writes.
- [x] Exercise an OpenSpec validation failure through the guided flow.

## 5. Make filters discoverable and easy to reset

**Files** `src/dashboard-ui.tsx`, `src/dashboard-view.ts`, `src/dashboard-layout.ts`, and dashboard UI tests.

- [x] Replace exact-text status, harness, and owner prompts with searchable pickers populated from the selected view's unfiltered rows. Include **Any**, keep a selected value visible if refresh removes its last matching row, and show result counts before applying. Preserve activity search as its own control.
- [x] Store search, filters, sort, and visibility toggles independently per view for the current dashboard session. Restore each view's previous selection when still available. Provide a documented one-key reset for the current view. Persisting preferences across launches can follow if users need it.
- [x] Distinguish **No matching rows** from **No data yet** and show which filters are active. Offer reset on the empty state and explain hidden completed work or older attempts where relevant.
- [x] Verify per-view status filters, one-key reset, narrow keyboard navigation, and choice counts for owners with spaces and disappeared values.
- [x] Exercise refresh while a picker is open and clearing an individual filter with **Any** in the terminal test harness.

## Release sequence and verification

Ship Overview first. Timeline and path actions can follow independently once their evidence and target identities are established. Land first-run guidance and filter improvements together if they share the same empty-state work.

- [x] Run the affected dashboard tests and `pnpm test` for phases 1–3.
- [x] Run the affected dashboard tests and `pnpm test` for phases 4–5. Confirm that `dashboard --once` and `dashboard --json` remain read-only and compatible with existing consumers.
- [x] Walk through four disposable scenarios with the keyboard in standard and narrow terminals. Use a fresh repository, a running feature with a retry, a conflicted integration with a reported worker waiting for exit, and completed work hidden by filters.
- [x] Document Overview, timeline navigation, and path-opening fallbacks in `docs/dashboard-guide.md`.
- [x] Document first-run guidance.
- [x] Document filter changes when they land.

Verified the four live keyboard scenarios in a Windows terminal session at standard width and at 44 columns. Native Windows open and copy were verified with a worktree containing spaces. The available Ubuntu environment lacks the desktop helpers for native POSIX verification.
