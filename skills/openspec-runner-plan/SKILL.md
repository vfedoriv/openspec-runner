---
name: openspec-runner-plan
description: Create or augment repository-local OpenSpec tasks with reviewed Codex model assignments, dependencies, and parallel permissions for openspec-runner.
---

Use the repository's existing OpenSpec workflow. Run `openspec status --change <change> --json` and `openspec instructions <artifact> --change <change> --json` to identify and create missing artifacts in dependency order. Read artifact dependencies before writing. Keep ordinary numbered checkbox tasks in tasks.md; identifiers such as 2.1 come from checkbox text, never positional JSON task IDs.

Run `openspec-runner models --json`. Propose one review table with task number, description, model (session unless specified), optional effort, dependencies, and parallel permission. Model IDs are configurable; choose them based on the user's preferences and the task rather than a fixed routing policy. Only propose parallel: true for independent work that can safely overlap. Omission means false. Dependencies become satisfied upon integration, not worker completion.

After the user reviews assignments, write version: 1 and a tasks mapping in execution.yaml beside tasks.md. Include every checkbox ID, including initially completed tasks. Each entry accepts model, reasoningEffort, dependsOn (quoted task IDs), and parallel. Omitted model inherits the calling session's current model at launch. Explicitly assigning a different model uses its own default effort unless overridden.

Run `openspec-runner validate <change> --json`. Have the planning artifacts committed before launch. Existing execution state requires `openspec-runner reconcile <change>` after content edits; checkbox completion alone does not invalidate the plan. Reconciliation invalidates unintegrated attempts, which require explicit retry. Planning does not authorize launching or integrating a batch.
