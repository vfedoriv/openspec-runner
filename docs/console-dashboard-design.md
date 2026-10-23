# Console Dashboard with Guided Actions

## Summary

Add an interactive `openspec-runner dashboard` for monitoring the current repository and linked coordination work. It should make current activity, blockers, evidence, and next steps easy to inspect.

The first version supports Codex and Claude Code, includes a readable activity feed, and follows existing platform support—including WSL on Windows. Workflow changes remain explicit CLI operations.

## Views and interaction

Use five tabs with selectable rows and a detail pane:

| View | Content |
|---|---|
| **Overview** | Feature phases, task counts, worker slots, recent activity, and attention items |
| **Attention** | Failed/blocked attempts, interrupted integration, missing reports, pending approvals, planning drift, stale assignments, and data errors |
| **Features** | Tasks, dependencies, readiness reasons, execution settings, attempt history, verification, findings, repair limits, integration and archive status |
| **Sessions** | Implementation/review/repair workers, saved identities, execution state, terminal/worktree details, readable activity, and raw logs |
| **Assignments** | Components, owners, dependencies, assignment/submission/acceptance/delivery state, and inspected coordination revision |

- Default to Overview and active work. Allow completed features and older attempts through filters.
- Preserve distinctions between completed, integrated, accepted, and delivered work. Show task counts rather than an estimated feature percentage.
- Provide search, status/harness/owner filters, and sorting by name or attention priority. Search and filtering apply to the current view.
- Use arrows for selection, Tab for pane focus, Enter for details, Escape to go back, `/` for search, `r` for refresh, `?` for help, and `q` to exit.
- Provide an action menu for inspecting evidence, viewing diffs, focusing existing terminals, and displaying commands or supported dry-run previews. Explain unavailable actions.
- Preview execution is an explicit selection. Launch/retry previews require exact task selection; unmanaged tasks requiring inherited settings prompt for explicit model/effort. Approval previews require an existing settings file.
- Keep launch, retry, approval, integration, recovery, assignment changes, archival, and cleanup execution outside the dashboard. Display the applicable command without executing it.
- Reuse existing task attachment behavior. Review/repair sessions may focus a recorded terminal through the existing adapter; otherwise show inspection details. Never automatically start or resume a worker.

## Data and CLI architecture

Build a shared dashboard reader, harness activity parsers, action helpers, and an Ink/React terminal interface. Keep coordination rules in existing domain modules and process/platform interactions in adapters.

Expose:

```text
openspec-runner dashboard
openspec-runner dashboard --change NAME
openspec-runner dashboard --store PATH --map FILE
openspec-runner dashboard --once
openspec-runner dashboard --json
```

- `--change` filters local features/tasks/sessions and their associated imported assignments.
- `--once` prints a plain snapshot; `--json` emits one versioned snapshot. Non-interactive terminals default to plain output.
- Require `--store` and `--map` together. Reuse existing repository identity and map validation, including relative-path resolution.
- Discover local changes from OpenSpec change directories, execution state, feature state, and component bindings. Include retained completed features and report malformed items individually.
- Without a Store, show imported assignment information and its pinned revision. With a Store, discover committed manifests and include shared features associated with the current repository; show their component summaries without monitoring other repositories’ workers.
- Resolve coordination status through the existing authoritative branch/history rules. Never fetch, pull, or treat imported history as current shared history.
- Define a `DashboardSnapshot` containing version, collection time, repository identity, feature/task/session summaries, assignments, attention items, and source errors. Reuse existing types for detailed reports and settings.
- Refresh every two seconds using one asynchronous collector process at a time, so synchronous domain reads do not freeze keyboard input. Retain the last successful data for failed sources and mark it stale.
- Keep the reader observational: no runner locks, migrations, recovery, validation commands that execute checks, or state writes.
- Separate recorded phase, report outcome, process observation, and terminal availability. Use existing process-identity evidence where supported; otherwise show uncertainty. Log silence never proves a worker has stopped.

## Readable activity and compatibility

Normalize available harness output into messages, tool/command activity, file-change summaries, diagnostics, and turn outcomes. Parse and format locally; no model calls are needed.

- For newly started Codex workers, enable `codex exec --json` when advertised by capability detection. Fall back to current text output otherwise. The documented stream includes messages, commands, file changes, and turn outcomes. [Official Codex documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
- Keep Claude’s existing stream mode. Normalize complete text and tool-use/result blocks, correlating tool IDs; omit token-level streaming from this version. [Claude documentation](https://code.claude.com/docs/en/headless)
- Capture normalized activity in an additive, versioned sidecar beside each new worker log, with observation times and attempt identity. Preserve existing logs and supervision/report checks.
- Activity collection is best-effort: parsing or sidecar failures must not change worker success, session ownership, report acceptance, or integration eligibility.
- Existing structured logs receive best-effort parsing; existing text logs remain readable without invented timestamps or reconstructed events.
- Follow activity by default. Scrolling pauses following; a visible control resumes it. Allow searching and expanding entries, plus switching to raw logs.
- Retain the latest 1,000 entries per selected session in memory and read older entries in bounded pages. Handle partial lines, Unicode boundaries, oversized records, log truncation, and missing files.
- Strip terminal control sequences from displayed content. Unknown or malformed events become diagnostic/raw entries.
- Treat a harness turn outcome as activity evidence, never as runner task completion. Preserve existing state versions and approval rules.

## Verification and defaults

Implement and verify the reader first, then activity capture/parsers, then the interactive views and guided actions.

Test with temporary repositories, fake harnesses, and terminal fixtures:

- Managed/unmanaged features, pre-launch tasks, version 1/2 execution state, completed features, and multiple attempts.
- Dependency readiness, planning drift, advisory versus blocking findings, repair limits, interrupted integration, and missing reports.
- Imported assignments, stale/revoked assignments, authoritative coordination revisions, invalid maps, and unavailable Store data.
- Both harnesses’ messages and tool activity, unsupported structured output, legacy logs, malformed/partial events, bounded reads, and sidecar failures.
- Unchanged completion/identity gates despite activity events.
- Stable selection during refresh, narrow terminals, search/filtering, paused following, asynchronous previews, plain/JSON output, and terminal restoration on exit.
- No persisted changes from browsing or previews; attachment must never create a session.

Run `pnpm test`, exercise snapshot and preview commands under a supported platform, and run `pnpm pack --dry-run`. Manually verify interactive navigation and attachment in WSL/Linux.

Defaults: one operator, one current repository, explicitly supplied local coordination data, keyboard-first interaction, in-dashboard attention indicators, and no background service. Defer multi-repository worker monitoring, messaging/stopping agents, cost accounting, desktop notifications, and direct workflow execution.
