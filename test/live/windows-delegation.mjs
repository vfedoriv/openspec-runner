import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Coordination } from "../../dist/coordination.js";
import { Feature } from "../../dist/feature.js";
import { validateDelegatedBinding } from "../../dist/feature-state.js";
import { codexWorkerPermissions, validateCodexInvocation } from "../../dist/harnesses/codex-permissions.js";
import { Runner } from "../../dist/runner.js";
import { git, run } from "../../dist/system.js";

const cli = fileURLToPath(new URL("../../bin/openspec-runner.js", import.meta.url));
const usage = "node test/live/windows-delegation.mjs <codex|claude> --model MODEL [--probe-only (Codex)]";
const featureId = "delegation";
const assignmentId = "assignment";
const owner = "live-test";
const change = "verify-delegation";
const sharedChange = "shared-delegation";
const task = "1.1";
const verification = [["node", "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('greeting.txt', 'utf8'), 'HELLO\\n')"]];

function runnerCli(root, ...args) {
  return JSON.parse(run(process.execPath, [cli, ...args, "--json"], root, 180000));
}

function workerCli(root, output, ...args) {
  console.log(`Running ${args.join(" ")}. Output ${output}`);
  const stdout = openSync(output, "wx");
  try {
    // Wait for the supervisor to record the worker exit and retain the native stream.
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd: root, windowsHide: true, stdio: ["ignore", stdout, "inherit"],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Worker command failed. Inspect ${output}`);
  } finally {
    closeSync(stdout);
  }
}

function gitFixture(root, branch, repository) {
  mkdirSync(root);
  git(root, "init", "-b", branch);
  git(root, "config", "user.name", "Runner Acceptance");
  git(root, "config", "user.email", "runner-acceptance@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "openspec-runner.repository", repository);
  run("openspec", ["init", "--tools", "none", "--no-animation"], root, 30000);
}

function writeChange(root, name, description) {
  const directory = join(root, "openspec", "changes", name);
  mkdirSync(join(directory, "specs", "greeting"), { recursive: true });
  const write = (path, contents) => writeFileSync(join(directory, path), contents);
  write("proposal.md", `## Why
Exercise delegated execution in disposable Windows checkouts.

## What Changes
- Add a deterministic greeting file.

## Capabilities
### New Capabilities
- \`greeting\`: A deterministic greeting fixture.

### Modified Capabilities
None.

## Impact
Adds one text file to the implementation checkout.
`);
  write("design.md", `## Context
A delegated Windows acceptance fixture.

## Goals / Non-Goals
Verify a single implementation task and review.

## Decisions
Use a plain-text greeting and verify its exact contents with Node.

## Risks / Trade-offs
The fixture exercises only one task.
`);
  write("specs/greeting/spec.md", `## ADDED Requirements
### Requirement: Greeting file
The checkout SHALL contain \`greeting.txt\` with the exact bytes HELLO followed by LF.

#### Scenario: Read the greeting
- **WHEN** \`greeting.txt\` is read
- **THEN** its contents are \`HELLO\` followed by a single LF
`);
  write("tasks.md", `## 1. Greeting\n\n- [ ] ${task} ${description}\n`);
  return directory;
}

function installClaudeCliShim(directory) {
  mkdirSync(directory);
  process.env.OPENSPEC_RUNNER_LIVE_NODE = process.execPath;
  process.env.OPENSPEC_RUNNER_LIVE_CLI = cli;
  // Claude can use Git Bash or PowerShell. Both wrappers select the same checkout.
  writeFileSync(join(directory, "openspec-runner"), '#!/bin/sh\nexec "$OPENSPEC_RUNNER_LIVE_NODE" "$OPENSPEC_RUNNER_LIVE_CLI" "$@"\n');
  writeFileSync(join(directory, "openspec-runner.cmd"), '@echo off\r\n"%OPENSPEC_RUNNER_LIVE_NODE%" "%OPENSPEC_RUNNER_LIVE_CLI%" %*\r\n');
  process.env.PATH = `${directory}${delimiter}${process.env.PATH}`;
}

function implementation(root, harness, model, context, guidance, marker) {
  gitFixture(root, "main", "implementation");
  runnerCli(root, "init", "--agent", harness);
  const directory = writeChange(root, change,
    "Run `node delegation-probe.mjs` from the assigned task worktree and use its output as verification evidence. " +
    "Create only `greeting.txt` containing exactly HELLO followed by one LF. Verify its bytes with Node, commit, and report.");
  const agent = harness === "codex" ? { defaultModel: model } : {
    defaultModel: model, permissionMode: "dontAsk",
    // The runner uses PowerShell's quoted invocation operator for begin/report.
    allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "PowerShell"],
  };
  writeFileSync(join(directory, "execution.yaml"), JSON.stringify({ version: 2, agent: harness, tasks: { [task]: {} } }));
  writeFileSync(join(root, "openspec", "runner.yaml"), JSON.stringify({
    version: 2, defaultAgent: harness, agents: { [harness]: agent }, worktrees: "git", terminal: "manual",
    cleanup: "manual", setup: [], verifyIntegration: verification,
  }));
  appendFileSync(join(root, ".gitignore"), "\n/.openspec-runner/\n");
  writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(root, "delegation-probe.mjs"), `import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pinned = ${JSON.stringify(context)};
assert.equal(readFileSync(pinned, "utf8"), ${JSON.stringify(guidance)});
assert.throws(() => {
  // r+ asks for write access to the existing file without truncating or writing it.
  closeSync(openSync(pinned, "r+"));
}, { code: /^(EACCES|EPERM)$/ });
if (process.argv.includes("--check-runtime")) {
  const path = join(${JSON.stringify(join(root, ".git", "openspec-runner"))}, "live-probe-" + randomUUID());
  writeFileSync(path, "original", { flag: "wx" });
  writeFileSync(path + ".tmp", "replacement", { flag: "wx" });
  renameSync(path + ".tmp", path);
  assert.equal(readFileSync(path, "utf8"), "replacement");
  unlinkSync(path);
}
console.log(${JSON.stringify(marker)});
`);
  git(root, "add", ".");
  git(root, "commit", "-m", "Prepare delegated implementation fixture");
}

function assignment(root, store, harness, model, guidance) {
  gitFixture(store, "coordination", "contracts");
  const changeRoot = writeChange(store, sharedChange, "Deliver the approved implementation component.");
  writeFileSync(join(store, "AGENTS.md"), guidance);
  git(store, "add", ".");
  git(store, "commit", "-m", "Prepare shared contract fixture");
  const c = new Coordination({ root: store, featureId, repositories: { implementation: root, contracts: store } });
  const contract = { repository: "contracts", context: {
    implementationRoot: root, planningRoot: store, changeRoot, change: sharedChange,
    source: "store", storeId: "live-store", artifactPaths: [], references: [],
  } };
  const role = { harness, model, ...(harness === "codex" ? { effort: "low" } : {}) };
  const manifest = {
    version: 1, featureId, storeId: "live-store", sharedChange, coordinationBranch: "coordination",
    components: { greeting: { repository: "implementation", change, deliveryBranch: "main", dependencies: [],
      settings: { implementation: role, review: role, repair: role, tasks: {}, maxFixRounds: 1, verifyIntegration: verification, setup: [] } } },
    taskMapping: { [task]: [{ type: "merged", componentId: "greeting" }] }, verification: [], completion: { requireAllMerged: true },
  };
  const head = () => git(store, "rev-parse", "HEAD");
  c.init({ manifest, contract, expectedHead: head(), operationId: "init" });
  const approval = c.approvalPreview({ contract });
  c.approve({ contract, token: approval.token, approvedBy: owner, id: "approval", operationId: "approve", expectedHead: approval.head });
  const input = { contract, componentId: "greeting", owner };
  const preview = c.assignmentPreview(input);
  c.assign({ ...input, token: preview.token, id: assignmentId, operationId: "assign", expectedHead: preview.head });
  return head();
}

function hasProbeEvidence(output, harness, marker) {
  const markerLine = value => typeof value === "string" && value.split(/\r?\n/).includes(marker);
  const events = readFileSync(output, "utf8").split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  if (harness === "codex") return events.some(event => {
    const item = event?.item;
    return event?.type === "item.completed" && item?.type === "command_execution" && item.exit_code === 0 &&
      item.command?.includes("delegation-probe.mjs") && markerLine(item.aggregated_output);
  });
  const probeIds = new Set(events.filter(event => event?.type === "assistant")
    .flatMap(event => event.message?.content ?? [])
    .filter(block => block.type === "tool_use" && ["Bash", "PowerShell"].includes(block.name) && block.input?.command?.includes("delegation-probe.mjs"))
    .map(block => block.id));
  return events.some(event => event?.type === "user" && event.message?.content?.some(block =>
    block.type === "tool_result" && !block.is_error && probeIds.has(block.tool_use_id) &&
    (Array.isArray(block.content) ? block.content.some(part => markerLine(part.text)) : markerLine(block.content))));
}

const { positionals: [harness, ...extra], values } = parseArgs({ allowPositionals: true, options: {
  model: { type: "string" }, "probe-only": { type: "boolean" }, help: { type: "boolean", short: "h" },
} });
if (values.help) {
  console.log(usage);
} else {
  runFixture();
}

function runFixture() {
  const model = values.model?.trim();
  if (!["codex", "claude"].includes(harness) || extra.length || !model || model === "session" || /[\0\r\n]/.test(values.model)) throw new Error(usage);
  if (values["probe-only"] && harness !== "codex") throw new Error("--probe-only requires Codex");
  if (process.platform !== "win32") throw new Error("Run this acceptance check on native Windows with a local NTFS temporary directory.");
  // A standalone CLI must not inherit the desktop session's Core transport.
  for (const key of ["CODEX_THREAD_ID", "CODEX_WINDOWS_REGISTERED_CORE", "CODEX_APP_RUNTIME_CLI_PATH", "CODEX_APP_TOOLS_PIPE_PATH"])
    delete process.env[key];

  const fixture = mkdtempSync(join(realpathSync(tmpdir()), `runner-live-windows-${harness}-`));
  console.log(`Fixture and evidence retained at ${fixture}`);
  const root = join(fixture, "implementation"), store = join(fixture, "store");
  const marker = `runner-delegation-probe-${randomUUID()}`;
  const guidance = "Shared Store guidance pinned for the Windows delegation acceptance test.\n";
  const context = join(root, ".git", "openspec-runner", "component-context", featureId, assignmentId, "0", "AGENTS.md");
  if (harness === "claude") installClaudeCliShim(join(fixture, "bin"));
  implementation(root, harness, model, context, guidance, marker);
  const storeHead = assignment(root, store, harness, model, guidance);
  const componentArgs = [featureId, "--store", store, "--repository", "implementation"];
  const importArgs = ["component", "import", ...componentArgs, "--assignment", assignmentId, "--owner", owner];
  const preview = runnerCli(root, ...importArgs, "--dry-run");
  assert.equal(preview.resources.worktrees, "git");
  assert.equal(preview.resources.terminal, "manual");
  const binding = runnerCli(root, ...importArgs, "--expected-head", storeHead, "--confirm", preview.token);
  assert.equal(binding.phase, "ready");
  assert.equal(realpathSync(join(binding.contextPaths[0], "AGENTS.md")), realpathSync(context));

  const runner = new Runner(root), feature = new Feature(root);
  const [attempt] = runnerCli(root, "launch", change, "--tasks", task);
  if (values["probe-only"]) {
    const context = { cwd: attempt.path, common: runner.repo.common, gitDir: attempt.gitDir, branch: attempt.branch };
    const policy = codexWorkerPermissions(context);
    for (const path of policy.prepareDirectories) mkdirSync(path, { recursive: true });
    validateCodexInvocation({ executable: "codex", args: [], cwd: attempt.path }, context);
    const output = run("codex", ["sandbox", "-P", policy.name, ...policy.configArgs, "-C", attempt.path,
      process.execPath, "delegation-probe.mjs", "--check-runtime"], attempt.path, 30000);
    assert.ok(output.split(/\r?\n/).includes(marker));
    validateDelegatedBinding(feature.read(change).delegated);
    const log = join(fixture, "codex-sandbox-probe.log");
    writeFileSync(log, output + "\n");
    console.log(JSON.stringify({ fixture, attempt: attempt.id, log, probeOnly: true }, null, 2));
    return;
  }
  const taskOutput = join(fixture, "implementation.stdout.log");
  workerCli(root, taskOutput, "worker", change, task, "--attempt", attempt.id);
  const implemented = runner.latest(runner.read(change), task);
  assert.equal(implemented.worker?.exitCode, 0, `Inspect ${implemented.worker?.log ?? taskOutput}`);
  assert.equal(implemented.report?.outcome, "completed", `Inspect ${implemented.worker?.log ?? taskOutput}`);
  assert.ok(hasProbeEvidence(taskOutput, harness, marker), `Missing successful pinned context probe in ${taskOutput}`);
  assert.equal(git(root, "diff", "--name-only", attempt.base, implemented.report.commit), "greeting.txt");
  runnerCli(root, "integrate", change, "--tasks", task);
  const integrated = runner.read(change);
  assert.equal(readFileSync(join(integrated.integration.path, "greeting.txt"), "utf8"), "HELLO\n");

  const review = runnerCli(root, "feature", "review", change);
  const reviewOutput = join(fixture, "review.stdout.log");
  workerCli(root, reviewOutput, "feature", "worker", change, "--attempt", review.id);
  const reviewed = feature.read(change).jobs.find(job => job.id === review.id);
  assert.equal(reviewed?.worker?.exitCode, 0, `Inspect ${reviewed?.worker?.log ?? reviewOutput}`);
  assert.equal(reviewed?.report?.outcome, "completed", `Inspect ${reviewed?.worker?.log ?? reviewOutput}`);
  assert.equal(reviewed.report.head, integrated.head);

  const receipt = join(fixture, "receipt.json");
  const exportArgs = ["component", "export", ...componentArgs, "--change", change, "--outcome", "completed"];
  const submission = runnerCli(root, ...exportArgs, "--dry-run");
  const exported = runnerCli(root, ...exportArgs, "--expected-head", storeHead, "--confirm", submission.token,
    "--id", "receipt", "--operation", "export", "--output", receipt);
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), exported.record);
  assert.equal(exported.record.result.commit, integrated.head);
  assert.equal(readFileSync(context, "utf8"), guidance);

  const result = { harness, model, fixture, root, store, context, marker, attempt: attempt.id, review: review.id,
    taskLog: implemented.worker.log, reviewLog: reviewed.worker.log, commit: integrated.head, receipt };
  writeFileSync(join(fixture, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
