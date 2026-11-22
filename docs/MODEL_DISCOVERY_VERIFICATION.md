# Model discovery and dashboard assignment verification

This record preserves the Windows and Linux observations from the former
2026-11-14 dashboard testing plan. Results are historical and version-specific;
fixture passes do not establish live provider compatibility.

The active backlog is [the verification coverage plan](superpowers/plans/2026-11-20-verification-coverage.md).
The old plan was removed after its completed steps were separated from its evidence.

## Current disposition — 2026-11-22

The optional SDK is now `@microsoft/copilot-sdk@2.0.1`. On native Linux,
installed Copilot CLI1.0.114 successfully initialized protocol4 through explicit
spawned stdio in `coding-agent` mode. Discovery uses the absolute installed worker
executable and caller cwd/inherited configuration; there is no implicit in-process,
remote-server or bundled-runtime fallback. Prompt-free normal discovery PASS:
`auto` / `Auto`, effort unsupported. Readiness-synchronized SIGINT130 and SIGTERM143
both left empty success stdout and no observed owned survivors. No session or
inference was created by these probes. See the [2026-11-22 remediation record](verification/2026-11-22-copilot-remediation.md).

The Free-account `auto` worker and a fresh prepared late-stop Linux recovery plus
explicit independent retry PASS. The old attempt remains failed with worker and
launcher null exit and no completion receipt; only the distinct replacement has
real OS0, launcher0, matching report/root stop/process-exit receipt and integration
of exact `HELLO\n` bytes. Separate abrupt supervisor loss before root stop is
BLOCKED safely: no report, proof, completion or retry is invented. Historical
unprepared records remain blocked. These bounded observations do not establish
containment of arbitrary previously unseen daemonization.

`Copilot Fusion` is the user's CLI display label; the SDK independently returned
`auto` / `Auto`. Neither this label nor `auto` identifies a concrete routed model.
Paid non-auto and explicit effort live acceptance are DEFERRED for this Free
account. Runner effort remains unsupported. Optional VS Code discovery bridge is
DEFERRED; authenticated editor and native Windows reruns remain BLOCKED here.
Store-linked Copilot authority remains UNSUPPORTED by the unchanged validators.

## Historical disposition — 2026-11-21

The November 14/20 observations below remain historical evidence. The Copilot
path and interrupted-discovery failures have since been corrected and verified
on native Linux; they are no longer current unresolved bugs. Native Windows
reruns remain BLOCKED on this Linux host.

- Task 2: private executable-path resolution, PATH-only/spaces/symlink and safe
  fallback regressions PASS (8/8 final discovery tests; wider run 18 pass,
  5 native Windows skips). No global resolver or shared-record change.
- Task 3: owned-tree cleanup, cooperative stop, bounded fallback, uncertainty
  preservation and mutation isolation PASS on Linux (42 pass, 2 native Windows
  skips). Unrelated sentinels survive; successful clipboard helpers retain their
  intentional descendants. Native Windows cleanup is not established by these tests.
- Task 4: Claude raw protocol/hidden metadata/selector safety regressions PASS
  (31/31 catalog tests; 3/3 raw-boundary focus). Malformed UTF-8 fails closed.
  Historical SDK 0.3.325 selector-mismatch cause remains OPEN; no alias rewrite.
- Follow-up Copilot protocol correction: independent audit reproduced DEL selector
  rewriting and malformed UTF-8 acceptance before catalog validation. Copilot now
  opts into the existing raw/fatal stdout boundary; exact valid selectors survive,
  control selectors reject and malformed transport becomes unavailable. Build PASS,
  complete discovery file25/25 PASS; scoped independent review PASS. Evidence:
  `protocol-fix-report.md` and `protocol-fix-review.md` in the retained SDD directory.
  The earlier604-pass integrated checkpoint predates this fix and later Task6 tests.
- Task 5: import-safe prompt-free driver PASS (final 9/9). Copilot CLI 1.0.112
  normal PATH catalog returned only `auto`, exit 0, no observed descendants.
  Readiness-synchronized SIGINT targeted the top-level runner, exited 130 with
  empty stdout and no observed remaining owned descendants. This supersedes
  the historical leak observation, not the non-auto acceptance gate.
- Codex 0.163.0 and Claude 2.1.329 catalog entries/efforts matched between the
  planning root and an actual prepared managed worker cwd. No worker inference
  occurred in those comparisons. Claude selectors varied across same-version
  sessions; no stable alias guarantee follows.
- Fresh Claude 2.1.329 omitted-effort and explicit-low supervised workers and
  Copilot `auto` worker completed report/session/exit/integration checks in
  Task 6. Requested effort is not independently observed effective effort.
  See the [scenario matrix](ACCEPTANCE_MATRIX.md) for exact current scope.
- Non-auto Copilot picker/SDK/worker acceptance is BLOCKED by an auto-only SDK
  catalog. Copilot effective effort remains unverified; runner effort rejection
  remains intentional. Optional editor bridge is DEFERRED.

Historical primary recheck (2026-11-21): Codex available8, Claude available5; Copilot catalog
compatibility BLOCKED. Ambient CLI1.0.114 protocol4 disagrees with pinned SDK1.0.34
protocol3 during client.start, before listModels. This is not an authentication
failure. Earlier CLI1.0.112 discovery passes remain version-specific; no upgrade
was performed. Driver identity/observation/deadline cleanup focus passes28/28;
new process observation is Linux-only, unsupported/unknown evidence BLOCKED.
Final integrated v3 build/suite PASS:645 total,621 pass,24 native Windows skips,
0 fail/cancel. Final pack dry-run and local Markdown links/anchors/diff checks PASS.

Durable evidence: [dated commands, counts and sanitized live receipts](verification/2026-11-21-acceptance.md).
Raw scratch logs are not packaged. Temporary `/tmp` locations identify local
observations, not portable artifacts or guaranteed future files. Installed CLI
versions changed externally; use each row's version. Integrated604-pass/24-skip
suite and `pnpm pack --dry-run` exit0 are checkpoints; the suite predates the
Copilot protocol fix and later Task6 extensions. Final v3 results supersede these
checkpoints; Copilot discovery was independently BLOCKED at that checkpoint.

## Windows execution notes

- Node v24.21.0, pnpm 11.7.0, Git 2.51.1.windows.1. The native fixture run passed 15 cases covering the five Ink workflows at 40, 80, and 140 columns, YAML alias rejection, and existing assignment guards. Narrow coverage exposed a truncated copy status, which now appears first in the confirmation footer.
- The Windows normalized CLI probes returned eight Codex selectors, five Claude selectors, and only Copilot auto. These were repository-checkout probes. At that stage, managed worker comparison, Claude SDK and supervised startup, and Copilot multi-model worker verification were open; see the later Linux results below.
- Copilot help advertises --reasoning-effort with model-dependent values. Startup and effective effort remain unverified. Native Linux was excluded from that Windows run; later Linux results follow below. The optional VS Code bridge was not exercised.

- Full suite exited zero with 346 passed, 123 skipped, and zero failures or cancellations. The final focused run passed all 44 cases. The new lifecycle fixture covers wrong checkout, completed and archiving state, a pending transaction, a successful repair, and uncertain termination. At that stage, imported binding/publication assertions, seeded effort switching, and bulk Ink confirmation were open. The later Linux fixture run covers them; native Windows execution of these later cases still needs a fresh baseline.

## Linux execution notes

- Node v24.16.0, pnpm 11.7.0, Git 2.43.0. Native child process execution and the locked Copilot SDK install resolved the initial sandbox-only fixture failures. `pnpm test` finished with 451 passed and 23 skipped. The focused suite finished with 43 passed and two Windows-only skips. Both exited zero with no failures or cancellations. The assignment guard checks passed for preview and apply, including a real imported binding without dashboard Store context. The checks compare execution file bytes and directory entries after rejection.
- The seeded Claude form passed at 40, 80, and 140 columns. It clears low effort on model change, rejects a deliberate low effort, and omits effort from the reviewed settings. At 40 columns the bulk form previews both tasks via the real `execution-settings --json --dry-run` path, preserves bytes on Escape, passes the reviewed token on Enter, and reloads the two saved assignments with the third untouched.
- Codex CLI 0.163.0 using `models --agent codex --catalog --json` reported the disposable planning root and the actual prepared worker worktree as distinct scopes. The app-server catalog matched across both directories with the same installed executable and inherited provider configuration. Eight selectors were visible with matching effort choices and defaults. The disposable preparation and comparison took 2.3 seconds.
- Claude Code 2.1.272 returned five selectors in 0.94 seconds from `models --agent claude --catalog --json`. The prompt-free Claude Agent SDK 0.3.325 comparison used the same CLI and planning checkout. Efforts matched. The SDK returned `claude-fable-5-1[1m]` where the runner returned `claude-fable-5[1m]`. The CLI child exited zero and was gone after `Query.close()` in 0.90 seconds. The strict parity assertion exited 1 on the selector difference.
- Both supervised Claude startup checks requested `sonnet`, one with `low` and one with effort omitted. Each initialized a session, reported `claude-sonnet-5`, and exited zero in about 3.5 seconds. The worker did not report effective effort. The runner marked both tasks failed because neither submitted an accepted final report. This verifies startup acceptance and the observed model only.
- Copilot CLI 1.0.112 and SDK 1.0.34 reached live discovery. `models --agent copilot --catalog --json` returned unavailable with no entries in 0.12 seconds. The direct SDK probe exited 1 with `Not authenticated`. No process remained in the normal probe's process group. An attempted interrupt raced with the authentication failure, so in-flight shutdown remains unverified. CLI help advertises `--reasoning-effort`; the runner's explicit-effort rejection passed. Account-backed catalog, picker, startup, effective effort, and the optional VS Code bridge remain unverified.

- After Copilot CLI 1.0.112 was authorized, the direct SDK probe exited zero and returned only `auto`. The unmodified runner still returned unavailable. On Linux it passes the bare name `copilot` to SDK 1.0.34, which requires an existing path. With a symlink to the installed binary in the disposable checkout, the runner returned `auto` and normal completion left neither child running. SIGINT sent after the SDK spawned the CLI exited the runner with status 130, but both descendants were still present 400 ms later. No non-auto selector or advertised effort was available from this catalog.

- The interactive Copilot picker shows Fusion Standard as selected, High and Max as unavailable on the current plan, and `gpt-oss:20b-cloud` as discovered under Local and self-hosted. That selector was absent from the SDK catalog, which returned only `auto`. The screenshot establishes a picker/catalog difference. Selection, supervised startup, and effective effort for the self-hosted entry remain unverified.
