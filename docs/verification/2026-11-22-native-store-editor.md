# Native Store editor verification — 2026-11-22

The real installed VS Code 1.144.1 and bundled GitHub Copilot Chat 0.72.0 were used with an independently created disposable Store fixture. The fixture uses a simulated OpenSpec planning executor; it does not prove real registered-Store planning compatibility. The worker transport uses the installed editor without an executable shim.

Evidence root: `E:/workspace/openspec-runner/.live-verification/runner-store-planning-CzwUsc`.
Attempt: `2e068bd3-19f0-4344-8547-76551926c7a3`.

Actual native model dropdown showed `Auto · Standard` available; named models offered an upgrade. The generated custom agent declares `model: Auto`. Git `check-ignore` accepted both the generated agent and `.github/hooks/openspec-runner.json` in the linked Store worktree.

The editor initially displayed Restricted Mode and a `Trust Folder & Continue` modal, with Copilot disabled. No automated trust action was taken. On later observation the modal was gone and a native model turn had started. The real generated hook bound the attempt lease at `2026-11-22T19:21:58.199Z` to session `2c620d52-b5b8-4081-a6ea-1dacad48e7f7`. The editor reported that Copilot Fusion selected GPT-6 Luna.

At `19:23Z`, the native turn was waiting for two user tool confirmations: reading the runner implementation skill outside the workspace, and running the public `begin` command. No automated approval was taken. The editor's visible mode selector read `Agent`; discovery/selection of the generated custom attempt agent is not established by this observation. Actual protected Store snapshot reads, accepted begin/report, Stop completion, integration and cleanup are still unverified. The worktree, lease and editor window are preserved.

The computer-use skill requires `docs/guidance.md`, which forbids acting on security permission requests and running terminal commands through UI automation directly or indirectly. These native prompts require user handling.

## Bounded outcome

At `19:24:34Z` the driver exited 1 with `Copilot hook deadline expired; editor activity may remain uncertain. Inspect saved chat/worktree before retrying`. This verification is **BLOCKED**, not a lifecycle pass. Final native UI inspection showed the skill read had completed, while the `begin` terminal confirmation remained pending. That command belongs to the expired supervised attempt and must not be approved as a continuation of this verification. No automated terminal approval, retry, cleanup, or editor termination was performed. The raw driver receipt records FAIL for its unmet assertion; the observed verification blocker is the required native user confirmation.

## User-approved late execution

The user subsequently confirmed that they had trusted the disposable folder and approved both tool confirmations. The already expired `begin` command was rejected with `Attempt is not ready to begin`. Native tools then successfully read the protected component `changes/demo/tasks.md`, component `specs/contract/spec.md` and shared `openspec/changes/shared/tasks.md`. This is positive native protected-context read evidence, even though the attempt did not complete.

The native model attempted a blocked report input at the expected runtime report-input path. It used session `ahp-session:/27b61f6f-662b-4b90-b0ed-e95131ee5201`, which differs from the hook session, and the report command failed. Its summary also records the runner's standard-session protection diagnostic: the Administrator editor terminal carries backup or restore privileges. No accepted report, task implementation or integration resulted.

Public `status --json`, run under the standard-token helper, confirmed the retained attempt is failed, with supervisor exit time `2026-11-22T19:24:26.100Z`. A public `retry demo 1.1 --dry-run --json` succeeded and reported the editor installed/supported. No fresh attempt was created: the elevated native editor terminal prerequisite remains unresolved. The lease still contains no Stop evidence. Further native verification requires a non-administrator editor session; this run did not change host security, close existing editor processes or bypass protection.
