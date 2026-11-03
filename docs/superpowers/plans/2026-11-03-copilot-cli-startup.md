# Copilot CLI startup correction

Scope: maintenance priority 1, authorized on 2026-11-03.

Use the installed CLI's new prompt-mode contract rather than reserving a UUID.
Keep root ownership in the nonce lease; preserve report, stop, process-exit, and
uncertain-termination gates. Do not reinterpret historical attempt identities.

- [x] Verify installed help and reproduce the old invocation failure in a regression test.
- [x] Update `src/harnesses/copilot.ts`: required prompt/trust capabilities,
  no reserved ID for new sessions, and observed-session `--resume`.
- [x] Update `copilot-supervisor.ts` to reject legacy reserved attempts before launch.
- [x] Exercise observed identity through the four-harness lifecycle fixture;
  cover capabilities, root nonce ownership, completion ordering, and termination.
- [x] Update operator limits and recovery instructions.
- [x] Complete authenticated implementation/integration and managed review execution
  through the production launcher after installing OpenSpec 1.15.0 with user
  authorization. See the [live record](../../REAL_WINDOWS_HARNESS_ACCEPTANCE.md#copilot-production-launcher-follow-up--2026-11-04).
  The reviewer found a fixture CRLF issue; its final phase is `fixing`, not completed.

Retain the existing Windows/Linux test and package checks. No global trust,
permissions, tool grants, or authentication settings are changed by the adapter.
