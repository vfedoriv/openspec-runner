# Remaining maintenance work

Reconciled on 2026-11-21. This is the current backlog; the
[verification coverage plan](superpowers/plans/2026-11-20-verification-coverage.md)
records implementation status per step. The [scenario matrix](ACCEPTANCE_MATRIX.md)
records exact host/harness/backend gates. Historical counts are not current results.

## Required environment and live gates

- BLOCKED: current Copilot catalog compatibility. Ambient CLI1.0.114 uses protocol4;
  pinned SDK1.0.34 supports protocol3 (expects CLI1.0.112). Start fails before
  listModels; this does not establish authentication failure. Restore compatible
  versions through a separately scoped tooling/dependency change and recheck
  prompt-free discovery. No upgrade was performed in this plan.
- BLOCKED: unsupported/unknown driver process observation. The observer supports
  Linux only; incomplete evidence cannot produce acceptance PASS.

- BLOCKED: native Windows final dashboard/imported-binding, byte/directory,
  effort-switch/bulk-confirmation and process-tree reruns. This host is Linux.
  Preserve earlier Windows passes at their original versions and scope.
- BLOCKED: non-auto Copilot picker/SDK/worker comparison; current SDK catalog
  exposes only auto. Runtime selected model and effective effort cannot be inferred
  from that selector. Runner effort rejection remains intentional.
- OPEN: independently observed Claude effective effort and historical SDK 0.3.325
  alias discrepancy cause. Fresh SDK/CLI agreement does not explain that old failure.
- BLOCKED by unavailable real terminal: interactive Codex token recall and real-terminal
  exact-session detach/reattach. Automated command comparison is narrower evidence.
- BLOCKED: end-to-end Copilot Linux late-stop retry. The observed SIGSTOP-before-root-stop then SIGKILL case retained failed/null exit and rejected integration/cleanup; the intentional stale-launcher ownership guard blocks retry preview. No guard bypass is authorized by this evidence.
- OPEN: unrun harness/worktree/terminal combinations. Selected Git/manual Linux
  passes establish no blanket backend support.

## Optional and excluded work

Optional VS Code discovery bridge remains DEFERRED. Presentation configuration,
brief/export and non-invocation coverage passes deterministically (15/15); actual
provider outline/deck rendering remains BLOCKED/unverified without an available,
authorized provider. No provider or bridge was installed for acceptance.
Shared Copilot records remain OUT OF SCOPE pending a separate compatibility plan.

## Completed corrections and evidence

Copilot executable-path discovery and Linux owned-probe cleanup are corrected;
Claude catalog protocol/hidden metadata/raw selector safety is covered. A later
independently audited Copilot raw/fatal protocol correction passes25/25 discovery
tests; final integrated verification includes it. Reviewed driver identity/observation
and late-fork deadline cleanup corrections pass28/28; final v3 suite passes645 total/621 pass/24 native Windows skips/0 fail/cancel. Child-isolated Claude auth
rejection, observed report-before-exit integration/cleanup blocking, actual Claude
planner rationale and genuine Copilot blocking-review/repair/fresh-review/archive
also passed (see the [durable record](verification/2026-11-21-acceptance.md)). Fresh
prompt-free Copilot normal/interrupt and actual-worker cwd parity checks passed.
See [model evidence](MODEL_DISCOVERY_VERIFICATION.md) and the matrix for versions,
receipts and narrower live lifecycle passes. Final build/suite, package dry-run and local Markdown target/anchor/diff
checks PASS; the initial baseline's isolated
read-only Git allowlist fixture failure was corrected with a regression.

Retain operator-controlled Git publication, snapshot-bound approval, feature-wide
approval renewal, report-plus-real-exit requirements and uncertain-process cleanup
protection. Exact VS Code chat resume is not promised. Historical Windows delegated
Codex/Claude Git/manual passes remain in the [delegation guide](windows-delegation-guide.md).

Related records: [worker startup](WORKER_STARTUP_VERIFICATION.md),
[shared recovery](SHARED_RECOVERY_VERIFICATION.md),
[Windows portability](WINDOWS_PORTABILITY_VERIFICATION.md),
[current limits](DOCUMENTED_LIMITS.md). Use current local indexing evidence before
relying on graph coverage; no fixed historical commit describes all current source.
