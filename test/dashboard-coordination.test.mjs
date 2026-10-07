import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { coordinationFixture } from "./helpers/coordination-fixture.mjs";
import { git, executable } from "./helpers/feature-fixture.mjs";
import { execFileSync } from "node:child_process";
import { collectDashboard } from "../dist/dashboard-reader.js";
import { repository } from "../dist/system.js";
import { stableDigest } from "../dist/coordination-state.js";
import { expectedContextPaths } from "../dist/component-state.js";

function fixture(t, options = {}) {
  const f = coordinationFixture(t, options);
  const map = join(f.dir, "map.json");
  writeFileSync(map, JSON.stringify({ api: relative(f.dir, f.root), contracts: "store" }));
  return { ...f, map, collect(extra = {}) { return collectDashboard({ cwd: f.root, store: f.storeRoot, map, ...extra }); } };
}
function commitManifest(f, id, branch) {
  const directory = join(f.storeRoot, "runner/features", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.yaml"), stringify({ ...f.manifest, featureId: id, coordinationBranch: branch }));
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", id);
}
function bind(f) {
  f.approve(); f.assign();
  const assignment = f.c.store.readRecord({ kind: "assignment", id: "assignment" });
  const historyRevision = git(f.storeRoot, "rev-parse", "HEAD");
  const stateDir = repository(f.root).stateDir;
  const resources = { terminal: "manual", worktrees: "git", worktreeRoot: join(f.root, "workers") };
  const binding = { version: 1, phase: "reserved", repository: "api", change: "demo", assignmentId: assignment.id, featureId: "feature", historyRevision,
    token: stableDigest({ value: { assignment, historyRevision, resources } }), assignment, contextPaths: expectedContextPaths({ stateDir, assignment }), resources };
  mkdirSync(join(stateDir, "components"), { recursive: true });
  writeFileSync(join(stateDir, "components/demo.json"), JSON.stringify(binding));
  return binding;
}

test("coordination discovers authoritative features from handoff checkout", t => {
  const f = fixture(t);
  const authority = git(f.storeRoot, "rev-parse", "HEAD");
  git(f.storeRoot, "checkout", "-b", "handoff", "HEAD~1");
  const directory = join(f.storeRoot, "runner/features/uncommitted"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.yaml"), stringify({ ...f.manifest, featureId: "uncommitted" }));
  const s = f.collect();
  assert.equal(s.features.find(x => x.id === "shared:feature")?.coordination.head, authority);
  assert.equal(s.features.some(x => x.id === "shared:uncommitted"), false);
  assert.deepEqual(s.errors, []);
});

test("coordination isolates conflicting and missing branch declarations", t => {
  const f = fixture(t);
  commitManifest(f, "missing", "absent");
  git(f.storeRoot, "checkout", "-b", "other");
  commitManifest(f, "feature", "other");
  const s = f.collect();
  assert.deepEqual(s.errors.map(x => x.source).sort(), ["shared:feature", "shared:missing"]);
  assert.match(s.errors.find(x => x.source === "shared:feature").message, /conflict/i);
  assert.equal(s.features.find(x => x.id === "local:demo")?.origin, "local");
});

test("coordination permits historical manifest versions on the same declared branch", t => {
  const f = fixture(t);
  f.manifest.components.api.deliveryBranch = "delivery";
  commitManifest(f, "feature", "coordination");
  const s = f.collect();
  assert.deepEqual(s.errors, []);
  assert.equal(s.features.find(x => x.id === "shared:feature")?.coordination.head, git(f.storeRoot, "rev-parse", "HEAD"));
});

test("coordination maps linked worktree and filters assignments by exact local change", t => {
  const f = fixture(t); bind(f);
  const linked = join(f.dir, "linked"); git(f.root, "worktree", "add", "-b", "linked", linked);
  const s = f.collect({ cwd: linked, change: "demo" });
  assert.equal(s.repository.identity, "api");
  assert.equal(s.features.some(x => x.id === "shared:feature"), true);
  assert.equal(s.assignments.length, 1);
  assert.equal(s.assignments[0].id, "shared:feature:assignment:assignment");
  assert.ok(s.assignments[0].binding);
  assert.deepEqual(f.collect({ change: "shared" }).features, []);
  assert.deepEqual(f.collect({ change: "other" }).assignments, []);
});

test("coordination rejects identity map associations to a different repository checkout", t => {
  const f = fixture(t);
  git(f.storeRoot, "config", "openspec-runner.repository", "api");
  writeFileSync(f.map, JSON.stringify({ api: "store" }));
  const s = f.collect();
  assert.equal(s.errors[0]?.source, "coordination");
  assert.match(s.errors[0].message, /association|ambiguous/i);
  assert.ok(s.features.some(x => x.id === "local:demo"));
});

test("coordination distinguishes pinned history from inspected authority and revocation", t => {
  const f = fixture(t), binding = bind(f);
  const offline = collectDashboard({ cwd: f.root });
  assert.equal(offline.assignments[0].importedRevision, binding.historyRevision);
  assert.equal(offline.assignments[0].inspectedRevision, undefined);
  assert.equal(offline.assignments[0].status, undefined);
  const before = f.collect();
  assert.equal(before.assignments[0].status?.phase, "assigned");
  const head = git(f.storeRoot, "rev-parse", "HEAD");
  f.c.revoke({ assignmentId: "assignment", reason: "New owner", id: "revoke", operationId: "op-revoke", expectedHead: head });
  const current = f.collect(), a = current.assignments[0];
  assert.equal(current.assignments.length, 1);
  assert.equal(a.importedRevision, binding.historyRevision);
  assert.equal(a.inspectedRevision, git(f.storeRoot, "rev-parse", "HEAD"));
  assert.equal(a.status.phase, "planned"); assert.equal(a.stale, true);
  assert.ok(current.attention.some(x => /revoked/i.test(x.message)));
});

test("coordination marks offline revocation authority explicitly unknown", t => {
  const f = fixture(t); bind(f);
  const s = collectDashboard({ cwd: f.root });
  assert.ok(s.attention.some(x => x.targetId === "local:demo:assignment:assignment" && /revocation.*unknown/i.test(x.message)));
  assert.equal(s.assignments[0].inspectedRevision, undefined);
});

test("coordination invalid map and store do not hide local data or mutate bindings", t => {
  const f = fixture(t); bind(f);
  const path = join(repository(f.root).stateDir, "components/demo.json"), before = readFileSync(path, "utf8");
  for (const extra of [{ store: join(f.dir, "missing") }, { map: join(f.dir, "missing-map") }, { map: undefined }]) {
    const s = f.collect(extra);
    assert.equal(s.errors.find(x => x.source === "coordination")?.stale, false);
    assert.ok(s.features.some(x => x.id === "local:demo"));
    assert.equal(s.assignments[0].inspectedRevision, undefined);
  }
  assert.equal(readFileSync(path, "utf8"), before);
});

test("coordination keeps unrelated features out and isolates malformed committed manifests", t => {
  const f = fixture(t);
  f.manifest.components.api.repository = "peer"; commitManifest(f, "peer-feature", "coordination");
  const directory = join(f.storeRoot, "runner/features/broken"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.yaml"), "{broken"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Malformed manifest");
  const s = f.collect();
  assert.equal(s.features.some(x => x.id === "shared:peer-feature"), false);
  assert.equal(s.features.some(x => x.id === "shared:feature"), true);
  assert.deepEqual(s.errors.map(x => x.source), ["shared:broken"]);
  assert.equal(s.sessions.length, 0);
});

test("coordination uses first-parent approval authority rather than approval timestamps", t => {
  const f = fixture(t); bind(f);
  f.approve("new-approval", { createdAt: "2000-01-01T00:00:00Z" });
  const s = f.collect();
  assert.equal(s.features.find(x => x.id === "shared:feature").coordination.approvalId, "new-approval");
  assert.equal(s.assignments[0].status.phase, "assigned");
  assert.equal(s.assignments[0].stale, true);
  assert.ok(s.attention.some(x => /approval.*stale/i.test(x.message)));
});

test("coordination marks a divergent imported assignment payload stale without duplicating its identity", t => {
  const f = fixture(t), binding = bind(f);
  binding.assignment.owner = "previous-owner";
  binding.token = stableDigest({ value: { assignment: binding.assignment, historyRevision: binding.historyRevision, resources: binding.resources } });
  writeFileSync(join(repository(f.root).stateDir, "components/demo.json"), JSON.stringify(binding));
  const s = f.collect();
  assert.equal(s.assignments.length, 1);
  assert.equal(s.assignments[0].owner, "alice");
  assert.equal(s.assignments[0].stale, true);
});

test("coordination invalid immutable history remains an isolated shared source error", t => {
  const f = fixture(t); bind(f);
  const path = join(f.storeRoot, "runner/features/feature/assignments/assignment.json");
  const assignment = JSON.parse(readFileSync(path, "utf8")); assignment.owner = "mallory";
  writeFileSync(path, JSON.stringify(assignment)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Changed immutable record");
  const s = f.collect();
  assert.match(s.errors.find(x => x.source === "shared:feature")?.message, /immutable.*changed/i);
  assert.equal(s.assignments[0].inspectedRevision, undefined);
  assert.ok(s.features.some(x => x.id === "local:demo"));
});

test("coordination rejects malformed and mismatched map entries using shared map validation", t => {
  const f = fixture(t);
  for (const value of [[], { api: 1 }, { wrong: relative(f.dir, f.root) }]) {
    writeFileSync(f.map, JSON.stringify(value));
    const s = f.collect();
    assert.equal(s.errors[0].source, "coordination");
    assert.ok(s.features.some(x => x.id === "local:demo"));
  }
});

test("coordination snapshot never writes files refs checks or worker tools", t => {
  const f = fixture(t); bind(f);
  const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  executable(join(f.bin, "git"), `
const cp = require('node:child_process');
const args = process.argv.slice(2), command = args[0] === '-c' ? args[2] : args[0];
if (!['rev-parse','config','remote','rev-list','ls-tree','cat-file','merge-base'].includes(command) ||
    (command === 'config' && !args.includes('--get')) || (command === 'remote' && !args.includes('get-url'))) {
  console.error('Forbidden Git operation ' + command); process.exit(2);
}
process.stdout.write(cp.execFileSync(${JSON.stringify(actualGit)}, args));
`);
  for (const tool of ["codex", "claude", "openspec", "wt", "herdr"]) executable(join(f.bin, tool), "throw new Error('Collector called a worker or verification tool');");
  const tree = () => {
    const files = [];
    const visit = path => {
      const stat = lstatSync(path);
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
      else files.push([path, stat.mode, readFileSync(path).toString("base64")]);
    };
    visit(f.dir); return files;
  };
  const before = tree(), s = f.collect();
  assert.deepEqual(s.errors, []);
  assert.equal(s.assignments[0].status.phase, "assigned");
  assert.deepEqual(tree(), before);
});

test("coordination keeps accepted delivered and completed milestones separate", t => {
  const f = fixture(t, { unchecked: false }), { assignment: a } = bind(f);
  const receipt = { version: 1, kind: "submission", id: "receipt", operationId: "op-receipt", featureId: "feature", createdAt: "2026-10-07T00:00:00Z",
    assignmentId: a.id, owner: a.owner, repository: a.repository, change: a.change, outcome: "completed", base: a.base, planFingerprint: a.planFingerprint,
    contractFingerprint: a.contract.fingerprint, result: { branch: "main", commit: a.base }, tasks: [{ id: "1.1", completed: true }], review: { commit: a.base, findings: [] }, verification: [] };
  f.c.importSubmission({ bytes: JSON.stringify(receipt), expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  let p = f.c.acceptancePreview({ submissionId: "receipt" });
  f.c.accept({ submissionId: "receipt", id: "accept", operationId: "op-accept", expectedHead: p.head, token: p.token });
  let s = f.collect(), feature = s.features.find(x => x.id === "shared:feature");
  assert.equal(s.assignments[0].status.phase, "accepted"); assert.equal(s.assignments[0].status.acceptedCommit, a.base);
  assert.equal(s.assignments[0].status.deliveryCommit, undefined); assert.equal(feature.completed, 0);
  const review = stage => {
    const preview = f.c.reviewPreview({ stage });
    f.c.recordReview({ stage, id: `review-${stage}`, operationId: `op-review-${stage}`, expectedHead: preview.head, token: preview.token,
      review: { tuple: preview.tuple, token: preview.token, reviewedBy: "reviewer", summary: "Reviewed exact tuple", findings: [] } });
  };
  review("combined");
  const merge = { componentId: "api", deliveryCommit: a.base, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" };
  p = f.c.mergePreview(merge); f.c.recordMerge({ ...merge, id: "merge", operationId: "op-merge", expectedHead: p.head, token: p.token });
  s = f.collect(); feature = s.features.find(x => x.id === "shared:feature");
  assert.equal(s.assignments[0].status.phase, "merged"); assert.equal(s.assignments[0].status.deliveryCommit, a.base);
  assert.equal(feature.completed, 1); assert.equal(feature.coordination.phase, "final-verification");
  review("final"); p = f.c.completionPreview();
  f.c.complete({ id: "complete", operationId: "op-complete", expectedHead: p.head, token: p.token, approvedBy: "user" });
  assert.equal(f.collect().features.find(x => x.id === "shared:feature").coordination.phase, "completed");
});
