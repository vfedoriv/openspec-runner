# Task 3 — Free Copilot selection and supervised acceptance

## Result

The picker now distinguishes the only currently advertised model from saved selectors, shows the provider label alongside its opaque selector, and marks Copilot effort unavailable even if discovery fails. Copilot effort choices are suppressed regardless of unexpected catalog effort metadata. Typed nonempty effort is rejected before confirmation. Existing adapters already preserve requested selectors and reject inherited effort; no migration or worker-runtime change was needed.

No subscription tier is inferred from catalog size. The Free environment is explicitly identified by the user. User-observed picker label `Copilot Fusion`, SDK provider label `Auto`, discovered/requested selector `auto`, and independently observed runtime model are separate facts. The user's suggestion that Fusion may mean auto remains a hypothesis; successful `auto` execution verifies compatibility with this environment, not a concrete routed model or an independently proven label mapping. Effective runtime model and effort remain **unobserved**.

## Regression checks

- RED: native `node --test --test-name-pattern 'Copilot keyboard' test/dashboard-layout.test.mjs` after correcting the keyboard fixture failed 3 of 4 new cases: unavailable discovery omitted the effort-unavailable status; narrow status visibility also failed. Before implementation, available 80-column behavior already passed. Retained output: `/tmp/task3-red.txt`.
- RED: `node --test --test-name-pattern 'explicit interruption signal' test/model-discovery-driver.test.mjs` failed with `Invalid argument --interrupt-signal`; the driver previously only supported SIGINT. An initial fixture attempted duplicate harness registration and was corrected to temporarily replace/restore the existing adapter's discovery method.
- An intermediate focused run exposed a narrow-width regression in the existing managed approval test: changing the effort choice prefix to `Choice` obscured `high` at 40 columns. Restored existing effort hint formatting for other harnesses; sole advertised model hints remain explicit.
- GREEN: `pnpm run build` passed. Final focused native command and totals recorded below after completion.
- Coverage includes: opaque single Fusion fixture; same selector with changed provider label; stale saved premium selector distinguished as saved; unavailable catalog without synthetic options; unexpected effort/tier metadata ignored; preserved requested selectors with no fallback; inherited low/high effort rejected; 40/80-column keyboard selection, rejection, blank effort and exact confirmation after switching from a saved Claude role.

## Disposable Free auto worker

Command: `node test/live/copilot-acceptance.mjs worker --model auto --infer --timeout-ms 300000`.

Initial sandbox execution failed before inference with `spawnSync copilot EPERM` (`/tmp/runner-copilot-worker-WQPGj0/failure.json`); this is a distinct environment failure, not acceptance evidence. Native approved execution passed. No global configuration, credentials, trust, premium models or subscription changes were made.

Native evidence: `/tmp/runner-copilot-worker-ZRdWrC/result.json`, `receipt.json`, and `repo/.git/openspec-runner/verify-runner.json`.

- CLI: `1.0.114`; requested model selector: `auto`; requested effort: absent.
- Attempt: `fbc7ee04-b3c4-45dd-9e6f-6466c14a72d2`.
- Exact observed/bound root session: `d9c66af5-bbe6-4a74-bcaf-125eabeb80b9`; identity confirmed.
- Accepted completed report commit: `5eb32e807e6075050bf68cb54f8b3b856a2b5084`; accepted at `2026-11-21T13:59:25.114Z`.
- Hook lease retained exact generation/nonce, accepted report and root stop at `2026-11-21T13:59:26.446Z` (secrets intentionally omitted here).
- Launcher real exit `0`, worker real exit `0` at `2026-11-21T13:59:27.272Z`; completion receipt source `process-exit`, same exact session.
- Integration head: `2cb9e24c7ec0072e9aa9a7233c8cea81c7504c8e`; greeting `HELLO` verified. Report-before-exit integration and cleanup were blocked as required.
- Acceptance child exit `0`, no timeout, process observation supported, no remaining owned descendants. Effective routed model/effort unobserved.

## Planning root versus actual worker catalog

Command: `node test/live/model-discovery.mjs --agent copilot --cwd /home/vitaliy/workspace/openspec-runner --worker-cwd /tmp/runner-copilot-worker-ZRdWrC/repo/.openspec-runner/worktrees/fbc7ee04-b3c4-45dd-9e6f-6466c14a72d2`.

Final label-preserving evidence: `/tmp/model-discovery-LiLT23/result.json` (earlier equivalent selector-only evidence: `/tmp/model-discovery-MrxXL8/result.json`). Both root and actual retained managed-worker cwd returned available catalogs, exit `0`, no timeout, confirmed process observation and no remaining owned descendants. Both advertised exactly `{selector:"auto", label:"Auto", source:"discovered", effortSupport:"unsupported"}`. Discovery started no inference; requested and observed model/effort are null. This compares explicit installed-runtime discovery in each cwd; it does not claim a bundled runtime has the same account catalog.

## Additional requested driver support

The coordinator requested readiness-synchronized SIGTERM support for later stable-tree checks. Added validated `--interrupt-signal SIGINT|SIGTERM`, requiring `--interrupt`, with existing SIGINT default preserved. SIGTERM acceptance requires exact exit `143`; SIGINT requires `130`. Account-free tests check argument rejection, readiness and actual SIGTERM delivery/descendant cleanup. Final real CLI SIGTERM checks are delegated to the coordinator as requested and were not run here.

## Scope and limits

No full suite was run by this implementation agent per explicit coordinator instruction; the coordinator owns stable-tree full verification. Existing dirty maintenance documentation, graph artifacts and plan were left untouched. No production third-party SDK API was changed, so no new external API documentation was needed. No work remains open in the reachable focused Task3 regression checks once the final totals below pass. Fusion-to-selector mapping remains explicitly unproven beyond user-observed label plus successful discovered auto selector; no fabricated selector or routed-model assertion is introduced.

Final focused native command: `node --test test/dashboard-catalog.test.mjs test/dashboard-layout.test.mjs test/copilot-config.test.mjs test/model-discovery-driver.test.mjs` — **47 passed, 0 failed**, 29.9 seconds; output `/tmp/task3-verified-tests.txt`. Build passed after the final source edit. `git diff --check` passed.

CLI dry-run: from unfinished disposable `/tmp/runner-copilot-worker-WQPGj0/repo`, `node /home/vitaliy/workspace/openspec-runner/bin/openspec-runner.js launch verify-runner --tasks 1.1 --agent copilot --default-model auto --default-effort high --dry-run --json` exited `1` with `{"error":"Copilot effort is unsupported by this adapter"}`. No inference or mutation was requested. The same command in the already integrated acceptance repository first rejected the already-satisfied task, so the unfinished fixture was used to reach settings validation.
