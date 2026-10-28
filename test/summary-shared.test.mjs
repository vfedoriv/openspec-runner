import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { coordinationFixture } from "./helpers/coordination-fixture.mjs";
import { git } from "./helpers/feature-fixture.mjs";
import { collectSharedSummary, collectComponentSummary } from "../dist/summary-shared.js";

function completed(t) {
  const f = coordinationFixture(t, { unchecked: false });
  writeFileSync(join(f.storeRoot, "openspec/changes/shared/proposal.md"), "Give people shared delivery visibility");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Describe shared intent");
  f.approve(); f.assign();
  const a = f.c.snapshot().records.find(r => r.kind === "assignment");
  const record = { version: 1, kind: "submission", featureId: "feature", id: "receipt", operationId: "op-receipt",
    createdAt: "2026-10-28T12:00:00Z", assignmentId: a.id, owner: a.owner, repository: a.repository, change: a.change,
    outcome: "completed", base: a.base, planFingerprint: a.planFingerprint, contractFingerprint: a.contract.fingerprint,
    result: { branch: "main", commit: a.base }, tasks: [{ id: "1.1", completed: true }],
    review: { commit: a.base, findings: [] }, verification: [] };
  f.c.importSubmission({ bytes: JSON.stringify(record), expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  let p = f.c.acceptancePreview({ submissionId: "receipt" });
  f.c.accept({ submissionId: "receipt", token: p.token, expectedHead: p.head, id: "accept", operationId: "op-accept" });
  for (const stage of ["combined", "final"]) {
    if (stage === "final") {
      const args = { componentId: "api", deliveryCommit: a.base, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" };
      p = f.c.mergePreview(args);
      f.c.recordMerge({ ...args, token: p.token, expectedHead: p.head, id: "merge", operationId: "op-merge" });
    }
    p = f.c.reviewPreview({ stage });
    f.c.recordReview({ stage, token: p.token, expectedHead: p.head, id: `${stage}-review`, operationId: `op-${stage}`,
      review: { tuple: p.tuple, token: p.token, reviewedBy: "reviewer", summary: "Reviewed exact tuple", findings: [] } });
  }
  p = f.c.completionPreview();
  f.c.complete({ token: p.token, approvedBy: "user", expectedHead: p.head, id: "complete", operationId: "op-complete" });
  const map = join(f.dir, "map.json"); writeFileSync(map, JSON.stringify(f.c.repositories));
  return { ...f, a, map };
}

test("shared summary binds completed merged tuple without local worker runtime", t => {
  const f = completed(t);
  const before = git(f.storeRoot, "rev-parse", "HEAD");
  const bundle = collectSharedSummary({ cwd: f.root, featureId: "feature", store: f.storeRoot, map: f.map });
  assert.equal(bundle.evidence.lifecycle, "shared-completed");
  assert.deepEqual(bundle.evidence.source.tuple, { api: f.a.base });
  assert.equal(bundle.evidence.source.completionEventId, "complete");
  assert.ok(bundle.evidence.gaps.some(x => /local/i.test(x)));
  assert.ok(bundle.evidence.facts.some(x => x.category === "intent"));
  assert.equal(git(f.storeRoot, "rev-parse", "HEAD"), before);
  assert.ok(bundle.evidence.facts.some(x => x.category === "delivery" && /pending/i.test(x.text)));
});

test("shared archive facts reference the revision that contains them", t => {
  const f = completed(t);
  const scope = { componentIds: ["api"], includeStore: false };
  let p = f.c.archivePreview({ scope });
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope });
  f.c.prepareArchive({ scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" });
  const bundle = collectSharedSummary({ cwd: f.root, featureId: "feature", store: f.storeRoot, map: f.map });
  assert.equal(bundle.evidence.source.storeRevision, git(f.storeRoot, "rev-parse", "HEAD"));
  const archive = f.c.snapshot().records.find(r => r.type === "archive-prepared");
  assert.ok(archive);
  assert.ok(bundle.evidence.references.some(r => r.recordId === archive.id));
});

test("incomplete shared feature cannot produce a completion summary", t => {
  const f = coordinationFixture(t);
  const map = join(f.dir, "map.json"); writeFileSync(map, JSON.stringify(f.c.repositories));
  assert.throws(() => collectSharedSummary({ cwd: f.root, featureId: "feature", store: f.storeRoot, map }), /complet/i);
});

test("independent Store clone reconstructs the same evidence and renewed authority invalidates completion", t => {
  const f = completed(t);
  const original = collectSharedSummary({ cwd: f.root, featureId: "feature", store: f.storeRoot, map: f.map });
  const clone = join(f.dir, "independent-store"); git(f.dir, "clone", "--local", f.storeRoot, clone);
  git(clone, "config", "openspec-runner.repository", "contracts");
  const map = join(f.dir, "clone-map.json"); writeFileSync(map, JSON.stringify({ ...f.c.repositories, contracts: clone }));
  const reconstructed = collectSharedSummary({ cwd: f.root, featureId: "feature", store: clone, map });
  assert.equal(reconstructed.digest, original.digest);
  f.approve("renewed");
  assert.throws(() => collectSharedSummary({ cwd: f.root, featureId: "feature", store: f.storeRoot, map: f.map }), /complet/i);
});

test("component summary validates receipt bytes rather than trusting runtime record", async t => {
  const f = coordinationFixture(t);
  const { component, input } = f.imported();
  const p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  const directory = join(component.repo.stateDir, "submissions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "forged.json"), JSON.stringify({ record: {
    assignmentId: "assignment", outcome: "completed", result: { commit: "forged" }, verification: [] }, bytes: "{}" }));
  assert.throws(() => collectComponentSummary({ cwd: f.root, change: "demo" }), /record|submission|identity|version/i);
  const a = component.readBinding({ change: "demo" }).assignment;
  for (const [id, day] of [["receipt-a", "28"], ["receipt-b", "29"]]) {
    const record = { version: 1, kind: "submission", featureId: "feature", id, operationId: `op-${id}`, createdAt: `2026-10-${day}T12:00:00Z`,
      assignmentId: a.id, owner: a.owner, repository: a.repository, change: a.change, outcome: "completed", base: a.base,
      planFingerprint: a.planFingerprint, contractFingerprint: a.contract.fingerprint, result: { branch: "main", commit: a.base },
      tasks: [{ id: "1.1", completed: true }], review: { commit: a.base, findings: [] }, verification: [] };
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({ record, bytes: JSON.stringify(record) }));
  }
  // An unrelated malformed file must not block this subject.
  writeFileSync(join(directory, "forged.json"), JSON.stringify({ record: { assignmentId: "other" }, bytes: "{}" }));
  const exact = collectComponentSummary({ cwd: f.root, change: "demo", submissionId: "receipt-a" });
  assert.ok(exact.evidence.references.some(r => r.recordId === "receipt-a"));
  const current = collectComponentSummary({ cwd: f.root, change: "demo" });
  assert.ok(current.evidence.references.some(r => r.recordId === "receipt-b"));
  assert.ok(current.evidence.facts.some(f => f.category === "work"));
  assert.ok(current.evidence.facts.some(f => f.category === "review"));
});
