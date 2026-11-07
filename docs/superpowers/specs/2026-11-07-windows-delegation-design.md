# Native Windows delegated execution

## Decision and scope

Enable native Windows component assignment import and execution on supported
local NTFS checkouts for the existing Codex and Claude shared-record contract.
The selected approach applies NTFS permissions under the runner's trusted
runtime. It lets a worker read approved Store context and blocks ordinary
filesystem operations that would change or substitute that context. It requires
the existing Windows account and runner installation.

The boundary trusts `.git/openspec-runner`, its repository ancestors, runner
metadata, and the account owner. Deliberate permission changes, replacing or
redirecting the runtime root itself, and administrator overrides are outside
this boundary. Existing operator approval, Git handoff, assignment digests,
and Copilot shared-record rules stay in their current workflows.

## Approaches considered

- **Trusted runtime with NTFS permissions**, selected. One filesystem policy
  applies to both shared harnesses. The implementation must account for parent
  deletion rights and recover interrupted permission changes.
- **Separate worker identity.** Stronger isolation would require provisioning a
  restricted Windows identity, configuring harness authentication for it, and
  handing reports back to the coordinator. That is a separate deployment model.

## Protection and verification

Add a Windows protection adapter behind the existing delegated context import
and verification paths. Retain POSIX behavior. Use bounded, noninteractive
Windows security API calls under the runner account, with paths passed as data.
Limit changes to the local runtime and reject unverified filesystems or account
configurations with an actionable diagnostic.

Native acceptance requires two details. Deny rules cover all ordinary Windows
identities so they also cover the Codex sandbox account. Require coordinator and
worker tokens without backup or restore privileges, which Git Bash can enable
automatically when the caller has them. Verify the recorded ACL rules and accept
only additive sandbox entries that preserve the protected rights.

- Match the approved inventory and bytes for the primary contract and all
  references. Reject unexpected files, reparse points in the runtime or context
  chain, and Windows path aliases such as case collisions, alternate data
  streams, and reserved device names before materializing files.
- Protect files and assignment directories against writes, appends, creation,
  renames, deletion, replacement, and directory redirection. Verify both object
  deletion and the parent's delete-child rights. The shared ancestors under the
  runtime must still allow new feature and assignment directories. The runtime
  root can receive a non-inheriting delete-child restriction while preserving
  ordinary updates to state, reports, and locks. Leave its `.git` parent ACL
  alone.
- Reuse the delegated-binding gate for implementation, review, repair, and
  export. Verify the active account, effective protection, path identity,
  inventory, and content before dispatch or use. A saved marker or an ACL rule
  by itself cannot establish effective protection.

## Import and recovery

Keep inspection and dry-run read-only. On confirmed import, probe enforcement
on disposable runner-owned paths before reserving the assignment. Under the
repository lock, save the reservation and a local recovery journal before
applying permission changes. Persist and verify original ACL and expected
runner change evidence before mutating each target. The journal carries local
details only and does not enter shared records or affect approval tokens.
For Windows, check that all recorded local workers sharing the runtime have
stopped before materialization. Hold the repository lock through materialization
and protection verification so the runner cannot start another worker while
the context is still writable.

Materialize and verify the exact approved inventory before sealing it. A failed
or interrupted import leaves a non-dispatchable reservation. A retry with the
same approved import may finish a known partial state. Unrecognized ACL or
content changes stop recovery. For an unrecognized reservation, retain the
original evidence and use an independent clone to import the assignment again.
A ready binding whose protection changes fails verification. It can pass again
after the operator restores the exact recorded protection and approved bytes.
Launch and import perform verification only for an already-ready binding.

Publish readiness only after the feature binding and complete protection have
been verified. Shared ancestor changes are idempotent across assignments.
Restoration may undo only journaled changes after verifying the path and ACL.
It must preserve rules still needed by other assignments. Retirement retains
the pinned context and its protection. This design adds no recovery command.

## Acceptance gate

Keep the Windows execution guards until the native protection and delegated
lifecycle tests pass. Test access as the worker's Windows identity, including
reads, blocked mutation and replacement, parent delete-child permissions,
multiple assignments and references, changed ACLs or bytes, redirected paths,
interrupted import, and operation of unrelated runtime files.

Verify Windows assignment import through implementation, integration, review,
repair, and export with controlled workers, then record separate live Codex
and Claude results. Run the Windows and POSIX regression suites and exercise
the affected CLI previews. The implementation can choose exact rights masks,
journal layout, and helper structure within the approved boundary.
