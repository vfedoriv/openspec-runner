# Native Windows delegated execution implementation plan

> Use the approved trusted-runtime boundary and keep the execution guards until the native acceptance gate passes.

**Goal** Enable the existing Codex and Claude delegated lifecycle on verified local NTFS checkouts.

**Spec** [Native Windows delegated execution](../specs/2026-11-07-windows-delegation-design.md)

- [x] Add native tests that distinguish readable context from denied mutation, including parent delete rights and ACL restoration.
- [x] Add a bounded Windows helper for NTFS preflight, exact ACL preparation, application, and effective access checks. Pass paths through structured input.
- [x] Validate the Windows inventory and persist recovery evidence before protection changes. Keep ready verification read-only and prove interrupted imports can resume from recognized state.
- [x] Wire verified protection into import and every delegated execution gate. Serialize import materialization against worker dispatch and preserve POSIX bindings.
- [x] Exercise delegated Windows import through export, including report and review or repair, using controlled workers. Run native Codex and Claude acceptance and record actual results separately.
- [x] Run Windows and POSIX regressions, affected CLI previews, and package inspection. Document the verified host scope and remaining limits.

## Review focus

- Separate rights on the object and its parent, including deletion from a permissive parent.
- Shared ancestor rules across assignments and ongoing atomic writes to runner records.
- Malformed inventories, path aliases, and reparse points before materialization.
- Recovery after a partial ACL change and rejection of unfamiliar ACLs or content.
- Active or uncertain workers and any launch or report path that could bypass ready verification.
