# Worker startup readiness

Scope: maintenance priority 3, authorized on 2026-11-04.

Test production dispatch ordering with fast native subprocesses, not fixture
waits for saved PID/lock state. Use Codex exec's documented `-` stdin transport
if the tests show that argument delivery bypasses registration readiness. Keep
existing lock deadlines, session identity, permissions, exit evidence, and
explicit retries. No new supervisor/wrapper process or state schema is needed.

- [x] Add deterministic fast-child, failed-registration, lock-deadline, and
  child-exit tests at the shared supervisor boundary; establish failures first.
- [x] Gate initial Codex/Claude prompt delivery on successful registration.
- [x] Remove PID/lock polling from feature fixtures; make fake backends consume
  the same stdin transport as the actual CLI. Exercise task/review/repair paths.
- [x] Verify Windows permission profiles, activity capture, and resume behavior.
- [x] Run full Windows/Linux suites, real Codex implementation/review smoke,
  package check, and independent review. Update current limits and priorities.

Results: [startup verification](../../WORKER_STARTUP_VERIFICATION.md).
