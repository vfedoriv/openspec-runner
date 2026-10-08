# Console Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. The supervisor owns delegation, the ledger and review; it does not implement source.

**Goal:** Build an observational dashboard with readable worker activity and explicitly selected guided actions.

**Architecture:** Share a versioned snapshot reader between CLI output and a lazy-loaded Ink interface. Isolate synchronous collection in a child process, reuse existing domain authority, and keep activity capture independent of lifecycle evidence.

**Tech Stack:** TypeScript ESM, Node >=22.13, pnpm, Ink/React TSX, node:test.

**Spec:** [Approved design](console-dashboard-design.md), preserved verbatim. Read both documents.

## Global Constraints

- Preserve existing CLI/platform behavior, execution state versions 1/2, feature state version 1, report/settings types, identity, approval and integration gates.
- Follow existing platform support—including WSL on Windows. Native Windows is not newly supported for runner execution.
- Refresh every two seconds using one asynchronous collector process at a time.
- Retain the latest 1,000 entries per selected session in memory and read older entries in bounded pages.
- Reading never acquires runner locks, migrates, recovers, writes state, runs verification checks, fetches or pulls. Activity is not lifecycle authority.
- Workflow mutations are displayed commands only. Audited dry-run execution requires explicit selection. Launch/retry requires exact tasks; unmanaged inherited settings require explicit model and any required effort. Core approval/archive previews execute validation or configured checks, so dashboard exposes them as display-only commands with a concrete unavailable-preview reason.
- Focus existing saved terminals only. Never create or resume sessions, including when attachment returns a command.
- Sidecar failures must not change worker success, ownership, report acceptance or integration eligibility.
- Keep Node >=22.13. Pin compatible Ink/React versions; TSX uses react-jsx and src/**/*.tsx inclusion. Snapshot paths never import UI dependencies.
- User authorized runtime/UI dependencies, Linux Git upgrade and an isolated worktree. Current checkout: C:/Users/vital/.codex/worktrees/console-dashboard/openspec-runner, branch codex/console-dashboard. Actual verification uses WSL Ubuntu22.04 Node22.23.3/pnpm11.7.0: source /home/vfedoriv/.local/share/openspec-runner-runtime/env.sh; cd /mnt/c/Users/vital/.codex/worktrees/console-dashboard/openspec-runner. Confirm Linux Git >=2.36 for existing worktree -z test fixtures; this is verification preflight, not a new production compatibility requirement. Native Git handles commits; do not globally export GIT_DIR/GIT_WORK_TREE.
- Linux Git 2.55 is now available; the previously failing worktree fixture passes. Consult console-dashboard-environment-report.md and record the full baseline result; full-suite and implementation tests are not claimed passing by this document.
- No multi-repository worker monitoring, messaging/stopping agents, cost accounting, notifications, background service or direct workflow execution.

## Review Focus

1. Linked worktree/map aliases: preserve current-worktree display, associate via validated repository identity and common Git directory (Tasks 1/2).
2. Handoff checkout, missing authoritative branch or conflicting manifests: inspect declared local branch history or show per-feature errors, never assume HEAD is authority (Task 2).
3. Truncated/replaced logs, Unicode and oversized/control-filled records: bounded sanitized pages without invented legacy timestamps (Task 3).
4. Sidecar disk failure and stderr resembling structured stdout: original supervision/Claude identity behavior stays intact (Task 4).
5. Refresh, previews and exit races: keys remain responsive, selection survives, children cancel and terminal state restores without workflow mutations (Tasks 1/5/6).

## Execution and ownership

Four phases, seven sequential reviewable tasks. Supervisor records owner/model, base, files, RED/GREEN evidence and reviewer verdict in a ledger. Tasks do not overlap; fixes outside assigned files require supervisor coordination. Tasks 1/2/4/5/6/7 use gpt-6.1-sol low; tightly specified Task 3 uses gpt-6-luna xhigh. Fresh reviewers use gpt-6.1-sol low. Four slots total; implementation and review proceed sequentially.

Every task: write named failing tests; run pnpm run build then node --test test/<owned>.test.mjs and observe the expected assertion/import failure; implement; rerun targeted tests to PASS. Before each task commit run pnpm test once through the supported Linux runtime. The supervisor then dispatches a fresh reviewer against the committed diff and resolves findings before advancing. Tests import compiled dist; use temporary repositories/fake tools and existing helpers. Do not hand-edit dist or publish/merge automatically.

## Phase 1 — Snapshot and authority

### Task 1: Local snapshot, collector and CLI

**Files:** Create src/dashboard-types.ts, src/dashboard-reader.ts, src/dashboard-collector.ts, src/dashboard-client.ts, src/dashboard-cli.ts, test/dashboard-reader.test.mjs, test/dashboard-cli.test.mjs. Modify src/cli.ts for separate dashboard dispatch.

**Produces (dashboard-types.ts):**

```ts
type DashboardOptions = { cwd: string; change?: string; store?: string; map?: string };
type SourceError = { source: string; message: string; stale: boolean };
type AttentionItem = { id: string; source: string; targetId?: string; priority: number; message: string };
type FeatureSummary = {
  id: string; change?: string; origin: "local" | "shared"; phase?: FeatureState["phase"];
  completed: number; total: number; state?: FeatureState; taskIds: string[]; sessionIds: string[];
  coordination?: CoordinationStatus;
};
type TaskSummary = {
  id: string; featureId: string; task: Task; assignment?: Assignment;
  ready: boolean; reasons: string[]; attempts: TaskAttempt[]; harness?: string;
};
type SessionSummary = {
  id: string; featureId: string; taskId?: string; role: "implementation" | "review" | "repair";
  attempt: TaskAttempt | FeatureJob; phase: TaskAttempt["phase"]; reportOutcome?: Report["outcome"];
  process: "running" | "exited" | "unknown"; terminal: "available" | "unavailable" | "unknown";
  log?: string; activityPath?: string; worktreeAvailable?: boolean;
};
type AssignmentSummary = {
  id: string; featureId: string; componentId: string; repository: string; change: string; owner: string;
  importedRevision?: string; inspectedRevision?: string; binding?: ComponentBinding;
  status?: ComponentStatus; stale: boolean;
};
type DashboardSnapshot = {
  version: 1; collectedAt: string;
  repository: { root: string; common: string; stateDir: string; identity?: string; currentWorktree: string; maxParallel?: number };
  features: FeatureSummary[]; tasks: TaskSummary[]; sessions: SessionSummary[];
  assignments: AssignmentSummary[]; attention: AttentionItem[]; errors: SourceError[];
  sources: Record<string, { collectedAt: string; stale: boolean }>;
};
```

Import existing types from plan.ts, runner.ts, feature-state.ts, component-state.ts and coordination-state.ts, without redefining persisted contracts. IDs: local:<change>, <featureId>:task:<taskId>, <featureId>:attempt:<attemptId>, shared:<featureId>, <sharedFeatureId>:assignment:<assignmentId>. Each collector has exactly one explicit Store with fixed inputs; IDs are unique and stable within its snapshot, without a separate Store identity probe. Source keys identify individual changes/shared features. Offline imported assignments use local:<change>:assignment:<assignmentId> until reconciled with explicit shared authority.

**Consumes:** repository(cwd), decodeState(raw), readFeature(stateDir,change), readComponentBinding({stateDir,change}), Runner.status(change), existing report/settings/process evidence. Audit helpers for side effects; never use verification executors/recovery. **Produces:** collectDashboard(options: DashboardOptions): DashboardSnapshot; dashboardCommand(args: string[]): Promise<void>; formatDashboard(snapshot: DashboardSnapshot): string; startDashboardCollector(options: DashboardOptions, receive: (snapshot: DashboardSnapshot) => void, fail: (message: string) => void): { refresh(): void; close(): Promise<void> }.

Collector IPC request {version:1,id:string,options:DashboardOptions}, response {version:1,id:string,snapshot?:DashboardSnapshot,error?:string}. One child/in-flight request, coalesced refresh, two-second polling, ten-second timeout/restart, max 8 MiB response, generation IDs reject late replies. Parent retains successful per-source data when that source fails and marks it stale. Child close cancels timers/process promptly. UI will dynamically import runDashboardUi(options: DashboardOptions): Promise<void>; introduce that import only in Task 6 so this task builds independently.

- [x] RED: "reader discovers prelaunch and retained features": union openspec/changes, stateDir/*.json excluding lock/auxiliary files, features/*.json and components/*.json; managed/unmanaged, missing archived artifacts and multiple attempts retained.
- [x] RED: "reader isolates malformed sources and state versions": valid siblings survive, v1/v2 decode without migration; before/after files/runtime bytes/refs unchanged.
- [x] RED: "reader explains existing gates": dependencies, drift, transaction, missing report, pending approvals, blocking versus advisory findings, repair limits and archive/integration evidence; counts without percentages.
- [x] RED: "reader separates phase report process and terminal": PID reuse/unsupported observation yields unknown, log silence never means exited, harness turn never means completed. Linked worktree root/common/state identity correct.
- [x] RED: "dashboard emits once json and plain without ui": --once, --json, --change, paired --store/--map syntax, non-TTY fallback, unknown flags fail; existing CLI behavior unaffected.
- [x] RED: "collector slow failure refresh and close stay responsive": fake blocked child/clock, one in flight, stale retained data, late response ignored, exit cancels.
- [x] GREEN: Implement reader and asynchronous client. Preserve detailed reused reports/settings/attempts; source-local errors. Separate dashboard argument parsing from existing commands/platform guards; preserve platform policy.
- [x] CHECK: targeted dashboard-reader/dashboard-cli, pnpm test, CLI --once/--json; fresh review and commit gate. Phase gate: local snapshot contract and observational audit accepted.

### Task 2: Coordination discovery and associations

**Files:** Create src/dashboard-coordination.ts, test/dashboard-coordination.test.mjs. Modify src/dashboard-reader.ts. Task 2 also owns narrowly necessary shared-source retention changes in src/dashboard-client.ts and test/dashboard-cli.test.mjs. If needed, extract unchanged machineMap from src/linked-cli.ts into src/repository-map.ts for shared validation; no incidental refactoring.

**Consumes:** DashboardOptions/DashboardSnapshot/FeatureSummary/AssignmentSummary from Task 1 and collectDashboard(options: DashboardOptions): DashboardSnapshot. **Produces:** collectCoordination(options: DashboardOptions, local: DashboardSnapshot): Pick<DashboardSnapshot,"features"|"tasks"|"assignments"|"attention"|"errors"|"sources"> (arrays include local items; reader replaces these fields without mutating the input snapshot). Known imported-authority blockers produce copied local task rows with ready=false, specific reasons and local attention targets; historical assignments never inherit another assignment's milestones. readMachineMap(path: string): Record<string,string> preserves current map validation: relative to map directory, repository normalization, assertRepositoryIdentity.

Discovery contract: enumerate committed runner/features/*/manifest.yaml candidates from locally available HEAD and refs/heads history plus binding feature IDs; decode candidate coordinationBranch, resolve refs/heads/<branch>, reread manifest there and verify ID/branch consistency. Then coordinationRevision({store,revision:branchHead}), store.status({revision:branchHead}) and authoritativeApproval; first-parent authority remains existing domain logic. Conflicting declarations/missing branches/invalid history are per-feature errors. Never fetch or silently use imported revision/checkout HEAD as current authority.

Association contract: current repository identity is configured openspec-runner.repository, else exact origin. Map entries must pass existing identity validation. Match current worktree with mapped checkout using normalized common Git directory; ambiguous identity/map associations are errors. Discover only shared features whose components associate with current repository. --change filters local features/tasks/sessions and imported assignments with that local change; shared feature appears only when associated assignment/component matches. Never monitor peers' workers.

Retention contract: use source "coordination" for a whole Store/map failure. The client retains prior shared-feature sources as stale on that error while preserving newly collected local data as fresh. Per-feature failures retain their exact shared source IDs. Reconcile imported bindings against shared assignments by shared feature ID, repository and assignment ID to avoid duplicate rows; unknown Store authority must remain explicit.

- [x] RED: "coordination discovers authoritative features from handoff checkout": manifest solely on declared local branch discovered, uncommitted manifest ignored, conflicting/missing branches isolated.
- [x] RED: "coordination maps linked worktree and filters assignments": relative map paths/main-worktree alias, ambiguous association error and exact --change linkage.
- [x] RED: "coordination distinguishes pinned from inspected revision": without Store imported assignment/pinned history with unknown revocation; with Store stale/revoked identified; accepted/merged/delivered/completed separate.
- [x] RED: "coordination invalid map and store do not hide local data": paired flags required, unavailable Store and invalid manifest errors visible without persisted mutation.
- [x] GREEN: Reuse CoordinationStore.status/authoritativeApproval, coordinationRevision and Component.status semantics; committed data only.
- [x] CHECK: targeted dashboard-coordination and coordination-cli, pnpm test, no-write audit; fresh review/commit. Phase gate: authority/association contracts accepted.

## Phase 2 — Activity

### Task 3: Normalization and bounded pages

**Files:** Create src/activity-types.ts, src/activity-parser.ts, src/activity-reader.ts, test/activity.test.mjs.

**Produces, consumed verbatim by Tasks 4/6:**

```ts
type ActivityIdentity = { attemptId: string; harness: string };
type ActivityEntry = {
  version: 1; id: string; identity: ActivityIdentity; observedAt?: string;
  kind: "message" | "command" | "file-change" | "diagnostic" | "turn" | "raw";
  stream: "stdout" | "stderr"; text: string; toolId?: string; outcome?: string;
};
type ActivityPage = { entries: ActivityEntry[]; cursor?: string; reset: boolean; errors: string[] };
interface ActivityDecoder {
  feed(chunk: Uint8Array, stream: "stdout" | "stderr", observedAt?: string): ActivityEntry[];
  end(): ActivityEntry[];
}
createActivityDecoder(identity: ActivityIdentity): ActivityDecoder;
type ActivityPageOptions = {
  log: string; sidecar?: string; identity: ActivityIdentity; cursor?: string;
  direction: "older" | "newer"; limit?: number; mode?: "normalized" | "raw";
};
readActivityPage(options: ActivityPageOptions): ActivityPage;
```

Page default/max 200 entries, max 256 KiB read/page, 64 KiB record/partial buffer per stream. Opaque cursor records file identity/offset; replacement/truncation resets. Separate stream buffers and byte-safe UTF-8; oversize remainder dropped through next newline with diagnostic. Sidecar preferred, including older rotated files <log>.activity.jsonl.1 and <log>.activity.jsonl.2 within the same total page budget; legacy structured/text best effort, raw without invented times. Strip ANSI/OSC/control sequences except readable tabs/newlines. Bound tool correlation to latest 1,000 IDs. No state writes or identity evidence synthesis.

Normalized mode is the default. Explicit raw mode ignores sidecars and emits sanitized original log lines without JSON normalization or invented timestamps, preserving the requested attempt/harness identity. Cursors bind to mode and retain intra-record entry boundaries; pending live EOF must not consume an unfinished record, and backward scans preserve each record's original block order. Validate sidecar identity, and share bounded tool correlation across legacy records within the page.

- [x] RED: "activity normalizes codex messages commands changes turn outcomes": malformed/unknown become diagnostic/raw and turn remains activity only.
- [x] RED: "activity correlates complete claude tool blocks": complete assistant text/tool_use/tool_result IDs, omit token deltas; existing identity decoder independent.
- [x] RED: "activity bounds partial unicode oversized and control records": split UTF-8, stderr interleaving, absent newline and hostile controls respect byte caps.
- [x] RED: "activity pages legacy logs and resets": missing file errors, no fake timestamps, older/newer boundaries preserve complete entries, truncation/replacement reset.
- [x] GREEN: Implement pure parser and bounded paging (no readFile of whole log).
- [x] CHECK: activity tests, pnpm test; fresh review/commit.

### Task 4: Best-effort sidecar capture

**Files:** Create src/activity-writer.ts, test/worker-activity.test.mjs. Modify src/worker.ts, src/harnesses/types.ts, src/harnesses/codex.ts; adjust existing harness/runner/feature behavior tests only when needed.

**Consumes:** ActivityIdentity/ActivityEntry/ActivityDecoder and createActivityDecoder(identity: ActivityIdentity): ActivityDecoder from Task 3; feed(chunk:Uint8Array,stream:"stdout"|"stderr",observedAt?:string):ActivityEntry[], end():ActivityEntry[]. **Produces:** createActivityWriter(log:string,identity:ActivityIdentity): { feed(chunk:Uint8Array,stream:"stdout"|"stderr"):void; close():Promise<void> }; sidecar <log>.activity.jsonl; optional HarnessCapabilities.features.structuredActivity?:boolean; optional HarnessAdapter.activityInvocation?(invocation:Invocation,capabilities:HarnessCapabilities):Invocation.

SupervisedSession retains its existing caller contract with optional id?:string for capture identity; real task attempts and feature jobs already provide that ID. If a legacy/custom caller has no attempt ID, skip capture and preserve its existing invocation instead of inventing identity or failing supervision.

Codex structuredActivity true only if exec help advertises --json. activityInvocation adds --json only to initial supported exec, never resume; absent hook/capability preserves existing invocation. No new saved settings/state version. Receipt timestamp and attempt identity recorded. Async serialized writes: max 1 MiB queue, max 64 KiB entry, 0600, max 8 MiB current plus two rotated files named <log>.activity.jsonl.1 and <log>.activity.jsonl.2 (1 is newer); reader respects these rotations and page budget. Queue/disk/parser failure disables capture and emits best-effort diagnostic; close bounded to 250 ms and absorbs capture failures. Stderr always diagnostic/raw stream, never identity-bearing stdout.

- [x] RED: "worker gates json by advertised capability": text fallback/external harness/resume invocation unchanged.
- [x] RED: "worker activity cannot satisfy completion identity gates": stdout turn success without report, forged stderr session/turn, mismatched identities keep existing acceptance behavior.
- [x] RED: "sidecar disk parser queue and close failures preserve worker result": original logs/stdout/stderr/exit and Claude identity callback preserved; bounds/rotation verified.
- [x] GREEN: Wire a separate best-effort path around existing raw logging and ClaudeStreamDecoder. Never assign capture errors to worker failure, kill child, or modify evidence callbacks.
- [x] CHECK: worker-activity/harness/runner/feature targeted tests, pnpm test; fresh review/commit. Phase gate: lifecycle unchanged with observational failures.

## Phase 3 — Safe actions and UI

### Task 5: Guided action allowlist

**Files:** Create src/dashboard-actions.ts, src/dashboard-action-runner.ts, test/dashboard-actions.test.mjs. Modify src/adapters.ts only for saved-terminal focus helper if needed.

**Consumes:** DashboardSnapshot/TaskSummary/SessionSummary from Tasks 1/2. **Produces:**

```ts
type DashboardAction = {
  id: string; label: string; kind: "inspect" | "diff" | "focus" | "command" | "preview";
  available: boolean; reason?: string; argv?: string[]; sessionId?: string;
};
type PreviewInput = { taskIds?: string[]; model?: string; effort?: string; settingsFile?: string };
actionsFor(snapshot:DashboardSnapshot,targetId:string):DashboardAction[];
runDashboardAction(options:{
  snapshot:DashboardSnapshot; action:DashboardAction; input?:PreviewInput; signal:AbortSignal;
}):Promise<{text:string;command?:string[]}>;
```

Only inspect/diff/focus/preview execute. Command-kind displays argv with existing platform quoting. Revalidate exact selected attempt before focus; historical selection must not focus a different latest attempt. Preserve Runner.attach finished/ambiguous checks, but adapter-focus only recorded existing terminal, otherwise details. Never run returned initial/resume command. Review/repair follows same policy. No create/start/resume/mutation method in action runner.

Executable preview allowlist: audited launch <change> --tasks exact IDs; retry <change> <task> with exactly one selected task; feature review/fix; all --dry-run --json. Plan/final approval and archive previews are unavailable because current core methods run validation/configured checks; provide display-only CLI commands and explicit reasons, without changing core behavior. Unmanaged inherited settings require explicit model and any required effort; fully specified assignments need no redundant overrides, Claude effort remains optional/capability-dependent and Codex effort must resolve. Managed settings stay approval-owned. Child CLI argv without shell, async timeout 30s, output max 1 MiB, AbortSignal cleanup, stdout/stderr separate. Do not execute arbitrary action argv; independently validate allowlist.

Saved-terminal focus runs through a bounded ephemeral async child using the existing adapter argument/context construction; it must return promptly and cancel the child/backend process group it created, never a stored worker PID or unrelated service. This adds no persistent service and does not use Runner.attach or execute returned worker commands.

- [x] RED: "actions require explicit selection and preview inputs": missing IDs/model/effort/file unavailable, all executable preview argv dry-run/json, mutation-kind cannot execute.
- [x] RED: "focus uses exact existing saved terminal": finished/missing/changed/ambiguous and manual sessions yield details; review/repair never creates/resumes.
- [x] RED: "preview cancellation timeout and failure preserve state": slow child responsive/cancellable; byte/ref/runtime audit for all allowed previews.
- [x] GREEN: Implement helpers using existing CLI preview semantics; bounded evidence/diff reads and safe terminal adapter calls.
- [x] CHECK: dashboard-actions and existing attach/preview tests, pnpm test; fresh review/commit.

### Task 6: Lazy Ink views and readable activity

**Files:** Create src/dashboard-ui.tsx, src/dashboard-view.ts, test/dashboard-ui.test.mjs. Modify src/dashboard-cli.ts, src/dashboard-client.ts, src/dashboard-collector.ts and src/dashboard-types.ts for UI wiring and activity requests through the existing collector. Task 6 owns narrow src/dashboard-reader.ts additions for optional task.harness (known plan agent), repository.maxParallel (valid local runner configuration) and session.worktreeAvailable (collector observation), so labels/slots/menu projection need no UI-thread filesystem reads. Narrow src/dashboard-actions.ts and related action tests may make actionsFor a pure snapshot projector: known missing worktree metadata disables focus, unknown remains unknown, and actual async execution retains fresh exact-path/terminal revalidation. Unknown/invalid configuration stays unknown with source errors; never invent Codex or a slot limit. Modify package.json, pnpm-lock.yaml, tsconfig.json for authorized Ink 8.0.0, React 19.3.0 and dev dependency @types/react 19.3.0, plus TSX. Use Ink rendering with controlled streams and the already installed Linux script utility for terminal checks; do not add a test renderer or native PTY package without further user authorization.

**Consumes:** startDashboardCollector(options:DashboardOptions,receive:(snapshot:DashboardSnapshot)=>void,fail:(message:string)=>void):{refresh():void;close():Promise<void>}; actionsFor(snapshot:DashboardSnapshot,targetId:string):DashboardAction[]; runDashboardAction({snapshot,action,input?,signal}):Promise<{text:string;command?:string[]}> with Task 5 DashboardAction/PreviewInput. ActivityIdentity={attemptId:string;harness:string}; readActivityPage({log:string,sidecar?:string,identity:ActivityIdentity,cursor?:string,direction:"older"|"newer",limit?:number}):ActivityPage, with ActivityEntry/ActivityPage from Task 3, including reset/errors and 200-entry/256KiB caps.

**Produces:** runDashboardUi(options:DashboardOptions):Promise<void>; selectDashboardRows(snapshot:DashboardSnapshot,view:"Overview"|"Attention"|"Features"|"Sessions"|"Assignments",filters:{search:string;status?:string;harness?:string;owner?:string;includeCompleted:boolean;includeOlderAttempts:boolean;sort:"name"|"attention"}):Array<{id:string;label:string;targetId:string}>.

Activity offload: extend the existing collector, rather than invoking synchronous readActivityPage on the UI thread or creating another collector. Add optional request kind "snapshot" | "activity" (absence retains snapshot compatibility), activity?:ActivityPageOptions on requests and activity?:ActivityPage on responses. Extend the client handle with readActivity(options:ActivityPageOptions,signal?:AbortSignal):Promise<ActivityPage>. Use the same single in-flight IPC request and bounded queue of at most eight activity requests, coalesced snapshot refreshes, existing ten-second timeout/response bound and generation guards. Reject cancelled/closed requests, discard late responses, and surface activity-page errors without marking unrelated snapshot sources stale. Closing cancels all outstanding work. UI selection generations prevent old-session pages replacing the current feed.

- [x] RED: "views default active overview and preserve selection": all five views, current-view search/status/harness/owner filters, sort, completed/older toggles; stable IDs/fallback; counts without percentages.
- [x] RED: "keys focus details help actions narrow terminal": arrows, Tab, Enter, Escape, /, r, ?, q; readable 40x12 fallback; all spec detail fields present.
- [x] RED: "activity follows pauses resumes searches expands raw pages": scroll pauses, visible resume, raw switch, bounded 1,000 selected-session entries and older paging without accumulation.
- [x] RED: "slow collection preview and exit restore terminal": unresolved collector/action promises do not block keys; q/SIGINT/error unmount, abort children, restore cursor/input.
- [x] GREEN: Declarative TSX with Ink input/focus/size APIs. Overview shows phases/counts/slots/activity/attention; Features shows dependencies/settings/attempts/verification/findings/repair/integration/archive; Sessions shows identity/process/terminal/worktree/activity/logs; Assignments shows ownership/dependencies/submission/acceptance/delivery/revision. Visible stale/error badges. Activity loads asynchronously outside render; no sync filesystem/domain collector on UI thread. Explicit preview menu and required inputs use Task 5.
- [x] CHECK: dashboard-ui, build/declarations, pnpm test; lazy imports and Node floor audit; fresh review/commit. Phase gate: responsive observational interaction.

## Phase 4 — Acceptance

### Task 7: Cross-path regression, documentation and package review

**Files:** Modify README.md; create test/dashboard-acceptance.test.mjs. Evidenced integration fixes to earlier files require supervisor assignment.

**Consumes:** dashboardCommand(args:string[]):Promise<void>, runDashboardUi(options:DashboardOptions):Promise<void>, collectDashboard(options:DashboardOptions):DashboardSnapshot and version-1 snapshot/activity/action contracts unchanged. **Produces:** CLI/shortcut/format/sidecar documentation, acceptance evidence and packaged compiled UI/collector paths.

- [ ] RED: "dashboard capture browsing preview preserve lifecycle": fake Codex/Claude, v1/v2, missing reports, turn success, sidecar failures and handoff Store history; activity never changes report/identity/integration gates and browse/preview preserves files/refs.
- [ ] GREEN: Wire evidenced missing package/import paths; document dashboard, --change, --store/--map, --once, --json, TTY fallback, shortcuts, stale data, bounded sidecars/rotation and explicit safe-action limits.
- [ ] CHECK: pnpm test PASS under supported Linux runtime; pnpm pack --dry-run PASS with compiled TSX/collector and compatible dependency engines.
- [ ] CHECK: disposable repository dashboard --json/--once/--change and paired Store/map; one JSON snapshot and no persisted changes. Explicit supported preview commands PASS without mutations.
- [ ] CHECK: WSL/Linux terminal navigation/all views/filtering, narrow terminal, paused follow/raw log, slow-preview cancellation and clean exit. Exercise saved-terminal attachment through fake backend fixtures; additionally test a real saved backend when available and record that optional real-backend check as unverified when unavailable.
- [ ] REVIEW: fresh gpt-6.1-sol low whole-change review against approved spec, authority, bounds, lifecycle and compatibility. Supervisor delegates corrections and reruns affected checks.
- [ ] ACCEPT: seven approved task gates, required full suite/CLI/package checks and manual evidence complete; report remaining risks. No additional design approval pause.

## Coverage and self-review

| Approved requirement | Owner |
|---|---|
| Local discovery, state/history/settings/reports and attention | 1 |
| Snapshot/CLI/version/refresh/staleness/process uncertainty | 1 |
| Map/current-worktree association/imported/shared authority | 2 |
| Normalized/legacy activity, bounds/sanitation/partial records | 3 |
| Capability-gated Codex, Claude compatibility, sidecar isolation | 4 |
| Evidence/diff/terminal/commands, exact explicit dry-run previews | 5 |
| Five views, keys/filters/sort/details/follow/search/raw/exit | 6 |
| End-to-end compatibility, platform/manual/package documentation | 7 |

Plan self-review: each approved feature has an owner; interface names agree across briefs; Review Focus cases have named tests. Implementation and verification remain pending.
