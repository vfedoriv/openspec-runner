harness: claude
revision: 2026-09-14
last_reviewed: 2026-09-14
evidence: Claude Code CLI documentation for haiku/sonnet/opus aliases and stream-json print mode; rankings are guidance, not a benchmark.

# Claude Code planning rules

Rule H1 — Mechanical or narrow documentation changes: prefer `haiku` and omit
effort unless the installed CLI explicitly supports a compatible effort setting.
Use `sonnet` when the edit affects generated output, a public contract, or tests
are weak.

Rule H2 — Routine implementation with clear boundaries and useful tests: use
`sonnet` and omit effort so the CLI/model default remains authoritative. Prefer
`haiku` for genuinely mechanical work with strong tests and `opus` when the
routine task has unusually broad context.

Rule H3 — Uncertain debugging or changes spanning modules: use `sonnet` first,
with a reproduced failure and focused verification. Escalate to `opus` when the
cause crosses repository boundaries, remains unclear after reproduction, or a
previous attempt failed for reasoning rather than access.

Rule H4 — Migrations, concurrency, security, and durable state/recovery: prefer
`opus`, omit effort unless capability discovery documents a supported value, and
require explicit crash-window, permission, and persistence tests. Do not use an
effort flag as a substitute for clear requirements or evidence.

Rule H5 — After an unsuccessful attempt, diagnose missing permissions, context,
or verification before changing aliases. Preserve the selected Claude harness;
never substitute Codex. If an alias changed or availability cannot be verified,
mark the recommendation unverified and ask for an explicit supported model.

Explicit user model/cost/latency preferences and project constraints win over
these recommendations when the CLI accepts the choice. Claude model discovery
is intentionally non-exhaustive; `haiku`, `sonnet`, and `opus` are examples, not
an entitlement list.

