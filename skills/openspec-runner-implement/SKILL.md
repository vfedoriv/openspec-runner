---
name: openspec-runner-implement
description: Implement exactly one assigned OpenSpec checkbox in an openspec-runner task worktree, verify it, commit it, and report a structured outcome.
---

Require the change name, task number, and attempt ID supplied by the runner prompt. Begin inside the assigned worktree with `openspec-runner begin <change> <task> --attempt <id>`; it registers CODEX_THREAD_ID. If registration fails, stop before editing.

Read the change's artifacts and the assigned task. Implement only that checkbox, perform its stated verification, and commit the implementation. Do not alter tasks.md, execution.yaml, runner.yaml, other shared change artifacts, or move to another checkbox. If the task needs planning changes or cannot be completed, report blocked with the reason and stop. Do not merge or integrate your own result.

Write report JSON to a temporary path outside the worktree with these fields:

```json
{
  "attempt": "supplied-attempt-id",
  "task": "2.1",
  "session": "actual-CODEX_THREAD_ID",
  "outcome": "completed",
  "commit": "full-HEAD-commit-SHA",
  "summary": "What changed",
  "verification": ["Exact check performed and its result"]
}
```

For completed results, the worktree must be clean at the reported commit. For failed or blocked outcomes, include concrete evidence and omit commit if there is none. Submit with `openspec-runner report <change> <task> --attempt <id> --file <absolute-report-path>`. The runner stores the report under Git's common directory. After a successful report, stop and leave the session available for review. Never report success based solely on a commit or an idle terminal.
