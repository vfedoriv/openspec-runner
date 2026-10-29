# Native Windows resource backends

Extend the approved Windows layer to installed Worktrunk, Herdr, and Orca.
The user supplied `git-wt` as the unambiguous Worktrunk executable and said
to proceed. Keep all four harness protocols unchanged.

Use the existing resource adapters, with shared platform command/path helpers.
Prefer `git-wt`; on Windows never probe bare `wt`, which can launch Windows
Terminal. Preserve Unix `wt` fallback. Windows automatic worktrees remain Git;
explicit Worktrunk/Orca selections are enabled. Terminal auto-selection follows
the actual caller's Herdr/Orca context, and stays manual outside either host.

Orca Windows terminal creation must explicitly select PowerShell 7, run the
worker with literal argument handling, and exit the owned terminal shell when
the worker exits. Herdr must use a native PowerShell worker invocation that
does not depend on POSIX `exec sh`. Existing terminal/runtime/worktree identity,
ambiguity, partial-creation, completion, and cleanup gates remain mandatory.
Canonical native paths are compared through the shared path boundary.

Verify portable fake-backend contracts natively, then real installed tools in
disposable repositories and owned terminals/sessions. Preserve all existing
user workspaces, settings, profiles, and terminals. Start only test-owned
runtime resources where required; clean them up by recorded exact identity.
Document any real runtime limitation separately from software installation.
Windows delegated component protection remains outside this follow-up.
