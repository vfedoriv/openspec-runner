# Shared Store contracts and delegated component changes

Date: 2026-10-04
Status: Design for user review

## 1. Intent and agreed decisions

Extend openspec-runner so a team can implement one shared feature across several
repositories. OpenSpec Stores hold the shared product contract. Each code
repository keeps its own OpenSpec component change and runner execution.

The agreed first version has:

- One coordinator responsible for feature planning, assignments, acceptance,
  dependencies across components, and shared feature completion.
- Teammates executing entire component changes on separate machines.
- Explicit Git handoffs for plans, assignments, submissions, and acceptance.
- Component runners supervising local tasks and integrating them into component
  branches. The coordinator accepts those branches for the shared feature.
- Accepted and reviewed component branches reported as ready for delivery.
- Shared feature completion only after every required component PR is merged,
  verification of the merged components succeeds, and final approval is recorded.

Success means a teammate can complete an assigned component without access to the
coordinator's runtime directory, and the coordinator can accept that result
without assuming access to the teammate's worktrees, processes, or sessions.

## 2. OpenSpec compatibility and current runner constraints

The public Stores beta documents two distinct relationships. A `store:` pointer
selects an external planning root. `references:` supplies read-only upstream
specifications while a repository retains its local planning root. This design
uses the second relationship for component repositories. A workset is an editor
convenience; it is not an assignment or repository routing mechanism.

The Store's shared change can remain active during component implementation.
OpenSpec reference indexes list canonical specs, not active changes, so the
runner must explicitly include the pinned active contract when relevant.

The current implementation assumes one repository throughout `loadPlan`,
`Runner.verifyResult`, integration, feature approval, and archival. Runtime state
and locks live beneath a Git common directory. Those locks protect worktrees in
one clone, not independent clones. Component execution will retain those local
guarantees; coordination introduces a separate durable model.

OpenSpec integration must use its documented JSON root and artifact information
through an adapter. Store selection must never implicitly assign implementation
repositories. Beta capability checks must produce actionable diagnostics when an
installed OpenSpec version lacks the required contract.

## 3. Architecture and ownership

There are three cooperating units:

1. **OpenSpec context adapter:** resolves the Store and local component roots,
   reads the contract at its approved revision, and produces a deterministic
   context fingerprint. It does not own execution or Git synchronization.
2. **Shared feature coordinator:** maintains the feature manifest, approvals,
   assignments, accepted submissions, dependencies, merge evidence, and final
   verification. It uses component repositories to inspect results and prepare
   verification checkouts.
3. **Delegated component runner:** imports one assignment, executes a component
   through existing local task supervision, integration, review, and bounded
   repair, then exports a portable submission receipt.

The coordinator is the single author of authoritative assignments, acceptance,
revocation, and completion records. Teammates submit receipts through separate
Git branches. The coordinator reviews and imports them. This prevents concurrent
teammates from updating a shared status file or issuing competing assignments.

The Git branch containing coordinator records is declared in the feature
manifest. Commands require the expected branch and recorded head for mutations.
A normal Git rejection requires reconciliation; force-pushing coordination
history is outside the workflow. The coordinator may execute a component locally
using the same assignment mechanism.

## 4. Shared records and local runtime

The Store contains normal OpenSpec artifacts plus versioned runner coordination
records under `runner/features/<feature-id>/`:

```text
openspec/changes/<shared-change>/        shared proposal, design, and spec deltas
runner/features/<feature-id>/
  manifest.yaml                        component links and policies
  approvals/<approval-id>.json          approved contract and component snapshots
  assignments/<assignment-id>.json      one entire component assignment
  submissions/<submission-id>.json      imported teammate receipts
  events/<event-id>.json                acceptance, revocation, merge, completion
```

Teammates publish exported submission files on their own Store submission
branches. Import preserves their bytes and identity. An accepted receipt becomes
part of coordinator history. Growing coordination records are outside the
OpenSpec change directory and are not part of the approved contract fingerprint.

Records are immutable and versioned with `version: 1`. Changes are new records
that reference earlier ones. Repeating an operation with the same identity and
payload is idempotent; reusing an identity with different content is rejected.
Status is derived from records on the declared coordination branch. Local
runtime caches can be rebuilt from that history.

Session IDs, PIDs, worktree paths, terminal metadata, locks, and full worker logs
remain in the executing machine's Git common directory. Receipts export the
evidence needed for acceptance, not a copy of local runtime state.

Repository identities and owner labels are shared. Machine checkout mappings
are supplied explicitly through local configuration or command arguments and
are never committed to the Store. Owner labels describe responsibility; Git
access and the team's normal review process establish who may publish records.

## 5. Manifest, assignment, and receipt contracts

The feature manifest declares:

- Feature ID, Store ID, shared change ID, and coordination branch.
- Required components keyed by a stable component ID.
- Each component's repository identity, local change name, delivery branch,
  approved execution settings, and dependencies.
- A mapping from every unfinished shared OpenSpec task to component merge
  milestones or successful final verification.
- Required combined verification commands and their execution repository.
- Completion policy requiring every required component to be merged.

Approval resolves the manifest into an exact snapshot. It binds the manifest
fingerprint, Store contract revision and relevant content fingerprint, component
plan fingerprints and base commits, effective execution/review/repair settings,
verification commands, and repair limits. Approval records explicitly attest to
user consent; a generated digest alone is not consent.

An assignment contains its ID, feature approval ID, component ID, repository and
change identity, owner, component base commit and plan fingerprint, pinned Store
contract, resolved role settings, verification requirements, and repair limit.
One component has at most one active assignment. Reassignment revokes the
previous assignment and creates a new identity.

A submission receipt contains its ID, assignment ID, owner, outcome, matching
plan and contract fingerprints, base commit, result branch and full commit SHA,
task completion summary, component review findings, and verification evidence.
Review evidence identifies the exact reviewed commit and the absence or presence
of blocking findings. Blocked and failed receipts carry a concrete reason and do
not require a result commit.

Each verification entry records the command arguments, exit result, and useful
evidence. The receipt is a claim from the component owner. Coordinator acceptance
independently validates the fetched result and runs the required acceptance
checks; it does not impersonate the remote worker's local session.

## 6. Context pinning and component execution

The runner fingerprints the relevant shared contract, Store context and guidance,
and linked specifications actually supplied to the component. The source commit
is recorded for reproducibility. An unrelated Store commit does not invalidate
an assignment whose relevant inputs have not changed.

The pinned contract is materialized as immutable, read-only execution context.
Workers must not silently substitute a later registered Store checkout. The
materialized context has explicit paths reported by the runner and does not
require registering a second checkout under an existing Store ID.

Before execution, assignment import validates repository identity, committed
component plan, base commit, approval snapshot, and available harness
capabilities. It binds local managed execution to the imported approval instead
of inferring new settings from the teammate's current session. Local permission
policies still apply. Machine resource paths and adapter selections remain local;
approved task behavior, setup requirements, checks, and model settings remain
fixed. Local resource overlays may change checkout/worktree locations and
terminal/worktree adapters; they may not edit the approved planning files or
override the approved task scope, setup, checks, or model settings. Import reports
the coordination history revision it inspected; a later revocation can make a
locally completed result unacceptable to the coordinator.

The teammate's runner may launch tasks, integrate local task results, run a fresh
component review, and perform the approved bounded repairs. Export requires all
component tasks to be integrated, no blocking review findings, a clean component
integration checkout, and successful verification at the submitted commit.
Delegated execution stops before archival or shared feature completion.

The owner publishes the result branch in the component repository using normal
Git operations and publishes the receipt through the Store handoff branch.

## 7. Coordinator acceptance and dependencies

Acceptance previews show the assignment, exact result commit, changed scope,
verification requirements, component review findings, and affected dependents.
Acceptance is recorded only after:

1. The assignment is active and matches the approved component and contract.
2. The coordinator has retrieved the result commit into the correct repository.
3. The assigned base is an ancestor of the result and planning inputs still match.
4. Canonical task completion matches local integration; approved planning content
   has not changed and the component has not already been archived.
5. Required verification succeeds in a coordinator-owned checkout of that commit.
6. Component review evidence is bound to that commit and has no blocking findings.

Local task completion continues to ignore checkbox changes in plan fingerprints.
Coordinator acceptance does not mark a component merged or a feature delivered.

The first version supports dependencies on an entire component reaching
`accepted` or `merged`. These dependencies gate issuing an assignment. They must
reference existing components and form an acyclic graph. An assignment records
the exact accepted or merged upstream commits that satisfied its dependencies.
Components that can implement independently against the shared contract declare
no dependency and may be assigned together.

Changing an accepted upstream result invalidates affected unmerged downstream
acceptance and combined review. Existing merged work remains historical fact;
further implementation requires a revised component plan and renewed approval.

## 8. Lifecycle, delivery, and archival

Component status follows:

```text
planned -> assigned -> submitted -> accepted -> merged
```

Blocked submissions retain their assignment and reason. Rejected submissions
require a corrected submission under the active assignment; changed approved
scope requires reapproval. An acceptance is invalidated if its inputs change.

The shared feature progresses through planning, awaiting approval, implementing,
verifying, ready for delivery, awaiting merges, final verification, and completed.
Status includes a blocker and next action. Ready for delivery requires every
component accepted and a successful combined review against the exact component
commit tuple. Completion requires:

- Every required component has recorded merge evidence on its declared delivery
  branch.
- Combined verification and final review are bound to the recorded merged tuple.
- No blocking findings remain and final user approval binds that tuple and review.

Git-only merge evidence is explicit. A record includes the delivery branch,
delivery commit, submitted commit, and PR URL. The operator attests that the PR
has merged; the runner verifies its Git evidence. The delivery commit must
be reachable from the fetched delivery branch. For normal merges, the accepted
commit must also be an ancestor of the delivery commit. For squash or rebase,
the operator explicitly identifies the delivery commit as the merged result.

For either merge style, compute the paths changed between the assigned base and
accepted result and compare their blob identities or deletion state at the
delivery commit. Differences require a fresh component review and acceptance of
the delivered snapshot. Paths outside the accepted change need not match the
accepted branch. The merged snapshots always receive the required final checks.
A PR URL alone is not merge evidence, and locally recorded evidence describes
the fetched Git state rather than claiming live hosting-provider status.

The coordinator alone updates shared Store task checkboxes according to their
declared milestone mappings. Accepted branches do not satisfy a merge milestone.
Shared task text and mappings are approved inputs; checkbox state is normalized
when fingerprinting, just as for existing local task plans. Every unfinished
shared task must have a completion mapping before plan approval.

Delivery completion and archive status are separate. Archival becomes eligible
after delivery completion and requires explicit approval of its exact scope. The
completion preview may include that scope, allowing the same final approval to
authorize later archival when its inputs and scope remain unchanged.
The coordinator prepares post-merge component archive changes and the shared
Store archive using OpenSpec, preserving interruption receipts and scope checks.
Each archive commit is delivered through normal Git review. `archived` is shown
only when the corresponding archive result is recorded on its canonical branch;
a prepared archive branch is shown as pending delivery.

## 9. Git transport, failure, and recovery

Synchronization remains explicit: operators clone, fetch, push, and review
branches through their normal Git workflow. Runner commands report missing
commits or checkout mappings with the required repository, ref, and revision.
They do not silently pull a working checkout or publish a branch.

The coordinator records durable intent before acceptance checks or archive
side effects. Recovery recognizes completed records and commits by operation
identity and does not repeat an ambiguous side effect. Local component execution
retains the existing task and feature recovery mechanisms.

Teammates can continue active assignments while the coordinator is offline.
Progress becomes visible when Git handoffs are published and imported. There is
no inferred liveness from a stale status record. A coordinator restart rebuilds
status from committed records, and resumes or diagnoses any local transaction.

Publication failures retain local records and exact commit identities for retry.
Stale or revoked submissions are retained for inspection without automatically
accepting them. Failed component checks block that component and its dependent
milestones while independent components can continue. Failed combined checks
block delivery approval or completion and produce findings assigned to the
affected component owners.

## 10. Proposed CLI and skill boundaries

Introduce a `coordination` command family for shared feature init, status,
approval, assignment, submission import, acceptance, merge recording, review,
completion, and archival. Shared commands accept an explicit Store selector and
feature ID. Mutation previews expose the exact record and snapshot token.

Introduce a `component` command family for assignment inspection/import,
delegated status, and submission export. Existing task launch, report,
integration, review, and repair commands operate within the imported component
scope. Import and export support `--dry-run --json` without launching workers.

CLI JSON distinguishes component acceptance, delivery, and archive state, names
the resolved planning and implementation roots, and includes blocker and next
action fields. Human output presents the same facts.

Update the planning and coordination skills to recognize linked features.
Add a delegated component workflow for teammates that reads the assignment,
resumes local execution, and produces the handoff. Worker prompts receive the
pinned contract context in addition to local artifacts. Existing repository-local
workflows and persisted state remain compatible through separate versioned
coordination and assignment records.

## 11. Verification strategy and delivery sequence

Implementation verification uses temporary Store and component repositories,
with independent clones representing coordinator and teammate machines. Fake
harnesses and OpenSpec fixtures make session and compatibility behavior explicit.

Required behavior coverage includes:

- Local-root versus Store-reference resolution, active contract inclusion, and
  pinned context despite later Store checkout changes.
- Manifest validation, deterministic fingerprints, dependency cycles, and
  unrelated Store edits preserving approvals.
- Assignment import with different local paths, frozen settings, revoked
  assignments, wrong repositories, and plan drift.
- Local delegated integration/review/repair followed by portable receipt export.
- Acceptance without the remote worktree, failed verification, altered planning
  content, duplicate imports, changed receipts, and interrupted acceptance.
- Dependency milestones tied to exact upstream commits and invalidation after
  changed accepted results.
- Offline coordinator recovery, rejected Git publication, and status reconstruction
  from records.
- Normal and squash/rebase merge evidence, incomplete delivery blocking completion,
  exact merged-tuple checks, and final approval invalidation.
- Post-merge archival scope, prepared versus delivered archive status, and recovery.
- Existing unmanaged and managed repository-local behavior.

Deliver the work in order: context pinning and shared records; component
assignment and execution binding; portable submission and acceptance; dependencies
and combined review; merge completion and post-merge archival. Each stage has an
independent acceptance scenario and preserves existing local workflows.

## 12. Sources and repository anchors

- [OpenSpec Stores beta](https://github.com/Fission-AI/OpenSpec/blob/main/docs/stores-beta/user-guide.md)
- [OpenSpec agent contract](https://github.com/Fission-AI/OpenSpec/blob/main/docs/agent-contract.md)
- [OpenSpec team workflow](https://github.com/Fission-AI/OpenSpec/blob/main/docs/team-workflow.md)
- [OpenSpec customization](https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md)
- `src/plan.ts`: plan loading, fingerprints, task parsing, OpenSpec readiness.
- `src/runner.ts`: local attempts, report acceptance, integration, recovery.
- `src/feature.ts` and `src/feature-state.ts`: approvals, review, repair, archival.
- `src/system.ts`: repository identity, local runtime, and locking.
- `src/cli.ts` and project-local skills: command and agent workflow integration.
