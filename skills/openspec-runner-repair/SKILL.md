---
name: openspec-runner-repair
description: Repair supplied blocking review findings for one managed OpenSpec feature in an isolated runner attempt, verify and commit the repairs, and report the outcome.
---

Require the change, attempt, starting head, fingerprint, findings, and exact begin/report commands from the runner. Begin inside the assigned checkout. Codex uses its actual CODEX_THREAD_ID; Claude uses the reserved UUID. Stop before editing if registration fails.

Read the approved artifacts and supplied blocking findings. Repair those issues with focused implementation/test changes and appropriate verification. Do not address optional suggestions, expand requirements, edit planning artifacts or checkboxes, or change execution settings. If the repair requires a spec change, cannot be verified, or the finding cannot be resolved within scope, report blocked with the reason. Do not silently dismiss findings.

Commit repairs and leave a clean worktree. Submit the runner's report schema with exact attempt/session/head/fingerprint, outcome, full repair commit SHA for a completed outcome, summary of addressed findings, and nonempty verification evidence. Write the input at the supplied external report path and use the exact report command. End immediately after acceptance.

The coordinator integrates the repair and launches a fresh whole-feature review. Your report cannot close findings or complete the feature. Do not integrate, archive, close terminals, remove worktrees, or start another repair round yourself.

For the `copilot` or `copilot-vscode` harness, use the runner-provided begin/report commands in the assigned worktree. `begin` resolves the actual hook-confirmed root session; use the returned session in the report and never use CODEX_THREAD_ID or invent a session ID. Require an explicit model recognized by the selected Copilot surface, omit effort, and do not translate model selectors between CLI and editor. A requested model is not observed model evidence. Invoke installed skills with `/openspec-runner-NAME`.

Copilot completion requires matching native hook ownership and an accepted report followed by root stop evidence. CLI additionally requires successful supervised process exit. VS Code records agent-turn completion while the editor window may remain open; launcher exit alone never completes a worker. If hook delivery, supervisor recovery, or editor liveness is uncertain, retain resources and inspect the saved chat rather than redispatching. Editor attach identifies the worktree and saved chat without claiming exact chat resume. Existing approval, report, delegation, verification, and archival boundaries still apply.
