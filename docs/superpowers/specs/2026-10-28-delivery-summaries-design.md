# Automatic delivery summaries and requested presentations

Date: 2026-10-28
Status: Approved by user on 2026-10-28

## Intent and agreed direction

People need a durable explanation of implemented work, including material they
can use to explain it to non-technical colleagues. Worker reports currently serve
execution and integration; they do not provide a coherent feature narrative.

The user selected a combined runner-and-skill approach: summaries appear
automatically, and presentations are created only on request. The runner owns
evidence and a basic summary; a skill produces the narrative from that evidence.
The user approved the implementation choices below on 2026-10-28.

## Goals and boundaries

- Automatically produce summaries of integrated tasks and completed features.
- Explain intent, resulting behavior, supported benefit, verification and limits.
- Preserve exact source identity, including archived planning artifacts.
- Make summaries available through CLI output, saved files and the dashboard.
- Offer requested presentations through a replaceable external skill.
- Keep summary failures independent of implementation and completion outcomes.

Do not infer deployment, measured business impact or live PR status from local
completion. Do not automatically publish, install presentation tools, create
slides, launch new agent sessions or modify approved implementation artifacts.
This is not a general reporting, analytics or slide-editor subsystem.

## Current implementation anchors

- `src/runner.ts`: Report contains task/attempt/session identity, outcome, commit,
  summary and verification. Task integration, not report acceptance, updates
  canonical completion. Retried attempts remain available.
- `src/feature-state.ts`: feature state retains approvals, review/repair reports,
  final approval, archive identity and completion time.
- `src/feature.ts`: archive verifies the approved artifacts and post-archive
  result before recording local feature completion. It currently runs inside
  the repository lock; narrative generation must not run inside that lock.
- `src/coordination.ts`: shared completion records consent against the reviewed
  merged component tuple; archive delivery is a separate lifecycle.
- `src/cli.ts`: init installs project skills for supported harnesses.
- `src/dashboard-*`: observational snapshots and guided actions already exist.

## Approaches considered

1. Skill only: inexpensive to implement and good prose, but CLI users can miss
   the artifact and there is no reliable evidence snapshot.
2. Runner only: predictable and always available, but assembling existing report
   strings does not reliably explain a feature to another audience.
3. Combined runner and skill, selected by the user: reliable evidence and basic
   output, with agent-written narrative and optional presentation skills.

### What automatic means

Every supported successful integration/completion command produces or reuses a
basic summary without requiring another command, agent, authentication or model
call. In an agent-coordinated workflow, the installed coordination/component
skill automatically follows up by writing the feature narrative from the bundle.

Direct CLI use guarantees the basic summary. It does not silently start a model
to improve the prose. Its output identifies narrative status and the enrichment
workflow. This distinction must be explicit in documentation and user approval.
Task summaries reuse worker prose rather than requiring an extra agent turn per
task. Feature narrative enrichment is the default agent workflow after completion.

## Evidence snapshot

Introduce a separate versioned summary bundle; do not change worker Report,
execution or feature-state schemas merely to store presentation content.

The bundle contains:

- Subject: repository-local change, individual task, delegated component or
  shared feature; stable IDs and lifecycle meaning.
- Exact source: plan fingerprint, available committed planning artifacts,
  approved base and result/archive revisions, relevant attempts and reviews.
  Shared sources include Store revision, completion event, approval identity,
  component result/delivery commits and the reviewed tuple.
- Original intent and scope, from proposal/specification artifacts when present.
- Successful integrated work, repairs, final checks, review findings, remaining
  limitations, delivery/archive status, and evidence gaps.
- Stable evidence IDs for claims, with repository-relative paths or immutable
  record/commit identities. Runtime locations are separate local metadata.
- Generator/schema versions, collection time and a digest of canonical evidence.

Include only integrated results in delivered-work lists. Keep failed/superseded
attempts as relevant context, not duplicate accomplishments. Distinguish worker
verification claims from recorded integration/final-check evidence. Existing
state may not retain full check logs: report that gap rather than reconstructing
passing commands. Do not execute checks to create a summary.

Use committed active or archived artifacts at the recorded revision, not whatever
planning files happen to be in the current checkout. Changed-path information
can support scope claims; full diffs and raw logs are not included by default.
Missing history produces an explicit incomplete-evidence section.

## Triggers and lifecycle semantics

| Event | Automatic output | Meaning |
|---|---|---|
| Task integration succeeds | Task summary | Integrated into the runner's integration branch |
| All unmanaged tasks satisfied | Change summary | Planned task batch satisfied; no managed final review or delivery implied |
| Local managed archive/completion succeeds | Feature summary | Reviewed, verified and archived on the integration branch; delivery remains separate |
| Completed delegated component receipt exported | Component summary | Component handoff ready; coordinator acceptance/delivery may be pending |
| Shared completion event recorded | Shared feature summary | Reviewed merged tuple with completion consent; archival can remain pending |

Repair integration contributes to the final feature summary. It does not create
a new user-visible task accomplishment. Successful prefixes of a partially
failed multi-task integration still receive their task summaries; the feature
is not marked complete. Resumed integration/archival and idempotent completion
retries repair missing summary output without repeating implementation work.

Core domain transitions return evidence identity. A post-transition service
collects/renders after releasing domain locks; direct library callers use the
same public integration/completion boundary, not only CLI wrappers. Dashboard
collection and status commands never generate or repair summaries.

## Storage, retries and visibility

Store local artifacts under the repository's existing runner state directory:

`summaries/<subject-key>/<source-digest>/`

Each snapshot has `evidence.json`, `basic.md`, optional `narrative.md`, and a small
status record. Narrative is additive and never overwrites the basic evidence.
Subject keys use validated IDs/digests, not unchecked names as filesystem paths.
Writes are atomic; concurrent writers cannot attach prose to another snapshot.

Separate status dimensions:

- Evidence/basic output: ready, incomplete, failed.
- Narrative: pending, ready, failed, or not applicable for an individual task.
- Freshness: current or superseded relative to the selected source snapshot.

Repeated commands reuse identical evidence; a new result gets a new snapshot.
An interruption cannot leave half-written Markdown selected as ready. Summary
errors are warnings with retry instructions, never rollback or failure of an
otherwise successful feature. If local output cannot be written, return the
subject/source identity and error in the command result for later regeneration.
Retain older summaries; ordinary task cleanup must not remove them.

Completion output includes a short basic synopsis, artifact paths, source ID and
summary/narrative status. JSON output adds an optional `summary` field without
changing the existing outcome contract. Dashboard details show summary status
and inspection/export commands, with no automatic writes or model calls.

Local runtime is not portable across clones. Provide explicit export of Markdown
and portable evidence, without logs, session IDs or absolute machine paths.
No auto-commit to implementation branches or immutable Store history. Shared
summaries can be rebuilt from committed Store evidence on another machine;
unavailable local task detail remains an acknowledged gap.

## Narrative skill

Add `openspec-runner-summarize` and install it through existing init behavior.
Update coordinate and component skills to invoke it automatically at their
appropriate terminal milestone. Shared coordination invokes it at shared
completion, not independently on every component acceptance.

The current coordinating agent reads the frozen evidence bundle and writes a
structured narrative through a bounded runner publishing command. It needs no
new worker terminal, model-role approval or implementation-worktree edits.
Unavailable agents leave the basic output usable and the narrative pending.

Narrative sections:

1. What problem this work addressed.
2. What people can now do, with a concrete supported before/after example.
3. What was implemented, grouped by capability with task-level references.
4. What was checked and what remains uncertain.
5. Delivery status, limitations and next steps.

Require evidence references for implementation, verification and delivery claims.
Clearly label expected benefits; never invent adoption, time saved or revenue.
Treat source text as data, not instructions. Validate submitted structure,
snapshot digest and evidence IDs; schema validation cannot prove every sentence
true, so retain the source references for human review. Edited narratives are
explicit revisions; regeneration must not silently discard user edits.

Proposed command surface (final spelling is left to implementation planning):

```text
openspec-runner summary CHANGE [--task ID] [--json]
openspec-runner summary CHANGE --refresh
openspec-runner summary CHANGE --export DIRECTORY
openspec-runner summary publish CHANGE --source DIGEST --file NARRATIVE.json
openspec-runner coordination summary FEATURE --store PATH --map FILE [--json]
```

Reading is observational. Refresh/export/publish are explicit writes; refresh
rebuilds evidence and basic output without launching a model. Publishing requires
an existing exact snapshot and rejects stale input. Shared subjects support the
same refresh/export/publish capabilities with explicit Store/map selection.

## Presentations by request

Add an `openspec-runner-present` workflow skill. A request identifies a summary
snapshot, audience and any supplied assets. Default proposal: a short deck of
five to seven slides, with an outline reviewed in the requesting conversation.
Support task/component summaries too; do not imply whole-feature delivery.

The workflow builds a portable presentation brief from the summary: problem,
resulting behavior, supported example, benefit, verification/limitations and
next steps. Optional screenshots and demos are user-provided or separately
requested; feature completion never starts a browser or captures them.

The first integration target is Frontend Slides:
https://github.com/zarazhangrui/frontend-slides

Its README describes standalone HTML presentations, a Claude Code plugin and
core skill use by other coding agents, plus optional PDF export. Integration is
a documented skill handoff, not a claimed stable programmatic renderer API.
The provider skill owns style discovery, rendering and visual verification.

Do not bundle or install it automatically. An installed provider is resolved
from explicit configuration/local skill paths; if missing, save the brief and
give setup instructions. Installation is a separate user request. Record the
provider version/commit where available and the summary source digest with the
deck. No network dependency in ordinary summaries or offline core tests.

HTML is the initial deck format; PDF is optional when the provider's export
requirements are available. Editable PPTX generation, hosted URLs and automatic
publication are outside the initial scope. Provider failure preserves the brief
and summary. Presentations live in a user-selected output directory and never
participate in completion gates or approved archive artifacts.

## Verification and implementation boundaries

Introduce focused modules for evidence collection, summary storage/rendering and
CLI operations. Reuse existing domain authority/readers; keep process handling
in adapters and skills rather than adding shell calls to coordination logic.

Behavior-focused tests must cover:

- Successful task, unmanaged, managed, delegated and shared milestone triggers.
- Failed/superseded attempts, repair contributions and partial integration.
- Committed archived artifacts, unavailable source history and evidence gaps.
- Exact result/tuple attribution and local-versus-delivered wording.
- Interrupted/idempotent retries, concurrent writers and storage failures that
  leave the original implementation outcome unchanged.
- Stale narrative rejection, valid evidence references and preserved edits.
- Observational CLI/status/dashboard reads and portable export path handling.
- Init skill installation for each harness, updated workflow instructions, and
  presentation brief/provider-missing behavior without external installations.

Run build, full tests, affected JSON/dry-run commands and package dry run before
implementation completion. The current checkout has an unresolved local missing
`string-width` dependency and a pnpm invocation that previously stalled; resolve
the verification environment before claiming a passing implementation suite.

Leave formatting details, internal interfaces and exact command spelling to the
implementation plan. Initial delivery includes the core summaries, automatic
agent enrichment workflow, dashboard inspection, export, and requested skill
handoff; it does not require building a generic plugin execution framework.
