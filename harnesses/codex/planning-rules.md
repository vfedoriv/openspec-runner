harness: codex
revision: 2026-09-14
last_reviewed: 2026-09-14
evidence: Codex CLI model/list metadata and the openspec-runner verification contract; rankings are guidance, not a benchmark.

# Codex planning rules

Rule C1 — Mechanical or narrow documentation changes: use the project's economical
model with `low` or `medium` effort. Escalate when the edit changes generated
content, a public contract, or has weak verification.

Rule C2 — Routine implementation with clear boundaries and tests: use the
configured/session model with its advertised default effort, or `medium` when a
supported explicit effort is required. Increase to `high` for cross-module work.

Rule C3 — Uncertain debugging or changes spanning modules: use a capable model at
`high` effort after reproducing the issue and identifying affected seams. Split
the task first when requirements or ownership are unclear.

Rule C4 — Migrations, concurrency, security, and durable state/recovery: use the
most capable available Codex model at `high` or `xhigh`, require focused tests,
failure-path checks, and review of persisted-state compatibility. Effort is not a
substitute for missing requirements or tests.

Rule C5 — After an unsuccessful attempt, diagnose access, environment, and
verification evidence before changing model or effort. Escalate reasoning only
when the failure is a reasoning/diagnosis problem; missing permissions or context
requires fixing access.

If a model or effort is unavailable or the catalog is stale, keep the assignment
explicitly unverified and ask for a supported choice. Never silently switch
harnesses or invent effort values. Explicit user preferences and project latency
or cost constraints override these recommendations when the selected combination
is supported.

