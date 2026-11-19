import { delegatedContextTest as test } from "./helpers/native-support.mjs";
import { test as nativeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, readdirSync, lstatSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { featureFixture, featureSettings, git, executable, blocker } from "./helpers/feature-fixture.mjs";
import { execFileSync } from "node:child_process";
import { Coordination } from "../dist/coordination.js";
import { Component } from "../dist/component.js";
import { Feature } from "../dist/feature.js";
import { Runner } from "../dist/runner.js";
import { assertWindowsContextHost, restoreWindowsContext, windowsContextRequest } from "../dist/windows-context.js";

function fixture(t, options = {}) {
  let dir;
  const unlock = path => { const stat = lstatSync(path); if (stat.isSymbolicLink()) return; chmodSync(path, stat.isDirectory() ? 0o755 : 0o644); if (stat.isDirectory()) for (const child of readdirSync(path)) unlock(join(path, child)); };
  const f = featureFixture({ after(cleanup) { t.after(() => {
    if (options.windowsProtection) {
      const component = new Component({ root: f.root, repository: "api" });
      const binding = component.readBinding({ change: "demo" });
      if (binding) restoreWindowsContext(windowsContextRequest(component.repo.stateDir, binding));
    }
    if (dir) unlock(dir);
    cleanup();
  }); } }, { unchecked: options.unchecked ?? true });
  dir = f.dir;
  git(f.root, "config", "openspec-runner.repository", "api");
  const storeRoot = join(f.dir, "store"); mkdirSync(storeRoot);
  git(storeRoot, "init", "-b", "coordination"); git(storeRoot, "config", "user.name", "Test"); git(storeRoot, "config", "user.email", "test@example.test");
  git(storeRoot, "config", "openspec-runner.repository", "contracts");
  mkdirSync(join(storeRoot, "openspec/changes/shared"), { recursive: true });
  writeFileSync(join(storeRoot, "openspec/changes/shared/tasks.md"), "- [ ] 1.1 Deliver API\n");
  writeFileSync(join(storeRoot, "AGENTS.md"), "Shared guidance\n");
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Contract");
  const repositories = { api: f.root, contracts: storeRoot };
  const c = new Coordination({ root: storeRoot, featureId: "feature", repositories });
  const context = { implementationRoot: f.root, planningRoot: storeRoot, changeRoot: join(storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] };
  const contract = { context, repository: "contracts" };
  const manifest = { version: 1, featureId: "feature", storeId: "team", sharedChange: "shared", coordinationBranch: "coordination", components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [], settings: { ...(options.settings ?? featureSettings), tasks: {}, verifyIntegration: [], setup: [] } } }, taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  c.init({ manifest, contract, expectedHead: git(storeRoot, "rev-parse", "HEAD"), operationId: "init" });
  const approve = (id = "approval", extra = {}) => {
    const p = c.approvalPreview({ contract });
    c.approve({ contract, token: p.token, approvedBy: "user", id, operationId: `op-${id}`, expectedHead: git(storeRoot, "rev-parse", "HEAD"), ...extra }); return p;
  };
  const assign = () => { const p = c.assignmentPreview({ componentId: "api", owner: "alice", contract }); return c.assign({ componentId: "api", owner: "alice", contract, token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(storeRoot, "rev-parse", "HEAD") }); };
  const imported = () => { approve(); assign(); const component = new Component({ root: f.root, repository: "api" }); const input = { storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }; return { component, input }; };
  return { ...f, c, storeRoot, contract, manifest, approve, assign, imported };
}

nativeTest("Windows delegated import, protected worker, Claude review and repair, and export", { skip: process.platform !== "win32" }, async t => {
  try { assertWindowsContextHost(process.cwd()); }
  catch (error) {
    if (!/without backup or restore privileges/.test(error.message)) throw error;
    t.skip("Delegated workers require a standard Windows token");
    return;
  }
  const claude = { harness: "claude", model: "test-model", effort: "low" };
  const f = fixture(t, { windowsProtection: true, settings: { ...featureSettings, review: claude, repair: claude } });
  const { component, input } = f.imported();
  const preview = await component.inspect(input);
  assert.equal(existsSync(component.repo.stateDir), false);
  const obstruction = join(f.root, ".openspec-runner", "worktrees", "demo-delegated-assignment-integration");
  mkdirSync(obstruction, { recursive: true });
  await assert.rejects(component.import({ ...input, token: preview.token }), /worktree path already exists/i);
  assert.equal(component.readBinding({ change: "demo" }).phase, "reserved");
  assert.throws(() => f.r.preview("demo", ["1.1"]), /completed import/);
  rmdirSync(obstruction);
  const binding = await component.import({ ...input, token: preview.token });
  assert.equal(binding.phase, "ready");
  assert.equal((await component.import({ ...input, token: preview.token })).phase, "ready");
  const context = join(binding.contextPaths[0], "AGENTS.md");
  executable(join(f.bin, "codex"), `
const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict');
if (process.argv.includes('--help')) { console.log('--add-dir --model --cd'); process.exit(0); }
(async () => {
  for await (const chunk of process.stdin) { }
  const { Runner } = await import(${JSON.stringify(new URL("../dist/runner.js", import.meta.url).href)});
  const runner = new Runner(), attempt = runner.latest(runner.read('demo'), '1.1');
  assert.equal(fs.readFileSync(${JSON.stringify(context)}, 'utf8'), 'Shared guidance\\n');
  assert.throws(() => fs.writeFileSync(${JSON.stringify(context)}, 'tampered'), {code: /EACCES|EPERM/});
  const session = 'windows-delegated-task';
  runner.begin('demo', '1.1', attempt.id, session);
  fs.writeFileSync('output.txt', 'implementation\\n');
  cp.execFileSync('git', ['add', 'output.txt']);
  cp.execFileSync('git', ['commit', '-m', 'Implement']);
  const commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  runner.report('demo', '1.1', attempt.id, { attempt: attempt.id, task: '1.1', session,
    outcome: 'completed', commit, summary: 'Implemented', verification: ['NTFS denied context writes'] });
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  const [task] = f.r.launch("demo", ["1.1"]);
  const result = await f.r.worker("demo", "1.1", task.id);
  assert.equal(result.exitCode, 0, readFileSync(result.log, "utf8"));
  f.r.integrate("demo", ["1.1"]);
  f.control({ findings: [blocker] });
  await f.review();
  const repair = f.f.launch("demo", "repair");
  assert.equal((await f.f.worker("demo", repair.id)).exitCode, 0);
  f.f.integrate("demo", repair.id);
  f.control({ findings: [] });
  await f.review();
  const request = { change: "demo", outcome: "completed" };
  const submission = component.submissionPreview(request);
  const exported = component.exportSubmission({ ...request, id: "result", operationId: "export", token: submission.token });
  assert.equal(exported.record.result.commit, f.r.read("demo").head);
  assert.equal(readFileSync(context, "utf8"), "Shared guidance\n");
});

test("assignment editor rejects a valid imported binding without dashboard Store context", async t => {
  const { editExecutionSettings } = await import("../dist/execution-settings.js");
  const f = fixture(t);
  const directory = join(f.root, "openspec/changes/demo");
  const path = join(directory, "execution.yaml");
  const bytes = readFileSync(path);
  const entries = readdirSync(directory).sort();
  const patch = { tasks: [{ id: "1.1", model: "new" }] };
  const reviewed = editExecutionSettings("demo", patch, undefined, f.root);
  const { component, input } = f.imported();
  const preview = await component.inspect(input);
  const binding = await component.import({ ...input, token: preview.token });
  assert.equal(binding.phase, "ready");
  assert.ok(f.f.read("demo").delegated);
  for (const token of [undefined, reviewed.token]) {
    assert.throws(() => editExecutionSettings("demo", patch, token, f.root), /Obtain revised settings from the coordinator/);
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(readdirSync(directory).sort(), entries);
  }
});

test("retirement preserves evidence and lets a different assignment reuse the clone", async t => {
  const f = fixture(t), { component, input } = f.imported(), preview = await component.inspect(input);
  const binding = await component.import({ ...input, token: preview.token });
  const integration = f.f.runner.read("demo").integration;
  const execution = f.f.runner.read("demo");
  execution.attempts.push({ id: "old-attempt", task: "1.1", phase: "failed", agent: "codex", batch: "old-batch", terminal: {}, error: "Preparation failed before launch" });
  execution.batches.push({ id: "old-batch", harness: "codex", attempts: ["old-attempt"] }); f.f.runner.save(execution);
  const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Replace assignment" };
  const before = readFileSync(join(f.f.repo.stateDir, "features/demo.json"), "utf8");
  const p = component.retirementPreview(args);
  assert.equal(component.readBinding({ change: "demo" }).phase, "ready");
  assert.throws(() => component.retire({ ...args, token: "wrong" }), /token|stale/i);
  const result = component.retire({ ...args, token: p.token });
  assert.equal(result.phase, "retired");
  assert.equal(JSON.parse(readFileSync(result.evidencePath, "utf8")).snapshot.feature, before);
  assert.equal(existsSync(integration.path), true);
  assert.equal(existsSync(binding.contextPaths[0]), true);
  assert.equal(component.retire({ ...args, token: p.token }).phase, "retired");
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /retired|binding|import/i);
  await assert.rejects(component.import({ ...input, token: preview.token }), /retired/i);
  f.c.revoke({ assignmentId: "assignment", reason: "Replace", id: "revoke-old", operationId: "op-revoke-old", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const next = f.c.assignmentPreview({ componentId: "api", owner: "bob", contract: f.contract });
  f.c.assign({ componentId: "api", owner: "bob", contract: f.contract, token: next.token, id: "replacement", operationId: "op-replacement", expectedHead: next.head });
  const replacement = { ...input, assignmentId: "replacement", owner: "bob" }, rp = await component.inspect(replacement);
  await component.import({ ...replacement, token: rp.token });
  assert.equal(component.readBinding({ change: "demo" }).assignmentId, "replacement");
  assert.notEqual(f.f.runner.read("demo").integration.path, integration.path);
  assert.throws(() => f.f.runner.begin("demo", "1.1", "old-attempt", "old-session"), /ready|attempt/i);
  await assert.rejects(f.f.runner.worker("demo", "1.1", "old-attempt"), /ready|attempt/i);
  assert.throws(() => component.retire({ ...args, token: p.token }), /assignment|identity/i);
  assert.equal(JSON.parse(readFileSync(result.evidencePath, "utf8")).snapshot.feature, before);
});

test("retirement rejects active workers, uncertain termination, and pending integration", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Stop" };
  const r = f.f.runner.read("demo"), original = structuredClone(r);
  r.transaction = { phase: "merging" }; f.f.runner.save(r);
  assert.throws(() => component.retirementPreview(args), /integration|transaction/i);
  delete r.transaction;
  r.attempts = [{ id: "old", task: "1.1", agent: "codex", batch: "old", phase: "running", terminal: {} }];
  r.batches = [{ id: "old", harness: "codex", attempts: ["old"] }]; f.f.runner.save(r);
  assert.throws(() => component.retirementPreview(args), /active/i);
  r.attempts[0].phase = "failed"; r.attempts[0].worker = { exitedAt: new Date().toISOString(), terminationUncertain: true }; f.f.runner.save(r);
  assert.throws(() => component.retirementPreview(args), /uncertain|active/i);
  f.f.runner.save(original);
  const featureFile = join(f.f.repo.stateDir, "features/demo.json"), s = JSON.parse(readFileSync(featureFile));
  s.transaction = { phase: "checking" }; writeFileSync(featureFile, JSON.stringify(s));
  assert.throws(() => component.retirementPreview(args), /integration|transaction/i);
  delete s.transaction; writeFileSync(featureFile, JSON.stringify(s));
  const fresh = component.retirementPreview(args);
  s.error = "State changed after preview"; writeFileSync(featureFile, JSON.stringify(s));
  assert.throws(() => component.retire({ ...args, token: fresh.token }), /stale|token/i);
});

test("retirement resumes after partial state removal and rejects changed evidence", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Replace" }, rp = component.retirementPreview(args);
  // Simulate a crash after durable intent and one exact active-file removal.
  const bindingPath = join(f.f.repo.stateDir, "components/demo.json"), binding = component.readBinding({ change: "demo" });
  const journal = { version: 1, input: args, token: rp.token, snapshot: rp.snapshot };
  mkdirSync(join(f.f.repo.stateDir, "component-retirements/feature"), { recursive: true });
  writeFileSync(rp.evidencePath, JSON.stringify(journal));
  binding.phase = "retiring"; binding.retirement = { token: rp.token, reason: args.reason };
  writeFileSync(bindingPath, JSON.stringify(binding)); unlinkSync(join(f.f.repo.stateDir, "features/demo.json"));
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|import|retir/i);
  const runnerPath = f.f.runner.path("demo"), original = readFileSync(runnerPath, "utf8");
  writeFileSync(runnerPath, original + "\n");
  assert.throws(() => component.retire({ ...args, token: rp.token }), /changed|differ/i);
  writeFileSync(runnerPath, original);
  assert.equal(component.retire({ ...args, token: rp.token }).phase, "retired");
});

test("component retirement CLI previews without writing and confirms exact local identity", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const cli = new URL("../bin/openspec-runner.js", import.meta.url);
  const args = [cli.pathname, "component", "retire", "feature", "--store", f.storeRoot, "--root", f.root,
    "--repository", "api", "--change", "demo", "--assignment", "assignment", "--owner", "alice", "--reason", "Reassign", "--json"];
  const before = readFileSync(join(f.f.repo.stateDir, "components/demo.json"), "utf8");
  const preview = JSON.parse(execFileSync(process.execPath, [...args, "--dry-run"], { encoding: "utf8" }));
  assert.equal(preview.action, "retire"); assert.equal(preview.phase, "ready");
  assert.equal(existsSync(preview.evidencePath), false);
  assert.equal(readFileSync(join(f.f.repo.stateDir, "components/demo.json"), "utf8"), before);
  const retired = JSON.parse(execFileSync(process.execPath, [...args, "--confirm", preview.token], { encoding: "utf8" }));
  assert.equal(retired.phase, "retired"); assert.equal(existsSync(retired.evidencePath), true);
});

test("retirement blocks incomplete import and late import cannot reactivate a retired binding", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Replace" };
  const path = join(f.f.repo.stateDir, "components/demo.json"), binding = component.readBinding({ change: "demo" });
  writeFileSync(path, JSON.stringify({ ...binding, phase: "reserved" }));
  assert.throws(() => component.retirementPreview(args), /import|reserved|incomplete/i);
  writeFileSync(path, JSON.stringify(binding));
  const bind = Feature.prototype.bindAssignment;
  Feature.prototype.bindAssignment = function(options) {
    const result = bind.call(this, options), preview = component.retirementPreview(args);
    component.retire({ ...args, token: preview.token });
    return result;
  };
  try { await assert.rejects(component.import({ ...input, token: p.token }), /retir|changed/i); }
  finally { Feature.prototype.bindAssignment = bind; }
  assert.equal(component.readBinding({ change: "demo" }).phase, "retired");
});

test("import rechecks retirement after asynchronous inspection before reserving execution", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const inspect = component.inspect.bind(component);
  component.inspect = async options => {
    const preview = await inspect(options);
    const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Retire during inspection" };
    component.retire({ ...args, token: component.retirementPreview(args).token });
    return preview;
  };
  await assert.rejects(component.import({ ...input, token: p.token }), /retir/i);
  assert.equal(component.readBinding({ change: "demo" }).phase, "retired");
});

test("in-flight reimport cannot recreate state after retirement between import locks", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Retire between import stages" };
  const lock = Runner.prototype.lock; let count = 0, armed = true;
  Runner.prototype.lock = function(fn) {
    const result = lock.call(this, fn);
    if (armed && ++count === 2) { armed = false; component.retire({ ...args, token: component.retirementPreview(args).token }); }
    return result;
  };
  try { await assert.rejects(component.import({ ...input, token: p.token }), /retir|binding/i); }
  finally { Runner.prototype.lock = lock; }
  assert.equal(f.f.runner.read("demo"), undefined);
  assert.equal(component.readBinding({ change: "demo" }).phase, "retired");
});

test("late task reports cannot change active state during interrupted retirement", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const state = f.f.runner.read("demo");
  state.attempts = [{ id: "late-report", task: "1.1", phase: "failed", agent: "codex", batch: "old", path: state.integration.path,
    terminal: {}, session: "old-session", worker: { exitedAt: new Date().toISOString(), exitCode: 1 } }];
  state.batches = [{ id: "old", harness: "codex", attempts: ["late-report"] }]; f.f.runner.save(state);
  const args = { change: "demo", assignmentId: "assignment", owner: "alice", reason: "Retire stopped worker" }, rp = component.retirementPreview(args);
  mkdirSync(join(f.f.repo.stateDir, "component-retirements/feature"), { recursive: true });
  writeFileSync(rp.evidencePath, JSON.stringify({ version: 1, input: args, token: rp.token, snapshot: rp.snapshot }));
  const binding = component.readBinding({ change: "demo" }); binding.phase = "retiring"; binding.retirement = { token: rp.token, reason: args.reason };
  writeFileSync(join(f.f.repo.stateDir, "components/demo.json"), JSON.stringify(binding));
  const reporter = new Runner(state.integration.path);
  assert.throws(() => reporter.report("demo", "1.1", "late-report", { attempt: "late-report", task: "1.1", session: "old-session", outcome: "failed", summary: "Late", verification: ["Stopped"] }), /retir/i);
  assert.equal(component.retire({ ...args, token: rp.token }).phase, "retired");
});

test("approval previews bind committed context, base, full resolved settings and explicit consent", t => {
  const f = fixture(t), p = f.c.approvalPreview({ contract: f.contract });
  assert.equal(p.components.api.base, git(f.root, "rev-parse", "HEAD"));
  assert.equal(p.components.api.settings.tasks["1.1"].model, "test-model");
  assert.equal(p.components.api.settings.tasks["1.1"].reasoningEffort, "high");
  assert.equal(p.components.api.settings.maxFixRounds, 2);
  assert.deepEqual(p.components.api.settings.setup, []);
  assert.throws(() => f.c.approve({ contract: f.contract, token: p.token, approvedBy: "", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }), /consent|approvedBy/i);
  assert.throws(() => f.c.approve({ contract: f.contract, token: "bad", approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }), /token/i);
  f.approve();
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Changed guidance\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Change guidance");
  assert.throws(() => f.c.assignmentPreview({ componentId: "api", owner: "alice", contract: f.contract }), /approval|drift/i);
});

test("assignments guard branch/head and retain one full-component owner", t => {
  const f = fixture(t); f.approve(); const p = f.c.assignmentPreview({ componentId: "api", owner: "alice", contract: f.contract });
  const args = { componentId: "api", owner: "alice", contract: f.contract, token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") };
  git(f.storeRoot, "switch", "-c", "other"); assert.throws(() => f.c.assign(args), /branch/i); git(f.storeRoot, "switch", "coordination");
  assert.throws(() => f.c.assign({ ...args, expectedHead: "a".repeat(40) }), /head/i);
  f.c.assign(args);
  assert.throws(() => f.c.assignmentPreview({ componentId: "api", owner: "bob", contract: f.contract }), /active assignment/i);
  assert.equal(f.c.status({}).components.api.assignmentId, "assignment");
});

test("import into independent clone freezes execution and read-only pinned prompts", async t => {
  const f = fixture(t); f.approve(); f.assign();
  const clone = join(f.dir, "independent api"), storeClone = join(f.dir, "independent store");
  execFileSync("git", ["clone", "--quiet", f.root, clone]); execFileSync("git", ["clone", "--quiet", f.storeRoot, storeClone]); git(clone, "config", "openspec-runner.repository", "api"); git(storeClone, "config", "openspec-runner.repository", "contracts");
  const component = new Component({ root: clone, repository: "api" }), input = { storeRoot: storeClone, featureId: "feature", assignmentId: "assignment", owner: "alice" };
  const preview = await component.inspect(input); assert.equal(preview.historyRevision, git(storeClone, "rev-parse", "HEAD"));
  const bound = await component.import({ ...input, token: preview.token });
  assert.equal(bound.assignmentId, "assignment"); assert.equal((await component.import({ ...input, token: preview.token })).assignmentId, "assignment");
  const feature = new Feature(clone), s = feature.read("demo");
  assert.equal(s.approval.tasks["1.1"].model, "test-model"); assert.equal(s.approval.maxFixRounds, 2);
  assert.equal(statSync(join(bound.contextPaths[0], "AGENTS.md")).mode & 0o222, 0);
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Replacement Store contents\n");
  const task = feature.runner.launch("demo", ["1.1"])[0];
  const prompt = feature.runner.prompt("demo", task); assert.ok(prompt.includes(bound.contextPaths[0])); assert.match(prompt, /pinned|Pinned/);
  assert.equal(readFileSync(join(bound.contextPaths[0], "AGENTS.md"), "utf8"), "Shared guidance\n");
  assert.throws(() => feature.planPreview("demo", featureSettings), /delegated|assignment/i);
  assert.throws(() => feature.finalPreview("demo"), /delegated|assignment/i);
  assert.throws(() => feature.archive("demo"), /delegated|assignment/i);
  assert.throws(() => feature.runner.preview("demo", ["1.1"], { model: "session" }), /overlay|settings|attempt/i);
  const review = { id: "test", agent: "codex", role: "review", path: join(clone, "fake"), base: s.approval.base, fingerprint: s.approval.fingerprint, settings: s.approval.review };
  assert.ok(feature.prompt("demo", review).includes(bound.contextPaths[0]));
  assert.ok(feature.prompt("demo", { ...review, role: "repair" }).includes(bound.contextPaths[0]));
});

test("imports reject identity, owner, base, plan, history and scope overlays", async t => {
  const f = fixture(t), { component, input } = f.imported();
  await assert.rejects(component.inspect({ ...input, owner: "bob" }), /owner/i);
  await assert.rejects(new Component({ root: f.root, repository: "wrong" }).inspect(input), /identity|repository/i);
  await assert.rejects(component.inspect({ ...input, historyRevision: "a".repeat(40) }), /history|git/i);
  const p = await component.inspect(input);
  await assert.rejects(component.import({ ...input, token: p.token, settings: {} }), /overlay|unknown/i);
  writeFileSync(join(f.root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Different scope\n");
  await assert.rejects(component.inspect(input), /committed|plan/i);
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Scope drift"); await assert.rejects(component.inspect(input), /base|plan/i);
});

test("revocation is reported against freshly inspected committed coordination history", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input); await component.import({ ...input, token: p.token });
  f.c.revoke({ assignmentId: "assignment", reason: "Owner changed", id: "revoke", operationId: "op-revoke", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  assert.equal(component.status({ change: "demo", storeRoot: f.storeRoot }).revoked, true);
  await assert.rejects(component.inspect(input), /revoked|active/i);
});

test("current approval authority follows committed introduction rather than timestamps", t => {
  const f = fixture(t); f.approve("first", { createdAt: "2099-01-01T00:00:00Z" }); f.approve("second", { createdAt: "2000-01-01T00:00:00Z" });
  assert.equal(f.c.status({}).approvalId, "second");
  f.assign(); assert.equal(f.c.store.readRecord({ kind: "assignment", id: "assignment" }).approvalId, "second");
});

test("every supplied referenced Store is pinned and relevant reference drift needs reapproval", async t => {
  const f = fixture(t), referenceRoot = join(f.dir, "reference"); mkdirSync(referenceRoot);
  git(referenceRoot, "init", "-b", "main"); git(referenceRoot, "config", "user.name", "Test"); git(referenceRoot, "config", "user.email", "test@example.test"); git(referenceRoot, "config", "openspec-runner.repository", "reference");
  mkdirSync(join(referenceRoot, "openspec/changes/ref"), { recursive: true }); writeFileSync(join(referenceRoot, "openspec/changes/ref/spec.md"), "Linked specification\n"); git(referenceRoot, "add", "."); git(referenceRoot, "commit", "-m", "Reference");
  f.c.repositories.reference = referenceRoot;
  f.contract.context.references = [{ storeId: "ref-store", root: referenceRoot, status: [] }];
  const reference = { repository: "reference", context: { ...f.contract.context, planningRoot: referenceRoot, changeRoot: join(referenceRoot, "openspec/changes/ref"), change: "ref", storeId: "ref-store", references: [] } };
  assert.throws(() => f.c.approvalPreview({ contract: f.contract }), /reference/i);
  const preview = f.c.approvalPreview({ contract: f.contract, references: [reference] }); assert.equal(preview.contract.references[0].files[0].content, "Linked specification\n");
  f.c.approve({ contract: f.contract, references: [reference], token: preview.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const p = f.c.assignmentPreview({ componentId: "api", owner: "alice", contract: f.contract, references: [reference] });
  f.c.assign({ componentId: "api", owner: "alice", contract: f.contract, references: [reference], token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const component = new Component({ root: f.root, repository: "api" }), input = { storeRoot: f.storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }, ip = await component.inspect(input), binding = await component.import({ ...input, token: ip.token });
  assert.equal(binding.contextPaths.length, 2);
  writeFileSync(join(referenceRoot, "openspec/changes/ref/spec.md"), "Changed specification\n"); git(referenceRoot, "add", "."); git(referenceRoot, "commit", "-m", "Change reference");
  assert.throws(() => f.c.assignmentPreview({ componentId: "api", owner: "bob", contract: f.contract, references: [reference] }), /approval|drift/i);
});

test("assignment and approval mutations retry exact identities without timestamp drift", t => {
  const f = fixture(t), p = f.approve(), head = git(f.storeRoot, "rev-parse", "HEAD");
  const repeated = f.c.approve({ contract: f.contract, token: p.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: head }); assert.equal(repeated.created, false);
  const ap = f.c.assignmentPreview({ contract: f.contract, componentId: "api", owner: "alice" }), expectedHead = git(f.storeRoot, "rev-parse", "HEAD");
  const args = { contract: f.contract, componentId: "api", owner: "alice", token: ap.token, id: "assignment", operationId: "op-assignment", expectedHead };
  const first = f.c.assign(args); assert.equal(f.c.assign(args).head, first.head);
});

test("shared approval reuses exact FeatureApproval adapter-owned role and task settings", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "openspec/runner.yaml"), JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "test-model" }, claude: { defaultModel: "claude-model", permissionMode: "acceptEdits", allowedTools: ["Read", "Bash(git *)"] } }, terminal: "manual", worktrees: "git", verifyIntegration: [], setup: [["node", "-e", "process.exit(0)"]] }));
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Role options and setup");
  const roles = { ...featureSettings, review: { harness: "claude", model: "claude-model", effort: "high" }, repair: { harness: "claude", model: "claude-model", effort: "medium" } };
  f.manifest.components.api.settings = { ...roles, tasks: {}, verifyIntegration: [], setup: [["node", "-e", "process.exit(0)"]] };
  writeFileSync(join(f.storeRoot, "runner/features/feature/manifest.yaml"), JSON.stringify(f.manifest)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Declare role options");
  f.f.start("demo"); const local = f.f.planPreview("demo", roles), shared = f.c.approvalPreview({ contract: f.contract }).components.api.settings;
  for (const role of ["implementation", "tasks", "review", "repair"]) assert.deepEqual(shared[role], local[role]);
  assert.deepEqual(shared.review.options, { permissionMode: "acceptEdits", allowedTools: ["Read", "Bash(git *)"] });
  assert.deepEqual(shared.setup, [["node", "-e", "process.exit(0)"]]);
});

test("import validates installed harness capabilities before reserving local execution", async t => {
  const f = fixture(t), { component, input } = f.imported();
  writeFileSync(join(f.bin, "codex"), "#!/usr/bin/env node\nconsole.log('unsupported CLI')\n");
  await assert.rejects(component.inspect(input), /Harness.*cannot execute|capabilit/i);
  assert.equal(component.status({ change: "demo" }).imported, false);
});

test("import rejects a forged approval token despite syntactically valid portable records", async t => {
  const f = fixture(t), { component, input } = f.imported();
  const path = join(f.storeRoot, "runner/features/feature/approvals/approval.json"), record = JSON.parse(readFileSync(path, "utf8"));
  record.consent.token = "a".repeat(64); writeFileSync(path, JSON.stringify(record)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Forge approval consent");
  await assert.rejects(component.inspect(input), /token|consent|immutable/i);
});

test("execution rejects local approval setting edits and writable pinned context", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input), binding = await component.import({ ...input, token: p.token });
  const feature = f.f, s = feature.read("demo"), file = join(feature.repo.stateDir, "features/demo.json");
  s.approval.tasks["1.1"].model = "edited-model"; writeFileSync(file, JSON.stringify(s));
  assert.throws(() => feature.runner.preview("demo", ["1.1"]), /approval|settings|binding/i);
  s.approval.tasks["1.1"].model = binding.assignment.settings.tasks["1.1"].model; writeFileSync(file, JSON.stringify(s));
  chmodSync(join(binding.contextPaths[0], "AGENTS.md"), 0o644);
  assert.throws(() => feature.runner.preview("demo", ["1.1"]), /pinned|writable/i);
});

test("import reservation recovers interrupted worktree creation without replacing approval", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  const integration = join(f.root, ".openspec-runner/worktrees/demo-delegated-assignment-integration"); mkdirSync(integration, { recursive: true }); writeFileSync(join(integration, "obstruction"), "Not a Git worktree\n");
  await assert.rejects(component.import({ ...input, token: p.token }), /git|worktree|reservation/i);
  assert.equal(component.status({ change: "demo" }).phase, "reserved");
  const before = f.f.read("demo").approval;
  const { rmSync } = await import("node:fs"); rmSync(integration, { recursive: true, force: true });
  const recovered = await component.import({ ...input, token: p.token });
  assert.equal(recovered.phase, "ready"); assert.deepEqual(f.f.read("demo").approval, before);
});

test("committed record identities reject rewritten bytes even with recomputed consent", async t => {
  const f = fixture(t), { component, input } = f.imported();
  const approvalPath = join(f.storeRoot, "runner/features/feature/approvals/approval.json"), assignmentPath = join(f.storeRoot, "runner/features/feature/assignments/assignment.json");
  const approval = JSON.parse(readFileSync(approvalPath, "utf8")), assignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
  approval.components.api.settings.maxFixRounds = 99; assignment.settings.maxFixRounds = 99;
  const { stableDigest } = await import("../dist/coordination-state.js");
  approval.consent.token = stableDigest({ value: { manifestFingerprint: approval.manifestFingerprint, contract: approval.contract, components: approval.components, verification: approval.verification } });
  writeFileSync(approvalPath, JSON.stringify(approval)); writeFileSync(assignmentPath, JSON.stringify(assignment)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Rewrite approved identities");
  await assert.rejects(component.inspect(input), /immutable|introduced|record.*changed/i);
});

test("authoritative first-parent record bytes cover receipts/events/deletions and retain merge imports", async t => {
  for (const kind of ["submission", "event", "deletion"]) await t.test(kind, inner => {
    const f = fixture(inner); f.approve(); f.assign();
    const receipt = { version: 1, kind: "submission", id: "receipt", featureId: "feature", operationId: "op-receipt", createdAt: "2026-10-04T12:00:00Z", assignmentId: "assignment", owner: "alice", repository: "api", change: "demo", outcome: "blocked", reason: "Need credentials", base: git(f.root, "rev-parse", "HEAD"), planFingerprint: f.c.store.readRecord({ kind: "assignment", id: "assignment" }).planFingerprint, contractFingerprint: f.c.store.readRecord({ kind: "assignment", id: "assignment" }).contract.fingerprint, tasks: [{ id: "1.1", completed: false }], verification: [] };
    let path;
    if (kind === "event") {
      f.c.revoke({ assignmentId: "assignment", reason: "Owner changed", id: "revoke", operationId: "op-revoke", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }); path = join(f.storeRoot, "runner/features/feature/events/revoke.json");
    } else {
      git(f.storeRoot, "switch", "-c", "handoff"); path = join(f.storeRoot, "runner/features/feature/submissions/receipt.json"); mkdirSync(join(path, ".."), { recursive: true });
      const bytes = JSON.stringify(receipt, null, 4) + "\n\n"; writeFileSync(path, bytes); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Owner handoff"); git(f.storeRoot, "switch", "coordination"); git(f.storeRoot, "merge", "--no-ff", "handoff", "-m", "Import receipt");
      assert.equal(f.c.store.readSnapshot().records.find(record => record.id === "receipt").reason, "Need credentials"); assert.equal(readFileSync(path, "utf8"), bytes);
    }
    if (kind === "deletion") git(f.storeRoot, "rm", path);
    else { const record = JSON.parse(readFileSync(path, "utf8")); record.reason = "Rewritten reason"; writeFileSync(path, JSON.stringify(record)); git(f.storeRoot, "add", "."); }
    git(f.storeRoot, "commit", "-m", "Change immutable record"); assert.throws(() => f.c.store.readSnapshot(), /immutable|introduced|record.*changed|record.*deleted/i);
  });
});

test("separate component binding remains authoritative when feature delegation is removed", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input); await component.import({ ...input, token: p.token });
  const featurePath = join(f.f.repo.stateDir, "features/demo.json"), state = JSON.parse(readFileSync(featurePath, "utf8")); delete state.delegated; state.approval.tasks["1.1"].model = "edited-model"; writeFileSync(featurePath, JSON.stringify(state));
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|delegat/i);
  assert.throws(() => f.f.runner.prompt("demo", { id: "task", task: "1.1", path: join(f.root, "fake"), agent: "codex" }), /binding|delegat/i);
  assert.throws(() => f.f.finalPreview("demo"), /binding|delegat/i); assert.throws(() => f.f.archive("demo"), /binding|delegat/i);
});

test("component runtime binding rejects corrupt identity/token/path fields before execution", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input); await component.import({ ...input, token: p.token });
  const path = join(f.f.repo.stateDir, "components/demo.json"), original = JSON.parse(readFileSync(path, "utf8"));
  for (const patch of [{ token: "a".repeat(64) }, { assignmentId: "wrong" }, { contextPaths: [join(f.dir, "elsewhere")] }, { phase: "unknown" }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|identity|token|context/i);
    assert.throws(() => component.status({ change: "demo" }), /binding|identity|token|context/i);
  }
  writeFileSync(path, JSON.stringify(original));
});

test("local resource previews/imports bind adapters and locations without approved plan edits", async t => {
  const f = fixture(t), { component, input } = f.imported(), resources = { terminal: "auto", worktrees: "auto", worktreeRoot: join(f.dir, "local agent workspaces") };
  executable(join(f.bin, "wt"), `console.log('Worktrunk unavailable in this fixture');`);
  const ordinary = await component.inspect(input), preview = await component.inspect({ ...input, resources });
  assert.notEqual(preview.token, ordinary.token); assert.deepEqual(preview.resources, resources);
  const planBytes = readFileSync(join(f.root, "openspec/runner.yaml"));
  const binding = await component.import({ ...input, resources, token: preview.token }); assert.deepEqual(binding.resources, resources);
  const state = f.f.runner.read("demo"); assert.ok(state.integration.path.startsWith(resources.worktreeRoot + "/"));
  const taskPreview = f.f.runner.preview("demo", ["1.1"]); assert.equal(taskPreview.worktrees, "auto"); assert.equal(taskPreview.terminal, "manual");
  const task = f.f.runner.launch("demo", ["1.1"])[0]; assert.ok(task.path.startsWith(resources.worktreeRoot + "/"));
  assert.deepEqual(readFileSync(join(f.root, "openspec/runner.yaml")), planBytes);
  assert.equal((await component.import({ ...input, resources, token: preview.token })).assignmentId, binding.assignmentId);
  await assert.rejects(component.import({ ...input, resources: { ...resources, terminal: "manual" }, token: preview.token }), /token|resources|reservation/i);
});

test("local resources reject behavior overlays and preserve import recovery locations", async t => {
  const f = fixture(t), { component, input } = f.imported();
  for (const patch of [{ settings: {} }, { setup: [] }, { verifyIntegration: [] }, { tasks: [] }, { model: "other" }, { scope: [] }, { terminal: "invalid" }]) await assert.rejects(component.inspect({ ...input, resources: patch }), /overlay|resource|unknown|adapter/i);
  const resources = { terminal: "manual", worktrees: "git", worktreeRoot: join(f.dir, "recover workspaces") }, p = await component.inspect({ ...input, resources });
  const integration = join(resources.worktreeRoot, "demo-delegated-assignment-integration"); mkdirSync(integration, { recursive: true }); writeFileSync(join(integration, "obstruction"), "Not a Git worktree\n");
  await assert.rejects(component.import({ ...input, resources, token: p.token }), /git|reservation|worktree/i);
  const { rmSync } = await import("node:fs"); rmSync(integration, { recursive: true, force: true });
  const bound = await component.import({ ...input, resources, token: p.token }); assert.equal(bound.phase, "ready"); assert.ok(f.f.runner.read("demo").integration.path.startsWith(resources.worktreeRoot + "/"));
});

test("ready component reservation rejects missing feature state and writable context directories", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input), binding = await component.import({ ...input, token: p.token });
  const path = join(f.f.repo.stateDir, "features/demo.json"), original = readFileSync(path);
  const { unlinkSync } = await import("node:fs"); unlinkSync(path);
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|delegat|feature/i); assert.throws(() => f.f.runner.prompt("demo", { id: "task", task: "1.1", path: join(f.root, "fake"), agent: "codex" }), /binding|delegat|feature/i);
  writeFileSync(path, original); chmodSync(binding.contextPaths[0], 0o755);
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /pinned|writable|directory/i);
});

test("canonical-only referenced Stores pin specs/config without inventing an active change", async t => {
  const f = fixture(t), upstream = join(f.dir, "canonical upstream"); mkdirSync(upstream); git(upstream, "init", "-b", "main"); git(upstream, "config", "user.name", "Test"); git(upstream, "config", "user.email", "test@example.test"); git(upstream, "config", "openspec-runner.repository", "upstream");
  mkdirSync(join(upstream, "openspec/specs/contracts"), { recursive: true }); writeFileSync(join(upstream, "openspec/specs/contracts/spec.md"), "Canonical linked specification\n"); writeFileSync(join(upstream, "openspec/config.yaml"), "schema: spec-driven\n"); git(upstream, "add", "."); git(upstream, "commit", "-m", "Canonical specs only");
  f.c.repositories.upstream = upstream; f.contract.context.references = [{ storeId: "upstream-store", root: upstream, status: [] }];
  const references = [{ repository: "upstream", root: upstream, storeId: "upstream-store" }], args = { contract: f.contract, references }, p = f.c.approvalPreview(args);
  assert.equal(p.contract.references[0].change, undefined); assert.ok(p.contract.references[0].files.some(file => file.path === "openspec/specs/contracts/spec.md"));
  f.c.approve({ ...args, token: p.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const ap = f.c.assignmentPreview({ ...args, owner: "alice", componentId: "api" }); f.c.assign({ ...args, owner: "alice", componentId: "api", token: ap.token, id: "assignment", operationId: "op-assignment", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const component = new Component({ root: f.root, repository: "api" }), input = { storeRoot: f.storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }, ip = await component.inspect(input), binding = await component.import({ ...input, token: ip.token });
  assert.equal(readFileSync(join(binding.contextPaths[1], "openspec/specs/contracts/spec.md"), "utf8"), "Canonical linked specification\n");
  writeFileSync(join(upstream, "openspec/specs/contracts/spec.md"), "Updated canonical scope\n"); git(upstream, "add", "."); git(upstream, "commit", "-m", "Changed reference scope");
  assert.throws(() => f.c.assignmentPreview({ ...args, owner: "bob", componentId: "api" }), /approval|drift/i);
});

test("resource overrides apply to delegated review and bounded repair without model changes", async t => {
  const f = fixture(t, { unchecked: false }), { component, input } = f.imported();
  executable(join(f.bin, "wt"), `console.log('Worktrunk unavailable in this fixture');`);
  const resources = { terminal: "auto", worktrees: "auto", worktreeRoot: join(f.dir, "feature job workspaces") }, p = await component.inspect({ ...input, resources });
  await component.import({ ...input, resources, token: p.token });
  process.env.HERDR_ENV = "1"; assert.equal(f.f.jobPreview("demo", "review").terminal, "herdr"); delete process.env.HERDR_ENV;
  f.control({ findings: [blocker] }); const review = await f.review(); assert.ok(review.path.startsWith(resources.worktreeRoot + "/"));
  const repairPreview = f.f.jobPreview("demo", "repair"); assert.equal(repairPreview.worktrees, "auto"); assert.equal(repairPreview.settings.model, "test-model");
  const repair = f.f.launch("demo", "repair"); assert.ok(repair.path.startsWith(resources.worktreeRoot + "/")); await f.f.worker("demo", repair.id);
  assert.equal(f.f.read("demo").fixRounds, 1); assert.equal(f.f.read("demo").approval.maxFixRounds, 2);
});

async function approvedStoreAssignment(t, withWeb = false, verifyIntegration = []) {
  const { storePlanningFixture } = await import("./helpers/store-planning-fixture.mjs");
  const { dir, code, storeRoot, write, input } = storePlanningFixture(t);
  git(code, "config", "openspec-runner.repository", "api");
  write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Deliver API\n");
  if (verifyIntegration.length) {
    const config = "components/api/openspec/runner.yaml";
    write(config, JSON.stringify({ ...JSON.parse(readFileSync(join(storeRoot, config), "utf8")), verifyIntegration }));
  }
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Shared contract");
  const featureId = "product", execute = input().execute;
  const repositories = { contracts: storeRoot, api: code };
  if (withWeb) {
    const web = join(dir, "web");
    git(dir, "clone", "--quiet", code, web); git(web, "config", "openspec-runner.repository", "web");
    repositories.web = web;
  }
  const coord = new Coordination({ root: storeRoot, featureId, repositories, execute });
  const contract = { repository: "contracts", context: { implementationRoot: code, planningRoot: storeRoot, changeRoot: join(storeRoot, "openspec/changes/shared"),
    source: "store", storeId: "team", change: "shared", artifactPaths: [], references: [] } };
  const spec = { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [], settings: { ...featureSettings, tasks: {}, verifyIntegration, setup: [] },
    planning: { repository: "contracts", openspecRoot: "components/api/openspec" } };
  const manifest = { version: 2, featureId, storeId: "team", sharedChange: "shared", coordinationBranch: "main", components: { api: spec },
    taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  if (withWeb) manifest.components.web = { ...spec, repository: "web", planning: { repository: "contracts", openspecRoot: "components/web/openspec" },
    dependencies: [{ componentId: "api", milestone: "merged" }] };
  const head = () => git(storeRoot, "rev-parse", "HEAD");
  assert.throws(() => coord.initPreview({ contract, manifest: { ...manifest, components: { api: { ...spec, planning: { ...spec.planning, repository: "other" } } } } }), /repository|Store/i);
  coord.init({ manifest, contract, expectedHead: head(), operationId: "init" });
  const approved = coord.approvalPreview({ contract });
  const approval = { contract, token: approved.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: head() };
  coord.approve(approval);
  const request = { componentId: "api", owner: "alice", contract };
  return { code, storeRoot, write, execute, coord, contract, featureId, request, head, approval, approved };
}

nativeTest("Store-backed assignments inherit approved bytes across coordination commits and verify independent authorities", async t => {
  const { replayStatus, decodeRecord } = await import("../dist/coordination-state.js");
  const { code, storeRoot, write, execute, coord, contract, featureId, request, head, approval } = await approvedStoreAssignment(t);
  write("components/api/guidance.md", "Changed guidance\n");
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Update rules");
  assert.throws(() => coord.assignmentPreview(request), /drift|approval/i);
  git(storeRoot, "revert", "--no-edit", "HEAD");
  const preview = coord.assignmentPreview(request);
  assert.equal(preview.planningSource.revision, approval.expectedHead);
  assert.equal(preview.base, git(code, "rev-parse", "HEAD"));
  assert.equal(JSON.stringify(preview).includes(JSON.stringify(storeRoot).slice(1, -1)), false);
  coord.assign({ ...request, id: "assignment", operationId: "op-assignment", token: preview.token, expectedHead: head() });
  const snapshot = coord.snapshot();
  assert.deepEqual(snapshot.records.map(r => r.version), [2, 2]);
  const assigned = snapshot.records.find(r => r.kind === "assignment");
  assert.throws(() => decodeRecord({ value: { ...assigned, planningSource: { kind: "local", root: code, change: "demo" } } }), /Store/i);
  assert.throws(() => replayStatus({ snapshot: { ...snapshot, records: snapshot.records.map(r => r.kind === "assignment" ? { ...r, planningSource: { ...r.planningSource, revision: head() } } : r) } }), /approval snapshot/i);
  const revoked = { version: 1, id: "revocation", featureId, operationId: "op-revocation", createdAt: approval.createdAt ?? new Date().toISOString(),
    kind: "event", type: "revoked", sequence: 1, componentId: "api", assignmentId: "assignment", reason: "Stopped" };
  assert.throws(() => replayStatus({ snapshot: { ...snapshot, records: [...snapshot.records, revoked] } }), /version/i);
  assert.throws(() => coord.store.authoritativeApproval({ snapshot: { ...snapshot, records: [...snapshot.records, revoked] } }), /version/i);
  const worker = new Component({ root: code, repository: "api", execute });
  const selection = { storeRoot, featureId, assignmentId: "assignment", owner: "alice" };
  assert.throws(() => worker.assignmentContext({ ...selection, historyRevision: "main" }), /full.*revision|full.*commit/i);
  const context = worker.assignmentContext(selection);
  assert.equal(context.execution.planningSource.revision, approval.expectedHead);
  assert.equal(context.execution.runtimeDir.startsWith(join(storeRoot, ".openspec-runner")), true);
  assert.equal(existsSync(context.execution.runtimeDir), false);
  const { expectedContextPaths, componentBindingPath } = await import("../dist/component-state.js");
  const { stableDigest } = await import("../dist/coordination-state.js");
  const stateDir = context.execution.runtimeDir, resources = { terminal: "manual", worktrees: "git", worktreeRoot: context.execution.worktreeRoot };
  const saved = { version: 1, phase: "reserved", repository: "api", change: "demo", assignmentId: assigned.id, featureId, historyRevision: context.historyRevision,
    assignment: assigned, contextPaths: expectedContextPaths({ stateDir, assignment: assigned }), resources,
    token: stableDigest({ value: { assignment: assigned, historyRevision: context.historyRevision, resources } }) };
  const bindingFile = componentBindingPath({ stateDir, change: "demo" });
  mkdirSync(join(stateDir, "components"), { recursive: true }); writeFileSync(bindingFile, JSON.stringify(saved));
  assert.equal(worker.assignmentContext(selection).assignment.id, assigned.id);
  const replacement = { ...assigned, id: "another" };
  writeFileSync(bindingFile, JSON.stringify({ ...saved, assignmentId: replacement.id, assignment: replacement, contextPaths: expectedContextPaths({ stateDir, assignment: replacement }),
    token: stableDigest({ value: { assignment: replacement, historyRevision: context.historyRevision, resources } }) }));
  assert.throws(() => worker.assignmentContext(selection), /reservation|reserves/i);
  unlinkSync(bindingFile);
  const retirementDir = join(stateDir, "component-retirements", featureId);
  mkdirSync(retirementDir, { recursive: true }); writeFileSync(join(retirementDir, `${assigned.id}.json`), "{}");
  assert.throws(() => worker.assignmentContext(selection), /retired|retirement/i);
  unlinkSync(join(retirementDir, `${assigned.id}.json`));
  write("components/api/openspec/changes/demo/new-rule.md", "Added after assignment\n");
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Change selected planning scope");
  assert.throws(() => worker.assignmentContext(selection), /drift/i);
  assert.equal(worker.assignmentContext({ ...selection, historyRevision: context.historyRevision }).assignment.id, assigned.id);
  git(storeRoot, "revert", "--no-edit", "HEAD");
  git(code, "commit", "--allow-empty", "-m", "Move base");
  assert.throws(() => worker.assignmentContext(selection), /base/i);
  git(code, "config", "openspec-runner.repository", "another");
  assert.throws(() => worker.assignmentContext(selection), /repository identity/i);
  git(code, "config", "openspec-runner.repository", "api");
  git(storeRoot, "config", "openspec-runner.repository", "another-store");
  assert.throws(() => worker.assignmentContext(selection), /repository identity/i);
  git(storeRoot, "config", "openspec-runner.repository", "contracts");
  coord.revoke({ id: "revoked", operationId: "op-revoked", expectedHead: head(), assignmentId: assigned.id, reason: "Stopped" });
  assert.throws(() => worker.assignmentContext(selection), /revoked|active/i);
  const renewed = coord.approvalPreview({ contract });
  coord.approve({ contract, id: "reapproval", operationId: "op-reapprove", token: renewed.token, approvedBy: "lead", expectedHead: head() });
  assert.throws(() => worker.assignmentContext(selection), /stale/i);
});

nativeTest("Store assignment remains current after a peer's accepted task updates and exact code delivery", async t => {
  const f = await approvedStoreAssignment(t, true);
  const first = f.coord.assignmentPreview(f.request);
  f.coord.assign({ ...f.request, id: "api-assignment", operationId: "assign-api", token: first.token, expectedHead: f.head() });
  const web = { ...f.request, componentId: "web" };
  assert.throws(() => f.coord.assignmentPreview(web), /requires merged/i);
  git(f.code, "commit", "--allow-empty", "-m", "Deliver code");
  const commit = git(f.code, "rev-parse", "HEAD");
  const metadata = { version: 2, featureId: f.featureId, createdAt: new Date().toISOString() };
  const write = record => f.coord.store.writeRecord({ record: { ...metadata, ...record }, expectedHead: f.head() });
  const receipt = { id: "receipt", operationId: "op-receipt", kind: "submission", assignmentId: "api-assignment",
    owner: first.owner, repository: first.repository, change: first.change, outcome: "completed", base: first.base,
    planFingerprint: first.planFingerprint, planningRevision: first.planningSource.revision, contractFingerprint: first.contract.fingerprint,
    tasks: [{ id: "1.1", completed: true, evidence: { kind: "integrated", attemptId: "attempt", workerCommit: commit, integrationCommit: commit } }],
    review: { commit, findings: [] }, result: { commit, branch: "main" }, verification: [] };
  write(receipt);
  const accepted = { id: "accept", operationId: "op-accept", kind: "event", type: "accepted", sequence: 1,
    assignmentId: "api-assignment", componentId: "api", submissionId: "receipt", commit, verification: [] };
  const snapshot = f.coord.snapshot(), { replayStatus } = await import("../dist/coordination-state.js");
  const fakeBaseline = { ...receipt, ...metadata, tasks: [{ id: "1.1", completed: true, evidence: { kind: "baseline", base: first.base } }] };
  assert.throws(() => replayStatus({ snapshot: { ...snapshot, records: [...snapshot.records.filter(r => r.kind !== "submission"), fakeBaseline, { ...metadata, ...accepted }] } }), /evidence/i);
  write(accepted);
  f.write("components/api/openspec/changes/demo/tasks.md", "- [x] 1.1 Deliver change\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Record accepted task");
  write({ id: "deliver", operationId: "op-deliver", kind: "event", type: "merged", componentId: "api", sequence: 2,
    submissionId: "receipt", commit, deliveryCommit: commit, deliveryBranch: "main", mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "lead" });
  const next = f.coord.assignmentPreview(web);
  assert.equal(next.planningSource.revision, f.approved.components.web.planningSource.revision);
  assert.deepEqual(next.dependencies, [{ componentId: "api", milestone: "merged", commit }]);
});

nativeTest("Store import reserves the protected project in its clone scope and resumes an interrupted snapshot", async t => {
  const f = await approvedStoreAssignment(t);
  const p = f.coord.assignmentPreview(f.request);
  f.coord.assign({ ...f.request, id: "assignment", operationId: "op-assignment", token: p.token, expectedHead: f.head() });
  const worker = new Component({ root: f.code, repository: "api", execute: f.execute });
  const selection = { featureId: f.featureId, storeRoot: f.storeRoot, assignmentId: "assignment", owner: "alice" };
  const { execution, assignment } = worker.assignmentContext(selection);
  const stateDir = execution.runtimeDir;
  if (process.platform === "win32") {
    try { assertWindowsContextHost(stateDir); }
    catch (error) {
      if (!/without backup or restore privileges/.test(error.message)) throw error;
      await assert.rejects(worker.inspect(selection), /without backup or restore privileges/);
      assert.equal(existsSync(stateDir), false);
      return;
    }
  }
  const { expectedContextPaths, readComponentBinding } = await import("../dist/component-state.js");
  const bin = join(f.code, "..", "tools"); mkdirSync(bin);
  executable(join(bin, "codex"), 'console.log("--add-dir --model --cd");');
  const previousPath = process.env.PATH;
  process.env.PATH = bin + (process.platform === "win32" ? ";" : ":") + previousPath;
  const paths = expectedContextPaths({ stateDir, assignment });
  const tasks = join(paths.at(-1), "components/api/openspec/changes/demo/tasks.md");
  try {
    const inspect = await worker.inspect(selection);
    assert.equal(existsSync(stateDir), false);
    mkdirSync(join(tasks, ".."), { recursive: true }); writeFileSync(tasks, "partial");
    await assert.rejects(worker.import({ ...selection, token: inspect.token }), /differ|content|bytes/i);
    assert.equal(readComponentBinding({ stateDir, change: "demo" }).phase, "reserved");
    unlinkSync(tasks);
    if (process.platform !== "win32") {
      writeFileSync(tasks, "- [ ] 1.1 Deliver change\n");
      const extra = join(tasks, "..", "unapproved.yaml");
      writeFileSync(extra, "left over from another plan\n");
      await assert.rejects(worker.import({ ...selection, token: inspect.token }), /unexpected pinned snapshot entry/i);
      unlinkSync(extra);
    }
    const resumed = await worker.import({ ...selection, token: inspect.token });
    assert.equal(resumed.phase, "ready");
    assert.equal(readFileSync(tasks, "utf8"), "- [ ] 1.1 Deliver change\n");
    assert.equal(existsSync(join(f.code, "openspec")), false);
    assert.equal(existsSync(join(f.code, ".git/openspec-runner")), false);
    assert.deepEqual(await worker.import({ ...selection, token: inspect.token }), resumed);
    assert.equal(git(f.storeRoot, "status", "--porcelain"), "");
  } finally {
    process.env.PATH = previousPath;
    if (process.platform === "win32") restoreWindowsContext(windowsContextRequest(stateDir, { assignment, contextPaths: paths }));
    else {
      const unlock = path => {
        if (!existsSync(path)) return;
        if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
      };
      unlock(stateDir);
    }
  }
});

nativeTest("historical Store import refuses a revoked assignment before reserving or resuming", async t => {
  const f = await approvedStoreAssignment(t);
  const p = f.coord.assignmentPreview(f.request);
  f.coord.assign({ ...f.request, id: "issue", operationId: "assign", token: p.token, expectedHead: f.head() });
  const worker = new Component({ root: f.code, repository: "api", execute: f.execute });
  const options = { storeRoot: f.storeRoot, featureId: f.featureId, assignmentId: "issue", owner: "alice", historyRevision: f.head() };
  const { assignment, execution, historyRevision } = worker.assignmentContext(options);
  const { stableDigest } = await import("../dist/coordination-state.js");
  const { componentBindingPath, expectedContextPaths } = await import("../dist/component-state.js");
  const stateDir = execution.runtimeDir, resources = { terminal: "manual", worktrees: "git", worktreeRoot: execution.worktreeRoot };
  const token = stableDigest({ value: { assignment, historyRevision, resources } });
  // Isolate mutation authorization from machine capabilities, including privileged Windows hosts.
  t.mock.method(worker, "inspect", async () => ({ assignment, historyRevision, resources, token }));
  f.coord.revoke({ assignmentId: "issue", reason: "Superseded", id: "stop", operationId: "stop-issue", expectedHead: f.head() });
  git(f.storeRoot, "switch", "--detach", `${f.approved.components.api.planningSource.revision}^`);
  assert.equal(worker.assignmentContext(options).assignment.id, "issue");
  const file = componentBindingPath({ stateDir, change: "demo" });
  await assert.rejects(worker.import({ ...options, token }), /revoked|no longer active/i);
  assert.equal(existsSync(file), false);
  mkdirSync(join(file, ".."), { recursive: true });
  const saved = JSON.stringify({ version: 1, phase: "reserved", repository: "api", change: "demo", assignmentId: assignment.id,
    featureId: assignment.featureId, historyRevision, token, assignment, resources, contextPaths: expectedContextPaths({ stateDir, assignment }) });
  writeFileSync(file, saved);
  await assert.rejects(worker.import({ ...options, token }), /revoked|no longer active/i);
  assert.equal(readFileSync(file, "utf8"), saved);
  assert.equal(existsSync(join(stateDir, "component-context")), false);
});

nativeTest("Store preflight accepts shared checkbox progress and rejects changed primary contract selections", async t => {
  const f = await approvedStoreAssignment(t);
  const p = f.coord.assignmentPreview(f.request);
  f.coord.assign({ ...f.request, id: "issue", operationId: "assign", token: p.token, expectedHead: f.head() });
  const worker = new Component({ root: f.code, repository: "api", execute: f.execute });
  const options = { storeRoot: f.storeRoot, featureId: f.featureId, assignmentId: "issue", owner: "alice" };
  f.write("openspec/changes/shared/tasks.md", "- [x] 1.1 Deliver API\n");
  f.write("unrelated.txt", "Other work\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Advance shared progress");
  const clean = worker.assignmentContext(options);
  assert.equal(clean.assignment.contract.files.find(file => file.path.endsWith("/tasks.md")).content, "- [ ] 1.1 Deliver API\n");
  f.write("openspec/specs/api/spec.md", "Different public contract\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Add selected API spec");
  assert.throws(() => worker.assignmentContext(options), /shared contract|primary contract/i);
  assert.deepEqual(worker.assignmentContext({ ...options, historyRevision: clean.historyRevision }).assignment.contract, clean.assignment.contract);
});

nativeTest("Store replay requires exact passing verification evidence on receipt and acceptance", async t => {
  const checks = [["node", "--test"]], passing = [{ command: checks[0], exitCode: 0, evidence: "Passed" }];
  const f = await approvedStoreAssignment(t, false, checks);
  const p = f.coord.assignmentPreview(f.request);
  f.coord.assign({ ...f.request, id: "issue", operationId: "assign", token: p.token, expectedHead: f.head() });
  const { replayStatus } = await import("../dist/coordination-state.js");
  const snapshot = f.coord.snapshot(), commit = git(f.code, "rev-parse", "HEAD");
  const metadata = { version: 2, featureId: f.featureId, createdAt: new Date().toISOString() };
  const receipt = { ...metadata, id: "receipt", operationId: "op-receipt", kind: "submission", assignmentId: "issue", owner: p.owner,
    repository: p.repository, change: p.change, outcome: "completed", base: p.base, planFingerprint: p.planFingerprint, planningRevision: p.planningSource.revision,
    contractFingerprint: p.contract.fingerprint, result: { commit, branch: "main" }, review: { commit, findings: [] },
    tasks: [{ id: "1.1", completed: true, evidence: { kind: "integrated", attemptId: "a", workerCommit: commit, integrationCommit: commit } }], verification: passing };
  const event = { ...metadata, id: "accept", operationId: "op-accept", kind: "event", type: "accepted", sequence: 1, assignmentId: "issue",
    componentId: "api", submissionId: "receipt", commit, verification: passing };
  const replay = (r, e) => replayStatus({ snapshot: { ...snapshot, records: [...snapshot.records, r, e] } });
  assert.equal(replay(receipt, event).components.api.acceptedCommit, commit);
  for (const invalid of [[], [{ ...passing[0], command: ["node", "--version"] }], [{ ...passing[0], exitCode: 1 }]]) {
    assert.throws(() => replay({ ...receipt, verification: invalid }, event));
    assert.throws(() => replay(receipt, { ...event, verification: invalid }));
  }
  assert.throws(() => replay(receipt, { ...event, verification: undefined }));
});

nativeTest("Store snapshot retry rejects undeclared entries beside approved files", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "runner-snapshot-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { assertDeclaredSnapshotEntries } = await import("../dist/component-state.js");
  const files = [{ path: "project/openspec/tasks.md", content: "Approved\n" }];
  const dir = join(root, "project/openspec");
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "tasks.md"), files[0].content);
  writeFileSync(join(dir, "added.yaml"), "unapproved\n");
  assert.throws(() => assertDeclaredSnapshotEntries(root, files), /undeclared|unexpected/i);
  unlinkSync(join(dir, "added.yaml")); mkdirSync(join(root, "extra"));
  assert.throws(() => assertDeclaredSnapshotEntries(root, files), /undeclared|unexpected/i);
  rmdirSync(join(root, "extra"));
  assertDeclaredSnapshotEntries(root, files);
});

nativeTest("Store rejects unsafe assignment filenames before publication", async t => {
  const f = await approvedStoreAssignment(t);
  const p = f.coord.assignmentPreview(f.request);
  const before = f.head();
  assert.throws(() => f.coord.assign({ ...f.request, id: "AUX", operationId: "issue", token: p.token, expectedHead: before }), /unsafe Store path ID/i);
  assert.equal(f.head(), before);
});
