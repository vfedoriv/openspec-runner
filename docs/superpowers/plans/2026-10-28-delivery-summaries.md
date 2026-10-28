# Delivery Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Automatically save evidence-backed task and feature summaries, enrich feature narratives in coordinating-agent workflows, and offer presentations on request.

**Architecture:** Read immutable lifecycle evidence into a versioned bundle; render/store a basic summary after successful domain transitions without affecting their outcome. Separate narrative publishing, observational inspection, portable export and requested presentation handoff from implementation authority.

**Tech Stack:** Existing strict TypeScript ESM, Node >=22.13, pnpm, node:test; existing dashboard Ink UI. No new production dependencies.

**Spec:** [Approved design](../specs/2026-10-28-delivery-summaries-design.md). Read both documents before execution.

## Completion record

Implemented on 2026-10-28 using native execution. Final Linux `pnpm test`:
340 tests, 338 passed, zero failures, two existing optional skips (81.778 seconds).
Package dry run passed and includes both new skills. Both new skills passed the skill-creator structural validator. CLI integration
tests exercise JSON inspection/export/publication and requested presentation
briefs. External Frontend Slides rendering was not exercised or installed.

The independent whole-change review's important findings were fixed with
regressions: reconciled task attribution, failure identity/warnings, publication
freshness, shared archival provenance, retained intent/work/review evidence,
missing history, portable briefs with selected narratives, and exact receipt
selection. Concurrency/interruption, independent clone reconstruction and renewed
authority checks also pass. Narrative publication now accepts a current-source
resolver, checked inside the summary lock before selecting prose.

Execution decisions: reuse the existing checkout; group the remaining integrated
implementation into one commit after final verification. Export writes a final
provenance file after artifact writes; interruption may leave an incomplete new
directory, documented with new-directory retry instructions. Unreadable JSON in
an unidentified receipt file remains a recoverable collection failure rather than
being silently ignored. No external publication or live presentation-provider
execution was performed.

## Global Constraints

- Summaries appear automatically; presentations are created only on request.
- Direct CLI guarantees basic output; current coordinating agents enrich feature narratives automatically. Never silently start model sessions.
- Preserve existing worker Report, execution-state, feature-state, approval, receipt and Store record formats.
- Never turn a successful integration/completion into a failure because summary writing failed.
- Run collection/rendering outside domain locks; use separate short summary write locks.
- Status/dashboard/summary reads are observational: no writes, migrations, checks, recovery, fetching or model calls.
- Use exact committed active/archived artifacts; unknown evidence remains unknown.
- Do not imply deployed/merged delivery from local integration or archival.
- Store under the existing runner state directory; do not commit generated summaries to approved feature/archive trees or immutable Store history.
- Preserve native Windows runner policy; use supported Unix/WSL execution for lifecycle fixtures.
- No auto-installation, publication, screenshots, hidden external services or generic plugin executor.
- Resolve the known missing `string-width` dependency and stalled pnpm invocation before claiming a passing implementation suite; do not change dependencies just to mask the local environment.

## Review Focus

1. First task integrates but a later task fails: persist the successful task summary while preserving the original exception and unfinished feature (Task 4).
2. Archived planning paths and cleaned worktrees: reconstruct from recorded Git objects without current-checkout substitution (Tasks 1/2).
3. Another operation advances authority while prose is being written: reject stale publication; inspection must select the current source (Tasks 3/5).
4. Concurrent or interrupted output and user edits: no partial ready artifact, duplicate completion or silently overwritten prose (Task 3).
5. Independent clone lacks local runtime: rebuild shared evidence from Store records, label missing local details, never claim absent verification (Tasks 2/5).

## File map and ownership

| Files | Responsibility / task |
|---|---|
| `src/summary-types.ts`, `src/summary-evidence.ts` | Contracts, canonical identity, local committed evidence (1) |
| `src/summary-shared.ts` | Shared Store and delegated receipt evidence (2) |
| `src/summary-store.ts`, `src/summary-render.ts` | Atomic artifacts, narrative validation, portable output (3) |
| `src/summary-service.ts` | Safe post-transition generation and current source selection (4) |
| `src/runner.ts`, `src/feature.ts`, `src/component.ts`, `src/coordination.ts` | Narrow domain hooks (4) |
| `src/summary-cli.ts`, `src/cli.ts`, `src/linked-cli.ts` | Commands, init, completion presentation (5/7) |
| `src/dashboard-types.ts`, `src/dashboard-reader.ts`, `src/dashboard-coordination.ts`, `src/dashboard-view.ts`, `src/dashboard-actions.ts` | Observational summary visibility (6) |
| `src/presentation-brief.ts` | Portable slide brief and explicit provider reference validation (7) |
| `skills/openspec-runner-{summarize,present}/SKILL.md` | Narrative and requested presentation workflows (7) |
| Existing coordinate/component skills, README and user/team/dashboard guides | Automatic follow-up and usage documentation (7) |
| `test/summary-{evidence,shared,store,lifecycle,cli,dashboard}.test.mjs`, `test/presentation-brief.test.mjs` | Behavior verification owned by corresponding tasks |

Keep new files focused. Existing helpers in `test/helpers/feature-fixture.mjs` and
`coordination-fixture.mjs` supply temporary repositories and fake tools. Extend
helpers only for behavior shared by multiple tests; do not duplicate whole
lifecycle fixtures. No generated `dist` edits.

## Shared interface decisions

Define these in Task 1 and use the names consistently in later tasks:

```ts
type SummarySubject =
  | { kind: "task"; change: string; task: string }
  | { kind: "change" | "feature"; change: string }
  | { kind: "component"; featureId: string; change: string; assignmentId: string }
  | { kind: "shared-feature"; featureId: string };
type SummaryRequest =
  | { cwd: string; change: string; task?: string }
  | { cwd: string; featureId: string; store: string; map: string };
type SummaryLifecycle = "task-integrated" | "batch-satisfied" |
  "feature-completed" | "component-handoff" | "shared-completed";
type SummaryReference = {
  id: string; repository: string; commit?: string;
  path?: string; recordId?: string;
};
type SummaryFact = {
  id: string;
  category: "intent" | "work" | "repair" | "verification" | "review" | "limitation" | "delivery";
  authority: "planning" | "worker-report" | "runner-record" | "store-record";
  text: string; references: string[];
};
interface SummaryEvidence {
  version: 1; subject: SummarySubject; lifecycle: SummaryLifecycle;
  source: {
    repository: string; fingerprint?: string; base?: string; result: string;
    archive?: string; storeRevision?: string; completionEventId?: string;
    approvalId?: string; tuple?: Record<string, string>;
  };
  facts: SummaryFact[]; references: SummaryReference[]; gaps: string[];
}
interface SummaryBundle {
  version: 1; generatorVersion: 1; digest: string;
  collectedAt: string; evidence: SummaryEvidence;
}
interface SummaryNarrative {
  version: 1; sourceDigest: string; sections: {
    problem: NarrativeClaim[]; behavior: NarrativeClaim[];
    implementation: NarrativeClaim[]; verification: NarrativeClaim[];
    limitations: NarrativeClaim[]; delivery: NarrativeClaim[];
  };
}
type NarrativeClaim = { text: string; evidenceIds: string[]; expectedBenefit?: boolean };
interface SummaryHandle {
  subjectKey: string; sourceDigest: string;
  basic: "ready" | "incomplete" | "failed";
  narrative: "pending" | "ready" | "failed" | "not-applicable";
  freshness: "current" | "superseded";
  synopsis: string; paths?: { evidence: string; basic: string; narrative?: string };
  warning?: string;
}
```

`source.repository` is a logical repository identity, not its absolute location.
For ordinary repositories without a configured logical ID, use a local identity
derived from Git common-directory identity, stored only in local metadata; the
portable evidence uses a stable display alias such as `implementation` instead.
Source revisions distinguish independent histories. Hash canonical evidence plus
generatorVersion; exclude collectedAt and all local locations. Validate every
ID/path at boundaries, sort references/facts/tuple keys for hashing, and use
SHA-256 subject keys. Shared storage belongs to the Store repository's runner
state directory; delegated storage belongs to the implementation repository.

### Task 1: Local committed evidence and basic-summary contracts

**Files:** Create `src/summary-types.ts`, `src/summary-evidence.ts`, `test/summary-evidence.test.mjs`.

**Interfaces:** Consume `Runner.read`, `readFeature`, Git committed-blob helpers
and existing plan fingerprint rules. Produce
`collectLocalSummary(request: Extract<SummaryRequest, { change: string }>): SummaryBundle`,
`summaryDigest(evidence: SummaryEvidence): string`,
`summarySubjectKey(subject: SummarySubject): string`.

- [x] Write tests named `local evidence includes only integrated work`, `archived evidence survives cleaned worktrees`, `collection ignores checkout drift and never executes checks`, and `digest ignores collection time and local locations`. Build managed/unmanaged fixtures; assert failed/superseded reports are not work facts, repair facts remain separate, missing proposal/check logs yield gaps, result/plan revisions remain frozen after checkout edits, and before/after runtime bytes/refs match.
- [x] Assert task identity against the integration commit marker `openspec-runner:<attempt>` on the recorded integration head's first-parent history, verifying report-commit ancestry. Missing marker/history yields incomplete evidence, never substituted current HEAD. Test multiple task commits and repeated collection produce equal digests.

Task-1 assertion examples (using the collected fixture bundle):
```js
assert.equal(bundle.evidence.lifecycle, "task-integrated");
assert.equal(bundle.evidence.source.result, integrationCommit);
assert.equal(summaryDigest(bundle.evidence), recollected.digest);
```
- [x] Run `pnpm run build` and `node --test test/summary-evidence.test.mjs`; observe missing module/behavior failure before implementation. Fix test setup failures before treating a result as RED.
- [x] Implement the three interfaces. Determine active versus archived committed plan paths from recorded state; preserve reference IDs and authority classes. Historical task selection targets the integrated attempt, not an unrelated later retry. Individual tasks use their integration commit; final feature source includes post-archive revision. No passing-check inference from a command list alone.
- [x] Run build and the focused test; expect all assertions to pass. Commit only these files with subject `Collect committed delivery summary evidence`.

### Task 2: Shared and delegated summary evidence

**Files:** Create `src/summary-shared.ts`, `test/summary-shared.test.mjs`. Modify `src/summary-evidence.ts` only for delegated source dispatch.

**Interfaces:** Consume Task 1 types/digest and existing immutable record replay,
submission records and approved component mappings. Produce
`collectSharedSummary(request: Extract<SummaryRequest, { featureId: string }>): SummaryBundle`
and `collectComponentSummary(options: { cwd: string; change: string; submissionId?: string }): SummaryBundle`.

- [x] Write tests `shared summary binds completed merged tuple`, `shared clone without runtime retains portable evidence and gaps`, `component handoff never means shared completion`, and `revoked or conflicting authority cannot select a current summary`. Assert exact completion/approval/review IDs and tuple; absent source commits are explicit gaps; stale/revoked historical records remain inspectable but not current; no network, checks, Store commits or runtime writes occur.

Task-2 assertion examples:
```js
assert.equal(shared.evidence.lifecycle, "shared-completed");
assert.deepEqual(shared.evidence.source.tuple, completedTuple);
assert.equal(component.evidence.lifecycle, "component-handoff");
```
- [x] Run build plus `node --test test/summary-shared.test.mjs`; observe expected RED.
- [x] Implement authoritative Store history selection using existing coordination rules and map validation. Derive shared current snapshot from the completion event, not arbitrary checkout HEAD; record that event's committed revision. A later archive event can supply updated archival facts through a new evidence digest without changing the delivery tuple. Component sources use persisted exact receipt identity/bytes and available local evidence. Reject incomplete lifecycle subjects rather than invent completion.
- [x] Run build and both evidence tests; expect PASS. Commit `Collect shared and delegated summary evidence`.

### Task 3: Atomic storage, narrative publishing and portable export

**Files:** Create `src/summary-store.ts`, `src/summary-render.ts`, `test/summary-store.test.mjs`.

**Interfaces:** Consume bundles/narratives from Tasks 1/2. Produce
`renderBasicSummary(bundle: SummaryBundle): string`,
`saveSummary(options: { stateDir: string; bundle: SummaryBundle }): SummaryHandle`,
`readSummary(options: { stateDir: string; subject: SummarySubject; sourceDigest: string }): SummaryHandle | undefined`,
`publishNarrative(options: { stateDir: string; bundle: SummaryBundle; narrative: SummaryNarrative; expectedRevision?: string }): SummaryHandle`,
`exportSummary(options: { stateDir: string; bundle: SummaryBundle; directory: string }): { directory: string; files: string[] }`.

- [x] Write tests `interrupted summary never becomes ready`, `concurrent identical saves converge`, `narrative rejects unknown evidence and wrong digest`, `edited narrative requires explicit revision`, `export contains portable evidence without runtime identities`, and `unsafe or occupied output paths are rejected`. Use real temporary directories and competing child writers, plus injected filesystem failures where necessary. Assert no partial status/pointer, no traversal/symlink overwrite, unchanged old narrative and no leaked absolute roots/session IDs/logs in export.

Task-3 assertion examples:
```js
assert.throws(() => publishNarrative({ stateDir, bundle,
  narrative: { ...validNarrative, sourceDigest: "wrong" } }));
assert.equal(readFileSync(previousNarrativePath, "utf8"), previousNarrative);
assert.equal(exportedText.includes(stateDir), false);
```
- [x] Run build plus `node --test test/summary-store.test.mjs`; observe expected RED.
- [x] Implement immutable evidence/basic files under `summaries/<subject-key>/<digest>/`. Use atomic staging and a short per-subject write lock outside runner locks; contention is retryable, never silently remove another owner's lock. Publish readiness last; readers verify referenced files and schema. Store narrative revisions by content hash, with a compare-and-swap selected revision; require expectedRevision for replacement. Detect out-of-band file edits via stored hashes and preserve them as conflicts, not overwrite targets.
- [x] Render concise five-part Markdown from facts, retaining authority labels, gaps and lifecycle wording. Validate narrative size (max 1 MiB), all required section arrays, nonempty claim text and existing fact IDs; implementation/verification/delivery claims require references. Empty unsupported sections render as evidence gaps. Use no model calls.
- [x] Export to a new directory only, with sanitized evidence, basic Markdown, selected narrative when valid, and provenance manifest; fail on existing destination to preserve user edits. Normalize known local path aliases in human-provided strings using existing portable-evidence conventions and exclude local metadata fields. Document that arbitrary free text still needs human review before external sharing; do not claim general secret detection.
- [x] Run build and summary-store tests; expect PASS. Commit `Store and export revision-bound summaries`.

### Task 4: Automatic nonblocking lifecycle hooks

**Files:** Create `src/summary-service.ts`, `test/summary-lifecycle.test.mjs`. Modify `src/runner.ts`, `src/feature.ts`, `src/component.ts`, `src/coordination.ts`.

**Interfaces:** Consume collectors and save/read functions. Produce
`resolveSummary(request: SummaryRequest): { stateDir: string; bundle: SummaryBundle }`,
`ensureSummary(request: SummaryRequest): SummaryHandle`,
`safeSummary(request: SummaryRequest): SummaryHandle`,
`readCurrentSummary(request: SummaryRequest): SummaryHandle | undefined`.
The safe wrapper catches collection/storage errors and returns failed status;
current selection derives authority through read-only collectors, not a stale pointer.

- [x] Write tests `task summaries survive later integration failure`, `completed archive retry repairs missing summary without rerunning checks`, `summary failure preserves successful domain outcome`, `library completion invokes summary outside runner lock`, and `unmanaged delegated and shared milestones use distinct subjects`. Assert no summary on abort or blocked/failed export, no extra checks/workers, identical repeated evidence, and no changes to canonical approved artifact trees.

Task-4 assertion examples (after arranging a completed managed fixture):
```js
const result = feature.archive("demo");
assert.equal(result.completed, true);
assert.equal(feature.read("demo").phase, "completed");
assert.equal(result.summary.basic, "failed"); // injected summary-only disk failure
```
- [x] Run build plus `node --test test/summary-lifecycle.test.mjs`; observe expected RED.
- [x] Wrap public integration/completion boundaries around their existing locked bodies. Capture integrated-attempt delta in try/finally and generate task artifacts after releasing locks, including before rethrowing the original later-task failure. Generate unmanaged change summaries only when all tasks are satisfied. Preserve original error objects/exit semantics; warnings must not mask them.
- [x] Add hooks to local Feature.archive success/idempotent return, completed Component.exportSubmission and Coordination.complete success/idempotent replay. Keep receipt `bytes` and Store record payloads unchanged. Add optional `summary` metadata to return wrappers only; preserve the existing coordination return contract with an additive field rather than replacing it. For partial integrations that throw, artifacts remain discoverable through summary inspection.
- [x] Account for cleanup early returns in Runner.integrate; task summary generation cannot be skipped when cleanup is manual or reports a warning. Completed local features select archive evidence; shared summaries track later archive delivery through explicit refresh, never dashboard writes. Do not mutate feature or worker persisted schemas.
- [x] Run build, all summary tests, and affected runner/feature/component/coordination tests; expect PASS. Commit `Generate summaries after lifecycle milestones`.

### Task 5: Summary commands and completion output

**Files:** Create `src/summary-cli.ts`, `test/summary-cli.test.mjs`. Modify `src/cli.ts`, `src/linked-cli.ts`.

**Interfaces:** Consume Task 4 request/service and Task 3 publisher/exporter.
Produce `summaryCommand(options: { cwd: string; args: string[] }): void` and
`formatSummaryResult(handle: SummaryHandle): string`.

- [x] Write subprocess tests for local/task/shared read, `--json`, refresh, export and publish, archived subjects, stale publication, malformed option combinations, missing artifacts and offline CLI operation. Assert reads leave filesystem/refs identical; refresh never starts a worker; JSON preserves existing completion fields and includes a synopsis/path/status; invalid input emits existing CLI-shaped errors.

Task-5 assertion examples (capture filesystem/ref digests around a read):
```js
assert.equal(response.summary.sourceDigest, bundle.digest);
assert.deepEqual(afterRead, beforeRead);
assert.equal(missing.available, false);
```
- [x] Run build plus `node --test test/summary-cli.test.mjs`; observe expected RED.
- [x] Implement exact surface: `summary CHANGE [--task ID] [--json]`, `summary CHANGE --refresh`, `summary CHANGE --export DIRECTORY`, `summary publish CHANGE --source DIGEST --file FILE [--expected-revision HASH]`. Shared equivalents use `coordination summary FEATURE --store PATH --map FILE` with the same flags, plus `--publish` instead of a second positional action. `--json` is allowed for every mode; read/refresh/export/publish are mutually exclusive, task filter may accompany any local mode, shared mode rejects task selection.
- [x] Recompute current authority before publish; hold only a short summary write lock for compare-and-swap and recheck source before selecting the narrative. Reject stale input even if its old snapshot still exists. No approval/completion tokens are consumed. Enforce 1 MiB file cap before JSON decoding and validate source/schema before writing.
- [x] Default read prints selected valid narrative or basic Markdown. Missing artifacts return `available: false` with source identity and refresh instruction in JSON (success when evidence is available), and a concise equivalent in plain output; invalid/missing lifecycle evidence remains an error. Completion plain output adds synopsis/path and any warning. No generation from reads; explicit refresh creates basic output.
- [x] Run build, summary-cli and existing coordination-cli/CLI regressions; exercise `--json` in disposable fixtures and verify no malformed stdout. Commit `Expose summary inspection publishing and export`.

### Task 6: Observational dashboard summary details

**Files:** Create `test/summary-dashboard.test.mjs`. Modify `src/dashboard-types.ts`, `src/dashboard-reader.ts`, `src/dashboard-coordination.ts`, `src/dashboard-view.ts`, `src/dashboard-actions.ts` (touch UI/layout only if existing detail projection requires it).

**Interfaces:** Consume `readCurrentSummary`; add optional `deliverySummary?: SummaryHandle` to existing feature/task/assignment projections without renaming existing `FeatureSummary`/`TaskSummary`.

- [x] Write tests `dashboard displays current summary and pending narrative`, `corrupt or missing summary cannot hide feature data`, and `summary refresh and export are display-only actions`. Assert selected source identity, visible limitations/warnings, bounded synopsis, and byte-identical runtime/refs before/after collection and inspection. A missing generated summary is not a feature execution failure.

Task-6 assertion examples:
```js
assert.equal(snapshot.features[0].deliverySummary.narrative, "pending");
assert.deepEqual(afterCollection, beforeCollection);
assert.equal(snapshot.features[0].completed, originalCompletedCount);
```
- [x] Run build plus `node --test test/summary-dashboard.test.mjs`; observe expected RED.
- [x] Project optional metadata into detail views, with basic/narrative status and source revision. Show inspect/refresh/export command recipes; do not add them to the executable preview allowlist. Isolate per-summary read errors, preserve existing feature counts and completion labels, and retain last successful stale data through existing collector behavior. Avoid attaching full bundle/prose to every two-second snapshot; paths and bounded synopsis suffice.
- [x] Run build, summary-dashboard and dashboard reader/coordination/actions/UI/layout tests; expect PASS. Commit `Show delivery summaries in dashboard details`.

### Task 7: Automatic narrative skills and requested presentation handoff

**Files:** Create `src/presentation-brief.ts`, `test/presentation-brief.test.mjs`, `skills/openspec-runner-summarize/SKILL.md`, `skills/openspec-runner-present/SKILL.md`. Modify `src/cli.ts`, `src/summary-cli.ts`, existing coordinate/component skills, `README.md`, `docs/README.md`, `docs/user-guide.md`, `docs/team-workflow.md`, `docs/team-workflow-reference.md`, `docs/dashboard-guide.md` and init/CLI tests.

**Interfaces:** Produce
`createPresentationBrief(options: { bundle: SummaryBundle; narrative?: SummaryNarrative; audience: string; assets?: string[] }): { markdown: string; sourceDigest: string }`
and `readPresentationProvider(options: { file: string }): { skillPath: string; version?: string }`.
Provider config is explicit local JSON `{ "skillPath": ".../SKILL.md", "version": "optional" }`;
resolve relative paths from config directory, require a regular readable skill
file and referenced support files to remain provider-owned. No implicit installs
or global discovery. This config is read only on requested presentation work.

- [x] Read skill-creation instructions applicable at execution before authoring the two new skills. Write tests `presentation brief preserves source and delivery limitations`, `missing provider still exports usable brief`, `requested provider path never launches a process`, and init coverage for both skills with Codex/Claude/all. Assert default five-to-seven-slide outline, evidence gaps, expected-benefit labels, caller-supplied assets, and no provider reads during integration/completion.

Task-7 assertion examples:
```js
const brief = createPresentationBrief({ bundle, audience: "Product stakeholders" });
assert.equal(brief.sourceDigest, bundle.digest);
assert.match(brief.markdown, /Limitations/);
assert.equal(providerProcessCalls.length, 0);
```
- [x] Run build and focused tests; observe expected RED before implementation.
- [x] Implement pure brief generation and add explicit `summary CHANGE --presentation-brief DIRECTORY --audience TEXT [--provider-config FILE] [--assets FILE]` with shared equivalents. Directory is new-only; assets FILE is a JSON array of user-selected paths, recorded as references without automatic copying/browser capture. This mode is mutually exclusive with publish/refresh/export and requires an existing summary. Missing provider yields a saved brief plus setup instructions, not an attempted installation or failed feature.
- [x] Write summarize workflow: after agent-led managed/shared completion or component handoff, inspect exact evidence, write five-part narrative JSON, publish against digest, then show synopsis and paths. For unmanaged all-tasks completion, do the same with batch wording. No extra agent turns for individual tasks. On failure report pending/basic output and retry command; do not repeat implementation/archive. Existing successful idempotent commands may repair basic artifacts first.
- [x] Write present workflow: activate only on a user presentation request; select summary/audience/assets, save portable brief, review outline in that conversation, read the configured provider skill and referenced resources, then hand it the exact brief. Frontend Slides is documented as the first provider target, not bundled or a guaranteed API. Preserve summary digest/provider provenance alongside output. HTML initial output, PDF only when available; no default PPTX, hosting, installing or publication. Verify rendered slides using the provider workflow before delivering them.
- [x] Update init's installed skill list and existing coordination/component terminal instructions. Document direct-CLI basic versus automatic agent narrative, task/feature/component/shared wording, storage/retention, export, regeneration/edit conflicts, presentation configuration and offline behavior. Add summary and presentation-brief examples to guides without disturbing current CLI examples.
- [x] Run `pnpm test`, affected fixture CLI commands with `--json`, and `pnpm pack --dry-run`; expect exit 0 and both skills in package. Manually inspect one managed-feature summary and a presentation brief with fake provider metadata; external provider execution/authentication is optional and recorded separately. Commit `Add narrative and requested presentation workflows`.

## Verification environment and execution gates

Before Task 1 implementation, inspect current dependency/runtime installation,
existing worktree attachments and supported WSL/Linux tooling. Reuse a suitable
checkout unless isolation is needed. Resolve the pnpm wrapper hang/missing
dependency through the normal locked installation in the supported environment;
do not reuse deleted machine-specific environment reports or claim their old
paths remain valid. Record baseline test result. Fix unrelated baseline issues
only as separately scoped work when necessary; do not hide them in this feature.

For each task, run the named tests against compiled output, observe a meaningful
RED, implement, then confirm GREEN before committing. Tests use real temporary
Git repositories and fake tools. Do not add tests that only mirror prose or
private implementation details; assert observable CLI, artifact and state behavior.

Before final completion run full tests, build/package checks, CLI examples and a
whole-change review. Confirm approved source trees, receipt bytes, existing state
versions and completion semantics remain unchanged by summaries. Do not publish
or merge automatically. The plan's commits describe coherent task boundaries;
follow the user's selected execution/review method.

## Coverage and self-review

| Design requirement | Tasks |
|---|---|
| Frozen local/archived evidence, task/repair distinctions and gaps | 1 |
| Shared authority, component handoff and independent-clone reconstruction | 2 |
| Atomic durable output, edits/retries/concurrency and portable export | 3 |
| Automatic domain/library triggers, partial success and nonblocking failures | 4 |
| Read/refresh/publish/export, source freshness and completion visibility | 5 |
| Observational dashboard projections and commands | 6 |
| Automatic agent narrative, installed skills, requested provider/brief and docs | 7 |

Self-review: all design sections have owners; all five Review Focus conditions
have named behavior tests; later tasks consume the exact earlier interface
names. Narrative/provider work remains separate from domain execution authority.
Final verification is recorded above; historical steps describe the executed plan.
