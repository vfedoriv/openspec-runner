# Windows automated verification, 2026-11-22

Production source was unchanged. Six existing test/fixture files received authorized portability or integration-budget corrections described below. Temporary probe copies were removed after execution. No global Git configuration was changed; untracked IDE configuration was preserved.

## Full suite

`pnpm test` in the restricted sandbox exited 1 before build: the pnpm manager tried to fetch pnpm@11.7.0 metadata and network access failed. See windows-full-tests-2026-11-22.log. The authorized unrestricted-host rerun is captured separately in windows-full-tests-elevated-2026-11-22.log. Do not treat the sandbox bootstrap failure as a test result.

## Discovery and lifecycle driver reproduction

`node --test test/copilot-model-discovery.test.mjs test/model-discovery-driver.test.mjs test/lifecycle-driver.test.mjs` reproduced 15 failures: 69 tests, 34 passed, 15 failed, 20 skipped, zero cancelled; 11310.9694ms. See windows-discovery-driver-isolated-2026-11-22.log.

Ten Copilot failures share a fixture portability defect. The fixture writes an extensionless Node shebang script. On Windows, platform-command resolves it to node plus script arguments. copilotExecutable deliberately rejects commands with arguments because the SDK requires a directly executable CLI; therefore the SDK/probe/mock termination boundary is never reached. A temporary copy using copilot.exe containing the native Node executable, with the existing fake SDK, passed all 17 applicable tests (34 total, 17 platform skips, zero failures; 18067.667ms). See windows-copilot-native-fixture-probe-2026-11-22.log. No model session was created. Proposed fix: use a native executable fixture on Windows rather than changing the production direct-executable contract.

The driver process enumerator explicitly returns undefined outside Linux. Consequently boundedChild cannot establish descendant readiness or affirmative process observation on Windows, and runLifecycle intentionally returns BLOCKED even when the hooks-disabled receipt succeeds. The hooks-disabled test unconditionally expects PASS. Two other unguarded tests require actual POSIX SIGINT/SIGTERM readiness/delivery; a third assumes Node close reports SIGKILL rather than Windows numeric termination. These are unsupported-driver assumptions, not successful Windows cancellation checks. Proposed fix: implement real Windows driver observation/termination support or explicitly test BLOCKED on unsupported platforms while keeping Linux success assertions. Merely changing expectations to claim PASS would be incorrect.

The stale identity fixture calls BigInt(current.createdAt). Windows observeProcess returns an ISO creation timestamp, while Linux returns a numeric proc token. The test fails before exercising stale identity behavior. ownedProcessRows itself expects Linux numeric tokens. Proposed fix: give this Linux-specific synthetic ancestry fixture numeric tokens independent of the host identity; keep the real sentinel identity for actual signal ownership assertions.

## Claude timeout reproduction

The original isolated timeout test fails ENOENT reading request.json (3305.6291ms). Its 250ms AbortSignal deadline can expire before the Windows child initialization writes the request marker; dashboardChild synchronously observes the new process via the Windows process adapter. A temporary test copy changing only 250ms to 1500ms passed 1/1 (4649.6543ms). See windows-claude-timeout-isolated-2026-11-22.log and windows-claude-timeout-1500ms-probe-2026-11-22.log. Proposed fix: arm fixture cancellation after an explicit initialization marker, with a bounded readiness wait, rather than relying on a subsecond startup budget.

## Authorized fixture corrections and targeted green run

After reporting the root causes, authorization was received for narrowly scoped test-only corrections. Edited files: test/copilot-model-discovery.test.mjs, test/claude-model-discovery.test.mjs, test/lifecycle-driver.test.mjs, test/model-discovery-driver.test.mjs. Production code is unchanged by this verification task.

The native executable fixture is now used on Windows. Claude cancellation is armed by the explicit request marker with a bounded 5s readiness wait. The Windows hooks-disabled path asserts BLOCKED plus a successful receipt with no worker. Windows timeout assertions check nonzero numeric termination and unavailable observation. Synthetic ancestry uses numeric tokens while actual stale-sentinel signaling keeps host identities. Two tests of actual POSIX signal delivery explicitly require Linux process observation; unsupported Windows behavior is not presented as a cancellation pass.

Targeted verification after edits: `node --test test/copilot-model-discovery.test.mjs test/model-discovery-driver.test.mjs test/lifecycle-driver.test.mjs test/claude-model-discovery.test.mjs` completed exit 0: 89 tests, 67 passed, zero failed/cancelled, 22 skipped, 25286.6222ms. See windows-fixtures-green-2026-11-22.log.

The first unrestricted full-suite process began before these edits. Earlier Claude/Copilot files were loaded before corrections and later drivers may load corrected files; therefore its result cannot establish a fully revised-tree green run. A final full-suite rerun is required.

## Full-run diagnosis and final run

The first unrestricted full suite finished exit 1: 705 tests, 485 passed, 12 failed, 208 skipped, zero cancelled, 1034681.5777ms. Its failures were the eleven discovery fixtures loaded before correction and the Copilot Store lifecycle wrapper timeout. The local Windows lifecycle did not reproduce the earlier commit interruption. The four-repository Store lifecycle passed in 534371.7706ms.

The Copilot Store wrapper timed out at 270023.4047ms with ETIMEDOUT, while captured stdout proved the first inner Copilot implementation/review/repair case passed in 157648.5463ms; no inner semantic failure was reported. Following explicit authorization, only test harness budgets were changed: the wrapper now allows 550000ms and run-tests.mjs gives its file the same 600000ms integration budget as Store multi-repo. Worker per-attempt deadlines are unchanged.

All raw logs were moved out of packaged docs to `.live-verification/logs/` using the same basenames. The revised-tree final `pnpm test` writes `.live-verification/logs/windows-full-tests-final-2026-11-22.log`; multi-repo progress traces write its `windows-full-tests-final-trace-2026-11-22.log` sibling. Live model turns had ended before this final run started.


## Final results and unresolved Windows interruption

The final revised-tree `pnpm test` completed exit 1: **705 tests, 496 passed, 1 failed, 208 skipped, zero cancelled, 913262.3557ms**. The corrected discovery/driver cases passed. Copilot Store lifecycle passed in 215845.0852ms. Both full Store surfaces, standard Windows protected context, and Store multi-repo integration completed; skipped tests remain unsupported/platform-gated checks and are not evidence of Windows signal/cancellation success.

The sole remaining failure is `copilot-vscode supervises implementation, review, repair and integration` in test/windows-harnesses.test.mjs. The fake editor repair worker's `git commit -m worker result` exited with Windows status **3221225786 (0xC000013A, control-C termination)**; the worker never reported/Stopped and the supervisor correctly rejected after its hook deadline (72424.0677ms). This reproduces the original full-suite interruption signature. The preceding unrestricted baseline local editor case passed, so it is intermittent.

A narrow isolated rerun, `node --test --test-name-pattern 'copilot-vscode supervises' test/windows-harnesses.test.mjs`, then passed **1/1**, zero skipped/failed/cancelled, 18330.3275ms. See `.live-verification/logs/windows-local-editor-isolated-2026-11-22.log`. This does not make the full suite green.

Concrete cause observed: the native Git child is interrupted during the detached fake editor worker, leading to absent report/Stop evidence and the expected fail-closed supervisor deadline. Root cause of the native control-C event is **unresolved**. Test inspection found the editor helper uses `detached:true, windowsHide:true`, while its Git subprocess uses default console options. Concurrent process-lifecycle fixtures also terminate their own children. Windows console lifetime/control-event interaction is a hypothesis, not proven cross-process signaling or a production bug. No live model turn was active during the final full run, so live inference contention is not required to reproduce it. No Git command was retried, no supervision deadline was extended to hide this failure, and no speculative production fix was made.

No further broad rerun was launched after this isolated diagnostic. Edited test paths are test/claude-model-discovery.test.mjs, test/copilot-model-discovery.test.mjs, test/lifecycle-driver.test.mjs, test/model-discovery-driver.test.mjs, test/copilot-store-lifecycle.test.mjs, and test/helpers/run-tests.mjs.
