---
name: openspec-runner-plan
description: Explore a feature idea or existing OpenSpec change, prepare a reviewed execution plan, and coordinate its opt-in managed lifecycle through review, repairs, and archival.
---

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
