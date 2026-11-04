# Worker startup readiness verification — 2026-11-04

This implements maintenance priority 3 against source `0c8fc7f` plus the startup
correction. Dates use Europe/Kiev; raw worker logs use UTC.

## Trigger and correction

Codex previously received the task prompt as an argument when its process was
created. The parent's spawn callback recorded the PID afterward, under the
repository lock. A sufficiently fast child could therefore consume instructions
before registration finished, even when registration ultimately failed.
The three-second live-owner lock retry reduced contention but did not establish
prompt readiness. The feature fixture's PID/lock polling also hid that ordering.

Initial Codex workers now use `codex exec ... -` and receive instructions on
stdin. The shared supervisor sends the complete prompt only after the synchronous
registration callback returns, which means the repository lock has been released.
If registration throws, stdin is destroyed before the owned stop procedure runs;
no task prompt is sent. Claude retains its stdin transport and shares that failure
gate. No wrapper process or persistent-state migration is introduced.

The installed Codex 0.165.0 help explicitly documents `-` as stdin input. Permission
profiles, effective-permission preflight, worktree isolation, activity capture,
structured reports, successful exit checks, and explicit retries remain in force.
Interactive resume has no new initial prompt or stdin payload. Copilot continues
using its separate hook supervisor and ownership protocol.

## Deterministic regression evidence

`test/worker-startup.test.mjs` runs native subprocesses against the real shared
supervisor and harness invocation builders. A startup marker coordinates the
parent's registration callback; the child does not wait for saved PID/lock state.
This is a condition barrier, not an arbitrary fixture startup delay.

Before the correction, three Codex tests failed: the fast child consumed its
prompt before registration returned, after registration refusal, and during a
registration lock timeout. The equivalent Claude readiness test already passed.
Afterward, all six tests passed:

- Fast Codex and Claude children consume prompts only after registration returns.
- Failed registration sends neither harness a task prompt.
- A live owner's lock reaches its existing deadline without prompt dispatch.
- A child that exits during registration cannot produce a successful supervised turn.

The feature fake workers now consume the native stdin transport instead of
polling the saved worker PID and lock file. Task, managed review, and repair
paths run through this boundary in the complete lifecycle suites. Additional
checks cover scoped Windows permissions, stdin preservation, activity capture,
and unchanged prompt-free resume.

## Verification record

The authenticated Windows smoke used Codex 0.165.0, `gpt-6-luna` with low effort,
OpenSpec 1.15.0, and Git/manual resources through the production scoped launcher.
Implementation, Node byte verification, commit, report acceptance, zero exit,
integration, and a fresh managed review with zero findings passed. The feature
stopped at `awaiting-final-approval`; final approval and archival were not run.

| Stage | Attempt | Session |
|---|---|---|
| Implementation | `ac18c8d6-c97e-4799-a2a7-b641598427a2` | `01a1a394-423c-7bb1-af02-ce9e14f2cb6a` |
| Independent review | `73a28e5f-6e39-438f-bcf6-5fd156290537` | `01a1a395-497b-77b2-b63b-c8ed5dfb96f7` |

Task commit: `a16aaf1d2063dd7c7fcfa2717a49e035081c0f6c`. Live state, reports,
and logs remain in `C:/Users/vital/AppData/Local/Temp/live-codex-stdin-1tE6e3/`.
The local driver and transcript are under `.superpowers/sdd/2026-11-04-live-acceptance/`.

Final verification:

- Windows, Node 24.21.0: 285 passed, 114 skipped, zero failures (399 total).
- Native Ubuntu 22.04, Node 22.14.0: 382 passed, 20 skipped, zero failures (402 total).
- Focused activity/startup suite: 18 passed, zero failures.
- Build, package dry-run, and whitespace checks passed.
- Independent production-code and final-fixture reviews found no actionable issues.

Linux reused the existing exact native dependencies in a fresh source copy;
its log remains at `/tmp/openspec-startup-linux.7orGGo/verification.log` in WSL.
The Windows final log is `startup-windows-suite.log` beside the ignored driver.
Activity fixtures now consume stdin before emitting completion, preserving strict
pipe-error behavior instead of suppressing it.

## Scope

This proves registration-before-prompt delivery for the Codex/Claude stdin
contract; it does not remove repository locks or guarantee that unrelated later
state mutations never contend. Long-held, stale, foreign, unreadable, or uncertain
locks still fail closed under the existing policy. A process may start and emit
startup diagnostics before registration; task instructions are withheld until
registration succeeds. Startup, stream, pipe, or process failures never become
successful task evidence solely because a prompt was delivered.
