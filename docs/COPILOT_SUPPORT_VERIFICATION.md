# Copilot worker verification

Copilot CLI and VS Code Copilot are distinct harnesses: `copilot` and
`copilot-vscode`. Both execute implementation, review, and repair workers.
Use a supported runner host, including native Windows with Git/manual resources
or the verified Herdr, Orca, and Worktrunk integrations.
See [Windows verification](WINDOWS_PORTABILITY_VERIFICATION.md) for the native
acceptance matrix and remaining live checks. Hooks, Git, the runner, and the agent must see
the same worktree filesystem and run in the same execution environment.

## Install and configure

Authenticate the standalone `copilot` CLI or install/authenticate GitHub Copilot
Chat in VS Code. Ensure `openspec-runner`, `git`, and the selected worker
executable are available on that host's PATH.

```sh
openspec-runner init --agent copilot --default-model YOUR_CLI_MODEL --json
# Or, in another project:
openspec-runner init --agent copilot-vscode --default-model YOUR_EDITOR_MODEL --json
```

Use a real model selector offered by the authenticated surface. The runner does
not translate CLI names to editor model selectors. `models --agent HARNESS
--json` reports that model discovery is non-exhaustive. Effort settings and
calling-session model inheritance are unsupported for both Copilot adapters.

Init installs eight skills in `.github/skills/` and the runner-owned
`.github/hooks/openspec-runner.json`. Commit these with runner configuration
before launching a worker. Existing runner.yaml is preserved: explicitly add
the new version-2 agent entry when initializing an already configured project.
`init --agent all` installs shared Copilot skills once without inventing model
defaults. Existing user hook files and editor settings remain in place.

The installed hooks use the VS Code compatible names/payloads, also recognized
by current Copilot CLI. Supported runtimes must deliver root prompt, stop, and
tool events. Disabled, blocked, incompatible, or missing hooks prevent successful
worker completion. Hook permission failures do not grant tool permissions.

Example version-2 entry (substitute a real model):

```yaml
version: 2
defaultAgent: copilot
agents:
  copilot:
    defaultModel: YOUR_CLI_MODEL
    allowedTools: []
    options:
      startupTimeoutMs: 60000
      completionTimeoutMs: 1800000
worktrees: git
terminal: manual
```

Review explicit CLI `allowedTools` for your task; an empty list does not grant
unattended tool use. The runner never adds an allow-all permission flag. Editor
tool permissions remain in VS Code. Editor options additionally accept
`executable` (default `code`) and `profile`. The editor must discover the generated
custom agent and honor its requested `model`; a hook session is not evidence of
the observed model. `hookFormat` accepts `copilot`/`vscode` for adapter settings;
the shared installed hook file uses the compatible PascalCase schema for both.

## Automated verification

Run `pnpm test` on Linux/WSL and Windows, and `pnpm pack --dry-run`. New behavior tests cover
model/options validation, installation preservation, ownership/replay rules,
completion evidence, and fake CLI/editor workers executing implementation,
whole-feature review, repair, integration, and a fresh final review.
Fake editor launchers exit before their agents report and stop. These tests
exercise orchestration; they do not prove compatibility with an authenticated
editor version or subscription.

## Authenticated smoke checklist

Later Windows live runs are recorded in
[real Windows harness acceptance](REAL_WINDOWS_HARNESS_ACCEPTANCE.md).
The corrected VS Code launcher passed implementation through integration with
GPT-6 Luna and the exact generated custom agent. Copilot CLI passed implementation
and review with diagnostic launch adjustments. The production adapter now uses
new prompt mode and hook-observed identity. The 2026-11-04 production retest
passed implementation/integration and review execution; its review reported a
fixture line-ending defect, leaving the fixture in `fixing`.
The [expanded live record](LIVE_ACCEPTANCE_2026-11-04.md) adds real repair/fresh
review, cancellation, interrupted-supervisor recovery, VS Code managed review and interrupted-supervisor recovery,
and Orca-backed inference. The full cross-product checklist remains open.

Automated validation on 2026-10-29: Ubuntu/WSL, Node 22.13.0, pnpm 11.7.0;
`pnpm test` passed with 350 passed, 2 skipped, and 0 failed. Package dry-run
passed. Fake-worker CLI checks exercised JSON model/planning output, read-only
launch previews, implementation/review/repair, integration, and interrupted
supervisor recovery for the editor. This is the historical pre-smoke automated
record; the later authenticated results above supersede its live-testing status.

Full CLI/editor acceptance, including cancellation and recovery, remains
**pending**. The production startup correction uses `--trust-folder -p PROMPT`
without a reserved session ID; trust applies only to the new invocation and does
not grant tool permissions. Existing reserved attempts require an explicit fresh
retry after inspection. Attachment uses `--resume` with the observed session ID.
The [production retest](REAL_WINDOWS_HARNESS_ACCEPTANCE.md#copilot-production-launcher-follow-up--2026-11-04)
verifies startup and review execution, not the full checklist. Repeat smoke
validation on the target machine after changes.
Record worker and editor versions, OS/host, Copilot extension version,
hook schema, requested model, and any independently observed model evidence.

- [ ] Preview a committed change with `launch CHANGE --tasks 1.1 --agent HARNESS
  --dry-run --json`. Confirm the harness, model, and frozen options.
- [ ] Launch the disposable task. For `terminal: manual`, execute its returned
  worker command once in the assigned worktree.
- [ ] Confirm the hook prompt binds the actual root session to the exact
  worktree. Another open editor chat must not claim that attempt.
- [ ] For VS Code, confirm the generated runner custom agent appears and its
  requested editor model is selected. Confirm the chat opened in the assigned
  worktree, even when unrelated editor windows were already open.
- [ ] Confirm the agent runs `begin`, verifies/commits its result, and reports
  using the session returned by `begin`.
- [ ] Confirm the report alone cannot integrate. CLI needs root stop plus zero
  process exit; editor needs root stop plus its explicit agent-stop completion
  receipt. The editor window can remain open.
- [ ] Repeat with a managed reviewer, a blocking finding, a repair worker, and
  a fresh reviewer. Confirm the existing final user approval remains required.
- Not applicable to the current shared-record contract: Copilot assignments are
  rejected by its Codex/Claude-only validator, and native Windows delegation is
  excluded. Test delegated Copilot execution only after that contract is extended.
- [ ] Disable hooks or cancel a worker. Confirm no result integrates and the
  saved worktree/log/session remain available for inspection.
- [ ] Interrupt the editor supervisor. Retry/cleanup must retain uncertain
  editor activity. A later matching stop can establish stopped status through
  recovery; it must not invent a successful execution receipt.
- [ ] Attach to CLI using only the confirmed exact session ID. For editor,
  locate the existing chat in the recorded worktree; attach never submits a new
  worker prompt or claims that opening a folder resumes an exact chat.

Hook payloads and model selectors vary across releases. If the installed runtime
cannot honor these contracts, inspect diagnostics and retain the attempt; do not
substitute CLI execution for an editor worker or bypass a completion check.
