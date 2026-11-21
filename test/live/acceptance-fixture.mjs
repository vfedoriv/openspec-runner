import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../../dist/cli.js";
import { git, run } from "../../dist/system.js";
export const change = "verify-runner";
export const task = "1.1";

export function fixture(root, model, { agent = "codex", effort, scenario } = {}) {
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Runner Acceptance");
  git(root, "config", "user.email", "runner-acceptance@example.invalid");
  run("openspec", ["init", "--tools", "none", "--no-animation"], root, 30000);
  init(root, agent, undefined, model);
  const directory = join(root, "openspec", "changes", change);
  mkdirSync(join(directory, "specs", "greeting"), { recursive: true });
  const write = (path, content) => writeFileSync(join(directory, path), content);
  write("proposal.md", `## Why
Exercise the runner in a disposable checkout.

## What Changes
- Add a deterministic greeting file.

## Capabilities
### New Capabilities
- \`greeting\`: A deterministic greeting fixture.

### Modified Capabilities
None.

## Impact
Adds one text file.
`);
  write("design.md", `## Context
A disposable acceptance fixture.

## Goals / Non-Goals
Verify one deterministic change.

## Decisions
Store the greeting as plain text.

## Risks / Trade-offs
The fixture exercises only one task.
`);
  write("specs/greeting/spec.md", `## Purpose
Provide a deterministic greeting for checking the runner's implementation, review, and archive workflow.

## ADDED Requirements
### Requirement: Greeting file
The checkout SHALL contain \`greeting.txt\` with the exact bytes HELLO followed by LF.

#### Scenario: Read the greeting
- **WHEN** \`greeting.txt\` is read
- **THEN** its contents are \`HELLO\` followed by a single LF
`);
  write("tasks.md", "## 1. Greeting\n\n- [ ] 1.1 Create greeting.txt containing exactly HELLO followed by one LF. Verify its bytes with Node, commit, and report." + (scenario === "retry" ? " On the FIRST attempt deliberately report outcome blocked with summary acceptance first-attempt block and do not edit or commit. Inspect openspec-runner status verify-runner --json for retained prior attempts. Only on an explicit retry after a prior blocked report, implement the greeting and report completed." : "") + "\n");
  write("execution.yaml", JSON.stringify(agent === "codex" ? { version: 1, tasks: { [task]: { model, reasoningEffort: "low" } } } : { version: 2, agent, tasks: { [task]: { model, ...(effort ? { effort } : {}) } } }));
  if (scenario === "repair") {
    const specification = join(directory, "specs/greeting/spec.md");
    writeFileSync(specification, readFileSync(specification, "utf8") + "\n### Requirement: Portable greeting line endings\nThe repository SHALL track `.gitattributes` with `*.txt text eol=lf` so greeting checkouts retain LF bytes on Windows.\n\n#### Scenario: Check out on Windows\n- **WHEN** Git checks out greeting.txt with autocrlf enabled\n- **THEN** the tracked LF attribute keeps the exact required bytes\n");
    const tasks = join(directory, "tasks.md");
    writeFileSync(tasks, readFileSync(tasks, "utf8").trimEnd() + " Implement only greeting.txt in this initial task; do not create .gitattributes. The missing LF policy is deliberately reserved for independent whole-feature review and repair.\n");
  } else writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(root, "openspec/runner.yaml"), JSON.stringify({
    ...(agent === "codex" ? { version: 1, defaultModel: model } : { version: 2, defaultAgent: agent, agents: { [agent]: { defaultModel: model, ...(agent === "claude" ? { permissionMode: "dontAsk", allowedTools: ["Read", "Write", "Edit", "Bash"] } : { allowedTools: ["shell", "write"] }) } } }), worktrees: "git", terminal: "manual", cleanup: "manual",
    verifyIntegration: [[process.execPath, "-e", "const fs = require('node:fs'); if (fs.readFileSync('greeting.txt', 'utf8') !== 'HELLO\\n') process.exit(1)"]],
  }));
  git(root, "add", ".");
  git(root, "commit", "-m", "Prepare disposable acceptance fixture");
}
