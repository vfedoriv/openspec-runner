---
name: openspec-runner-plan
description: Plan a repository-local feature or linked Store feature with committed task scope and resolved settings, then obtain approval of the exact implementation snapshot.
---

Choose the mode before enrollment. A repository-local managed feature uses `feature start/adopt` below. A linked feature uses `coordination <action> <feature> --store CHECKOUT --map MAP`; an already imported assignment uses the delegated `openspec-runner-component` workflow. Do not enroll a shared contract or delegated assignment as an ordinary local managed feature.

For a linked feature, read the workflow guide at the installed package path reported by `openspec-runner --help` for the complete manifest, machine-map and review/receipt schemas and checked CLI sequence. Prepare normal committed shared OpenSpec artifacts in the Store and committed component plans in their implementation repositories. The manifest names `storeId`, `sharedChange`, `coordinationBranch`, every component repository/change/delivery branch, frozen role/task settings, setup/checks, whole-component accepted/merged dependencies, shared-task milestone mapping, tuple verification and `completion.requireAllMerged: true`. Map every unfinished shared task. An explicit local machine map provides repository IDs and checkout paths; never insert checkout paths into portable records. A Store selector does not route implementation repositories. Use the installed OpenSpec adapter's JSON root/artifact contract; unsupported beta capability diagnostics require an OpenSpec upgrade or corrected Store registration.

Initialize with `coordination init --file MANIFEST --dry-run --json`; the real command requires the expected full Store HEAD and operation identity. Preview shared approval with `coordination approve --dry-run --json`. Present the exact contract revision/fingerprint, component bases/plans, complete task and role settings, dependency gates, checks and repair limits. Record user consent only after the user approved that package, using its returned token, full expected head, record/operation IDs and `--approved-by`. Broad implementation approval covers the approved execution scope; completion and archive scope need their own exact consent. Publish the named coordination branch using an explicit authorized Git handoff. Assign whole components under that shared approval. Future Store checkout changes never silently substitute for a pinned assignment; changed relevant context requires renewed shared approval and reassignment.

For local planning:

Accept a feature idea or an existing change. For a new managed feature choose a repository-local change name and run `openspec-runner feature start <change> --json`; use `feature adopt` for an existing change. Check `feature status` first when resuming. If the user only wants execution metadata or the existing manual workflow, do not enroll the change automatically.

Explore the problem and clarify acceptance criteria before proposing implementation. Read the project's installed OpenSpec exploration/proposal instructions; these are agent workflows, not assumed `openspec explore` or `openspec propose` executables. Use the installed OpenSpec CLI to create a new change when needed. Then use `openspec status --change <change> --json` and `openspec instructions <artifact> --change <change> --json` to create artifacts in dependency order. Read dependencies before writing. Keep numbered checkbox tasks in tasks.md; identifiers such as 2.1 come from checkbox text, never positional JSON task IDs.

Choose one harness for the proposed batch (`codex` or `claude`) and show it once above the review table. Run `openspec-runner planning-rules --agent <harness> --json`, then `openspec-runner models --agent <harness> --json`; use the selected worker harness's rules even when the planning session uses another tool. Propose one review table with task number, description, model, effort or intentional CLI default, dependencies, parallel permission, and a brief reason/rule source. Model IDs and effort vocabularies are harness-specific. Claude initially cannot inherit a calling-session model, and its model examples are not an entitlement list. Only propose parallel: true for independent work that can safely overlap. Omission means false. Dependencies become satisfied upon integration, not worker completion.

Write the complete execution.yaml BEFORE requesting approval: version 2, change-level agent, and every checkbox ID (including completed tasks) mapped to model, effort, dependsOn, and parallel. Do not add task-level harness fields. Version-1 Codex plans remain supported with reasoningEffort. Run `openspec-runner validate <change> --json`.

For managed features, also prepare a JSON settings input outside the change directory:

```json
{
  "implementation": { "harness": "codex", "model": "<resolved-model>", "effort": "high" },
  "review": { "harness": "codex", "model": "<resolved-model>", "effort": "high" },
  "repair": { "harness": "codex", "model": "<resolved-model>", "effort": "high" },
  "maxFixRounds": 2
}
```

Select supported models from discovery, never copy placeholder values. Show all three roles in the approval package. The implementation harness must match the plan; reviewer and repair harnesses may differ. Resolve explicit Codex effort for every task and role. Claude may intentionally omit effort to use its CLI default. Never leave a managed model as `session`. Persist the input somewhere the next coordinating session can read it; its resolved snapshot is recorded durably on approval.

Present scope, acceptance criteria, artifacts, task assignments, reviewer/repair settings, and the two-round repair limit. Ask the user to approve this concrete package. Approval authorizes implementation batches, integration, review, and in-scope repairs. It does not authorize archival yet. Commit only the approved planning files; do not sweep unrelated edits into the commit. Then run `feature approve <change> --file <settings> --dry-run --json`, check that its snapshot matches what was approved, and record that approval with the returned token using `feature approve <change> --file <settings> --confirm <token> --json`. A changed snapshot requires renewed review; never fabricate consent from a token.

Continue in this session using `openspec-runner-coordinate`, or give another session the change name and `feature status` command. The CLI owns lifecycle state; do not edit it directly. If a user rejects or revises the plan, stay in planning. Existing execution state requires `reconcile` after committed content edits, then fresh approval; checkbox updates alone do not invalidate approval. Repair-limit increases or different agent settings also require a reviewed approval package. A later retry can change harness only through a newly approved plan; an existing attempt never changes identity.

For unmanaged changes, preserve explicit per-batch launch/integration approval and manual final delivery/archival. Planning alone never authorizes unmanaged execution.
