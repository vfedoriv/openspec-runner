# Copilot Store Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Support Store-backed implementation, review and repair through Copilot CLI and VS Code Copilot without installing runner configuration or planning artifacts in code repositories.

**Architecture:** Proposed for review: retain the existing process/editor transports and hook-confirmed session ownership. Thread the validated Store execution scope through launch, hooks, report acceptance, inspection and recovery. Generate only disposable, ignored integration files inside assigned worktrees where the host requires discovery there; keep durable state in the assignment's Store runtime.

**Tech Stack:** TypeScript ESM, Node >=22.13, pnpm 11.7.0, node:test, optional @microsoft/copilot-sdk 2.0.1, installed Copilot CLI and VS Code Copilot Chat.

**Spec:** User request dated 2026-11-22; existing contract in `docs/store-only-workflow.md`. This is a proposed design and implementation plan; Store implementation has not been authorized by this planning request.

## Execution status — 2026-11-22

The user subsequently authorized implementation and explicitly approved using dev. Runtime routing, disposable hooks, CLI/editor scope and recovery lookups are implemented in the working tree. End-to-end simulated Store implementation/review/repair passes for both Copilot surfaces under the Windows standard-token fixture, including scoped CLI preview and stale hook rejection. Coordination contract validation also required adding both Copilot surfaces; that missing prerequisite was discovered by the lifecycle regression. Source review found and verified the fix for accepting tracked hooks. See [the verification record](../../verification/2026-11-22-copilot-store.md).

Ruling: keep changes reviewable in the authorized checkout; do not merge or publish. Preserve local report-path compatibility rather than applying Store report layout to local attempts. Use trusted state directories from the existing Runner/Feature context for lifecycle lookup, retaining common Git identity separately. Live native editor discovery and Linux cancellation cannot be proved by simulated Windows tests and remain explicitly unverified. Full-suite failures must be reported separately from focused passing tests. The user also requested and received a global OpenSpec 2.1.1 installation during implementation.

## Findings and alternatives

The SDK dependency and lockfile already specify 2.0.1. Restore the installation with `pnpm install --frozen-lockfile`; no dependency-range edit is needed. Keep the SDK in the isolated model-discovery subprocess. Replacing CLI execution with SDK sessions would require new ownership, cancellation and terminal-evidence semantics and would not implement editor support. Requiring code-local init is simpler but contradicts the Store-only workflow. Extend the current transports instead.

`src/worker.ts` takes the hook-owned branch before passing Store scope to an invocation. `copilot-supervisor.ts` derives its lease directory from code Git metadata, requires committed `.github/hooks/openspec-runner.json`, and creates sibling reports. `copilot.ts` also hardcodes sibling reports and ignores the Store argument. `copilot-hook-cli.ts` resolves only code-local state. `lifecycle.ts` repeats that assumption for refresh and Linux stop proofs. `copilot-editor.ts` generates per-attempt agents and writes code-common Git exclusions. Fix the complete lifecycle rather than launch alone.

## Upstream review

- [Copilot SDK 2.0.1 release](https://github.com/microsoft/copilot-sdk/releases/tag/v2.0.1): compatibility updates and model selection support do not introduce runner Store routing. Keep selectors opaque and preserve the existing no-effort rule for Copilot.
- [OpenSpec 2.1.1 release](https://github.com/Fission-AI/OpenSpec/releases/tag/v2.1.1): bundled offline skill installation, archive preflight/formatting/retirement fixes, validation fixes and install-aware upgrade guidance. These warrant compatibility checks, not replacement of runner coordination.
- [Versioned OpenSpec changelog](https://github.com/Fission-AI/OpenSpec/blob/v2.1.1/CHANGELOG.md): the earlier 2.1.0 skill-scope change also matters. Scripted init must explicitly request project scope when that is intended; do not assume init writes repository-local skills.
- OpenSpec CLI `--store` selects a registered ID; runner `--store` selects a checkout path. Preserve this distinction and continue resolving/pinning structured context through `openspec-context.ts` and `planning-source.ts`. Never pass a checkout path as an upstream Store ID or infer a Store from a repository name.

## Global constraints

- Store planning, configuration, progress, runtime and archives remain in the Store. Code repositories contain implementation and tests.
- No code-local init, committed runner hooks, configuration, skills or planning artifacts are prerequisites for Store execution.
- Transient host-discovery files are permitted only in owned worker worktrees, excluded from commits, identity-bound, and cleaned only after existing termination gates pass.
- Preserve existing local workflows and version-1 linked histories; do not reinterpret active attempts or move their leases automatically.
- Resolve Store authority from trusted runner execution context. Hook input, environment paths and mutable worktree files cannot independently authorize a Store runtime.
- Preserve hook-confirmed root session, generation/nonce checks, report acceptance and terminal evidence. Requested model is not observed model evidence; VS Code exact resume remains unsupported.
- Keep existing Windows protection and Linux process-identity/stop-proof gates. No weaker cleanup or signaling policy for Store workers.

## Review focus

1. Same code clone assigned to two Stores: reject stale or mismatched binding (Tasks 1–2).
2. Redirected paths, spaces and injected hook input: reject escape and preserve argument boundaries (Tasks 1–3).
3. Interrupted launch/editor sessions: retain resources until ownership and termination are proven (Tasks 2–4).
4. Existing user hooks/agent files and tracked files: preserve them and avoid staging generated integration files (Tasks 2–4).
5. Updated OpenSpec skill scopes/JSON behavior: fail with actionable capability diagnostics, never silently fall back to local planning (Task 5).

## Task 1: Define one trusted Copilot runtime resolver

**Files:** Create `src/harnesses/copilot-runtime.ts`; modify `src/harnesses/types.ts`, `src/worker.ts`, `src/harnesses/copilot-supervisor.ts`; create `test/copilot-store.test.mjs`.

**Interfaces:** Add `resolveCopilotRuntime(input: { common: string; worktree: string; store?: StoreInvocationScope }): { stateDir: string; reportsDir: string }`. Local state remains `<common>/openspec-runner`; Store state is exactly the validated assignment `runtimeDir`; reports are beneath that state. Reuse Store binding/path validation instead of creating a separate authority protocol. Pass optional Store scope into `superviseCopilot`.

- [ ] Write tests asserting exact local and Store paths, independent clone separation, wrong assignment rejection, and rejection of redirected/out-of-scope runtime paths.
- [ ] Build and run `node --test test/copilot-store.test.mjs`; confirm new assertions fail before implementation.
- [ ] Implement the resolver and propagate scope before the hook-owned early return. Preserve current local report locations where existing local behavior differs; encode that distinction explicitly in resolver tests.
- [ ] Run the new tests and existing `test/copilot-worker.test.mjs`; require no failures. Commit this unit.

## Task 2: Make hook provisioning and report ownership Store-aware

**Files:** Modify `src/harnesses/copilot-supervisor.ts`, `src/harnesses/copilot-hooks.ts`, `src/harnesses/copilot-hook-cli.ts`, `src/runner.ts`, `src/feature.ts`; create `src/harnesses/copilot-store-hooks.ts`; extend `test/copilot-store.test.mjs` and `test/copilot-hooks.test.mjs`.

**Interfaces:** Add `prepareStoreCopilotHooks(input: { worktree: string; attempt: string; scope: StoreInvocationScope }): { path: string }`. Generate from the same hook definitions used by local installation (locate/extract their existing generator rather than duplicating templates). Resolve hook execution context using the existing Store binding/assignment identity and trusted runtime descriptor. Do not trust a raw stateDir in the event payload.

- [ ] Add failing tests for a code repository with no `.github` or local OpenSpec setup: provision hooks, bind the actual root session, accept a scoped report, record stop in the same Store lease directory, and reject forged/stale/cross-assignment hooks.
- [ ] Add tests preserving preexisting user hooks and rejecting a conflicting runner-owned hook rather than overwriting it. Verify transient files never enter the implementation commit or canonical Store history.
- [ ] Provision hooks before launch in the assigned worktree; quote the pinned runner command for both supported shells. Extend hook command parsing only as necessary to carry the trusted descriptor. Use matching scoped state for report acceptance and hook stop/report checks.
- [ ] Run `node --test test/copilot-store.test.mjs test/copilot-hooks.test.mjs test/copilot-worker.test.mjs`; require all applicable tests pass. Commit.

## Task 3: Route CLI permissions and VS Code discovery

**Files:** Modify `src/harnesses/copilot.ts`, `src/harnesses/copilot-vscode.ts`, `src/harnesses/copilot-editor.ts`, `src/harnesses/copilot-supervisor.ts`; extend `test/copilot-config.test.mjs`, `test/copilot-store.test.mjs`.

**Interfaces:** Consume the existing trailing optional `StoreInvocationScope` in CLI initial/resume invocation. Extend `prepareEditorAgent` input with optional Store scope and use the runtime resolver from Task 1. Keep editor model/profile handling unchanged.

- [ ] Add failing CLI assertions that invocation grants the assignment runtime, includes no unrelated Store/code-common writes, and retains common Git access needed for implementation. Assert resume uses the same scope.
- [ ] Add editor tests that preparation targets the assigned folder/profile, discovers the transient agent and hooks without code-local init, preserves the selected model, and preserves user files. Verify paths with spaces and Windows drive paths.
- [ ] Implement scoped CLI access and disposable editor discovery using documented host capabilities. Validate actual host discovery in a disposable fixture before claiming support; an unsupported host gets an actionable readiness error. Avoid adding the whole Store as a writable editor workspace folder.
- [ ] Run `node --test test/copilot-config.test.mjs test/copilot-store.test.mjs test/copilot-worker.test.mjs`; require no failures. Commit.

## Task 4: Carry scope through inspection, recovery and cleanup

**Files:** Modify `src/harnesses/lifecycle.ts`, `src/runner.ts`, `src/feature.ts`; extend `test/copilot-recovery.test.mjs`, `test/copilot-termination.test.mjs`, `test/copilot-store.test.mjs`.

**Interfaces:** Extend `refreshCopilotEvidence`, `prepareCopilotStop`, and `preparedCopilotStopIsGone` with trailing optional Store scope, preserving existing callers. Route every lease lookup through Task 1's resolver. Keep code Git identity separate from runtime location in process/stop proofs; inspect helper call chains before changing signatures.

- [ ] Add failing public Runner/Feature tests covering Store begin, report, status, successful integration and review/repair; blocked reports; crash before binding; stop before report; retry; interrupted cancellation; uncertain editor termination; and wrong-generation evidence.
- [ ] Extend Linux stop-proof tests so Store scope changes cannot authorize stale process termination. Verify local persisted attempts retain their original lease locations and ambiguous legacy Store attempts fail with an inspection/retry diagnostic.
- [ ] Thread scope through all evidence refresh and recovery callers, including retry/prepare-stop paths. Keep disposable integrations until successful owned cleanup; never delete user integrations or move old leases automatically.
- [ ] Run `node --test test/copilot-recovery.test.mjs test/copilot-termination.test.mjs test/copilot-store.test.mjs`; require all applicable cases pass. Commit.

## Task 5: Prove Store lifecycle and OpenSpec 2.1.1 compatibility

**Files:** Extend `test/store-only-multi-repo.test.mjs`, `test/windows-harnesses.test.mjs`, `test/openspec-context.test.mjs`; update `docs/store-only-workflow.md`, `docs/COPILOT_SUPPORT_VERIFICATION.md`, `docs/ACCEPTANCE_MATRIX.md`, `README.md`; create `docs/verification/2026-11-22-copilot-store.md` at implementation time with actual results.

- [ ] Parameterize Store worker fixtures for both Copilot surfaces using fake executables/hooks and cover task implementation, review, repair, integration, export/acceptance and archive. Start from clean code repositories without installed runner artifacts. Assert all durable runtime resides in the Store and code trees remain free of planning/configuration files.
- [ ] Add representative version-2.1.1 structured-context fixtures and a real isolated CLI compatibility check: explicit Store ID, project pointer, no root/stale ID, strict validation and existing archive collision. Preserve runner authority checks even when upstream actionContext allows broader edits. Scope skill installs explicitly; never run update/init against real code repositories as part of the check.
- [ ] Run `pnpm test`, `pnpm pack --dry-run`, and affected scoped `launch --dry-run --json` commands. Require no unexpected failures and inspect packaged generated-file exclusions.
- [ ] Perform separate live Windows and Linux Copilot CLI checks and a native VS Code check, with exact installed versions recorded. Verify read access to pinned instructions, begin/report/stop, scoped runtime, no staged generated files, and owned cleanup. Fake editor tests cannot establish native editor support. Mark unavailable host/account checks as unverified rather than passed.
- [ ] Document supported host versions, readiness diagnostics, transient worktree files, local-history compatibility and remaining host limits; commit only after recorded evidence supports each claim.

## Acceptance and execution boundary

The dependency restoration is requested now. The implementation tasks above are proposed only. Review this plan before implementation. Full support requires both surfaces to complete a Store lifecycle from code repositories with no prior runner installation, while retaining all existing identity and cleanup guarantees.

## Preparation verification — 2026-11-22

- `pnpm install --frozen-lockfile` completed using pnpm 11.7.0, replacing the installed legacy SDK 1.0.34 with @microsoft/copilot-sdk 2.0.1. Manifest and lockfile already matched; neither changed.
- Installed package metadata confirms 2.0.1; an ESM import confirms CopilotClient and RuntimeConnection exports. A preliminary CommonJS eval import hit the SDK's eval filename handling; normal ESM import succeeded.
- The build phase of `pnpm test` passed. Focused SDK/configuration/hook checks passed 11/11 outside the sandbox. A sandbox-only run failed on Git dubious ownership in a temporary repository and passed on rerun outside it, without modifying global Git trust.
- Full `pnpm test` was attempted but did not pass: Claude timeout fallback failed, and the run was interrupted while other integration suites were still active. This is not full-suite verification. No claim is made about live Store execution or native editor support.
- Only this proposed plan was added to tracked-source scope. Existing untracked `.idea/encodings.xml` was left untouched. No product implementation, commit, global OpenSpec upgrade or OpenSpec project initialization was performed.
