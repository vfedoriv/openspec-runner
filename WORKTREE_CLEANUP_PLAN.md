# Two-phase worktree cleanup implementation plan

## Outcome and scope

Automatically reclaim task worktrees during execution and sweep leftovers when
every planned task is satisfied. Preserve branches and execution reports. Keep
the integration worktree until a separate, explicitly requested delivery/finalize
operation; implementing that operation is outside this change.

This plan changes the runner only. It does not authorize deleting existing
`graphrag-ui` worktrees during implementation.

## Behavioral decisions

- Phase 1 runs after the entire selected integration batch succeeds, including a
  successful `integrate --continue`. It removes the integrated task worktrees.
  Batch boundaries preserve inspection and recovery resources if a later task
  in the same batch conflicts or fails verification.
- Phase 2 runs immediately afterward when every task in the current, validated
  plan is satisfied by the committed baseline or an integrated latest attempt,
  with no pending integration or active attempt. It considers every recorded
  attempt, including older failed, blocked, and stale attempts.
- Both phases present dirty, locked, mismatched, or uncertain worktrees for user
  review and ask which should be deleted. Show each exact path, the reason it
  needs confirmation, and the changes or files that deletion would discard.
  Keep the worktree until the user explicitly approves its deletion; declining
  or not responding leaves it intact. Resolve uncertain ownership before offering
  deletion. A failed/blocked report already means the worker has stopped under
  the existing lifecycle contract; a session ID alone is neither proof of active
  work nor permission to terminate a session.
- Normal lifecycle: final report accepted and durably saved, report command
  returns, worker exits gracefully, integration batch succeeds, verified
  runner-owned terminal closes, then its worktree is removed. Preserve session
  IDs and available logs for later inspection. Closing execution does not delete
  the saved Codex conversation.
- Failed/blocked workers also exit after their accepted final report. Keep their
  terminals and worktrees for inspection until eligible for the final sweep.
  Conflicts or failed integration checks retain batch terminals and worktrees.
- Automatically close only verified runner-created terminals belonging to the
  stopped attempt. Present uncertain ownership or activity for user confirmation;
  resolve identity before acting. Manually opened terminals require explicit
  approval. Do not close the coordinator, unrelated panes, or a shared workspace
  containing other activity.
- Keep every branch, including branches containing unintegrated commits from an
  obsolete attempt. A clean obsolete worktree can be removed only when its
  current commit remains reachable through its verified retained branch.
- Cleanup failures do not undo integration, alter task outcomes, or change a
  successful integration command into failure. Report cleanup separately.
- Add `cleanup: automatic | manual` to `runner.yaml`, with `automatic` as the
  default, so the agreed behavior works without another setup step. Document the
  changed default for existing configurations; `manual` preserves retention.
- Keep `cleanup <change> --tasks IDS`. Add `cleanup <change> --all` to retry the
  final sweep explicitly once the change is complete. Both support `--dry-run`
  and `--json`; reject conflicting selectors. Status and dry-run remain read-only.

## Implementation sequence

### 1. Configuration and persisted cleanup state

Files: `src/plan.ts`, `src/runner.ts`, `src/cli.ts`.

- Validate the cleanup policy and include it in newly generated configuration.
- Preserve compatibility with existing version-1 state and `attempt.cleaned`.
  Add optional cleanup results and batch bookkeeping only where needed.
- Record runner ownership and stable terminal/session identifiers at launch,
  plus optional worker-exit and terminal-close results. Treat missing ownership
  evidence in older state as requiring inspection, not automatic permission.
- Persist the selected batch's cleanup candidates before integration side
  effects. Keep this separate from the per-task transaction, which is cleared
  after each integrated task. This lets `--continue` recover the original batch
  even after some tasks have already integrated.
- Record a completion snapshot containing task identities, the validated plan
  fingerprint, and integration head for the final sweep. Never infer completion
  merely because all existing attempts happen to be integrated.
- Invalidate completion metadata on reconciliation or newly launched work.
  For older state, derive completion from verified planning artifacts in the
  recorded integration checkout/commit; skip with an explanation if unavailable.

### 2. Shared cleanup inspection and removal

Files: `src/adapters.ts`, `src/system.ts`, `src/runner.ts`.

- Create one reusable inspector for automatic cleanup, explicit cleanup, and
  dry-run. Return per-attempt IDs, task IDs, paths, eligibility, and reasons.
- Resolve candidates only from saved attempts, then verify Git registration,
  repository identity, exact path, expected branch, and current commit. Never
  sweep filesystem names or remove unrelated worktrees.
- Protect the main checkout, integration checkout, invoking checkout, active
  attempts, and worktrees involved in pending integration.
- For integrated attempts, require the expected reported commit and evidence
  that it is included in the recorded integration history. For obsolete attempts,
  verify the retained branch protects the current commit.
- Check tracked changes and untracked files. Use ordinary Git worktree removal
  for automatic cleanup. Allow force removal only for exact, verified candidates
  explicitly approved after review, including approval to discard local changes
  or override a lock where applicable. Never use recursive filesystem deletion.
  Explain that ignored build/dependency files in a removable worktree disappear
  with its directory. Preserve current commits through retained branches before
  deleting an approved worktree whose branch or HEAD differs from recorded state.
- Distinguish an already removed worktree from a missing path with stale Git
  registration or a reused path. Do not mark uncertain resources as cleaned.
- Persist each successful removal. Re-inspection must recover safely if the
  process crashes between removal and state save.

### 3. Worker exit and terminal closure

Files: `src/adapters.ts`, `src/system.ts`, `src/codex.ts`, `src/runner.ts`, and
`skills/openspec-runner-implement/SKILL.md`.

- During implementation, verify supported Codex and Herdr exit/close operations
  against current documentation and adapter capability checks. Do not assume
  ending an assistant turn exits the Codex process, or inject guessed commands
  into a terminal whose foreground process is unknown.
- Implement a graceful exit handoff after a completed, failed, or blocked report
  has been accepted and the reporting command has returned. Never terminate the
  worker from inside the report handler. Rejected reports keep the session
  available to correct and resubmit them.
- Confirm actual process exit separately from report acceptance. Use bounded
  waits outside the repository lock; a timeout or unsupported exit capability
  produces a pending action for the coordinator, without automatic force-killing.
- Before eligible worktree removal, inspect the saved terminal ownership and
  current activity, close only the verified runner-owned terminal, and confirm
  closure. Never close an entire shared workspace to remove one task pane.
- Include old failed/blocked attempts in terminal cleanup during the final sweep.
  If a terminal has been reused or other processes are active, ask the user what
  to close and explain the impact. Bind approval to the inspected resource and
  recheck before acting. Worktree-deletion approval does not implicitly authorize
  terminating newly discovered activity.
- If a known attached session or terminal cannot be closed safely, retain its
  worktree and return the pending action. Unsupported/manual terminal adapters
  provide explicit instructions and a confirmation path. Already exited workers
  and already closed terminals are successful, repeatable cleanup outcomes.
- Preserve reports, session IDs, and available durable logs before terminal
  removal. Make `attach` explain closed-terminal/removed-worktree state and how
  to inspect the retained session or branch; never blindly resume implementation
  inside a removed worktree.
- With `cleanup: manual`, workers still exit after accepted final reports, while
  terminal closure and worktree removal wait for explicit cleanup.

### 4. Automatic integration hooks and recovery

File: `src/runner.ts`.

- After integration commits and task state are durably saved, execute phase 1
  when the selected batch has succeeded. Close eligible terminals before their
  worktrees are removed. Then evaluate and run phase 2 using the same sequence.
- Retain candidates across partial batch failure. On successful continuation,
  clean earlier integrated members as well as the final member. Abort itself
  performs no cleanup; previously integrated attempts remain eligible later.
- Make repeat integration/cleanup calls retry eligible leftovers without another
  merge or duplicate integration commit.
- Coordinate inspection, removal, and state changes under the repository lock
  without recursively acquiring it. Release the lock before waiting for user
  input. Reacquire it and re-inspect before an approved removal; require fresh
  confirmation if identity, HEAD, lock, or local contents changed since review.
- Return structured cleanup results such as removed, already removed, skipped,
  confirmation required, and failed, with reasons, covering worker exit, terminal
  closure, and worktree removal separately. Isolate cleanup errors from integration errors and
  surface persistence failures honestly without rewriting successful task phases.

### 5. Explicit retry and archived changes

Files: `src/cli.ts`, `src/runner.ts`.

- Implement selectors and dry-run using the shared inspector. Preserve the
  existing explicit task-selection behavior and branch-retention response fields.
- `--all` sweeps only this change's recorded attempts after verified completion.
  It excludes the integration worktree even when all tasks are satisfied.
- Avoid requiring the change directory to remain in the invoking checkout.
  Prefer saved completion evidence and immutable Git history for archived
  changes; never use missing artifacts as evidence of completion.
- Report retained resources and actionable reasons in text and JSON. Explicit
  cleanup may report failure for removal errors; automatic cleanup remains a
  warning attached to successful integration.
- In an interactive CLI, offer keep/delete choices for reviewed candidates. In
  agent-coordinated execution, return structured confirmation requests so the
  coordinator can ask the user and apply their selection through an explicit
  cleanup confirmation operation. Bind approval to exact attempt IDs, paths,
  and inspected state; do not add a blanket force-all bypass.
- JSON and unattended runs must not block for terminal input. Persist pending
  review items and return them to the caller; the coordinator presents them to
  the user. Missing input never counts as consent and never blocks integration
  success. Hard exclusions such as unrelated, active, main, invoking, and
  integration worktrees cannot be overridden by this confirmation flow.
- Expose saved cleanup results through status when status can load the plan.
  Repairing all archived-change status behavior is outside this change.

### 6. Behavior and recovery tests

Files: `test/runner.test.mjs`, `test/worktrunk.test.mjs`, and CLI tests as needed.

- Successful batch removes its task worktrees, retains branches/reports and the
  integration worktree, and permits dependent tasks to launch.
- Final task triggers a sweep that removes clean obsolete retries and retries
  earlier cleanup failures; incomplete plans and active attempts prevent it.
- Conflicts, failed checks, partial batches, abort, and continuation preserve
  recoverability and clean only after the appropriate success boundary.
- Inject crashes/failures after integration commit, after task-state save, and
  after removal but before cleanup-state save; retries produce no duplicate
  integrations or unsafe removals.
- Dirty/untracked, locked, changed-branch, and unexpected-commit worktrees require
  confirmation. Test approval, rejection, no response, selective approval, and
  changed contents after approval. Uncertain ownership must be resolved first;
  unrelated, active, main, invoking, and integration worktrees remain excluded.
- Verify unattended/JSON operation returns pending review without prompting,
  approvals cannot apply to other attempts or changed resources, and user input
  is awaited without holding the repository lock.
- Old failed/blocked attempts with unique commits retain their branches and
  commits after removal. Uncertain or still-active attempts are preserved.
- Existing state without new fields, manual policy, archived changes, baseline
  completed tasks, and reconciliation behave correctly.
- Git and Worktrunk-created worktrees, including paths with spaces, follow the
  same policy. Dry-run changes neither worktrees nor persisted state.
- Cleanup errors remain visible while successful integration still succeeds.
- Accepted reports return before graceful exit; rejected reports do not trigger
  exit. Verify completed/failed/blocked outcomes and real exit acknowledgement
  with fake processes and adapters, including timeout and unsupported capability.
- Successful integration closes the correct owned terminal before removal;
  conflicts and failed checks retain terminals. Manual policy retains terminals
  until explicit cleanup while still allowing worker exit after reporting.
- Test already closed, reused, manually opened, shared, and uncertain terminals;
  changed activity after approval; and closure failure preserving the worktree.
  Dry-run never exits sessions or closes terminals.
- Recover from interruption between exit, terminal closure, and worktree removal
  without duplicate actions or loss of session IDs/reports. Verify `attach`
  handles closed terminals and removed worktrees explicitly.

### 7. Documentation and verification

Files: `README.md`, `OPENSPEC_PLANNER.md`,
`skills/openspec-runner-coordinate/SKILL.md`, and
`skills/openspec-runner-implement/SKILL.md`.

- Replace manual-only retention guidance with the two phases, policy default,
  opt-out, retry commands, skipped-resource handling, and retained branches.
- Update coordinator guidance to inspect cleanup summaries after integration and
  ask the user which pending cleanup candidates to delete, explaining what will
  be discarded. Apply only the approved selection. Distinguish task completion
  from delivery of the integration branch.
- Document graceful worker exit after report acceptance, terminal closure before
  removal, manual/unsupported adapter handling, pending confirmations, and how
  to inspect retained sessions and reconstruct worktrees from retained branches.
- Run `pnpm test`, then exercise affected CLI paths with `--json` and
  `--dry-run` in disposable repositories. Run `pnpm pack --dry-run` to verify
  packaged workflow documentation. Do not hand-edit generated `dist/` files.

## Acceptance criteria

After a normal change finishes, all eligible task-attempt worktrees are gone,
including obsolete retries. Workers have exited gracefully and their eligible
runner-owned terminals are closed before worktree removal. The integration
worktree, branches, commits, reports, session IDs, and available durable logs
and task outcomes remain available. Every candidate requiring confirmation is
presented for a user decision, with a repeatable approval path including after
archival. Uncommitted work is discarded only with explicit approval for the
reviewed worktree. Cleanup failure or interruption never requires repeating a
completed merge.

## Inspection correction

The earlier archived-change failure observed in `graphrag-ui` came from `status`,
not `cleanup`. Current cleanup loads planning artifacts from each task worktree,
so archival in the main checkout alone does not establish a cleanup failure.
The archived-change tests above will verify the actual cleanup behavior.
