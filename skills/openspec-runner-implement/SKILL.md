---
name: openspec-runner-implement
description: Implement exactly one assigned OpenSpec checkbox in an openspec-runner task worktree through the selected harness, verify it, commit it, and report a structured outcome.
---

Require the change name, task number, attempt ID, harness, and registration identity supplied by the runner prompt. Begin inside the assigned worktree with the exact `openspec-runner begin ...` command in that prompt. Codex registers its actual `CODEX_THREAD_ID`; Claude registers the reserved UUID supplied with `--session`. If registration fails, stop before editing. Do not switch harnesses or inherit a Codex identity in a Claude worker.

Read the change's artifacts and the assigned task. Implement only that checkbox, perform its stated verification, and commit the implementation. Do not alter tasks.md, execution.yaml, runner.yaml, other shared change artifacts, or move to another checkbox. If the task needs planning changes or cannot be completed, report blocked with the reason and stop. Do not merge or integrate your own result.

Write report JSON to a temporary path outside the worktree with these fields:

```json
{
  "attempt": "supplied-attempt-id",
  "task": "2.1",
  "session": "actual harness session identity",
  "outcome": "completed",
  "commit": "full-HEAD-commit-SHA",
  "summary": "What changed",
  "verification": ["Exact check performed and its result"]
}
```

For completed results, the worktree must be clean at the reported commit. For failed or blocked outcomes, include concrete evidence and omit commit if there is none. Submit with `openspec-runner report <change> <task> --attempt <id> --file <absolute-report-path>`. The runner stores the report under Git's common directory. Wait for the report command to return successfully, then end your turn immediately. The supervised Codex or Claude process exits naturally and preserves the session/log for review. Do not kill yourself, close terminals, remove worktrees, or continue to another checkbox. If a report is rejected, correct it before ending the turn. Never report success based solely on a commit or an idle terminal.
