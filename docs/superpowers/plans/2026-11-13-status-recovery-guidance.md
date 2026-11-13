# Status recovery guidance implementation plan

**Goal** Show the affected attempt, available evidence, and next safe step together in CLI status and the dashboard.

## 1. Derive recovery entries from runner evidence

**Files** `src/runner.ts`, `src/feature.ts`, `src/harnesses/lifecycle.ts`, `test/runner.test.mjs`, `test/feature.test.mjs`

- [ ] Add a shared `RecoveryEntry` type with a stable kind, optional task and attempt IDs, worktree and log paths where available, an evidence message, a next-step message, and optional command arguments. Add a `recovery` array to `Runner.status` and `Feature.status`. Preserve existing `nextAction`, transaction, and attempt fields.
- [ ] For pending task integration, use the transaction's current task, its saved attempt, recorded phase, and integration worktree. For repair integration, use the transaction's exact repair attempt. Inspect unresolved Git index entries without changing the worktree. When conflicts are confirmed, say to resolve and stage them in the named worktree. Otherwise describe the recorded phase and distinguish an unavailable Git observation from a clean conflict check. Emit the appropriate `integrate <change> --continue` or `feature integrate <change> --continue` command. For pending cleanup after integration, explain that continuation resumes cleanup.
- [ ] Derive worker entries from accepted reports and saved worker receipts independently of task readiness and launch suggestions. Include the report outcome, attempt ID, and log path. Reuse completion checks to explain missing supervised exit, uncertain termination, or missing harness-specific session and stop evidence. Distinguish an absent exit receipt from an observed running process. For a completed report, explain the successful exit evidence needed before integration. For a failed or blocked report, explain the stop evidence needed before retry can be considered.
- [ ] For workers awaiting evidence, recommend inspecting the saved session or log and refreshing status. Include a read-only status command for the relevant change. Keep recovery and retry commands out of the entry until their existing eligibility checks can establish that they are appropriate.
- [ ] Test a real merge conflict, a failed integration check with no unresolved paths, repair integration, and a report before and after its exit receipt. Include uncertain termination and a case where one worker is waiting while another task can launch. Assert that status leaves the worktree, Git index, and runner state untouched.

## 2. Show the same guidance in the dashboard

**Files** `src/dashboard-types.ts`, `src/dashboard-reader.ts`, `src/dashboard-client.ts`, `src/dashboard-view.ts`, `src/dashboard-cli.ts`, and dashboard tests

- [ ] Collect recovery entries alongside existing feature and session evidence. Surface each entry in feature details and link Attention to the exact session when available. Show the worktree, evidence, and next step together. Include the entries in `dashboard --once` and preserve them as additive fields in `dashboard --json`.
- [ ] Use the same shell-aware command rendering as existing status suggestions. When the collector retains stale data, label the evidence stale and suppress actionable commands until the source refreshes.
- [ ] Test that CLI status and dashboard snapshots agree on the attempt, path, and command. Exercise a stale refresh and verify that merely displaying recovery guidance starts no commands or mutations.

## 3. Document and verify

**Files** `README.md`, `docs/dashboard-guide.md`

- [ ] Document the conflict and report-before-exit flows. Explain where to stage a conflict resolution and where to inspect missing worker evidence.
- [ ] Run the affected runner, feature, and dashboard tests, then `pnpm test`. In a disposable repository, compare `status <change> --json`, `feature status <change> --json`, and `dashboard --once` during the relevant recovery scenarios.
