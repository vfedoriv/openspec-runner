import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deliveredStoreFixture } from "./helpers/store-coordination-fixture.mjs";
import { git } from "./helpers/store-planning-fixture.mjs";
import { recordTupleReview } from "../dist/coordination-review.js";
import { CoordinationStore } from "../dist/coordination-state.js";
import { coordinationOperation } from "../dist/coordination-operation.js";
import { coordinationRuntimePath, coordinationJournalPath } from "../dist/coordination-runtime.js";
import { archiveJournalPath, inspectArchivePreparation, recoverArchivePreparation } from "../dist/coordination-archive.js";

function secondFeature(f) {
  const directory = join(f.storeRoot, "runner/features/second");
  cpSync(join(f.storeRoot, "runner/features/product"), directory, { recursive: true });
  writeFileSync(join(directory, "manifest.yaml"), JSON.stringify({ ...f.c.store.readManifest(), featureId: "second" }));
  const rewrite = root => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) rewrite(path);
      else if (entry.name.endsWith(".json")) writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), featureId: "second" }));
    }
  };
  rewrite(directory); git(f.storeRoot, "add", "runner/features/second"); git(f.storeRoot, "commit", "-m", "Second independent feature");
  return new CoordinationStore({ root: f.storeRoot, featureId: "second" });
}

test("real Git coordinator operations isolate identical IDs across features and retain retry identity", t => {
  const f = deliveredStoreFixture(t, ["api"]), a = f.c.store;
  const b = secondFeature(f);
  const input = { id: "same", operationId: "same", expectedHead: f.head() };
  const run = (store, value) => coordinationOperation({ store, input, action: "archive", initialize: () => ({ value }), execute: ({ journal }) => journal.data.value });
  assert.equal(run(a, "first"), "first");
  assert.equal(run(b, "second"), "second");
  assert.equal(run(a, "retry"), "first");
  assert.throws(() => coordinationOperation({ store: a, input: { ...input, id: "changed" }, action: "archive", initialize: () => ({}), execute: () => {} }), /identity/);
  const aPath = archiveJournalPath({ store: a, operationId: "same" });
  assert.equal(inspectArchivePreparation({ store: a, operationId: "same" }).value, "first");
  assert.equal(inspectArchivePreparation({ store: b, operationId: "same" }).value, "second");
  for (const area of ["acceptance-checkouts", "delivery-checkouts", "review-checkouts", "archive-checkouts"]) {
    const first = coordinationRuntimePath({ store: a, area, operationId: "same", componentId: "api" });
    const second = coordinationRuntimePath({ store: b, area, operationId: "same", componentId: "api" });
    assert.notEqual(first, second); assert.ok(first.includes(join("coordination", "features", "product", area)));
  }
  const saved = readFileSync(aPath, "utf8");
  const legacy = join(f.storeRoot, ".git/openspec-runner/archive/same.json"); mkdirSync(join(legacy, ".."), { recursive: true }); writeFileSync(legacy, "unknown legacy owner");
  assert.equal(run(a, "retry"), "first"); assert.equal(readFileSync(aPath, "utf8"), saved);
  assert.notEqual(archiveJournalPath({ store: a, operationId: "same" }), archiveJournalPath({ store: b, operationId: "same" }));
});

test("unscoped v2 legacy journal blocks execution and archive inspection without adopting data", t => {
  const f = deliveredStoreFixture(t, ["api"]), path = join(f.storeRoot, ".git/openspec-runner/archive/legacy.json");
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify({ input: { id: "legacy", operationId: "legacy", expectedHead: f.head() }, expectedHead: f.head(), data: { unknownOwner: true } }));
  const input = { id: "legacy", operationId: "legacy", expectedHead: f.head() };
  assert.throws(() => coordinationOperation({ store: f.c.store, input, action: "archive", initialize: () => assert.fail("must not initialize"), execute: () => assert.fail("must not execute") }), /legacy.*journal.*reconcil/i);
  assert.throws(() => archiveJournalPath({ store: f.c.store, operationId: "legacy" }), /legacy.*journal.*reconcil/i);
  assert.throws(() => inspectArchivePreparation({ store: f.c.store, operationId: "legacy" }), /legacy.*journal.*reconcil/i);
  assert.throws(() => recoverArchivePreparation({ store: f.c.store, operationId: "legacy", targetId: "api", attestedBy: "operator" }), /legacy.*journal.*reconcil/i);
  assert.ok(readFileSync(path, "utf8").includes("unknownOwner"));
});

test("v1 runtime roots remain unchanged and v2 IDs are validated", t => {
  const f = deliveredStoreFixture(t, ["api"]), store = f.c.store;
  const legacy = { root: store.root, featureId: "Feature", readManifest: () => ({ version: 1 }) };
  assert.equal(coordinationJournalPath({ store: legacy, area: "review", operationId: "Operation" }), join(f.storeRoot, ".git/openspec-runner/review/Operation.json"));
  assert.equal(coordinationRuntimePath({ store: legacy, area: "archive-checkouts", operationId: "Operation", componentId: "API", legacyRoot: f.code }), join(f.code, ".git/openspec-runner/archive-checkouts/Operation/API"));
  for (const operationId of ["../escape", "CON", "bad.name"]) assert.throws(() => coordinationRuntimePath({ store, area: "review", operationId }), /ID|unsafe|reserved/i);
  for (const extra of [{ area: "../escape" }, { componentId: "../escape" }, { store: { ...legacy, featureId: "../escape" } }]) assert.throws(() => coordinationRuntimePath({ store, area: "review", operationId: "safe", ...extra }), /ID|unsafe/i);
});

test("tuple coordinator executes identical review IDs in each feature checkout and preserves interruption guards", t => {
  const f = deliveredStoreFixture(t, ["api"]), second = secondFeature(f), counter = join(f.dir, "review-checkouts.txt");
  const preview = f.c.reviewPreview({ stage: "combined" });
  preview.verification = [{ componentId: "api", command: ["node", "-e", `require('node:fs').appendFileSync(${JSON.stringify(counter)}, process.cwd()+'\\n'); console.log('Verified exact feature checkout')`] }];
  const review = { tuple: preview.tuple, token: preview.token, reviewedBy: "operator", summary: "Reviewed exact tuple", findings: [] };
  const run = (store, input) => recordTupleReview({ store, input, roots: f.roots, preview: () => preview });
  const first = { stage: "combined", id: "isolated-review", operationId: "isolated-review", token: preview.token, expectedHead: f.head(), review };
  run(f.c.store, first); run(f.c.store, first);
  const input = { ...first, expectedHead: f.head() }; run(second, input); run(second, input);
  const paths = readFileSync(counter, "utf8").trim().split("\n");
  assert.deepEqual(paths, [f.c.store, second].map(store => coordinationRuntimePath({ store, area: "review-checkouts", operationId: first.operationId, componentId: "api" })));
  const journalPath = coordinationJournalPath({ store: second, area: "review", operationId: input.operationId });
  const journal = JSON.parse(readFileSync(journalPath, "utf8")); journal.running = 0; writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => run(second, input), /ambiguous side effects/);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2);
});
