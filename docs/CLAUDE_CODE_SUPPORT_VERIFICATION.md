# Claude Code live acceptance testing

Status: checklist pending execution; this document does not claim successful live testing.

Run these checks against an installed, authenticated Claude Code CLI in a disposable repository. Record the Claude Code and openspec-runner versions, selected model and effort, terminal backend, and results. Automated tests with fake executables do not establish live CLI compatibility.

## Preparation and compatibility

- [ ] Install the Claude runner skills and reviewed project permissions. Verify that planning, implementation, and reporting work with Codex absent.
- [ ] Verify the installed CLI supports the runner's stdin prompt, stream output, session UUID, persistence, permission settings, and saved resume invocation.
- [ ] Confirm permissions cover task edits, checks, commits, the Git common directory, and runner reporting.
- [ ] Have the planner assess representative routine and complex tasks using Claude's planning rules. Review model/effort choices, reasons, supported settings, and explicit user preferences. Record requested aliases, intentionally omitted effort, and observed concrete model metadata when available.

## Successful task lifecycle

- [ ] Plan two independent tasks and a later task depending on both. Launch the independent tasks in one Claude-only batch.
- [ ] Verify each attempt has one begin registration, a matching stream-confirmed session UUID, one accepted report, a clean committed task worktree, and an actual supervisor exit receipt. A reserved UUID or accepted report alone is insufficient.
- [ ] Exercise manual terminals and Herdr separately. Detach and reattach without duplicate submission; verify retained sessions and exact saved resume details.
- [ ] Integrate the independent tasks, then launch and integrate the dependent task. Confirm dependencies unlock only after integration and only integration changes canonical task checkboxes.
- [ ] Verify cleanup retains sessions, logs, and branches. Attaching to a completed attempt must not resume a removed worktree.

## Failure and recovery

- [ ] Exercise a denied permission and confirm actionable diagnostics and durable attempt state.
- [ ] Exercise an unsuccessful worker report and an interrupted worker. Inspect each attempt and explicitly retry; verify there is no automatic resubmission.
- [ ] Verify authentication and invalid-model failures produce actionable diagnostics without a successful task outcome.
- [ ] Confirm integration and cleanup remain blocked until actual process exit is established, including when a report was already accepted.

## Optional cross-harness checks

These checks require Codex in addition to the live Claude instance.

- [ ] Retrieve Claude planning rules from a Codex coordinating session and verify Claude assignments use those rules.
- [ ] Select another harness for a later batch with compatible assignments. Verify each batch remains homogeneous and historical attempts retain their original harness and session identity.
- [ ] Reject mixed-harness task configuration before worktrees or workers are created.

## Test record

For each run, retain the versions, configuration, reviewed permissions, task assignments, attempt/session IDs, relevant logs, exit receipts, and pass/fail results. Record unresolved CLI or protocol assumptions explicitly before claiming live support has been verified.
