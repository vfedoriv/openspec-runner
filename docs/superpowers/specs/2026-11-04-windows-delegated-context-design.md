# Windows delegated context protection

Date: 2026-11-04
Status: Deferred at the user's request. Filesystem approach was selected, but
the runtime-root boundary was not approved. No implementation was started.
Revisit the protection boundary before resuming; this is not an active plan.

## Intent and scope

Enable native Windows component assignment import and execution for the existing
Codex/Claude shared-record contract. The user selected Windows delegation first
and filesystem access rules as the protection mechanism. Shared Copilot record
support remains a separate follow-up.

Import must preserve the approved bytes and prevent ordinary worker filesystem
operations from modifying, adding, renaming, deleting, or replacing pinned
context. Reopening an assignment must verify protection and content before
dispatch. Failed or uncertain verification blocks execution.

This matches the existing owner-controlled POSIX protection boundary. It is not
isolation from a hostile account owner deliberately changing permissions, an
administrator using privilege overrides, or modification of the runner itself.
The repository and runtime metadata remain trusted, as they are today.
Specifically, moving, deleting, redirecting, or changing the ACL of the runtime
root (`.git/openspec-runner`) or its repository ancestors is outside this boundary.
Preventing an account owner from replacing that root would require restricting
its `.git` parent and is not part of this change. Normal worker access to pinned
files and the context hierarchy beneath that trusted root is covered.

## Approaches

1. **Filesystem access rules — selected by the user.** Apply and verify Windows
   DACL restrictions under the runner-owned context hierarchy. This supports both
   current shared harnesses and requires native negative-operation tests,
   interrupted-import recovery, and explicit restoration handling.
2. **Harness-only protection — not selected.** Extend the Codex restricted profile
   to make context read-only. This would leave Claude delegation unsupported and
   would make the shared contract depend on one harness's permission mechanism.
3. Read-only attributes or Windows chmod alone cannot enforce directory mutation
   restrictions and do not satisfy the contract.

## Protection policy

Use a platform module for protection, verification, and scoped restoration.
Retain the existing POSIX behavior. Windows uses the current process identity;
it requires no additional account, elevation, ownership transfer, global policy,
or permissions changes outside runner-owned paths.

Materialize the exact approved inventory, rejecting redirected paths and
unexpected entries. Protect files against writes and deletion, and directories
against additions, renames, deletion, and child replacement. Check parent
delete-child authority as well as each object's delete authority. Protect the
necessary context ancestor chain within the runner state directory while keeping
unrelated runtime records, reports, locks, and future assignments usable. Do not
alter the repository's `.git` directory ACL or broader user directories.
The runtime root may receive a non-inheriting delete-child restriction to protect
its context child; its own replacement through `.git` is the trusted-root boundary
described above. Verification rejects a redirected runtime root, but this does
not promise protection against a concurrent actor replacing trusted metadata.

Resolve the current SID and inspect explicit and inherited access rules using
Windows security APIs through a fixed, noninteractive PowerShell helper. Pass
paths as data, never interpolated executable expressions. All child processes
are hidden and bounded. Failure to read or establish the required rules is an
unsupported capability, not permission to fall back to attributes.

Native tests must demonstrate that both object and parent permissions enforce
the policy for the same user identity that launches workers. Verification must
check effective policy, current identity, path safety, and approved file bytes;
merely recognizing a saved fingerprint or finding a deny rule is insufficient.

The builder may choose the exact rights masks and helper layout, subject to
these tests and constraints. Unsupported volumes or account configurations must
return an actionable reason and never start a worker.

## Import, persistence, and recovery

Keep the existing inspect/import token and assignment approval semantics. Probe
native protection capability using disposable runner-owned paths before creating
an execution reservation. A capability result does not replace verification of
the materialized assignment.

Record restoration evidence before each ACL mutation, using additive local
runtime metadata outside the protected context. Do not add host ACL details to
portable coordination records or change assignment digests. Existing non-Windows
bindings remain readable with their original protection checks. Existing Windows
reservations must not become ready merely because the platform guard is removed.

Do not mark a binding ready or permit dispatch until the complete context and
ancestor policy is verified. Recovery from a partially protected import must
verify existing bytes and resume the same assignment without refreshing Store
context, silently repairing tampered ready bindings, or changing approval.

Shared ancestor rules must be idempotent across assignments. Restoring one
assignment must not relax another assignment's protection. A restoration helper
may remove only recorded runner-owned rules after checking current path and ACL
identity; unexpected changes stop restoration. No automatic context deletion,
new assignment retirement command, or general cleanup expansion is included.
Fixture cleanup explicitly restores its own protection before removing its
verified disposable root.

## Acceptance and documentation

- Native Windows tests prove reads succeed and writes, appends, creation,
  rename, delete, replacement, and directory redirection fail for protected paths.
- Include nested files, multiple pinned references and assignments, inherited
  parent delete rights, spaces/non-ASCII paths, ACL tampering, changed content,
  unsupported capability, and interrupted protection/restoration.
- Run delegated import, implementation, integration, review/repair, report,
  recovery, and submission tests on Windows with portable fake tools. Remove
  delegated skips only for scenarios actually supported by the new policy.
- Verify existing Codex Windows permissions still allow necessary Git/report
  writes while context mutation fails. Exercise both Codex and Claude workers;
  record simulated and authenticated acceptance separately.
- Run the required full Windows suite, Linux regression suite, build, package
  dry run, and affected CLI JSON/dry-run checks. Preserve local-worker behavior.
- Update current limits and verification guides with exact supported scope and
  remaining gaps; retain dated historical evidence.

## References

- [Current component import](../../../src/component.ts)
- [Binding validation](../../../src/feature-state.ts)
- [Windows portability design](2026-10-29-windows-portability-design.md)
- [Microsoft file access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
- [Microsoft access control and owner authority](https://learn.microsoft.com/windows/security/identity-protection/access-control/access-control)
