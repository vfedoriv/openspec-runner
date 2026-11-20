import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("Store evidence rejects one integration reused for multiple tasks", t => {
  const f = storePlanningFixture(t);
  f.write("components/api/openspec/changes/demo/tasks.md", "- [ ] 1.1 First task\n- [ ] 1.2 Second task\n");
  f.write("components/api/openspec/changes/demo/execution.yaml", 'version: 2\ntasks:\n  "1.1": {}\n  "1.2": {}\n');
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Two tasks");
  const source = pinStorePlan({ ...f.input(), revision: git(f.storeRoot, "rev-parse", "HEAD") });
  const base = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "worker");
  writeFileSync(join(f.code, "result.txt"), "implemented\n");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Implement");
  const workerCommit = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "integration", base);
  git(f.code, "merge", "--no-ff", "worker", "-m", "Integrate\n\nopenspec-runner:first\nopenspec-runner:second");
  const commit = git(f.code, "rev-parse", "HEAD");
  const assignment = { version: 2, base, planningSource: source, planFingerprint: source.fingerprint,
    settings: { tasks: { "1.1": {}, "1.2": {} } } };
  const receipt = { version: 2, planningRevision: source.revision, result: { commit }, tasks: ["first", "second"].map((attemptId, i) => ({
    id: `1.${i + 1}`, completed: true, evidence: { kind: "integrated", attemptId, workerCommit, integrationCommit: commit },
  })) };
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt }), /distinct|marker/i);
});

test("Store submission rejects forbidden artifacts removed before the final commit", t => {
  const f = storePlanningFixture(t), source = pinStorePlan(f.input()), base = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "worker");
  mkdirSync(join(f.code, "openspec")); writeFileSync(join(f.code, "openspec", "leaked.md"), "forbidden");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Leak artifact");
  rmSync(join(f.code, "openspec"), { recursive: true }); writeFileSync(join(f.code, "result.txt"), "implemented\n");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Remove artifact");
  const workerCommit = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "integration", base);
  git(f.code, "merge", "--no-ff", "worker", "-m", "Integrate\n\nopenspec-runner:attempt");
  const commit = git(f.code, "rev-parse", "HEAD");
  const assignment = { version: 2, base, planningSource: source, planFingerprint: source.fingerprint, settings: { tasks: { "1.1": {} } } };
  const receipt = { version: 2, planningRevision: source.revision, result: { commit }, tasks: [{ id: "1.1", completed: true,
    evidence: { kind: "integrated", attemptId: "attempt", workerCommit, integrationCommit: commit } }] };
  assert.throws(() => validateStoreSubmission({ root: f.code, assignment, receipt }), /planning|runtime|artifact/i);
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

test("Store index policy checks the complete staged tree, renames and deletions", async t => {
  const { assertStoreCodeIndex } = await import("../dist/store-submission.js");
  const f = storePlanningFixture(t);
  writeFileSync(join(f.code, "allowed.txt"), "code\n", "utf8"); git(f.code, "add", ".");
  assert.equal(typeof assertStoreCodeIndex, "function");
  assert.doesNotThrow(() => assertStoreCodeIndex(f.code));
  mkdirSync(join(f.code, "OpenSpec")); writeFileSync(join(f.code, "OpenSpec", "other.md"), "artifact\n", "utf8");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Existing forbidden tree");
  writeFileSync(join(f.code, "allowed.txt"), "updated\n", "utf8"); git(f.code, "add", ".");
  assert.throws(() => assertStoreCodeIndex(f.code), /artifact|planning|runtime/i);
  git(f.code, "rm", "OpenSpec/other.md");
  assert.doesNotThrow(() => assertStoreCodeIndex(f.code));
  mkdirSync(join(f.code, ".OPENSPEC-RUNNER"));
  git(f.code, "mv", "allowed.txt", ".OPENSPEC-RUNNER/state.json");
  assert.throws(() => assertStoreCodeIndex(f.code), /artifact|planning|runtime/i);
  git(f.code, "mv", ".OPENSPEC-RUNNER/state.json", "allowed.txt");
  assert.doesNotThrow(() => assertStoreCodeIndex(f.code));
});
