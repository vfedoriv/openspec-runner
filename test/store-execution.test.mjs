import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Feature } from "../dist/feature.js";
import { pinStorePlan } from "../dist/planning-source.js";
import { assertStoreBindingAuthority, resolveBoundExecutionContext, resolveExecutionContext } from "../dist/execution-context.js";
import { Coordination } from "../dist/coordination.js";
import { Component } from "../dist/component.js";
import { saveFeature } from "../dist/feature-state.js";
import { storePlanningFixture } from "./helpers/store-planning-fixture.mjs";
import { storeFeatureFixture } from "./helpers/store-feature-fixture.mjs";
import { git } from "./helpers/store-planning-fixture.mjs";

if (process.platform === "win32" && !process.env.OPENSPEC_TEST_STANDARD_CHILD) {
  test("Store execution in a Windows child without backup or restore privileges", () => {
    let output;
    try { output = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./helpers/standard-windows-child.ps1", import.meta.url))], {
      input: JSON.stringify({ node: process.execPath, args: ["--test", fileURLToPath(import.meta.url)] }),
      encoding: "utf8", windowsHide: true, timeout: 270000,
    }); } catch (error) { throw new Error(error.stdout || error.stderr || error.message); }
    assert.match(output, /Store execution routes planning and runtime independently/);
  });
} else {
test("Store execution routes planning and runtime independently of the code repository", t => {
  const f = storePlanningFixture(t);
  const source = pinStorePlan(f.input());
  const context = resolveExecutionContext({ implementationRoot: f.code, change: "demo",
    store: { storeRoot: f.storeRoot, featureId: "feature", componentId: "api", assignmentId: "assignment", source } });
  const feature = new Feature(f.code, undefined, context);
  assert.equal(feature.repo.stateDir, context.runtimeDir);
  assert.equal(feature.runner.plan("demo").fingerprint, source.fingerprint);
  assert.equal(feature.runner.plan("demo").config.agents.codex.defaultModel, "api");
  assert.throws(() => feature.runner.preview("demo", ["1.1"]), /import|assignment|binding/i);
  assert.throws(() => feature.start("demo"), /Store.*import|import.*Store|assignment/i);
  assert.equal(existsSync(context.runtimeDir), false);
  assert.equal(existsSync(join(f.code, "openspec")), false);
  assert.equal(existsSync(join(f.code, ".openspec-runner")), false);
});

test("Store import activates a recoverable code-only integration worktree", async t => {
  const f = await storeFeatureFixture(t);
  const imported = await f.component.import({ ...f.selection, token: f.preview.token });
  assert.equal(imported.phase, "ready");
  const feature = new Feature(f.code, undefined, f.execution);
  const state = feature.runner.read("demo");
  assert.equal(feature.read("demo").phase, "implementing");
  assert.equal(git(state.integration.path, "rev-parse", "HEAD"), imported.assignment.base);
  assert.equal(existsSync(join(state.integration.path, "openspec")), false);
  assert.equal(existsSync(join(f.code, "openspec")), false);
  assert.equal(existsSync(join(f.code, ".openspec-runner")), false);
  const retried = await f.component.import({ ...f.selection, token: f.preview.token });
  assert.equal(retried.phase, "ready");
  assert.equal(feature.runner.read("demo").integration.path, state.integration.path);
  const bound = resolveBoundExecutionContext({ implementationRoot: state.integration.path, storeRoot: f.storeRoot,
    featureId: "product", componentId: "api", change: "demo" });
  assert.equal(bound.runtimeDir, f.execution.runtimeDir);
  assert.equal(assertStoreBindingAuthority(bound, "demo").assignmentId, "assignment");
  const assigned = imported.assignment;
  const blocked = { version: 2, kind: "submission", id: "blocked-receipt", operationId: "blocked-receipt", createdAt: new Date().toISOString(),
    featureId: assigned.featureId, assignmentId: assigned.id, owner: assigned.owner, repository: assigned.repository, change: assigned.change,
    base: assigned.base, planFingerprint: assigned.planFingerprint, contractFingerprint: assigned.contract.fingerprint,
    planningRevision: assigned.planningSource.revision, outcome: "blocked", reason: "Owner will repair within the approved scope", tasks: [], verification: [] };
  f.coordinator.importSubmission({ bytes: JSON.stringify(blocked), expectedHead: f.head() });
  assert.doesNotThrow(() => assertStoreBindingAuthority(bound, "demo"));

  const launch = feature.runner.launch("demo", ["1.1"]);
  const task = feature.runner.read("demo").attempts.at(-1);
  assert.ok(feature.runner.workerCommand("demo", task).includes("--store"));
  assert.match(feature.runner.prompt("demo", task), /Read .*SKILL\.md/);
  assert.equal(launch.length, 1);
  assert.equal(existsSync(join(task.path, "openspec")), false);
  const worker = await feature.runner.worker("demo", "1.1", task.id);
  assert.equal(worker.exitCode, 0);
  assert.equal(feature.runner.latest(feature.runner.read("demo"), "1.1").phase, "completed");
  feature.runner.integrate("demo", ["1.1"]);
  assert.equal(feature.runner.latest(feature.runner.read("demo"), "1.1").phase, "integrated");
  assert.equal(feature.runner.status("demo").tasks[0].completed, true);
  const integrated = feature.runner.read("demo"), integratedHead = integrated.head;
  const previous = git(integrated.integration.path, "rev-parse", "HEAD^1");
  integrated.head = previous;
  integrated.transaction = { tasks: ["1.1"], current: "1.1", before: previous, phase: "committing", marker: `openspec-runner:${task.id}` };
  integrated.attempts.at(-1).phase = "completed";
  delete integrated.attempts.at(-1).integrationCommit;
  feature.runner.save(integrated);
  feature.runner.integrate("demo", [], "continue");
  assert.equal(feature.runner.read("demo").head, integratedHead);
  assert.equal(feature.runner.latest(feature.runner.read("demo"), "1.1").integrationCommit, integratedHead);
  assert.equal(git(f.storeRoot, "show", "HEAD:components/api/openspec/changes/demo/tasks.md").includes("[x]"), false);
  assert.equal(git(state.integration.path, "ls-tree", "-r", "--name-only", "HEAD").includes("openspec"), false);
  const blocker = { id: "F1", category: "correctness", location: "result.txt:1", impact: "Repair required", correction: "Write repaired output" };
  f.control({ findings: [blocker] });
  const review = feature.launch("demo", "review");
  assert.equal((await feature.worker("demo", review.id)).exitCode, 0);
  const repair = feature.launch("demo", "repair");
  assert.equal((await feature.worker("demo", repair.id)).exitCode, 0);
  feature.integrate("demo", repair.id);
  const repaired = feature.runner.read("demo"), repairedHead = repaired.head;
  const repairState = feature.read("demo"), beforeRepair = git(repaired.integration.path, "rev-parse", "HEAD^1");
  repairState.transaction = { attempt: repair.id, before: beforeRepair, marker: `openspec-runner-repair:${repair.id}`, phase: "committing" };
  repairState.jobs.find(job => job.id === repair.id).phase = "completed";
  repaired.head = beforeRepair;
  feature.runner.save(repaired); saveFeature(feature.repo.stateDir, repairState);
  feature.integrate("demo", undefined, "continue");
  assert.equal(feature.runner.read("demo").head, repairedHead);
  f.control({});
  const finalReview = feature.launch("demo", "review");
  assert.equal((await feature.worker("demo", finalReview.id)).exitCode, 0);
  assert.equal(feature.submissionEvidence({ change: "demo" }).tasks[0].completed, true);
  const exporter = new Component({ root: f.code, repository: "api", execution: f.execution });
  const submission = { change: "demo", outcome: "completed" };
  const submissionPreview = exporter.submissionPreview(submission);
  assert.equal(submissionPreview.tasks[0].evidence.kind, "integrated");
  const exported = exporter.exportSubmission({ ...submission, id: "completed-receipt", operationId: "completed-receipt", token: submissionPreview.token });
  assert.equal(exported.record.version, 2);
  const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
  const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "demo", ...feature.runner.storeArgs(), "--json"], { cwd: f.code, encoding: "utf8" }));
  assert.equal(status.tasks[0].completed, true);

  const otherStore = join(f.dir, "other-store");
  git(f.dir, "clone", "--quiet", f.storeRoot, otherStore);
  git(otherStore, "config", "openspec-runner.repository", "contracts");
  git(otherStore, "config", "user.name", "Other coordinator");
  git(otherStore, "config", "user.email", "other@example.test");
  const execute = ({ cwd, args }) => args[0] === "status"
    ? JSON.stringify({ root: { path: cwd, source: "nearest" }, planningHome: { root: cwd }, changeRoot: "openspec/changes/demo", artifactPaths: {} })
    : args[0] === "doctor" ? '{"references":[]}' : '{"state":"ready"}';
  const other = new Coordination({ root: otherStore, featureId: "product", repositories: { contracts: otherStore, api: f.code }, execute });
  const otherHead = () => git(otherStore, "rev-parse", "HEAD");
  other.revoke({ id: "revoke-old", operationId: "revoke-old", expectedHead: otherHead(), assignmentId: "assignment", reason: "New owner" });
  const contract = { ...f.contract, context: { ...f.contract.context, planningRoot: otherStore, changeRoot: join(otherStore, "openspec/changes/shared") } };
  const request = { contract, componentId: "api", owner: "owner" };
  other.assign({ ...request, id: "other-assignment", operationId: "other-assignment", expectedHead: otherHead(), token: other.assignmentPreview(request).token });
  const otherComponent = new Component({ root: f.code, repository: "api", execute });
  const selection = { ...f.selection, storeRoot: otherStore, assignmentId: "other-assignment" };
  const otherPreview = await otherComponent.inspect(selection);
  f.trackExecution(otherComponent.assignmentContext(selection).execution);
  await assert.rejects(otherComponent.import({ ...selection, token: otherPreview.token }), /Store.*owner|another Store|ownership/i);
  f.coordinator.revoke({ id: "stop-original", operationId: "stop-original", expectedHead: f.head(), assignmentId: "assignment", reason: "Retire original owner" });
  assert.throws(() => feature.runner.report("demo", "1.1", task.id, {}), /revoked|stale|assignment/i);
  const local = new Component({ root: f.code, repository: "api", execution: f.execution });
  const retirement = { change: "demo", assignmentId: "assignment", owner: "owner", reason: "Release completed local execution" };
  const retire = local.retirementPreview(retirement);
  assert.equal(local.retire({ ...retirement, token: retire.token }).phase, "retired");
  assert.throws(() => feature.runner.report("demo", "1.1", task.id, {}), /assignment|import|retired/i);
  const replacement = await otherComponent.import({ ...selection, token: otherPreview.token });
  assert.equal(replacement.phase, "ready");
});
}
