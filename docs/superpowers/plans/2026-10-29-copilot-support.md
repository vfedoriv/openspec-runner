# Copilot Worker Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute implementation, review, and repair workers through GitHub Copilot CLI and VS Code Copilot using native chat and lifecycle hooks.

**Architecture:** Register separate adapters over a shared durable hook bridge. Preserve CLI process-exit supervision while adding explicit editor turn-completion evidence, with one completion policy shared by integration, feature, delegation, recovery, and cleanup.

**Tech Stack:** Existing strict TypeScript ESM, Node >=22.13, pnpm 11.7.0, node:test, Git worktrees, native Copilot/VS Code interfaces. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-29-copilot-support-design.md` (approved 2026-10-29).

## Global Constraints

- Register `copilot` and `copilot-vscode` as distinct harness IDs.
- Never substitute one for the other automatically, including during retries or recovery.
- Preserve existing version-1 Codex configuration, version-2 configuration, and saved Codex/Claude attempts.
- No general native Windows runner support; execute in the existing supported runner environment.
- Require explicit configured/default models for both harnesses; never inherit Codex calling-session settings.
- Never invent observed-model evidence or treat editor launcher exit as agent completion.
- Preserve existing project hooks, skills for other harnesses, and editor settings.
- No automatic redispatch after an ambiguous editor launch or supervisor failure.
- Tests exercise compiled modules; generated `dist/` is never committed.

## Review Focus

1. Existing editor instances may ignore launch environment variables: ownership must derive from prompt nonce and canonical worktree (Task 2).
2. A stopped supervisor does not imply a stopped editor: cleanup/retry retain uncertain resources (Tasks 4–5).
3. Hook replays, subagent events, or a competing chat cannot complete or steal a worker (Task 2).
4. A requested model is not an observed model; editor configuration must not imply runtime attestation (Tasks 3–4).
5. Existing init configuration must not be rewritten or filled with runnable model placeholders (Task 3).

## Task 1: Establish shared completion and supervision contracts

**Files:** Create `src/harnesses/lifecycle.ts`, `test/harness-lifecycle.test.mjs`; modify `src/harnesses/types.ts`, `src/runner.ts`, `src/feature.ts`, `src/feature-state.ts`, `src/worker.ts`.

**Interfaces:**
- Export `WorkerReceipt` from `harnesses/types.ts` for the current worker fields plus optional `completion: { source: "process-exit" | "agent-stop"; at: string; session: string }` and `launcher: { pid?: number; exitedAt?: string; exitCode?: number | null }`.
- Add optional adapter `lifecycle: { transport: "process" | "editor"; ownership: "environment" | "stream" | "hook"; reservedSession: boolean; skillPrefix: string }`; absent means existing Codex semantics.
- Export `completionProblem(attempt: TaskAttempt | FeatureJob): string | undefined` and `agentMayBeActive(attempt: TaskAttempt | FeatureJob): boolean` from `lifecycle.ts`. This module reads evidence only and performs no process calls.

- [ ] Write tests preserving historical Codex/Claude success/failure rules and rejecting synthetic Copilot results with only a report or only a zero launcher exit. Assert editor success requires matching hook session, report, terminal stop evidence, and explicit supervised completion; a process completion receipt cannot satisfy an editor worker.
- [ ] Run `pnpm run build` then `node --test test/harness-lifecycle.test.mjs`; confirm missing interfaces cause failure before implementation.
- [ ] Implement additive receipt/lifecycle contracts and the shared predicate. Preserve Claude identity, error-result, and successful child-exit checks exactly; do not retroactively require new fields on legacy attempts.
- [ ] Replace duplicate integration/feature successful-result checks with the shared predicate, retaining report/commit/fingerprint/cleanliness checks in their existing owners. Reuse `WorkerReceipt` for `TaskAttempt.worker`; `FeatureJob` inherits it.
- [ ] Run lifecycle, harness, runner, and feature tests; commit only this task's files with subject `Centralize worker completion evidence`.

## Task 2: Implement the durable hook bridge

**Files:** Create `src/harnesses/copilot-hooks.ts`, `src/harnesses/copilot-hook-cli.ts`, `test/copilot-hooks.test.mjs`; modify `src/cli.ts` to route the internal hook command before regular user command parsing.

**Interfaces:**
- `HookEvent` has `kind: "prompt" | "stop" | "end" | "error" | "tool"`, `session: string`, `cwd: string`, `at: string`, optional `prompt`, `subagent`, `recoverable`, and `reason`.
- `HookLease` has version 1, attempt/harness/worktree/nonce/supervisor-generation identity, armed timestamp, optional observed session, stop timestamp, error, and terminal status. Store one lease at `<stateDir>/hooks/<attempt>.json` using existing atomic writes and repository lock.
- Export `normalizeHook(eventName: string, value: unknown): HookEvent` and `armHookLease(input: { stateDir: string; attempt: string; harness: string; worktree: string; generation: string; nonce: string }): HookLease`.
- Export `recordHook(input: { stateDir: string; event: HookEvent }): { output: Record<string, unknown>; exitCode: number }` and `readHookLease(stateDir: string, attempt: string): HookLease | undefined`.
- `copilot-hook-cli.ts` exports `hookCommand(args: string[]): Promise<void>`; command syntax is `openspec-runner hook EVENT`, with event JSON on stdin. Limit input to 1 MiB and reserve stdout for the host's JSON response.

- [ ] Write schema fixtures for camelCase and VS Code compatible names/payloads. Assert equal normalized events, rejection of malformed/oversize data, and no mutation outside an armed runner worktree.
- [ ] Write nonce-binding tests: absent/wrong nonce, another cwd, symlink/canonical mismatch, another root session, subagent events, stale generation, timestamps before arming, and repeated stop. Assert only matching prompt-submitted evidence binds ownership; SessionStart alone cannot bind it.
- [ ] Run `node --test test/copilot-hooks.test.mjs` after build and confirm failure; implement bounded normalization, canonical-path matching, atomic idempotent transitions, and the command route.
- [ ] Add tool-event tests asserting neutral output outside runner scope and documented denial for a competing/completed owner in the armed worktree. Do not grant tools or replace existing host approval policy. Treat hook timeout/failure as missing evidence, never success.
- [ ] Verify stop/end/error ordering: recoverable tool errors allow later success; cancellation/unrecoverable error cannot become success; late events cannot reopen a terminal lease. Map only documented payloads and denial responses for each hook format.
- [ ] Run hook and lifecycle tests; commit with subject `Record Copilot lifecycle hooks durably`.

## Task 3: Add adapters, configuration, and installation

**Files:** Create `src/harnesses/copilot.ts`, `src/harnesses/copilot-vscode.ts`, `src/harnesses/copilot-settings.ts`, `harnesses/copilot/planning-rules.md`, `harnesses/copilot-vscode/planning-rules.md`, `test/copilot-config.test.mjs`; modify `src/harnesses/registry.ts`, `src/plan.ts`, `src/cli.ts`, `package.json`.

**Interfaces:**
- Export `copilotHarness: HarnessAdapter` and `copilotVscodeHarness: HarnessAdapter` with IDs from the spec and lifecycle metadata from Task 1.
- Export `resolveCopilotSettings(id: "copilot" | "copilot-vscode", assignment: Assignment, inherited?: HarnessSettings, config?: AgentConfig): HarnessSettings`.
- Options: `hookFormat: "copilot" | "vscode"` (default respectively), `startupTimeoutMs` (default 60000, range 1000–600000), `completionTimeoutMs` (default 1800000, range 1000–86400000); editor additionally accepts `executable` (default `code`) and optional `profile`. Reject control characters, unknown options, unsupported effort, and nonmatching inherited harnesses. User config cannot supply arbitrary argv.
- Extend `init(cwd?, selected?: string, defaultAgent?: string, defaultModel?: string)` and forward CLI `--default-model`. Preserve its current result shape.

- [ ] Test settings/configuration with explicit model, inherited CLI defaults, invalid session inheritance, unsupported effort, unknown options, different editor/CLI model strings, and options frozen in managed settings. Verify existing adapters reject unsupported adapter-owned options rather than silently accepting them.
- [ ] Test init for both new IDs and `all`: eight skills at `.github/skills`, no duplicate returned paths, runner-owned hook file only, existing user hooks untouched, existing runner.yaml byte-preserved, and required model when creating a Copilot default. Installing all skills retains existing Codex/Claude configuration without inventing models for other adapters.
- [ ] Run new tests and confirm failure; implement adapter settings, registry entries, options parsing, and installation. Install a bridge script that delegates to the installed runner command; avoid hardcoded developer checkout paths.
- [ ] Generate only one configured hook schema per worker. Verify existing runner-owned hook contents before replacing them; conflicting ownership fails with a useful path. Ensure hook installation and future worktree selection use the same reviewed format rather than emitting duplicate schemas.
- [ ] Implement non-inference capabilities probes and model-discovery results. CLI requires exact-session UUID selection, prompt/model/path/tool options used by the adapter; editor probes `code chat --help`, version, and Copilot extension presence. Report runtime hook handshake as required even when static prerequisites pass. Unsupported discovery is non-exhaustive, never fabricated.
- [ ] Add bundled hashed planning rules following the existing adapter pattern; update package description to describe registered harnesses. Run config/harness tests and package dry-run; commit with subject `Register Copilot harnesses and install their workflows`.

## Task 4: Execute and supervise both Copilot transports

**Files:** Create `src/harnesses/copilot-supervisor.ts`, `src/harnesses/copilot-editor.ts`, `test/copilot-worker.test.mjs`, `test/copilot-editor.test.mjs`; modify `src/worker.ts`, `src/runner.ts`, `src/feature.ts`, and adapters from Task 3.

**Interfaces:**
- Export `superviseCopilot(a: SupervisedSession & { id: string }, common: string, prompt: string, started: (pid: number) => void, evidence: (update: (current: SupervisedSession) => void) => void): Promise<number | null>`; keep the public `superviseWorker` signature backward compatible.
- Export `prepareEditorAgent(input: { worktree: string; attempt: string; model: string; hookFormat: "copilot" | "vscode" }): { mode: string; path: string }` from `copilot-editor.ts`. Write an attempt-specific `.github/agents/openspec-runner-ATTEMPT.agent.md`, excluded by exact runner-owned path, using safe YAML serialization.
- Extend `SupervisedSession` to include hook generation and explicit completion receipt fields required by Tasks 1–2. The supervisor uses the supplied evidence callback to persist observed ownership before begin/report acceptance.

- [ ] Fake `copilot` tests assert argument-array safety for Unicode/spaces, reserved UUID equality, exact resume ID, rejected unavailable flags, hook ownership, report/stop ordering, and actual nonzero process exit preventing integration. No blanket allow-all flags.
- [ ] Fake `code` tests exit the launcher immediately, delay hooks, and assert the worker remains unfinished. Deliver matching report then stop and assert `completion.source === "agent-stop"`; reverse/missing/wrong identity evidence cannot succeed.
- [ ] Add tests for startup/completion deadlines, launcher failure, missing hooks, canceled turn, recoverable tool error, environment variables not reaching an existing editor process, and a report followed by supervisor interruption. Assert uncertain liveness survives timeout/crash and keeps resources.
- [ ] Run tests to confirm failure. Implement dispatch with the armed nonce before spawning, controlled polling without holding repository locks, bounded deadlines, supervisor PID tracking, and separate launcher diagnostics. Retain the child-process-exit contract for CLI and explicit hook-completion contract for editor.
- [ ] Update task/feature prompts to use adapter skill prefixes and begin/report instructions. For Copilot, `begin` resolves only the already observed hook session, checks explicit overrides, and returns the session for the report. Never consult `CODEX_THREAD_ID` for Copilot. Apply identical rules to review and repair.
- [ ] Implement VS Code native fresh-chat launch in the exact worktree and selected custom mode/profile; never reuse an arbitrary active window. Verify selected mode/model discovery through real smoke steps; if the installed runtime cannot honor the native dispatch contract, report unsupported and retain resources instead of silently using CLI.
- [ ] Run worker, editor, legacy harness, and feature tests; commit with subject `Supervise Copilot CLI and editor workers`.

## Task 5: Integrate recovery, delegation, activity, and cleanup

**Files:** Modify `src/runner.ts`, `src/feature.ts`, `src/component.ts`, `src/cleanup.ts`, `src/terminal-cleanup.ts`, `src/activity-parser.ts`, `src/dashboard-reader.ts`, `src/dashboard-collector.ts`; create `test/copilot-lifecycle.test.mjs`. Change additional persisted-state readers only where they inspect these receipt fields.

**Interfaces:** Consume Task 1 predicates and Tasks 2–4 receipts; expose dispatch, observed session, completion source, and uncertainty through existing status/dashboard data, adding optional fields rather than changing historical required schemas. `resumeInvocation` for editor throws an explicit unsupported-exact-resume error; callers inspect capability before invoking it.

- [ ] Test complete task integration and managed review/repair with each Copilot harness; reject report-only, missing stop, nonzero CLI exit, stale report, and changed planning files. Include delegated import/inspection/export using both adapters and immutable approved settings.
- [ ] Test attach for CLI exact confirmed session; editor attach opens/focuses only the assigned worktree and identifies its chat without submitting a new prompt. Test that neither path redispatches a finished or ambiguous attempt.
- [ ] Test recovery and cleanup after supervisor death while editor status is uncertain. Preserve worktrees, keep retry/integration blocked, and expose the observed chat/session for operator inspection. A matching terminal hook can settle liveness; absent evidence requires explicit operator reconciliation, never inference from a dead supervisor alone. Use existing recovery commands to record reconciliation with concrete observed evidence; do not invent a successful result.
- [ ] Run tests to confirm failure; implement shared completion/liveness policies in integration, feature success, delegated export, retry, and cleanup. Store editor completion separately from child process exits in every reader.
- [ ] Normalize hook activity as diagnostic/turn/tool data using existing ActivityEntry shapes. Add a Copilot branch in the activity parser so unrecognized Copilot output remains raw rather than being decoded as Codex. Test that activity never replaces report/completion gates.
- [ ] Run lifecycle, cleanup, component, activity, dashboard, runner, and feature tests; commit with subject `Apply Copilot evidence across recovery and integration`.

## Task 6: Document and verify the supported workflow

**Files:** Modify `README.md`, `docs/user-guide.md`, `docs/dashboard-guide.md`, `docs/README.md`, the eight `skills/openspec-runner-*/SKILL.md` files; create `docs/COPILOT_SUPPORT_VERIFICATION.md`. Include the team workflow references where they enumerate supported harnesses or completion receipts.

- [ ] Add user-facing init, model, planning, launch/preview, attach, report, and recovery examples for both IDs. Explain editor model selectors, hook formats, explicit turn completion, same-host filesystem requirement, and exact-resume limitation. Replace Codex/Claude-only assumptions in skills without changing approval boundaries.
- [ ] Add authenticated manual smoke procedures for CLI plus VS Code extension/runtime combinations: selected model and custom agent, worktree path, session ownership, report, turn stop, canceled/missing hooks, retained resources, managed reviewer and repair, and delegated receipt. Record exact tested versions and mark unrun cases pending.
- [ ] Resolve environment-only validation prerequisites using the existing lockfile: locate a usable pinned pnpm, install `pnpm install --frozen-lockfile` when authorized network access permits, and run tests in the supported Linux/WSL environment. Do not change dependencies/lockfile or relax product platform gates to make local validation pass.
- [ ] Run `pnpm test` and require all existing/new tests to pass. Run `pnpm pack --dry-run`, and run affected init/models/planning-rules/status with `--json` plus launch/review/repair `--dry-run --json` against disposable fixtures. Record blocked commands honestly if the environment remains unavailable.
- [ ] Run real smoke checks when authenticated tools are available. Never claim editor compatibility based only on fake executables. Summarize requested versus actually observed model evidence explicitly.
- [ ] Review the whole change against the approved design, resolve actionable findings, run `git diff --check`, and commit documentation with subject `Document and verify Copilot worker support`.

## Self-review and execution handoff

Spec coverage: adapter/config/init/planning/model behavior is Task 3; native ownership and replay handling is Task 2; transport supervision and model selection is Task 4; implementation/review/repair/delegation/recovery/cleanup/activity compatibility is Tasks 1 and 5; user guidance and full verification is Task 6. Each Review Focus condition has a named test in its owning task. Internal interface names above are shared across dependent tasks.

Recommended execution: native in this session, because the six tasks share the hook lease, supervision, and completion contracts and benefit from one implementer preserving those invariants. Obtain the plan review and execution choice required by the writing-plans skill before starting product edits.
