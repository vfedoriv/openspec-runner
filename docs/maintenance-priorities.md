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

### 2. Expanded live acceptance: core gaps covered, full matrix remains open

The [expanded 2026-11-04 acceptance record](LIVE_ACCEPTANCE_2026-11-04.md) covers
Copilot repair/fresh review, real cancellations, CLI supervisor recovery, Claude
parallel/dependent tasks with a Codex reviewer, VS Code managed review, and
real inference with Orca and Herdr/Worktrunk resources.

The crash test exposed and drove a fix for stale Windows Copilot launcher
acknowledgement. Recovery still requires a matching root stop and provably absent
process trees; it cannot turn a lost supervisor into successful execution.

The full harness/backend product, interactive exact-session resume, and
credential-failure cases remain open. Use the evidence matrix rather than
assuming all combinations passed. Keep simulated, installed-tool and
authenticated results distinct.

### 3. Startup readiness: corrected and verified

Deterministic fast-child tests reproduced prompt consumption before Codex PID
registration, including when registration failed or its lock deadline expired.
The three-second lock retry mitigated contention but did not prevent dispatch.

Initial Codex workers now use stdin, and the shared supervisor delivers the
prompt only after synchronous registration returns. Registration failure destroys
stdin before stopping the worker. Feature fixtures consume the same prompt
transport instead of polling PID/lock files. Claude shares the failure gate;
permissions, reports, exits, and interactive resume remain intact.

See the [startup verification record](WORKER_STARTUP_VERIFICATION.md) and
[current startup boundary](DOCUMENTED_LIMITS.md#4-initial-worker-prompts-wait-for-registration).
No additional wrapper-process handshake or lock-policy change was needed.

### 4. Extend delegated execution only where needed — deferred

Two independent gaps prevent parity with local workers:

- Windows rejects delegated execution until protected pinned context is verified
  ([`component.ts`](../src/component.ts), [`feature-state.ts`](../src/feature-state.ts)).
- Shared record settings accept only Codex and Claude
  ([`coordination-state.ts`](../src/coordination-state.ts)); Copilot requires a
  deliberate contract/compatibility extension and lifecycle acceptance.

Prioritize Windows protection if same-host team work is the next goal, or shared
Copilot support if cross-machine Copilot delegation is needed first. Preserve
the existing fail-closed behavior until their contract tests pass.
The user stopped the Windows protection work before implementation; its draft
design is deferred. No Windows delegation guard or shared harness contract changed.

### 5. Reduce shared-workflow recovery friction — implemented

`component retire` now supports explicit same-clone replacement after certain
worker exit and idle integration. It snapshots binding/feature/runner bytes,
retains all resources and exports, and leaves a tombstone. Confirmed retries
resume partial retirement without deleting changed state. Import and report
mutation gates prevent late commands from reviving retired execution.

Nested Store archives derive their exact OpenSpec root from the approved shared
tasks inventory. Preparation, explicit recovery, replay and canonical delivery
retain that namespace and reject sibling-tree changes or ambiguous roots.
Feature-wide approval renewal is a conservative authority rule; do not weaken
it merely to reduce repeated work.
See [shared recovery verification](SHARED_RECOVERY_VERIFICATION.md).

## Documentation disposition

Keep the dated specs, plans, and verification records as design/evidence history.
Mark superseded plans and link to current verification rather than deleting
their rationale or treating unchecked historical boxes as the current backlog.

This review corrects skill counts and install targets, harness requirements,
outdated live-testing status, the resolved Windows Codex blocker, and the branch
reference to its merged correction. The limits guide now covers the CLI launch
gap and narrower delegated support. Historical test counts remain explicitly
historical. The startup description now reflects registration-gated stdin
prompts, deterministic fast-child coverage, and the retained live-owner lock retry.

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
