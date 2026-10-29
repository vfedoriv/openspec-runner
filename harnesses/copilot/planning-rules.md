harness: copilot
revision: 2026-10-29

# GitHub Copilot CLI planning

Select an explicit model available to the authenticated standalone `copilot` CLI.
Model discovery is non-exhaustive. Do not inherit a Codex session model or set
effort: this adapter does not expose a verified effort option. Configure narrowly
reviewed allowedTools for unattended work; the runner never grants all tools.
Installed hooks and exact UUID session selection are required. Use a more capable
available model for uncertain debugging and durable-state changes; diagnose
permissions, context, and verification failures before changing the model.
