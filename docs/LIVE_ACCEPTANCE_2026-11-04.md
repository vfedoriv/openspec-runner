# Expanded live acceptance — 2026-11-04

This record follows [the production startup correction](REAL_WINDOWS_HARNESS_ACCEPTANCE.md#copilot-production-launcher-follow-up--2026-11-04).
Runs used source at `6e52e98` plus the recovery correction described below.
Dates use Europe/Kiev; raw log timestamps use UTC and can show November 3.
These are authenticated native Windows runs, separate from simulated tests.
No final feature approval or archival was performed.

## Environment and permissions

Installed tools: Codex 0.165.0, Claude Code 2.1.312, Copilot CLI 1.0.105,
VS Code 1.144.0, OpenSpec 1.15.0, and Orca runtime 1.4.247. Herdr and Worktrunk
use the installed native backends described in the [Windows record](WINDOWS_PORTABILITY_VERIFICATION.md#installed-resource-backend-follow-up).

Claude requested `claude-haiku-5-5`; its stream confirmed that model. Codex
requested `gpt-6-luna` with low effort. Copilot CLI requested `auto`; VS Code
requested `Auto (copilot)`. A requested selector or hook session is not independent
attestation of the concrete editor model.

Fixtures use Git/manual resources unless specified otherwise. Claude positive
runs allow Read/Write/Edit/Glob/Grep/Bash/PowerShell with `dontAsk`; Copilot CLI
allows shell/write for its fixture invocation. The denied-tool fixture allows
Read only. Codex uses the production scoped Windows permission profile. The user
approved native editor trust/tool prompts and ran the Herdr driver in an actual
Herdr-managed pane. No global authentication, permissions, or trust was changed.
Only test-owned process trees were interrupted; unrelated apps and sessions were
not terminated. The isolated Orca server was stopped after its test.

## Results

| Scenario | Evidence | Observed result |
|---|---|---|
| Copilot blocking review → repair → integration → fresh review | `copilot-live-DEXA5v` | Repair added the LF attributes rule; both workers exited zero with accepted reports. Fresh review has zero findings; feature awaits final approval. |
| Two independent Claude tasks, then their dependent task | `live-claude-qLqEmV` | Parallel workers produced alpha/beta; the dependent task was blocked before integration and produced combined output afterward. All three integrated. |
| Claude implementation with independent Codex feature review | `live-claude-qLqEmV` | Reviewer exited zero with an accepted report and no findings; original task harness/session identities were retained. Feature awaits final approval. |
| VS Code managed review | `live-editor-jTfIMk` | Actual hook session, accepted report, matching root stop and agent-stop receipt, supervisor zero. No findings; feature awaits final approval. The supplied completed task was in the baseline, so this review did not establish editor implementation or repair. |
| VS Code interrupted supervisor and later root stop | `live-editor-crash-eynem9` | Recovery blocked while the turn was active. After its real report and matching stop, recovery recorded failed state and null exit, created no completion receipt, and allowed explicit review retry preview. |
| Real cancellation: Copilot CLI | `live-cancel-copilot-5i10zv` | Stopped only the owned launcher tree. Failed attempt, nonzero exit, no report; integration blocked, resources retained, explicit retry preview allowed. |
| Real cancellation: Claude and Codex | `live-cancel-claude-WTtFek`, `live-cancel-codex-e5FcVd` | Owned process trees stopped; attempts failed and could not integrate. Logs/worktrees retained and explicit retry previews allowed. Already-recorded supervisor exits did not need a second recovery invocation. |
| Copilot supervisor crash and late report | `live-crash-copilot-EzZLez` | Turn continued and eventually reported/stopped. Old code left a stale launcher record blocking retry. Corrected recovery preserves a failed attempt and null exit, blocks integration, and permits explicit retry after matching root stop and process-tree checks. |
| Invalid Copilot model | `live-invalid-sFAyvo` | Exit one, failed attempt, no report, no integration. |
| Denied Claude PowerShell tool | `live-denied-nPK7fX` | Native denial prevented begin/edits/report. Process exit zero still yielded a failed attempt and blocked integration; permissions were not widened. |
| Copilot inference through Orca worktrees and terminals | `live-orca-jwTPn3` | Accepted report, process-exit receipt, zero exit, successful integration. Cleanup safely skipped because the runtime reported another terminal in the task worktree. Test-owned runtime stopped; retained worktree is evidence, not claimed cleanup success. |
| Claude inference through Worktrunk and Herdr | `live-herdr-8VFrL9` | User ran the driver in a real Herdr pane. Accepted report and zero exit; integration, owned-pane closure, and task-worktree removal passed. Session, log, and branch remain; attach supplies no resume command for the removed worktree. |

## Recovery correction

The interrupted CLI supervisor lost the launcher exit acknowledgement. A late
completed report could also leave a completed-looking task despite the null
supervisor exit. The original retry check continued to treat that launcher as
possibly live even after the turn had stopped.

Recovery now acknowledges the stale Windows launcher only when all of these hold:

- The actual registered session matches observed identity and has a root-stop event.
- The supervisor is recorded exited with a null exit code.
- Both saved Windows process identities have valid creation timestamps.
- Neither saved PID is currently live, and both saved process trees are provably absent.

Missing, live, uncertain, foreign-platform, or reused identities remain blocked.
Recovered tasks/jobs stay failed, with null exit evidence and no invented
completion receipt. Existing reports and resources remain available for inspection.
This extension is native-Windows-specific; it does not relax Linux or editor
process/turn evidence rules.

For a stopped task whose supervisor disappeared, inspect status and logs, then
rerun its saved `worker CHANGE TASK --attempt ID` command to record recovery;
that command does not dispatch the old prompt again. Feature jobs use
`feature recover CHANGE --attempt ID`. Wait for the matching root stop before
retrying a CLI turn that survived its supervisor. Inspect the resulting failed
attempt, preview an explicit retry, and obtain the normal execution approval.
Do not edit state, clear locks, or manufacture successful exit receipts.

The affected `retry demo 1.1 --dry-run --json` command was exercised against the
recovered live fixture; it returned the Copilot task and left state byte-identical.

## Evidence inventory

Fixture names above are under `C:/Users/vital/AppData/Local/Temp/`.
Each retains `.git/openspec-runner` state, logs and reports, plus its isolated Git
history. The Herdr worktree was intentionally removed after safe cleanup.
Ignored local drivers and the Herdr result receipt are under
`.superpowers/sdd/2026-11-04-live-acceptance/` in this checkout.

| Stage | Attempt | Session |
|---|---|---|
| Copilot repair | `7123a7d7-30aa-491b-9e32-a59187f89cb9` | `e29c4d73-b415-41ef-9f8a-dbc009750d0d` |
| Copilot fresh review | `fa44d9d1-df70-410e-adef-27914fa77c04` | `5e10b528-ee27-4c69-99ef-80397676c4b9` |
| Claude task 1.1 | `dd2416bb-6613-434f-abb1-1a42a5a2f22e` | `275f8465-a897-4e34-a966-364222ea29ab` |
| Claude task 1.2 | `01bcdc51-ebfe-4470-aa76-634613fe14ad` | `890c8b60-3687-4401-bde0-7ff776413bd5` |
| Claude dependent task | `0a957cd6-cc94-4c80-868e-64039e230bf9` | `84f2a114-ab9e-4d56-8d8e-73b02c73ca33` |
| Codex mixed-role review | `b81e0690-89f8-4133-a19e-d5c22c7485c7` | `01a1a375-6b0d-7e03-891e-432c364f739e` |
| VS Code managed review | `beece792-194c-4026-8a13-c6a077a94144` | `020f6acc-5553-4971-9d88-ce0a5f600f8e` |
| VS Code supervisor crash | `79d2b946-7bcc-4957-99b6-e5fbfceb1768` | `2e3b5441-b0f6-4fb2-864a-e63fdc1f6586` |
| Copilot supervisor crash | `439b7aa0-1958-47c6-9489-4adcf8bf3fff` | `91152939-225e-47d3-8a2e-5d856827d40d` |
| Orca-backed Copilot | `7dc77803-5732-4772-9b76-d12306d48d6a` | `85cf15e7-7d3d-4cbb-842c-46839b9f611f` |
| Herdr-backed Claude | `c6bf0bb4-84e2-4be0-ac25-da6481668778` | `f593ac10-e20a-4bb4-aa53-235c66f7966b` |

## Regression verification

Full Windows suite: 278 passed, 114 skipped, zero failures (392 total). This
includes the new helper guard tests and persisted task/feature recovery paths
in the four-harness lifecycle matrix. Build, package dry-run, and whitespace
checks passed. An independent review found no actionable issues.

Full Linux suite on native Ubuntu 22.04 storage with Node 22.14.0: 375 passed,
20 skipped, zero failures (395 total). The first copied Windows dependency tree
was incomplete (missing `yoga-layout`); it was replaced with an isolated
`pnpm install --frozen-lockfile --ignore-scripts` before the passing build and
suite. No dependency or global-tool changes were made to this repository. The
Linux copy and logs remain at `/tmp/openspec-live-linux.M3AIzw` in that WSL distro.

## Remaining scope

These runs do not establish every harness/backend permutation, live interactive
exact-session resume, authentication-failure handling, or clean final approval
and archival. Windows delegated execution and shared Copilot assignments remain
excluded by the [current contracts](DOCUMENTED_LIMITS.md#7-delegated-execution-has-narrower-support-than-local-workers).
Do not treat the broader checklist as fully passed solely because these cases passed.
