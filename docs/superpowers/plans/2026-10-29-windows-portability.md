# Windows Portability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the existing task and managed-feature workflows natively on Windows for all four supported harnesses—Codex, Claude Code, Copilot CLI, and VS Code Copilot—without weakening their distinct lifecycle or recovery guarantees.

**Architecture:** Add focused filesystem, command, path, and process adapters beneath the existing shared runner. Enable Windows only for resource/harness combinations whose native contracts pass; retain Linux behavior and additive persisted-state compatibility.

**Tech Stack:** Existing strict TypeScript ESM, Node >=22.13, pnpm 11.7.0, node:test, Git for Windows, PowerShell, Codex CLI/app-server, Claude Code CLI, Copilot CLI, VS Code. No new runtime dependency by default.

**Spec:** `docs/superpowers/specs/2026-10-29-windows-portability-design.md`.

## Global Constraints

- Initial Windows target: local x64/NTFS, Git worktrees, manual terminals, and every supported harness: `codex`, `claude`, `copilot`, `copilot-vscode`.
- Existing Linux/WSL behavior must continue to pass its full suite.
- Keep file-data flushing, atomic replacement, exclusive immutable publication, locks, and snapshot-bound approvals.
- Do not use blanket `shell: true`, silently widen permissions, or migrate historical attempt identities.
- Unknown process/session identity retains resources and blocks automatic retry/cleanup.
- Preserve user's editor profile, hooks, authentication, and existing project configuration.
- Windows Codex and Claude Code support is required in the same delivery as both Copilot surfaces. Only Worktrunk/Herdr/Orca backends remain optional follow-up scope.
- Preserve each harness's native model/effort, session, permission, stream, and resume behavior; the platform layer does not convert one harness protocol into another.
- The user approved implementation. Verification and live acceptance status are recorded in `docs/WINDOWS_PORTABILITY_VERIFICATION.md`.

## Review Focus

1. A directory-flush workaround must not swallow a real file-write/rename failure (Task 1).
2. Prompts and paths containing spaces, quotes, `$`, `&`, `%`, `!`, Unicode, or newlines must remain literal across Windows launch boundaries (Task 2).
3. PID reuse, inaccessible process metadata, and a surviving descendant cannot authorize cleanup (Task 3).
4. Git path spelling, junctions, prefix collisions, and Windows mode bits cannot bypass worktree/context ownership (Task 4).
5. PATH/profile differences cannot make capability checks, Codex model discovery, worker execution, or hooks target another runtime; inherited Codex identity cannot claim Claude/Copilot work (Tasks 2, 5, 6).

## File map

Create `src/platform-files.ts`, `src/platform-command.ts`, `src/platform-process.ts`, and `src/platform-paths.ts`. They own OS differences, with platform-neutral coordination callers.

Update `system.ts`, `coordination-state.ts`, and persistence/immutable-store callers for storage; `worker.ts`, `codex.ts`, `submission.ts`, `dashboard-action-runner.ts`, and all four `src/harnesses/` adapters for command execution; `processes.ts`, `runner.ts`, `feature.ts`, `cleanup.ts`, and terminal cleanup for process identity; component/context and all harness planning-supplement readers for canonical paths/protection.

Update `cli.ts` and `dashboard-cli.ts` only at the enablement gate. Update test discovery, fake-tool helpers, package scripts, guides, and shared runner skills with their owning tasks. Create `test/windows-harnesses.test.mjs` for the required four-harness native lifecycle matrix.

### Task 1: Portable persistent-state and immutable-record writes

**Files:** Create `src/platform-files.ts`, `test/platform-files.test.mjs`; modify `src/system.ts`, `src/coordination-state.ts`, `src/summary-store.ts` where they duplicate replacement/publication behavior.

**Interfaces:** Export `flushDirectory(path: string): "flushed" | "unsupported"`, `replaceJson(path: string, value: unknown): void`, and `publishExclusive(path: string, bytes: Uint8Array): void`. Keep `atomic(path, value)` as a backward-compatible facade. The immutable publication function must fail on existing different bytes; its existing caller owns idempotence decisions.

- [ ] Write native temporary-directory tests: create and replace JSON successfully; on Windows directory flush returns `unsupported`; file fsync still executes; existing destination survives a failed replacement; immutable publication cannot overwrite an existing record.
- [ ] Add targeted fault-injection tests asserting EACCES/EPERM from file writes or replacement is propagated, not misclassified as unsupported directory flush. Expose injected filesystem operations only through the adapter's internal testable boundary, not runner APIs.
- [ ] Run `pnpm run build` and `node --test test/platform-files.test.mjs`; observe the current EPERM/missing-contract failures.
- [ ] Implement same-directory temporary writes, file fsync, close, replacement, and platform-specific directory flush. On Windows do not invoke the unsupported directory flush; document reduced power-loss durability. Limit replacement retries, if needed for transient sharing violations; do not retry arbitrary permission failures or delete the old destination first.
- [ ] Preserve exclusive immutable publication and global lock ownership. Audit all remaining direct directory-fsync sites and route them through this contract.
- [ ] Run persistence, coordination-state, summary-store, and lifecycle tests on Windows and Linux. Expected: green, unchanged persisted JSON identities, no overwrite or unlocked publication. Commit `Make runner state persistence portable`.

### Task 2: Safe Windows executable resolution, invocation, and command rendering

**Files:** Create `src/platform-command.ts`, `test/platform-command.test.mjs`; modify `src/system.ts`, `src/worker.ts`, `src/codex.ts`, `src/submission.ts`, `src/dashboard-action-runner.ts`, `src/harnesses/codex.ts`, `src/harnesses/claude.ts`, both Copilot adapters/supervisor, and hook installation in `src/cli.ts`.

**Interfaces:** Export `resolveCommand(input: { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }): { executable: string; args: string[]; env: NodeJS.ProcessEnv }` and `renderCommand(args: string[], shell: "powershell" | "posix"): string`. Existing `runRaw`, `run`, and `shellCommand` retain signatures and delegate to this boundary. Async callers use the same resolved executable/argv/environment rather than a second resolution algorithm.

- [ ] Write real child-process echo tests preserving literal `a b`, `x&y`, `$HOME`, `%PATH%`, `a!b`, quotes, Unicode, and a multiline prompt. Assert no expansion and no unintended file creation. Add a PowerShell-rendered command round trip with the same literals.
- [ ] Reproduce direct Node `code` ENOENT; test an installed-style `code.cmd` fixture that points to a versioned Code.exe/CLI entry point. Test explicit executable and profile selection plus an absent tool.
- [ ] Add Codex and Claude executable fixtures for supported native/package installations. Verify Codex worker, exact-session resume, capability probe, and app-server model/list all use the same resolver; verify Claude worker/resume/probe do too. Assert Claude stdin is byte-preserved, stream-json flags and tool patterns remain literal, and inherited CODEX_THREAD_ID is absent for Claude/Copilot but preserved for Codex where required.
- [ ] Run the new test file and observe failures. Implement host/PATHEXT resolution using the actual user environment available to the normal process; do not modify persistent PATH or assume privileged execution.
- [ ] Launch native executables directly. For known VS Code/Node CLI shims, resolve a validated direct entry point and preserve the required environment, including VS Code's Electron-as-Node setting. Read the installed wrapper's supported structure rather than hardcoding its version directory; reject unrecognized wrappers with an actionable direct-entry configuration error. Do not evaluate arbitrary wrapper text or interpolate prompts into cmd.exe.
- [ ] Add support for known installed runner/OpenSpec/Node-package shims used by setup and hooks; unsupported custom command wrappers require an explicit native executable/script descriptor. Route capability checks and execution through identical selection logic.
- [ ] Use PowerShell call-operator quoting for Windows operator commands; keep POSIX rendering for Linux. Install host-specific hook commands referencing the selected installed runner entry point so an existing editor process need not inherit a refreshed PATH. Do not commit machine-specific absolute paths into portable planning records.
- [ ] Run command, all four harness settings/init/model/resume, Codex app-server, Claude stream, dashboard action, and CLI JSON/preview tests on both OSes. Expected: exact literals and correct selected runtime/profile for every harness. Commit `Resolve and launch Windows command entry points safely`.

### Task 3: Windows process identity, descendants, and acknowledged termination

**Files:** Create `src/platform-process.ts`, `test/platform-process.test.mjs`; modify `src/processes.ts`, `src/runner.ts`, `src/feature.ts`, `src/worker.ts`, `src/codex.ts`, `src/terminal-cleanup.ts`, `src/dashboard-action-runner.ts`, and `src/harnesses/copilot-supervisor.ts`.

**Interfaces:** Export `observeProcess(pid: number): { pid: number; createdAt: string; parentPid?: number } | undefined`, `observeDescendants(pid: number): Array<{ pid: number; createdAt: string; parentPid?: number }> | undefined`, and `stopOwnedProcess(input: { pid: number; createdAt: string; timeoutMs: number }): Promise<{ stopped: boolean; uncertain: boolean }>`. Keep synchronous existing `processStart`/`shellProcesses` facades for their callers, normalizing the opaque creation token without reinterpreting historical Linux tokens.

- [ ] Write native helper-process tests covering stable creation identity, exited PID, a parent with a long-lived child, identity mismatch/PID reuse, denied metadata access, and an unrelated process that must survive termination of the owned worker.
- [ ] Write interrupted-worker tests for every harness: no report; report before supervisor death; nonzero/uncertain exit; surviving child; PID reuse; stale session. Also cover late Copilot stop, editor launcher exit, and Claude stream UUID mismatch/missing/error terminal result. Assert each native completion contract blocks integration/retry/cleanup appropriately; a Copilot stop cannot replace a Codex/Claude process receipt or Claude stream evidence.
- [ ] Add Codex app-server cancellation/timeout tests proving model discovery terminates only its own process tree and does not leave a discovery process behind or alter a worker session.
- [ ] Run the tests and observe current Windows missing-/proc behavior. Implement Windows identity/parentage inspection through a narrow local OS query with fixed scripts and validated integer PIDs; inspect no unrelated command lines or environment. Unknown access/results return uncertainty.
- [ ] Implement bounded termination of the owned process/confirmed descendants and re-observe identities before treating them as stopped. A Windows termination request is not a POSIX graceful SIGTERM contract. Never terminate the user's VS Code GUI as a worker-cleanup shortcut.
- [ ] Replace Linux-only recovery exclusions with platform-aware identity checks. Add an optional platform tag to new persisted process receipts; preserve legacy Linux interpretation, and mark ambiguous cross-host records uncertain.
- [ ] Run process, termination, recovery, cleanup, dashboard action, Codex discovery, and all four harness lifecycle tests on both OSes. Expected: no PID-reuse adoption, live-descendant cleanup, substituted session, or fabricated completion evidence. Commit `Track Windows worker identity and termination`.

### Task 4: Canonical paths, Git boundaries, and protected component context

**Files:** Create `src/platform-paths.ts`, `test/platform-paths.test.mjs`; modify `src/system.ts`, `src/adapters.ts`, `src/cleanup.ts`, `src/submission.ts`, `src/coordination-state.ts`, `src/component.ts`, `src/component-state.ts`, `src/feature-state.ts`, `src/harnesses/copilot-hooks.ts`, and planning-supplement path readers.

**Interfaces:** Export `samePath(a: string, b: string): boolean`, `containedPath(root: string, candidate: string): boolean`, and `protectContext(root: string): { verified: boolean; reason?: string }`. Filesystem comparisons use canonical identity; portable Git paths and repository IDs retain their existing byte/case semantics.

- [ ] Write Windows native path tests for `C:\\Repo` versus `c:/repo`, spaces/Unicode, trailing separators, `repo` versus `repo-other`, traversal, junction/symlink escape, alternate data streams, and redirected/moved worktrees. Case-sensitive directories and inaccessible/unsupported filesystems must fail closed rather than be globally lowercased.
- [ ] Add immutable-context tests: imported files retain exact approved bytes; files and directories cannot be replaced/modified through the supported worker identity after protection; a reopened binding detects changed protection or redirected paths.
- [ ] Run the tests and observe current lexical-equality/mode-bit failures. Implement canonical path handling shared by hook ownership, worktree inspection, Store identity, planning supplements, and cleanup. Audit `/dev/null` Git hook overrides and use an actual platform-neutral empty hooks directory where required.
- [ ] Test Codex/Claude add-directory arguments, Git-common/report paths, session persistence paths, and bundled/supplement planning rules with native Windows path spellings. Verify equivalent canonical-path checks in all harness adapters; no Copilot-only path workaround.
- [ ] Implement and verify an appropriate Windows protected-context policy with explicit cleanup/restoration rules. Do not interpret chmod(0444/0555) alone as a protected directory. If equivalent protection cannot be established under the current user, return an explicit unsupported delegated-execution capability; local workflows remain independently eligible.
- [ ] Run path, worktree, pinned-context, component import/export, and coordination tests on both OSes. Expected: canonical matching with no containment escape or weakened context gate. Commit `Enforce portable path and context ownership`.

### Task 5: Portable test harness and Windows capability enablement

**Files:** Create `test/windows-harnesses.test.mjs`; modify `test/helpers/run-tests.mjs`, `test/helpers/feature-fixture.mjs`, `test/helpers/coordination-fixture.mjs`, `test/helpers/fake-orca.mjs`, `package.json`, relevant `test/*.test.mjs` including `test/harness.test.mjs` and Copilot cases, `src/cli.ts`, `src/dashboard-cli.ts`, `src/adapters.ts`, and all harness capabilities.

**Interfaces:** The test helper accepts zero explicit files by discovering `test/*.test.mjs` internally, or accepts existing explicit file arguments; set `package.json` test to `pnpm run build && node test/helpers/run-tests.mjs`. Preserve reporter/watchdog behavior. Runtime capability checks return actionable unsupported reasons before resource mutation.

- [ ] Write test-discovery assertions for PowerShell/cmd-style literal glob arguments and no-argument discovery. Verify test files execute once, explicit files remain selectable, and watchdog/failure exit behavior remains correct.
- [ ] Replace shebang-only executable fixtures with shared native executable/Node-entry fixtures using Task 2's public command contract, including Codex/app-server, Claude, Copilot, Git, and OpenSpec tools. Enable Windows lifecycle tests rather than removing skip conditions before their fixtures are portable.
- [ ] Parameterize the native lifecycle matrix over `codex`, `claude`, `copilot`, and `copilot-vscode`; compare the covered IDs against `harnessIds()` so a registered harness cannot be silently omitted. For each run implementation, managed review, blocking finding, repair/integration, fresh review, cancellation, stale session, missing report, nonzero exit, supervisor crash, and cleanup. Assert dry-run creates no resources. Add each harness's JSON init/models/planning/status and exact-session resume checks (or truthful unsupported editor resume), plus direct Windows hook invocation for Copilot.
- [ ] Add protocol-specific cases: Codex actual thread identity and supported effort/model discovery; Claude split/CRLF stream-json decoding, reserved UUID equality, terminal error, permission/allowed-tool arguments and optional supported effort; Copilot hook replay/root stop; editor launcher-versus-agent completion. These checks must run natively on Windows, not only in Linux regressions.
- [ ] Test approved cross-harness roles: Codex implementation with Claude review/repair and the reverse, plus a Copilot role. Each batch remains homogeneous and historical attempts retain their harness/session. Do not reuse a calling Codex identity/model implicitly in another harness.
- [ ] Add preflight tests for unsupported Windows Worktrunk/Herdr/Orca, unavailable installed tool versions, and delegated context protection. All four harnesses are Windows implementation targets; missing live authentication is not grounds to omit their fake-worker coverage. Explicit unsupported resource selections fail before mutation; auto chooses verified Git/manual resources. Dashboard enablement must have portable cancellation/process behavior too.
- [ ] Replace the blanket Windows CLI/dashboard guards only after Tasks 1–4 contracts and the supported fake-worker lifecycle pass natively. Keep precise capability errors for remaining unsupported combinations and clarify authentication versus installation versus executable-resolution failures.
- [ ] Run exact `pnpm test` in ordinary Windows user execution and Linux/WSL, then `pnpm pack --dry-run`. Expected: zero failures; no Windows-specific skips for the enabled persistence/worker/recovery contracts. Commit `Enable verified native Windows runner workflows`.

### Task 6: Real acceptance for all supported harnesses and user guidance

**Files:** Create `docs/WINDOWS_PORTABILITY_VERIFICATION.md`; update `README.md`, `docs/user-guide.md`, `docs/dashboard-guide.md`, `docs/CLAUDE_CODE_SUPPORT_VERIFICATION.md`, `docs/COPILOT_SUPPORT_VERIFICATION.md`, and the shared runner skills where platform/session guidance changes.

- [ ] Record OS, filesystem, Node, Git, PowerShell, pnpm, Codex, Claude Code, Copilot CLI, VS Code, profile, and hook versions. Distinguish normal execution visibility from restricted tool visibility; do not conclude absence from a redirected PATH. Use the authenticated normal Windows user environment for live tests.
- [ ] Create separate disposable native Git repositories for each harness with Git/manual resources and real model selections. For Codex verify model/list, supported effort, actual CODEX_THREAD_ID, successful supervised exit, exact resume, and integration. For Claude verify stdin prompt, stream-confirmed reserved UUID, permission/tool policy, successful terminal result/exit, exact resume, and integration. For Copilot CLI verify exact reserved/hook session, report/root stop/exit and integration. Run JSON previews before actual workers.
- [ ] Repeat using the installed VS Code profile: correct workspace/custom agent/requested model, actual hook ownership, accepted report, root stop, and editor completion receipt despite the launcher exiting earlier. Verify existing unrelated editor windows cannot claim the attempt and attach does not submit another prompt.
- [ ] For every harness, exercise a blocking managed review, repair/integration, fresh review, and final approval boundary. Validate approved cross-harness role selection too. Exercise cancellation and supervisor interruption for all four, missing/error stream results for Claude, and disabled hooks for Copilot; retained resources must remain inspectable without automatic redispatch. Validate delegated handoff only when Task 4 protection is verified.
- [ ] Publish a four-row harness acceptance matrix with separate capability, native fake-worker, authenticated implementation, managed lifecycle, and recovery results. Include command discovery, profiles, path quoting, NTFS state durability, optional backends, and process uncertainty. Mark unavailable authenticated checks pending; no overall claim that all harnesses are live-verified until all four rows pass. Missing credentials/tools must not silently reduce implementation scope.
- [ ] Run final build, Windows/Linux suites, package dry-run, and a whole-change review. Record evidence and unresolved limitations. Commit `Document and verify native Windows portability`.

## Self-review and execution handoff

Coverage: Task 1 owns persistence/exclusive publication, Task 2 owns command selection/quoting for all harnesses and Codex discovery, Task 3 owns recovery/process evidence across both worker supervisors and app-server, Task 4 owns shared path/protection invariants, Task 5 owns the complete four-harness native matrix and enablement, and Task 6 owns real-runtime acceptance/documentation for every supported harness. Every Review Focus class has concrete tests in its owning task. The interfaces above preserve existing synchronous facades where required and add platform metadata without migrating old receipts.

Recommended execution is inline in this chat, preserving the user's prior choice to let the assistant select the method. The platform contracts are tightly coupled and should be implemented in order, with one fresh whole-change review at the end. This plan does not itself enable Windows or authorize running workers in the user's normal repositories.
