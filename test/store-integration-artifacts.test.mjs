import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Feature } from "../dist/feature.js";
import { saveFeature } from "../dist/feature-state.js";
import { storeFeatureFixture } from "./helpers/store-feature-fixture.mjs";
import { git } from "./helpers/store-planning-fixture.mjs";

if (process.platform === "win32" && !process.env.OPENSPEC_TEST_STANDARD_CHILD) {
  test("Store integration artifacts in a standard Windows child", () => {
    try { execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./helpers/standard-windows-child.ps1", import.meta.url))], {
      input: JSON.stringify({ node: process.execPath, args: ["--test", fileURLToPath(import.meta.url)] }), encoding: "utf8", windowsHide: true, timeout: 270000,
    }); } catch (error) { throw new Error(error.stdout || error.stderr || error.message); }
  });
} else {
  test("Store integrations reject staged artifacts and polluted crash recovery", async t => {
    const f = await storeFeatureFixture(t);
    await f.component.import({ ...f.selection, token: f.preview.token });
    const feature = new Feature(f.code, undefined, f.execution), runner = feature.runner;
    runner.launch("demo", ["1.1"]);
    const task = runner.read("demo").attempts.at(-1);
    assert.equal((await runner.worker("demo", "1.1", task.id)).exitCode, 0);
    // Obtain the real integration worktree, then reconstruct its interrupted transaction.
    runner.integrate("demo", ["1.1"]);
    const taskDone = runner.read("demo"), path = taskDone.integration.path;
    const taskPending = structuredClone(taskDone);
    taskPending.head = task.base;
    taskPending.attempts.at(-1).phase = "completed";
    delete taskPending.attempts.at(-1).integrationCommit;
    taskPending.transaction = { tasks: ["1.1"], current: "1.1", before: task.base, marker: `openspec-runner:${task.id}`, phase: "checking" };
    const stage = name => { mkdirSync(dirname(join(path, name)), { recursive: true }); writeFileSync(join(path, name), "evidence\n", "utf8"); git(path, "add", "--", name); };
    const exercise = async (role, pending, before, worker, marker, invoke, read, save) => {
      for (const name of ["openspec/changes/other/tasks.md", ".openspec-runner/state.json", "OpenSpec/other.md", ".OPENSPEC-RUNNER/evidence.json"]) {
        await t.test(`${role} rejects ${name} before commit`, () => {
          git(path, "reset", "--hard", before); save(structuredClone(pending));
          git(path, "merge", "--no-ff", "--no-commit", worker); stage(name);
          const index = git(path, "write-tree");
          assert.throws(invoke, /planning|runtime|artifact/i);
          assert.equal(git(path, "rev-parse", "HEAD"), before);
          assert.equal(git(path, "write-tree"), index);
          assert.ok(read().transaction);
          assert.notEqual(role === "task" ? read().attempts.at(-1).phase : read().jobs.at(-1).phase, "integrated");
        });
        await t.test(`${role} rejects polluted committed recovery ${name}`, () => {
          git(path, "reset", "--hard", before); save(structuredClone(pending));
          git(path, "merge", "--no-ff", "--no-commit", worker); stage(name);
          git(path, "commit", "-m", `Interrupted integration\n\n${marker}`);
          const head = git(path, "rev-parse", "HEAD");
          assert.throws(invoke, /planning|runtime|artifact/i);
          assert.equal(git(path, "rev-parse", "HEAD"), head);
          assert.ok(read().transaction);
          assert.notEqual(role === "task" ? read().attempts.at(-1).phase : read().jobs.at(-1).phase, "integrated");
        });
      }
      git(path, "reset", "--hard", before); save(structuredClone(pending));
      git(path, "merge", "--no-ff", "--no-commit", worker); stage("allowed.txt");
      invoke(); assert.equal(read().transaction, undefined);
    };
    await exercise("task", taskPending, task.base, taskDone.attempts.at(-1).report.commit, `openspec-runner:${task.id}`,
      () => runner.integrate("demo", [], "continue"), () => runner.read("demo"), state => runner.save(state));
    f.control({ findings: [{ id: "F1", category: "correctness", location: "result.txt:1", impact: "Repair required", correction: "Repair output" }] });
    const review = feature.launch("demo", "review"); await feature.worker("demo", review.id);
    const repair = feature.launch("demo", "repair"); await feature.worker("demo", repair.id);
    const repairPending = feature.read("demo"), execution = runner.read("demo"), before = execution.head;
    repairPending.transaction = { attempt: repair.id, before, marker: `openspec-runner-repair:${repair.id}`, phase: "checking" };
    await exercise("repair", repairPending, before, repairPending.jobs.at(-1).report.commit, repairPending.transaction.marker,
      () => feature.integrate("demo", undefined, "continue"), () => feature.read("demo"), state => { saveFeature(feature.repo.stateDir, state); runner.save(structuredClone(execution)); });
  });
}

