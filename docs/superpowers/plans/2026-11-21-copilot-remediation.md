# Copilot Compatibility and Recovery Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. If delegated, preserve the user's GPT-6.1 Sol / low-effort worker preference. Original implementation requirements are preserved below; the dated disposition records completed, deferred and blocked scope.

**Goal:** Restore compatible Copilot discovery and reliable Linux recovery, and make the current Free/Fusion-only experience accurate without advertising unavailable choices.

**Architecture:** Keep SDK discovery in the isolated probe subprocess and actual workers on the existing CLI/hook supervisor. Migrate the optional SDK to an explicit v2 spawned transport. Extend process recovery only with identity-bound, fail-closed evidence. Deliver SDK compatibility, account-specific UI validation and Linux recovery as separately reviewable changes.

**Tech stack:** TypeScript ESM, Node >=22.13, pnpm11.7.0, node:test, optional @microsoft/copilot-sdk2.0.1, installed Copilot CLI.

**Requirements:** User's Copilot remediation request and clarification: their current **Free subscription exposes Fusion only and does not permit model/effort selection**. Existing boundaries/evidence: [acceptance record](../../verification/2026-11-21-acceptance.md), [matrix](../../ACCEPTANCE_MATRIX.md), [current limits](../../DOCUMENTED_LIMITS.md).

## Disposition — 2026-11-22

Product source/dist frozen at `af44ca3`; final acceptance driver/tests at
`8dc7e82`. Tasks1–5 implemented and independently reviewed;
Tasks6–7 documentation/distribution verification records the final stable tree.
See the [durable remediation record](../../verification/2026-11-22-copilot-remediation.md)
for exact versions, commands, identities and limits. Checkboxes below close the
scoped requirement or its explicit conditional disposition; they do not turn
external or intentionally deferred support into a live PASS.

- COMPLETED P0: SDK2.0.1 explicit installed CLI1.0.114 spawned transport, actual
  protocol4 initialization, prompt-free auto/Auto catalog and SIGINT130/SIGTERM143
  no-survivor checks. No implicit in-process/remote/bundled fallback.
- COMPLETED P1: Free auto worker and prepared Linux late-stop plus explicit
  distinct independent real-exit retry/integration. User-observed Copilot Fusion
  label→auto mapping and concrete routed model remain independently unproved.
- BLOCKED safely: abrupt-before-root-stop/no-report loss and historical unprepared
  records. They gain no proof, successful completion or automatic retry.
- DEFERRED: paid non-auto/effort and optional VS Code discovery bridge. Editor
  live and native Windows checks remain BLOCKED on this Linux host.
- UNSUPPORTED: Store-linked Copilot authority; existing validators unchanged.
- COMPLETED review: whole branch `19a33bb..12b48a2`, followed by confirmed P2
  driver failure-cleanup correction `8dc7e82` and scoped re-review PASS with no
  new findings. Product source/dist unchanged; no additional inference needed.
- DEFERRED nonblocking P3: known-capable CI guard against unexpected pidfd
  capability skips; current native checkpoint had no such skips.

## Decisions and boundaries

- P0: compatible prompt-free discovery; P1: Fusion-only end-to-end behavior and Linux recovery. Premium model/effort enablement is not a prerequisite for delivering these fixes.
- The Fusion display label is not assumed to be a selector. Discover and verify the accepted selector; prior `auto` observations are historical, not a promise that `fusion` is valid or that the routed model is known.
- Preserve requested selector, observed runtime model and provider label as separate facts. Never silently replace a rejected explicit selector with auto/Fusion.
- No global CLI downgrade, credential change, trust change or subscription change. Lockfile/package-local SDK upgrade is part of this plan. No premium-model probes against the Free account.
- Discovery submits no prompt and creates no session. Paid inference, if ever needed for a later phase, is outside current Free-account acceptance.
- Keep optional dependency behavior: absence of SDK/runtime artifacts must not break ordinary runner commands or direct CLI worker execution.
- Do not use SDK v2's implicit in-process default. Require explicit spawned transport within the existing isolated probe. No automatic connection to a remote runtime/server.
- Preserve exact root session, nonce/generation, accepted report, genuine exit/completion, snapshot approval and explicit retry rules. A crashed supervisor remains failed with null exit and no invented success receipt.
- Shared Copilot assignments, new VS Code discovery bridge, exact editor-chat resume and enabling editor effort are separate follow-up projects. Keep existing validators rejecting unsupported shared harnesses.
- Preserve existing Node floor unless actual v2 package/runtime requirements prove it insufficient; stop that subtask with evidence rather than silently raising it.

## Versioned sources and migration caution

Use these tagged sources, not stale unversioned snippets:
- [v2.0.1 Node API](https://github.com/microsoft/copilot-sdk/blob/v2.0.1/nodejs/README.md): `runtime`, explicit `mode`, `forSpawnedStdio`, optional platform runtime artifacts.
- [v2.0.1 protocol](https://github.com/microsoft/copilot-sdk/blob/v2.0.1/sdk-protocol-version.json): protocol4.
- [v2.0.1 release](https://github.com/microsoft/copilot-sdk/releases/tag/v2.0.1).

Context7 currently returns older `connection`/`forStdio` examples. Resolve/query it at execution time, but compare with the tagged package types/source before implementing. Do not copy a 1.x example into the v2 probe. Verify actual published package metadata and platform artifact versions; do not treat development placeholders on main as release versions.

## Review focus

1. SDK/CLI protocol drift and missing optional native artifacts must produce useful safe diagnostics (Tasks1–2).
2. Bundled-runtime and installed-worker contexts can advertise different catalogs; do not substitute them silently (Tasks1–3).
3. Fusion label, selectable ID and routed model must not be conflated; Free users must not be offered unsupported effort (Task3).
4. Late stop/report, detached descendants, PID reuse, reboot and foreign-platform state cannot unlock unsafe retry (Tasks4–5).
5. A successful listModels or root-stop event never substitutes for session/report/process-exit evidence (all acceptance tasks).

## Task 1 — Pin and prove the v2 runtime contract

**Files:** package.json, pnpm-lock.yaml; create test/copilot-sdk-v2.test.mjs; use test/live/model-discovery.mjs.
**Interface:** Existing `copilotHarness.models(options)` and catalog schema remain compatible; no persisted state migration in this task.

- [x] Record installed CLI/version/protocol, package1.0.34 baseline failure and Node/pnpm/platform. Reproduce protocol3-versus4 startup failure in an isolated fixture, retaining sanitized error and zero inference.
- [x] Pin optional `@microsoft/copilot-sdk` to2.0.1, remove old direct package pin and update the lockfile using pnpm. Inspect the actual installed types, exported factories, stop return/error behavior, optional platform artifacts and supported Node floor. No global installation.
- [x] Add a failing contract fixture that rejects old `connection`/`forStdio`, implicit transport/mode, user prompts/session creation, and mismatched cwd/config. Assert the intended v2 construction explicitly uses `mode:"coding-agent"` and `runtime:RuntimeConnection.forSpawnedStdio(...)`.
- [x] In a bounded prompt-free spike, test explicit installed-CLI transport against its actual flags/protocol. Preferred outcome: the same installed CLI and cwd/config as workers. A matching protocol number alone is insufficient launch compatibility proof.
- [x] If installed CLI is not a supported v2 spawned entry point, use the pinned SDK's bundled spawned runtime instead, record that source/version in evidence and compare its catalog/auth/config with the actual CLI worker. Do not silently fall back between sources. If parity cannot be established, return an explicitly scoped/unavailable catalog rather than claiming worker compatibility.
- [x] Run build and new contract tests. Gate: a real protocol4 initialization and prompt-free model list with the selected explicit transport, or an exact external blocker; no SDK session/user turn or survivors. Commit this task only after the probe migration in Task2 makes the dependency change usable.

## Task 2 — Migrate discovery and retain cleanup guarantees

**Files:** src/harnesses/copilot-model-probe.ts, src/harnesses/copilot.ts; test/copilot-model-discovery.test.mjs, test/copilot-sdk-v2.test.mjs.
**Interface:** Preserve `models({discover,cwd})`, raw/fatal protocol handling, existing CLI JSON fields and unavailable fallback.

- [x] Update the probe import/construction to the verified Task1 v2 contract. Keep SDK imports isolated from main CLI startup. Adapt shutdown to actual v2 types; do not assume v1 `stop()` returns an error array.
- [x] Add red cases for protocol mismatch, SDK absent, runtime artifact absent/wrong architecture, unsupported executable wrapper, failed start/list/stop and interrupted/hung stop. Distinguish authentication, compatibility and unavailable-runtime reasons using fixed safe messages; never forward raw credentials/provider stderr.
- [x] Preserve absolute executable handling when selecting installed CLI, fatal UTF-8 decoding, control-selector rejection, no available payload before successful shutdown, and nonzero130/143 with empty success stdout on interruption.
- [x] Adapt copied SDK fixtures to exercise the real v2 API shape. Keep positive controls: no-session marker actually detects session creation; executable marker actually detects execution; unrelated sentinel stays alive.
- [x] Run `pnpm run build`, then `node test/helpers/run-tests.mjs test/copilot-sdk-v2.test.mjs test/copilot-model-discovery.test.mjs test/dashboard-actions.test.mjs test/platform-process.test.mjs`. Gate: no leaked owned identities on normal/error/timeout/SIGINT/SIGTERM/dashboard-abort paths; no regression to clipboard owners, mutation immunity or uncertainty reporting.
- [x] Exercise `models --agent copilot --catalog --json` on the current Free account. Require valid observed catalog, explicit runtime source/context in evidence, bounded shutdown and no inference. Recheck task1 runtime-source decision before accepting the migration.

## Task 3 — Deliver and verify the Free/Fusion-only experience

**Files:** src/model-catalog.ts, src/dashboard-catalog.ts, src/dashboard-ui.tsx, src/harnesses/copilot.ts, src/harnesses/copilot-settings.ts; test/dashboard-catalog.test.mjs, test/dashboard-layout.test.mjs, test/copilot-config.test.mjs, test/live/model-discovery.mjs, test/live/copilot-acceptance.mjs.
**Interface:** Preserve opaque selectors and existing saved settings. Add metadata only if needed, backwards compatibly; a provider reference is not an account entitlement or worker harness.

- [x] Capture the Free account's picker label and SDK catalog separately. Map Fusion to an actual CLI-accepted discovered selector through a disposable supervised worker, not by lowercasing a label. Verify report/root-stop/real zero exit before integration.
- [x] Add fixtures for one valid selector labelled Fusion, unavailable catalog, changed label with unchanged ID, stale saved premium selector and unexpected extra metadata. Confirm no synthetic list of premium models or invented effort values appears.
- [x] If the available catalog has one choice, show that choice without implying another model/effort can be selected. Keep effort unavailable for this adapter/account. Test keyboard reachability and confirmation at40/80 columns, including no accidental low/high effort submission from a previously selected Claude form.
- [x] Do not infer subscription tier solely from one catalog entry or invent an entitlement API. Use runtime-supported entries/capabilities and the explicitly verified Free environment. A stale saved selector may remain visible as saved, but must not be presented as currently advertised or silently remapped.
- [x] Compare planning-root and actual managed-worker context, picker/catalog selector and requested/observed model facts. Gate: one Fusion-compatible worker completes and integrates, existing `--effort` rejection remains actionable, and unavailable account choices are not offered.
- [x] Record effective model/effort as unobserved if the runtime supplies no independent evidence. Tests and UI must not claim that auto/Fusion names a concrete model.

## Task 4 — Add identity-bound Linux stale-launcher reconciliation

**Files:** src/platform-process.ts, src/harnesses/lifecycle.ts, src/runner.ts and src/feature.ts only at existing recovery call sites; test/platform-process.test.mjs, test/copilot-recovery.test.mjs, test/feature-contract.test.mjs.
**Interface:** Preserve Windows recovery and saved record compatibility. Introduce a narrowly scoped platform proof behind `recoverCopilotLauncher`, rather than deleting its Windows guard and reusing timestamp parsing on Linux.

- [x] Read the retained late-stop result in the acceptance record. Add a red Linux attempt and feature-job regression: exact confirmed session+matching root stop, supervisor failed/null exit, known vanished supervisor and launcher trees; explicit retry preview currently blocks.
- [x] Define affirmative Linux proof using creation identity plus host/boot identity and owned descendant evidence retained before disappearance. If existing records lack sufficient provenance, keep them blocked; specify new optional evidence fields in the relevant attempt/job types and validate/roundtrip them. Do not assume a vanished parent PID proves its descendants vanished.
- [x] Add a proof truth table: live root/child, detached survivor, reused PID, different boot/host/platform, unreadable /proc, missing identity, unknown descendants, stale generation/session/root stop, mismatched report and interrupted write. Every uncertain case preserves the old bytes/guards. Windows ISO timestamps must never be interpreted as Linux start ticks.
- [x] Implement only the proved-stopped transition: acknowledge launcher exit with null evidence, keep failed task/job and worker null exit, create no completion receipt, retain logs/worktrees/context. Then permit explicit retry preview/new attempt; integration of the old attempt must still reject.
- [x] Test idempotent recovery and interrupted persistence through public Runner/Feature commands, not manual state repair. Late reports/commands from old attempt cannot mutate the replacement. Retain historical session identity.
- [x] Run build and focused recovery/platform/feature suites. Gate: valid proved-stopped Linux case permits explicit fresh retry, all uncertainty cases remain blocked, native Windows recovery tests remain behaviorally unchanged.

## Task 5 — Repeat the real Linux failure/retry chain

**Files:** test/live/lifecycle-scenarios.mjs, test/live/lifecycle-acceptance.mjs, test/lifecycle-driver.test.mjs; durable verification record and matrix.
**Interface:** Existing `recovery --model SELECTOR --infer --cancel` and explicit retry/approval opt-ins; no implicit retry from a root-stop event.

- [x] Add account-free driver checks that require the new proof and preserve failure propagation, finite deadlines, process-observation support and the exact signal variant. Never treat unsupported observation or a missed race window as PASS.
- [x] On Free/Fusion use the verified selector and execute the observed SIGSTOP-supervisor-before-root-stop then SIGKILL scenario. Require a genuine late accepted report/matching root stop, both old trees proved gone, failed/null exit/no completion, integration blocked, and explicit retry preview now allowed.
- [x] Explicitly retry and verify a distinct attempt/session, fresh report/commit/root-stop/actual exit receipt and integration; old attempt stays failed. Do not claim SIGKILL-before-root-stop coverage from the suspended-supervisor variant.
- [x] Separately attempt abrupt supervisor loss before root stop with readiness/identity barriers. If the provider aborts the turn, verify safe failure and explicit recovery; do not fabricate a late report. Include detached survivor and uncertainty fixtures even if no live survivor can be induced safely.
- [x] Gate: no owned probe/worker descendants remain, unrelated sentinel survives, no global process killing/lock clearing/manual receipt creation. Linux/native Windows evidence remains separate; Windows live rerun needs its own host.

## Task 6 — Conditional capabilities and support-expansion gates

**Files:** docs/COPILOT_SUPPORT_VERIFICATION.md, docs/DOCUMENTED_LIMITS.md, docs/ACCEPTANCE_MATRIX.md; conditional tests in test/copilot-config.test.mjs and test/live/copilot-acceptance.mjs.

- [x] Keep paid non-auto model and explicit effort acceptance DEFERRED for this Free account. Build account-free fixtures for advertised/non-advertised model handling, but do not mark live premium/effort support passed or require subscription upgrade.
- [x] If a separate entitled account later becomes available, perform a separate scoped capability decision: verify advertised selector/effort, actual CLI startup invocation and independently observed setting before enabling effort. Historical attempts without effort retain their bytes/meaning; do not add effort fields now just because CLI help lists a flag.
- [x] Keep Store-linked Copilot support explicitly unsupported in current schema. Before enabling it, create a separate design/compatibility plan covering old Codex/Claude records, authority/approval hashing, import/context protection, retirement/replacement, review/repair, submission receipts and mixed-version readers. SDK upgrade alone never expands shared authority.
- [x] Keep the optional VS Code discovery bridge deferred. A future bridge needs exact profile/extension host, consent granted/denied, requested versus observed selector, existing-chat ownership and completion receipts. Existing CLI passes do not close editor gates.

## Task 7 — Final verification and truthful documentation

**Files:** package.json/pnpm-lock.yaml as reviewed; docs/maintenance-priorities.md, docs/MODEL_DISCOVERY_VERIFICATION.md, docs/COPILOT_SUPPORT_VERIFICATION.md, docs/ACCEPTANCE_MATRIX.md, a new dated durable acceptance record, this plan.

- [x] Record each task's commit/base, Node/OS/SDK/runtime/CLI/protocol versions, transport source, cwd/config scope, exact commands, elapsed/exit, session/report/receipt identities and sanitized owned-process observations. Preserve earlier1.x failures and1.0.112 successes as historical evidence.
- [x] Run `pnpm test` once on the final stable tree; diagnose named failures before broad repeats. Run `pnpm pack --dry-run`, check the optional SDK/runtime distribution and installed-package discovery from a disposable unpacked package, not just repository node_modules.
- [x] Exercise normal catalog and readiness-synchronized SIGINT/SIGTERM through CLI JSON paths, then the Free/Fusion worker and recovery drivers. Verify configuration/approval dry-run remains read-only. Native Windows/GUI prerequisites unavailable here remain explicitly BLOCKED.
- [x] Check documentation local links/anchors and `git diff --check`. Make catalog compatibility status current only after the selected v2 transport has passed; no placeholder protocol4 success based solely on the SDK version number.
- [x] Run final independent whole-branch code review over dependency changes, native runtime distribution, process ownership and persisted-state compatibility (whole-branch review plus P2 driver cleanup fix8dc7e82 scoped re-review PASS; no new findings). Final report separates completed P0/P1 fixes, externally blocked live checks, intentionally deferred premium/editor support and unsupported Store authority.

## Delivery order and exit criteria

Tasks1–2 ship together as the catalog compatibility fix. Task3 verifies the actual Free subscription and can ship independently of recovery. Task4 precedes5; neither depends on premium model access. Task6 records explicit follow-up gates, rather than expanding the implementation implicitly. Task7 closes verification only on a stable reviewed tree.

Completion means compatible discovery and Fusion worker behavior pass, proved-stopped Linux recovery unlocks only an explicit fresh retry, and old/uncertain work cannot integrate. A paid-only model, effort setting, optional editor bridge or Store assignment is not required for this Free-account milestone. Missing native platform/runtime artifacts and genuinely unavailable environments are BLOCKED with exact evidence; an unimplemented test/fixture remains OPEN.
