import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStoreSubmission } from "../dist/store-submission.js";
import { deliveredPlan } from "../dist/coordination-delivery.js";
import { loadSourcePlan, pinStorePlan } from "../dist/planning-source.js";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";

test("Store task evidence binds approved scope, worker ancestry and integration marker", t => {
  const f = storePlanningFixture(t), source = pinStorePlan(f.input());
  const base = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "worker");
  writeFileSync(join(f.code, "result.txt"), "implemented\n");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Implement");
  const workerCommit = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "integration", base);
  git(f.code, "merge", "--no-ff", "worker", "-m", "Integrate\n\nopenspec-runner:attempt");
  const commit = git(f.code, "rev-parse", "HEAD");
  const assignment = { version: 2, base, planningSource: source, planFingerprint: source.fingerprint,
    settings: { tasks: Object.fromEntries(loadSourcePlan(source).tasks.map(task => [task.id, {}])) } };
  const receipt = { version: 2, planningRevision: source.revision, result: { commit },
    tasks: loadSourcePlan(source).tasks.map(task => ({ id: task.id, completed: true,
      evidence: { kind: "integrated", attemptId: "attempt", workerCommit, integrationCommit: commit } })) };
  assert.doesNotThrow(() => validateStoreSubmission({ root: f.code, assignment, receipt }));
  assert.doesNotThrow(() => deliveredPlan({ root: f.code, preview: { assignment, receipt, payload: { deliveryCommit: commit } } }));
  const forged = structuredClone(receipt); forged.tasks[0].evidence.integrationCommit = workerCommit;
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt: forged }), /integration|marker/i);
  const baseline = structuredClone(receipt); baseline.tasks[0].evidence = { kind: "baseline", base };
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt: baseline }), /baseline|evidence/i);
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt: { ...receipt, tasks: [] } }), /coverage|scope/i);
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt: { ...receipt, tasks: [...receipt.tasks, receipt.tasks[0]] } }), /coverage|scope/i);
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt: { ...receipt, planningRevision: base } }), /planning/i);
  git(f.code, "checkout", "-b", "rewritten", base);
  writeFileSync(join(f.code, "result.txt"), "implemented\n"); git(f.code, "add", "."); git(f.code, "commit", "-m", "Squashed delivery");
  const rewritten = git(f.code, "rev-parse", "HEAD");
  assert.throws(() => git(f.code, "merge-base", "--is-ancestor", commit, rewritten));
  assert.doesNotThrow(() => deliveredPlan({ root: f.code, preview: { assignment, receipt, payload: { deliveryCommit: rewritten } } }));
  mkdirSync(join(f.code, "openspec")); writeFileSync(join(f.code, "openspec", "leaked.md"), "forbidden");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Leak planning artifact");
  assert.throws(() => deliveredPlan({ root: f.code, preview: { assignment, receipt, payload: { deliveryCommit: git(f.code, "rev-parse", "HEAD") } } }), /planning|runtime|artifact/i);
});

test("approved baseline tasks require only the assigned code base", t => {
  const f = storePlanningFixture(t);
  f.write("components/api/openspec/changes/demo/tasks.md", "- [x] 1.1 Already implemented\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Approve existing implementation");
  const source = pinStorePlan({ ...f.input(), revision: git(f.storeRoot, "rev-parse", "HEAD") }), base = git(f.code, "rev-parse", "HEAD");
  const assignment = { version: 2, base, planningSource: source, planFingerprint: source.fingerprint, settings: { tasks: { "1.1": {} } } };
  const receipt = { version: 2, planningRevision: source.revision, result: { commit: base },
    tasks: [{ id: "1.1", completed: true, evidence: { kind: "baseline", base } }] };
  assert.doesNotThrow(() => validateStoreSubmission({ root: f.code, assignment, receipt }));
  receipt.tasks[0].evidence.base = "0".repeat(40);
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt }), /baseline/i);
});
