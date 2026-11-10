# Native Windows component delegation

Use a local NTFS component checkout, PowerShell 7.2 or newer, and an installed Codex or
Claude CLI that supports the assignment's approved settings. The shared-record
contract accepts Codex and Claude. Follow the normal [team workflow](team-workflow.md)
to inspect, import, implement, review, and export an assignment.

Run the coordinator and workers in a standard Windows session. Git Bash can
enable backup and restore privileges when the caller has them, so the runner
refuses delegated work from tokens that carry either privilege.

On Windows, stop recorded workers sharing the component checkout before
confirming import. An inspected assignment reserves execution only after the
runner proves that Windows can enforce the context permissions. Import pins the
approved Store files and references, then verifies the exact inventory, bytes,
and effective NTFS permissions before publishing readiness. Inspection and
dry-run remain read-only.

The protected files remain readable. Windows blocks ordinary writes, additions,
renames, deletion, and replacement, including from Codex's separate sandbox
identity. The runner trusts its account owner, Git
metadata, and the `.git/openspec-runner` directory itself. Its ACL policy covers
the context hierarchy under that directory. Deliberate permission changes,
runtime-root replacement, and administrator overrides are outside the boundary.

## Recover an interrupted import

Retry the same confirmed import to finish a recognized partial state. Keep the
local protection journal under `component-protection` beside the runner state.
If a crash leaves a stale repository lock, verify that the coordinator and its
Windows protection helper have exited before clearing the lock and retrying.
If the runner reports unexplained ACL or byte changes in a reservation, retain
the evidence and import in an independent clone. A ready binding can be used
again after the operator restores the exact recorded permissions and approved
bytes. Retirement retains its pinned context and protection journal.

Codex can add access entries for its sandbox accounts. Verification accepts
additive entries that preserve the sealed permissions, and checks the same
effective deny rules and file contents again before using the context.

## Verify the local environment

The native acceptance fixtures exercise NTFS access and a controlled delegated
lifecycle with Git worktrees and manual terminals. Live checks use disposable
repositories and the installed harness. Record backend combinations separately.

From a source checkout, build the runner and use an authenticated harness model
to run either fixture. The driver retains the repository and worker evidence.

```powershell
pnpm run build
node test/live/windows-delegation.mjs codex --model MODEL
node test/live/windows-delegation.mjs claude --model MODEL
```

Add `--probe-only` to the Codex command to check the installed sandbox without
making a model request. It must read the approved bytes, reject a writable
open, and allow a disposable file in the runner runtime to be replaced and
deleted.

## Native acceptance on 2026-11-07

The native runs used Codex 0.167.0, Claude Code 2.1.312, and OpenSpec 1.15.0.
Git worktrees and manual terminals are the verified backend combination.

The authenticated Claude fixture completed implementation, review, and
receipt export with Git worktrees and manual terminals. Its worktree command
read the approved bytes and received an access-denied error on a writable open.
Fixture `runner-live-windows-claude-yowt7q` retained receipt commit
`aa735f8a708c82a4337b178486b4e4c8477071c0`.

The authenticated Codex fixture passed the same worker probe and completed
implementation, review, and receipt export. Fixture
`runner-live-windows-codex-mepNUh` retained receipt commit
`95ed54805adc8d107c454e82dce0bc2b27f17026`.

The installed Codex sandbox passed the same read and write-denial probe. It
also replaced and deleted a disposable runtime file. The runner verified that
the sandbox's added ACL entries preserved the context protection. Fixture
`runner-live-windows-codex-YWpTT7` retained the sandbox output.

The Windows suite passed 303 tests with 122 skips. Its controlled delegated
fixture exercised interrupted import, task integration, review, repair, and
export. The Linux suite passed 404 tests with 24 skips. Package dry run
included the Windows protection helper.
