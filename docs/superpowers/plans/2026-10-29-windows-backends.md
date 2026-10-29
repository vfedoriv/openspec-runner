# Windows Backends Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; perform one fresh whole-change review at the end.

**Goal:** Enable verified native Windows Worktrunk, Herdr, and Orca resource adapters for every harness.

**Architecture:** Extend existing adapters and shared native command/path boundaries. Prefer `git-wt` and use PowerShell 7 for owned Windows terminal commands; retain Unix command semantics and all ownership gates.

**Tech Stack:** TypeScript, Node >=22.13, Git, installed backend CLIs, node:test.

**Spec:** `docs/superpowers/specs/2026-10-29-windows-backends-design.md`.

## Constraints and review focus

No bare Windows `wt`, no global PATH/config changes, no existing terminal
termination, no automatic redispatch after ambiguous creation. Preserve all
four harness protocols and the delegated-context gate. Check literal shell
arguments/exit status, exact worktree base and paths, runtime/session identity,
partial creation, and cleanup after acknowledged worker exit.

### Task 1: Worktrunk selection and native resource enablement

- [x] Add failing tests proving `git-wt` selection avoids Windows Terminal and explicit Worktrunk works with native paths; preserve Unix fallback.
- [x] Replace OS-only backend rejections with existing capability/session gates. Keep Windows automatic worktrees on Git.
- [x] Port installed Worktrunk acceptance to native executable fixtures and isolated config; verify explicit base, idempotent recovery, and no project hooks.
- [x] Build and run Worktrunk, resource capability, and runner backend tests.

### Task 2: Native terminal commands and ownership

- [x] Add failing tests for Orca `--shell pwsh.exe`, literal worker command/exit status, and Herdr native launch. Enable existing fake Orca/Herdr cases on Windows.
- [x] Implement the native terminal command boundary; use canonical paths in Orca and Herdr ownership checks.
- [x] Verify attach without redispatch, partial creation, runtime/session mismatches, exited/live descendants, unrelated panes, and acknowledged cleanup. Preserve Unix behavior.

### Task 3: Installed runtime acceptance and regression

- [x] Verify installed `git-wt`, Herdr, and Orca in disposable repositories/owned terminals. Record versions and actual launch/completion/cleanup evidence. Preserve user resources.
- [x] Run full native Windows and Linux suites, package dry-run, and one fresh review. Fix important findings with regressions.
- [x] Update Windows verification, README, and guides; commit verified changes locally. Clearly record any remaining external runtime blocker.
