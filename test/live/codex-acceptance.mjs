import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { init } from "../../dist/cli.js";
import { Feature } from "../../dist/feature.js";
import { getHarness } from "../../dist/harnesses/registry.js";
import { Runner } from "../../dist/runner.js";
import { git, run, shellCommand } from "../../dist/system.js";

const change = "verify-runner";
const task = "1.1";
const usage = "node test/live/codex-acceptance.mjs <archive|credentials|resume> --model MODEL";

function fixture(root, model) {
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Runner Acceptance");
  git(root, "config", "user.email", "runner-acceptance@example.invalid");
  run("openspec", ["init", "--tools", "none", "--no-animation"], root, 30000);
  init(root, "codex");
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
  write("tasks.md", "## 1. Greeting\n\n- [ ] 1.1 Create greeting.txt containing exactly HELLO followed by one LF. Verify its bytes with Node, commit, and report.\n");
  write("execution.yaml", JSON.stringify({ version: 1, tasks: { [task]: { model, reasoningEffort: "low" } } }));
  writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(root, "openspec/runner.yaml"), JSON.stringify({
    version: 1, defaultModel: model, worktrees: "git", terminal: "manual", cleanup: "manual",
    verifyIntegration: [[process.execPath, "-e", "const fs = require('node:fs'); if (fs.readFileSync('greeting.txt', 'utf8') !== 'HELLO\\n') process.exit(1)"]],
  }));
  git(root, "add", ".");
  git(root, "commit", "-m", "Prepare disposable acceptance fixture");
}

async function archive(root, model, runner) {
  const feature = new Feature(root);
  const role = { harness: "codex", model, effort: "low" };
  const settings = { implementation: role, review: role, repair: role };
  feature.start(change);
  feature.approve(change, settings, feature.planPreview(change, settings).token);
  const [attempt] = runner.launch(change, [task]);
  const result = await runner.worker(change, task, attempt.id);
  assert.equal(result.exitCode, 0, `Inspect worker log ${result.log}`);
  runner.integrate(change, [task]);
  const review = feature.launch(change, "review");
  const reviewed = await feature.worker(change, review.id);
  assert.equal(reviewed.exitCode, 0, `Inspect reviewer attempt ${review.id}`);
  const preview = feature.finalPreview(change);
  feature.approveFinal(change, preview.token);
  const completed = feature.archive(change);
  const path = preview.archive.worktree;
  assert.equal(feature.status(change).phase, "completed");
  assert.equal(git(path, "rev-parse", "HEAD"), completed.head);
  assert.equal(git(path, "rev-parse", "HEAD^"), preview.head);
  assert.equal(readFileSync(join(path, "greeting.txt"), "utf8"), "HELLO\n");
  assert.equal(existsSync(join(path, "openspec", "changes", change)), false);
  assert.ok(existsSync(join(path, "openspec", "specs", "greeting", "spec.md")));
  assert.equal(feature.archive(change).archive.commit, completed.head);
  return { attempt: attempt.id, review: review.id, commit: completed.head, worktree: path };
}

async function credentials(root, model, runner) {
  const home = mkdtempSync(join(root, ".git", "empty-codex-home-"));
  writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  process.env.CODEX_HOME = home;
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN", "CODEX_AUTH_TOKEN"])
    delete process.env[key];
  const [attempt] = runner.launch(change, [task], { model, reasoningEffort: "low" });
  const result = await runner.worker(change, task, attempt.id);
  assert.ok(Number.isInteger(result.exitCode) && result.exitCode !== 0, `Expected a failed process exit. Inspect ${result.log}`);
  const failure = readFileSync(result.log, "utf8").split(/\r?\n/)
    .findLast(line => line.startsWith('{"type":"turn.failed"'));
  assert.match(failure ? JSON.parse(failure).error?.message ?? "" : "", /unauthori[sz]ed|\b401\b|missing (?:an? )?api key|not logged in|authentication (?:failed|required)|invalid api key/i,
    `Worker failure must identify missing credentials. Inspect ${result.log}`);
  const state = runner.read(change);
  assert.equal(runner.latest(state, task).phase, "failed");
  assert.equal(runner.latest(state, task).report, undefined);
  assert.throws(() => runner.integrate(change, [task]), /needs a completed report/);
  assert.equal(runner.read(change).head, state.head);
  return { attempt: attempt.id, exitCode: result.exitCode, log: result.log };
}

function resume(root, model, runner) {
  const [attempt] = runner.launch(change, [task], { model, reasoningEffort: "low" });
  const marker = `runner-${randomUUID()}`;
  const events = (args, label) => {
    const output = run("codex", args, attempt.path, 180000);
    writeFileSync(join(runner.repo.common, `${label}.jsonl`), output + "\n");
    return output.split(/\r?\n/).map(line => JSON.parse(line));
  };
  const first = events(["exec", "--json", "--model", model, `Remember this token and reply with only the token. Do not use tools. Token ${marker}`], "resume-initial");
  const session = first.find(event => event.type === "thread.started")?.thread_id;
  assert.match(session ?? "", /^[a-f0-9-]{36}$/i);
  const bound = new Runner(attempt.path).begin(change, task, attempt.id, session);
  const attached = runner.attach(change, task);
  const harness = getHarness("codex");
  let invocation = harness.resumeInvocation(attempt.settings, attempt.path, runner.repo.common, session);
  invocation = harness.managedInvocation(invocation, { common: runner.repo.common, gitDir: attempt.gitDir, branch: attempt.branch });
  assert.equal(bound.session, session);
  assert.equal(attached.attempt, attempt.id);
  assert.equal(attached.command, shellCommand([invocation.executable, ...invocation.args]));
  const resumed = events(["exec", "resume", "--json", "--model", model, session, "Reply with only the token from my first message. Do not use tools."], "resume-confirmed");
  assert.equal(resumed.find(event => event.type === "thread.started")?.thread_id, session);
  assert.ok(resumed.some(event => event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text.trim() === marker));
  return { attempt: attempt.id, session, interactiveCommand: attached.command, expectedToken: marker, worktree: attempt.path };
}

const { positionals: [scenario, ...extra], values } = parseArgs({ allowPositionals: true, options: {
  model: { type: "string" }, help: { type: "boolean", short: "h" },
} });
if (values.help) {
  console.log(usage);
} else {
  const scenarios = { archive, credentials, resume };
  if (!Object.hasOwn(scenarios, scenario) || extra.length || !values.model?.trim() || /[\0\r\n]/.test(values.model)) throw new Error(usage);
  // A standalone CLI must not inherit the desktop session's Core transport.
  for (const key of ["CODEX_THREAD_ID", "CODEX_WINDOWS_REGISTERED_CORE", "CODEX_APP_RUNTIME_CLI_PATH", "CODEX_APP_TOOLS_PIPE_PATH"])
    delete process.env[key];
  const root = mkdtempSync(join(tmpdir(), `runner-live-${scenario}-`));
  console.log(`Fixture ${root}`);
  fixture(root, values.model);
  const result = await scenarios[scenario](root, values.model, new Runner(root));
  console.log(JSON.stringify({ scenario, root, ...result }, null, 2));
}
