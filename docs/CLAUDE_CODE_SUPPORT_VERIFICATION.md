# Claude Code live acceptance testing

## Current scoped update — 2026-11-21

Fresh native Linux Git/manual Claude2.1.329 `sonnet` workers with omitted and
explicit-low effort passed matching session, accepted report, committed result,
real supervisor exit0 and integration checks. Active resume command identity and
report-before-exit integration rejection were observed in the explicit-low run.
These are narrower than real-terminal detach/reattach and independently observed
effective effort (still null/unverified). A later intentional blocked report →
explicit new-attempt retry and invalid-model diagnostic are recorded separately
in the [scenario matrix](ACCEPTANCE_MATRIX.md). A controlled child PATH with Codex absent also passed a fresh worker lifecycle.
Child-isolated authentication rejection also PASS: exit1, no report, unchanged
integration head and integration blocked (`/tmp/runner-claude-auth-7OhJHx`;
see [durable acceptance evidence](verification/2026-11-21-acceptance.md)). Planner rationale PASS with actual versioned rules/catalog: routine Sonnet/H2 and durable concurrency/recovery Opus/H4, intentionally omitted effort. Full backend coverage remains OPEN; real-terminal detach/reattach remains BLOCKED.
A fresh gates run observed both integration and cleanup rejection before real exit;
that gate is now VERIFIED in the dated evidence.

Prompt-free Claude2.1.329 root/actual-worker catalogs matched; historical
SDK0.3.325 mismatch cause remains OPEN. Check the [model evidence](MODEL_DISCOVERY_VERIFICATION.md)
and matrix for per-run versions/receipts. Checklist boxes below retain their
historical scope; compound assertions remain unchecked where any gate is unrun.


Status: the full checklist remains pending. A narrower authenticated Windows
implementation, integration, and managed review passed; see the
[real Windows acceptance record](REAL_WINDOWS_HARNESS_ACCEPTANCE.md).
The [expanded live record](LIVE_ACCEPTANCE_2026-11-04.md) additionally covers
parallel/dependent tasks, Codex review, cancellation, denied tools, and
Herdr/Worktrunk execution with safe cleanup. Unchecked items below include
broader host, planner, and interactive-resume cases.

Native Windows local workers use the same Claude stream/session contract as
Linux, including the verified native resource backends. See the [Windows verification
record](WINDOWS_PORTABILITY_VERIFICATION.md); native fake-worker coverage does
not establish authenticated Claude acceptance. Herdr requires the caller's actual Herdr session.

Run these checks against an installed, authenticated Claude Code CLI in a disposable repository. Record the Claude Code and openspec-runner versions, selected model and effort, terminal backend, and results. Automated tests with fake executables do not establish live CLI compatibility.

## Preparation and compatibility

- [ ] Install the Claude runner skills and reviewed project permissions. Verify that planning, implementation, and reporting work with Codex absent.
- [ ] Verify the installed CLI supports the runner's stdin prompt, stream output, session UUID, persistence, permission settings, and saved resume invocation.
- [ ] Confirm permissions cover task edits, checks, commits, the Git common directory, and runner reporting.
- [ ] Have the planner assess representative routine and complex tasks using Claude's planning rules. Review model/effort choices, reasons, supported settings, and explicit user preferences. Record requested aliases, intentionally omitted effort, and observed concrete model metadata when available.

## Successful task lifecycle

- [x] Plan two independent tasks and a later task depending on both. Launch the independent tasks in one Claude-only batch.
- [ ] Verify each attempt has one begin registration, a matching stream-confirmed session UUID, one accepted report, a clean committed task worktree, and an actual supervisor exit receipt. A reserved UUID or accepted report alone is insufficient.
- [ ] Exercise manual terminals and Herdr separately. Detach and reattach without duplicate submission; verify retained sessions and exact saved resume details.
- [x] Integrate the independent tasks, then launch and integrate the dependent task. Confirm dependencies unlock only after integration and only integration changes canonical task checkboxes.
- [x] Verify cleanup retains sessions, logs, and branches. Attaching to a completed attempt must not resume a removed worktree.

## Failure and recovery

- [x] Exercise a denied permission and confirm actionable diagnostics and durable attempt state.
- [ ] Exercise an unsuccessful worker report and an interrupted worker. Inspect each attempt and explicitly retry; verify there is no automatic resubmission.
- [x] Verify authentication and invalid-model failures produce actionable diagnostics without a successful task outcome. Fresh Linux isolated cases are recorded in the dated acceptance evidence.
- [x] Confirm integration and cleanup remain blocked until actual process exit is established, including when a report was already accepted. Fresh Linux gates run observed both rejections in the actual report-before-exit window.

## Optional cross-harness checks

These checks require Codex in addition to the live Claude instance.

- [ ] Retrieve Claude planning rules from a Codex coordinating session and verify Claude assignments use those rules.
- [ ] Select another harness for a later batch with compatible assignments. Verify each batch remains homogeneous and historical attempts retain their original harness and session identity.
- [ ] Reject mixed-harness task configuration before worktrees or workers are created.

## Test record

For each run, retain the versions, configuration, reviewed permissions, task assignments, attempt/session IDs, relevant logs, exit receipts, and pass/fail results. Record unresolved CLI or protocol assumptions explicitly before claiming live support has been verified.
