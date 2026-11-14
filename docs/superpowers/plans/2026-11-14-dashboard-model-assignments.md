# Dashboard Model Assignments Implementation Plan

**Status** — Core dashboard workflows implemented. Checkboxes indicate completed verification for the stated scope.

**Goal** — Let operators browse models by harness, choose compatible reasoning effort, and review and save model assignments where they manage local OpenSpec work.

**Architecture** — Reuse the harness registry and settings resolvers for discovery and validation. Add a reusable picker to the Ink dashboard, a CLI-backed editor for `execution.yaml`, and structured input for the existing managed approval flow. Keep Git and the approval history as the records for durable assignments.

## Design decisions

- A picker limited to launch and retry would be small and useful for unmanaged runs. It would leave durable task and role assignments in external files. A dashboard-only settings store would allow quick changes, but would require a second source of execution settings and new approval and evidence rules. Use the existing plan and approval workflow and share the picker across both kinds of action.
- Open **Models** from Project actions. Start with the project default harness and switch among registered harnesses. Show a searchable list with the accepted selector, display name, source, and supported and default effort when known. The same picker opens from launch, task, and role forms with the relevant harness preselected. The first release fits the existing action menus and keeps the shared **Assignments** view focused on component ownership.
- Show configured, approved, and attempted settings in the relevant feature, task, and session details. Display where a value came from and show a runtime-observed model when recorded. If a saved selector disappears from a catalog, retain it visibly with a status. A catalog result describes the probe context and can change with account, provider, or runtime configuration.
- The implementation harness is change-level. Per-task changes select a model and effort within that harness. A managed implementation default uses the same harness, while review and repair each use their own harness and model. The Models panel browses project defaults. Editing `runner.yaml` can be considered later because it affects other changes and participates in their plan fingerprints.
- An unmanaged launch or retry picker supplies invocation defaults under the existing precedence rules. An explicit task assignment still wins where the resolver gives it precedence. Managed launches and retries use the approved snapshot. Saved attempts keep their original settings, and a retry creates a separate attempt under current rules.

## Harness discovery

| Harness | First release | Follow-up |
| --- | --- | --- |
| Codex | Use the installed `app-server` and paginated `model/list`. Show picker-visible entries by default and use the per-model effort values. Preserve the existing CLI projection, which currently includes hidden entries. | Verify which provider and configuration the probe sees in the planning checkout and how that compares with managed workers. [App Server model catalog](https://learn.chatgpt.com/docs/app-server#list-models-modellist) |
| Claude Code | Show the existing aliases as examples, configured selectors, and manual entry. When the CLI advertises effort, show its accepted values as CLI-wide unless per-model support is known. Preserve omitted effort where the existing resolver permits it. | Test `Query.supportedModels()` from the official Agent SDK with the installed Claude executable and matching configuration, without submitting a prompt. Verify cleanup and which aliases and effort levels the execution CLI accepts. [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) |
| Copilot CLI | The dashboard queries SDK `listModels()` through the installed CLI and falls back to manual entry. The Windows probe returned `auto` on Copilot Free. | Verify Linux and a catalog with multiple selectable models. Evaluate effort independently by checking that worker startup can pass and honor it. [Copilot SDK compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) · [CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) |
| VS Code Copilot | Show configured selectors and manual entry. Point users to the editor's model picker and the custom-agent selector for their profile. The runner adapter currently rejects effort. | Consider an opt-in editor bridge only after testing profile and host identity, consent behavior, and the mapping from enumerated models to selectors accepted by the generated `.agent.md`. [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) · [Custom agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference) |

## Implementation sequence

### Implemented and verified

- [x] Add a CLI-backed preview and confirmation for local task edits. Verify dry-run byte preservation, stale-token rejection, v1 effort spelling, and inheritance reset.
- [x] Add optional Copilot CLI discovery and verify the runner returns the `auto` entry via the installed Windows CLI without an inference request.

### Implemented with verification pending

- [x] Verify the catalog browser and keyboard choices across setup, launch, retry, task edit, and managed approval in Ink. Assert the selected model and effort reach each action.
- [x] Verify stdin-based managed approval end to end, including preview and confirmation.
- [x] Test fresh cache reuse, forced refresh failure with cached results, and cancellation when switching harnesses in `test/dashboard-catalog.test.mjs`.
- [x] Test normalized catalog filtering of hidden and malformed rows and preservation of advertised effort choices and defaults.
- [x] Classify effort availability in discovered catalog rows, deduplicate valid effort selectors, and display when the runner does not support effort.
- [x] Verify the full Windows suite after fixing the dashboard startup and action ordering regressions. Recorded run passed 324 tests with 123 skipped. Subsequent catalog normalization coverage passed in the focused suite.
- [x] Verify Ctrl+R and the refresh notice in the Ink keyboard flow. Layout regression tests also pass at 40, 80, and 96 columns.
- [x] Exercise task assignment preview and confirmation through the executable with `--file -` and `--json`.
- [x] Reject unknown, duplicate, and satisfied task IDs and reject confirmation after the planning HEAD changes.
- [x] Run the normalized Codex catalog against the installed Windows CLI. Verified eight visible selectors with advertised effort choices and defaults.
- [x] Show configured and approved task settings in task details and distinguish requested and observed models in session details. Verify both sets of labels in dashboard view tests.

### 1. Add a typed catalog and read-only Models panel

- [x] Add `src/model-catalog.ts` and adapter support in `src/harnesses/types.ts`. Normalize entries to a selector, label, source (`discovered`, `configured`, `example`, or `saved`), optional visibility, and effort support (`known choices`, `unsupported`, or `unknown`) with optional advertised default. Include catalog status, fetch time, scope, and an actionable failure reason. Validate provider payloads before rendering and deduplicate by selector within the selected harness. Keep adapters responsible for interpreting provider-specific fields.
- [x] Reuse `src/codex.ts` discovery with an explicit working directory. Preserve Codex's CLI text and JSON contracts, including the unqualified v1 array and explicit-agent envelope. Add `models --agent HARNESS --catalog --json` for the normalized format. Keep discovery outside snapshot collection. Scope an in-memory success cache to harness and query context, expose refresh, and identify a previous result as stale if refresh fails. Deduplicate concurrent queries and discard late results after the user switches harnesses.
- [x] Add read-only Models actions and a bounded catalog query. Render a scrollable, searchable model list in Ink with harness switching, effort options, source labels, and refresh. Verify search and harness switching with an Ink keyboard test.
- [x] Open Models on the configured project harness by default. Include query scope, fetch time, and configured model selectors in the typed catalog.
- [x] Verify Codex pagination and both legacy CLI projections alongside picker-visible catalog output using a fake app-server.
- [x] Test paginated results, hidden entries, malformed payloads, missing executables, timeout, cancellation, a failed refresh after success, and a harness switch during a pending request. Verify legacy `models --json` and explicit `models --agent codex --json` shapes with a fake backend.

### 2. Use the picker for setup and unmanaged launch or retry

- [x] Extract a reusable picker from the Models panel and use it in `src/dashboard-ui.tsx` for Copilot setup and for unmanaged launch and retry. Resolve the effective harness before model and effort. Support manual selectors, keep existing configured selections visible, and rerender effort choices when model or harness changes. Use advertised defaults only where the CLI would resolve them, and require a valid explicit choice where approval requires one.
- [x] Move shared launch settings checks out of the dashboard-only prompts into the existing CLI resolution path in `src/cli.ts` as needed. Show the resolved settings per selected task in preview and explain when a task's explicit settings take precedence. Clear an incompatible effort on model change and surface any known incompatibility before confirmation. Where support is unknown, label it and pass through existing adapter validation. Use the existing expected launch identity so a changed resolution requires a new review.
- [x] Test a mixed batch of inherited and explicit task settings, clearing effort when switching models, explicit setup selectors with spaces, managed override rejection, and unchanged dependency and parallelism checks.

### 3. Add durable single-task and bulk assignment edits

- [ ] Add **Edit model and effort** on a local task and **Assign models to tasks** on a feature. Bulk selection uses explicit task IDs and previews one row per changed task with old and new configured values, the effective value when resolvable, and its source. Offer independent keep, set, and inherit controls for model and effort. Inherit clears the field and lets the runner resolver decide the effective value. Show a no-change result when the patch is empty.
- [ ] Add a domain editor in `src/execution-settings.ts` and a CLI entry `execution-settings <change> --file PATCH --dry-run --json`, with `--confirm TOKEN` for apply and `--file -` for dashboard stdin. Use a bounded patch payload shaped as `{ tasks: [{ id, model?, effort? }] }`, with strings for set, `null` for inherit, and omitted fields for keep. Edit the YAML document with the existing `yaml` package, use `reasoningEffort` for v1 and `effort` for v2, and validate the candidate with `assignmentsFrom` and the applicable adapter. Preserve dependencies, parallel permission, schema version, harness, and comments. Reject ambiguous YAML aliases and shared nodes if the edit cannot preserve unrelated assignments. Reuse starter generation when `execution.yaml` is missing.
- [ ] Bind the preview to the planning checkout, current HEAD, plan and runner identity, exact input file bytes, and proposed result. Report the target path and show a narrow diff. On apply, recheck the change, checkout, component authority, task eligibility, file bytes, and preview token under the runner lock. Use `replaceBytes` for the confirmed write and restrict it to the validated planning file. Reject redirected paths, stale previews, active or unacknowledged workers, pending integration or successful repair awaiting integration, completed or archived work, and changes controlled by shared delegation. Store and binding checks belong in the write path, including when the dashboard lacks Store context. Completed tasks remain inspectable and are excluded from editing.
- [ ] Save a working-tree edit. Guide the operator to review and commit it. If execution state exists, guide them to the existing reconcile action, then to managed plan reapproval if applicable. Spell out that current reconciliation marks **all unintegrated attempts** stale, even when one task changes. Keep integrated work and recorded execution history. Let the existing committed-artifact and approval gates block new launches between these steps.
- [ ] Test byte-for-byte dry-run behavior, comments and line endings, v1/v2, clear-to-inherit, mixed bulk edits, missing and completed tasks, dirty working-tree inputs, changed HEAD, a second editor or runner updating state, blocked component authority, path redirection, and failure during Windows file replacement. Test the sequence save → commit → reconcile → reapprove → retry using fixture repositories.

### 4. Compose managed approval settings in the dashboard

- [ ] Add an approval form for implementation defaults, review, repair, and the existing repair-round limit. Seed it from the prior approval when present and provide an explicit choice for missing fields. Display per-task effective settings from `resolveFeatureApprovalSettings`, including how an implementation-default change would affect inherited tasks. Show where an explicit Codex effort must be supplied and how omitted Claude effort resolves in each case.
- [ ] Extend the existing `feature approve` action to accept `--file -` for the reviewed form payload through bounded CLI stdin. Retain `--file SETTINGS`. Reuse `Feature.planPreview`, its OpenSpec validation, and `Feature.approve`, with the expected runner state and approval token checked on confirmation. Keep approval its own operator action after any required commit and reconciliation. Offer copy or export of the settings JSON when useful for CLI review and reuse.
- [ ] Test distinct review and repair harnesses, inherited and explicit task settings, an existing repair budget, stale form or plan previews, uncommitted planning artifacts, a same-plan role update, and rejection of local approval for imported assignments.

### 5. Verify richer discovery and document the operator workflow

- [ ] Prototype Claude discovery and complete Copilot verification for missing runtimes, Linux shutdown, and multi-model accounts. Copilot SDK 1.0.34 and CLI 1.0.112 were verified on Windows with an `auto`-only catalog. Evaluate VS Code discovery only if the profile-scoped manual workflow proves too limiting.
- [ ] Update `docs/dashboard-guide.md` and the CLI reference with the model picker, one-off launch defaults, durable task edits, and managed approval flow. Run `pnpm test`, exercise affected commands with `--json` and `--dry-run`, and run the Ink keyboard flows at narrow and wide terminal sizes. Verify that reopening the dashboard reflects the saved plan and that attempt history distinguishes requested and observed model evidence.

## Release scope

Ship the Models panel and launch picker together. Follow with task assignments and in-dashboard managed approval. After those workflows are in use, the most useful optional additions are filtering tasks by effective model, copying a model and effort pair to selected tasks, and refreshing a single harness catalog. Provider switching, mid-session model edits, cross-harness per-task routing, and cost estimates each need their own execution or evidence contract.
