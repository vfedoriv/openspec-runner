# Copilot Store skill-access fix — 2026-11-22

The earlier live verification recorded a real access gap but stopped at documenting it. The user requested that it be fixed and verified.

## Cause and change

Store prompts supply absolute bundled skill paths. Copilot CLI invocation previously granted the worktree, code Git metadata and Store runtime, but not those bundled skill directories. Native read tools also lacked explicit approvals for some sealed context files.

Store launch and resume now add only the three bundled worker-skill directories (implement/review/repair), explicitly allow reads of each SKILL.md, and deny built-in writes beneath those directories. No runner-repository root, Store Git directory, broad all-path grant or all-tool permission was added. The write denials are CLI policy, not a claim of OS immutability for package files; existing sealed context protection remains in place.

Store CLI workers check support for --deny-tool before dispatch; local Copilot startup compatibility is unchanged. Older unsupported hosts fail before hook provisioning or process launch.

## Verification

- Regression assertions first failed for missing skill directories. Separate experimental snapshot read permits failed native checks and were removed rather than shipped as a fix.
- Fresh build and `pnpm test test/copilot-store.test.mjs test/copilot-config.test.mjs test/copilot-worker.test.mjs test/copilot-hooks.test.mjs`: 15 passed, zero failed/skipped. Includes launch/resume flag pairing and fail-closed old-host readiness.
- `pnpm pack --dry-run`: passed; bundled skills are present in package contents.
- Independent source review: no blocking issue; readiness follow-up was implemented and tested.
- Real CLI fixture H5A6d1: native implement skill read40 lines, review skill read28 lines, implementation/integration succeeded, and accepted review completed with findings[] and supervised exit0. The corrected HELLO shared/component requirements are coherent. See [live CLI evidence](2026-11-22-copilot-store-live-cli.md).
- Public Store implementation/review/repair simulated lifecycle regression passed for both Copilot surfaces (181526ms wrapper, zero failures).
- Separate native controls isolated a deep-path boundary: protected originals and equal-length unprotected copies at 257/263 characters were denied, even with exact-file approvals; identical ordinary copies shortened to 241/247 characters were both read successfully. This narrows the observed native path-length/layout issue and does not establish a universal MAX_PATH threshold. The live fixture now uses prefix `live-` instead of `runner-store-planning-`, shortening its generated paths by 16 characters. Existing fixture callers keep their original default prefix. No protection or production Store layout was weakened.

A public review-only launch on the already reviewed integration was correctly rejected as an existing successful job. No saved state, job identity or approval was rewritten to force a second review.

The earlier full Windows suite's intermittent local VS Code fixture interruption remains an unrelated unresolved result (496 pass, 1 fail, 208 skipped). Focused passes and this live fix do not turn that historical full run green. Native VS Code Administrator-host completion remains outside this CLI fix.
