import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureFixture, git } from "./helpers/feature-fixture.mjs";
import { collectLocalSummary, summaryDigest, summarySubjectKey } from "../dist/summary-evidence.js";
import { saveFeature } from "../dist/feature-state.js";

function integratedFixture(t) {
  const f = featureFixture(t);
  const base = git(f.root, "rev-parse", "HEAD");
  git(f.root, "commit", "--allow-empty", "-m", "Implementation");
  const commit = git(f.root, "rev-parse", "HEAD");
  git(f.root, "commit", "--allow-empty", "-m", "Integrate task\n\nopenspec-runner:attempt-1");
  const head = git(f.root, "rev-parse", "HEAD");
  const workspace = { branch: "main", path: f.root, base };
  const report = { attempt: "attempt-1", task: "1.1", session: "fixture", outcome: "completed", commit,
    summary: "Users can inspect output", verification: ["Worker checked output"] };
  f.r.save({ version: 1, change: "demo", fingerprint: "fixture-plan", integration: workspace, head, baseline: [],
    attempts: [{ ...workspace, id: "attempt-1", task: "1.1", description: "Produce output", fingerprint: "fixture-plan",
      settings: { model: "test", reasoningEffort: "high" }, parallel: false, phase: "integrated", terminal: {}, report },
    { ...workspace, id: "failed-2", task: "1.2", description: "Failed task", phase: "failed", terminal: {},
      settings: { model: "test" }, parallel: false, fingerprint: "fixture-plan" }] });
  return { ...f, head };
}

test("local evidence includes only integrated work and distinguishes worker checks", t => {
  const f = integratedFixture(t);
  const bundle = collectLocalSummary({ cwd: f.root, change: "demo", task: "1.1" });
  assert.equal(bundle.evidence.lifecycle, "task-integrated");
  assert.equal(bundle.evidence.source.result, f.head);
  assert.equal(bundle.evidence.facts.filter(x => x.category === "work").length, 1);
  assert.equal(bundle.evidence.facts.find(x => x.category === "verification").authority, "worker-report");
  assert.ok(bundle.evidence.gaps.length > 0);
  assert.throws(() => collectLocalSummary({ cwd: f.root, change: "demo", task: "1.2" }), /integrated/);
});

test("collection ignores checkout drift and digest ignores collection time", t => {
  const f = integratedFixture(t);
  const a = collectLocalSummary({ cwd: f.root, change: "demo", task: "1.1" });
  writeFileSync(join(f.root, "openspec/changes/demo/tasks.md"), "uncommitted drift");
  const b = collectLocalSummary({ cwd: f.root, change: "demo", task: "1.1" });
  assert.equal(a.digest, b.digest);
  assert.equal(summaryDigest(a.evidence), a.digest);
  assert.match(summarySubjectKey(a.evidence.subject), /^[a-f0-9]{64}$/);
  assert.throws(() => summarySubjectKey({ kind: "task", change: "../escape", task: "1.1" }));
});

test("archived evidence survives cleaned worktrees and missing marker is a gap", t => {
  const f = integratedFixture(t);
  git(f.root, "mv", "openspec/changes/demo", "openspec/changes/archived-demo");
  git(f.root, "commit", "-am", "Move current artifacts");
  const bundle = collectLocalSummary({ cwd: f.root, change: "demo", task: "1.1" });
  assert.equal(bundle.evidence.source.result, f.head);
  assert.ok(bundle.evidence.references.some(x => x.path === "openspec/changes/demo/tasks.md"));
  const state = f.r.read("demo");
  state.attempts[0].id = "missing-marker";
  for (const batch of state.batches) batch.attempts = batch.attempts.map(id => id === "attempt-1" ? "missing-marker" : id);
  f.r.save(state);
  const incomplete = collectLocalSummary({ cwd: f.root, change: "demo", task: "1.1" });
  assert.ok(incomplete.evidence.gaps.some(x => /integration commit/i.test(x)));
});

test("completed feature reads archived proposal while task retains prearchive references", t => {
  const f = integratedFixture(t);
  writeFileSync(join(f.root, "openspec/changes/demo/proposal.md"), "Let people inspect results");
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Intent");
  const before = git(f.root, "rev-parse", "HEAD");
  git(f.root, "mv", "openspec/changes/demo", "openspec/changes/archive-demo");
  git(f.root, "commit", "-am", "Archive");
  const commit = git(f.root, "rev-parse", "HEAD");
  saveFeature(f.r.repo.stateDir, { version: 1, change: "demo", phase: "completed", planningRoot: f.root,
    jobs: [], fixRounds: 0, approvalHistory: [], archive: { before, marker: "fixture", phase: "committed",
      directories: [], path: "openspec/changes/archive-demo", commit } });
  const feature = collectLocalSummary({ cwd: f.root, change: "demo" });
  assert.equal(feature.evidence.source.result, commit);
  assert.equal(feature.evidence.facts.find(x => x.category === "intent").text, "Let people inspect results");
  const task = collectLocalSummary({ cwd: f.root, change: "demo", task: "1.1" });
  assert.ok(task.evidence.references.some(x => x.path === "openspec/changes/demo/tasks.md"));
});
