# Real Windows harness acceptance — 2026-10-29

The [2026-11-04 Copilot production-launcher follow-up](#copilot-production-launcher-follow-up--2026-11-04) supersedes the original CLI diagnostic-only launch status.

These are authenticated model runs on Windows, distinct from the simulated
worker tests and the installed resource-backend checks. The disposable fixtures
use real OpenSpec 1.15.0, Git worktrees, and runner `840be0c` plus the
VS Code launch correction merged into `dev` at `5e07c79`, plus the Codex
permission correction committed at `9b4865e`.
They ask the agent to create `greeting.txt`, verify its exact content with Node,
commit it, and submit a report. Successful runs integrate the result; Claude, Codex, and
Copilot CLI also execute a managed feature reviewer. Final approval is not recorded.

## Results

| Harness | Installed version | Requested model | Result |
| --- | --- | --- | --- |
| Claude Code | 2.1.312 | `claude-haiku-5-5` | Implementation, verification, commit, accepted report, supervised exit, integration, and review passed. Observed model matches the request. |
| Codex | 0.165.0 | `gpt-6-luna`, low effort | Passed implementation, verification, commit, accepted report, supervised exit, integration, and independent managed review through the corrected production launcher. |
| Copilot CLI | 1.0.105 | `auto` | Implementation, verification, commit, accepted report, root stop, supervised exit, integration, and review passed with the diagnostic launch changes below. |
| VS Code Copilot | VS Code 1.144.0; bundled Copilot Chat 0.72.0 | `Auto (copilot)` | Passed implementation, verification, commit, report, root stop, supervisor completion, and integration through the corrected production launcher. Runtime events confirm the exact generated worker agent and GPT-6 Luna tool calls. Real managed review remains pending. |

Copilot's authenticated model picker offers only automatic routing for this
account's Free plan. Explicit Luna and Haiku identifiers were rejected before
inference. The earlier editor run displayed GPT-6 Luna as its automatic choice;
that does not establish the model used by the CLI retest.

## Diagnostic setup and limitations

The original launch paths did not pass these three retests. Copilot CLI
adjustments below remain test-driver diagnostics. The VS Code and Codex
corrections are implemented in runner source and were retested without launcher overrides:

- **Copilot CLI:** start a new prompt session with `--trust-folder -p PROMPT`,
  omit `--session-id`, and capture its actual root session through the existing
  nonce-bound ownership hook. This CLI rejects combining `--trust-folder` with
  `--session-id`. The test grants `shell` and `write` tools only for the disposable
  worker invocation; it does not alter global permissions. The shipped adapter
  still reserves a session and needs a corresponding implementation change.
- **Codex:** a per-worktree named profile extends `:workspace`. It grants the
  assigned Git administrative directory, object storage, runner runtime, report
  directory, and its branch/ref-log namespace (directory create rights are needed
  for Windows Git lock files). Common Git configuration and other branch
  namespaces stay read-only. The prompt pins this installation's Node/runner
  executable, avoiding a global wrapper that cannot resolve inside the native
  sandbox. Temporary files have an explicit runner-owned location. A no-model
  effective-permission check rejects missing or unexpectedly broad grants before
  inference, including on resume. The installed CLI retains the correct named
  profile even with process-local legacy `sandbox_mode` overrides; incompatible
  diagnostics fail closed. Native probes verify Git writes and denied writes to
  common configuration, main, `.git`, `.codex`, `.agents`, and `.aws`. No global
  configuration, credentials, or ACLs were changed. Earlier failed diagnostic
  attempts remain in the evidence directory.
- **VS Code:** open the assigned folder/profile before submitting any prompt.
  Initialize editable Agent mode and select the generated custom agent with
  empty chat commands; these do not perform model inference. Only then arm the
  nonce-bound ownership lease and submit the task through `code chat --mode NAME`
  with cwd targeting. Chat window/profile flags suppress that cwd behavior, so
  they are excluded from task submission. The original chat selected `vscode-ask`
  in native session events even while its UI label read Agent; custom-mode lookup
  is synchronous and can silently preserve the prior mode when unresolved.
  The corrected live run selects the exact generated agent, executes PowerShell
  and file edits, and produces an accepted report followed by a matching stop.
  The user approves workspace trust and native command permissions. No security
  settings or permission prompts were changed by automation.
- **Claude:** explicitly permit its native `PowerShell` tool in the disposable
  fixture. Bash-only permissions caused the first run to stop before edits.

These small task and review tests do not establish repair, cancellation, recovery,
mixed-harness operation, or the full acceptance checklists for any harness.
Git/manual resources were used; these runs do not combine real model inference
with Herdr or Orca terminals.

## Evidence

The ignored local evidence directory is
`.superpowers/sdd/2026-10-29-real-harnesses/`. It retains fixture repositories,
worktrees, runner logs, hook leases, reports, and the diagnostic driver.

- Claude successful implementation: `ac4eee93-a220-42ce-9156-e49a909d5050`;
  review: `b26a667e-c21d-4913-97b3-5d74f7f3d405`.
- Copilot successful implementation: `4413b58e-467e-4b87-888f-10285301c401`;
  root session: `37586b32-d56f-474c-a019-1fbea0148f9e`;
  commit: `63c668a19ed55af229eb03fe67b2ae955f20796d`;
  review: `c6b1f17a-bbb6-4b27-b720-fd644c627d7d`.
- Codex historical blocked retests: `codex-retest-*`, `codex-auto-review-*`.
- Corrected Codex implementation: `55520544-0a89-4c69-b300-ab6c366fe0f0`;
  session `01a188ca-bfcc-7dc1-946f-fbd88b8141c5`;
  commit `475936826713511ee37f1dde740a52d01540ca22`. Accepted report,
  zero supervisor exit, and integration are saved in `codex-scoped-*`.
  Independent managed review `32887a32-d605-4e60-965f-fbed8cee4cb3`
  completed with accepted report, zero exit, and no findings.
- Final launcher including effective-permission preflight: implementation
  `5d68e65d-b0d1-481a-8407-4faccc8273f6`, session
  `01a188d8-823d-7273-bcaa-c741b9dfd17b`, commit
  `4aabde47dc961c885ec822ccfa4d9a2df9cc3549`; integrated. Fresh review
  `353a86c7-9b85-415f-877e-cf2a8ca00a6b`, session
  `01a188d9-b974-7c62-b439-813029f773b2`; accepted report, no findings.
  Both supervised processes exit zero. See `codex-verified2-*` evidence.
  Git's automatic shared ref maintenance emitted a denied `packed-refs.lock`
  warning; the scoped branch commit succeeded and the worktree was clean.
  Shared maintenance remains outside worker permissions.
- VS Code blocked retest: `f711ad36-05a2-4e0c-b8a6-02cdce805d91`.
  After manual trust, session `a7a9d7ad-6ef4-4540-9d47-24ca0eb89d4f`
  bound at `17:03:33.924Z` and stopped at `17:03:52.938Z`, after the
  supervisor had exited at `17:01:38.040Z`; `reportAccepted` is false.
- Fresh VS Code attempt `3025f0c0-0164-4258-8f22-11dbaf19f41d`
  was started after trust was confirmed. Its chat displayed
  `Auto (gpt-6-luna)` and consumed 0.2 credits; session
  `e66d896a-1e49-4bb7-9071-7496f4be2c7d` bound at
  `17:10:43.208Z` and stopped at `17:10:56.160Z`, with
  `reportAccepted: false`. The agent explicitly reported that shell and
  file-writing tools were unavailable. It did not register or edit files.
  Its native `subagent.selected` event identifies `vscode-ask`, with only
  read/search tools. The generated mode was not selected for this request.
- Nested fixtures under the previously trusted
  folder hit Windows Git path-length limits, including `$GIT_DIR too big`;
  those preparation failures are retained and are not model-run results.
  Explicit retry `413f2f02-118b-4e18-aa40-e23133a77bb3` also failed
  worktree preparation with that error; its built-in Agent-mode diagnostic
  never started. No extra folder-trust prompt was accepted by automation.
- Corrected production-launcher implementation:
  `ed8dc6d7-7f30-4ded-98c7-c68878449b6d`; native root session:
  `545aefd3-315e-49c7-9422-b1f3cc2c7e86`; commit:
  `ffc238d2e81e518038a0e6777536c275c66ce3b9`. The exact agent is
  `openspec-runner-ed8dc6d7-7f30-4ded-98c7-c68878449b6d`; native
  tool events record `gpt-6-luna`. Report acceptance precedes root stop at
  `17:31:25.237Z`; supervisor exit is zero with completion source `agent-stop`
  at `17:31:26.087Z`. The task is integrated. Independent Git inspection confirms
  only `greeting.txt` in the task commit, whose blob contains HELLO_WINDOWS and LF.
- The Windows Git preparation failure is fixed by passing the target path
  relative to the repository root to `git worktree add`. Git's explicit
  `$GIT_DIR` length guard can fail even with `core.longpaths=true`. The absolute
  saved resource identity remains unchanged. The new native regression test
  reproduces the original failure and passes with the relative-path change.

## Verification of the launch correction

Three regression tests failed against the original code, then passed with the
fix. The full Windows suite passes: 271 passed, 113 skipped, zero failures.
The full Linux suite also passes: 369 passed, 18 skipped, zero failures, using
checksum-verified Node 22.13.0 and pnpm 11.7.0 on a native WSL filesystem.
Package dry-run and `git diff --check` pass. An independent code review found
no actionable issues.

## Upstream launch contracts

- [VS Code command-line reference](https://code.visualstudio.com/docs/configure/command-line)
- [Copilot hook reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [VS Code agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks)

Installed CLI help was also checked for supported flags and conflicting options.

## Codex permission correction verification

The focused native test exercises the installed Codex permission diagnostics and
Windows sandbox without model inference, including positive Git writes and
negative protected-file writes. Regression tests cover profile identity,
initial/resumed invocations, and rejection of missing, unrestricted, or broader
effective permissions. An independent code review found no remaining actionable
issues after the resume and effective-configuration checks were added.

Final verification: Windows full suite 274 passed, 114 skipped, zero failures;
Linux full suite 371 passed, 20 skipped, zero failures. The installed native
Codex test passes all four focused tests, including sandbox probes. Package
dry-run and `git diff --check` pass. Linux used Node 22.13.0 and pnpm 11.7.0
on a native WSL filesystem; installed native integrations remain skipped there.

- [Codex permission profiles](https://learn.chatgpt.com/docs/permissions)
- [Codex protected paths](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)

## Copilot production launcher follow-up — 2026-11-04

The corrected production adapter was tested on native Windows with Copilot CLI
1.0.105, OpenSpec 1.15.0, Git/manual resources, and model `auto`. Both native
session logs identified GPT-6 Luna. The disposable fixture granted `shell` and
`write` tools only for its worker invocations. No launcher overrides or global
trust/permission changes were used.

The adapter starts a new `--trust-folder -p PROMPT` session without a reserved
UUID. The nonce hook binds the actual root session. Report acceptance, root stop,
process exit, and observed-session completion receipts remain required. Saved
attachment uses `--resume`; legacy reserved attempts require explicit fresh retry.

| Stage | Attempt | Observed root session | Result |
|---|---|---|---|
| Implementation | `1523343d-7cef-4c89-a548-7c24c2a6977f` | `a48ef0f7-70c1-4ff1-acec-6bc0f485279d` | Accepted completed report, matching stop/completion receipt, exit zero, integrated. |
| Independent review | `63086a8b-89af-43e4-9b4e-1ff21d4ec1f4` | `0d329788-e243-4b7b-9fe6-877f367e5cf2` | Accepted completed report with one spec finding, matching stop/completion receipt, exit zero. |

Implementation commit `fecce5fdf90a65f2b396b74a86320ac30bac76ec` contains
only `greeting.txt`; its committed blob contains HELLO_COPILOT and LF. The reviewer
correctly found that `core.autocrlf=true` produces CRLF in a fresh Windows checkout
without a path-specific attributes rule. The fixture remains in `fixing`; no
repair, final approval, or archival is claimed. The [expanded live acceptance record](LIVE_ACCEPTANCE_2026-11-04.md) records the subsequent repair and clean fresh review. This initial run verifies production startup,
ownership, reporting, integration, and review execution, not a clean final feature
review or the complete recovery/cancellation checklist.

Evidence remains in `C:/Users/vital/AppData/Local/Temp/copilot-live-DEXA5v/`,
including `.git/openspec-runner` logs, leases, reports, and feature/attempt state.
An earlier fixture, `copilot-live-WQENrF`, stopped at missing-OpenSpec preflight
before inference. OpenSpec 1.15.0 was then installed with user authorization.

Verification: full Windows suite 274 passed, 114 skipped, zero failures. The
subsequently expanded focused Copilot suite passed all 12 tests, including new
capability and legacy-attempt checks. Build, package dry-run, and whitespace
checks passed. Independent code review found no actionable issues. Linux was
not rerun for this correction.
