# Maintenance priorities

Reviewed on 2026-11-03 against source at `9b4865e`. This is a maintenance
assessment, not an approved implementation plan. Documentation corrections are
included in this review. The subsequent step-1 startup correction is implemented;
authenticated implementation/integration and review execution passed. Other runtime work remains open.

## Recommended next work

### 1. Copilot CLI production startup: corrected and smoke-tested

The historical authenticated run needed launch overrides. The adapter now uses
new prompt mode, per-invocation folder trust, hook-observed session identity, and
explicit saved-session resume. Legacy reserved attempts require a fresh retry.
After installing OpenSpec with user authorization, the 2026-11-04 production
smoke passed implementation/integration and independent review execution. The
reviewer reported a fixture line-ending defect and correctly moved it to `fixing`.
See the [live record](REAL_WINDOWS_HARNESS_ACCEPTANCE.md#copilot-production-launcher-follow-up--2026-11-04);
full recovery/cancellation acceptance remains priority 2.

Evidence: [real acceptance record](REAL_WINDOWS_HARNESS_ACCEPTANCE.md#diagnostic-setup-and-limitations),
[`copilot.ts`](../src/harnesses/copilot.ts),
[`copilot-supervisor.ts`](../src/harnesses/copilot-supervisor.ts), and
[`copilot-hooks.ts`](../src/harnesses/copilot-hooks.ts).

Determine compatible initial prompt/trust flags from the installed CLI, then
bind its actual root session through the existing nonce lease. Review capability
checks and exact-session resume alongside startup; changing one argument list
alone leaves reserved-session assumptions elsewhere in the lifecycle.

Acceptance: regression tests for the incompatible flag combination and observed
session identity; rejection of unrelated chats, stop-before-report, and nonzero
exit; authenticated implementation/integration and managed review using the
production launcher without overrides. Include cancellation and recovery.

### 2. Close real-harness acceptance gaps

The real Windows record establishes narrow implementation and review successes,
not the complete lifecycle. VS Code managed review remains pending. Repair,
cancellation, interrupted-supervisor recovery, mixed-harness role selection,
and real inference combined with terminal backends remain unverified there.

Run the existing acceptance checklists in disposable projects after the Copilot launch
fix. Record exact versions, permissions, requested/observed models, session
identities, reports, exits, and retained recovery resources. Keep simulated,
installed-tool, and authenticated results distinct.

Evidence: [real acceptance record](REAL_WINDOWS_HARNESS_ACCEPTANCE.md),
[Claude checklist](CLAUDE_CODE_SUPPORT_VERIFICATION.md),
[Copilot checklist](COPILOT_SUPPORT_VERIFICATION.md), and
[backend matrix](WINDOWS_PORTABILITY_VERIFICATION.md#installed-resource-backend-follow-up).

### 3. Verify startup readiness beyond bounded lock retries

The old limits document called the Codex registration race unresolved, but
[`system.ts`](../src/system.ts) now retries lock acquisition for up to three
seconds when another live local process owns it.
[`platform-files.test.mjs`](../test/platform-files.test.mjs) covers a 500 ms
contended critical section. That mitigation lowers the urgency of this work.

The prompt still reaches Codex before the spawn callback saves its PID.
[`feature-fixture.mjs`](../test/helpers/feature-fixture.mjs) waits for PID
registration and lock release, so its success does not independently verify
production ordering. This review did not reproduce a remaining live failure.

Evidence: [current startup limit](DOCUMENTED_LIMITS.md#4-codex-worker-startup-contention-has-bounded-retries),
[`worker.ts`](../src/worker.ts), [`feature.ts`](../src/feature.ts), and
[`runner.ts`](../src/runner.ts).

Add a deterministic fast-child test without fixture sleeps, covering task and
review/repair startup, registration failure, lock deadline expiry, and child
exit during registration. Use the result to decide whether a readiness handshake
is needed. Preserve locks, ownership, successful exits, and explicit retries;
verify on Windows and Linux.

### 4. Extend delegated execution only where needed

Two independent gaps prevent parity with local workers:

- Windows rejects delegated execution until protected pinned context is verified
  ([`component.ts`](../src/component.ts), [`feature-state.ts`](../src/feature-state.ts)).
- Shared record settings accept only Codex and Claude
  ([`coordination-state.ts`](../src/coordination-state.ts)); Copilot requires a
  deliberate contract/compatibility extension and lifecycle acceptance.

Prioritize Windows protection if same-host team work is the next goal, or shared
Copilot support if cross-machine Copilot delegation is needed first. Preserve
the existing fail-closed behavior until their contract tests pass.

### 5. Reduce shared-workflow recovery friction

Replacement assignments currently require an independent clone. A supported
binding retirement/replacement operation would avoid that cost, but must retain
old evidence and reject replacement while any owned job or integration is active
or uncertain ([`component.ts`](../src/component.ts)).

Nested Store roots also cannot be automatically archived
([`coordination.ts`](../src/coordination.ts)). Add support only with exact-root,
scoped-path, approval, interrupted-operation, and canonical-delivery tests.
Feature-wide approval renewal is a conservative authority rule; do not weaken
it merely to reduce repeated work.

## Documentation disposition

Keep the dated specs, plans, and verification records as design/evidence history.
Mark superseded plans and link to current verification rather than deleting
their rationale or treating unchecked historical boxes as the current backlog.

This review corrects skill counts and install targets, harness requirements,
outdated live-testing status, the resolved Windows Codex blocker, and the branch
reference to its merged correction. The limits guide now covers the CLI launch
gap and narrower delegated support. Historical test counts remain explicitly
historical. The old startup-risk description now reflects the implemented
three-second live-owner lock retry and its regression coverage.

The checked-in knowledge graph is indexed at `69fc453` on 2026-09-15. It locates
the original supervisor/lock architecture but predates the current harness and
Windows changes. Refresh it with the project's indexing tooling before relying
on it for current architecture; do not hand-edit the compressed artifact.

## Boundaries to retain

Operator-controlled fetch/push/PR publication, snapshot-bound approval, distinct
completion/archive delivery states, and uncertain-process cleanup guards are
intentional. They are not missing automation to remove by default. Presentation
provider setup and exact VS Code chat resume also remain explicit capabilities,
not grounds for weakening execution evidence.
