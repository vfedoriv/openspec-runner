import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { editExecutionSettings } from "../dist/execution-settings.js";

test("assignment preview preserves bytes and rejects stale settings before applying", t => {
  const root = mkdtempSync(join(tmpdir(), "runner-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  const directory = join(root, "openspec", "changes", "demo");
  mkdirSync(directory, { recursive: true });
  const execution = join(directory, "execution.yaml");
  const before = "version: 1\r\ntasks:\r\n  1.1:\r\n    # preserve this comment\r\n    parallel: true\r\n";
  writeFileSync(join(root, "openspec", "runner.yaml"), "version: 1\n");
  writeFileSync(join(directory, "tasks.md"), "- [ ] 1.1 Example\n");
  writeFileSync(execution, before);
  git("add", ".");
  git("-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "-m", "Plan");
  const patch = { tasks: [{ id: "1.1", model: "example-model", effort: "high" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  assert.equal(readFileSync(execution, "utf8"), before);
  assert.equal(preview.changes[0].effective.reasoningEffort, "high");
  assert.equal(preview.changes[0].modelSource, "Task setting");
  assert.equal(preview.changes[0].effortSource, "Task setting");
  const unresolved = editExecutionSettings("demo", { tasks: [{ id: "1.1", effort: "high" }] }, undefined, root);
  assert.equal(unresolved.changes[0].effective, undefined);
  assert.match(unresolved.changes[0].validation, /after the model resolves/);
  assert.throws(() => editExecutionSettings("demo", { tasks: [{ id: "1.1", effort: "\n" }] }, undefined, root), /Invalid effort/);
  writeFileSync(execution, before + "# concurrent edit\r\n");
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /stale/);
  const updated = editExecutionSettings("demo", patch, undefined, root);
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url)),
    "execution-settings", "demo", "--file", "-", "--json", ...args,
  ], { cwd: root, input: JSON.stringify(patch), encoding: "utf8" }));
  assert.equal(cli("--dry-run").token, updated.token);
  assert.equal(cli("--confirm", updated.token).applied, true);
  const saved = readFileSync(execution, "utf8");
  assert.match(saved, /# preserve this comment\r\n/);
  assert.match(saved, /parallel: true\r\n/);
  assert.match(saved, /reasoningEffort: high\r\n/);
  const clear = { tasks: [{ id: "1.1", model: null, effort: null }] };
  const reset = editExecutionSettings("demo", clear, undefined, root);
  assert.equal(reset.changes[0].after.model, undefined);
  assert.throws(() => editExecutionSettings("demo", { tasks: [{ id: "9.9", model: "other" }] }, undefined, root), /Unknown or duplicate task/);
  assert.throws(() => editExecutionSettings("demo", { tasks: [{ id: "1.1" }, { id: "1.1" }] }, undefined, root), /Unknown or duplicate task/);
  const next = editExecutionSettings("demo", clear, undefined, root);
  git("-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Advance HEAD");
  assert.throws(() => editExecutionSettings("demo", clear, next.token, root), /stale/);
  writeFileSync(join(directory, "tasks.md"), "- [x] 1.1 Example\n");
  assert.throws(() => editExecutionSettings("demo", clear, undefined, root), /already satisfied/);
});

test("bulk starter preview is read-only and publishes v2 assignments exclusively", async t => {
  const { featureFixture, git } = await import("./helpers/feature-fixture.mjs");
  const { root } = featureFixture(t, { unchecked: true });
  const directory = join(root, "openspec/changes/demo");
  const path = join(directory, "execution.yaml");
  rmSync(path);
  writeFileSync(join(directory, "tasks.md"), "- [ ] 1.1 First\n- [ ] 1.2 Second\n");
  const patch = { tasks: [{ id: "1.1", model: "a", effort: "high" }, { id: "1.2", model: "b", effort: "low" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  assert.equal(preview.createsFile, true);
  assert.throws(() => readFileSync(path), { code: "ENOENT" });
  assert.match(preview.diff, /Task 1\.1\n- model: inherit\n\+ model: a/);
  assert.deepEqual(preview.changes.map(row => row.effective.effort), ["high", "low"]);
  editExecutionSettings("demo", patch, preview.token, root);
  const saved = readFileSync(path, "utf8");
  assert.match(saved, /version: 2/);
  const { collectDashboard } = await import("../dist/dashboard-reader.js");
  const reopened = collectDashboard({ cwd: root, change: "demo" });
  assert.deepEqual(reopened.tasks.map(row => [row.assignment.model, row.assignment.effort]), [["a", "high"], ["b", "low"]]);
  assert.match(saved, /effort: low/);
  assert.doesNotMatch(saved, /reasoningEffort/);
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /stale/);
  assert.equal(editExecutionSettings("demo", patch, undefined, root).message, "No assignment changes");
  const mixed = { tasks: [{ id: "1.1", effort: null }, { id: "1.2", model: "c" }] };
  const changed = editExecutionSettings("demo", mixed, undefined, root);
  assert.deepEqual(changed.changes.map(row => [row.after.model, row.after.effort]), [["a", undefined], ["c", "low"]]);
  assert.match(git(root, "status", "--short"), /execution.yaml/);
});

test("Claude effort can be set and cleared before the inherited model resolves", async t => {
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { root } = featureFixture(t, { unchecked: true });
  const path = join(root, "openspec/changes/demo/execution.yaml");
  writeFileSync(path, 'version: 2\nagent: claude\ntasks:\n  "1.1": {}\n');
  const patch = { tasks: [{ id: "1.1", effort: "high" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  assert.equal(preview.changes[0].effective, undefined);
  assert.equal(preview.changes[0].modelSource, "Unresolved");
  assert.equal(preview.changes[0].effortSource, "Task setting");
  assert.match(preview.changes[0].validation, /after the model resolves/);
  editExecutionSettings("demo", patch, preview.token, root);
  assert.match(readFileSync(path, "utf8"), /effort: high/);
  const clear = { tasks: [{ id: "1.1", effort: null }] };
  const reset = editExecutionSettings("demo", clear, undefined, root);
  editExecutionSettings("demo", clear, reset.token, root);
  assert.doesNotMatch(readFileSync(path, "utf8"), /effort:/);
});

test("committed assignment changes require reconcile and approval before a retry", async t => {
  const { featureFixture, featureSettings, git } = await import("./helpers/feature-fixture.mjs");
  const { root, r, f, approve } = featureFixture(t, { unchecked: true });
  approve();
  const [attempt] = r.launch("demo", ["1.1"]);
  const patch = { tasks: [{ id: "1.1", model: "replacement", effort: "medium" }] };
  assert.throws(() => editExecutionSettings("demo", patch, undefined, root), /active work/);
  const state = r.read("demo");
  state.attempts[0].phase = "failed";
  r.save(state);
  const preview = editExecutionSettings("demo", patch, undefined, root);
  const execution = join(root, "openspec/changes/demo/execution.yaml");
  const original = readFileSync(execution);
  state.attempts[0].phase = "completed";
  state.attempts[0].worker = { token: "test", exitedAt: "now", exitCode: 0, log: "test.log" };
  state.attempts[0].report = { attempt: attempt.id, task: "1.1", session: "done", outcome: "completed", summary: "Done", verification: [] };
  r.save(state);
  assert.throws(() => editExecutionSettings("demo", patch, undefined, root), /Integrate completed task/);
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /Integrate completed task/);
  assert.deepEqual(readFileSync(execution), original);
  delete state.attempts[0].worker;
  delete state.attempts[0].report;
  state.attempts[0].phase = "failed";
  state.attempts[0].description = "Changed after preview";
  r.save(state);
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /stale/);
  const reviewed = editExecutionSettings("demo", patch, undefined, root);
  assert.match(reviewed.nextSteps.join(" "), /All unintegrated attempts become stale/);
  editExecutionSettings("demo", patch, reviewed.token, root);
  assert.throws(() => r.preview("demo", ["1.1"]), /approval|reconcile/i);
  git(root, "add", "openspec/changes/demo/execution.yaml");
  git(root, "commit", "-m", "Assign replacement model");
  r.reconcile("demo");
  assert.equal(r.read("demo").attempts[0].phase, "stale");
  assert.throws(() => r.preview("demo", ["1.1"]), /approval/i);
  f.approve("demo", featureSettings, f.planPreview("demo", featureSettings).token);
  const [retry] = r.launch("demo", ["1.1"], undefined, undefined, true);
  assert.notEqual(retry.id, attempt.id);
  assert.equal(retry.settings.model, "replacement");
  assert.equal(retry.settings.reasoningEffort, "medium");
  assert.equal(r.read("demo").attempts[0].settings.model, attempt.settings.model);
  const integrated = r.read("demo");
  integrated.attempts.at(-1).phase = "integrated";
  delete integrated.attempts.at(-1).worker;
  r.save(integrated);
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [x] 1.1 Produce output\n- [ ] 1.2 Follow-up\n");
  writeFileSync(execution, readFileSync(execution, "utf8") + '  "1.2": {}\n');
  const next = editExecutionSettings("demo", { tasks: [{ id: "1.2", model: "next" }] }, undefined, root);
  assert.equal(next.changes[0].task, "1.2");
});

test("assignment edits fail closed on redirected files and component authority", async t => {
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { symlinkSync } = await import("node:fs");
  const { componentBindingPath } = await import("../dist/component-state.js");
  const { dirname } = await import("node:path");
  const { root, dir, r } = featureFixture(t, { unchecked: true });
  const path = join(root, "openspec/changes/demo/execution.yaml");
  const original = readFileSync(path, "utf8");
  const patch = { tasks: [{ id: "1.1", model: "new" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  const binding = componentBindingPath({ stateDir: r.repo.stateDir, change: "demo" });
  mkdirSync(dirname(binding), { recursive: true });
  writeFileSync(binding, "{}");
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /binding|record|schema|object/i);
  assert.equal(readFileSync(path, "utf8"), original);
  rmSync(binding);
  const external = join(dir, "external.yaml");
  writeFileSync(external, original);
  rmSync(path);
  try { symlinkSync(external, path, "file"); }
  catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    const directory = dirname(path);
    const externalDirectory = join(dir, "external-plan");
    mkdirSync(externalDirectory);
    writeFileSync(join(externalDirectory, "execution.yaml"), original);
    rmSync(directory, { recursive: true });
    symlinkSync(externalDirectory, directory, "junction");
  }
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /ordinary|outside|symlink/i);
  assert.equal(readFileSync(external, "utf8"), original);
});

test("assignment editor rejects YAML aliases and preserves reviewed bytes", async t => {
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { root } = featureFixture(t, { unchecked: true });
  const directory = join(root, "openspec/changes/demo");
  const path = join(directory, "execution.yaml");
  const patch = { tasks: [{ id: "1.1", model: "new" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  const aliased = 'version: 1\nshared: &assignment {}\ntasks:\n  "1.1": *assignment\n';
  writeFileSync(path, aliased);
  for (const token of [undefined, preview.token]) {
    assert.throws(() => editExecutionSettings("demo", patch, token, root), /Resolve YAML aliases/);
    assert.equal(readFileSync(path, "utf8"), aliased);
  }
});

test("assignment editor rechecks managed lifecycle guards on confirmation", async t => {
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { saveFeature } = await import("../dist/feature-state.js");
  const { root, r, f } = featureFixture(t, { unchecked: true });
  f.start("demo");
  const original = f.read("demo");
  const path = join(root, "openspec/changes/demo/execution.yaml");
  const bytes = readFileSync(path);
  const patch = { tasks: [{ id: "1.1", model: "new" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  for (const [name, state, error] of [
    ["wrong planning checkout", { ...original, planningRoot: join(root, "other") }, /recorded planning checkout/],
    ["completed feature", { ...original, phase: "completed" }, /Finish active work and pending integration/],
    ["archiving feature", { ...original, phase: "archiving", archive: { head: "a".repeat(40) } }, /Finish active work and pending integration/],
    ["repair awaiting integration", { ...original, jobs: [{ role: "repair", phase: "completed", report: { outcome: "completed" } }] }, /Finish active work and pending integration/],
    ["uncertain termination", { ...original, jobs: [{ role: "review", phase: "failed", worker: { terminationUncertain: true } }] }, /Finish active work and pending integration/],
    ["integration transaction", { ...original, transaction: { attempt: "repair", before: "a".repeat(40), marker: "test", phase: "merging" } }, /Finish active work and pending integration/],
  ]) {
    saveFeature(r.repo.stateDir, state);
    for (const token of [undefined, preview.token]) {
      assert.throws(() => editExecutionSettings("demo", patch, token, root), error, name);
      assert.deepEqual(readFileSync(path), bytes, name);
    }
  }
});

test("Windows sharing violation preserves execution.yaml and leaves a retryable preview", { skip: process.platform !== "win32", timeout: 20000 }, async t => {
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { readdirSync } = await import("node:fs");
  const { root } = featureFixture(t, { unchecked: true });
  const directory = join(root, "openspec/changes/demo");
  const path = join(directory, "execution.yaml");
  const original = readFileSync(path, "utf8");
  const patch = { tasks: [{ id: "1.1", model: "new" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  const script = `$f=[IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'Read', 'ReadWrite'); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $f.Dispose()`;
  const reader = spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(reader, "close");
  try {
    await Promise.race([once(reader.stdout, "data"), closed.then(() => { throw new Error("Could not acquire sharing lock"); })]);
    assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), { code: /EPERM|EACCES|EBUSY/ });
    assert.equal(readFileSync(path, "utf8"), original);
    assert.ok(readdirSync(directory).every(name => !name.endsWith(".tmp")));
  } finally { reader.stdin.end("\n"); await closed; }
  assert.equal(editExecutionSettings("demo", patch, preview.token, root).applied, true);
});
