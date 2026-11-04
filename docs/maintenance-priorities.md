# Remaining maintenance work

Reviewed on 2026-11-04 after shared recovery implementation (`eb24877`).
Completed and superseded design/plan documents have been removed; Git history
retains them. Current behavior belongs in the guides, and measured results in
verification records.

## Delegated execution

Windows delegated execution remains unsupported. Its protection work was stopped
before implementation. Revisit the protection boundary before starting a new
design; keep the existing guards until native contract tests pass.

Shared coordination records still accept only Codex and Claude. Adding Copilot
requires an explicit compatibility contract and delegated lifecycle acceptance.
Local Copilot support does not establish shared assignment support.

## Remaining acceptance coverage

The full harness/backend product, interactive exact-session resume, and
credential-failure cases remain open. Use the [live acceptance matrix](LIVE_ACCEPTANCE_2026-11-04.md)
to distinguish simulated, installed-tool, and authenticated results.

## Current implementation evidence

- [Worker startup verification](WORKER_STARTUP_VERIFICATION.md)
- [Shared recovery verification](SHARED_RECOVERY_VERIFICATION.md)
- [Windows portability verification](WINDOWS_PORTABILITY_VERIFICATION.md)
- [Current limits](DOCUMENTED_LIMITS.md)

The checked-in knowledge graph is indexed at `69fc453` on 2026-09-15 and predates
current harness and Windows changes. Refresh it through the indexing tooling
before relying on it for current architecture; do not hand-edit its compressed
artifact.

## Boundaries to retain

Operator-controlled Git publication, snapshot-bound approval, feature-wide
approval renewal, distinct completion/archive delivery states, and uncertain-process
cleanup guards remain intentional. Presentation-provider setup and exact VS Code
chat resume remain explicit capabilities.
