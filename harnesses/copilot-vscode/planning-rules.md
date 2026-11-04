harness: copilot-vscode
revision: 2026-10-29

# VS Code Copilot planning

Select an explicit model selector recognized by the authenticated editor. CLI
model identifiers are not automatically translated. The custom agent requests
that model; hooks do not attest the observed runtime model. Effort and exact
chat resume are unsupported. Native hooks must run on the same host/filesystem
as the runner. A successful editor launcher exit does not complete a worker.
Require an accepted report and matching root stop event. Retain uncertain editor
workers for inspection rather than redispatching. Verify the installed editor
version, selected agent/model, and hook format using the manual smoke procedure.
