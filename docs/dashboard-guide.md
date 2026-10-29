# Dashboard guide

Feature/task details include saved [delivery summary status](delivery-summary-guide.md) and display-only inspection, refresh and export commands.

The console dashboard shows runner progress, blockers, worker sessions, and
shared assignments in your terminal. Use it to inspect evidence and preview
next steps while your coordinating session operates the runner.

Browsing does not launch workers, integrate results, approve plans, or change
runner state. Selected actions can focus an existing terminal or run a supported
dry-run preview. Execution and approvals remain in the CLI or coordinating session.

## Contents

- [Open the dashboard](#open-the-dashboard)
- [Choose a view](#choose-a-view)
- [View gallery](#view-gallery)
- [Navigate and filter](#navigate-and-filter)
- [Follow a worker session](#follow-a-worker-session)
- [Inspect actions and previews](#inspect-actions-and-previews)
- [Monitor shared assignments](#monitor-shared-assignments)
- [Read progress correctly](#read-progress-correctly)
- [Troubleshooting](#troubleshooting)

## Open the dashboard

Use Linux, macOS, or WSL with Node.js 22.13 or newer. Follow the
[installation guide](../README.md#install-into-a-target-project) first if the
runner is not available. From the target project's Git repository:

```sh
cd /path/to/target-project
openspec-runner dashboard
```

To concentrate on one local OpenSpec change and its associated imported assignments:

```sh
openspec-runner dashboard --change user-auth
```

The interactive display requires both terminal input and terminal output. It
refreshes every two seconds; press `r` to request a refresh sooner. Press `?`
for help and `q` or Ctrl-C to exit.

For a single snapshot, or output to a file:

```sh
openspec-runner dashboard --once
openspec-runner dashboard --json --change user-auth > dashboard.json
```

`--once` prints plain text. `--json` emits one version-1 JSON snapshot. Without
a terminal on both input and output, the default is a single plain snapshot,
so piping the command does not start the interactive display.

## Choose a view

Use the left and right arrow keys to move between five views.

| View | Use it to |
|---|---|
| Overview | Check feature progress, current sessions, task counts, occupied slots, and the attention count. |
| Attention | Find blockers, missing evidence, and data collection errors that need investigation. |
| Features | Inspect local task dependencies, readiness, execution settings, and managed lifecycle evidence, alongside shared feature summaries when available. |
| Sessions | Inspect implementation, review, and repair attempts, process observations, reports, session identities, saved terminals, and activity. |
| Assignments | Inspect component owners, coordination revisions, and assignment, submission, acceptance, and delivery evidence. |

A useful routine is to start in Overview, inspect Attention, then open the
relevant task in Features or attempt in Sessions. Use Assignments when the work
belongs to a shared Store workflow.

## View gallery

These are illustrative terminal screens with fictional data, based on the
dashboard's Unicode borders and column layout. All examples use a 96-column,
18-row terminal. IDs and timestamps are shortened; long cells end with `…`.
Borders and padding are produced by the same layout function used by the UI.
The dashboard shows one pane at a time; details and activity replace the list
when opened.

The local example is a managed `user-auth` change with four tasks. Task `1.1`
is integrated, attempt `a02` for `1.2` reported a blocker and exited, `1.3` is
ready, and `1.4` depends on `1.2`. No workers currently occupy the two available
slots. The Assignments example adds a shared Store context; the later activity
example shows a new retry of the blocked task.

### Overview

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Overview] │ Attention │ Features │ Sessions │ Assignments                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 0/2 · attention 1 · list                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:all o:all c:false v:false z:name                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│   a01 · implementation · phase integrated · process exited · report completed                │
│ ▸ a02 · implementation · phase blocked · process exited · report blocked                     │
│   user-auth · implementing · 1/4 tasks satisfied                                             │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Tab Enter / r ? q · a actions                                                             │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

The header separates satisfied tasks, occupied slots, and attention items. A
blocked attempt can coexist with an `implementing` feature phase. Press `→`
to inspect Attention, or select a row with `↑`/`↓` and press Enter for evidence.

### Attention

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Overview │ [Attention] │ Features │ Sessions │ Assignments                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 0/2 · attention 1 · list                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:all o:all c:false v:false z:name                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Attempt a02 is blocked                                                                     │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Tab Enter / r ? q · a actions                                                             │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Select the blocker and press Enter to inspect the associated attempt. Attention
also shows collection errors and approval or recovery gates when present. Its
count does not count every task waiting on a dependency.

### Features

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Overview │ Attention │ [Features] │ Sessions │ Assignments                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 0/2 · attention 1 · list                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:all o:all c:false v:false z:name                                                   │
├─────────┬───────────────────────────────────┬────────────────────────────────────────────────┤
│ Task    │ Description                       │ State / reason                                 │
├─────────┼───────────────────────────────────┼────────────────────────────────────────────────┤
│   1.1   │ Add login endpoint                │ Task is already satisfied                      │
│   1.2   │ Add token validation              │ Existing attempt is blocked; select explicit … │
│ ▸ 1.3   │ Add login form                    │ Ready                                          │
│   1.4   │ Add integration tests             │ Dependency 1.2 is not integrated or satisfied  │
│         │ user-auth                         │ implementing · 1/4 tasks satisfied             │
├─────────┴───────────────────────────────────┴────────────────────────────────────────────────┤
│ ↑↓ Tab Enter / r ? q · a actions                                                             │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Task `1.3` can be considered for launch while `1.4` waits for integration of its
dependency. Press Enter on a task to read its settings and dependency evidence,
or `a` to inspect its available actions. Task rows and the feature summary are
sorted by name; the feature summary occupies its own table row. The `▸` marker
identifies the selection. Each column truncates independently so its vertical
dividers stay aligned.

### Sessions

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Overview │ Attention │ Features │ [Sessions] │ Assignments                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 0/2 · attention 1 · list                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:codex o:all c:false v:false z:name                                                 │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│   a01 · implementation · phase integrated · process exited · report completed                │
│ ▸ a02 · implementation · phase blocked · process exited · report blocked                     │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Tab Enter / r ? q · a actions                                                             │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Here `h`, `codex`, Enter has narrowed the list to Codex attempts. The runner
phase, observed process state, and report outcome are separate fields. Press
Enter for details, then Enter again for activity; use `v` to include older
attempts after a retry. Clear the harness filter with `h`, Enter.

### Assignments

This example extends the scenario with an imported `auth-api` component owned
by `alex`. Its local import binding is ready; that does not establish acceptance
or delivery. Supply `--store` and `--map` to inspect current locally available
shared authority, as described in [Monitor shared assignments](#monitor-shared-assignments).

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Overview │ Attention │ Features │ Sessions │ [Assignments]                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 0/2 · attention 1 · list                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:all o:alex c:false v:false z:name                                                  │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ auth-api · owner alex · ready                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
│                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Tab Enter / r ? q · a actions                                                             │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Use `o`, `alex`, Enter to select this owner's work, then Enter on the assignment
to inspect its pinned revision and available status evidence. Clear the owner
filter with `o`, Enter before returning to other work.

## Navigate and filter

Each view has a list and a details pane. Session rows also have an activity pane.
The header identifies the current pane. Unicode borders separate navigation,
progress, filters, content, and keyboard hints. Features uses a task table when
there is enough room. Terminals narrower than 70 columns or shorter than 18 rows
use a compact bordered list with fewer header and footer lines.

1. Select a row with the up and down arrows.
2. Press Enter to open details. For a session, press Enter again to open activity.
3. Use Tab to cycle through the available panes.
4. Use the up and down arrows to scroll the focused details or activity pane.
5. Press Escape to return to the list, close help or actions, or cancel an action.

| Key | Effect |
|---|---|
| `/`, text, Enter | Search visible row labels; in the activity pane, search loaded activity instead. |
| `s`, value, Enter | Filter by exact status, such as `running`, `ready`, or `blocked`, depending on the view. |
| `h`, value, Enter | Filter by exact harness, such as `codex` or `claude`. |
| `o`, value, Enter | Filter by exact component owner. |
| `c` | Include or hide completed work. |
| `v` | Include or hide older session attempts. |
| `z` | Switch between name and attention sorting. |
| `r` | Refresh observations. |
| `?` | Toggle help. |
| `q` / Ctrl-C | Exit. |

Search is case insensitive; status, harness, and owner filters require exact
values. To clear a filter, press its key and submit an empty value. For search,
press `/`, erase the current text, and press Enter. Escape cancels text entry.
Filters persist when you switch views, so a status filter useful in Sessions
may hide every row in Assignments.

Completed work and older attempts are hidden by default. If a finished feature
or earlier attempt seems missing, toggle `c` or `v` before investigating further.

## Follow a worker session

Open Sessions, select an attempt, and press Enter twice to reach its activity.
The details pane contains the saved attempt and report evidence; the activity
pane helps you understand what the worker is doing.

After the blocker has been addressed and task `1.2` explicitly retried outside
the dashboard, its new attempt `a03` might show activity like this:

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Overview │ Attention │ Features │ [Sessions] │ Assignments                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 1/2 · attention 1 · activity                                               │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:all o:all c:false v:false z:name                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ 14:21:03 message [codex/a03] Checking token validation requirements                          │
│ 14:21:05 command [codex/a03] Read src/auth/token.ts                                          │
│ 14:21:12 file-change [codex/a03] Updated src/auth/token.ts                                   │
│ 14:21:18 command [codex/a03] Run authentication checks                                       │
│                                                                                              │
│                                                                                              │
│                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ normalized · PAUSED — f resume · w raw p pause b older x expand                              │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

This example is paused after scrolling. Press `f` to follow the newest output,
`w` to compare the raw log, or Escape to return to the session list. The progress
counter remains `1/4` while the worker edits files; only integration satisfies
the task. The attention count can still include the older blocked attempt even
when the session list hides it.

Activity follows new output by default. Use these controls while reading:

| Key | Effect |
|---|---|
| Up/down arrows | Scroll activity and pause following. |
| `p` | Toggle following on or off. |
| `f` | Resume following at the newest activity. |
| `b` | Load an older page and pause following. |
| `x` | Expand or collapse activity text; pauses following. |
| `w` | Switch between normalized activity and the original raw log. |
| `/`, text, Enter | Search the activity currently loaded. |

Normalized activity prefers the runner's `.activity.jsonl` sidecar and falls
back to existing logs. Raw mode reads the original worker log. Older sessions
may have only the original log, and an attempt may have no recorded log at all.

History is paged and bounded: the reader retains up to 1,000 entries for the
selected session. Search applies to loaded entries, so use `b` to inspect older
history. Long records can be truncated, and terminal control sequences are
stripped. Consult saved logs and authoritative reports when the visible activity
does not contain enough evidence.

Quiet output does not establish that a worker stopped. Likewise, a successful
harness turn does not complete a runner task. Check the process observation,
report, and integration evidence in details before deciding what to do next.

## Inspect actions and previews

Select a feature, task, session, or assignment and press `a`. Use the up and down
arrows to choose an action and Enter to select it. Unavailable entries explain
their reason. Escape closes the menu or cancels a running action.

For the ready task `1.3` in the Features example, the menu begins like this:

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Overview │ Attention │ [Features] │ Sessions │ Assignments                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Tasks 1/4 · slots 0/2 · attention 1 · list                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ / s:all h:all o:all c:false v:false z:name                                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│   Inspect evidence                                                                           │
│ ▸ Preview launch (select exact tasks and settings)                                           │
│   Display launch command                                                                     │
│   Preview retry (select this task) — unavailable: Retry requires an unsuccessful attempt     │
│   Display retry command                                                                      │
│   Display integrate command                                                                  │
│                                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Tab Enter / r ? q · a actions                                                             │
│ s status h harness o owner c completed v older z sort · ←→ views                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Press Enter on **Preview launch** to enter task `1.3` and inspect a dry run.
The retry preview is unavailable because this task has no unsuccessful attempt.
More actions are available below the visible portion; use `↓` to reach them.
Press Escape to close the menu.

The actions depend on the selected row:

| Action | Result |
|---|---|
| Inspect evidence | Shows the selected item's recorded details. |
| View saved attempt diff | Shows the attempt's diff when its saved worktree and base are available. |
| Focus saved terminal | Focuses an eligible existing terminal in the matching backend context. It does not create or resume a session. |
| Preview launch or retry | Runs a supported CLI dry run after you enter the exact task IDs and any required settings. |
| Preview review or repair | Uses approved managed settings and retains coordination authority checks. |
| Display command | Shows a CLI command for you or your coordinating session to review and run outside the dashboard. |

For a launch preview:

1. Select a local feature or ready task in Features and open `a`.
2. Choose **Preview launch** and enter exact task IDs, such as `1.1,1.2`, then Enter.
   A task row permits only that task; select the feature row for a batch.
3. For an unmanaged change, answer the model and effort prompts. If the plan
   inherits settings, supply an explicit model and, for Codex, effort. Explicit
   settings already recorded in the plan can be used without overrides.
4. Read the preview output in details and scroll with the arrow keys.

A managed preview uses the approved settings without overrides. A retry targets
exactly the selected task and requires a stopped unsuccessful attempt. Executable
previews use `--dry-run --json`, have a 30-second timeout, and limit output to
1 MiB. A successful preview does not launch or retry anything.

Plan approval, final approval, and archive previews are unavailable in the
dashboard because their CLI validation or configured checks may write files.
Their entries explain the limitation and offer display-only commands. Integration,
reconciliation, and cleanup are also commands to execute outside the dashboard.
Review displayed commands and replace placeholders or supply required arguments
using the [CLI reference](../README.md#cli-reference).

## Monitor shared assignments

To include shared Store authority, supply both a local Store checkout and a
machine map:

```sh
openspec-runner dashboard --store ../coordination-store --map ./repositories.yaml
```

Both paths resolve from the current directory. The map must match the repository
identities; see the [team operator reference](team-workflow-reference.md) for
Store and map setup.

With these options, the dashboard inspects locally available committed manifests
and authoritative branch/history status, including shared components associated
with the current repository. It does not fetch or pull Store updates, and it
does not monitor workers running in other repositories.

Without a Store, imported assignments show their pinned revision. That is useful
local evidence, but it does not establish current shared authority. Use Assignments
to inspect the revision and ownership before acting on a delegated component.

## Read progress correctly

These states describe different milestones:

| State | What it means |
|---|---|
| Task completed | The worker submitted an implementation result; integration may still be pending. |
| Task integrated | The runner merged the result, passed checks, and updated the canonical checkbox. |
| Managed feature completed | Review and archival finished on the retained integration branch; delivery to the main branch remains separate. |
| Component accepted | The coordinator accepted an exact component commit. |
| Component delivered | Delivery evidence was recorded for the shared component; acceptance alone does not establish delivery. |

If a source cannot be read after a successful observation, the dashboard retains
that observation marked **STALE**, with its original collection time. Stale tasks
are not ready; process and terminal observations become unknown. Investigate the
error in Attention, correct the underlying access or data problem, and refresh.
Browsing does not recover, migrate, or rewrite the underlying state.

## Troubleshooting

| Symptom | What to check |
|---|---|
| The command prints text and exits | Both input and output must be terminals for interactive mode. Remove pipes/redirection and omit `--once` or `--json`. |
| No matching work | Clear search and exact filters; toggle `c` for completed work and `v` for older attempts. Check `--change` and the current repository. |
| Activity appears frozen | Look for `PAUSED`; press `f` to follow newest activity, then check process and report evidence if output remains quiet. |
| Activity is missing or incomplete | Try `w` for the raw log and `b` for older pages. Check details for a saved log path and activity errors. |
| Terminal focus is unavailable | Read the action's reason. Finished or ambiguous sessions, missing worktrees, and mismatched backend context cannot be focused. |
| A row is stale or reports unknown process state | Inspect Attention and the collection error, restore access to the source, and press `r`. |
| Shared options are rejected | Supply `--store` and `--map` together and check their paths and repository identities. |
| Lines are cut off | Widen the terminal. Narrow or short terminals use a compact bordered list and truncate displayed lines. Use `--json` for a full snapshot of collected evidence. |
| A preview is rejected | Read its blocker, check exact task IDs and approved settings, and inspect current CLI status before retrying. |

For execution problems after leaving the dashboard, use the
[recovery reference](../README.md#recovery-and-plan-changes) and
[CLI troubleshooting](../README.md#troubleshooting). To return to the documentation
index, see [all guides](README.md).

Copilot CLI (`copilot`) and VS Code Copilot (`copilot-vscode`) can execute runner-managed workers. See the [Copilot setup and verification guide](COPILOT_SUPPORT_VERIFICATION.md) for model selection, native hooks, completion evidence, and recovery.
