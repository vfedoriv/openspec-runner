# openspec-runner

`openspec-runner` adds explicit, reviewable parallel execution to an existing
[OpenSpec](https://github.com/Fission-AI/OpenSpec) workflow. It turns selected
checkboxes from an OpenSpec change into isolated Codex sessions, Git branches,
and worktrees, then integrates only the results you approve.

The package installs three project-local agent skills:

| Skill | Where it runs | Responsibility |
|---|---|---|
| `$openspec-runner-plan` | Your planning session | Create or complete normal OpenSpec artifacts, assign models and dependencies, and write `execution.yaml` |
| `$openspec-runner-coordinate` | Your coordinating session | Validate, preview, launch, inspect, retry, and integrate explicitly selected task batches |
| `$openspec-runner-implement` | One isolated worker per task | Implement exactly one checkbox, verify it, commit it, and submit a structured report |

The skills guide Codex; the `openspec-runner` CLI enforces durable state,
dependency, worktree, report, and integration rules. The runner does not replace
OpenSpec, modify OpenSpec core, change Codex authentication or permissions, or
automatically archive a change.

## Contents

- [How it fits into OpenSpec](#how-it-fits-into-openspec)
- [Requirements](#requirements)
- [Install into a target project](#install-into-a-target-project)
- [Quick start](#quick-start)
- [Use the three skills together](#use-the-three-skills-together)
- [Configuration](#configuration)
- [Task lifecycle and integration](#task-lifecycle-and-integration)
- [Sessions, terminals, and worktrees](#sessions-terminals-and-worktrees)
- [Recovery and plan changes](#recovery-and-plan-changes)
- [CLI reference](#cli-reference)
- [State and safety guarantees](#state-and-safety-guarantees)
- [Troubleshooting](#troubleshooting)
- [Developing the runner](#developing-the-runner)

## How it fits into OpenSpec

Keep using OpenSpec to describe a change and produce its normal proposal, design,
specification, and `tasks.md` artifacts. The runner begins where those tasks need
execution metadata and isolated implementation.

The initial OpenSpec artifacts do not need to be committed before using
`$openspec-runner-plan`. The planning skill may complete those artifacts and
will add `execution.yaml`, so review and commit the complete planning result
after the skill finishes. That commit is required before coordination can
preview or launch any task.

```mermaid
flowchart TB
    A[Create an OpenSpec change] --> B[Build proposal, specs, design,<br/>and tasks.md]
    B --> C[Use openspec-runner-plan]
    C --> D[Review execution.yaml<br/>assignments]
    D --> E[Commit planning artifacts]
    E --> F[Use openspec-runner-coordinate]
    F --> G[Launch an approved<br/>ready batch]
    G --> H1[Worker: task 1]
    G --> H2[Worker: task 2]
    H1 --> I[Review reports and commits]
    H2 --> I
    I --> J[Integrate approved results]
    J --> K{More ready tasks?}
    K -- Yes --> F
    K -- No --> L[Deliver integration branch]
    L --> M[Use normal OpenSpec validation<br/>and archival flow]
```

There are two important boundaries:

1. A worker completing a task does **not** complete its canonical OpenSpec
   checkbox. Only successful integration does that.
2. The runner produces a dedicated integration branch. Delivering that branch
   to your main branch and archiving the OpenSpec change remain explicit steps.

The resulting file and state layout is:

```mermaid
flowchart TB
    subgraph V[Versioned in the target project]
        A[openspec/changes/CHANGE/tasks.md]
        B[openspec/changes/CHANGE/execution.yaml]
        C[openspec/runner.yaml]
        D[.agents/skills/openspec-runner-*]
    end

    subgraph R[Runtime state outside versioned planning files]
        E[git-common-dir/openspec-runner]
        F[Attempts and structured reports]
        G[Repository-wide lock]
        E --> F
        E --> G
    end

    subgraph W[Git resources]
        H[Dedicated integration branch and worktree]
        I[One retained branch and temporary worktree per attempt]
    end

    A --> H
    B --> H
    C --> I
    D --> I
    F --> H
```

## Requirements

The target project must have:

- Linux, macOS, or WSL. Native Windows is outside v1.
- Node.js 22.13 or newer.
- Git and a Git repository.
- OpenSpec installed and initialized in the project.
- Codex CLI installed, authenticated, and available on `PATH`.
- The planning artifacts committed before the first launch.

Optional integrations:

- [Worktrunk](https://github.com/max-sixty/worktrunk) for worktree creation. With
  `worktrees: auto`, the runner uses it only when the required capabilities are
  available and otherwise falls back to Git worktrees.
- [Herdr](https://herdr.dev/docs/agent-automation/) for automatic persistent
  terminal sessions. With `terminal: auto`, it is used when `HERDR_ENV=1`;
  otherwise the runner prints exact commands for separate terminals.

Check the required tools before installation:

```sh
node --version
git --version
openspec --version
codex --version
```

## Install into a target project

Installation has two parts: make the CLI available, then run `init` in each
target project to install the project-local skills and configuration.

### 1. Build and link the CLI

This repository currently ships as a local companion rather than a registry
package. From the `openspec-runner` checkout:

```sh
cd /path/to/openspec-runner
pnpm install --frozen-lockfile
pnpm run build
pnpm add --global .
```

`pnpm add --global .` exposes the `openspec-runner` executable through your pnpm
global binary directory. Confirm that directory is on `PATH`:

```sh
openspec-runner --help
```

If you do not want a global install, add the local checkout to the target project
instead:

```sh
cd /path/to/target-project
pnpm add --save-dev /path/to/openspec-runner
pnpm exec openspec-runner --help
```

Use `pnpm exec openspec-runner` in place of `openspec-runner` below when using this
local dependency option.

### 2. Initialize the target project

Run `init` from anywhere inside the target Git repository:

```sh
cd /path/to/target-project
openspec-runner init
```

It creates this project-local installation:

```text
target-project/
├── .agents/
│   └── skills/
│       ├── openspec-runner-plan/SKILL.md
│       ├── openspec-runner-coordinate/SKILL.md
│       └── openspec-runner-implement/SKILL.md
└── openspec/
    └── runner.yaml
```

`init` is safe to rerun after rebuilding or upgrading the runner:

- It updates only the three runner-owned `SKILL.md` files.
- It does not remove or replace unrelated project skills.
- It creates `openspec/runner.yaml` only when absent, preserving existing runner
  configuration.
- It does not initialize OpenSpec or create an OpenSpec change.

Review and commit the installed files so every task worktree receives the same
skills and configuration:

```sh
git add .agents/skills/openspec-runner-* openspec/runner.yaml
git commit -m "Install OpenSpec runner skills"
```

After upgrading this checkout, rebuild, rerun `openspec-runner init` in the
target project, review the skill changes, and commit them.

## Quick start

Assume an existing OpenSpec change named `user-auth`.

### 1. Plan the execution

In your main Codex session, ask it to use the planning skill:

```text
Use $openspec-runner-plan for the user-auth change. Complete any missing OpenSpec
artifacts, then propose task dependencies, model assignments, effort, and safe
parallel groups. Do not launch anything yet.
```

Review the proposed table. After approval, the skill writes
`openspec/changes/user-auth/execution.yaml` beside `tasks.md`, validates the
plan, and asks you to commit the planning artifacts. You may start this step
with uncommitted proposal, design, specification, or `tasks.md` files; commit
them together with `execution.yaml` after planning finishes and before starting
step 2.

### 2. Inspect and preview a ready batch

```text
Use $openspec-runner-coordinate for user-auth. Show ready tasks and preview tasks
1.1 and 1.2. Do not launch until I approve the preview.
```

The coordinating session runs the equivalent of:

```sh
openspec-runner status user-auth --json
openspec-runner launch user-auth --tasks 1.1,1.2 --dry-run --json
```

The preview resolves the base commit, dependencies, parallel permission, model,
and reasoning effort before creating resources.

### 3. Launch the approved tasks

After reviewing the preview, tell the coordinating session to launch that exact
batch. It runs:

```sh
openspec-runner launch user-auth --tasks 1.1,1.2
```

Inside Herdr, each task starts in its own persistent workspace. Outside Herdr,
the command prints one shell-quoted Codex command per task; run each command once
in a separate terminal. Reserved attempts already consume concurrency slots, so
do not rerun `launch` just because a terminal has not started yet.

### 4. Review and integrate

Each worker uses `$openspec-runner-implement` through the runner-generated
prompt. It implements one checkbox, verifies and commits it, then submits a
structured report. Back in the coordinating session:

```sh
openspec-runner status user-auth --json
openspec-runner integrate user-auth --tasks 1.1,1.2
```

Review the report, verification evidence, commit, and worktree before approving
integration. Successful integration merges tasks sequentially, runs configured
checks, updates the corresponding checkboxes, and commits those updates in the
dedicated integration worktree.

### 5. Continue with newly ready tasks

Dependencies are satisfied only after integration. If task `2.1` depends on
both previous tasks:

```sh
openspec-runner launch user-auth --tasks 2.1 --dry-run --json
openspec-runner launch user-auth --tasks 2.1
openspec-runner integrate user-auth --tasks 2.1
```

Repeat until complete, then explicitly deliver the returned integration branch
and use your normal OpenSpec validation and archival process.

## Use the three skills together

### Planning skill: `$openspec-runner-plan`

Use this while creating a change or adding runner metadata to an existing change.
It:

1. Uses the repository's existing `openspec status` and artifact-instruction
   workflow to create missing artifacts in dependency order.
2. Keeps standard numbered checkboxes in `tasks.md`.
3. Queries `openspec-runner models --json` instead of assuming model IDs.
4. Presents one review table with task number, description, model, optional
   reasoning effort, dependencies, and parallel permission.
5. Writes `execution.yaml` after review, includes every checkbox, and runs
   `openspec-runner validate <change> --json`.

Task identity comes from the number in the checkbox text:

```markdown
- [ ] 1.1 Add the token verifier
- [ ] 1.2 Add the session repository
- [ ] 2.1 Wire authentication into the API
```

Do not use OpenSpec's positional JSON task IDs as runner identifiers. Every
checkbox must have an entry in `execution.yaml`; an empty assignment is valid.

Planning does not authorize a launch. The OpenSpec artifacts may be uncommitted
when planning starts. After planning finishes, commit `tasks.md`,
`execution.yaml`, and every other changed OpenSpec artifact before moving to
coordination.

### Coordination skill: `$openspec-runner-coordinate`

Use one coordinating session to own the batch lifecycle. It:

- Shows status and ready tasks before launch.
- Previews the exact selected batch with `--dry-run --json`.
- Launches only that batch; it never starts a continuous scheduler.
- Uses `attach` for an existing worker instead of creating duplicates.
- Treats structured worker reports, not terminal idle indicators, as completion.
- Integrates only results selected after review.
- Stops on conflicts or failed checks and uses explicit continue/abort recovery.
- Retains old attempts and branches unless eligible worktrees are explicitly
  cleaned up.

A useful prompt for later batches is:

```text
Use $openspec-runner-coordinate for user-auth. Inspect current status, show the
reports for completed workers, and propose the next dependency-ready batch. Wait
for my choice before integrating or launching.
```

### Implementation skill: `$openspec-runner-implement`

Normally you do not invoke this yourself. The runner includes it in the
single-task prompt sent to every worker. A worker must:

1. Register its actual Codex identity from its assigned worktree with `begin`.
2. Read the change artifacts and implement only its assigned checkbox.
3. Leave `tasks.md`, `execution.yaml`, `runner.yaml`, and other shared
   planning artifacts unchanged.
4. Perform task-specific verification and commit the implementation.
5. Keep a completed worktree clean at the reported commit.
6. Write its report outside the worktree and submit it with `report`.
7. Stop after reporting instead of continuing to another checkbox.

The runner-generated prompt supplies the change, task number, and attempt ID. The
worker-facing sequence is conceptually:

```sh
openspec-runner begin user-auth 1.1 --attempt ATTEMPT_ID
# implement only task 1.1, verify, and commit
openspec-runner report user-auth 1.1 \
  --attempt ATTEMPT_ID \
  --file /absolute/path/outside/worktree/task-report.json
```

A completed report has this shape:

```json
{
  "attempt": "supplied-attempt-id",
  "task": "1.1",
  "session": "actual-CODEX_THREAD_ID",
  "outcome": "completed",
  "commit": "full-HEAD-commit-SHA",
  "summary": "Added token verification and covered rejection paths",
  "verification": ["pnpm test -- token-verifier: 8 tests passed"]
}
```

`outcome` may be `completed`, `failed`, or `blocked`. Verification must be
a nonempty array of concrete evidence. Completed reports require the full commit
SHA. A blocked or failed worker has stopped implementing; start a new attempt
only with explicit `retry`.

### Skill handoff sequence

```mermaid
sequenceDiagram
    actor U as User
    participant P as Planning session
    participant C as Coordinating session
    participant R as openspec-runner
    participant W as Isolated worker

    U->>P: Use openspec-runner-plan
    P->>U: Review assignments and dependencies
    U->>P: Approve execution.yaml
    P->>R: validate change
    U->>C: Use openspec-runner-coordinate
    C->>R: status and dry-run
    R-->>C: Ready tasks and resolved settings
    U->>C: Approve exact batch
    C->>R: launch selected tasks
    R->>W: Single-task prompt and isolated worktree
    W->>R: begin with worker identity
    W->>W: Implement, verify, and commit
    W->>R: Structured report
    R-->>C: Result available for review
    U->>C: Approve selected integration
    C->>R: integrate selected tasks
    R->>R: Merge, verify, check checkbox, commit
    R-->>C: New integration head and ready tasks
```

## Configuration

### Project configuration: `openspec/runner.yaml`

`init` creates:

```yaml
version: 1
defaultModel: session
maxParallel: 4
worktrees: auto
terminal: auto
cleanup: automatic
setup: []
verifyIntegration: []
```

| Field | Meaning |
|---|---|
| `version` | Configuration schema version; currently `1` |
| `defaultModel` | `session` to inherit the coordinating Codex session, or an explicit model identifier |
| `maxParallel` | Repository-wide maximum active/reserved task attempts |
| `worktrees` | `auto` uses compatible Worktrunk when available, otherwise Git |
| `terminal` | `auto` uses Herdr inside Herdr, otherwise returns manual commands |
| `cleanup` | `automatic` (default, including existing configs) cleans successful batches and completed changes; `manual` retains terminals/worktrees until explicit cleanup |
| `setup` | Idempotent argument-array commands run while preparing task worktrees |
| `verifyIntegration` | Argument-array commands run after merging into the integration worktree |

For example:

```yaml
version: 1
defaultModel: session
maxParallel: 3
worktrees: auto
terminal: auto
cleanup: automatic
setup:
  - ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]
verifyIntegration:
  - ["pnpm", "test"]
  - ["pnpm", "run", "build"]
```

Commands are argument arrays, not shell strings. Keep `setup` idempotent because
recovery can explicitly rerun unfinished setup. Integration checks must not leave
unexplained unstaged or untracked files.

### Per-change assignments: `execution.yaml`

Place `execution.yaml` beside the change's `tasks.md`:

```yaml
version: 1
tasks:
  "1.1":
    parallel: true
  "1.2":
    model: session
    reasoningEffort: high
    parallel: true
  "2.1":
    dependsOn: ["1.1", "1.2"]
    parallel: false
```

| Field | Meaning |
|---|---|
| `model` | Model identifier, or `session`; omission also inherits the launch session |
| `reasoningEffort` | Optional effort supported by the selected model |
| `dependsOn` | Task numbers that must be integrated before launch |
| `parallel` | Whether the task may overlap other explicitly parallel tasks; omission is `false` |

Dependencies must reference existing tasks and the graph must be acyclic.
Previously completed checkboxes in the initial committed baseline count as
satisfied.

### Model and effort resolution

Inspect currently advertised Codex models with:

```sh
openspec-runner models --json
```

Model IDs are configurable and not hard-coded by the skills. At batch launch:

- An omitted model or `session` inherits the calling session's captured model
  and reasoning effort.
- An explicitly different model uses its advertised default effort unless
  `reasoningEffort` is assigned.
- An explicit assignment matching the inherited model inherits its effort.
- If calling-session metadata is unavailable, supply explicit defaults:

```sh
openspec-runner launch user-auth --tasks 1.1 \
  --default-model MODEL_ID \
  --default-effort high
```

The isolated metadata reader currently supports Codex CLI 0.153.x and the
`state_5.sqlite` threads schema, tested with 0.153.4. It selects only `model`
and `reasoning_effort` for `CODEX_THREAD_ID` through a read-only connection;
it does not read messages, titles, authentication, or unrelated threads.
Unsupported formats fail with an explicit-default instruction. Resolved settings
are saved with attempts, so later model switches do not alter resume behavior.

## Task lifecycle and integration

```mermaid
stateDiagram-v2
    [*] --> Planned
    Planned --> Ready: dependencies integrated
    Planned --> Waiting: dependency incomplete
    Waiting --> Ready: dependency integrated
    Ready --> Preparing: launch selected task
    Preparing --> Running: worker begins
    Preparing --> Recoverable: preparation interrupted
    Recoverable --> Preparing: recover
    Running --> Reported: completed report
    Running --> Failed: failed report
    Running --> Blocked: blocked report
    Reported --> Integrating: user approves
    Integrating --> Integrated: merge and checks succeed
    Integrating --> Pending: conflict or failed check
    Pending --> Integrating: continue
    Pending --> Reported: abort
    Failed --> Ready: explicit retry
    Blocked --> Ready: explicit retry
    Integrated --> [*]
```

### Readiness and parallelism

A task is ready only when all dependencies are integrated. Completion alone does
not unlock dependents. Launch accepts exactly the comma-separated task numbers
you select and does not automatically fill unused capacity.

Overlapping tasks may run together only when every overlapping task has
`parallel: true`. A task with `parallel: false` runs alone. `maxParallel`
and the repository lock cover all changes sharing the Git common directory.

### Base and branch behavior

The first launch creates a dedicated integration branch and worktree. Its base is
the invoking checkout's committed `HEAD` unless `--base REF` is supplied:

```sh
openspec-runner launch user-auth --tasks 1.1 --base origin/main
```

The selected base must contain identical planning artifacts. Later batches start
from the recorded integration head. Unrelated uncommitted changes in the invoking
checkout stay there and are not included.

### Integration behavior

Before merging a result, the runner verifies:

- The report belongs to the current attempt and task.
- The reported commit is the task worktree's current commit.
- The task worktree is clean.
- Planning artifacts still match their recorded fingerprints.

It merges selected results sequentially, runs `verifyIntegration`, changes only
the integrated tasks' checkboxes, and commits in the integration worktree. The
invoking checkout stays on its original branch.

If a merge conflicts or a check fails, the transaction remains pending and
dependents stay blocked. Inspect the returned integration path. Resolve and stage
conflicts, or fix the failed check, then run:

```sh
openspec-runner integrate user-auth --continue
```

To discard the pending transaction's tracked changes:

```sh
openspec-runner integrate user-auth --abort
```

Abort restores the transaction's starting tracked state. Earlier integrations,
task branches, and task worktrees remain. If the coordinator crashed immediately
after its merge commit, `--continue` recognizes that commit without duplicating
it.

## Sessions, terminals, and worktrees

### Inside Herdr

For every task, the runner creates a labeled workspace without changing focus,
starts a supervised `codex exec` worker in the returned pane with explicit settings
and working directory. Workspace, pane, terminal, and worker session
IDs are saved when available.

```sh
openspec-runner attach user-auth 1.1
```

`attach` focuses the saved agent. Herdr preserves panes across client detach and
reconnect. A server or machine restart may require the exact saved Codex resume
command. Herdr idle/done indicators describe terminal activity, not task
completion.

### Outside Herdr

`launch` returns exact commands to run once in separate terminals. Each command
includes the worker prompt and working directory. Do not replace it with an
unrequested background process or invoke it twice. `attach` prints the saved
resume command instead of focusing a pane.

An attempt without a saved Codex identity cannot be recreated blindly after an
ambiguous startup. Inspect its saved workspace/pane or explicitly recover the
appropriate lifecycle stage.

### Worktree and terminal cleanup

With `cleanup: automatic` (the default for new and existing configuration), cleanup
runs after each successful integration batch. When every planned task is satisfied,
a second sweep considers all recorded attempts, including obsolete failed/blocked
retries. Conflicts and failed checks retain the batch's worktrees for recovery.
The integration worktree stays available for explicit branch delivery and archival.

New workers use supervised `codex exec`: after an accepted final report they end
their turn, exit, and the supervisor records the actual exit. Sessions persist in
Codex and runner logs live under the Git common directory's `openspec-runner/logs`.
Report acceptance alone is not proof of exit. A worker that exits without an
accepted report is marked failed for explicit retry. No automatic process killing
or guessed terminal input is used.

Before removal, cleanup closes the verified runner-owned Herdr pane and saves
available scrollback. It checks pane identity and foreground activity; on Linux
it also checks shell descendants for background jobs. Unsupported inspection or
uncertain identity leaves a pending action. Close manually opened terminals
yourself before confirming their worktree removal.

Dirty, locked, or changed worktrees require approval. The interactive CLI asks
for each candidate; JSON/unattended calls return `confirmation-required` with
reasons, changed paths, and an approval token for the coordinator to present to
the user. No reply means keep. Approval covers only that attempt and inspected
state; changed files, HEAD, lock, or terminal activity invalidate it. Main,
invoking, integration, active, and unrelated worktrees are protected. Ignored
build/dependency files disappear with the removed directory. Branches, commits,
reports, and session identities remain.

Inspect or retry cleanup, including after archival in the main checkout:

```sh
openspec-runner cleanup user-auth --tasks 1.1,1.2
openspec-runner cleanup user-auth --all --dry-run --json
openspec-runner cleanup user-auth --all
# After the user approves one reviewed candidate:
openspec-runner cleanup user-auth --all --attempt ATTEMPT_ID --confirm TOKEN --json
```

`--all` requires proof that all planned tasks are satisfied and no attempts are
active. Cleanup failures are reported separately and never turn successful
integration into failure. Set `cleanup: manual` to retain terminals/worktrees
until explicit cleanup; workers still exit after reporting. `attach` returns
inspection details for finished workers instead of attempting to resume them
in removed directories. Old interactive sessions require review before cleanup.

## Recovery and plan changes

### Interrupted preparation

Attempts are persisted before external worktree, setup, or terminal side effects.
If preparation was interrupted before terminal launch was attempted:

```sh
openspec-runner recover user-auth 1.1
```

Recovery reuses the attempt identity, branch, and worktree. It may rerun unfinished
setup commands. Ambiguous Herdr creation, Codex startup, or prompt submission
never causes automatic resubmission. Worktrunk partial creation is reconciled
against Git's worktree list before fallback.

### Failed, blocked, stale, or invalidated attempts

After confirming the old worker has stopped, create a retained new attempt:

```sh
openspec-runner retry user-auth 1.1
```

Retry never terminates the prior worker. Use `attach` to inspect an existing
session; do not continue implementation after a final blocked or failed report.

### Planning artifacts changed

After committed planning content changes and once no attempt or integration is
active, run:

```sh
openspec-runner reconcile user-auth
```

Reconciliation adopts committed plan edits, preserves satisfied task identities,
copies only planning files into the integration worktree, and conservatively
invalidates every unintegrated result. Retry invalidated tasks explicitly.
Checkbox completion changes alone do not invalidate fingerprints.

## CLI reference

| Command | Purpose |
|---|---|
| `init` | Create `runner.yaml` when absent and install/update three project skills |
| `models [--json]` | Query Codex model IDs and supported reasoning settings |
| `validate <change> [--json]` | Validate task numbering, coverage, dependencies, and OpenSpec readiness |
| `status <change> [--json]` | Inspect readiness, attempts, reports, and sessions |
| `launch <change> --tasks IDS` | Launch exactly the selected comma-separated tasks |
| `launch ... --dry-run --json` | Preview without creating resources |
| `launch ... --default-model MODEL` | Override the inherited/default model |
| `launch ... --default-effort EFFORT` | Override effort for inherited tasks |
| `launch ... --base REF` | Set the initial committed base; default is invoking `HEAD` |
| `attach <change> <task>` | Focus a saved pane or print a resume command |
| `integrate <change> --tasks IDS` | Merge and verify selected completed results |
| `integrate <change> --continue` | Continue pending integration recovery |
| `integrate <change> --abort` | Abort the current pending integration |
| `recover <change> <task>` | Resume interrupted pre-session preparation |
| `retry <change> <task>` | Create a new retained attempt |
| `reconcile <change>` | Adopt committed plan edits and invalidate old results |
| `cleanup <change> --tasks IDS` | Remove selected integrated clean worktrees |
| `cleanup <change> --all [--dry-run] [--json]` | Inspect/retry the final sweep of all attempts |
| `cleanup ... --attempt ID --confirm TOKEN` | Apply approval to one inspected candidate |
| `worker <change> <task> --attempt ID` | Run the returned supervised worker command exactly once |
| `begin <change> <task> --attempt ID [--session ID]` | Worker-only identity registration |
| `report <change> <task> --attempt ID --file PATH` | Worker-only outcome submission |

Prefer `--json` for automation and skill workflows. `launch --dry-run` is the
safe inspection point before worktrees, attempts, or sessions are created.

## State and safety guarantees

- Only explicit task selections launch, integrate, retry, or clean up.
- The runner does not continuously schedule newly ready tasks.
- Only integration updates canonical OpenSpec task checkboxes.
- Workers cannot claim completion without verification evidence, a full commit
  SHA, and a clean worktree at that commit.
- Shared planning artifacts are fingerprinted; drift blocks unsafe operations
  until explicit reconciliation.
- Runtime state lives under `<git-common-dir>/openspec-runner`, outside versioned
  planning files.
- Concurrency and duplicate prevention use a repository-wide lock shared across
  worktrees and changes.
- Ambiguous external side effects are recorded and not blindly repeated.
- Final delivery, branch deletion, and OpenSpec archival are never implicit.

The lock records PID and host. After a coordinator crash, confirm its owner is
gone before explicitly removing
`<git-common-dir>/openspec-runner/lock.json`. Lock stealing is deliberately not
automatic because it could race another coordinator.

## Troubleshooting

### `init` says this is not a Git repository

Run it inside the intended target repository. `init` resolves the Git root before
installing configuration or skills.

### Codex cannot see the runner skills

Confirm the files exist under `.agents/skills/`, commit them, and start or
refresh the Codex session from the target project. Rerun `openspec-runner init`
after upgrading the runner checkout.

### Launch cannot read the calling session model

Use explicit defaults, or assign models and efforts in `execution.yaml`:

```sh
openspec-runner launch user-auth --tasks 1.1 \
  --default-model MODEL_ID \
  --default-effort high
```

### A dependency still appears blocked

Check `openspec-runner status <change> --json`. A report is not enough; the
dependency must be integrated. A pending conflict or failed check also blocks
dependents.

### Launch printed commands instead of opening sessions

This is the expected fallback outside Herdr. Run each returned command once in
its own terminal. Invoke coordination inside Herdr with `HERDR_ENV=1` for
automatic persistent sessions.

### A worker pane disappeared or the client reconnected

Run `openspec-runner attach <change> <task>`. It focuses a recognized Herdr agent
or prints the exact saved resume command. Do not relaunch unless the lifecycle
explicitly permits `retry`.

### Integration stopped

Inspect the returned integration worktree. Resolve and stage conflicts or fix the
verification failure, then use `integrate --continue`. Use `integrate --abort`
to discard the current pending transaction.

### Validation reports plan drift

Commit intended planning edits, let active work and pending integration finish,
then use `reconcile`. Expect unintegrated results to be invalidated and require
explicit retry.

## Developing the runner

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm pack --dry-run
```

Tests use temporary repositories and fake Codex, Worktrunk, and Herdr executables.
The compatibility test uses installed OpenSpec when available and otherwise
skips. Coverage includes model inheritance, validation, concurrency, duplicate
prevention, setup recovery, paths containing spaces, partial worktree creation,
Herdr IDs and argument forwarding, stale reports, plan drift, integration
conflicts, failed checks, and interrupted integration commits.

Live acceptance is still recommended in a disposable Herdr repository: plan two
independent tasks and one dependent task, launch the independent workers, detach
and reattach, inspect reports, integrate them, then launch the dependent task.
Confirm that only integration changes canonical checkboxes.

Adapter references: [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[Worktrunk](https://github.com/max-sixty/worktrunk),
[Herdr automation](https://herdr.dev/docs/agent-automation/), and
[Herdr persistence](https://herdr.dev/docs/persistence-remote/).
