# Windows portability layer scope

Date: 2026-10-29
Status: Implementation approved; native verification and live acceptance are tracked in `docs/WINDOWS_PORTABILITY_VERIFICATION.md`.
Baseline: Copilot implementation `32fdba3`, integrated into local `dev`.

## Intent

Run the existing task and managed-feature lifecycle natively on Windows for
every supported harness: Codex (`codex`), Claude Code (`claude`), GitHub Copilot
CLI (`copilot`), and VS Code Copilot (`copilot-vscode`). Use Git worktrees and
manual terminals initially. Preserve each harness's session ownership, report,
completion, approval, model/effort, and recovery guarantees.

The user requested that the existing Copilot changes first be committed in dev,
then a Windows portability plan be created. This document records that plan's
requirements; platform and API choices below are proposals for implementation.
The user clarified that Windows portability must cover all supported harnesses;
Codex and Claude Code are required scope, not optional follow-up work.

## Evidence from this machine

- Windows Node 24.21.0 builds the project. Eight Copilot unit tests passed;
  four process/integration cases were skipped on Windows.
- Outside restricted execution, Copilot CLI 1.0.105 is installed and passes the
  adapter's flag probe. VS Code 1.144.0 provides the required chat options.
- The ordinary execution environment did not expose the user's installed PATH.
  Missing commands there did not establish that the software was absent.
- Node's direct `code` invocation fails with ENOENT, while the installed
  `code.cmd` works when invoked explicitly from PowerShell.
- The installed code.cmd starts Code.exe with ELECTRON_RUN_AS_NODE=1 and a
  versioned resources/app/out/cli.js path. Do not assume a fixed installation
  subdirectory across VS Code updates.
- State-file fsync and rename pass; directory fsync fails with EPERM, including
  outside restricted execution.
- CLI and dashboard explicitly reject Windows. Process identity/recovery uses
  Linux /proc. Generated commands use POSIX quoting. Tests rely on shell glob
  expansion, shebang executables, chmod, and POSIX process behavior.

These observations establish portability work, not authenticated end-to-end
compatibility for any harness. Codex and Claude Code Windows installation and
authentication have not been verified in this investigation. All four harnesses
require their own disposable native smoke tests for their actual protocols.

## Approach and boundary

Keep a shared coordination core and introduce platform-specific filesystem,
command, path, and process boundaries. This is preferable to removing the guard
alone (which leaves known failures) or requiring a Windows-to-WSL bridge (which
does not provide the requested native execution).

Initial validation targets local Windows x64/NTFS, supported Node >=22.13,
Git for Windows, and PowerShell. Git worktrees and manual terminals are the
first supported resource combination. Worktrunk, Herdr, and Orca on Windows
remain explicitly unsupported until their own native contract tests pass.
Existing Linux/WSL behavior must continue to pass its full suite. All four
harnesses are first-release Windows targets. Do not infer one harness's runtime
compatibility from another's smoke test. Missing authentication or an unavailable
installed tool marks its live verification pending; it does not remove that
harness from implementation or automated acceptance scope.

## Required harness contracts

| Harness | Native Windows contract |
|---|---|
| Codex | Resolve native/package-installed CLI; execute workers and model-discovery app-server with literal argv; register the actual CODEX_THREAD_ID; retain supported model/effort and calling-session behavior; require the existing accepted-report/process-exit gates; resume only the exact saved session. |
| Claude Code | Resolve native/package-installed CLI; preserve stdin prompts, stream-json decoding, reserved/observed UUID equality, permission/tool/add-directory arguments and supported effort; exclude inherited CODEX_THREAD_ID; require matching successful stream result plus supervised exit before integration; resume only the confirmed UUID. |
| Copilot CLI | Resolve native/package-installed CLI; retain exact reserved session, hook ownership, report-before-root-stop ordering, explicit tools/paths, zero process exit, and confirmed-session resume. |
| VS Code Copilot | Resolve the selected installation/profile; discover the correct custom agent/model; retain hook ownership and explicit agent-stop completion independent of launcher exit; attach must not fabricate exact chat resume. |

Use the same platform command/process/path boundaries for all four. Never force
Codex or Claude through the Copilot hook protocol. Preserve homogeneous batches
and explicitly approved different harnesses for implementation/review/repair roles.

## Required behavior

1. Preserve file-data flushing and atomic replacement. Treat only the documented
   Windows directory-flush limitation as a reduced crash-durability guarantee;
   propagate real write, file-flush, replacement, and permission errors. Keep
   immutable record publication exclusive, rather than replacing existing data.
2. Resolve executables for the selected host, explicit executable, and editor
   profile. Preserve argument arrays and literal prompts. Prefer direct native
   or Node/Electron entry points over introducing shell interpretation. Unsupported
   wrappers must report an actionable configuration error, not silently run a shell.
3. Render operator-facing commands for PowerShell on Windows and POSIX shells
   on Linux. Hook launch commands must address the correct installed runner
   on the agent host, independently of a reused editor window's inherited PATH.
4. Observe Windows PID plus creation identity, detect PID reuse and descendants,
   and confirm termination of owned worker processes. Unknown identity or editor
   liveness blocks retry/cleanup. Launcher exit never means editor completion.
5. Normalize paths for comparisons while retaining original display paths.
   Canonical containment must not accept prefix collisions, junction escapes,
   redirected worktrees, alternate data streams, or traversal aliases. Do not
   lowercase portable Git paths or case-sensitive filesystem paths globally.
6. Preserve pinned delegated-context protections with a platform-specific
   contract. Windows chmod/mode bits do not establish POSIX directory protection.
   Until a native equivalent is implemented and verified, reject delegated
   execution explicitly while permitting the supported local workflow.
7. Discover test files in Node and use portable fake tools. Native persistence,
   launch, hook, process, recovery, integration, and cleanup tests must execute
   on Windows rather than pass through blanket skips.
8. Replace global Windows guards only after required contracts pass. Reject
   unsupported resource combinations before creating worktrees or starting agents.

## Compatibility and acceptance

Persisted schema changes are additive. Historical Linux attempts retain their
original process identity interpretation; records with missing platform metadata
are uncertain on a different host, not eligible for automatic cleanup. No
automatic path migration, session substitution, permission widening, or redispatch.

Acceptance requires native fake-worker implementation/review/repair and recovery
tests, unchanged Linux/WSL regressions, package verification, Windows JSON/dry-run
checks, and an authenticated disposable task with each of the four harnesses.
Report requested versus independently observed models accurately. Live-tool tests
must preserve the user's normal project, editor settings, hooks, and authentication.

The implementer can settle helper internals and diagnostic wording. Any expansion
to optional terminal backends, remote shares, or weaker ownership/durability
guarantees must be raised separately, not hidden inside the platform enablement.
