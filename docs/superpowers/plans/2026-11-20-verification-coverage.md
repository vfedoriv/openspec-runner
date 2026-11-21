# Verification Coverage Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes for tracking. This document authorizes no live execution by itself.

**Goal:** Close the recorded discovery failures, add missing deterministic regressions, and establish explicit live acceptance coverage without erasing historical evidence.

**Architecture:** Keep harness-specific discovery in the harness adapters and process ownership at the existing platform/dashboard child boundary. Use fake executables for reproducible failures and retained disposable repositories for real tool acceptance. Record deterministic, installed-tool, and authenticated results separately.

**Tech Stack:** TypeScript ESM, Node.js >=22.13, pnpm 11.7.0, node:test, Git, installed Codex/Claude/Copilot and optional SDKs.

**Requirements:** The 2026-11-20 audit request; [model discovery evidence](../../MODEL_DISCOVERY_VERIFICATION.md), [documented limits](../../DOCUMENTED_LIMITS.md), [Codex live scenarios](../../live-acceptance-guide.md), and [Claude checklist](../../CLAUDE_CODE_SUPPORT_VERIFICATION.md).

## Global constraints

- Preserve snapshot approval, exact session ownership, report-plus-exit requirements, and explicit retry. Discovery must be prompt-free.
- Do not widen worker permissions, auto-publish Git history, extend shared Copilot records, or claim exact editor chat resume.
- Do not install globally or change credentials/trust to obtain a pass. Use authorized environments and test-owned processes only.
- Native Windows and native Linux results are distinct; WSL is not native Windows evidence.
- Obtain third-party API documentation through Context7 at execution time before changing SDK-specific calls.
- No runtime/dependency upgrade is assumed. Any necessary upgrade gets its own compatibility review and locked version.
- Tests run against dist: build before focused runs. Run pnpm test before submitting implementation changes.
- An unavailable environment is BLOCKED with a reason, not PASS or a silently satisfied checkbox.
- Commit each independently verified task when commits are requested; do not commit generated dist or knowledge-graph artifacts.

## Review focus

1. PATH-only executables, spaces, symlinks and Windows wrappers must not turn installed tools into false unavailable catalogs (Task 2).
2. SIGINT, SIGTERM, timeout and dashboard cancellation must leave no test-owned probe descendants (Task 3).
3. Malformed/changed provider metadata must fail safely without inventing selectors or effort support (Task 4).
4. Catalog context must match the worker's actual cwd/configuration and not leak a stale other-harness result (Tasks 4–5).
5. Reports, root stops and null/uncertain exits must never manufacture success or bypass review/approval (Task 6).

## Dependency order and completion rules

Task 1 establishes the baseline. Task 2 precedes Task 3's live Copilot rerun.
Task 4 can proceed after Task 1. Tasks 5–6 follow their relevant deterministic
checks. Task 7 is optional and cannot block core closure. Task 8 reconciles all
results. All boxes below start open: writing this plan does not execute them.

## Dated execution disposition — 2026-11-21

Base commit: `88c5696b5101246d5e180ba35751a6c8ef457626`; changes remain
uncommitted. [Durable acceptance evidence](../../verification/2026-11-21-acceptance.md)
records commands, versions, counts and sanitized receipts. Raw scratch logs are
not packaged. Temporary locations identify local observations and become
unavailable if removed; they are not reproducible package artifacts. Installed
CLI versions changed externally; read per-run evidence.

Step numbers below follow the checkbox order within each task. An unchecked
compound step can contain verified subparts; the remaining assertion is explicit.

| Task | Step disposition |
|---|---|
| 1 | 1 VERIFIED Linux environment/lock/preflight; 2 Linux initial build PASS, suite 530 pass/1 fixture fail/24 skips, integrated checkpoint628 total/604 pass/24 Windows skips/0 fail/cancel, native Windows BLOCKED; 3 BLOCKED native Windows; 4 VERIFIED isolated fixture classification/correction (1/1 named,22/22 file); 5 integrated checkpoint PASS, final v3 build/suite PASS645 total/621 pass/24 native Windows skips/0 fail/cancel after reviewed driver deadline correction + BLOCKED Windows gate. |
| 2 | 1–5 IMPLEMENTED/VERIFIED, reviewed: final discovery8/8, wider18 pass/5 native Windows skips. Native success is not inferred from wrapper simulation. |
| 3 | 1,2,4 IMPLEMENTED/VERIFIED Linux; 3 sentinel VERIFIED, native Windows identity/uncertainty execution BLOCKED; 5 Linux42 pass/2 Windows skips, native Windows BLOCKED. |
| 4 | 1–5 IMPLEMENTED/VERIFIED scoped fixture gate (31/31 catalog,3/3 raw safety); historical SDK0.3.325 mismatch cause explicitly OPEN as permitted by step5. Current parity is version-specific, never an alias rewrite. |
| 5 | 1 IMPLEMENTED/VERIFIED driver focus28/28 after identity/observation/deadline review; observer Linux-only, unsupported/unknown BLOCKED; 2 VERIFIED CLI1.0.112 normal PATH auto + top-level SIGINT130/empty stdout/no observed descendants; current CLI1.0.114/SDK1.0.34 catalog compatibility BLOCKED (protocol4/3), no upgrade; 3 BLOCKED auto-only account/catalog; 4 OPEN direct effort acceptance/effective observation; 5 VERIFIED worker-cwd catalogs, fresh Claude SDK comparison and explicit/omitted startup; independently effective effort unobservable and recorded without inference. |
| 6 | 1 matrix IMPLEMENTED with exact scope; 2 drivers IMPLEMENTED/VERIFIED; 3 BLOCKED real-terminal token recall; 4 PARTIAL Claude session/report/exit/integration, report-before-exit blocking and explicit retry verified, Codex-absent worker VERIFIED, child-isolated auth and observed integration/cleanup-window rejection VERIFIED, planner rationale VERIFIED, real-terminal gate BLOCKED; 5 PARTIAL Copilot auto worker/cancel/archive/hooks-disabled checks, blocking-review/repair/fresh-review/archive VERIFIED; exact Linux late-stop failure handling observed, explicit retry BLOCKED by intentional stale-launcher guard; editor/other host rows BLOCKED; 6 deterministic contracts retained, actual Claude routine/complex installed planner VERIFIED; other live planner/batch combinations OPEN; 7 BLOCKED native Windows; 8 PARTIAL row dispositions, full matrix OPEN. Matrix is authoritative for exact receipts and final focused counts. |
| 7 | 1 DEFERRED optional bridge; 2 VERIFIED15/15 tests, spec/quality approved, no production fix; 3 BLOCKED/unverified real provider rendering; 4 OUT OF SCOPE shared Copilot, boundary retained. |
| 8 | 1 VERIFIED final durable reconciliation; 2 VERIFIED conservative status marking; 3 PARTIAL fresh Codex8/Claude5 catalog checks, Copilot compatibility BLOCKED; final v3 build/suite/pack/link/anchor/diff PASS; 4 VERIFIED historical evidence preserved and backlog redirected; 5 VERIFIED scoped final disposition, required blocked/open rows retained. |

OPEN means an unrun acceptance assertion or implementation/fixture gap; it does
not become BLOCKED merely because a driver lacks a readiness barrier. Child-only
credential isolation is authorized; authentication testing needs no additional
global credentials/trust change or permission. BLOCKED is reserved for unavailable
external environments/accounts/surfaces.

No full-coverage or native Windows completion claim is made. Review approvals
cover their named deterministic scope and do not convert environment gates to passes.

### Task 1 — Reproduce an honest baseline on both operating systems

**Files:** test/helpers/run-tests.mjs, test/helpers/native-support.mjs, test/helpers/feature-fixture.mjs; evidence in docs/MODEL_DISCOVERY_VERIFICATION.md.
**Interface:** Existing pnpm test and node test/helpers/run-tests.mjs FILE...; no product API change.

- [x] Record commit/dirty paths, OS/filesystem, Node/pnpm/Git versions and dependency lock state. Run disposable Git init/commit and a Node child spawn before the suite. Sandbox spawnSync git EPERM is an environment failure, not product failure.
- [ ] Run pnpm run build, then pnpm test on native Linux and native Windows. Retain complete logs, exit status, pass/fail/skip/cancel counts and every relevant skip reason. Never substitute historical suite counts.
- [ ] Run the final dashboard/execution-settings cases on Windows, including imported binding guards, byte/directory preservation, effort switching and bulk confirmation; these landed after the older Windows baseline.
- [x] If baseline tests fail, reproduce a named test alone, classify fixture/environment/product cause and fix only with a regression. Do not loosen guards to obtain green.
- [ ] Gate: build exits zero, suites exit zero, and required native cases execute. List unavailable installed-tool/backend cases separately.

### Task 2 — Resolve Copilot SDK executable paths reliably

**Files:** src/harnesses/copilot.ts, src/platform-command.ts if a reusable resolver is needed; create test/copilot-model-discovery.test.mjs.
**Interface:** Preserve copilotHarness.models(options) and ModelDiscovery; do not change shared records or global resolveCommand behavior unless required by reviewed tests.

- [x] Add failing test `Copilot discovery resolves a PATH-only executable outside cwd`: use an isolated PATH bin and unrelated cwd, a fake SDK transport that checks an existing absolute executable path, and no checkout-local symlink. Assert available catalog with the exact fixture selector and no inference prompt.
- [x] Add cases for absolute path with spaces, executable symlink, missing executable, SDK absent and unsupported Windows wrapper. Assert actionable unavailable result, no shell interpolation, no launched worker, and unchanged cwd contents. Restore environment/module fixtures after each test.
- [x] Build and run node test/helpers/run-tests.mjs test/copilot-model-discovery.test.mjs; confirm the PATH case fails for the path contract, not authentication or module loading.
- [x] Resolve the CLI to the executable path required by the locked SDK before starting the probe; preserve existing rejection of wrappers that cannot be passed directly. Keep fallback behavior when unavailable.
- [x] Repeat focused checks with test/platform-command.test.mjs and test/dashboard-catalog.test.mjs. Gate: all pass without a local symlink workaround.

### Task 3 — Prove probe process-tree cleanup

**Files:** src/harnesses/copilot-model-probe.ts, src/harnesses/copilot.ts, src/dashboard-action-runner.ts, src/cli.ts only for top-level signal ownership; test/copilot-model-discovery.test.mjs, test/dashboard-actions.test.mjs.
**Interface:** Preserve dashboardChild(command, argv, cwd, signal, mutation?, stdin?) and CLI models --agent copilot --catalog --json. Cancellation must not affect mutation commands or unrelated processes.

- [x] Create a test-owned fake probe/CLI grandchild with readiness IPC/files and recorded PID plus creation identity. Wait for readiness rather than racing an arbitrary sleep; register bounded teardown before launch.
- [x] Add failing subprocess cases for SIGINT and SIGTERM sent after CLI readiness. Add normal completion, discovery timeout, dashboard AbortSignal cancellation, malformed output, SDK start/list failure and stop failure. Assert probe AND CLI identities are absent within a bounded 3-second cleanup deadline and no success JSON is emitted on failure.
- [ ] Add an unrelated sentinel child and assert it remains alive. On Windows exercise owned-tree identity and uncertain termination; uncertainty must be reported rather than called successful cleanup. Never kill a process solely from a stale PID.
- [x] Reproduce the interrupt failure before changing code, then implement cleanup/signal propagation at the boundary owning the descendants. Ensure client.stop runs for cooperative shutdown; provide bounded owned-tree fallback when it cannot finish.
- [ ] Build/run focused discovery, dashboard action and platform-process tests on both platforms. Gate: no leaked fixture identities and existing mutation/uncertain-process guards pass. Verify CLI interruption exits nonzero (130 for SIGINT on Linux).

### Task 4 — Pin catalog protocol and Claude parity behavior

**Files:** src/harnesses/claude.ts, src/model-catalog.ts, test/dashboard-catalog.test.mjs; create test/claude-model-discovery.test.mjs.
**Interface:** Preserve claudeModels(options), modelCatalog(harness, cwd, configured?, includeHidden?) and ModelCatalog fields.

- [x] Add fixture streams for matching initialize response, unrelated request IDs, errors, empty models, malformed JSON, hidden/control-character selectors, duplicate selectors, split output and absent effort metadata. Assert exact returned selectors, safe fallback, effortSupport and cwd scope. No inference turn may be submitted.
- [x] Add a captured/sanitized selector regression for the recorded fable selector mismatch. Investigate the same installed CLI/config with direct protocol and SDK before deciding whether these surfaces promise identical selectors. Never hardcode a version-specific alias rewrite merely to match one account.
- [x] Run the new cases red, implement only demonstrated normalization/protocol fixes and rerun focused tests. If CLI and SDK intentionally expose different aliases, retain raw selectors and document/test that boundary rather than treating strict parity as passed.
- [x] Recheck cache isolation by harness/cwd, cancellation of one shared reader, stale responses after switching harness, timeout and unavailable fallback preserving saved selectors. Add assertions only where existing dashboard-catalog cases do not already cover the behavior.
- [x] Gate: fixture suite passes; selector discrepancy has a documented cause or remains OPEN with exact evidence. Effective runtime effort cannot be inferred from startup acceptance.

### Task 5 — Repeat authenticated discovery acceptance

**Files:** create test/live/model-discovery.mjs; docs/MODEL_DISCOVERY_VERIFICATION.md.
**Interface:** Driver takes --agent codex|claude|copilot, --cwd PATH and optional --worker-cwd PATH; default is prompt-free. Worker startup is a separate explicit mode, never an automatic discovery side effect.

- [x] Implement bounded version/catalog/process observation with sanitized logs, elapsed time, exit status, scope and retained fixture path. Exclude credentials, tokens and sensitive configuration. Driver tests use fake executables and require no account.
- [x] On native Linux repeat authenticated Copilot discovery with normal PATH, no symlink workaround, normal shutdown and readiness-synchronized interruption. Gate: valid catalog and no probe/CLI descendants after the Task 3 deadline.
- [ ] On a multi-model account compare picker versus SDK/runner selectors. Start one disposable supervised worker with an advertised non-auto selector; require accepted report, matching root stop and actual exit receipt for lifecycle success. Record requested and independently observed model separately. If account exposes only auto, mark multi-model BLOCKED.
- [ ] Check advertised CLI effort directly in a disposable CLI session only when supported. Record acceptance and effective effort independently; keep runner effort rejection covered. Supporting effort in the runner is a separate behavior change, not part of this plan.
- [x] Repeat Codex planning-root/actual-worker cwd parity with matching provider configuration. Repeat Claude direct protocol/SDK comparison and explicit/omitted effort startup. Record selector differences and unobservable effective effort without claiming parity or completed tasks.

### Task 6 — Close the remaining live lifecycle matrix

**Files:** test/live/codex-acceptance.mjs, test/live/windows-delegation.mjs; create test/live/claude-acceptance.mjs and test/live/copilot-acceptance.mjs; matching harness verification docs.
**Interface:** Reuse existing disposable repository and Runner lifecycle contracts. Live driver scenario flags must make requested inference, cancellation and approval explicit.

- [x] Create a matrix keyed by OS, harness, worktree backend, terminal backend and scenario. Seed only exact recorded passes: November 7 Codex credential/automated resume/archive and Windows delegated Git/manual Codex/Claude; November 4 lifecycle rows remain version-specific. Do not mark unrun combinations passed.
- [x] Add fake-driver regression tests for scenario parsing, bounded waiting, failure propagation, retained evidence and no automatic retry. Then implement driver scenarios using existing fixtures rather than duplicating state schemas.
- [ ] Verify interactive Codex token recall in a real terminal using the retained session and emitted expectedToken. Automated exec resume and reaching the trust dialog do not close this item.
- [ ] For Claude verify operation with Codex absent; routine/complex planner model/effort rationale; authentication and invalid-model failure; unsuccessful report and explicit retry; exact-session detach/reattach; report-before-exit integration/cleanup blocking. Record begin/session/report/commit/exit evidence per attempt.
- [ ] For Copilot CLI/editor verify hooks disabled, cancellation, interrupted supervisor and late stop, no fabricated successful receipt, explicit retry, and blocking review → repair → fresh review → final approval/archive where supported. Prior cancellation/recovery passes need not be mislabeled untested; rerun after relevant changes and identify uncovered host/backend rows.
- [ ] Verify cross-harness planner rules, homogeneous batches, mixed-harness rejection before resource creation and preservation of historical session identity. Reuse deterministic coverage; live checks establish installed compatibility only.
- [ ] Exercise native Windows delegated Codex/Claude Git/manual again only after relevant execution/protection changes; test other advertised backends explicitly before extending that verified scope.
- [ ] Gate each row independently: PASS with exact evidence, FAIL with regression reference, or BLOCKED with missing environment/account. Overall full-matrix completion requires every in-scope row to pass; selected rows are not blanket support.

### Task 7 — Optional bridge and presentation-provider acceptance

**Files:** src/harnesses/copilot-vscode.ts, test/copilot-config.test.mjs, test/presentation-brief.test.mjs; docs/COPILOT_SUPPORT_VERIFICATION.md and docs/delivery-summary-guide.md.
**Interface:** Existing generated .agent.md and explicit provider-config brief handoff; no new bridge or provider is installed automatically.

- [ ] Keep the optional VS Code discovery bridge DEFERRED unless explicitly pursued. For an existing authorized bridge, record profile/extension host and test consent granted, denied, unavailable host and catalog selector accepted by the generated agent. A displayed selector is not proof of worker selection.
- [x] Audit provider-config/brief tests for malformed JSON, missing/invalid skillPath/version, config-relative paths, missing provider, asset references and summary source digest/limitations. Add only missing behavior-focused cases, then run node test/helpers/run-tests.mjs test/presentation-brief.test.mjs test/summary-cli.test.mjs.
- [ ] If an installed provider is available and requested, perform a separate brief → outline review → deck/export smoke test. Record provider revision/source digest and inspect output. Fixture brief generation alone establishes no third-party rendering compatibility.
- [x] Shared Copilot assignment support remains OUT OF SCOPE: extending it requires a separate compatibility plan for old records, approval, import, review, repair and receipt export.

### Task 8 — Publish truthful coverage and final verification

**Files:** docs/maintenance-priorities.md, docs/MODEL_DISCOVERY_VERIFICATION.md, docs/*SUPPORT_VERIFICATION.md, docs/live-acceptance-guide.md, docs/README.md and this plan.

- [x] After each task update the matching verification record with date, commit, tool/runtime versions, exact command, result/counts, fixture/evidence location and any blocked reason. Temporary logs that no longer exist must be labeled unavailable, not linked as reproducible artifacts.
- [x] Mark checkboxes only after their assertions ran. Separate failed investigations from fixes and startup acceptance from observed runtime model/effort and complete lifecycle success.
- [x] Build, run pnpm test, exercise models --agent HARNESS --catalog --json for affected adapters, and pnpm pack --dry-run. Record unavailable authenticated checks independently. Confirm docs links and git diff --check.
- [x] Remove superseded active checklists only after preserving unique measured evidence and redirecting references. Retain dated historical records with supersession notices. Keep one current backlog in maintenance-priorities.md linking this plan.
- [x] Final report lists deterministic passes, native/live passes, unresolved failures, BLOCKED environments and optional/deferred work separately. No full-coverage claim while required rows remain open.
