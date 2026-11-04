# Shared workflow recovery verification

Date: 2026-11-04. Source: `a826c6b` plus the shared recovery changes.

## Assignment retirement

`component retire` previews and confirms retirement of one exact local binding.
It requires the old change, assignment ID, owner, reason and local snapshot token.
It neither revokes coordination authority nor authorizes replacement scope.

Before removing active state, it exclusively publishes the original binding,
feature and runner bytes in a local retirement journal. A retiring/retired binding
blocks execution. Confirmed retries remove only matching active state; divergent
bytes, identity or journal content stop recovery. Context, reports, logs, exports,
branches and worktrees remain available. Import requires a different approved
assignment and its exact base/plan, and creates fresh execution resources.

Linux regression tests exercise same-clone replacement, retained journal bytes
and resources, pure CLI preview/confirmation, stale tokens, partial state removal,
active/uncertain workers, pending integration and incomplete imports. Tests also
cover retired-ID rejection, late old begin/worker commands, retirement during
asynchronous inspection, import between mutation locks, and late reports during
interrupted retirement. The three import/report review findings were reproduced
with failing tests before their mutation gates were added.

This does not enable native Windows delegated execution; its protected-context
work remains deferred. Existing bindings remain readable. Local retirement adds
new binding phases and a retained journal; earlier runner versions reject these
phases rather than safely operate the retired state.

## Nested Store archives

The approved tasks inventory selects one exact repository-relative OpenSpec root.
Root-level archive targets preserve their existing representation. Nested targets
include `openspecRoot` in their local token-bound preview. Portable coordination
events keep the existing schema: replay derives scope from the completion's
approved review/contract, rather than trusting an event-supplied root.

Native Windows and Linux tests exercise nested preparation/canonical delivery,
explicit interrupted-output adoption without rerunning OpenSpec, and rejection of
out-of-scope output. Replay rejects a nested receipt rewritten to a sibling/root
namespace. Portable helper tests cover ambiguous inventories, missing/mismatched
changes, traversal, redirected namespace syntax, alternate streams and non-ASCII
paths. Existing Linux archive tests retain root-level scope, consent, planning-byte,
produced-tree and canonical-content checks.

Earlier readers that assume repository-root archives reject nested path scope.
Use the updated runner for a shared history containing nested archive events.
Approval renewal and explicit Git publication/delivery rules are unchanged.

## Verification results

- Windows `pnpm test`: 411 tests; 289 passed, 122 skipped, zero failures.
- Ubuntu 22.04 / Node 22.14.0: 414 tests; 394 passed, 20 skipped, zero failures.
- Build and package dry run passed.
- Independent source review found three retirement races; failing regression
  tests reproduced them, and the complete suites passed after the fixes.
- Bundled component/coordinator skill scenarios were checked before and after
  correcting their obsolete fresh-clone and root-only archive instructions.
- Installed OpenSpec 1.15.0 archived a real disposable Windows Store change at
  `planning/team space/openspec/changes/shared`, synchronized its canonical spec,
  and passed exact delivery recording (`archive: archived`). Prepared commit:
  `464018e743533fe698e3ccadd264af9a7d4e3b9c`. Coordination setup used fixture
  receipts and consent; this smoke involved no model inference or publication.

Native Windows retains the existing unsupported delegated-flow skips. The new
nested archive tests run on Windows independently of delegated worker support.
These simulated worker scenarios do not claim new authenticated model acceptance.

See the [implementation plan](superpowers/plans/2026-11-04-shared-recovery.md),
[current limits](DOCUMENTED_LIMITS.md), and
[operator recovery commands](team-workflow-reference.md#changes-failures-and-recovery).
