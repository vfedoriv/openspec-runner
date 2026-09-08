# OpenSpec task runner with model selection and parallel sessions

## Summary

Build a standalone TypeScript/Node.js companion package, `openspec-runner`, in `/home/vitaliy/workspace/openspec-runner`.

The agreed workflow is:

1. A wrapper planning skill creates OpenSpec tasks and proposes model assignments and dependencies.
2. You review the assignments and select a batch of ready tasks.
3. Each checkbox runs in a separate Codex session, branch, and worktree.
4. You review results and explicitly integrate selected tasks.
5. Integration unlocks dependent tasks for the next batch.

V1 supports repository-local OpenSpec changes on Linux, macOS, and WSL. Existing OpenSpec skills, commands, and core code remain untouched.

## Extension and configuration

Ship three new skills: planning, batch coordination, and single-task implementation. The package’s installer installs only its own named skills.

The planning skill uses OpenSpec’s existing status and artifact-instruction commands to create missing artifacts, including ordinary numbered checkbox tasks. It also supports adding execution metadata to existing tasks. It proposes models, optional reasoning effort, dependencies, and parallel permission in one review table.

Use two companion-owned files:

- `openspec/runner.yaml`: project execution preferences.
- `execution.yaml` beside the change’s `tasks.md`: per-task assignments.

Illustrative configuration:

```yaml
# openspec/runner.yaml
version: 1
defaultModel: session
maxParallel: 4
worktrees: auto       # Worktrunk when supported; otherwise Git
terminal: auto       # Herdr in its session; otherwise manual commands
setup: []            # Optional commands, represented as argument arrays
verifyIntegration: []
```

```yaml
# <change-directory>/execution.yaml
version: 1
tasks:
  "1.1":
    parallel: false

  "2.1":
    model: gpt-6-astra
    reasoningEffort: high
    dependsOn: ["1.1"]
    parallel: true

  "2.2":
    dependsOn: ["1.1"]
    parallel: true

  "3.1":
    dependsOn: ["2.1", "2.2"]
    parallel: false
```

Model names are configurable identifiers, not a hard-coded routing policy. Omitted model assignments inherit the calling session’s model.

Use checkbox numbers such as `2.1` as task identifiers. OpenSpec’s current JSON task IDs are positional numbers, so they cannot serve as these identifiers.

Validate unique task numbers, manifest coverage, valid dependency references, and an acyclic dependency graph. Record task descriptions and artifact fingerprints at launch; subsequent content changes require reconciliation before affected tasks launch or integrate. Checkbox completion changes do not invalidate the plan.

A custom OpenSpec schema remains a future option. The wrapper and sidecar approach requires no schema fork or new core configuration fields.

## Execution and integration

### Public commands

| Command | Behavior |
|---|---|
| `init` | Create companion configuration and install its skills |
| `models` | Show Codex model identifiers and supported reasoning settings |
| `validate <change>` | Validate task metadata and OpenSpec readiness |
| `status <change>` | Show dependencies, readiness, attempts, results, and session locations |
| `launch <change> --tasks 2.1,2.2` | Launch exactly the selected batch; support `--dry-run` |
| `attach <change> <task>` | Reattach to the task’s existing session |
| `integrate <change> --tasks 2.1,2.2` | Integrate selected results sequentially |
| `retry <change> <task>` | Create an explicitly requested new attempt |
| `cleanup <change> --tasks …` | Remove explicitly selected, integrated worktrees |

Provide JSON output for inspection commands and launch previews. Worker-facing `begin` and `report` commands register session identity and structured outcomes.

### Model resolution

At batch launch, resolve each task’s model from its explicit assignment or the batch’s captured calling-session model. Offer `--default-model` for launches where calling-session metadata is unavailable.

The installed Codex version exposes active model and effort in session metadata; implement this through an isolated, version-tested reader keyed by the calling thread ID. Read only necessary metadata. Unsupported storage formats produce an actionable request for an explicit default.

Inherited tasks also inherit captured reasoning effort unless overridden. An explicitly assigned different model uses its own default effort unless the task specifies one. Persist resolved settings for attachment and recovery.

Launch Codex with explicit model, effort, and working-directory arguments. Existing authentication and permission configuration remain Codex’s responsibility. [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

### Scheduling and worktrees

A task is ready when its prerequisites are integrated. Previously completed tasks in the initial committed baseline count as satisfied.

Tasks may overlap only when every overlapping task explicitly permits parallel execution. A task with `parallel: false` runs alone. Enforce the configured concurrency limit and prevent duplicate launches through a repository-wide lock.

The first launch creates a dedicated integration branch and worktree from the selected base, defaulting to the invoking checkout’s committed HEAD. Require current planning artifacts to be committed. Each batch’s task branches start from the integration branch’s recorded commit.

Use Worktrunk’s noninteractive creation and JSON output, with an explicit base and hooks disabled. Run configured setup commands explicitly. Use direct Git worktrees when Worktrunk is absent or lacks required capabilities; reconcile partial creation before attempting any fallback. [Worktrunk](https://github.com/max-sixty/worktrunk)

### Sessions and completion

Inside Herdr, create one labeled workspace per task, start Codex in its returned pane, and submit the worker prompt. Store returned workspace, pane, terminal, and Codex session identifiers. Preserve the caller’s focus.

Outside Herdr, return exact task launch commands for the user’s terminals. Automatic persistent launching requires running the coordination command inside a Herdr session.

Herdr preserves running panes across client detach and reconnect. After a server or machine restart, use saved session identities to resume interrupted work explicitly. [Herdr persistence](https://herdr.dev/docs/persistence-remote/)

The worker skill implements only its assigned checkbox, performs its stated verification, commits task changes, and reports the commit and verification evidence. Workers do not update shared planning artifacts or advance to another task.

Keep execution state outside versioned planning files, with task-local reports and coordinator-owned state under Git’s common directory. Herdr’s idle/done indicators describe terminal activity; only a valid task report establishes readiness for review.

### Integration and recovery

The integration command requires a completed report and a clean task worktree at the reported commit. It merges selected results sequentially into the dedicated integration worktree, runs configured integration checks, updates the corresponding checkbox, and records completion.

Stop on conflicts or failed checks. Provide `integrate --continue` and `--abort`; dependent tasks stay blocked until integration finishes. Preserve task branches and worktrees for inspection.

Make launch and integration recovery idempotent: persist attempt identity before starting external processes, record merge progress, and reconcile existing resources after interruption. Ambiguous launch outcomes must not automatically create another session.

Final delivery of the integration branch and OpenSpec archival remain explicit user actions.

## Verification and release defaults

Test with temporary Git repositories and fake Codex, Worktrunk, and Herdr executables:

- Model inheritance after a parent model switch, explicit overrides, unsupported metadata, and resume consistency.
- Task numbering, missing assignments, cycles, dependency readiness, exclusive execution, concurrency limits, and duplicate-launch prevention.
- Worktrunk and Git parity, paths containing spaces, setup failures, and partial creation recovery.
- Herdr argument forwarding, returned identifiers, blocked startup, reconnect, and manual fallback.
- Single-task completion reports, stale commits, artifact drift, integration conflicts, failed checks, and interrupted integration.
- Compatibility with unmodified OpenSpec creation, status, validation, and archival behavior.

Perform a real acceptance run: implement two independent tasks concurrently, detach and reattach Herdr, integrate both, then launch a dependent task. Confirm canonical checkbox updates occur only upon integration.

Default to four concurrent tasks, conservative parallel permission, explicit batch launching, and retained worktrees. Ship the companion locally first; registry publication, continuous scheduling, external planning stores, native Windows, and additional agent providers are outside v1.
