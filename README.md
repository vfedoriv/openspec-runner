# openspec-runner

Run explicitly selected OpenSpec checkbox tasks in separate Codex sessions, branches,
and worktrees. Review and integrate results into a dedicated integration branch;
only integration updates task checkboxes and unlocks dependent tasks.

This is a standalone local companion. It does not modify OpenSpec core, existing
skills, schemas, authentication, or Codex permission settings. Requires Node.js
22.13+, Git, Codex, and OpenSpec on PATH. Linux, macOS, and WSL are supported;
native Windows and registry publication are outside v1.

## Local installation

```sh
cd /home/vitaliy/workspace/openspec-runner
npm ci
npm run build
npm link
cd /path/to/your/project
openspec-runner init
```

`init` creates `openspec/runner.yaml` if absent and installs only these project-local
skills under `.agents/skills/`: `openspec-runner-plan`,
`openspec-runner-coordinate`, and `openspec-runner-implement`. Re-running it updates
those three skills and preserves existing configuration and other skills. Commit
the installed skills and planning artifacts so task worktrees can use them.

## Plan and select a batch

Use `$openspec-runner-plan` to create missing artifacts with the normal OpenSpec
status/instructions workflow, or add assignments to existing tasks. Review its
single table of model assignments, efforts, dependencies, and parallel permissions.

```yaml
# openspec/runner.yaml
version: 1
defaultModel: session
maxParallel: 4
worktrees: auto # Worktrunk with required capabilities; otherwise Git
terminal: auto # Herdr when HERDR_ENV=1; otherwise exact manual commands
setup: [] # e.g. [["npm", "ci"]]; use idempotent setup for explicit recovery
verifyIntegration: [] # e.g. [["npm", "test"]]
```

```yaml
# openspec/changes/my-change/execution.yaml
version: 1
tasks:
  "1.1":
    parallel: true
  "1.2":
    model: your-configurable-model-id
    reasoningEffort: high
    parallel: true
  "2.1":
    dependsOn: ["1.1", "1.2"]
    parallel: false
```

Each key must match the number in an ordinary checkbox, for example
`- [ ] 1.1 Implement the first part`. Every checkbox needs an assignment; empty
assignments are valid. Model identifiers are not hard-coded. Omitted model (or
`session`) inherits the calling session's captured model and effort at each batch
launch. An explicitly different model uses its advertised default effort unless
an effort is assigned. Explicit assignments matching the inherited model inherit
its effort. Unknown model defaults require an explicit effort.

`models` queries Codex's app-server `model/list` protocol, including pagination.
The isolated session reader currently supports Codex CLI 0.153.x and the
`state_5.sqlite` threads schema, tested with 0.153.4. It selects only model and
reasoning_effort for `CODEX_THREAD_ID`, using a read-only connection. It never
reads conversation messages, titles, authentication, or unrelated threads.
Unsupported formats fail with an explicit-default instruction. Saved attempts
keep resolved settings even if the caller later switches models.

```sh
openspec-runner models --json
openspec-runner validate my-change --json
openspec-runner status my-change --json
openspec-runner launch my-change --tasks 1.1,1.2 --dry-run --json
openspec-runner launch my-change --tasks 1.1,1.2
# Without calling-session metadata:
openspec-runner launch my-change --tasks 1.1 --default-model MODEL --default-effort high
```

Launch exactly the selected batch. Dependencies must already be integrated;
checkboxes completed in the initial committed baseline also count. All overlapping
tasks must explicitly permit parallel work. The concurrency limit and lock cover
all changes sharing Git's common directory. A completed/failed/blocked report
means the worker has stopped implementing; it must not continue editing afterward.

The initial base defaults to the invoking checkout's committed HEAD; use `--base`
to choose another commit containing identical planning artifacts. Later batches
start from the recorded integration head. Commit current planning artifacts before
launch. Unrelated uncommitted changes remain in the invoking checkout.

## Sessions and reports

Inside Herdr, launch creates a labeled workspace with `--no-focus`, starts Codex
in the returned pane with explicit settings and working directory, then submits the
single-task prompt. Returned workspace, pane, terminal (when supplied), and worker
session IDs are saved. Outside Herdr, launch prints shell-quoted commands to run
once in separate terminals; these reserved attempts consume concurrency slots.
The worker prompt is included in each command.

```sh
openspec-runner attach my-change 1.1
```

Inside the saved Herdr session, attach focuses the existing recognized agent.
Otherwise it prints the exact saved Codex resume command. If a pane was lost in a
server/machine restart, run that resume command explicitly. Reconnecting a client
does not require a new attempt. An attempt without a saved Codex identity cannot
be blindly recreated after ambiguous startup: inspect its saved pane/workspace.
A Herdr idle/done indicator is never a completion report.

Workers register from their assigned worktree:

```sh
openspec-runner begin my-change 1.1 --attempt ATTEMPT_ID
openspec-runner report my-change 1.1 --attempt ATTEMPT_ID --file /tmp/task-report.json
```

`begin` uses `CODEX_THREAD_ID`; `--session` supports explicit identity registration.
Report fields are `attempt`, `task`, `session`, `outcome` (`completed`, `failed`, or
`blocked`), `summary`, and a nonempty `verification` array of evidence strings.
Completed reports also need the full `commit` SHA. The worker must commit its
implementation, keep the worktree clean, and leave shared planning artifacts
unchanged. Store the input report outside the worktree. Reports and coordinator
state live under `<git-common-dir>/openspec-runner`, outside versioned planning.

## Review and integration

```sh
openspec-runner integrate my-change --tasks 1.1,1.2
openspec-runner launch my-change --tasks 2.1
```

Integration verifies the completed report and clean task worktree at the reported
commit, merges sequentially, runs configured checks, updates the checkbox, and
commits in the integration worktree. The invoking checkout remains on its branch.
Inspect the integration path and branch returned by the command. Final delivery of
that branch and OpenSpec archival are separate explicit user actions.

On a conflict, resolve and stage files in the returned integration worktree, then:

```sh
openspec-runner integrate my-change --continue
# Or discard this pending integration's tracked changes:
openspec-runner integrate my-change --abort
```

Failed checks preserve the pending transaction. Fix the cause and continue; checks
run again. Checks must leave no unexplained unstaged or untracked output. Abort
restores the pending transaction's starting tracked state; earlier successful task
integrations and task branches remain. Dependents stay blocked while integration
is pending. If the coordinator crashed just after its merge commit, continue
recognizes that commit and records completion without duplicating it.

## Recovery and changed plans

```sh
openspec-runner recover my-change 1.1
openspec-runner retry my-change 1.1
openspec-runner reconcile my-change
openspec-runner cleanup my-change --tasks 1.1,1.2
```

- `recover` explicitly resumes interrupted preparation before any terminal launch
  was attempted. It reuses the recorded identity/branch/worktree. It may rerun
  unfinished setup commands, which should be idempotent.
- `retry` creates a new retained attempt only for a failed, blocked, or stale task.
  Stop the old worker before reporting blocked/failed; retry never terminates it.
- `reconcile` adopts committed planning edits after all active attempts and pending
  integrations have finished. It conservatively invalidates every unintegrated
  result, preserves satisfied task identities, and copies only planning files into
  the integration worktree. Retry invalidated tasks explicitly. Checkbox completion
  changes alone do not invalidate fingerprints.
- `cleanup` removes only explicitly selected integrated, clean worktrees. Branches
  remain for inspection. It never removes pending/failed worktrees.

Attempts are persisted before external side effects. Ambiguous Herdr creation,
startup, or prompt submission never triggers automatic resubmission. Worktrunk
partial creation is reconciled through Git's worktree list before fallback.
The repository lock records PID and host. After a crashed coordinator, confirm that
owner is gone before explicitly removing `openspec-runner/lock.json`; lock stealing
is deliberately not automatic because it can race another coordinator.

## Verification

```sh
npm test
npm pack --dry-run
```

Tests use temporary repositories and fake executables for Codex, Worktrunk, and
Herdr. The compatibility test uses installed OpenSpec when available (otherwise it
is reported as skipped). Coverage includes model switches and resume consistency,
validation, exclusivity/concurrency, duplicate prevention, setup failures, paths
with spaces, partial worktree creation, returned Herdr IDs/argument forwarding,
blocked startup, stale reports, plan drift, conflicts, failed checks, and interrupted
integration commits.

**Live acceptance still required inside Herdr:** plan two independent tasks and a
dependent task in a disposable repository; launch both independent workers, detach
and reattach the client, review reports, integrate both, then launch the dependent
task. Confirm only integration changes canonical checkboxes. Automated fake-adapter
coverage does not establish this live terminal/authentication behavior.

Adapter references: [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[Worktrunk](https://github.com/max-sixty/worktrunk),
[Herdr automation](https://herdr.dev/docs/agent-automation/), and
[Herdr persistence](https://herdr.dev/docs/persistence-remote/).
