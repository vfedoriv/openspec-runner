# GitHub Copilot CLI and VS Code worker support

Date: 2026-10-29
Status: Proposed for user approval

## Intent and agreed scope

Add GitHub Copilot CLI and the VS Code Copilot extension as selectable execution
harnesses alongside Codex and Claude Code. Both Copilot surfaces must execute
runner-managed implementation, review, and repair jobs, including delegated
component jobs that use the existing feature lifecycle. Planning and coordination
skills must work in both surfaces too.

The user selected native VS Code chat and hooks instead of a companion extension.
The runner continues to own worktrees, immutable attempt identities, reports,
verification, integration, and approvals. Copilot owns its authentication,
subscription, available models, editor interface, and tool permission prompts.

## Approaches

1. **Native chat and hooks — selected.** Use the standalone `copilot` executable
   for CLI workers and `code chat` for editor workers. Native lifecycle hooks
   provide session evidence. This avoids a separately installed runner extension,
   but requires hook-capable versions and explicit handling of the editor launcher's
   early exit. VS Code does not expose an exact chat-resume command in the
   documented `code chat` interface.
2. **Companion VS Code extension — not selected.** Install a runner extension
   for editor controls and worker communication. This adds packaging, installation,
   editor API maintenance, and another communication protocol. It remains a
   possible later feature if dedicated editor controls are wanted.

Supporting VS Code only as a planning interface was considered initially and
explicitly ruled out by the user: editor sessions must execute managed workers.

## Goals and boundaries

- Register `copilot` and `copilot-vscode` as distinct harness IDs. Never substitute
  one for the other automatically, including during retries or recovery.
- Support the normal init, planning-rules, models, preview, launch, worker, begin,
  report, status, attach, integration, managed review/repair, and delegated flows.
- Require observed session ownership and terminal evidence before integrating
  results from either new harness.
- Keep existing version-1 Codex configuration, version-2 configuration, and saved
  Codex/Claude attempts readable with their original semantics.
- Preserve existing project hooks, skills for other harnesses, and editor settings.

This work does not add a custom VS Code extension, cloud-agent execution, remote
control, subscription management, automatic authentication, or general native
Windows runner support. Existing supported runner environments remain the target.
WSL/remote use requires the runner, hooks, Git, and worker filesystem paths to
refer to the same execution environment; a mismatched editor host cannot claim
the attempt.

## Current implementation and changes needed

`src/harnesses/types.ts` and `registry.ts` provide settings resolution, capability
inspection, invocation construction, and planning guidance. Configuration already
resolves version-2 registered harnesses, but `src/cli.ts` hardcodes the two init
targets. `runner.ts`, `feature.ts`, and `worker.ts` contain Claude-specific session
and terminal-result checks. Those assumptions must become explicit adapter
contracts while preserving Codex and Claude behavior.

The editor requires a supervisor that remains alive after its launcher exits.
It cannot use the current rule that child-process close means worker completion.
Activity parsing also currently treats every non-Claude harness as Codex; new
Copilot data must get its own normalization or remain explicitly raw.

## Configuration, skills, and models

Use version-2 configuration and change-level `agent: copilot` or
`agent: copilot-vscode`. Each batch remains homogeneous. Managed role settings
may choose either new harness independently, subject to existing approval rules.

`init --agent copilot` and `init --agent copilot-vscode` install the eight current
runner skills into `.github/skills/` plus the runner-owned hook configuration.
`init --agent all` includes both new harnesses, deduplicates their shared skill
destination, and retains existing default-agent behavior. Init preserves existing
runner.yaml; it must explain any required explicit configuration update.

Add adapter-validated `agents.<id>.options` where required, rather than arbitrary
shell arguments. Configuration and approved settings freeze these options with
the existing settings snapshot. The proposed options are a VS Code executable
or profile selector when needed, an explicit hook format (`vscode` or `copilot`),
and bounded startup/completion timeouts. Exact option names and reasonable limits
are implementation decisions; reject unknown options and invalid values.

Require explicit configured/default models for both harnesses. Do not inherit
Codex calling-session settings or translate model IDs between surfaces. CLI
model IDs and editor model selectors remain opaque surface-specific strings.
For a new single-Copilot configuration, init requires an explicit model selector
(using the existing `--default-model` spelling). Installing all skills does not
require configuring every harness: retain the existing Codex/Claude entries and
add a Copilot configuration only when its model is supplied. Selecting Copilot
as the default agent requires its model. Never write a runnable placeholder model.
Reject effort settings until the selected surface demonstrably supports a
documented corresponding option. No unsupported effort is silently discarded.

For VS Code, select a runner custom agent through `code chat --mode` and put the
requested editor model in that agent's documented model field. Keep its stable
definition in `.github/agents/` and record its identity with the attempt. Any
attempt-specific generated definition lives only in its isolated worktree, is
excluded from Git status and commits, and must not overwrite a user definition.
The implementation must verify agent discovery and model selection with a real
editor smoke test before advertising that version combination as verified.
Distinguish a requested model from a runtime-observed model; hook payloads alone
do not prove which model ran. Never invent observed-model evidence.

`models --agent ... --json` returns a factual capability result. Use a documented
non-inference catalog only if available; otherwise return unavailable/partial,
non-exhaustive guidance. Bundled planning rules explain these limitations without
hardcoding a supposedly complete entitlement list or current model ranking.

## Native hook bridge and ownership

Install one runner-owned `.github/hooks/openspec-runner.json` and a small bridge
entry point. Use the hook schema appropriate to the configured runtime. Normalize
Copilot camelCase payloads and VS Code PascalCase/snake_case payloads into the
same internal events. Do not install duplicate handlers for both schemas in one
session. Support root-session prompt, stop, session-end, error, and tool events
only where the selected runtime documents them; subagent hooks cannot establish
root ownership or complete a root worker.

All mutable bridge data belongs under the existing Git-common runner runtime
directory. Before dispatch, save a launch nonce, attempt ID, exact worktree,
harness, role/change/task identity, and supervisor identity. The generated first
prompt includes the nonce. A prompt-submitted hook must match that nonce and the
exact canonical worktree before atomically binding the actual hook session ID.
For CLI workers, also match the UUID reserved for `--session-id`. A session-start
event alone is insufficient because it need not carry the initial prompt.

Use the registered begin/report protocol after ownership is observed. `begin`
for a Copilot worker may resolve its hook-confirmed session from the saved
attempt; its response gives the actual session ID for the report. Explicit
`--session` must match. Never use `CODEX_THREAD_ID` for either Copilot harness.

Validate bounded JSON input, event type, session ID, timestamps/order, active
worker generation, and exact worktree. Ignore events outside runner attempts.
Within an armed attempt, reject mismatched ownership and record actionable
diagnostics. Duplicate delivery must be idempotent; late events must not reopen
or mutate a terminal attempt. In a runner-owned worktree, tool hooks deny
execution from a competing session or from the completed owner. Hooks return
neutral responses outside runner scope and never grant broader permissions.

This is local lifecycle evidence, equivalent in trust boundary to existing
local worker reports; it is not authentication against a malicious process
running as the same OS user. Hook failures/timeouts must never create successful
completion evidence even if the host continues execution.

## Execution and completion

### Copilot CLI

Probe the installed CLI version/help for every required flag. Invoke the modern
standalone `copilot`, not the legacy `gh copilot` command. Use programmatic prompt
mode, the selected model, an exact reserved session UUID, and documented explicit
tool/path permissions. Pass prompts without shell interpolation. Do not add a
blanket allow-all setting or change user permission preferences.

Keep the child supervised as with other CLI harnesses. Successful completion
requires a matching observed hook session, an accepted report, terminal lifecycle
evidence, and a zero process exit. Early exit, absent hooks, cancellation,
unrecoverable error, wrong identity, or missing report retains resources and
prevents integration. Use exact-ID session reopening only after capability and
identity checks; never use a most-recent-session shortcut.

### VS Code Copilot

Launch a fresh editor chat for the assigned worktree with the runner custom
agent and nonce-bearing prompt. Do not reuse an arbitrary active editor window.
Use native commands only. Worktree/session handshake is mandatory even if the
launcher reports success; the launcher does not prove which workspace or
harness received the request.

The runner supervisor remains alive, records its own process identity, logs
launcher diagnostics separately, and waits for durable hook evidence. A zero
launcher exit records dispatch only. It never sets worker exit success.

Completion requires a matching root stop event after an accepted report, with no
recorded unrecoverable lifecycle error or cancellation. This records **agent turn
completion**, not editor process exit. The editor may remain open. Represent this
completion source explicitly; do not mislabel it as an editor child exit. Shared
feature/integration checks must accept the supervised hook completion contract
without weakening existing CLI exit requirements.

Stopping without a report is unsuccessful. An accepted blocked/failed report
retains its outcome. A recoverable tool error alone does not invalidate a later
successful result. A crash, disabled hooks, missing handshake, or deadline expiry
produces an unsuccessful/uncertain result; it never triggers redispatch. Keep
resources when editor activity cannot be proven stopped. Cleanup/retry must not
treat supervisor death as proof that the editor agent stopped.

## Recovery, status, and compatibility

Show harness, dispatch state, confirmed session, report, completion source,
timeout/error, and retained logs in status and existing dashboard details.
Normalize available hook activity without making it task-completion authority.

For CLI, attach can expose an exact confirmed session command. For VS Code,
attach focuses/opens the assigned worktree and identifies the saved chat session;
it does not submit another prompt. Advertise `exactResume: false` unless a
documented exact-session interface is implemented and verified. Explain how to
find the existing chat manually; do not claim that opening the worktree resumes it.

Separate supervisor liveness, launcher status, and actual agent terminal evidence
in persisted state. Extend decoders with optional/additive fields and harness
policies. Legacy attempts preserve their existing Codex/Claude rules. New fields
must not cause historical attempts to acquire stricter requirements retroactively.
Review linked-component inspection, export evidence, and cleanup readers for the
same assumptions; all entry points must use the same completion decision.

## Verification and acceptance

Use behavior tests with temporary repositories and fake `copilot`, `code`, and
hook delivery. Cover both new harnesses for implementation, managed review and
repair, delegated settings, successful integration, and failed integration gates.
Required adversarial/recovery cases include:

- Launcher exit before agent completion and report before stop.
- Wrong worktree, wrong session, wrong nonce, another editor window, subagent
  events, duplicate hooks, stale hooks after retry, and competing root sessions.
- Missing report, missing hooks, partial/malformed input, bounded waits,
  cancellation, recoverable tool failure, unrecoverable failure, supervisor crash,
  late stop, uncertain editor liveness, and retained resources.
- Unsupported flags/options/effort, model selectors remaining surface-specific,
  init preserving user hooks/settings and legacy config, and CLI arguments with
  spaces/Unicode passed without shell interpretation.
- Existing Codex/Claude fixtures and saved-state readers remain compatible.

Run `pnpm test`, package dry-run, and affected `--json`/`--dry-run` commands.
Document real authenticated smoke steps for CLI and VS Code, including observed
identity, worktree, requested model, hook format, reports, and completion gates.
Fake-tool tests cannot establish actual editor compatibility. If a real runtime
is unavailable, label that verification pending rather than claim it passed.

Current environment findings: the checkout was clean before design work; the
baseline TypeScript build cannot resolve `string-width`; the pnpm launcher cannot
fetch its pinned version under current network restrictions; WSL inspection
returns access denied. These are validation constraints to resolve or report,
not reasons to add unrelated product behavior.

## Primary interface references

Third-party interfaces checked on 2026-10-29; project architecture was inspected
locally. Recheck the installed versions during implementation.

- [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Copilot hooks and payloads](https://docs.github.com/en/copilot/reference/hooks-reference)
- [VS Code chat command](https://code.visualstudio.com/docs/configure/command-line#start-chat-from-the-command-line)
- [VS Code native hooks](https://code.visualstudio.com/docs/agent-customization/hooks)
- [VS Code custom agents](https://code.visualstudio.com/docs/agent-customization/custom-agents)
- [VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)

## Builder decisions

The harness IDs, native-hook approach, observed-session gate, explicit editor
completion source, no automatic redispatch, truthful resume capabilities, and
coverage of implementation/review/repair are design decisions. Internal type
names, helper boundaries, exact option spellings/timeouts, log format, and test
fixture organization remain with the implementer. Runtime incompatibilities
must result in clear unsupported/readiness diagnostics, not a weaker success
gate or silent substitution of Copilot CLI for an editor worker.
