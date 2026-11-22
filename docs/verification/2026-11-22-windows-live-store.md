# Windows live Store verification — 2026-11-22

Follow-up: the skill-access and fixture mismatch blockers below were subsequently fixed, with clean live implementation/integration/review evidence. See [skill-access fix](2026-11-22-copilot-store-skill-access-fix.md). Historical failures and remaining native editor/long-path boundaries below are retained rather than rewritten as passes.

The user authorized live verification and all feasible tests on the current Windows environment. This record distinguishes real installed tools from simulated worker fixtures. No production permissions were broadened to force a pass. Existing IDE files and unrelated worktrees were preserved.

## Real OpenSpec 2.1.1

`node test/live/openspec-store-smoke.mjs` passed eight checks using actual OpenSpec 2.1.1 and isolated process-local XDG config/data directories:

- Project-scoped Copilot skill installation.
- Explicit registered Store selection through runner structured context resolution.
- Missing planning-root rejection without creating code-local planning.
- Project Store pointer selection.
- Stale Store ID rejection without local fallback.
- Strict change validation.
- Real archive, canonical spec generation and strict archived validation.
- Archive collision rejection preserving canonical specs and the active change.

Final disposable evidence: `C:/Users/vital/AppData/Local/Temp/openspec-store-211-uqx7Ny/result.json`. Archive-collision verification uses a strict-valid MODIFIED delta that would change the canonical greeting, with normal spec synchronization enabled; the specific existing-archive diagnostic is required, the collision rejects before changing the canonical bytes, and the active change remains. The user's existing Store registry was not changed. Skill installation was verified, but network isolation was not enforced, so this is not an offline-network proof.

## Real SDK discovery

The installed runner adapter returned `unavailable`: `Copilot SDK/runtime compatibility check failed.` No model session was created for this check. Initial reported CLI version was 1.0.112; the VS Code shim may select/extract a different bundled runtime, so shim version and actual worker runtime must not be conflated. The generic prompt-free discovery driver's process observer is Linux-only and reports BLOCKED on Windows; that does not prove failed Windows process containment or successful catalog discovery.

A subsequent real `test/live/copilot-protocol-smoke.mjs` run passed SDK start/getStatus/stop with zero shutdown errors and no inference. The shim's actual runtime reported version 1.0.114 and protocolVersion 4. Repeating the real runner adapter's model discovery then returned available with exactly the `auto` / `Auto` entry (non-exhaustive). This closes the current adapter compatibility/catalog blocker, but does not rewrite the earlier failure or prove the generic Linux-only observer works on Windows. No explicit CLI upgrade or silent runner fallback was introduced; the installed shim selected its runtime normally. Logs: `.live-verification/logs/copilot-protocol-2026-11-22.log` and `copilot-catalog-final-2026-11-22.log`.

## Real native editor

See [native editor evidence](2026-11-22-native-store-editor.md). The native UI offered Auto and the real Store hook bound a session. The test encountered workspace trust and tool-confirmation barriers. The supervisor ultimately expired while confirmations were pending. Its pending begin command is stale and must not be approved as a continuation. Chat/worktree were retained because editor activity remained uncertain. Native completion, report acceptance, integration and cleanup did not pass. Custom attempt-agent discovery was not established: the visible mode selector remained Agent.

## Real CLI and automated suite

An early actual CLI attempt reached root hook ownership but failed without an accepted report under permission denials. A fresh attempt using documented shell/write permissions still saw a bundled runner skill read denial, but public begin/report completed and supervised exit was zero. Expected `HELLO` LF output was verified and integrated into a distinct integration commit. This establishes a real CLI Store task implementation/integration pass with fixture planning scaffolding, not a complete real-OpenSpec/real-Copilot integrated flow.

The subsequent actual review exited zero but submitted an accepted BLOCKED report. Required review skill access was denied and the generic fixture shared task description did not match its HELLO task. Review is not a pass; no repair was performed. A successful process exit cannot override the report outcome. No further paid turn was requested to repeat an already reproduced permission blocker.

After the user handled editor confirmations, late begin/report commands were rejected for the expired attempt. Native protected Store snapshot reads did succeed. VS Code's Administrator terminal failed the runner's required standard-user protection check, and the model's proposed report identity differed from the hook-bound session. These are separate native blockers; no identity or protection bypass was attempted.

The user independently supplied the editor's final output: task1.1 blocked, begin rejected, backup/restore privilege protection unverified, blocked report input written but report rejected for absent begin-registered session, and no result.txt or commit. This corroborates the recorded failed lifecycle; the blocked input is not an accepted runner report. Its proposed session mismatch is an invalid input observed without successful begin registration, not independent proof that a correctly registered native editor session would report the wrong identity.

Windows fixture defects were reproduced independently before test-only corrections. See [automated Windows diagnosis](2026-11-22-windows-tests.md). No production signal, session identity, authority or cleanup requirement was weakened. The earlier red suite cannot be relabeled green based on focused passing checks.

Raw logs are retained under `.live-verification/logs/`, outside the package's documentation whitelist. Final `pnpm pack --dry-run` passed and a package-list check found neither documentation logs nor the live evidence tree included. Production source was not changed in this verification task.

The initial full run completed with 705 tests: 485 pass, 12 fail, 208 skip, 0 cancelled (1034681ms). It loaded the old discovery fixtures before their corrections and later loaded the corrected driver fixtures, so it is not a final revised-tree result. Eleven discovery failures were independently reproduced and corrected in test fixtures. The remaining Store lifecycle wrapper failed at 270 seconds; captured output proved its first inner CLI case passed in 157648ms without a semantic failure before the wrapper expired. Its outer timeout is now 550 seconds with a 600-second test-runner budget, analogous to the existing multi-repository integration budget; worker deadlines were not extended. The final revised full suite is recorded separately.

## Remaining verification gaps

The final revised full `pnpm test` completed with 705 tests: **496 passed, 1 failed, 208 skipped, 0 cancelled**, duration 913262ms. The sole failure is the local `copilot-vscode supervises implementation, review, repair and integration` case: its fake worker's `git commit -m worker result` exited with Windows status3221225786 (0xC000013A), followed by the Copilot hook deadline. Both Store lifecycle surfaces passed in this full run. This full result is red, even if the local editor case passes in isolation; root-cause investigation is separate. Raw final details are in `.live-verification/logs/windows-full-tests-final-2026-11-22.log`.

The final isolated local VS Code rerun passed 1/1 in 18330ms without further source changes. The full-run interruption's underlying cause remains unresolved; a detached Windows console-lifetime interaction is only a hypothesis. No speculative production change, broader permission, weakened identity gate or additional full-suite retry was used to manufacture a green result. Evidence is retained in the ignored `.live-verification/` directory; production source remains unchanged by this verification task.

- Required bundled runner skills need a narrow native access solution; live CLI denied those paths despite a completed implementation turn. Clean review/repair must be repeated after that and the scaffold semantic correction.
- Native editor completion requires a fresh attempt in a non-administrator editor, timely user confirmations, hook-consistent begin registration and report identity, and verified custom-agent selection. The expired native attempt cannot establish those claims.
- The generic discovery driver's Linux-only process observer still cannot provide Windows process-observation proof. The real SDK initialization and runner adapter catalog now pass with the actual shim runtime 1.0.114/protocol 4 and Auto; no guessed catalog or silent runtime fallback was used.
- Linux cancellation/procfs cases and other platform-only checks cannot be verified by Windows execution. Simulated Windows lifecycle success does not supply that evidence.
