# Copilot remediation verification — 2026-11-22

This local-only record closes the scoped Linux Free-account remediation. No
publication, push, global install, subscription, credential or global trust change
was performed. Live inference was confined to explicitly authorized disposable
Free `auto` fixtures. Raw provider transcripts and nonce values are omitted.
Earlier temporary artifacts were lost after interruption; earlier reports and the
[November21 acceptance record](2026-11-21-acceptance.md) are authoritative historical
summaries, not newly inspected raw evidence. Fresh final receipts were inspected
and copied into ignored working evidence before cleanup; scratch is not packaged.

## Scope and versions

Product source/dist froze at `af44ca3`; final acceptance driver/tests are at
`8dc7e82` after the reviewed cleanup correction. Native Linux6.8.0-151-generic x86_64, Node24.16.0, pnpm11.7.0,
Git2.43.0; existing Python3.10.19 supplies `os.pidfd_open` and
`signal.pidfd_send_signal`. The project Node floor remains `>=22.13`.
Optional `@microsoft/copilot-sdk@2.0.1` supports Node `^20.19.0 || >=22.12.0`.
Its runtime metadata is1.0.114, sourceSha
`780b7b259392066ad0494a65114a9200a5a3234d`; optional platform artifacts are pinned2.0.1
for darwin/linux/linuxmusl/win32 x64/arm64. Linux-x64 artifact metadata specifies
glibc. Artifact metadata alone proves no native Windows behavior.

Selected discovery source is the absolute installed worker executable
`/home/vitaliy/.local/bin/copilot`, version1.0.114. The isolated optional-SDK probe
uses `RuntimeConnection.forSpawnedStdio({path, workingDirectory})` and explicit
`mode:"coding-agent"`, inheriting cwd/environment/config. SDK-spawned flags include
`--headless --no-auto-update --stdio`. Actual `getStatus` returned
`{version:"1.0.114",protocolVersion:4}` during Tasks1–2. There is no implicit
in-process, remote-server or bundled-runtime fallback. The bundled runtime was
separately checked historically, then deliberately not selected.

## Implementation and review ledger

| Unit | Base → final | Result and verification scope |
|---|---|---|
| Tasks1–2 | `19a33bb` → `e25f724` | Optional SDK migration and explicit probe, reviewed clean after residual cleanup fix;57 focused/56 pass/1 Windows skip,44635ms; independent8/8 cleanup checks |
| Task3 | `e25f724` → `ebfcb7e` | Opaque single choice, saved selector retention, no inferred entitlement/effort;47/47 focused; reviewed clean; real auto worker below |
| Task4 | `ebfcb7e` → `6ec491c` | Canonical prepared Linux identity proof, public Runner/Feature APIs, optional pidfd signaling; reviewed clean after8 initial and3 follow-up findings;140 focused/138 pass/2 Windows skips |
| Task5 | `6ec491c` → `af44ca3` | Freeze-before-census `b5412db`, strict absence follow-ups `89a67e8`/`af44ca3`; driver proof `0231870`, independent replacement `a8c6c1d`; reviewed clean;60/60 final native safety+driver tests |
| Final driver fix | `12b48a2` → `8dc7e82` | Post-publication cleanup keeps prepared supervisor frozen; actual public receipt/account-free regression,61/61 focused safety+driver PASS; scoped re-review PASS |
| Tasks6–7 | product `af44ca3`, driver/tests `8dc7e82` + documentation | Conditional gates, durable record and package checks; whole-branch review and final verification below |

The SDK1.0.34/protocol3 baseline against CLI1.0.114/protocol4 failed at start,
before listModels: `SDK protocol version mismatch: SDK supports versions 3-3,
but server reports version 4.` Bounded no-prompt start/stop took400ms with no
survivors; this was not authentication failure. Earlier CLI1.0.112 successes and
1.x failures remain historical. They are not rewritten as v2 results.

## Fresh prompt-free catalog and interruption

All commands run from `/home/vitaliy/workspace/openspec-runner`, inherited account
configuration, SDK2.0.1/installed CLI1.0.114; no session or user turn. The driver
executes `models --agent copilot --catalog --json` under owned-process observation.

```sh
node test/live/model-discovery.mjs --agent copilot --cwd /home/vitaliy/workspace/openspec-runner --timeout-ms 25000
node test/live/model-discovery.mjs --agent copilot --cwd /home/vitaliy/workspace/openspec-runner --timeout-ms 25000 --interrupt --interrupt-signal SIGINT
node test/live/model-discovery.mjs --agent copilot --cwd /home/vitaliy/workspace/openspec-runner --timeout-ms 25000 --interrupt --interrupt-signal SIGTERM
```

| Case | Child exit / elapsed | Result |
|---|---|---|
| normal | 0 /4258ms | available, exact scope above; `auto` / `Auto`, effort unsupported; fetched2026-11-22T12:46:34.712Z |
| readiness SIGINT | 130 /339ms | readiness observed, empty stdout |
| readiness SIGTERM | 143 /217ms | readiness observed, empty stdout |

Outer driver commands exited0; process observation supported,
`remainingBeforeCleanup:[]`, no inference. Fresh evidence directories were
`/tmp/model-discovery-BAPwZD`, `-XH3zyb`, `-WUGRFO`. These names identify local
observations, not portable links or guaranteed retained files.

## Free worker and account boundaries

Historical Task3 command:
`node test/live/copilot-acceptance.mjs worker --model auto --infer --timeout-ms 300000`.
Native child exit0, supported observation/no owned survivors. Attempt
`fbc7ee04-b3c4-45dd-9e6f-6466c14a72d2`, exact root session
`d9c66af5-bbe6-4a74-bcaf-125eabeb80b9`, accepted report
`5eb32e807e6075050bf68cb54f8b3b856a2b5084` at2026-11-21T13:59:25.114Z;
matching root stop13:59:26.446Z; real worker/launcher0 and process-exit receipt
13:59:27.272Z; integration `2cb9e24c7ec0072e9aa9a7233c8cea81c7504c8e`,
independently checked `HELLO` plus LF. Report-before-exit integration/cleanup
blocked. Duration was not retained in the surviving summary; it is not invented.
Root and actual worker cwd catalogs both returned auto/Auto, unsupported effort,
no inference/survivors. Raw temporary files from this earlier run are unavailable.

The user's picker label Copilot Fusion, discovered/requested `auto`, provider
label Auto and concrete routed model are separate facts. A successful auto worker
proves this selector works in the identified Free environment; no independent
Fusion label mapping or concrete routed model is claimed. Effective effort is
unobserved. Account-free fixtures cover advertised opaque selector/changed label,
saved stale premium selector, unavailable catalog, unexpected metadata, no silent
remap, inherited effort rejection and40/80-column confirmation. Paid non-auto and
explicit effort acceptance remain DEFERRED; no subscription upgrade is required.

A later entitled-account decision must verify advertised selector/effort, actual
startup invocation and independently observed setting before enabling effort.
Historical omitted-effort records retain their bytes and meaning. CLI help alone
is not evidence to enable effort. The optional VS Code bridge remains DEFERRED:
exact profile/extension host, granted/denied consent, requested/observed selector,
existing-chat ownership and completion receipt gates remain separate. Authenticated
editor live checks are BLOCKED here. Store-linked Copilot is UNSUPPORTED: unchanged
validators require a separate design for old Codex/Claude records, authority and
approval hashing, import/context protection, retirement/replacement, review/repair,
submission receipts and mixed-version readers.

## Fresh prepared late-stop recovery and explicit independent retry — PASS

Command on frozen `af44ca3`:

```sh
node test/live/copilot-acceptance.mjs recovery --model auto --infer --cancel --retry --timeout-ms 300000 > /tmp/task5-live-final-late.json 2> /tmp/task5-live-final-late.stderr
```

Public acceptance CLIexit0, elapsed71672ms, root
`/tmp/runner-copilot-recovery-lTqnou`. Exact variant:
`SIGSTOP-supervisor-before-root-stop-then-SIGKILL`. Old supervisor254775/start164163,
launcher254807/start164183; pause2026-11-22T13:03:57.678Z. Old attempt
`64afb921-3ff5-4849-b5f9-6aa2df483961`, confirmed/observed session
`89fb6a8d-2f94-4c79-a7c8-5120973afff7`; genuine accepted report
`4b428d3a478670262b880f7e6d5f6f3cfe09d0b9` at13:04:18.306Z;
matching root stop13:04:19.976Z. Canonical prepared receipt existed before actual
supervisor SIGKILL: seven retained/barrier members, independently validated.
Binding `7f355982b15af426f3cb64ca85fccee4d4046afa47e6a5822c4c53eef3e05c0c`;
integrity `028ff47d29cf5e224b7f7037af0469a1ffb54a4724d7f2f91508f18ee9dc56d4`.
Old phase remains failed, worker null exit acknowledged13:04:20.601Z and launcher
null exit13:04:20.605Z; completion absent. Old integration remains rejected.

Explicit replacement attempt `ed0f36ec-9c74-40c7-89d9-610ffa62c25c`, independent
session `102733e4-d277-451d-b11a-77e2ddbfddf8`. Independent CLI worker
supervisor258995/start167676 actual OSexit0/no signal; launcher259031/start167697
exit0 at13:04:57.474Z. Accepted report
`a5570e03b0bda98fd7c3578a132896ed0f2ae67a` at13:04:55.101Z, matching accepted
root stop13:04:56.474Z, genuine `process-exit` receipt13:04:57.536Z bound to the
fresh exact session, worker0 acknowledged13:04:57.537Z. Integrated head
`f89f7ef107049c6e91c5ade595a59dd566bdeba7` matches the receipt; independently read
tracked `greeting.txt` bytes `48454c4c4f0a` (`HELLO` plus LF).

Both outer and replacement observations supported; no timeout/overflow or owned
survivors. All retained proof members independently proved gone; unrelated
sentinel survived. No lock clearing, fabricated receipts or global process kill.
Prepared stop uses the public Runner/Feature APIs programmatically; there is no
new CLI interface. Existing optional Python pidfd/kernel support and coherent
PID/procfs namespace are required only for explicit prepared stop. Unsupported
helper/uncertain reads fail closed, ordinary workers/discovery stay available.
Bounded census cannot promise containment of arbitrary previously unseen daemons.

## Separate abrupt-before-root-stop loss — expected BLOCKED

```sh
node test/live/copilot-acceptance.mjs recovery-abrupt --model auto --infer --cancel --timeout-ms 180000 > /tmp/task5-live-final-abrupt.json 2> /tmp/task5-live-final-abrupt.stderr
```

Root `/tmp/runner-copilot-recovery-abrupt-foGlpR`, elapsed12979ms; public CLIexit1
correctly communicates BLOCKED. Inner scenario controller exit0 means its checks
ran, not end-to-end recovery PASS. Attempt `d8cae3dd-7feb-4f96-b42a-f5ab81c2e324`,
confirmed session `2efceb04-0e74-4eb5-ae98-1275bd3c917c`, supervisor265298/start173860,
launcher265364/start173879. Readiness verified absent report/root stop before
actual SIGKILL. Failed/null exit acknowledged13:05:33.223Z; no report, proof,
completion or retry. Retry preview blocked; sentinel survived; supported process
observation, no timeout, all12 recorded owned identities independently gone.
No further inference followed. Historical unprepared records remain blocked.
Earlier `YFwQaO`/`h2rFok` failures remain failures; lost raw evidence does not gain
a fresh-inspection claim. Account-free fixes prove their named failure modes,
not the exact unidentified historical branch.

## Final stable-tree and distribution verification

The coordinator's pre-driver-fix checkpoint ran `pnpm test` on source/tests
`af44ca3`: build included, actual exit0;743 total,719 pass,24 skipped,0 failed,
0 cancelled,195512.850832ms. The24 skips are existing Windows/opt-in Windows
checks; there were no optional-pidfd/native-cancellation capability skips.
After the reviewed driver correction, final `pnpm test` on `8dc7e82` exited0,
build included:744 total,720 pass,24 skipped,0 failed,0 cancelled,
203784.235025ms. The24 skips remain expected platform/opt-in Windows cases,
with no native pidfd-capability skips. This supersedes the earlier checkpoint.
The repeat was required by the new regression and driver change.
The passing checkpoint includes read-only configuration and
approval preview coverage: “approval previews are read-only and bind concrete
settings, fingerprint and base”, “CLI plan/review previews and JSON status leave
state unchanged”, and “coordination and component previews leave every file
unchanged and expose revocation recovery”. Task3's explicit-high effort dry-run
also rejected with `Copilot effort is unsupported by this adapter`, without
inference or mutation.

After suite completion, `pnpm pack --dry-run` and
`pnpm pack --pack-destination /tmp/copilot-remediation-package-8EVoAt` both exited0
(including prepack builds). Elapsed times were not separately retained for those
pack commands. The actual archive was unpacked with:

```sh
tar -xzf /tmp/copilot-remediation-package-8EVoAt/openspec-runner-0.1.0.tgz -C /tmp/copilot-remediation-package-8EVoAt
cd /tmp/copilot-remediation-package-8EVoAt/package
pnpm install --prod --ignore-scripts --lockfile=false
```

The first restricted install attempt failed because the default pnpm store's
SQLite database was unwritable; the native package-local retry exited0 in3.1s.
No artifacts were manually copied. This production installation resolves the
archive's published dependency ranges (yaml2.9.1 in this install), rather than
using the repository dev installation/lockfile. It installed optional SDK2.0.1
and the matching Linux-x64 platform artifact2.0.1 with linux/x64/glibc metadata.
The archive contains `dist/linux-signal.js` and `dist/linux-signal.d.ts`; SDK pin
and Node floor are unchanged. No ignored scratch report is packaged.

A temporary verification script imported the workspace driver's
`runDiscovery({agent:"copilot",cwd:packagePath,timeoutMs:25000},
{runner:packagePath+"/bin/openspec-runner.js"})`, then required
`discoverySucceeded(result)`. Exact invocation:
`node /tmp/copilot-remediation-package-check.mjs`. Installed package discovery
PASS, actual child0/2219ms, scope exactly the unpacked package, auto/Auto,
unsupported effort, supported observation/no owned survivors, no inference;
evidence `/tmp/model-discovery-Jx4jr5`. It resolves SDK from the unpacked package's
own production dependency installation.

`node /tmp/copilot-remediation-status-check.mjs` ran that package's `status.mjs`
through `boundedChild` (25000ms deadline). It constructed the explicit installed
CLI spawned transport in coding-agent mode, called only start/getStatus/stop,
and asserted status version1.0.114/protocol4 and empty stop errors. Actual child0,
1694ms, supported observation/no owned survivors, no session or prompt.

For optional-absence verification, only the disposable package's SDK symlink was
temporarily renamed and restored in `finally`.
`node /tmp/copilot-remediation-absent-check.mjs` proved ordinary `--help` exit0
(119ms) and `models --agent copilot --catalog --json` exit0 (143ms), safe unavailable
catalog with empty entries; supported observation/no survivors. Its initial fake
worker verification failed because the temporary assertion incorrectly expected
integration to change the planning checkout. Adding await did not change this;
the runner integrates in its separate integration checkout. No production defect
or inference occurred. The corrected committed-blob/phase assertion was run alone:
`node /tmp/copilot-remediation-absent-worker-check.mjs`, actual child0/635ms,
account-free fake CLI worker0/launcher0, genuine process-exit receipt and integrated
phase. Attempt `09db6dde-4032-4f3d-861b-c10b71557b9f`, session
`fake-09db6dde-4032-4f3d-861b-c10b71557b9f`; tracked report blob was independently
read. The reported planning HEAD `098aff6811e76b3ddfa2fc3497ec08d762c0f76c` is not
claimed as the integration head. No owned survivors and no inference. Only copied
account-free helper scripts inside the disposable package were modified; no
production source/test changes or global settings were made.

`python3 /tmp/copilot-markdown-check.py` checks seven changed documents, local file
targets and Markdown heading anchors, and rejects ignored scratch targets.
The seven-document check passed47 local targets/anchors; `git diff --check` passed
before the initial documentation commit. Whole-branch independent review covered
`19a33bb..12b48a2`. The subsequently confirmed P2 was confined to acceptance-driver
failure cleanup: after durable preparation followed by an exception, its old
`finally` could send SIGCONT and invalidate the frozen barrier. Commit `8dc7e82`
sets the preparation-invoked flag before calling the public API and permits
cleanup SIGCONT only when preparation was never invoked. Exact owned termination
cleanup remains available. The regression writes an actual canonical receipt
through public Runner preparation before injecting the exception, then checks
zero SIGCONT, no retry/PASS, sentinel survival and exact owned cleanup. Native
red0/1 then green61/61 (20 driver+41 safety),34930.18035ms; final driver20/20,
7364.154472ms. Scoped re-review `12b48a2..8dc7e82` PASS, no new findings. Product
TypeScript, dist, protocol and receipt formats are unchanged. The real live PASS
success path is unchanged, so no further inference was run.

The nonblocking P3 suggestion to fail unexpected pidfd-capability skips on a
known-capable CI host remains DEFERRED; no CI feature was added. The current
native checkpoint had no such skips. Native Windows and real GUI/terminal
prerequisites remain BLOCKED on this host.

Final post-fix `pnpm pack --dry-run` exited0 in2865ms after the final suite
completed, including its prepack build. Local links/anchors and diff checks were
rerun for the two-document closure.

The coordinator independently compared all172 unpacked JavaScript/declaration
dist files against the checkout: zero hash mismatches, both Linux signal helper
files present. The dated record was packaged and no `.superpowers` entry was
present. Product distribution checks remain valid after the test-only driver fix;
no disposable production-install repeat is needed.

## Recorded scope decisions

Tasks1–2 were coupled so the optional dependency pin never ships without a usable
probe migration. Tasks6–7 share documentation/distribution scope; they add no
implicit support. Existing checkout and unrelated graph artifacts were preserved.
Linux affirmative stop requires a pre-disappearance frozen-tree barrier persisted
by an independent controller; root disappearance alone cannot prove descendants
gone. Existing optional Python stdlib pidfd signaling was accepted to bind terminal
signals to kernel handles without a numeric PID fallback. Namespace consistency
is independently checked in Node and Python; read uncertainty stays an error.
These decisions narrow explicit prepared cancellation, preserve ordinary startup
and historical records, and leave later CLI ergonomics as separate work.
