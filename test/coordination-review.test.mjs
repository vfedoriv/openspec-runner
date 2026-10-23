import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { coordinationFixture } from "./helpers/coordination-fixture.mjs";
import { git, blocker } from "./helpers/feature-fixture.mjs";
import { replayStatus } from "../dist/coordination-state.js";

function configured(t, { dependencies = {}, verification = [] } = {}) {
  const f = coordinationFixture(t, { unchecked: false, configureManifest(manifest) {
    for (const [id, deps] of Object.entries(dependencies)) manifest.components[id] = { ...structuredClone(manifest.components.api), dependencies: deps };
    manifest.verification = verification;
  } });
  const manifest = f.manifest;
  f.approve();
  const write = record => f.c.store.writeRecord({ record, expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const event = (id, payload) => write({ version: 1, kind: "event", featureId: "feature", id, operationId: `op-${id}`, createdAt: "2026-10-05T12:00:00Z", sequence: Math.max(0, ...f.c.snapshot().records.filter(r => r.kind === "event").map(r => r.sequence)) + 1, ...payload });
  const assign = (componentId, id = `assignment-${componentId}`) => {
    const p = f.c.assignmentPreview({ contract: f.contract, componentId, owner: "alice" });
    f.c.assign({ contract: f.contract, componentId, owner: "alice", id, operationId: `op-${id}`, expectedHead: p.head, token: p.token });
    return f.c.snapshot().records.find(r => r.id === id);
  };
  const submit = (a, id = `receipt-${a.componentId}`, commit = a.base) => {
    const receipt = { version: 1, kind: "submission", featureId: "feature", id, operationId: `op-${id}`, createdAt: "2026-10-05T12:00:00Z", assignmentId: a.id, owner: a.owner, repository: a.repository, change: a.change, outcome: "completed", base: a.base, planFingerprint: a.planFingerprint, contractFingerprint: a.contract.fingerprint, result: { branch: "main", commit }, tasks: [{ id: "1.1", completed: true }], review: { commit, findings: [] }, verification: [] };
    f.c.importSubmission({ bytes: JSON.stringify(receipt), expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }); return receipt;
  };
  const accept = (receipt, id = `accept-${receipt.id}`) => {
    const p = f.c.acceptancePreview({ submissionId: receipt.id });
    return f.c.accept({ submissionId: receipt.id, id, operationId: `op-${id}`, expectedHead: p.head, token: p.token });
  };
  const reviewArgs = (id = "review", findings = [], stage = "combined") => {
    const p = f.c.reviewPreview({ stage });
    return { stage, id, operationId: `op-${id}`, expectedHead: p.head, token: p.token, review: { tuple: p.tuple, token: p.token, reviewedBy: "reviewer", summary: "Inspected the exact whole-feature tuple against the shared contract", findings } };
  };
  return { ...f, manifest, write, event, assign, submit, accept, reviewArgs };
}
function merge(f, id, receipt, commit = receipt.result.commit) {
  f.event(id, { type: "merged", componentId: receipt.id.replace("receipt-", ""), submissionId: receipt.id, commit: receipt.result.commit, deliveryCommit: commit, deliveryBranch: "main", mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" });
}

test("accepted and merged dependencies issue assignments with exact satisfying commits and diagnostics", t => {
  const f = configured(t, { dependencies: { web: [{ componentId: "api", milestone: "accepted" }], docs: [{ componentId: "api", milestone: "merged" }] } });
  assert.match(f.c.status().components.web.blocker, /api.*accepted/i);
  assert.throws(() => f.assign("web"), /api.*accepted/i);
  const api = f.submit(f.assign("api")); f.accept(api);
  assert.deepEqual(f.assign("web").dependencies, [{ componentId: "api", milestone: "accepted", commit: api.result.commit }]);
  assert.throws(() => f.assign("docs"), /api.*merged/i);
  merge(f, "merge-api", api);
  assert.deepEqual(f.assign("docs").dependencies, [{ componentId: "api", milestone: "merged", commit: api.result.commit }]);
});

test("assignment preview and mutation reject stale retained merges for accepted and merged dependencies", t => {
  for (const milestone of ["accepted", "merged"]) {
    const f = configured(t, { dependencies: { web: [{ componentId: "api", milestone: "accepted" }], docs: [{ componentId: "web", milestone }] } });
    const api = f.submit(f.assign("api")); f.accept(api);
    const web = f.submit(f.assign("web")); f.accept(web); merge(f, "merge-web", web);
    const input = { contract: f.contract, componentId: "docs", owner: "alice" }, preview = f.c.assignmentPreview(input);
    const commit = git(f.root, "commit-tree", git(f.root, "rev-parse", "HEAD^{tree}"), "-p", api.result.commit, "-m", "Replacement result");
    const replacement = f.submit(f.c.snapshot().records.find(r => r.id === api.assignmentId), "receipt-api-new", commit); f.accept(replacement);
    const status = f.c.status(), before = f.c.snapshot();
    assert.equal(status.components.web.requiresReapproval, true);
    assert.equal(status.components.web.deliveryCommit, web.result.commit);
    assert.equal(status.components.web.mergedHistory.length, 1);
    assert.match(status.components.docs.blocker, new RegExp(`web.*${milestone}`, "i"));
    assert.throws(() => f.c.assignmentPreview(input), new RegExp(`web.*${milestone}`, "i"));
    assert.throws(() => f.c.assign({ ...input, id: "assignment-docs", operationId: "op-assignment-docs", token: preview.token, expectedHead: before.head }), new RegExp(`web.*${milestone}`, "i"));
    assert.deepEqual(f.c.snapshot(), before);
    assert.equal(git(f.storeRoot, "status", "--porcelain"), "");
  }
});

test("revocation retries retain immutable sequence and timestamp with original head and reject changed intent", t => {
  for (const explicitTimestamp of [false, true]) {
    const f = configured(t); f.assign("api");
    const args = { assignmentId: "assignment-api", reason: "Owner changed", id: "revoke", operationId: "op-revoke", expectedHead: f.c.snapshot().head,
      ...(explicitTimestamp ? { createdAt: "2026-10-05T12:00:00Z" } : {}) };
    const first = f.c.revoke(args), bytes = readFileSync(join(f.storeRoot, first.path), "utf8");
    assert.equal(f.c.revoke(args).head, first.head);
    assert.equal(readFileSync(join(f.storeRoot, first.path), "utf8"), bytes);
    assert.equal(f.c.snapshot().records.filter(r => r.type === "revoked").length, 1);
    for (const changed of [{ reason: "Different reason" }, { assignmentId: "missing" }, { operationId: "different" }, { createdAt: "2026-10-06T12:00:00Z" }])
      assert.throws(() => f.c.revoke({ ...args, ...changed }), /immutable|identity/i);
    git(f.storeRoot, "switch", "-c", "other"); assert.throws(() => f.c.revoke(args), /branch/i); git(f.storeRoot, "switch", "coordination");
    assert.throws(() => f.c.revoke({ ...args, expectedHead: "a".repeat(40) }), /head/i);
    git(f.storeRoot, "commit", "--allow-empty", "-m", "Later history");
    assert.throws(() => f.c.revoke(args), /head/i);
  }
});

test("revocation recovers interruption after record commit without duplicate events", t => {
  const f = configured(t); f.assign("api");
  const args = { assignmentId: "assignment-api", reason: "Owner changed", id: "revoke", operationId: "op-revoke", expectedHead: f.c.snapshot().head };
  const original = f.c.store.writeRecord.bind(f.c.store);
  f.c.store.writeRecord = options => { original(options); throw new Error("Simulated interruption after commit"); };
  assert.throws(() => f.c.revoke(args), /Simulated interruption/);
  const head = f.c.snapshot().head, bytes = readFileSync(join(f.storeRoot, "runner/features/feature/events/revoke.json"), "utf8");
  f.c.store.writeRecord = original;
  assert.equal(f.c.revoke(args).head, head);
  assert.equal(readFileSync(join(f.storeRoot, "runner/features/feature/events/revoke.json"), "utf8"), bytes);
  assert.equal(f.c.snapshot().records.filter(r => r.type === "revoked").length, 1);
});

test("upstream replacement invalidates unmerged downstream transitively and forbids stale acceptance", t => {
  const f = configured(t, { dependencies: { web: [{ componentId: "api", milestone: "accepted" }], docs: [{ componentId: "web", milestone: "accepted" }] } });
  const api = f.submit(f.assign("api")); f.accept(api);
  const web = f.submit(f.assign("web")); f.accept(web);
  const docs = f.submit(f.assign("docs")); f.accept(docs);
  f.c.recordReview(f.reviewArgs()); assert.equal(f.c.status().phase, "ready-for-delivery");
  writeFileSync(join(f.root, "output.txt"), "replacement\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Replacement result");
  const replacement = f.submit(f.c.snapshot().records.find(r => r.id === "assignment-api"), "receipt-api-new", git(f.root, "rev-parse", "HEAD"));
  f.accept(replacement);
  const status = f.c.status();
  assert.equal(status.components.web.acceptedCommit, undefined); assert.equal(status.components.docs.acceptedCommit, undefined);
  assert.match(status.components.web.blocker, /depend|upstream/i);
  assert.throws(() => f.c.acceptancePreview({ submissionId: web.id }), /depend|upstream|stale/i);
  assert.throws(() => f.c.reviewPreview({ stage: "combined" }), /accepted/i);
  assert.equal(status.phase, "implementing");
});

test("chronological revocation preserves earlier merged historical facts and requires revised plan plus approval", t => {
  const f = configured(t); const a = f.assign("api"), receipt = f.submit(a); f.accept(receipt); merge(f, "merge-api", receipt);
  f.c.revoke({ assignmentId: a.id, reason: "Further implementation", id: "revoke", operationId: "op-revoke", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  assert.equal(f.c.status().components.api.deliveryCommit, receipt.result.commit);
  assert.throws(() => f.assign("api", "replacement"), /revised|plan|approval/i);
  f.approve("new-approval"); assert.throws(() => f.assign("api", "replacement"), /revised|plan/i);
  writeFileSync(join(f.root, "openspec/changes/demo/tasks.md"), "- [x] 1.1 Produce revised output\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Revised component plan");
  f.approve("revised-approval");
  const current = f.c.status().components.api;
  assert.equal(current.deliveryCommit, undefined); assert.equal(current.mergedHistory[0].deliveryCommit, receipt.result.commit);
  const replacement = f.assign("api", "replacement"); f.accept(f.submit(replacement, "receipt-replacement"));
  assert.equal(f.c.status().components.api.deliveryCommit, undefined); assert.equal(f.c.status().components.api.mergedHistory.length, 1);
  assert.equal(f.c.status().components.api.acceptedCommit, replacement.base);
  assert.equal(f.c.reviewPreview({ stage: "combined" }).tuple.api, replacement.base);
});

test("combined review previews are read-only and bind all exact checkouts, explicit findings and readiness", t => {
  const command = ["node", "-e", "const cp=require('node:child_process'),fs=require('node:fs'); const paths=JSON.parse(process.env.OPENSPEC_RUNNER_CHECKOUTS); if(Object.keys(paths).join(',')!=='api,web') process.exit(2); for(const path of Object.values(paths)) if(cp.execFileSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'}).trim()!==process.env.EXPECTED_REVIEW_COMMIT) process.exit(3); if(process.cwd()!==paths.web) process.exit(4); console.log('all exact checkouts verified');"];
  const f = configured(t, { dependencies: { web: [] }, verification: [{ componentId: "web", command }] });
  assert.throws(() => f.c.reviewPreview({ stage: "combined" }), /accepted/i);
  for (const id of ["web", "api"]) f.accept(f.submit(f.assign(id)));
  process.env.EXPECTED_REVIEW_COMMIT = git(f.root, "rev-parse", "HEAD"); t.after(() => delete process.env.EXPECTED_REVIEW_COMMIT);
  const before = git(f.root, "worktree", "list", "--porcelain"), head = git(f.storeRoot, "rev-parse", "HEAD"), args = f.reviewArgs();
  assert.deepEqual(Object.keys(args.review.tuple), ["api", "web"]);
  assert.equal(git(f.root, "worktree", "list", "--porcelain"), before); assert.equal(git(f.storeRoot, "rev-parse", "HEAD"), head);
  assert.throws(() => f.c.recordReview({ ...args, review: { ...args.review, tuple: { api: args.review.tuple.api } } }), /tuple|attest/i);
  f.c.recordReview(args); assert.equal(f.c.status().phase, "ready-for-delivery");
  assert.equal(git(f.root, "worktree", "list", "--porcelain"), before);
  const record = f.c.snapshot().records.find(r => r.id === "review");
  assert.equal(record.reviewedBy, "reviewer"); assert.match(record.verification[0].evidence, /all exact/);
  assert.ok(!JSON.stringify(record).includes(f.dir));
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [ ] 1.1 Deliver API\n");
  const receipt = f.c.snapshot().records.find(r => r.id === "receipt-api"); merge(f, "merge-api", receipt);
  assert.equal(f.c.status().phase, "awaiting-merges");
  f.c.recordReview(f.reviewArgs("blocking-review", [blocker]));
  assert.equal(f.c.status().phase, "verifying"); assert.match(f.c.status().blocker, /review|finding/i);
});

test("review rejects stale tokens and current context drift, and recovers committed events without repeating checks", t => {
  const command = ["node", "-e", "require('node:fs').appendFileSync(process.env.REVIEW_COUNTER,'checked\\n'); console.log('checked exact tuple');"];
  const f = configured(t, { verification: [{ componentId: "api", command }] }); f.accept(f.submit(f.assign("api"))); const args = f.reviewArgs();
  const counter = join(f.dir, "review-counter"); process.env.REVIEW_COUNTER = counter; t.after(() => delete process.env.REVIEW_COUNTER);
  assert.throws(() => f.c.recordReview({ ...args, token: "bad" }), /token/i);
  const original = f.c.store.writeRecord.bind(f.c.store); let interrupted = false;
  f.c.store.writeRecord = options => { const result = original(options); if (!interrupted && options.record.type === "reviewed") { interrupted = true; throw new Error("Interrupted after review commit"); } return result; };
  assert.throws(() => f.c.recordReview(args), /Interrupted/); f.c.store.writeRecord = original;
  f.c.recordReview(args); f.c.recordReview(args);
  assert.equal(readFileSync(counter, "utf8"), "checked\n");
  assert.equal(f.c.snapshot().records.filter(r => r.type === "reviewed").length, 1); assert.deepEqual(f.c.status().pendingOperations, []);
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Changed contract\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Changed context");
  assert.equal(f.c.status().phase, "awaiting-approval");
  assert.throws(() => f.c.reviewPreview({ stage: "combined" }), /context|contract|drift/i);
});

test("review checks detect sibling checkout changes and ambiguous interruptions do not replay commands", t => {
  const command = ["node", "-e", "const fs=require('node:fs'); const paths=JSON.parse(process.env.OPENSPEC_RUNNER_CHECKOUTS); if(process.env.FAIL_TUPLE) fs.writeFileSync(paths.api+'/output.txt','changed sibling'); console.log('checked sibling');"];
  const f = configured(t, { dependencies: { web: [] }, verification: [{ componentId: "web", command }] });
  for (const id of ["api", "web"]) f.accept(f.submit(f.assign(id)));
  f.c.recordReview(f.reviewArgs("passing-review")); assert.equal(f.c.status().phase, "ready-for-delivery");
  process.env.FAIL_TUPLE = "1"; t.after(() => delete process.env.FAIL_TUPLE);
  const args = f.reviewArgs(); assert.throws(() => f.c.recordReview(args), /check|command|tuple/i); delete process.env.FAIL_TUPLE;
  assert.equal(f.c.status().phase, "verifying"); assert.throws(() => f.c.recordReview(args), /failed/i);
  const failed = f.c.snapshot().records.find(r => r.id === "review");
  assert.equal(failed.findings.at(-1).componentId, "web"); assert.equal(failed.findings.at(-1).owner, "alice");
  assert.match(f.c.status().blocker, /web.*alice.*failed/i);
  const path = join(f.storeRoot, ".git/openspec-runner/review/op-review.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  journal.stage = "checking"; journal.running = 0; writeFileSync(path, JSON.stringify(journal));
  assert.throws(() => f.c.recordReview(args), /ambiguous|interrupted/i);
});

test("merged downstream history survives upstream replacement while readiness requires renewed plans", t => {
  const f = configured(t, { dependencies: { web: [{ componentId: "api", milestone: "accepted" }], docs: [{ componentId: "web", milestone: "accepted" }] } });
  const api = f.submit(f.assign("api")); f.accept(api);
  const web = f.submit(f.assign("web")); f.accept(web); merge(f, "merge-web", web);
  const docs = f.submit(f.assign("docs")); f.accept(docs);
  const snapshot = f.c.snapshot(), sequence = Math.max(...snapshot.records.filter(r => r.kind === "event").map(r => r.sequence));
  const replacement = { ...api, id: "receipt-replaced", operationId: "op-receipt-replaced", result: { branch: "main", commit: "d".repeat(40) }, review: { commit: "d".repeat(40), findings: [] } };
  snapshot.records.push(replacement, { version: 1, kind: "event", featureId: "feature", id: "replaced", operationId: "op-replaced", createdAt: "2026-10-05T12:00:00Z", sequence: sequence + 1, type: "accepted", componentId: "api", assignmentId: api.assignmentId, submissionId: replacement.id, commit: replacement.result.commit });
  const status = replayStatus({ snapshot });
  assert.equal(status.components.web.deliveryCommit, web.result.commit); assert.equal(status.components.web.mergedHistory.length, 1);
  assert.equal(status.components.web.requiresReapproval, true); assert.equal(status.components.docs.acceptedCommit, undefined);
  assert.equal(status.phase, "implementing"); assert.match(status.components.web.nextAction, /plan.*approval/i);
});

test("renewed contract approval invalidates final review and completion authority without erasing merged history", t => {
  const f = configured(t); const receipt = f.submit(f.assign("api")); f.accept(receipt); merge(f, "merge-api", receipt);
  f.c.recordReview(f.reviewArgs("final-review", [], "final"));
  assert.equal(f.c.status().phase, "awaiting-final-approval");
  const completion = f.c.completionPreview({});
  f.c.complete({ id: "complete", operationId: "op-complete", expectedHead: completion.head, token: completion.token, approvedBy: "operator" });
  assert.equal(f.c.status().phase, "completed");
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Changed approved shared context\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Changed shared context");
  f.approve("renewed-approval");
  const status = f.c.status();
  assert.equal(status.approvalId, "renewed-approval");
  assert.ok(!["ready-for-delivery", "awaiting-merges", "awaiting-final-approval", "completed"].includes(status.phase));
  assert.equal(status.components.api.mergedHistory[0].deliveryCommit, receipt.result.commit);
  assert.match(status.blocker, /approval|context|revis/i); assert.match(status.nextAction, /plan|approval|reconcil/i);
  assert.throws(() => f.c.reviewPreview({ stage: "final" }), /approval|merged|context/i);
  assert.ok(!["awaiting-final-approval", "completed"].includes(f.c.store.status().phase));
});
