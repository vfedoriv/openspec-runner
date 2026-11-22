# Lifecycle acceptance matrix

Rows are keyed by OS, harness/version, worktree backend, terminal backend and scenario. PASS applies only to the stated case and retained evidence. FAIL records a failed acceptance assertion, including exploratory driver defects; BLOCKED records a missing prerequisite or an open gate. A generic worker pass does not imply every optional attachment, cleanup, cancellation, review or archive subgate passed. Full-matrix completion remains open.

Fresh runs use Linux, Git/manual resources, disposable repositories and unchanged account configuration. Requested model/effort and independent runtime observations are distinct; effective effort is unobservable in these runs. `[auto]` catalog access does not establish non-auto entitlement. Exact begin/session/report/commit/exit receipts are in the report and retained repositories.

The new acceptance-driver process observer supports Linux only. Unsupported,
unknown or incomplete observation is BLOCKED and cannot satisfy acceptance.
Reviewed deterministic driver focus passes28/28, including exact-identity cleanup,
late-fork forced-deadline regression and unrelated sentinel survival.

## Current disposition — 2026-11-22

The optional SDK is now `@microsoft/copilot-sdk@2.0.1`. On native Linux,
installed Copilot CLI1.0.114 successfully initialized protocol4 through explicit
spawned stdio in `coding-agent` mode. Discovery uses the absolute installed worker
executable and caller cwd/inherited configuration; there is no implicit in-process,
remote-server or bundled-runtime fallback. Prompt-free normal discovery PASS:
`auto` / `Auto`, effort unsupported. Readiness-synchronized SIGINT130 and SIGTERM143
both left empty success stdout and no observed owned survivors. No session or
inference was created by these probes. See the [2026-11-22 remediation record](verification/2026-11-22-copilot-remediation.md).

The Free-account `auto` worker and a fresh prepared late-stop Linux recovery plus
explicit independent retry PASS. The old attempt remains failed with worker and
launcher null exit and no completion receipt; only the distinct replacement has
real OS0, launcher0, matching report/root stop/process-exit receipt and integration
of exact `HELLO\n` bytes. Separate abrupt supervisor loss before root stop is
BLOCKED safely: no report, proof, completion or retry is invented. Historical
unprepared records remain blocked. These bounded observations do not establish
containment of arbitrary previously unseen daemonization.

`Copilot Fusion` is the user's CLI display label; the SDK independently returned
`auto` / `Auto`. Neither this label nor `auto` identifies a concrete routed model.
Paid non-auto and explicit effort live acceptance are DEFERRED for this Free
account. Runner effort remains unsupported. Optional VS Code discovery bridge is
DEFERRED; authenticated editor and native Windows reruns remain BLOCKED here.
Store-linked Copilot authority remains UNSUPPORTED by the unchanged validators.

## Historical integrated checkpoint — 2026-11-21

Build and `pnpm test` passed645 total/621 pass/24 native Windows skips/0 fail/cancel;
package dry-run and local Markdown checks passed. Those results predate this
remediation. Earlier CLI1.0.112 discovery passes and SDK1.0.34/CLI1.0.114 protocol
mismatch remain historical evidence in the [November21 record](verification/2026-11-21-acceptance.md).

## Fresh Linux rows — 2026-11-22

| Harness/source | Scenario | Request / observation | Gate | Evidence |
|---|---|---|---|---|
| SDK2.0.1 / installed CLI1.0.114 protocol4 | prompt-free CLI JSON catalog | auto / Auto; effort unsupported | PASS | normal4258ms/exit0, no inference, no observed owned survivors |
| Same source | readiness-synchronized SIGINT / SIGTERM | empty success stdout; process observation supported | PASS | child130/339ms; child143/217ms; no observed owned survivors |
| Copilot CLI1.0.114, Git/manual | prepared suspended-supervisor late report/root stop, then SIGKILL, explicit fresh retry | auto; concrete routed model unobserved | PASS | old failed/null/no completion; distinct independent worker OS0/launcher0/receipt/integration `f89f7ef`;71672ms |
| Same source | abrupt SIGKILL before report/root stop | auto, no retry | BLOCKED (expected safe failure) | no report/proof/completion; retry blocked;12979ms; no observed owned survivors |
| Free account | paid non-auto / explicit effort | unavailable account capability | DEFERRED | No premium probes or upgrade required; effort unsupported |
| Copilot editor | optional discovery bridge / authenticated editor | exact profile/host/consent/session evidence unavailable | DEFERRED / BLOCKED | CLI receipts do not close editor gates |
| Store-linked Copilot | shared assignment authority | unchanged Codex/Claude-only schema | UNSUPPORTED | Separate compatibility/authority design required |
| Native Windows | current catalog / prepared recovery | Linux host | BLOCKED | No native Windows live execution claimed |

Exact identities, commands, versions and scope are in the [2026-11-22 remediation record](verification/2026-11-22-copilot-remediation.md).

## Historical Linux rows — 2026-11-21

| OS | Harness/version | Worktree/terminal | Scenario | Request / observation | Gate | Evidence |
|---|---|---|---|---|---|---|
| Linux | Claude2.1.329 | Git/manual | implementation, accepted report, real exit, integration | sonnet / effort omitted; effective effort unobserved | PASS | `/tmp/runner-claude-worker-H19bgY/result.json`; report-before-exit integration block observed; active attach not established in this run |
| Linux | Claude2.1.329 | Git/manual | implementation, active exact-session command, report-before-exit integration block, exit, integration | sonnet / low; effective effort unobserved | PASS | `/tmp/runner-claude-worker-hZoMLo/result.json`; exact session a08a04bf-fb8d-473b-8f44-2259483012df |
| Linux | Copilot CLI1.0.112 | Git/manual | implementation, active attachment, report-before-exit integration block, matching process-exit receipt, integration | auto / no effort; routed runtime model unobserved | PASS | `/tmp/runner-copilot-worker-FRFEhG/result.json`; session45f8a4af-3914-4048-b3f4-7e1a9b437793 |
| Linux | Claude2.1.329 | Git/manual | unsuccessful report then explicit retry; historical identity preserved | sonnet / effort omitted | PASS | `/tmp/runner-claude-retry-OXpLMi/result.json`; blocked first attempt0166e8df-eef3-468b-9aec-29c5f392b8b6, completed second e92a9850-ad03-4439-adda-d00e2b6cd122 |
| Linux | Claude2.1.329 | Git/manual | operation with Codex absent from controlled child PATH | sonnet / omitted effort | PASS | `/tmp/runner-claude-worker-NFpCmk/result.json`; which codex exit1; accepted report/identity/exit0/integration |
| Linux | Claude2.1.329 | Git/manual | invalid model | runner-invalid-model-never-exists / explicit rejection diagnostic | PASS | `/tmp/runner-claude-invalid-model-mwr32J/result.json`; worker1/no report/integration rejected; auth/ENOENT cannot pass |
| Linux | Copilot CLI1.0.114 | Git/manual | owned cancellation | auto / confirmed session before owned PID/start stop | PASS | `/tmp/runner-copilot-cancel-w7Lexw/result.json`; failed supervisor143/no report/no completion/integration rejected |
| Linux | Copilot CLI1.0.114 | Git/manual | hooks disabled | required hook file absent only in fixture | PASS | `/tmp/runner-copilot-hooks-disabled-iTNaAW/result.json`; no provider PID/session/report; retained supervisory null exit |
| Linux | Copilot CLI1.0.114 | Git/manual | implementation→positive review→explicit final approval→archive | auto / no effort | PASS | `/tmp/runner-copilot-archive-soGi4L/result.json`; matching implementation+review report/exit receipts; archive25d8a3012937f0a167ee1ac7ad9c412e29d81aeb; no blocking repair cycle |
| Linux | Copilot CLI1.0.114 | Git/manual | exploratory hooks-disabled expected rejection | correctly blocked provider, driver lacked early rejection handling | FAIL | `/tmp/runner-copilot-hooks-disabled-y1pQti`; corrected real regression proves no provider process |
| Linux | Claude2.1.329 | Git/manual | exploratory Codex-absent relocated global shim | relative global shim target broken after relocation | FAIL | `/tmp/runner-claude-worker-r9uwro`; no report despite provider exit0; source wrapper fixed fixture |
| Linux | Claude2.1.329 / SDK0.3.284 | repository/direct protocol | fresh prompt-free selector and effort metadata parity | exact five selectors+efforts equal; no inference | PASS | `/tmp/task6-sdk-result.json`, `/tmp/task6-claude-comparison.json`, direct `/tmp/model-discovery-3AFRjB/result.json`; distinct from historical CLI2.1.272 |
| Linux | Claude2.1.329 | Git/manual | exploratory finished-worker resume-command assertion | real provider completed; driver assertion failed | FAIL | `/tmp/runner-claude-worker-SgJyFs`; fixed by active-window comparison above |
| Linux | Copilot CLI1.0.112 | Git/manual | exploratory fixture init | missing explicit default model before inference | FAIL | `/tmp/runner-copilot-worker-dNy5Af`; fixture regression now passes |
| Linux | Claude2.1.329 | Git/manual | exploratory invalid-model overlay retry setup | task explicit selector won; first attempt completed; retry correctly refused | FAIL | `/tmp/runner-claude-retry-PoJCxT`; successful blocked-report retry above uses revised fixture |
| Linux | Copilot CLI1.0.112 | Git/manual | non-auto startup | fresh Task5 catalog auto only | BLOCKED | Account supplies no usable non-auto selector |
| Linux | Claude2.1.329 | Git/manual | routine/complex planner rationale | actual versioned H2/H4 rules + fresh discovered catalog | PASS | `/tmp/runner-claude-planner-4ixNXz/result.json`; routine sonnet, durable concurrency/recovery opus, intentional default effort; no Codex substitution. Other harness planning/batch live combinations remain unverified |
| Linux | Claude2.1.329 | Git/manual | isolated auth failure; integration+cleanup during accepted report before supervisor exit | child-only empty config; actual observed live window | PASS | `/tmp/runner-claude-auth-7OhJHx/result.json`, `/tmp/runner-claude-gates-VAmoGY/result.json`; real-terminal detach/reattach remains BLOCKED, exact-command attachment is narrower |
| Linux | Copilot CLI1.0.114 | Git/manual | blocking review→repair→fresh review→explicit final approval→archive | auto; planted missing tracked LF policy | PASS | `/tmp/runner-copilot-repair-z6hL3L/result.json`; genuine blocking finding, distinct jobs/sessions, exact greeting+policy bytes at repaired integration and archived Git heads |
| Linux | Copilot CLI1.0.114 | Git/manual | interrupted supervisor then late root stop | exact SIGSTOP-supervisor-before-stop then SIGKILL | BLOCKED | `/tmp/runner-copilot-recovery-rtk2ZP/result.json`; genuine late accepted report/root stop, launcher gone, failed/null exit/no completion; integration+cleanup rejected. Linux stale-launcher guard retains ownership and blocks explicit retry; no bypass |
| Linux | Copilot editor | Git/manual | authenticated implementation/review/cancel/recovery | editor/provider session unavailable | BLOCKED | CLI availability is not editor authentication |
| Linux | current harnesses | Worktrunk/Herdr, Orca/Orca | fresh backend lifecycle | host context not demonstrated | BLOCKED | Backend executable presence proves no resource ownership or compatible terminal |
| native Windows | current harnesses | Git/manual and other backends | fresh delegated implementation/review/protection | Linux host | BLOCKED | No native Windows execution environment |
| real terminal | Codex0.163.0 | retained session | interactive expected-token recall | noninteractive host | BLOCKED | Automated exec resume and trust dialog do not close this gate |

## Exact historical passes (not rerun)

| OS | Harness/version | Worktree/terminal | Scenario | Gate | Evidence / limits |
|---|---|---|---|---|---|
| Windows | Codex0.167.0 | Git/manual | credential rejection | PASS | [November7 record](live-acceptance-guide.md#native-windows-run-on-2026-11-07), `runner-live-credentials-2zHcUP`; HTTP401/exit1/integration blocked |
| Windows | Codex0.167.0 | Git/manual | automated exact-session exec resume | PASS | Same record, `runner-live-resume-3Xwwye`; token recalled, interactive terminal recall remains BLOCKED |
| Windows | Codex0.167.0 | Git/manual | implementation/review/final approval/archive/idempotence | PASS | Same record, `runner-live-archive-27sptG`; archive99f3b36e08a78240176e93d820210eedb527e341 |
| Windows | Codex0.167.0 | Git/manual | delegated implementation/review/receipt/protected read/write denial | PASS | [November7 delegation](windows-delegation-guide.md#native-acceptance-on-2026-11-07); native runtime replace/delete probe is distinct |
| Windows | Claude2.1.312 | Git/manual | delegated implementation/review/receipt/protected read/write denial | PASS | Same November7 delegation record; no other backend inferred |
| Windows | Copilot CLI1.0.105 | Git/manual | blocking review→repair→integration→fresh review | PASS | [November4](LIVE_ACCEPTANCE_2026-11-04.md), `copilot-live-DEXA5v`; final approval was pending |
| Windows | Claude2.1.312 | Git/manual | independent tasks then dependency and Codex0.165.0 independent review | PASS | November4, `live-claude-qLqEmV`; final approval was pending |
| Windows | Copilot editor / VS Code1.144.0, Chat0.72.0 | Git/manual | managed review | PASS | November4, `live-editor-jTfIMk`; baseline task means no editor implementation/repair proof |
| Windows | Copilot editor / VS Code1.144.0, Chat0.72.0 | Git/manual | interrupted supervisor and later root stop/no fabricated completion | PASS | November4, `live-editor-crash-eynem9`; failed/null exit, explicit retry preview |
| Windows | Copilot CLI1.0.105 | Git/manual | real cancellation | PASS | November4, `live-cancel-copilot-5i10zv`; retained failed attempt/no report/integration blocked |
| Windows | Claude2.1.312 | Git/manual | real cancellation | PASS | November4, `live-cancel-claude-WTtFek`; explicit retry preview |
| Windows | Codex0.165.0 | Git/manual | real cancellation | PASS | November4, `live-cancel-codex-e5FcVd`; explicit retry preview |
| Windows | Copilot CLI1.0.105 | Git/manual | supervisor crash, late report and corrected recovery | PASS | November4, `live-crash-copilot-EzZLez`; failed/null exit, no fabricated receipt, explicit retry preview |
| Windows | Copilot CLI1.0.105 | Git/manual | invalid model | PASS | November4, `live-invalid-sFAyvo`; exit1/no report/integration blocked |
| Windows | Claude2.1.312 | Git/manual | denied native PowerShell | PASS | November4, `live-denied-nPK7fX`; process0 still failed task/no begin/report/integration |
| Windows | Copilot CLI1.0.105 | Orca/Orca | implementation, receipt, integration | PASS | November4, `live-orca-jwTPn3`; cleanup skipped due another terminal, not cleanup success |
| Windows | Claude2.1.312 | Worktrunk/Herdr | implementation/integration/owned pane closure/worktree removal | PASS | November4, `live-herdr-8VFrL9`; user ran a real Herdr pane |

The [durable acceptance record](verification/2026-11-21-acceptance.md) records commands, available verification, discovery scope and still-open subgates; discovery does not substitute for lifecycle receipts.

## Running the drivers

Run from the source checkout and build first. Both wrappers reject missing/invalid arguments before resources. Examples deliberately show opt-ins:

```sh
node test/live/claude-acceptance.mjs worker --model sonnet --infer --effort low
node test/live/claude-acceptance.mjs retry --model sonnet --infer --retry
node test/live/copilot-acceptance.mjs hooks-disabled --model auto --infer
node test/live/copilot-acceptance.mjs cancel --model auto --infer --cancel
node test/live/copilot-acceptance.mjs archive --model auto --infer --approve --timeout-ms 240000
```

Copilot version changed externally during the run; 1.0.112 and 1.0.114 rows are distinct. No installation was performed by these drivers.

Every invocation retains a unique `/tmp/runner-HARNESS-SCENARIO-*` directory. Timeout/nonzero/missing-receipt/owned-survivor conditions fail; no retry is automatic. The retry fixture explicitly asks the first attempt to report blocked, then verifies the new attempt retains historical session identity. Archive approval is limited to the disposable fixture's exact preview. It does not establish blocking-review→repair behavior.
