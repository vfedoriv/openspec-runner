# openspec-runner

`openspec-runner` adds durable, reviewable execution to an existing
[OpenSpec](https://github.com/Fission-AI/OpenSpec) workflow. It can run as an
explicit batch companion, or manage an opt-in feature from exploration and plan
approval through isolated implementation, whole-feature review, bounded repairs,
final approval, OpenSpec archival, and completion on a retained integration
branch.

The package installs five project-local agent skills:

| Skill | Where it runs | Responsibility |
|---|---|---|
| `openspec-runner-plan` | Your planning session | Explore a feature, prepare its OpenSpec artifacts and resolved execution/review settings, and obtain plan approval |
| `openspec-runner-coordinate` | Your coordinating session | Run unmanaged batches or resume a managed feature through implementation, review, repairs, and archival |
| `openspec-runner-implement` | One isolated worker per task | Implement exactly one checkbox, verify it, commit it, and submit a structured report |
| `openspec-runner-review` | A fresh feature reviewer | Review the whole feature against the approved spec and report findings |
| `openspec-runner-repair` | An isolated repair worker | Repair blocking findings without changing the approved task list |

The skills guide both supported worker harnesses; the `openspec-runner` CLI
enforces durable state, dependency, worktree, report, and integration rules.
The runner does not replace OpenSpec, modify OpenSpec core, change Codex or
Claude Code authentication or permissions. Opt-in managed features can archive a
change after final user approval; unmanaged changes retain explicit manual archival.

Explicit skill invocation differs by harness:

| Harness | Syntax |
|---|---|
| Codex | `Use $openspec-runner-plan ...` |
| Claude Code | `/openspec-runner-plan ...` |

Use the corresponding skill name for coordination, implementation, review, or repair. Claude
Code can also load a matching skill automatically from its description, but
this guide uses `/skill-name` when explicit invocation matters. Codex examples
use the `$skill-name` mention syntax.

## Contents

- [How it fits into OpenSpec](#how-it-fits-into-openspec)
- [Requirements](#requirements)
- [Install into a target project](#install-into-a-target-project)
- [Quick start](#quick-start)
- [Managed feature lifecycle](#managed-feature-lifecycle)
- [Skills and session handoffs](#skills-and-session-handoffs)
- [Configuration](#configuration)
- [Task lifecycle and integration](#task-lifecycle-and-integration)
- [Sessions, terminals, and worktrees](#sessions-terminals-and-worktrees)
  - [Worktree and terminal cleanup](#worktree-and-terminal-cleanup)
- [Recovery and plan changes](#recovery-and-plan-changes)
- [CLI reference](#cli-reference)
- [State and safety guarantees](#state-and-safety-guarantees)
- [Troubleshooting](#troubleshooting)
- [Developing the runner](#developing-the-runner)

## How it fits into OpenSpec

Keep using OpenSpec to describe a change and produce its normal proposal, design,
specification, and `tasks.md` artifacts. The planning skill uses the repository's
installed OpenSpec workflows and artifact instructions; it does not assume that
`explore` or `propose` are CLI subcommands. The runner adds reviewed execution
metadata, isolated implementation, and—when explicitly enabled—feature-level
approval, review, repair, archival, and completion state.

The initial OpenSpec artifacts do not need to be committed before using the
`openspec-runner-plan` skill. The planning skill may complete those artifacts
and will add `execution.yaml`, so review and commit the complete planning result
after the skill finishes. That commit is required before coordination can
preview or launch any task.

```mermaid
flowchart TB
    A[Explore feature and create<br/>OpenSpec artifacts] --> B[Prepare execution.yaml<br/>and resolved role settings]
    B --> C{Managed feature?}

    C -- No --> U1[Review and commit plan]
    U1 --> U2[Preview and approve each batch]
    U2 --> UW[Isolated implementation workers]
    UW --> U3[Review and integrate selected results]
    U3 --> U4{All tasks satisfied?}
    U4 -- No --> U2
    U4 -- Yes --> U5[Deliver branch and archive manually]

    C -- Yes --> M1[Review and approve<br/>plan plus role settings]
    M1 --> M2[Commit plan and record<br/>snapshot-bound approval]
    M2 --> M3[Launch ready batches<br/>under approved settings]
    M3 --> MW[Isolated implementation workers]
    MW --> M4[Integrate completed tasks]
    M4 --> M5{All tasks satisfied?}
    M5 -- No --> M3
    M5 -- Yes --> M6[Fresh whole-feature review]
    M6 --> M7{Blocking findings?}
    M7 -- Yes, rounds remain --> M8[Isolated repair attempt]
    M8 --> M9[Integrate repair]
    M9 --> M6
    M7 -- Yes, limit reached --> M10[Pause for user direction]
    M7 -- No --> M11[Preview final result<br/>and archive scope]
    M11 --> M12[User final approval]
    M12 --> M13[Archive, synchronize specs,<br/>verify, and commit]
    M13 --> M14[Feature completed on<br/>integration branch]
```

Both workflows preserve two important boundaries:

1. A worker completing a task does **not** complete its canonical OpenSpec
   checkbox. Only successful integration does that.
2. The runner produces a dedicated integration branch. Delivering that branch
   to your main branch remains separate. Unmanaged archival is manual; managed
   archival requires a second, snapshot-bound user approval.

The resulting file and state layout is:

```mermaid
flowchart TB
    subgraph V[Versioned in the target project]
        A[openspec/changes/CHANGE/tasks.md]
        B[openspec/changes/CHANGE/execution.yaml]
        C[openspec/runner.yaml]
        D[Agent skills for Codex<br/>and Claude Code]
    end

    subgraph R[Runtime state outside versioned planning files]
        E[git-common-dir/openspec-runner]
        F[Task attempts and structured reports]
        G[Repository-wide lock]
        J[Worker logs and cleanup decisions]
        N[features/CHANGE.json<br/>approvals, phase, findings, receipts]
        O[Review and repair reports]
        E --> F
        E --> G
        E --> J
        E --> N
        E --> O
    end

    subgraph W[Git resources]
        H[Dedicated integration branch and worktree]
        I[Retained branch per attempt]
        K[Temporary task worktree]
        P[Retained review or repair worktree]
    end

    subgraph T[Execution resources]
        L[Supervised implementation,<br/>review, or repair worker]
        M[Optional runner-owned Herdr pane]
    end

    A --> H
    B --> H
    C --> K
    D --> K
    F --> H
    I --> K
    K --> L
    P --> L
    N --> P
    L --> M
    J -. records exit and cleanup .-> L
    M -. closes before removal .-> K
```

## Requirements

The target project must have:

- Linux, macOS, or WSL. Native Windows is outside v1.
- Node.js 22.13 or newer.
- Git and a Git repository.
- OpenSpec installed and initialized in the project.
- At least one selected worker harness—Codex or Claude Code—installed,
  authenticated, and available on `PATH`.
- The planning artifacts committed before the first launch.

Optional integrations:

- [Worktrunk](https://github.com/max-sixty/worktrunk) for worktree creation. With
  `worktrees: auto`, the runner uses it only when the required capabilities are
  available and otherwise falls back to Git worktrees.
- [Herdr](https://herdr.dev/docs/agent-automation/) for automatic persistent
  terminal sessions. With `terminal: auto`, it is used when `HERDR_ENV=1`;
  Orca takes precedence when both environments are present.
- [stablyai/orca](https://github.com/stablyai/orca) for worktree creation and
  persistent terminals. Select `worktrees: orca` and `terminal: orca`, or use
  terminal auto-detection inside an Orca terminal. Outside either
  environment, the runner prints exact commands for separate terminals.

Check the required tools before installation:

```sh
node --version
git --version
openspec --version
codex --version        # when using Codex
claude --version       # when using Claude Code
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
# or: openspec-runner init --agent claude
# or: openspec-runner init --agent all
```

It creates this project-local installation:

```text
target-project/
├── .agents/
│   └── skills/
│       ├── openspec-runner-plan/SKILL.md
│       ├── openspec-runner-coordinate/SKILL.md
│       ├── openspec-runner-implement/SKILL.md
│       ├── openspec-runner-review/SKILL.md
│       └── openspec-runner-repair/SKILL.md
├── .claude/
│   └── skills/              # installed by init --agent claude|all
└── openspec/
    └── runner.yaml
```

`init` is safe to rerun after rebuilding or upgrading the runner. `codex` remains
the compatibility default; `claude` creates a version-2 config with an explicit
`sonnet` default and `dontAsk` permissions; `all` installs both skill targets and
allows `--default-agent codex|claude` for a new version-2 config:

- It updates only the five runner-owned `SKILL.md` files.
- It does not remove or replace unrelated project skills.
- It creates `openspec/runner.yaml` only when absent, preserving existing runner
  configuration.
- It does not initialize OpenSpec or create an OpenSpec change.

Review and commit the installed files so every task worktree receives the same
skills and configuration:

```sh
git add .agents/skills/openspec-runner-* .claude/skills/openspec-runner-* openspec/runner.yaml
git commit -m "Install OpenSpec runner skills"
```

After upgrading this checkout, rebuild, rerun `openspec-runner init` in the
target project, review the skill changes, and commit them.

## Quick start

This first example shows the original unmanaged batch workflow for an existing
OpenSpec change named `user-auth`. It retains approval before every launch and
integration. For the end-to-end workflow, continue to
[Managed feature lifecycle](#managed-feature-lifecycle).

### 1. Plan the execution

Invoke the planning skill with the syntax for your coordinator.

Codex:

```text
Use $openspec-runner-plan for the user-auth change. Complete any missing OpenSpec
artifacts, then propose task dependencies, model assignments, effort, and safe
parallel groups. Do not launch anything yet.
```

Claude Code:

```text
/openspec-runner-plan user-auth. Complete any missing OpenSpec artifacts, then
propose task dependencies, model assignments, effort, and safe parallel groups.
Do not launch anything yet.
```

Review the proposed table and the complete
`openspec/changes/user-auth/execution.yaml` prepared beside `tasks.md`. The skill validates the
plan and asks you to commit the approved planning artifacts. You may start this step
with uncommitted proposal, design, specification, or `tasks.md` files; commit
them together with `execution.yaml` after planning finishes and before starting
step 2.

### 2. Inspect and preview a ready batch

Codex:

```text
Use $openspec-runner-coordinate for user-auth. Show ready tasks and preview tasks
1.1 and 1.2. Do not launch until I approve the preview.
```

Claude Code:

```text
/openspec-runner-coordinate user-auth. Show ready tasks and preview tasks 1.1
and 1.2. Do not launch until I approve the preview.
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

Inside Herdr, each task starts in its own persistent workspace; inside Orca,
each starts in its own terminal. Outside these environments,
the command prints one shell-quoted supervised worker command per task; run each
command once in a separate terminal. Reserved attempts already consume
concurrency slots, so do not rerun `launch` just because a terminal has not
started yet.

The selected harness comes from `defaultAgent`, the change-level `agent`, or
`--agent`. For example, an approved Claude Code batch can be launched with:

```sh
openspec-runner launch user-auth --tasks 1.1,1.2 --agent claude
```

### 4. Review and integrate

Each worker uses the `openspec-runner-implement` skill through a
harness-specific runner-generated prompt: `$openspec-runner-implement` for
Codex and `/openspec-runner-implement` for Claude Code. It implements one
checkbox, verifies and commits it, then submits a structured report. Back in
the coordinating session:

```sh
openspec-runner status user-auth --json
openspec-runner integrate user-auth --tasks 1.1,1.2
```

Review the report, verification evidence, commit, and worktree before approving
integration. Integration waits until every selected supervised worker has
actually exited; an accepted report by itself is not sufficient. Successful
integration merges tasks sequentially, runs configured checks, updates the
corresponding checkboxes, and commits those updates in the dedicated integration
worktree. It then returns a cleanup summary. With the default automatic policy,
eligible task terminals and worktrees from that successful batch are cleaned at
this point.

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

## Managed feature lifecycle

Invoke the planning skill with a feature idea to use the full managed workflow:

```text
Use $openspec-runner-plan to plan and coordinate a managed feature for user authentication.
Explore the requirements, propose the OpenSpec artifacts and execution plan, and ask
me to approve them before implementation. Continue through review and repairs,
then ask for final approval before archiving.
```

Use `/openspec-runner-plan` in Claude Code. The current conversation coordinates
the work; implementation, review, and repairs run in separate supervised sessions.
There is no unattended controller. On a new session, resume from
`openspec-runner feature status user-auth --json`.

```mermaid
stateDiagram-v2
    [*] --> Planning: feature start or adopt
    Planning --> AwaitingPlanApproval: artifacts and settings ready
    AwaitingPlanApproval --> Implementing: user approves exact plan snapshot
    Implementing --> Implementing: launch and integrate ready batches
    Implementing --> Reviewing: all tasks integrated
    Reviewing --> Fixing: review reports blockers
    Reviewing --> AwaitingFinalApproval: review has no blockers
    Fixing --> Reviewing: repair integrated; fresh review required
    Fixing --> Fixing: two repair rounds exhausted; pause for user direction
    Fixing --> Implementing: user approves revised settings or round limit
    AwaitingFinalApproval --> Archiving: user approves exact final snapshot
    Archiving --> Archiving: recover interrupted archive/check/commit
    Archiving --> Completed: archive committed and final checks pass
    Completed --> [*]

    note right of AwaitingPlanApproval
      Approval binds plan fingerprint,
      base, task settings, reviewer,
      repair settings, and round limit.
    end note
    note right of AwaitingFinalApproval
      Advisory findings remain visible;
      correctness, security, spec, and
      verification findings block approval.
    end note
```

Managed features are opt-in. `feature start <change>` registers a new lifecycle
before artifacts exist; it does not initialize OpenSpec or invent requirements.
`feature adopt <change>` enrolls an existing change after its active workers and
integration have stopped. Existing tasks, commits, and checked boxes never imply
user approval. Unmanaged commands keep their existing behavior.

The durable lifecycle phases are `planning`, `awaiting-plan-approval`,
`implementing`, `reviewing`, `fixing`, `awaiting-final-approval`, `archiving`,
and `completed`. Conditions that require intervention are reported as blockers
alongside the current phase rather than introducing an unpersisted scheduler or
hidden transition.

The planning skill prepares all artifacts and task metadata before review, and
includes explicit implementation, reviewer, and repair settings. Reviewers and
repair workers may use a different supported harness from implementation.
For example, save this input outside the change directory, replacing model
placeholders using model discovery:

```json
{
  "implementation": { "harness": "codex", "model": "MODEL_ID", "effort": "high" },
  "review": { "harness": "codex", "model": "MODEL_ID", "effort": "high" },
  "repair": { "harness": "claude", "model": "sonnet" },
  "maxFixRounds": 2
}
```

Codex effort must be explicit for all approved settings. Claude effort may be
omitted to intentionally use its CLI default. Managed execution never inherits
new defaults from whichever session happens to resume it.

After the user approves the artifacts and settings, commit only those planning
files. Preview the committed snapshot, check it matches the approved package,
and record approval using its token:

```sh
openspec-runner feature start user-auth --json
openspec-runner feature approve user-auth --file /path/to/feature-settings.json --dry-run --json
openspec-runner feature approve user-auth --file /path/to/feature-settings.json --confirm PLAN_TOKEN --json
```

Tokens bind a snapshot; they are not substitutes for user consent. Plan approval
creates the integration branch and authorizes routine ready-batch launches,
integration, review, and in-scope repairs. Use ordinary launch/integrate commands
with the approved settings; omit agent, model, effort, and base overrides.
Changed planning content requires a commit, reconciliation, and fresh approval.
Checkbox updates alone do not invalidate approval.

After implementation, preview and start a fresh reviewer:

```sh
openspec-runner feature review user-auth --dry-run --json
openspec-runner feature review user-auth --json
openspec-runner feature status user-auth --json
```

Herdr/Orca dispatch uses the existing terminal adapters. Manual mode returns an
exact supervised worker command to run once in another terminal. Reports alone
are insufficient: a successful supervised exit and matching session identity
are required. The reviewer checkout must remain unchanged.

Review reports include a stable finding ID, category, location, impact, and
suggested correction. Correctness, security, spec, and verification failures
block completion. Style and optional improvements are advisory. For blockers:

```sh
openspec-runner feature fix user-auth --dry-run --json
openspec-runner feature fix user-auth --json
# After the repair worker reports and exits successfully:
openspec-runner feature integrate user-auth --attempt REPAIR_ID --json
openspec-runner feature review user-auth --json
```

Each repair attempt covers the current blockers in an isolated worktree without
adding OpenSpec tasks. Repairs cannot close findings themselves; every repair
must be integrated and reviewed again. After two repair attempts, unresolved
blockers require user direction. A failed/blocked attempt pauses the workflow;
an explicitly requested `--retry` creates another attempt and consumes another
repair round. Increasing `maxFixRounds` requires a new reviewed plan approval.

Once checks pass and the latest review has no blockers:

```sh
openspec-runner feature approve user-auth --final --dry-run --json
openspec-runner feature archive user-auth --dry-run --json
# Present the result, advisory findings, and archive scope; obtain final approval.
openspec-runner feature approve user-auth --final --confirm FINAL_TOKEN --json
openspec-runner feature archive user-auth --json
```

Archival runs OpenSpec's normal specification synchronization in the integration
worktree, commits the archive, and runs final validation/checks. Only then is
the feature marked completed. Completion does not merge into main or publish
a pull request. Branches, reports, and the integration worktree remain available.

Lifecycle state is versioned separately beneath
`<git-common-dir>/openspec-runner/features/`; existing version-1/version-2 task
state remains compatible. Approvals and reports live outside fingerprinted
planning files. `status` includes the lifecycle, task readiness, findings,
blocking errors, and next action, even before artifacts exist or after archival.

For interrupted repairs, inspect and resolve conflicts before
`feature integrate <change> --continue`, or use `--abort` to abandon the pending
merge. `feature recover <change> --attempt ID` records provably interrupted
preparation or a disappeared supervised worker without starting another session.
Uncertain terminal/process ownership must be inspected; it is never automatically
redispatched. Feature job worktrees are retained and listed in status for review
and recovery. Existing task cleanup policy and confirmations remain unchanged.

Archive errors retain an `archiving` state and receipt. Rerun `feature archive`
after inspection to resume an already-produced archive or commit. Partial edits
with the active change still present require inspection and completion of the
OpenSpec operation before retrying. Never delete the lifecycle state to bypass
an error or run a second archive blindly.

## Skills and session handoffs

The planner and coordinator are user-facing. Implementation, review, and repair
skills are invoked by runner-generated prompts inside supervised worktrees.

### Planning skill: `openspec-runner-plan`

Use this while exploring a feature, creating a change, or adding runner metadata
to an existing change.
It:

1. Uses the repository's existing `openspec status` and artifact-instruction
   workflow to create missing artifacts in dependency order.
2. Keeps standard numbered checkboxes in `tasks.md`.
3. Queries `openspec-runner models --json` instead of assuming model IDs.
4. Presents one review table with task number, description, model, optional
   reasoning effort, dependencies, and parallel permission.
5. Prepares `execution.yaml` for review, includes every checkbox, and runs
   `openspec-runner validate <change> --json`.
6. For a managed feature, resolves implementation, review, and repair settings,
   previews the committed approval snapshot, and records it only after consent.

Task identity comes from the number in the checkbox text:

```markdown
- [ ] 1.1 Add the token verifier
- [ ] 1.2 Add the session repository
- [ ] 2.1 Wire authentication into the API
```

Do not use OpenSpec's positional JSON task IDs as runner identifiers. Every
checkbox must have an entry in `execution.yaml`; an empty assignment is valid.

The OpenSpec artifacts may be uncommitted when planning starts. After planning
finishes, commit `tasks.md`,
`execution.yaml`, and every other changed OpenSpec artifact before moving to
coordination. For unmanaged changes this commit does not authorize launch. For
managed changes, the separate plan-approval record authorizes routine execution
under its exact fingerprint, base, settings, and repair limit.

### Coordination skill: `openspec-runner-coordinate`

Use one coordinating session to own the lifecycle. For every change it:

- Shows status and ready tasks before launch.
- Previews the exact selected batch with `--dry-run --json`.
- Launches only that batch; it never starts a continuous scheduler.
- Uses `attach` for an existing worker instead of creating duplicates.
- Treats structured worker reports, not terminal idle indicators, as completion.
- Integrates only verified results with matching reports and exit receipts.
- Stops on conflicts or failed checks and uses explicit continue/abort recovery.
- Reports automatic cleanup results and asks about candidates requiring a user
  decision. Attempt branches and the integration worktree remain available.

For managed features it also continues through fresh whole-feature review,
blocking-finding repairs, re-review, final approval, and recoverable archival.
The recorded plan approval removes routine per-batch prompts; unmanaged batches
continue to require explicit launch and integration choices.

A useful prompt for later batches is:

Codex:

```text
Use $openspec-runner-coordinate for user-auth. Inspect current status, show the
reports for completed workers, and propose the next dependency-ready batch. Wait
for my choice before integrating or launching.
```

Claude Code:

```text
/openspec-runner-coordinate user-auth. Inspect current status, show the reports
for completed workers, and propose the next dependency-ready batch. Wait for my
choice before integrating or launching.
```

### Implementation skill: `openspec-runner-implement`

Normally you do not invoke this yourself. The runner includes it in the
single-task prompt sent to every worker, using Codex's `$skill-name` syntax or
Claude Code's `/skill-name` syntax as appropriate. A worker must:

1. Register its worker identity from the assigned worktree with `begin`: Codex
   uses its actual `CODEX_THREAD_ID`; Claude Code uses the reserved stream UUID.
2. Read the change artifacts and implement only its assigned checkbox.
3. Leave `tasks.md`, `execution.yaml`, `runner.yaml`, and other shared
   planning artifacts unchanged.
4. Perform task-specific verification and commit the implementation.
5. Keep a completed worktree clean at the reported commit.
6. Write its report outside the worktree and submit it with `report`.
7. After the report command returns successfully, end the turn so the supervised
   worker exits instead of continuing to another checkbox.

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
  "session": "worker-session-id",
  "outcome": "completed",
  "commit": "full-HEAD-commit-SHA",
  "summary": "Added token verification and covered rejection paths",
  "verification": ["pnpm test -- token-verifier: 8 tests passed"]
}
```

`outcome` may be `completed`, `failed`, or `blocked`. Verification must be a
nonempty array of concrete evidence. Completed reports require the full commit
SHA. Codex reports its registered thread identity; Claude Code reports the
matching stream `session_id`. A blocked or failed worker has stopped
implementing; start a new attempt only with explicit `retry`.

### Review skill: `openspec-runner-review`

The runner starts this skill in a fresh isolated checkout at the exact integration
head. It reviews the complete approved base-to-head change against the proposal,
design, specs, tasks, and verification evidence. It must not edit tracked files.
Its report includes the reviewed head and fingerprint plus stable findings with
`id`, `category`, `location`, `impact`, and `correction`.

`correctness`, `security`, `spec`, and `verification` findings block final
approval. `style` and `improvement` findings are advisory and remain visible in
the final preview. A completed report is accepted only with a matching session;
the review becomes usable only after the supervised process exits successfully.

### Repair skill: `openspec-runner-repair`

The runner starts one isolated repair attempt for the current blocking findings.
The worker may change implementation and tests, but not the approved OpenSpec
artifacts, checkboxes, or execution settings. A completed repair requires a clean
worktree, full commit SHA, verification evidence, matching session, and successful
supervised exit. The coordinator integrates that commit without adding or checking
off a task, then requires a fresh whole-feature review. A repair cannot close its
own findings.

### Managed skill handoff sequence

```mermaid
sequenceDiagram
    actor U as User
    participant C as Planning/coordinating session
    participant R as openspec-runner
    participant W as Implementation workers
    participant V as Fresh reviewer
    participant F as Repair worker

    U->>C: Plan a managed feature
    C->>R: feature start or adopt
    C->>U: Present artifacts, tasks, and role settings
    U->>C: Approve exact plan package
    C->>R: Record fingerprinted plan approval
    C->>R: status and launch dry-run
    R-->>C: Ready tasks with approved settings
    C->>R: launch selected tasks
    R->>W: One isolated worktree per task
    W->>R: Register, implement, verify, commit, report, exit
    C->>R: integrate completed tasks
    R->>R: Merge, verify, update checkboxes, clean eligible worktrees
    loop Until all dependencies are integrated
        C->>R: launch next ready tasks
        R->>W: New isolated task attempts
        W->>R: Reports and supervised exits
        C->>R: integrate
    end
    C->>R: feature review
    R->>V: Whole-feature prompt at exact integration head
    V->>R: Findings, verification, and supervised exit
    alt Blocking findings and repair rounds remain
        C->>R: feature fix
        R->>F: Current blockers in isolated worktree
        F->>R: Repair commit, verification, and exit
        C->>R: feature integrate repair
        C->>R: feature review again
    else No blocking findings
        C->>U: Present review, advisory findings, and archive preview
        U->>C: Approve exact final snapshot
        C->>R: Record final approval and archive
        R->>R: Synchronize specs, validate, commit, mark completed
    end
    R-->>C: Completed integration branch and archive receipt
```

The unmanaged sequence ends after task integration and cleanup; it keeps the
per-batch user approvals shown in the quick start and leaves OpenSpec archival to
the user.

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
| `version` | Configuration schema version: `1` for Codex-compatible settings or `2` for registered harness configuration |
| `defaultModel` | `session` to inherit the coordinating Codex session, or an explicit model identifier |
| `maxParallel` | Repository-wide maximum active/reserved task attempts |
| `worktrees` | `auto` uses compatible Worktrunk when available, otherwise Git; explicit `git`, `worktrunk`, and `orca` are supported |
| `terminal` | `auto` uses Orca when `ORCA_TERMINAL_HANDLE` is present, then Herdr inside Herdr, otherwise returns manual commands; explicit `orca`, `herdr`, and `manual` are supported |
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

New projects can select a harness with version 2:

```yaml
version: 2
defaultAgent: claude
agents:
  claude:
    defaultModel: sonnet
    permissionMode: dontAsk
    allowedTools: []
    # Optional reviewed supplement:
    # planningRules: openspec/planning-rules/claude.md
maxParallel: 4
worktrees: auto
terminal: auto
cleanup: automatic
setup: []
verifyIntegration: []
```

`defaultAgent` is the project fallback; a launch batch may select another
registered harness with `--agent`. Each batch is homogeneous, while separate
batches may use different harnesses. `agents.<harness>` owns that harness's
model, permission, and planning-rule settings. `allowedTools: []` grants
nothing, and the runner never injects a permission bypass.

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

Version 2 assigns one change-level harness and uses the common `effort` field:

```yaml
version: 2
agent: claude
tasks:
  "1.1":
    model: sonnet
    parallel: true
  "1.2":
    model: sonnet
    effort: high
    parallel: true
```

Task-level `agent` fields are rejected. Version-1 files remain Codex-compatible
and are normalized as Codex at runtime; old and new schemas are never silently
translated between harnesses.

### Managed feature approval settings

Managed features approve a separate JSON input for the three execution roles.
It is an approval input, not another project configuration file, and should stay
outside the OpenSpec change directory so it does not alter the plan fingerprint.

| Field | Meaning |
|---|---|
| `implementation` | Harness, explicit model, and optional effort inherited by task assignments; its harness must match `execution.yaml` |
| `review` | Harness, explicit model, and optional effort for fresh whole-feature reviews |
| `repair` | Harness, explicit model, and optional effort for blocking-finding repairs |
| `maxFixRounds` | Maximum repair attempts after the initial review; defaults to `2` |

The approval preview resolves every task's effective settings and returns a token
bound to the plan fingerprint, committed base, role settings, task settings,
integration checks, and repair limit. Recording approval stores that resolved
snapshot beneath the Git common directory. Resuming from another session cannot
silently change it through a different session model or CLI default.

### Model and effort resolution

Inspect models and aliases through the selected harness with:

```sh
openspec-runner models --json
openspec-runner models --agent claude --json
openspec-runner planning-rules --agent claude --json
```

Model IDs are configurable and not hard-coded by the skills. At batch launch:

- An omitted model uses the selected harness's configured/default model. `session`
  means calling-session inheritance; it is supported for Codex and intentionally
  unavailable for Claude until a stable reader exists.
- An explicitly different model uses its advertised default effort unless
  an effort is assigned. Claude may intentionally omit effort and use its
  CLI/model default.
- An explicit assignment matching the inherited model inherits its effort.
- If calling-session metadata is unavailable, supply explicit defaults:

```sh
openspec-runner launch user-auth --tasks 1.1 \
  --default-model MODEL_ID \
  --default-effort high
```

The isolated Codex metadata reader currently supports Codex CLI 0.153.x and the
`state_5.sqlite` threads schema, tested with 0.153.4. It selects only `model`
and `reasoning_effort` for `CODEX_THREAD_ID` through a read-only connection;
it does not read messages, titles, authentication, or unrelated threads.
Unsupported formats fail with an explicit-default instruction. Claude uses print
mode with structured `stream-json`, a preallocated `--session-id`, and exact
`--resume` only after stream identity confirmation. Credentials remain in the
user's CLI configuration and are never copied into runner state. Resolved
settings and the immutable harness are saved with attempts, so later model or
calling-session changes do not alter resume behavior.

## Task lifecycle and integration

This lower-level state machine applies to implementation checkboxes in both the
managed and unmanaged workflows. Managed review, repair, and archival use the
feature lifecycle shown earlier.

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
    Running --> ReportAccepted: completed report accepted
    Running --> Failed: failed report accepted
    Running --> Blocked: blocked report accepted
    ReportAccepted --> WorkerExited: supervised process exits
    Failed --> FailedExited: supervised process exits
    Blocked --> BlockedExited: supervised process exits
    WorkerExited --> Integrating: coordinator selects; user approves unmanaged
    Integrating --> Integrated: merge and checks succeed
    Integrating --> Pending: conflict or failed check
    Pending --> Integrating: continue
    Pending --> WorkerExited: abort
    FailedExited --> Ready: explicit retry
    BlockedExited --> Ready: explicit retry
    Integrated --> Cleaning: successful batch
    Cleaning --> Cleaned: eligible resources removed
    Cleaning --> ReviewRequired: confirmation needed
    ReviewRequired --> Cleaned: user approves current inspection
    ReviewRequired --> Retained: user keeps or does not respond
    Retained --> Cleaning: explicit cleanup retry
    Cleaned --> [*]
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

Implementation tasks, managed reviews, and managed repairs all use the same
worktree and terminal adapters. Task attempts may be cleaned after integration;
feature review and repair worktrees are retained with their reports and logs for
audit and recovery. Review and repair jobs are exclusive across the repository,
and cannot overlap active implementation workers.

### Inside Herdr

For every task or managed feature job, the runner creates a labeled workspace
without changing focus and starts a supervised Codex or Claude worker in the
returned pane with explicit settings and working directory. Workspace, pane,
terminal, role/batch, harness, and worker session IDs are saved when available.

```sh
openspec-runner attach user-auth 1.1
```

While a worker is active, `attach` focuses its saved pane. After the worker exits
or its worktree is removed, `attach` returns the retained session, branch, log,
and available inspection details instead of trying to resume in a missing
directory. Herdr preserves panes across client detach and reconnect. A server or
machine restart may require the exact saved Codex or Claude resume command. Herdr idle/done
indicators describe terminal activity, not task completion.

### Inside Orca (stablyai/orca)

Use the [Orca desktop app](https://github.com/stablyai/orca) from
[onorca.dev](https://www.onorca.dev/). Register its `orca` CLI in the app's
settings and add the target repository to Orca. In `openspec/runner.yaml`, select:

```yaml
worktrees: orca
terminal: orca
```

Check `orca status --host local --json` before launching. Explicit `terminal:
orca` works from any shell with access to the ready local runtime. `terminal:
auto` detects Orca through `ORCA_TERMINAL_HANDLE`. Each selected task gets a
dedicated background terminal running the saved supervised Codex or Claude
worker command. It does not send prompts into an existing interactive agent.

The worktree adapter calls `orca worktree create --base-branch <commit> --setup
skip --no-parent`. It records Orca's actual branch and path, which follow the
app's workspace and branch-prefix settings, and verifies the base against local
Git. A unique attempt marker in the worktree comment supports reconciliation
after a partial creation failure; retain that comment until preparation finishes.
The internal integration worktree continues to use Git directly. Runner `setup`
commands still run normally; Orca setup commands are skipped.

`attach` focuses the saved terminal handle. Runtime and PTY incarnation identities
prevent attaching to or closing a replacement terminal. Ambiguous terminal
creation is never automatically resubmitted. After a runtime restart, inspect
the saved attempt and logs manually; the runner does not adopt fresh handles.

Cleanup saves output and closes only its verified terminal after both the worker
receipt and Orca confirm exit. Other Orca terminals in the task worktree block
removal, including initial shell/default tabs that Orca may create. Inspect and
close those in the app, then retry runner cleanup. Worktree removal uses Git to
retain branches: Orca's `worktree rm` can delete them. Orca may need a workspace
refresh to reflect the external removal. No unrelated terminals are closed.

`worktrees: auto` retains its Worktrunk/Git behavior. The two adapter settings
are independent; Orca terminals also work with Git/Worktrunk worktrees once
Orca can resolve their paths. This integration requires a local runtime on the
same host and filesystem as the runner. Remote/SSH targets and WSL-to-Windows
app bridging are unsupported. Native Windows remains outside runner support;
use Linux, macOS, or an Orca runtime inside the same WSL environment.

The CLI contract was checked against upstream revision
[`fa0010e8`](https://github.com/stablyai/orca/tree/fa0010e8d6b2a7ad946fe1f1b005c6a8497c6c17).
Older runtimes without host coverage or terminal incarnation information fail
closed. Previous tmux-based `fmfsaisai/orca` support has been replaced; its saved
terminal records require manual inspection and are not migrated into desktop Orca.

### Outside Herdr or Orca

`launch`, `feature review`, and `feature fix` return exact supervised worker
commands to run once in separate terminals. Task commands start
`openspec-runner worker`; feature jobs start `openspec-runner feature worker`.
Each invokes one selected-harness CLI with the saved prompt and working
directory. Claude prompts are sent through stdin in print/stream-json mode; its
session UUID is checked against emitted stream events. Do not replace it with
an unrequested background process or invoke it twice. While the worker remains
active, `attach` prints the saved resume command instead of focusing a pane.

An attempt without a saved harness identity cannot be recreated blindly after an
ambiguous startup. Inspect its saved workspace/pane or explicitly recover the
appropriate lifecycle stage.

### Worktree and terminal cleanup

With `cleanup: automatic` (the default for new and existing configuration), the
runner performs two cleanup phases:

1. **After each integrated batch:** only after every selected merge and
   integration check succeeds—including an `integrate --continue` recovery—the
   runner considers that batch's integrated attempts. A conflict, failed check,
   or unacknowledged worker exit retains the worktrees needed for recovery.
2. **After the whole change is complete:** when every planned task was already
   complete in the baseline or has been integrated, and no attempt or integration
   transaction is active, the runner sweeps all recorded attempts. This catches
   obsolete failed, blocked, stale, invalidated, and superseded retry worktrees.

The integration worktree is excluded from both phases and stays available for
explicit branch delivery and, for unmanaged changes, manual OpenSpec archival.
Managed archival happens in that retained integration worktree after final
approval, and the completed worktree remains available for inspection.

New workers use supervised Codex or Claude processes: after an accepted final
report they end their turn, exit, and the supervisor records the actual exit.
Sessions persist in the selected provider and runner logs live under the Git
common directory's `openspec-runner/logs`.
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

Cleanup reports one status per attempt:

| Status | Meaning and next action |
|---|---|
| `eligible` | Inspection found no review condition. A dry run would remove it; a real cleanup proceeds automatically. |
| `removed` | The verified terminal was closed when applicable and the worktree was removed. |
| `already-removed` | No registered worktree or residual path remains; no action is needed. |
| `confirmation-required` | Removal could discard changes or close a reviewed terminal. Show the path, reasons, changes, and terminal details to the user, then keep it or submit its token. |
| `skipped` | A hard protection or uncertain identity prevents automated removal. Resolve the stated reason before retrying; confirmation does not override this status. |
| `failed` | Closing the terminal or removing the worktree failed. Integration remains successful; inspect the reason and retry cleanup. |

Inspect or retry cleanup, including after archival in the main checkout:

```sh
openspec-runner cleanup user-auth --tasks 1.1,1.2
openspec-runner cleanup user-auth --all --dry-run --json
openspec-runner cleanup user-auth --all
# After the user approves one reviewed candidate:
openspec-runner cleanup user-auth --all --attempt ATTEMPT_ID --confirm TOKEN --json
```

For automation, first inspect with `--dry-run --json`. A review case resembles:

```json
{
  "cleaned": false,
  "branchesRetained": true,
  "scope": { "all": true, "tasks": [] },
  "results": [
    {
      "attempt": "attempt-id",
      "task": "1.1",
      "path": "/absolute/path/to/task-worktree",
      "status": "confirmation-required",
      "reasons": ["Deletion discards the listed tracked/untracked local changes"],
      "changes": "?? notes.txt",
      "terminal": { "kind": "manual", "reason": "Confirm the worker has exited and all manually opened terminals/processes using this worktree have been closed" },
      "token": "state-bound-approval-token"
    }
  ]
}
```

The token is deliberately bound to that inspection. Re-run the dry run and ask
again if the worktree contents, HEAD, lock, integration state, or terminal state
changes before confirmation. Never cache or broadly reuse cleanup tokens.

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
setup commands. Ambiguous Herdr/Orca creation, selected-harness startup, or prompt
submission never causes automatic resubmission. Worktrunk partial creation is
reconciled against Git's worktree list before fallback.

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

For a managed change, reconciliation also invalidates its plan approval and moves
the lifecycle back to `awaiting-plan-approval`. Preview and obtain approval for
the new committed snapshot before launching or integrating more work. A changed
reviewer, repair model, or repair limit likewise requires a new plan approval.

### Interrupted feature review or repair

Feature attempts are also reserved before worktree, setup, terminal, or process
side effects. Inspect `feature status` first. If the supervisor is provably gone
and startup did not leave ambiguous terminal ownership, record the interruption:

```sh
openspec-runner feature recover user-auth --attempt FEATURE_ATTEMPT_ID --json
```

Recovery does not replay setup or dispatch. After the retained evidence is
reviewed, an explicit `feature review --retry` or `feature fix --retry` creates a
new attempt. Repair retries count toward `maxFixRounds`.

### Interrupted repair integration

Repair integration has its own transaction and never changes `tasks.md`. Resolve
and stage conflicts or correct the failing check in the integration worktree,
then continue; abort only while the recorded repair commit has not been created:

```sh
openspec-runner feature integrate user-auth --continue --json
openspec-runner feature integrate user-auth --abort --json
```

Continuation recognizes a repair merge commit carrying the saved transaction
marker, so a crash after commit does not create a duplicate.

### Interrupted managed archival

`feature archive` persists its starting head, marker, original archive-directory
contents, discovered destination, staged tree, and commit as progress advances.
After inspecting the reported error, rerun the same command. It can recognize an
archive already produced by OpenSpec or an archive commit written before state was
saved. It refuses unexpected files, ambiguous archive destinations, changed
branches, altered archived artifacts, and dirty post-check worktrees.

## CLI reference

| Command | Purpose |
|---|---|
| `init [--agent codex\|claude\|all]` | Create `runner.yaml` when absent and install selected project skills |
| `models [--agent HARNESS] [--json]` | Query the selected harness model capabilities; Claude discovery is explicitly non-exhaustive |
| `planning-rules --agent HARNESS [--json]` | Show bundled and configured versioned planning guidance with hashes |
| `feature start <change> [--json]` | Register an opt-in lifecycle before its OpenSpec artifacts are complete |
| `feature adopt <change> [--json]` | Attach lifecycle tracking to an idle existing change without inferring approval |
| `feature status <change> [--json]` | Inspect phase, approvals, tasks, jobs, findings, blockers, receipts, and next action |
| `feature approve <change> --file SETTINGS --dry-run --json` | Preview the committed plan and fully resolved role/task settings without mutation |
| `feature approve <change> --file SETTINGS --confirm TOKEN` | Record user approval of that exact plan snapshot |
| `feature review <change> [--dry-run] [--retry]` | Preview or start a fresh supervised whole-feature review |
| `feature fix <change> [--dry-run] [--retry]` | Preview or start one repair attempt for current blocking findings |
| `feature integrate <change> --attempt ID` | Merge and verify a completed repair without modifying task checkboxes |
| `feature integrate <change> --continue\|--abort` | Continue or abort interrupted repair integration |
| `feature approve <change> --final --dry-run --json` | Preview the reviewed commit, advisory findings, checks, and archive scope |
| `feature approve <change> --final --confirm TOKEN` | Record user approval of that exact final snapshot |
| `feature archive <change> [--dry-run]` | Preview or recoverably archive, synchronize specs, verify, commit, and complete |
| `feature recover <change> --attempt ID` | Record a provably interrupted feature job without redispatching it |
| `feature worker\|begin\|report ...` | Runner-owned supervised review/repair protocol |
| `validate <change> [--json]` | Validate task numbering, coverage, dependencies, and OpenSpec readiness |
| `status <change> [--json]` | Inspect task state, or route a managed change to its feature status |
| `launch <change> --tasks IDS [--agent HARNESS]` | Launch exactly the selected tasks through one harness |
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
safe task inspection point before worktrees, attempts, or sessions are created.
Managed `feature approve`, `review`, `fix`, and `archive` support resource-free
`--dry-run` previews at their corresponding decision boundaries.

## State and safety guarantees

- Only explicit task selections launch, integrate, retry, or clean up.
- Every batch records one immutable harness and every attempt records that batch;
  unmanaged retries may select another harness only after the previous attempt is
  stopped, while managed attempts remain bound to approved settings.
- The runner does not continuously schedule newly ready tasks.
- Only integration updates canonical OpenSpec task checkboxes.
- Workers cannot claim completion without verification evidence, a full commit
  SHA, and a clean worktree at that commit.
- Shared planning artifacts are fingerprinted; drift blocks unsafe operations
  until explicit reconciliation.
- Managed plan approval binds the fingerprint, starting commit, effective task
  settings, reviewer/repair settings, integration checks, and repair limit.
- Plan drift or reapproval invalidates incompatible unintegrated attempts;
  checkbox completion alone does not change the plan fingerprint.
- Review and repair jobs use role-specific identities rather than fabricated task
  IDs. They require accepted reports and successful supervised exit receipts.
- A reviewer must leave its checkout unchanged. Every integrated repair makes the
  prior review stale and requires a fresh whole-feature review.
- Blocking correctness, security, spec, and verification findings prevent final
  approval. Advisory findings remain visible without blocking archival.
- Final approval binds the exact integration head and accepted review. Any later
  code change makes it stale.
- Managed archival records intent before invoking OpenSpec, recognizes already
  produced output or commits after interruption, and marks completion only after
  archive commit and final checks succeed.
- Runtime state lives under `<git-common-dir>/openspec-runner`, outside versioned
  planning files.
- Concurrency and duplicate prevention use a repository-wide lock shared across
  worktrees and changes.
- Ambiguous external side effects are recorded and not blindly repeated.
- Claude workers use `--session-id` plus matching stream identity and terminal
  evidence; a reserved UUID alone is not proof of a live session or completion.
- Automatic cleanup removes only verified runner-owned task worktrees; review
  conditions require an exact, state-bound user confirmation.
- Cleanup failure is reported independently and does not undo or misreport a
  successful integration.
- Final branch delivery and branch deletion are never implicit. Unmanaged archival
  remains manual; managed archival requires an explicit command after final user
  approval.

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

### Claude Code cannot see the runner skills or start unattended

Use `openspec-runner init --agent claude` (or `--agent all`) and commit
`.claude/skills/`. Claude must be installed and authenticated separately. The
runner uses `-p --output-format stream-json --verbose`, sends the prompt on
stdin, and starts the prompt with the appropriate `/openspec-runner-implement`,
`/openspec-runner-review`, or `/openspec-runner-repair` invocation. It deliberately
does not use `--bare`, which skips project skill discovery. The runner uses the
configured permission mode and `allowedTools`; it never injects
`--dangerously-skip-permissions`. A Claude worker cannot inherit a calling
Codex model, so use `--default-model` or an explicit task model.

### Claude reports a session or terminal-evidence error

The UUID passed to `--session-id` is only a reservation. The stream must emit
the same `session_id`, the worker must register it with `begin --session`, and a
terminal result event must be observed before a completed report can be
integrated. Inspect the retained log and retry explicitly after diagnosing a
CLI, permission, or model failure.

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

This is the expected fallback outside Herdr or Orca. Run each returned command once in
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

### A task reported completion but integration says its worker has not exited

The structured report was accepted, but the supervised Codex or Claude process has
not yet returned and recorded its exit. Inspect it with `status` and `attach`.
Ask the worker to end its turn if it is still active; do not kill it or integrate
the worktree while the exit is uncertain. Once the supervisor records the exit,
run `integrate` again.

### Cleanup requires confirmation

Inspect the exact candidate and present its path, reasons, changed files, and
terminal activity to the user:

```sh
openspec-runner cleanup <change> --all --dry-run --json
```

An empty response or a decision to keep means no deletion. After an explicit
approval, submit only that attempt's current token. If confirmation fails because
state changed, inspect again and request a new decision rather than reusing the
old token.

### Cleanup was skipped or failed

Read the per-attempt `reasons` in JSON output. `skipped` usually means a protected
path, active transaction, moved worktree, mismatched ownership, or unavailable
terminal inspection; fix that condition before retrying. `failed` means an
eligible or approved operation was attempted but did not finish. The integration
commit remains valid in both cases, and the worktree is retained unless removal
was acknowledged.

### Validation reports plan drift

Commit intended planning edits, let active work and pending integration finish,
then use `reconcile`. Expect unintegrated results to be invalidated and require
explicit retry.

For a managed feature, reconciliation also makes the saved approval stale. Run
the plan-approval dry run again and obtain user consent for the new token before
continuing.

### A managed feature is waiting for plan approval

Run `openspec-runner feature status <change> --json`. Commit the complete current
OpenSpec plan, then preview `feature approve --file SETTINGS --dry-run --json`.
Check that its base, fingerprint, task settings, reviewer, repair settings, and
round limit match what the user reviewed. A token from an older preview is
intentionally rejected.

### Review finished but final approval is unavailable

The latest review must target the current integration head and current plan
fingerprint, leave its checkout unchanged, submit a valid finding report, and
exit successfully under the recorded session identity. Integrating a repair or
changing code makes the review stale. Run a new `feature review`; do not edit or
reuse the previous report.

### Repair limit reached

The default permits two repair attempts after the initial review. Status remains
in `fixing` and reports that user direction is required. Either revise scope and
planning artifacts, accept a reviewed increase to `maxFixRounds`, or stop the
feature. Changing the number in a local settings file does not alter the durable
approval until the new preview is explicitly approved.

### Managed archival stopped

Read the recorded archive phase and error from `feature status`. Inspect the
integration worktree, fix only the reported validation or recovery condition,
and rerun `feature archive`. Do not invoke `openspec archive` a second time when
the active change is already gone, delete lifecycle state, or manufacture a new
approval token. Completion is recorded only after the archive commit and all
post-archive checks pass.

## Developing the runner

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm pack --dry-run
```

Run the complete suite on Linux or WSL with Node.js 22.13 or newer and pnpm on
the Linux PATH. Native Windows does not support the integration suite's POSIX
fake executables. To run the managed-feature checks first and then the full suite:

```sh
pnpm install --frozen-lockfile
pnpm run build
node --test test/feature-contract.test.mjs test/feature.test.mjs test/openspec.test.mjs
pnpm test
pnpm pack --dry-run
```

The real OpenSpec interoperability test requires `openspec` on PATH; otherwise
it is skipped. It creates a disposable project and exercises approval, a fake
supervised reviewer, final approval, real OpenSpec spec synchronization, and
archival. Real Codex/Claude authentication is not required for the test suite.
On Windows, `pnpm run build` and
`node --test test/feature-contract.test.mjs` check types and portable contracts.

Tests use temporary repositories and fake Codex, Claude Code, Worktrunk, and
Herdr executables.
The compatibility test uses installed OpenSpec when available and otherwise
skips. Coverage includes model inheritance, validation, concurrency, duplicate
prevention, setup recovery, paths containing spaces, partial worktree creation,
Herdr IDs and argument forwarding, stale reports, plan drift, integration
conflicts, failed checks, and interrupted integration commits.

Live acceptance is still recommended in a disposable repository: run the same
scenario once with Codex and once with Claude Code. Plan two independent tasks
and one dependent task, launch the independent workers, detach and reattach,
inspect reports, integrate them, then launch the dependent task. Confirm that
only integration changes canonical checkboxes.

Adapter references: [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[Claude Code headless mode](https://code.claude.com/docs/en/headless),
[Claude Code permission modes](https://code.claude.com/docs/en/permission-modes),
[Worktrunk](https://github.com/max-sixty/worktrunk),
[Herdr automation](https://herdr.dev/docs/agent-automation/), and
[Herdr persistence](https://herdr.dev/docs/persistence-remote/).
