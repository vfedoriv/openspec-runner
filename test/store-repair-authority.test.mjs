import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Feature } from "../dist/feature.js";
import { saveFeature } from "../dist/feature-state.js";
import { storeFeatureFixture } from "./helpers/store-feature-fixture.mjs";
import { git } from "./helpers/store-planning-fixture.mjs";

if (process.platform === "win32" && !process.env.OPENSPEC_TEST_STANDARD_CHILD) {
  test("Store repair authority in a standard Windows child", () => {
    let output;
    try { output = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./helpers/standard-windows-child.ps1", import.meta.url))], {
      input: JSON.stringify({ node: process.execPath, args: ["--test", fileURLToPath(import.meta.url)] }),
      encoding: "utf8", windowsHide: true, timeout: 270000,
    }); } catch (error) { throw new Error(error.stdout || error.stderr || error.message); }
    assert.match(output, /Store repair continuation checks live authority/);
  });
} else {
  test("Store repair continuation checks live authority before touching recovery evidence", async t => {
    const f = await storeFeatureFixture(t);
    await f.component.import({ ...f.selection, token: f.preview.token });
    const feature = new Feature(f.code, undefined, f.execution);
    feature.runner.launch("demo", ["1.1"]);
    const task = feature.runner.read("demo").attempts.at(-1);
    assert.equal((await feature.runner.worker("demo", "1.1", task.id)).exitCode, 0);
    feature.runner.integrate("demo", ["1.1"]);
    f.control({ findings: [{ id: "F1", category: "correctness", location: "result.txt:1", impact: "Repair required", correction: "Repair output" }] });
    const review = feature.launch("demo", "review");
    assert.equal((await feature.worker("demo", review.id)).exitCode, 0);
    const repair = feature.launch("demo", "repair");
    assert.equal((await feature.worker("demo", repair.id)).exitCode, 0);
    const before = feature.runner.read("demo").head;
    feature.integrate("demo", repair.id);
    const complete = feature.read("demo"), execution = feature.runner.read("demo");
    const committed = execution.head, path = execution.integration.path, storeHead = f.head();
    const pending = structuredClone(complete);
    pending.jobs.find(job => job.id === repair.id).phase = "completed";
    pending.transaction = { attempt: repair.id, before, marker: `openspec-runner-repair:${repair.id}`, phase: "merging" };
    const reset = (afterCommit = false) => {
      git(path, "reset", "--hard", afterCommit ? committed : before);
      const state = structuredClone(pending);
      if (afterCommit) state.transaction.phase = "committing";
      saveFeature(feature.repo.stateDir, state);
      feature.runner.save({ ...structuredClone(execution), head: before });
    };
    let revocation = 0;
    const mutations = {
      revoked() {
        const id = `revoke-repair-${++revocation}`;
        f.coordinator.revoke({ id, operationId: id, expectedHead: f.head(), assignmentId: "assignment", reason: "Retire owner" });
      },
      component() {
        f.write("components/api/openspec/changes/demo/tasks.md", "- [ ] 1.1 Changed component scope\n");
        git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Change component scope");
      },
      shared() {
        f.write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Changed shared scope\n");
        git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Change shared scope");
      },
    };
    for (const afterCommit of [false, true]) {
      for (const [name, mutate] of Object.entries(mutations)) {
        await t.test(`${name} authority rejects ${afterCommit ? "committed" : "pending"} repair recovery`, () => {
          reset(afterCommit);
          try {
            mutate();
            const savedFeature = feature.read("demo"), savedExecution = feature.runner.read("demo");
            const head = git(path, "rev-parse", "HEAD"), index = git(path, "write-tree");
            assert.throws(() => feature.integrate("demo", undefined, "continue"), /revoked|stale|drifted|approval/i);
            assert.deepEqual(feature.read("demo"), savedFeature);
            assert.deepEqual(feature.runner.read("demo"), savedExecution);
            assert.equal(git(path, "rev-parse", "HEAD"), head);
            assert.equal(git(path, "write-tree"), index);
          } finally { git(f.storeRoot, "reset", "--hard", storeHead); }
        });
      }
    }
    await t.test("already integrated retry rejects revoked authority", () => {
      git(path, "reset", "--hard", committed);
      saveFeature(feature.repo.stateDir, complete); feature.runner.save(execution);
      try {
        mutations.revoked();
        assert.throws(() => feature.integrate("demo", repair.id), /revoked|stale|assignment/i);
      } finally { git(f.storeRoot, "reset", "--hard", storeHead); }
    });
    await t.test("unchanged authority permits staged merge continuation", () => {
      reset();
      git(path, "merge", "--no-ff", "--no-commit", pending.jobs.find(job => job.id === repair.id).report.commit);
      assert.ok(git(path, "diff", "--cached", "--name-only"));
      assert.equal(feature.integrate("demo", undefined, "continue").head, git(path, "rev-parse", "HEAD"));
      assert.equal(feature.read("demo").transaction, undefined);
    });
    await t.test("stale authority permits abort but protects an existing repair commit", () => {
      reset(true);
      try {
        mutations.revoked();
        assert.throws(() => feature.integrate("demo", undefined, "abort"), /Repair commit exists/);
        reset();
        git(path, "merge", "--no-ff", "--no-commit", pending.jobs.find(job => job.id === repair.id).report.commit);
        assert.deepEqual(feature.integrate("demo", undefined, "abort"), { aborted: true });
        assert.equal(git(path, "rev-parse", "HEAD"), before);
        assert.equal(git(path, "status", "--porcelain"), "");
        assert.equal(feature.read("demo").transaction, undefined);
      } finally { git(f.storeRoot, "reset", "--hard", storeHead); }
    });
  });
}
