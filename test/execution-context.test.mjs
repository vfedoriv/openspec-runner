import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { git, storePlanningFixture } from "./helpers/store-planning-fixture.mjs";
import { resolveExecutionContext } from "../dist/execution-context.js";
import { pinStorePlan } from "../dist/planning-source.js";

test("local execution selects the code project and existing runtime/worktree locations", t => {
  const f = storePlanningFixture(t), ctx = resolveExecutionContext({ implementationRoot: f.code, change: "demo" });
  assert.equal(ctx.runtimeDir, join(f.code, ".git/openspec-runner"));
  assert.equal(ctx.worktreeRoot, join(f.code, ".openspec-runner/worktrees"));
  assert.equal(ctx.planningProjectRoot, f.code);
  assert.deepEqual(ctx.planningSource, { kind: "local", root: f.code, change: "demo" });
});

test("Store runtime follows the selected feature, component and code common directory", t => {
  const f = storePlanningFixture(t), linked = join(f.dir, "linked"), clone = join(f.dir, "clone");
  git(f.code, "worktree", "add", "--detach", linked, "HEAD"); git(f.dir, "clone", f.code, clone);
  const source = pinStorePlan(f.input());
  const store = { storeRoot: f.storeRoot, featureId: "feature", componentId: "api", assignmentId: "assignment", source };
  const select = (implementationRoot, selection = store) => resolveExecutionContext({ implementationRoot, change: "demo", store: selection });
  const main = select(f.code), worktree = select(linked), independent = select(clone);
  assert.equal(main.implementation.root, f.code);
  assert.equal(main.planningProjectRoot, join(f.storeRoot, "components/api"));
  for (const key of ["runtimeDir", "worktreeRoot"]) {
    assert.equal(worktree[key], main[key]);
    assert.notEqual(independent[key], main[key]);
    assert.notEqual(select(f.code, { ...store, featureId: "feature2" })[key], main[key]);
    assert.equal(relative(f.storeRoot, main[key]).split(sep)[0], ".openspec-runner");
    assert.equal(existsSync(main[key]), false);
  }
  assert.equal(existsSync(join(f.code, ".openspec-runner")), false);
  assert.throws(() => select(f.code, { ...store, componentId: "web" }), /component|root/i);
  assert.throws(() => select(f.code, { ...store, featureId: ".." }), /id|unsafe/i);
  assert.throws(() => resolveExecutionContext({ implementationRoot: f.code, change: "another", store }), /change/i);
  const outside = join(f.dir, "outside");
  mkdirSync(outside); symlinkSync(outside, join(f.storeRoot, ".openspec-runner"), "junction");
  assert.throws(() => select(f.code), /redirect|symlink/i);
});
