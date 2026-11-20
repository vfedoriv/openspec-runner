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
