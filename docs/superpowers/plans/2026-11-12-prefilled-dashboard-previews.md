# Prefilled dashboard launch previews

**Goal** Let an operator review or edit the runner's suggested task batch in the dashboard without retyping task IDs.

**Scope** Use the existing launch preview and its result view. Keep the exact-task confirmation step and the current model and effort prompts for unmanaged changes. The existing CLI preview resolves settings and checks whether the submitted batch can launch.

## 1. Derive the launch prefill from the dashboard snapshot

**Files** `src/dashboard-actions.ts`, `test/dashboard-actions.test.mjs`

- [ ] Add tests for a local feature with `nextAction.launch` equal to `["launch", "demo", "--tasks", "1.1,1.2", "--dry-run", "--json"]`. Expect the feature's existing launch preview action to read **Preview suggested batch** and provide `1.1,1.2` as its initial task text.
- [ ] Derive the label and initial text together. Accept a suggestion only for the selected local feature and an available source snapshot. Require the exact launch preview shape, matching change, and unique, valid, ready task IDs belonging to that feature. Use the existing task ID validation rules. Use the manual launch preview with a blank field when a suggestion is absent, stale, invalid, or too long for the editor. Keep single-task launch and retry prefilled with the selected task ID.
- [ ] Add tests for malformed arguments, mismatched changes, duplicate IDs, unknown or no-longer-ready tasks, stale sources, and single-task actions. Verify that the suggested text is used only as editor input and `previewCommand` still constructs the command from the explicitly submitted selection.

## 2. Wire the prefill into the editable task field

**Files** `src/dashboard-ui.tsx`, `test/dashboard-ui.test.mjs`

- [ ] Add a keyboard test that opens the actions menu for a feature with a suggested batch and verifies that selecting the preview opens an editable task field without starting a child process.
- [ ] When the operator opens the action, resolve the selected action and its initial text against the current snapshot. Seed the task field once and keep the operator's edits across refreshes. Support Ctrl+U to clear the task field for replacing the whole batch. Enter submits the displayed selection and Escape cancels through the existing flow.
- [ ] Verify that the unchanged prefill and an edited selection both reach the existing preview with the exact submitted IDs. Test that refresh does not overwrite edited text or silently select a different batch. If a selected task becomes unavailable, surface the existing validation error on submission.
- [ ] Verify that managed previews use approved settings and unmanaged previews still collect model and effort where required. The preview subprocess must receive `--dry-run --json`, with settings and worktree backend shown in the existing result view.

## 3. Update the guide and verify the workflow

**Files** `docs/dashboard-guide.md`

- [ ] Update the launch-preview walkthrough to show accepting, editing, or clearing the suggested IDs and selecting tasks manually when the field opens blank.
- [ ] Run `pnpm run build` and `node --test test/dashboard-actions.test.mjs test/dashboard-ui.test.mjs`, then `pnpm test`.
- [ ] In a disposable repository, open a feature with two ready tasks in the dashboard, preview the suggested batch, then repeat with one task selected. Verify the resolved settings in the CLI preview output and confirm that the operation leaves runner state and Git worktrees unchanged.
