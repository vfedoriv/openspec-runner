---
name: openspec-runner-review
description: Review a managed OpenSpec feature in an assigned fresh reviewer checkout and submit structured findings without changing implementation or planning artifacts.
---

Require the change, attempt, review base, reviewed head, fingerprint, and exact begin/report commands in the runner prompt. Begin in the assigned checkout using that command. Codex uses its actual CODEX_THREAD_ID; Claude uses the supplied reserved session UUID. Stop if registration fails.

Read the approved proposal, specs, design, and tasks. Review the entire base-to-head feature diff and relevant surrounding code against its acceptance criteria. Read implementation verification evidence from runner status/reports when useful and run appropriate checks. Do not edit tracked files, commit, revise the plan, integrate, or archive. Keep generated output outside the tracked tree or in ignored build paths.

Report actionable findings using the runner's schema: id, category, location, impact, correction. Categories correctness, security, spec, and verification block completion; style and improvement are advisory. Categorize by actual effect, not preferred style or severity labels. Explain concrete evidence and behavior, and use file/line or command locations. Reuse supplied finding IDs when an earlier issue remains; omit resolved findings and give new issues new IDs. Review the whole feature again after repairs, not only the modified lines.

Submit outcome completed with a findings array (empty when clear), the exact head/fingerprint, a summary, and nonempty verification evidence. A completed review can contain blockers. If checks cannot run or scope cannot be evaluated, report blocked with evidence instead of claiming a clean review. A failed required check is a verification blocker when you can describe the failure accurately.

Write the report at the runner-supplied external path, submit using its exact report command, and end immediately after acceptance. The supervising process records exit; an accepted report alone does not establish a finished review. Do not close terminals, kill processes, delete worktrees, or resolve your own report by editing code.
