# Native Windows verification

Verification date: 2026-10-29. The native implementation covers `codex`,
`claude`, `copilot`, and `copilot-vscode` for local x64 NTFS repositories,
Git worktrees, and manual terminals. Authenticated acceptance is tracked
separately below.

## Environment and prerequisites

The test host used Windows 11 Pro x64 (10.0.26300), local NTFS, Node 24.21.0,
pnpm 11.7.0, Git 2.51.1.windows.1, and
PowerShell 7.6.7. The Linux regression environment used Ubuntu 22.04 in WSL
and checksum-verified Node 22.13.0. No persistent PATH, authentication, editor
profile, or global Git settings were changed for verification.

Install OpenSpec and the selected harness normally, and make their executable
entry points available to the runner process. Install/build the runner, then
initialize a disposable project with an explicit model:

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm test
node ./bin/openspec-runner.js init --agent copilot --default-model YOUR_MODEL --json
```

Set `worktrees: git` and `terminal: manual` in `openspec/runner.yaml`.
`auto` also selects these resources on Windows. Use PowerShell 7 for returned
operator commands. These commands preserve spaces, quotes, shell punctuation,
Unicode, and multiline arguments. Internal child launches use argument arrays
without a command shell. Recognized VS Code, npm, and pnpm Node wrappers are
resolved to their direct entry points; custom wrappers with extra environment
or fixed arguments are rejected rather than silently reinterpreted.

Windows hook installation pins the invoking Node and runner entry points in
the hook's `powershell` command, so an already-open editor's old PATH cannot
select another runner. Reinstall/review hooks when moving that installation
or sharing a project with another host. The POSIX hook command stays portable.
Existing differing user hook files are preserved; only exact recognized
runner-generated configurations are migrated.

## Harness acceptance matrix

| Harness | Installed capability | Native simulated lifecycle | Authenticated prompt | Live managed lifecycle/recovery |
| --- | --- | --- | --- | --- |
| Codex | Native CLI not found on normal user PATH | Passed | Pending | Pending |
| Claude Code | Native CLI not found on normal user PATH | Passed | Pending | Pending |
| Copilot CLI | Passed, 1.0.105 | Passed | Passed, `auto`, tools disabled | Pending |
| VS Code Copilot | Passed, VS Code 1.144.0 x64, bundled Copilot Chat 0.72.0 | Passed | Pending | Pending |

VS Code was the normal installation/profile; Copilot is bundled in this
version and therefore absent from `--list-extensions`. Detection validates
the bundled manifest belonging to the selected editor entry point. An
installed capability check does not establish login or model availability.
The Copilot prompt returned `WINDOWS_SMOKE_OK`; it was a disposable no-tool
inference check, not a runner task/report/stop acceptance test. OpenSpec was
also absent from the normal native user PATH. No missing tools were installed
and no login was initiated automatically.

The four-harness matrix covers implementation, task integration, a blocking
managed review, repair/integration, a fresh review, final approval boundaries,
JSON model/planning output, and read-only launch preview. It checks protocol
identity for Codex and Claude, Copilot hook ownership, and editor launcher
exit versus agent completion. Additional tests cover storage replacement,
exclusive publication, process identity mismatch, detached descendants,
termination uncertainty, dashboard cancellation, junction containment, and
unsupported-resource preflight. Simulated tools do not prove authenticated
compatibility with every installed version or subscription.

## Boundaries and recovery

- Herdr, Orca, and Worktrunk remain unsupported on native Windows; select
  Git/manual resources. WSL remains a separate execution environment.
- Delegated component execution is explicitly unsupported on Windows until
  equivalent protected-context write restrictions are verified. NTFS mode
  bits alone do not establish that protection. Local managed features remain
  eligible. Tests for these unsupported combinations are explicitly skipped
  on Windows and continue running on Linux.
- File bytes are flushed before same-directory replacement. Windows does
  not support the Unix directory-fsync operation, so power-loss durability
  of directory entries is weaker. Actual file-write/rename errors propagate;
  retries of at most three seconds preserve the existing destination during
  sharing conflicts. Short lock contention with another live local reporting
  process also waits at most three seconds on Windows and Linux. Stale,
  unknown, and nested lock owners are never removed automatically.
  Log/activity access inherits the parent directory's Windows ACLs; Unix
  `0600` mode assertions do not establish equivalent Windows ACL isolation.
- Process creation tokens are platform-specific. Legacy numeric Linux
  tokens and cross-platform receipts cannot authorize Windows recovery.
  Unknown metadata or uncertain termination blocks completion, retry, and
  cleanup; retain the worktree and inspect its processes/session. A missing
  supervisor alone does not prove its descendants stopped. Editor cleanup
  never terminates the user's GUI as a shortcut.
- Automated OS-SIGINT injection is skipped on Windows because Node's
  `process.kill(SIGINT)` forcibly terminates there. Dashboard action-tree
  cancellation is tested natively; interactive console Ctrl-C restoration
  remains a manual smoke check.

## Verification record

The final native Windows `pnpm test` passed 241 tests, with 133 explicitly
skipped and zero failed (374 total). This includes reopened-binding preflight,
controlled NTFS sharing locks, and live-owner reporting contention. The final
`pnpm pack --dry-run` passed. The full Linux `pnpm test` passed 363 tests,
with 14 explicitly skipped and zero failed (377 total). Linux skips include
the Windows-only probes and unavailable optional installed-tool acceptance.
Review fixes add regression coverage for surviving descendants,
uncertain cleanup, custom wrappers, pinned hooks, and a real empty Git hooks
directory. The focused review-fix run passed all 28 tests.

Linux regression tests run from a disposable WSL-native filesystem snapshot
with the exact locked Linux dependencies. Running directly from the mounted
Windows drive missed two dashboard startup deadlines; both checks passed
with unchanged deadlines on the native Linux filesystem. A subsequent full
run exposed a Claude stream/begin lock race, reproduced by the short-contention
test and addressed by the shared bounded wait.

The fresh review identified four important issues: surviving descendants,
cleanup after uncertain termination, command-wrapper semantic loss, and hooks
selecting stale PATH entries. Each has regression coverage. No minor findings
were deferred. Implementation used the existing checkout on a feature branch
and one coupled implementation commit; the tradeoffs are less filesystem
isolation and a larger review/bisection unit.

Live acceptance remains pending for each full row above: use separate
disposable repositories and follow the Claude/Copilot verification guides.
Record actual sessions, accepted reports, terminal results, acknowledged exits,
review/repair/final approval, interruption, cancellation, exact resume where
supported, and cross-harness role selection. Do not describe all four
harnesses as live-verified until these checks pass.
