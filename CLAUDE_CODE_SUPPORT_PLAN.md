# Plan: Claude Code support

Status: proposed; no implementation started.

Prepared: 2026-09-14. Based on the local repository, its knowledge graph, and current official Claude Code documentation retrieved through Context7 and checked against the documentation site. CLI capabilities must be verified against an installed version during implementation; this document does not claim live Claude acceptance testing.

## 1. Intended result and scope

Allow each explicitly selected OpenSpec task batch to run entirely through either Codex or Claude Code while retaining the existing task lifecycle: reviewed assignments, explicit launch, isolated Git worktrees, supervised workers, identity-bound reports, explicit integration, and conservative cleanup.

Recommended scope:

- Preserve existing Codex configuration, commands, model inheritance, and recorded attempts.
- Support Claude workers from either a Codex or Claude coordinating session, or an ordinary terminal. Coordinator identity must not determine worker backend.
- Each launch batch has exactly one harness: all Codex or all Claude Code. Do not support task-level harness overrides or mixed batches.
- Treat Codex and Claude Code as equal implementations of the same harness contract, with the same lifecycle guarantees, CLI workflows, and acceptance requirements.
- Design the contract and registration mechanism to admit future agentic harnesses, such as GitHub Copilot, without modifying orchestration logic.
- Ship separate model/effort assignment rules for each harness and require the planner to consult the selected harness's rules when proposing task assignments.
- Install planning, coordination, and implementation skills for both tools.
- Use the installed `claude` CLI through a narrow adapter. Do not add an Anthropic SDK dependency for this first release.
- Preserve Linux/macOS/WSL support and the existing native-Windows restriction.

Out of scope: mixed-harness batches, implementing additional harnesses now, automatic provider failover, translating conversations between providers, automatic scheduling, cloud-hosted workers, Claude agent teams, runner-managed login or billing, a new permission UI, and automatically resuming a worker after a final report. Claude's own worktree creation must not be used: the runner already owns worktree allocation and recovery.

The single-harness batch requirement and equal treatment of Codex and Claude Code are explicit product requirements. Separate batches may select different harnesses; this does not require a repository-wide harness lock. Ordinary dependency and concurrency rules still apply across batches and changes. Persist batch identity and its selected harness on each attempt. Codex defaults below exist only for compatibility with existing projects, not as a privileged implementation. “Harness” refers to the coding tool; “provider” refers to its model/authentication service, which the runner does not manage.

## 2. Current implementation and affected seams

| Location | Current behavior | Planned change |
| --- | --- | --- |
| `src/codex.ts` | Defines `Settings`; reads current Codex model/effort from version-gated SQLite; queries app-server `model/list`; builds Codex arguments | Move into the Codex harness adapter; extract shared types and normalize native evidence |
| `src/cli.ts` | Resolves one inherited settings object, calls Codex model discovery, installs only `.agents/skills` | Resolve settings per selected backend; add backend-aware options and installation |
| `src/plan.ts` | Strict version-1 YAML parsing; assignments contain model, reasoning effort, dependencies, and parallel permission | Add explicit backend configuration with backward-compatible parsing |
| `src/runner.ts` | Imports Codex settings/resolution; saves untagged settings/session IDs; builds Codex prompts and resume commands | Persist immutable backend identity and dispatch through adapters |
| `src/worker.ts` | Probes `codex exec --help`, spawns `codex exec`, logs output, waits for actual process close | Retain common supervision and add backend-specific invocation/event handling |
| `src/adapters.ts` | Normal launch uses a supervised command in a Herdr pane; legacy fallback starts `--kind codex` | Make supervised terminal launch independent of backend; preserve legacy Codex inspection |
| `src/cleanup.ts`, `src/terminal-cleanup.ts`, `src/processes.ts` | Protect worktrees using ownership, report, process-exit, and terminal evidence | Keep protections; test them with both providers and migrated state |
| `skills/openspec-runner-*/SKILL.md` | Codex invocation syntax and `CODEX_THREAD_ID` assumptions | Share lifecycle instructions and render provider-specific installation content |
| `test/runner.test.mjs` | Codex fakes and lifecycle/recovery coverage | Add Claude protocol fixtures and a shared behavioral test matrix |
| `README.md`, `package.json` | Describe Codex-only workers | Document both backends, compatibility, permissions, and configuration |

Important existing distinctions to preserve:

1. `begin` verifies the latest active attempt, setup completion, worktree, and session ownership before editing.
2. `report` is the authority for task outcome. Completion requires a clean worktree, correct full commit SHA, and unchanged planning artifacts.
3. A report is not proof of process exit. Integration and cleanup require the supervisor's exit evidence.
4. `recover` repairs preparation; `retry` creates a new attempt; `attach` inspects an existing identity. None should silently launch another agent.
5. CLI effort discovery currently happens separately from `Runner.preview` and `Runner.launch`. The refactor must make the final resolved settings identical between preview and launch.

## 3. Equal harness implementations and module responsibilities

Introduce `src/harnesses/types.ts` for the common contract, `src/harnesses/registry.ts` for explicit registration, and sibling implementations under `src/harnesses/codex.ts` and `src/harnesses/claude.ts`. Move the existing Codex implementation behind that contract rather than wrapping only Claude around Codex-shaped interfaces. Compatibility exports from `src/codex.ts` may remain temporarily.

Use a registry keyed by stable harness IDs, initially `codex` and `claude`. Validate configured IDs against registered implementations rather than scattering two-value checks through the runner. Keep registration explicit and compiled into the package for now; dynamic third-party plugin loading is out of scope. Future harness support should require an adapter, registration, skill integration, documentation, and conformance fixtures—not new branches in launch, report, integration, or cleanup.

The interface should expose:

- Backend identity and capability checks, including installed CLI version.
- Optional calling-session settings and optional model discovery, with explicit unsupported results.
- Harness-owned validation and resolution of model/effort/settings, plus schema/version handling for its persisted options.
- Initial invocation as executable, argument array, working directory, optional stdin, and controlled environment additions.
- Prompt rendering and session-registration strategy.
- Resume/inspection command construction from saved settings and identity.
- Session evidence and output decoding normalized into common lifecycle events (identity confirmation, diagnostics, terminal result, and execution failure).
- Skill installation targets and invocation conventions, so the installer also uses the registry.
- A versioned model/effort planning-rules resource, discovered through the registry and available to either coordinating harness.

Required capabilities are supervised execution, durable session ownership evidence, the worker report protocol, and retained inspection details. Optional capabilities such as calling-session inheritance, live model discovery, and exact resume must explicitly report supported/unsupported status with a reason. Equal implementations means equal contract and lifecycle guarantees; it does not require fabricating a CLI feature that one harness lacks. Capability limitations must be visible in preview and documentation through the same mechanisms for both harnesses.

`src/worker.ts` owns spawning, process identity, log file permissions, stdout/stderr forwarding, input closure, and final exit receipts. `Runner` owns locks, state transitions, reports, dependencies, and integration. Neither should interpret harness-specific event fields directly or branch on a Codex/Claude ID. Each adapter must normalize its native evidence; session registration via Codex environment metadata and Claude stream confirmation are implementation details behind the same ownership contract.

Use a common resolved-settings envelope containing harness ID, requested model, optional effort, resolution sources, and adapter-validated versioned options. Each adapter owns its strongly typed options; core orchestration must not depend on a central Codex-versus-Claude settings union. Retain legacy `reasoningEffort` only at the compatibility boundary and translate the common effort field inside each adapter. Do not assume identical effort vocabularies or model capabilities. No arbitrary extra-arguments escape hatch in the initial schema: it could override identity, persistence, output format, or worktree ownership.

## 4. Configuration and CLI contract

### YAML versions

Continue accepting version-1 `runner.yaml` and `execution.yaml` unchanged, normalizing missing backend identity to Codex. Add version 2 for new backend fields so old binaries reject new plans rather than misinterpret them. Both files may be parsed independently. An unchanged pair of version-1 files retains Codex behavior. A version-1 execution file may be used with a version-2 project default or explicit batch selection, but its model/effort values must be validated by the selected harness, never silently translated. Changing committed defaults changes the plan and requires reconciliation.

Proposed project configuration:

```yaml
version: 2
defaultAgent: codex
agents:
  codex:
    defaultModel: session
  claude:
    defaultModel: sonnet
    permissionMode: dontAsk
    allowedTools: []
maxParallel: 4
worktrees: auto
terminal: auto
cleanup: automatic
setup: []
verifyIntegration: []
```

The empty allow list adds no grants; existing Claude settings still apply. It is not a promise that an unconfigured Claude worker can edit or commit. Setup documentation must show how a project supplies reviewed permissions for its checks and runner commands.

Proposed assignment file with a change-level default harness (the selected batch can override this default):

```yaml
version: 2
agent: claude
tasks:
  "1.1":
    model: sonnet
    parallel: true
  "1.2":
    model: sonnet
    effort: high
    parallel: true
  "1.3":
    dependsOn: ["1.1", "1.2"]
    parallel: false
```

Version-2 assignments use `effort`; version-1 `reasoningEffort` keeps its existing meaning. Reject conflicting aliases, unknown keys, unknown harnesses, task-level `agent` fields, invalid values, and settings belonging to another harness. Permit explicit provider model identifiers, including identifiers whose punctuation differs from Codex IDs; validate strings for safe argument transport without inventing a universal model-ID regex.

Task `1.3` intentionally omits a model so it can use the selected batch harness's configured or CLI default. The harness is still chosen once for that batch, independently of task settings.

### Selection and precedence

1. Batch `--agent` wins over the execution file’s top-level `agent`, which wins over project `defaultAgent`; the legacy fallback is Codex. Resolve this once for the entire selection and snapshot it before creating attempts.
2. Explicit task model wins over the CLI model default for its backend, then that backend's configured default.
3. `session` means the selected backend's calling-session model. Codex keeps its existing reader. Claude initially fails with an explicit-model instruction; do not infer the model from a parent Codex session or scrape Claude transcripts.
4. Explicit task effort wins. CLI/configured effort applies only to the corresponding inherited/default model. A different task model gets its own supported default, preserving the existing Codex rule.
5. Claude may omit effort and use its CLI/model default. Persist that omission as an intentional default, not an invented resolved effort. Preserve requested model aliases and record observed concrete model metadata when available; alias/default behavior may change across CLI/model updates.

All task model/effort overrides and CLI defaults are interpreted by the one selected harness. Reject per-task harness fields and repeated/conflicting harness flags before side effects. Different models within a batch are allowed when supported by its harness. Changing the selected harness never translates existing model identifiers; incompatible assignments must fail with instructions to update the plan. Do not route by model-name prefixes.

Examples (separate launch batches):

```sh
openspec-runner launch feature --tasks 1.1,1.2 --agent claude --dry-run --json
openspec-runner launch feature --tasks 1.1,1.2 --agent claude
# A later ready batch, with assignments compatible with Codex:
openspec-runner launch feature --tasks 1.3 --agent codex --default-model MODEL_ID
```

Preview returns one top-level harness selection and all attempts inherit it. Repeated preview/launch invocations use the same precedence, resolved settings, and validation; no task can change the harness while the batch is being prepared.

### Commands

- `init --agent codex|claude|all`: default remains `codex`. Install selected skills; preserve existing configuration. When creating new Claude-only configuration, choose an explicit Claude model default; `all` installs both equally. For a new version-2 configuration, permit an explicit `--default-agent` with `init --agent all`; if omitted, retain the compatibility default and show it in installer output.
- `models --agent codex|claude [--json]`: an explicit harness selects that adapter; otherwise use the project default, falling back to Codex outside configured projects. Preserve the legacy unqualified Codex output contract for legacy projects. Claude should return a clearly labeled discovery status and documented example aliases when live account discovery is unavailable; examples must never be represented as an exhaustive entitlement list. Do not launch a paid inference just to list models.
- `planning-rules --agent HARNESS [--json]`: return the selected harness's bundled model/effort guidance plus any configured project supplement, with source paths, versions, and content hashes. This read-only command must work without launching or authenticating a worker. The planner uses it alongside `models`; guidance and actual model availability are separate inputs.
- `launch` and `retry`: add batch-wide `--agent`; preserve current defaults and explicit selection behavior. A retry may choose a new backend after the old attempt is confirmed stopped; existing attempts never change backend.
- `launch --dry-run --json`: show the single batch harness, requested model/effort, resolution sources, permission policy, capabilities, and exact execution recipe. Read-only probes are allowed; no inference, login, state writes, worktrees, or terminals.
- `status`, `attach`, and JSON errors: identify the saved backend. Keep existing fields where possible and document additions.
- `begin` and `report`: remain backend-neutral worker commands. Do not allow a worker flag to change the saved backend.

New version-2 CLI output should use the same model/capability envelope for every harness. Preserve older Codex JSON shapes only through an explicit legacy formatting path; adapter return types must remain uniform. Generate available harness choices in help and validation from the registry; `codex|claude` above lists the initial implementations, not a permanent two-harness limit.

Read-only inspection, cleanup, and integration of retained results must not require either coding CLI to remain installed. Each harness must work without the other installed: launch probes only the selected harness and must not inspect the other tool’s home directory.

## 5. Claude invocation, permissions, and project context

Use print mode with structured streaming for the Claude adapter. The documented building blocks include `-p`, `--output-format stream-json`, `--verbose`, `--model`, and a UUID supplied through `--session-id`. Resume uses an exact saved ID through `--resume`. Model-specific effort and optional flags need capability checks against the chosen supported version. See the [CLI reference](https://code.claude.com/docs/en/cli-reference).

The execution recipe should set the child process `cwd` to the existing attempt worktree, send the full generated prompt via a tested stdin path, and close stdin after submission. Use argument arrays; only render shell-quoted commands at terminal boundaries. Keep Claude session persistence enabled.

Permission policy:

- Inherit the user's authentication and existing provider configuration. Never read or copy credential files into runner state, logs, command previews, or YAML.
- Use the configured unattended permission mode; recommend `dontAsk` so missing grants produce denial rather than an unattended approval wait. Add only explicitly configured `allowedTools` rules. Verify behavior on the pinned supported version. [Permission modes](https://code.claude.com/docs/en/permission-modes)
- Do not inject `--dangerously-skip-permissions` or automatically select a bypass mode. Arbitrary execution cannot be made safe simply by placing it in a worktree.
- Test access to the assigned worktree, Git common directory, and the temporary report path. Provide additional working-directory access only where needed and explain that directory access is not blanket command approval.
- If a tool denial prevents `begin`, `report`, Git commit, or verification, retain diagnostics and fail without inventing a completed report. An accepted blocked report remains the preferred task-level explanation when reporting is permitted.

Keep project instructions and skills available to workers. Current print mode can load project/user context; do not select `--bare` or safe mode without explicitly replacing that context. Because this behavior is evolving, pin and test it as a required capability. Claude results and stream events are execution diagnostics; they do not replace `openspec-runner report`. [Programmatic execution](https://code.claude.com/docs/en/headless)

## 6. Session identity and durable supervision

Allocate a distinct Claude session UUID before spawning and persist it as `expectedSession`, not as proof that a session exists. Save the attempt, backend settings, worker token, and launch intent before external side effects.

Pass the UUID with `--session-id`, include the exact `begin ... --session UUID` command in the worker prompt, and optionally expose a runner-owned session environment variable. Claude must not fall back to inherited `CODEX_THREAD_ID`.

The stdout decoder should confirm the emitted session ID against the expected UUID and persist confirmation independently of `begin`. The worker's `begin` call remains the explicit registration gate. Require verified stream identity before treating a Claude completion as eligible for integration, but tolerate event/`begin` callback ordering without racing or deadlocking the repository lock. A reserved UUID alone must not trigger a resume command.

Keep `report.session` as a string for compatibility; interpret it in the context of the attempt's immutable backend. Reject wrong IDs, mismatched emitted identities, superseded attempts, and duplicate/conflicting reports.

Decoder requirements:

- Incrementally handle split UTF-8/chunks, multiple newline-delimited events per chunk, and a final unterminated line.
- Separate stderr diagnostics from stdout protocol parsing; preserve both in logs.
- Bound buffered line size and avoid retaining the full transcript in memory/state.
- Ignore unfamiliar noncritical event types, but fail closed on malformed required identity/result data or contradictory session IDs.
- Record terminal result/error metadata for diagnostics. Do not equate a successful Claude result or exit code zero with task completion.

Persist actual process-close status separately from report outcome. Missing report means failed attempt even after exit zero. A nonzero exit, missing required terminal evidence, or identity mismatch after a completed report must retain the report but block integration pending explicit diagnosis; enforce this policy through common normalized evidence for both new Codex and Claude attempts. Historical Codex receipts must be handled explicitly by the migration compatibility path, not by a permanent exemption for new Codex workers. Signals and lost supervisors must remain distinguishable from successful completion.

## 7. Recovery, attachment, and terminals

Keep normal Herdr launch on `pane run` with the saved supervised worker command; it does not need Claude-specific Herdr agent support. Remove Codex-only arguments from the new generic terminal path. Preserve the legacy Codex fallback only where existing callers/state require it, and never route Claude into it.

Build Claude inspection/resume commands from saved backend, identity, settings, and working directory. Never use `--continue`, latest-session discovery, or a session picker for deterministic recovery. Do not emit an executable resume command for an unconfirmed session or a removed worktree.

Preserve the distinction between active pane attachment and starting a second CLI process. A saved resume recipe is not authorization to resume concurrently. Finished attempts return retained identity, branch, report, and log; further implementation requires `retry`.

Test crash points before spawn, after spawn before identity confirmation, after confirmation before `begin`, after `begin`, after report acceptance, and before the final exit receipt. Neither a reserved UUID nor a missing receipt proves that resubmission is safe. Existing ambiguous-startup and lost-supervisor handling must remain conservative.

## 8. State compatibility and migration

Use a version-2 runtime state format for batch records, harness-tagged attempts, and normalized execution evidence. Each batch records a stable ID and one immutable harness; every member attempt references that batch and must match its harness. Validate this invariant when decoding state and before launch/recovery. A retry creates a new batch/attempt rather than changing the old batch. Add a single versioned decoder used by every read path, including `preview`'s scan of other changes; do not only update `Runner.read` while leaving direct `json<State>` reads elsewhere.

- Decode version-1 attempts as Codex. Where original launch grouping was not recorded, use marked synthetic single-attempt legacy batches rather than guessing historical grouping. Preserve session IDs, settings, reports, worker receipts, terminal IDs, cleanup tokens/evidence, transactions, and attempt order.
- Normalize read-only commands in memory. Persist upgrades only during a locked mutation and after preserving a backup of the original state.
- Reject unknown versions. Add an actual version guard so old/new state handling is explicit; TypeScript's `version: 1` annotation currently does not validate JSON at runtime.
- Never reinterpret old attempts using current project defaults. Recover/attach use saved settings; retry resolves a new attempt.
- Include backend/configuration changes in planning fingerprints. Reconcile only under existing inactive-state rules; backend edits invalidate unintegrated results as other execution-plan edits do.
- Preserve raw historical reports and logs. Keep cleaned attempts inspectable without installed providers or remaining worktrees.

Operational migration must run with coordinators/workers stopped. Old binaries currently read state through unchecked casts, so a version bump alone cannot prevent an older executable from rewriting version-2 state. Document that downgrade requires restoring the backup in a quiescent repository and cannot safely discard attempts created after migration.

## 9. Skills and documentation

Install the same three workflows into `.agents/skills` for Codex and `.claude/skills` for Claude. Prefer shared source instructions with small backend-specific rendering substitutions, rather than maintaining six divergent lifecycle descriptions. Claude project skills use `.claude/skills/<name>/SKILL.md`. [Skills documentation](https://code.claude.com/docs/en/skills)

Update all three workflows:

- Planning: select one harness per proposed batch and show it once above the task review table; use the change-level YAML default, never per-task harness fields. Read its model/effort rules, check harness-specific model capabilities, and propose assignments with task-specific reasons and rule references. Explain unavailable capabilities.
- Coordination: preview resolved backend settings, recognize both session types, and retain explicit launch/integration/cleanup approvals.
- Implementation: use the provider-appropriate invocation and exact registration command; share report schema, commit verification, and stop-after-report rules.

For unattended workers, include the required implementation instructions directly in the generated prompt or explicitly provide their file content. Do not rely solely on interpreting `$openspec-runner-implement` or an interactive slash command in print mode.

Preserve user-owned instruction files. Claude reads `CLAUDE.md`; projects sharing `AGENTS.md` can import it with `@AGENTS.md`. Document this option without overwriting or automatically rewriting existing instructions. Verify nested instruction handling in the acceptance fixture. [Claude memory documentation](https://code.claude.com/docs/en/memory)

Installer output should list exactly which paths were installed. Repeated installation must be idempotent, preserve existing OpenSpec skills/configuration, and package all required rendering assets. Extend README requirements, examples, model defaults, permissions, single-harness batches, future adapter development, failure diagnostics, migration, resume, and cleanup sections. Update the package description.

### Per-harness model and effort assignment rules

Add human-readable, versioned resources such as `harnesses/codex/planning-rules.md` and `harnesses/claude/planning-rules.md` to the package. These are harness-specific supplements to the common planning workflow, with equal coverage and the same document structure. A future harness must provide its own rules as part of registration and acceptance.

Rules must contain actual model/effort recommendations for concrete task situations, not merely a list of available models. Each resource should document:

- Its harness ID, rule IDs, revision, last review date, and documentation or evaluation evidence supporting the recommendations.
- Named models or aliases, their appropriate task types, and applicable effort levels, including when effort should be omitted because the model does not support it.
- Conditions for choosing a faster/lower-cost option, a balanced option, or a more capable option; these categories need not map to the same models or effort labels across harnesses.
- Escalation criteria such as unclear requirements, broad codebase dependencies, concurrency or persistence changes, difficult diagnosis, weak verification, or a previous unsuccessful attempt.
- How explicit user choices, available models, latency/cost preferences, and project constraints affect the recommendation.
- What to do when a recommended model is unavailable, an alias has changed, effort support is unknown, or rules are older than the installed CLI/model catalog. Never silently substitute a different harness or invent supported effort values.

Use a common task-assessment rubric, with each harness supplying its own concrete mapping:

| Task situation | Required guidance in each harness's rules |
| --- | --- |
| Mechanical documentation edits or narrow, well-specified changes | Suitable economical model and effort; conditions that make a more capable model necessary |
| Routine implementation with clear boundaries and useful tests | Normal model/effort recommendation and when to increase reasoning |
| Changes spanning modules or debugging with an uncertain cause | Model and effort suited to investigation; indicators that the task should first be clarified or split |
| Migrations, concurrency, security-sensitive logic, or durable state/recovery | Recommended reasoning capacity and verification expectations; avoid using effort as a substitute for clear requirements or tests |
| An unsuccessful prior attempt | Diagnose why it failed before changing model/effort; distinguish missing access/context from reasoning difficulty |

Populate the concrete Codex and Claude mappings during implementation using current official documentation, available model metadata, and any project evaluations. Record uncertainty honestly: vendor capability descriptions and local routing heuristics are not comparative benchmarks. This planning update does not prescribe unverified current model rankings or assume maximum effort is always preferable.

Allow an optional `agents.<harness>.planningRules` path in version-2 `runner.yaml`, for example `openspec/planning-rules/claude.md`, to supplement bundled recommendations with project-specific model choices and task examples. The resolver should return the two labeled documents rather than attempting to merge Markdown algorithmically. The installer must preserve user-authored supplements. They are guidance files, not executable configuration, and cannot alter permissions, session ownership, or lifecycle requirements.

Planner workflow:

1. Resolve the one harness for the proposed batch and read `planning-rules --agent HARNESS`; use the worker harness's rules even when the planner itself runs in a different harness.
2. Read task descriptions, affected components, dependencies, verification requirements, and uncertainty. Evaluate task difficulty from this context rather than task size or keywords alone.
3. Check the selected harness's model/effort capabilities. Apply explicit user assignments and constraints first, then project guidance, then bundled recommendations. User preferences can override recommendations but cannot make an unsupported model/effort combination valid.
4. Choose model and effort independently for each task within that harness. In the review table, include the proposed model, effort or intentional default, a brief reason tied to the task, and the applicable rule ID/source. Prefer explicit model assignments when a rule recommends a concrete model; use `session` only when inheritance is intentional and available.
5. If availability cannot be verified without inference, label the proposal as unverified. Use documented/configured choices when sufficient, and ask for clarification only when a missing choice prevents a defensible assignment. Do not perform paid probes just to produce the plan.
6. After assignment review, write the resolved choices into `execution.yaml` using the existing model/effort fields. Preserve the rationale and rule versions/hashes in the committed planning review document, without adding free-form rationale fields to the strict execution schema.

These rules guide planning; they are not a runtime scheduler or automatic model router. Launch validates and uses the reviewed assignments and established defaults. It must not reread new recommendations and silently upgrade, downgrade, or otherwise replace a task's assigned settings. Retries can receive revised assignments after review; saved attempts retain their original settings.

Record the rule sources and hashes when planning, and treat the project supplement and committed assignment rationale as planning inputs for fingerprinting. Bundle updates must not make existing plans drift merely because the installed rule text changed: the planning record identifies the version actually used. Deliberate replanning updates that record under the existing reconciliation rules.

Both Codex-installed and Claude-installed planning skills must be able to retrieve either harness's rules. Keep one authoritative bundled copy per harness and resolve it through the CLI, avoiding copied guidance that becomes stale in each skill directory. Include these resources in package contents and test resolution from an installed package outside the source checkout.

## 10. Implementation sequence and exit criteria

| Phase | Work | Exit criterion |
| --- | --- | --- |
| 1. Compatibility spike | In a disposable repository, verify installed Claude version/help, stdin, UUID events, persistence, permissions, skills, authentication errors, and exact resume | Record a tested minimum version and sanitized protocol fixtures; resolve undocumented assumptions |
| 2. Extract harness boundary | Define common contract/normalized evidence; move Codex into a sibling adapter; make registry drive resolution and installation | Codex passes common conformance tests; core has no harness-ID branches |
| 3. Configuration/state | Versioned parsers, backend defaults, deterministic resolution, state decoder/migration, CLI options and preview | Legacy and single-harness plans validate; per-task harness fields are rejected; dry-run creates no resources; old state remains usable |
| 4. Claude worker | Invocation, UUID confirmation, prompt, stream decoder, diagnostics, supervisor integration | Fake Claude succeeds, blocks, fails, and crashes with correct durable state |
| 5. Lifecycle/terminal coverage | Single-harness batch invariants, cross-batch concurrency, retry/recovery, attachment, integration gating, cleanup | Both providers obey identical ownership and dependency protections |
| 6. Skills, assignment rules, and docs | Multi-target installer, common workflow content, concrete per-harness model/effort mappings, project supplements, rules inspection command, README and package updates | Both skill destinations resolve rules from packed output; sample task assignments explain model/effort choices using the selected harness's rules |
| 7. Acceptance | Full tests, CLI previews, packaging checks, disposable live runs | Acceptance checklist below passes and compatibility limitations are documented |

Phases are ordered to avoid adding Claude branches throughout orchestration before the abstraction and compatibility rules exist. Keep each phase reviewable as a coherent change; do not combine unrelated lifecycle repairs unless required by the new backend.

## 11. Verification plan

Automated tests use temporary repositories and fake executables; ordinary tests must not require authentication or paid inference.

| Area | Required behaviors |
| --- | --- |
| Configuration | Version-1 equivalence; version-2 defaults; batch-wide precedence; per-task harness fields and conflicting flags rejected; unknown agents/keys; wrong-provider effort; explicit model strings; session inheritance unavailable |
| Discovery | Codex output compatibility; Claude discovery honestly unavailable/partial; no Codex probe on Claude-only paths; no inference in preview |
| Planning rules | Correct worker-harness rules regardless of planner harness; bundled/project precedence and provenance; unavailable models and unsupported effort; explicit user choices; missing/mismatched rule resources; no runtime reassignment when bundled guidance changes |
| Invocation | Exact executable/argv/cwd/stdin; paths containing spaces/quotes; prompt metacharacters; scoped permissions; no accidental bypass or provider worktree flags |
| Identity | Reserved versus confirmed UUID; mismatched stream identity; `begin` ordering; inherited Codex environment ignored for Claude; report from wrong worktree/session |
| Streaming | Split/multiple events; Unicode; unknown events; stderr noise; oversized/malformed/truncated lines; missing terminal result; duplicate result |
| Outcomes | Accepted completed/blocked/failed reports; exit zero without report; nonzero after report; auth/model/permission failure; stdin/spawn failure; signal exit |
| Recovery | Every crash window; duplicate launch prevention; stopped-worker retry; retry switching provider; exact saved settings on recovery; no resume into cleaned directories |
| Orchestration | Single-harness batch invariants; separate batches across changes retain global concurrency rules; exclusive tasks; dependencies unlock only after integration; drift and reconciliation; conflicts and failed checks |
| Extensibility | Run the same harness conformance suite against Codex and Claude; register a test-only third harness with planning rules without changing core orchestration or installer logic |
| Migration | Historical interactive/supervised Codex attempts; active states; transaction/cleanup records; all-state scans; unknown version; read-only commands do not rewrite state |
| Installation | Codex/Claude/all targets; three skills per target; repeat install; user config and rule supplements preserved; package contains templates and both harness rule resources |
| Cleanup | Actual exit required; descendant/background activity; retained logs; legacy review cases; terminal ownership; state-bound approvals; no cleanup regression |

Run `pnpm test` (includes build), `pnpm pack --dry-run`, and affected CLI commands with `--json`/`--dry-run`. Add focused test files for adapter/parser/resolution behavior instead of expanding the existing large test file indiscriminately. Retain existing Worktrunk and OpenSpec compatibility coverage.

Live acceptance in a disposable repository:

1. Run this full acceptance scenario once with Codex and once with Claude. Install the selected harness’s skills and reviewed permissions; verify instructions/reporting with the other harness absent.
   Before launch, have the planner assess representative routine and complex tasks using that harness's rules. Review its model/effort choices and reasons, and confirm the same rules are accessible when planning from the other harness. Do not assert one exact model for every subjective task; check rule applicability, supported settings, and explicit preference handling.
2. Launch two independent tasks in one batch using only the selected harness, plus a later task depending on both.
3. Verify one begin registration and one accepted report per attempt, immutable backend/session identities, clean committed task worktrees, and real exit receipts.
4. Exercise manual terminals and Herdr separately; detach/reattach without duplicate submission.
5. Integrate the independent tasks, then launch the dependent task; only integration changes canonical checkboxes.
6. Exercise a denied permission, an unsuccessful report, and an interrupted worker; inspect and explicitly retry without automatic resubmission.
7. Verify cleanup retains sessions/logs/branches and completed attachment does not resume a removed worktree.
8. In a separate scenario, choose another harness for a later batch with compatible assignments; verify each batch stays homogeneous and historical attempts keep their original harness. Reject any attempt to configure a mixed batch before resources are created.

## 12. Risks and release gates

- **CLI/protocol drift:** choose a tested version range from the spike, combine capability checks with fixtures, and fail with actionable diagnostics on unsupported required behavior.
- **False identity confidence:** a preallocated UUID is intent, not a session receipt; keep reservation, confirmation, begin, report, and exit separate.
- **Permission gaps:** a worker may edit successfully yet be unable to write runner state or report. Acceptance must cover the Git common directory and report path explicitly.
- **Default drift:** Claude aliases and omitted effort are not immutable concrete model settings. Show requested and observed values and document this limitation instead of claiming exact reproducibility.
- **Harness isolation:** scope defaults and environment handling by backend; never forward Codex effort metadata or identity to Claude.
- **Backward compatibility:** version all new state, normalize every reader, and prohibit concurrent old/new executables during migration.
- **Instruction drift:** keep common skill content authoritative and test installation in committed worktrees.
- **Stale assignment guidance:** version model/effort rules, review concrete mappings against current capabilities, retain planning provenance, and keep installed rule updates from silently changing reviewed assignments.

Release is ready when both providers satisfy the same report/integration/cleanup invariants, existing Codex workflows remain compatible, each harness works without the other installed, single-harness batches pass the same acceptance suite, a test-only third adapter proves the extension boundary, and no unresolved protocol assumption is presented as supported behavior.

Future harness onboarding (for example GitHub Copilot) must implement the same contract, supply concrete model/effort planning rules, and pass the same conformance suite; no claim about that tool’s current CLI capabilities is made here. Do not implement or research its integration as part of this change.

Deferred enhancements: a documented Claude calling-session settings reader, authenticated live model discovery if a stable interface becomes available, additional enterprise-provider acceptance matrices, and optional usage/budget reporting. None should block explicit-model Claude CLI support.
