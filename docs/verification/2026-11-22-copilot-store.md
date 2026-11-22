# Copilot Store implementation — 2026-11-22

Subsequent real Windows/OpenSpec checks and test-fixture corrections are recorded in [Windows live verification](2026-11-22-windows-live-store.md). The original results below remain historical; consult the later record for native passes, blockers and final revised-suite results.

Implementation is on the existing dev checkout with user authorization. SDK installation was restored to the already locked @microsoft/copilot-sdk 2.0.1. Existing untracked IDE configuration was preserved.

## Changes

Copilot surfaces are accepted in coordination contracts. Store invocation scope reaches the hook supervisor before transport dispatch. Runtime/report paths use the imported component scope; local paths remain compatible. Store hook callbacks resolve explicit assignment selection through existing binding authority. Disposable hooks are generated only in linked worktrees and excluded from commits; tracked, conflicting or redirected hook paths are rejected. Editor agent preparation validates Store runtime and rejects tracked/redirected agent files. CLI launch/resume grant assignment runtime access. Begin, inspection and Linux recovery lookups use the same state directory as reports and supervision.

## Verification boundaries

TypeScript build and focused Copilot runtime, hook, configuration, worker and recovery checks have passed on Windows. Linux-specific cancellation tests are skipped on this host. Public Store lifecycle fixtures exercise both surfaces with fake executables; these simulate editor discovery and invoke real runner hook/begin/report commands. They do not prove native host discovery or inference.

Initial host versions read without inference: OpenSpec 1.15.0, Copilot CLI 1.0.112, VS Code 1.144.1 x64. At the user's subsequent request, `pnpm add --global @fission-ai/openspec@2.1.1` completed and `openspec --version` confirmed 2.1.1. Store/status help confirmed the registered-ID selector. A real `status --change demo --json` smoke check in a disposable temporary project returned root, planningHome, changeRoot and artifactPaths with resolved paths and existing output files. Project files and Store registrations were not updated. Full registered-Store 2.1.1 compatibility, native VS Code Store discovery/context reads, and Linux Store cancellation remain unverified. No live model turn, publication or merge was performed.

An independent source review found a tracked-hook acceptance issue; the tracked-path rejection now runs before accepting identical generated content. Follow-up review found no further concrete correctness or security bug. It identified the remaining native host and negative recovery verification boundaries.

The implementation plan remains the acceptance checklist; unchecked live/platform items must not be represented as passed.

## Final focused results

- TypeScript compilation: pass.
- Runtime/hooks/configuration/recovery/termination checks: 31 tests, 18 pass, 13 Linux-only skips, zero failures. Subsequent Store editor generation/tracked-file assertions also pass (3/3 Store unit cases).
- `test/copilot-store-lifecycle.test.mjs`: standard Windows child passes both inner Copilot surfaces, including scoped `launch --dry-run --json`, stale-assignment hook rejection, implementation, blocking review, repair integration and clean final review. Final wrapper duration 215076ms, zero failures.
- `pnpm pack --dry-run`: pass.
- Independent review: no remaining concrete correctness/security finding; native host and Linux recovery limits above remain.
- Full `pnpm test`: run separately; has failures in discovery and platform process-control tests. An isolated `Copilot discovery safely classifies SDK protocol version mismatch` rerun also fails (expected compatibility diagnostic, received generic catalog unavailable); the SDK discovery implementation was not changed by this work. Do not treat focused results as a green full suite.

Full `pnpm test` completed: 704 tests, 481 passed, 17 failed, 206 skipped, zero cancelled; duration 883314ms. The new public Store lifecycle test was added after this run enumerated files and was run separately as described above.

Failure groups: Claude timeout fallback (1); Copilot selector/termination/classification discovery (10); local hooks-disabled early launch acceptance (1); bounded process/signal/identity drivers (4); local VS Code lifecycle (1). The last failed after `git commit -m worker result` exited with Windows status 3221225786 and the supervisor reached its hook deadline. None of these failure names directly tests changed Store authority/runtime behavior, but that does not establish that all are preexisting. The suite is red and broader host compatibility remains unresolved. Full details are retained in `copilot-store-full-tests.log` in the working checkout.

Isolated local VS Code lifecycle rerun: `node --test --test-name-pattern "copilot-vscode supervises" test/windows-harnesses.test.mjs` passed 1/1 in 17906ms, without code changes. This confirms the reported local failure did not reproduce in isolation; it does not turn the full suite green.
