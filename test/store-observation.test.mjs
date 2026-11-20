import { test } from "node:test";
import assert from "node:assert/strict";
import { pinStorePlan, readStorePlanRevision } from "../dist/planning-source.js";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";

test("Git-only Store observation detects semantic drift without treating progress as drift", t => {
  const f = storePlanningFixture(t), source = pinStorePlan(f.input());
  const current = () => readStorePlanRevision({ storeRoot: f.storeRoot, source, revision: git(f.storeRoot, "rev-parse", "HEAD") });
  assert.equal(current().fingerprint, source.fingerprint);
  f.write("components/api/openspec/changes/demo/tasks.md", "- [x] 1.1 Deliver change\n");
  f.write("components/api/notes.md", "Unselected notes\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Progress and unrelated notes");
  assert.equal(current().fingerprint, source.fingerprint);
  f.write("components/api/openspec/specs/new/spec.md", "New canonical requirement\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "New selected requirement");
  assert.notEqual(current().fingerprint, source.fingerprint);
});

test("older Store pins retain fingerprints and fail closed on additions with unknown selectors", t => {
  const f = storePlanningFixture(t), input = f.input();
  const source = pinStorePlan({ ...input, kind: "store" });
  assert.equal(source.selections, undefined);
  assert.deepEqual(pinStorePlan({ ...source, storeRoot: f.storeRoot, execute: input.execute }), source);
  f.write("components/api/openspec/changes/demo/tasks.md", "- [x] 1.1 Deliver change\n");
  f.write("components/web/guidance.md", "Unrelated component progress\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Progress");
  assert.equal(readStorePlanRevision({ storeRoot: f.storeRoot, source, revision: git(f.storeRoot, "rev-parse", "HEAD") }).fingerprint, source.fingerprint);
  f.write("components/api/contracts/new.md", "Potential custom input\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Add potentially selected input");
  assert.throws(() => readStorePlanRevision({ storeRoot: f.storeRoot, source, revision: git(f.storeRoot, "rev-parse", "HEAD") }), /scope.*stale|renew approval/i);
});

test("Store pins retain custom selector roots for Git-only freshness checks", t => {
  const f = storePlanningFixture(t);
  f.write("components/api/contracts/first.md", "Approved custom contract\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Custom selected directory");
  const execute = request => request.args[0] === "status" ? JSON.stringify({
    root: { path: request.cwd, source: "nearest" }, planningHome: { root: request.cwd },
    changeRoot: "openspec/changes/demo", artifactPaths: { contract: { outputPath: "contracts", resolvedOutputPath: "contracts", existingOutputPaths: ["contracts"] } },
  }) : f.input().execute(request);
  const source = pinStorePlan({ ...f.input(), revision: git(f.storeRoot, "rev-parse", "HEAD"), execute });
  assert.ok(source.selections.includes("components/api/contracts"));
  f.write("components/api/contracts/second.md", "New selected requirement\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Extend custom selected directory");
  assert.notEqual(readStorePlanRevision({ storeRoot: f.storeRoot, source, revision: git(f.storeRoot, "rev-parse", "HEAD") }).fingerprint, source.fingerprint);
});
