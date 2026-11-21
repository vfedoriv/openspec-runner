# Acceptance evidence — 2026-11-21

This durable record summarizes sanitized measured evidence from the implementation
session. Full raw scratch logs are intentionally not published. Local `/tmp`
locations below identify retained observations, not package links or guaranteed
future artifacts; if removed, their underlying raw evidence is unavailable.
No credentials, provider transcripts or environment dumps are included.

Base commit: `88c5696b5101246d5e180ba35751a6c8ef457626`, plus uncommitted
reviewed changes. Native Linux x64/ext4, kernel6.8.0-151-generic, Node24.16.0,
pnpm11.7.0, Git2.43.0, TypeScript5.9.3. No dependency/lock upgrade, global
installation or global credentials/trust change was performed. CLI versions
changed externally between runs; version numbers below apply only to their rows.

## Deterministic verification

Commands ran from the source checkout. Subprocess-heavy runs needed the already
authorized native execution retry because sandbox process virtualization produced
opaque file-level failures or `spawnSync git EPERM`; those were not product reds.

| Scope | Exact command | Measured result |
|---|---|---|
| Initial baseline | `pnpm run build`, then `pnpm test` | build0; suite1:555 total,530 pass,1 fixture failure,24 native Windows skips,0 cancelled |
| Named baseline correction | `node --test --test-name-pattern='^coordination snapshot never writes files refs checks or worker tools$' test/dashboard-coordination.test.mjs` | before1 failed; after1/1 PASS; exact read-only approval-history Git argv allowed, mutation/other-log rejection retained |
| Corrected fixture file | `node test/helpers/run-tests.mjs test/dashboard-coordination.test.mjs` |22/22 PASS |
| Copilot executable-path correction | `node test/helpers/run-tests.mjs test/copilot-model-discovery.test.mjs` |final8/8 PASS; positive executable-marker control, PATH/spaces/symlink/fallback/no inference |
| Wider path check | `node test/helpers/run-tests.mjs test/copilot-model-discovery.test.mjs test/platform-command.test.mjs test/dashboard-catalog.test.mjs` |18 pass,5 native Windows skips,0 fail |
| Process cleanup/uncertainty | `node test/helpers/run-tests.mjs test/copilot-model-discovery.test.mjs test/dashboard-actions.test.mjs test/platform-process.test.mjs` |42 pass,2 native Windows skips,0 fail/cancel; SIGINT/SIGTERM, timeout/abort/failures, sentinel/mutation/clipboard guards |
| Claude catalog | `node --test --test-reporter=tap test/claude-model-discovery.test.mjs test/dashboard-catalog.test.mjs` |31/31 PASS after real protocol reds and fatal UTF-8 correction |
| Raw protocol boundary | `node --test --test-name-pattern='malformed UTF-8|raw protocol stdout' test/claude-model-discovery.test.mjs` |3/3 PASS; prior malformed UTF-8 red0/2 |
| Discovery driver | `node --test test/model-discovery-driver.test.mjs` |final9/9 PASS; no inference, strict interrupt/readiness/empty stdout and finite sanitized metadata |
| Provider/brief handoff | `node test/helpers/run-tests.mjs test/presentation-brief.test.mjs test/summary-cli.test.mjs` |15/15 PASS; no production fix or provider invocation/rendering claim |
| Copilot follow-up protocol | `node --test --test-name-pattern='Copilot protocol' test/copilot-model-discovery.test.mjs`, then `node --test test/copilot-model-discovery.test.mjs` |before2 pass/2 genuine fail (DEL rewriting and malformed UTF-8 acceptance); after build0 and25/25 PASS; raw/fatal boundary correction independently reviewed |
| Lifecycle extension focus | `node --test test/lifecycle-driver.test.mjs test/harness-lifecycle.test.mjs test/feature-contract.test.mjs test/copilot-recovery.test.mjs` |24/24 PASS including12 driver tests; live extension outcomes tracked separately |

Final fixture-only transport/receipt focus: `node --test test/lifecycle-driver.test.mjs test/harness-lifecycle.test.mjs test/feature-contract.test.mjs test/copilot-recovery.test.mjs` —27/27 PASS,0 skips/failures; planner swapped-model and repair wrong/missing-policy or CRLF negative controls retained.

Integrated checkpoint: `pnpm test` exit0,628 total,604 pass,24 native Windows
skips,0 fail/cancel,183045ms. This checkpoint predates the Copilot protocol fix
and later lifecycle extension and is not their final full-suite verification.
`pnpm pack --dry-run` exit0 (coordinator checkpoint; current product build
included). This is a historical checkpoint; final results appear below.

## Prompt-free installed discovery

From the source checkout after building, exact driver interface:
`node test/live/model-discovery.mjs --agent AGENT --cwd PATH [--worker-cwd PATH] [--interrupt]`.
It invokes installed `--version` and runner `models --agent AGENT --catalog --json`;
no inference/session creation is implicit.

- Copilot1.0.112: normal PATH/no symlink catalog `[auto]`,exit0,2296ms,no
  observed remaining owned descendants; `/tmp/model-discovery-UHKPEs/result.json`.
  Top-level `--interrupt` after probe+CLI readiness exited130 with empty stdout,
  no observed remaining owned identities; `/tmp/model-discovery-iUUnBX/result.json`.
  Earlier probe-only interrupt exit0/unavailable is separate failure-handling
  evidence and does not satisfy top-level interrupt acceptance.
- Codex0.163.0: root/actual prepared managed worker cwd catalogs equal, including
  effort metadata,exit0/no descendants; `/tmp/model-discovery-YIiyL3/result.json`.
  Eight selectors:gpt-6.1-sol,gpt-6.1-terra,gpt-6-astra,gpt-6-sol,gpt-6-luna,
  gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna. No worker inference in comparison.
- Claude2.1.329: root/actual worker cwd entries equal,exit0/no descendants;
  `/tmp/model-discovery-oWyNtS/result.json`. Fresh direct/SDK0.3.284 selectors and
  effort metadata equal:default,opus,claude-fable-5-2[1m],sonnet,haiku;
  `/tmp/task6-claude-comparison.json`. Empty SDK prompt iterable submits no user
  turn. Same-version selectors varied between sessions; no stable alias guarantee.
- Historical CLI2.1.272/SDK0.3.325 fable alias mismatch cause remains OPEN;
  current parity does not explain it. Raw aliases are preserved, never rewritten.

## Fresh installed lifecycle evidence

All rows are native Linux Git/manual. Exact wrappers require explicit inference:
`node test/live/claude-acceptance.mjs SCENARIO --model sonnet --infer` and
`node test/live/copilot-acceptance.mjs SCENARIO --model auto --infer`.
`retry` also requires `--retry`; `cancel` requires `--cancel`; archive/repair
require `--approve`. These are disposable-fixture opt-ins, not blanket approval.
Rows summarize accepted reports plus actual exit evidence; model requests and
effective runtime model/effort remain separate.

| Harness/version / scenario | Result and retained evidence |
|---|---|
| Claude2.1.329 worker, omitted effort |PASS session64f83434-1331-4528-92d8-36ddfeb7783b,report commitdf86e57cd1db08431a9f50140fb4cac1c7e04381,real exit0/integration; `/tmp/runner-claude-worker-H19bgY/result.json` |
| Claude2.1.329 worker `--effort low` |PASS exact sessiona08a04bf-fb8d-473b-8f44-2259483012df,report commitc085e5c3a3305c130a5e1ce852e6dab503e4a625,exit0/integration; active resume command and report-before-exit integration rejection observed; `/tmp/runner-claude-worker-hZoMLo/result.json` |
| Copilot1.0.112 auto worker |PASS exact session45f8a4af-3914-4048-b3f4-7e1a9b437793,report commitaef3d1934d8e41c377751149222c1bfe67c1bf3f,matching process-exit receipt0/integration and active attach command; `/tmp/runner-copilot-worker-FRFEhG/result.json` |
| Claude2.1.329 retry `--retry` |PASS first intentional blocked report then explicit distinct new session/attempt,completed report/exit0/integration,historical identity retained; `/tmp/runner-claude-retry-OXpLMi/result.json` |
| Claude2.1.329 invalid-model (model `runner-invalid-model-never-exists`) |PASS explicit model rejection,exit1,no report,integration rejected; `/tmp/runner-claude-invalid-model-mwr32J/result.json`; auth/ENOENT alone cannot satisfy gate |
| Claude2.1.329 Codex absent |PASS controlled child PATH `which codex`1,accepted report/exact session/exit0/integration; `/tmp/runner-claude-worker-NFpCmk/result.json` |
| Copilot1.0.114 cancel `--cancel` |PASS observed saved launcher PID/start owned stop,failed supervisor143,no report/completion,integration rejected; `/tmp/runner-copilot-cancel-w7Lexw/result.json` |
| Copilot1.0.114 hooks-disabled |PASS required-hooks-missing rejection before provider PID/session/report,no success receipt; `/tmp/runner-copilot-hooks-disabled-iTNaAW/result.json` |
| Copilot1.0.114 archive `--approve` |PASS implementation + positive review actual report/exit receipts,exact final approval/archive25d8a3012937f0a167ee1ac7ad9c412e29d81aeb; `/tmp/runner-copilot-archive-soGi4L/result.json`; no blocking repair-chain claim |
| Claude2.1.329 auth |PASS child-only empty config/allowlisted environment,explicit auth rejection,real exit1,no report,unchanged head,integration blocked; `/tmp/runner-claude-auth-7OhJHx/result.json`; global credentials untouched |
| Claude2.1.329 gates |PASS actual accepted-report-before-exit integration AND cleanup rejection,worktree retained in observed window; real report commit0b26820a1da1c7e2a63de6b6670e425b770248e1,exit0 then integration; `/tmp/runner-claude-gates-VAmoGY/result.json` |
| Claude2.1.329 planner |PASS actual version2026-09-14 planning rules/hash207e1b59bd11aa8f29b8fe547c6f1a4f217120b8b6ae35c17f16ed681f2fcc07 plus fresh catalog; routine sonnet/H2, durable concurrency/recovery opus/H4, intentional null effort; requested sonnet, observed claude-sonnet-5-5/session65d922fc-9f9b-427e-bc2b-999169623ac8; exit0/no survivors; `/tmp/runner-claude-planner-4ixNXz/result.json` |
| Copilot1.0.114 blocking review/repair `--approve` |PASS genuine missing-lf-policy finding; distinct repair/session commit0c0bcba109e77fd7786bb33397d170cbfe813d76, integratedd9b2c3a08c0c37b4acf262d6c727248abcadbec8; approval rejected until fresh clean review; explicit archive8108db58a31eef59381c2f28d3d4142185efc6c3. Exact tracked greeting `HELLO\n` and policy `*.txt text eol=lf\n` verified at both heads; every job real exit0/matching receipt; `/tmp/runner-copilot-repair-z6hL3L/result.json` |
| Copilot1.0.114 supervised late-stop `--cancel` |BLOCKED end-to-end retry. Exact Linux SIGSTOP-supervisor-before-root-stop then SIGKILL; genuine accepted report commitcf99a992d33b1248b7ffb78a757866abd84e16a6/sessionac768f51-b63c-4d48-8fc7-b5418f384721 and matching stop while suspended; launcher subsequently gone, public recovery failed/null exit/no completion, integration+cleanup rejected. Intentional stale-launcher ownership guard blocks explicit retry preview; no bypass; `/tmp/runner-copilot-recovery-rtk2ZP/result.json` |

Exploratory failures remain historical: finished-worker resume assertion
`runner-claude-worker-SgJyFs`; missing default Copilot model
`runner-copilot-worker-dNy5Af`; invalid retry overlay
`runner-claude-retry-PoJCxT`; relocated relative runner shim
`runner-claude-worker-r9uwro`; missing early hooks-rejection handling
`runner-copilot-hooks-disabled-y1pQti`; planner
`runner-claude-planner-GmLllY` (variadic `--add-dir` consumed prompt; explicit
`--` separator corrected with regression). Subsequent rows use fresh corrected
fixtures. Failed investigations are not erased or counted as product acceptance.


## Final driver review and current runtime boundary

Whole-change review findings are closed. Test-owned ancestry now requires current
PID plus creation-identity matches; historical identities cannot seed replacement
children and each signal refreshes identity. The demonstrated forced-deadline
late-fork leak reproduced red, then passed after Linux freeze/refresh required two
stopped snapshots before exact-identity SIGKILL. Unrelated sentinel survival and
false/missing observation gates pass. Final command from source checkout:
`node --test test/model-discovery-driver.test.mjs test/lifecycle-driver.test.mjs`
—28/28 PASS,0 fail/cancel/skip,exit0,4400.795146ms; scoped follow-up review PASS.
This is bounded observation, not containment of arbitrary unobserved daemonization.
The new driver process observer supports Linux only. Unsupported/unknown or
incomplete observation is explicitly BLOCKED and cannot produce acceptance PASS.

Integrated v2 checkpoint: `pnpm test` exit0,641 total,617 pass,24 native Windows
skips,0 fail/cancel,182894ms. Final v3 `pnpm test` after the deadline correction exited0:645 total,621 pass,
24 native Windows skips,0 fail/cancel,181563.469365ms; included successful `tsc`
build. Final `pnpm pack --dry-run` exited0; package includes this durable record
and matrix, excludes ignored scratch logs and the deleted superseded plan.
Primary checked14 changed Markdown files: local targets/heading anchors0 errors,
no scratch links; `git diff --check` exit0. Retained checkout logs:
`logs/coordinator-final-suite-v3.log`, `logs/coordinator-final-package.log` and
`logs/coordinator-doc-links.json`. No full-matrix claim follows.

Fresh primary prompt-free commands from source checkout:
`node bin/openspec-runner.js models --agent codex --catalog --json`,
`node bin/openspec-runner.js models --agent claude --catalog --json` and
`node bin/openspec-runner.js models --agent copilot --catalog --json`.
All three CLI commands exited0. Codex available8 and Claude available5; current
Copilot catalog unavailable (command success is not catalog availability).
Read-only direct probe `node dist/harnesses/copilot-model-probe.js /home/vitaliy/.local/bin/copilot`
exited1 with empty stdout: ambient CLI1.0.114 serves protocol4, pinned
`@github/copilot-sdk`1.0.34 supports protocol3 (metadata expects CLI1.0.112).
Failure occurs in `client.start()` before `listModels()`. Current discovery is
compatibility BLOCKED, not an authentication failure or proven catalog regression.
Earlier CLI1.0.112 authenticated discovery passes and CLI1.0.114 worker/archive
passes remain valid independent observations. No SDK/CLI upgrade was performed;
a compatible pair plus repeated prompt-free discovery is a remaining gate.

## Remaining disposition

Primary also independently read real tracked Git blobs at repaired integration
and archive heads: exact `HELLO\n` greeting and `*.txt text eol=lf\n` policy,
beyond the JSON receipts.

OPEN: unrun harness/backend/planner-batch combinations; historical Claude
alias cause; independent effective effort. Missing barriers/fixture defects and
unrun reachable acceptance are OPEN work, not environment blockers.

BLOCKED: current Copilot CLI1.0.114/SDK1.0.34 catalog protocol compatibility;
unsupported/unknown driver process observation; end-to-end Linux late-stop explicit retry by intentional stale-launcher
ownership contract; native Windows reruns (Linux host); real-terminal interactive token
recall/detach/reattach; authenticated editor surface; non-auto Copilot account
catalog; actual third-party presentation rendering without an available authorized
provider. Optional editor discovery bridge DEFERRED; shared Copilot OUT OF SCOPE.
The [matrix](../ACCEPTANCE_MATRIX.md) preserves exact historical Windows/backend
passes and independently scoped remaining rows. No full-matrix claim is made.
