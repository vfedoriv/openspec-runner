import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { coordinationFixture } from "./helpers/coordination-fixture.mjs";
import { git, executable } from "./helpers/feature-fixture.mjs";
import { execFileSync } from "node:child_process";
import { replayStatus } from "../dist/coordination-state.js";

function delivery(t, finalMapping = false, options = {}) {
  const f = coordinationFixture(t, { ...options, unchecked: false, configureManifest(m) { if (finalMapping) m.taskMapping["1.1"] = [{ type: "final-verification" }]; } });
  options.beforeApprove?.(f); f.approve(); options.beforeAssign?.(f); f.assign();
  const a = f.c.snapshot().records.find(r => r.kind === "assignment");
  const submit = (commit, id = "receipt") => {
    const receipt = { version: 1, kind: "submission", featureId: "feature", id, operationId: `op-${id}`, createdAt: "2026-10-05T12:00:00Z", assignmentId: a.id, owner: a.owner, repository: a.repository, change: a.change, outcome: "completed", base: a.base, planFingerprint: a.planFingerprint, contractFingerprint: a.contract.fingerprint, result: { branch: "main", commit }, tasks: [{ id: "1.1", completed: true }], review: { commit, findings: [] }, verification: (options.checks ?? []).map(command => ({ command, exitCode: 0, evidence: "Claimed component verification" })) };
    f.c.importSubmission({ bytes: JSON.stringify(receipt), expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
    const p = f.c.acceptancePreview({ submissionId: id }); f.c.accept({ submissionId: id, token: p.token, expectedHead: p.head, id: `accept-${id}`, operationId: `op-accept-${id}` });
    return receipt;
  };
  let reviewNumber = 0;
  const review = (stage) => { reviewNumber++; const p = f.c.reviewPreview({ stage }); f.c.recordReview({ stage, token: p.token, expectedHead: p.head, id: `${stage}-review-${reviewNumber}`, operationId: `op-${stage}-review-${reviewNumber}`, review: { tuple: p.tuple, token: p.token, reviewedBy: "reviewer", summary: "Inspected exact tuple", findings: [] } }); };
  const merge = (commit, extra = {}) => { const args = { componentId: "api", deliveryCommit: commit, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator", ...extra }; const p = f.c.mergePreview(args); return f.c.recordMerge({ ...args, token: p.token, expectedHead: p.head, id: "merge", operationId: "op-merge" }); };
  const complete = (archive) => { const p = f.c.completionPreview({ archive }); const args = { token: p.token, approvedBy: "user", expectedHead: p.head, id: "complete", operationId: "op-complete", archive }; f.c.complete(args); return args; };
  return { ...f, a, submit, review, merge, complete };
}

test("delivery changed-path evidence preserves leading whitespace filenames", t => {
  const f = delivery(t);
  writeFileSync(join(f.root, " output.txt"), "accepted\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Accepted whitespace path");
  f.submit(git(f.root, "rev-parse", "HEAD")); f.review("combined");
  writeFileSync(join(f.root, " output.txt"), "different delivered blob\n"); git(f.root, "commit", "-am", "Changed whitespace path");
  const commit = git(f.root, "rev-parse", "HEAD"), input = { componentId: "api", deliveryCommit: commit, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" };
  const p = f.c.mergePreview(input);
  assert.deepEqual(p.changedPaths, [" output.txt"]); assert.deepEqual(p.mismatches, [" output.txt"]);
  assert.throws(() => f.merge(commit), /fresh|snapshot|accept/i);
});

test("portable archive replay rejects independently forged paths and consent bases", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: ["api"], includeStore: false }, p = f.c.archivePreview({ scope });
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  const snapshot = f.c.snapshot(), completion = snapshot.records.find(r => r.type === "completed"), seq = Math.max(...snapshot.records.filter(r => r.kind === "event").map(r => r.sequence)) + 1;
  const prepared = { version: 1, kind: "event", featureId: "feature", id: "prepared", operationId: "op-prepared", createdAt: "2026-10-05T12:00:00Z", sequence: seq, type: "archive-prepared", componentId: "api", commit: f.a.base, base: p.targets.api.base, branch: "main", preparedBranch: "runner-archive/feature/op-prepared/api", paths: ["openspec/changes/demo/tasks.md", "openspec/changes/archive/2026-10-05-demo/tasks.md", "openspec/specs/demo/spec.md"], completionEventId: completion.id, snapshotToken: p.token, evidence: "Inspected archive" };
  const delivered = { ...prepared, id: "delivered", operationId: "op-delivered", sequence: seq + 1, type: "archive-delivered", preparedEventId: prepared.id };
  delete delivered.preparedBranch;
  const replay = (a, b = delivered) => replayStatus({ snapshot: { ...snapshot, records: [...snapshot.records, a, b] } });
  assert.equal(replay(prepared).archive, "archived");
  assert.throws(() => replay({ ...prepared, paths: ["README.md"] }, { ...delivered, paths: ["README.md"] }), /scope|path/i);
  assert.throws(() => replay({ ...prepared, paths: ["openspec/changes/archive/2026-10-05-other/tasks.md"] }), /scope|path/i);
  assert.throws(() => replay({ ...prepared, base: "c".repeat(40) }), /base|consent|scope/i);
  assert.throws(() => replay(prepared, { ...delivered, base: "d".repeat(40) }), /base|scope|evidence/i);
  for (const key of ["base", "snapshotToken", "completionEventId", "preparedBranch", "evidence"]) {
    const missing = { ...prepared }; delete missing[key];
    assert.throws(() => replay(missing), /archive|scope|base|evidence/i);
  }
});

test("shared milestones and Store archive preserve all approved non-checkbox bytes", t => {
  const source = "\n  - [ ] 1.1 Deliver API\n\n```md\n- [ ] 9.9 Example only\n```\n\n\n";
  const f = delivery(t, true, { beforeApprove(f) { writeFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), source); git(f.storeRoot, "commit", "-am", "Approve exact whitespace and fences"); } });
  f.submit(f.a.base); f.review("combined"); f.merge(f.a.base);
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), source);
  f.review("final"); const expected = source.replace("[ ] 1.1", "[x] 1.1");
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), expected);
  f.complete(); git(f.storeRoot, "branch", "contracts-main");
  const scope = { componentIds: [], includeStore: true, storeDeliveryBranch: "contracts-main" }, p = f.c.archivePreview({ scope });
  assert.equal(p.targets._store.tasksContent, expected);
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  const approved = f.c.archivePreview({ scope }); f.c.prepareArchive({ scope, token: approved.token, expectedHead: approved.head, id: "archive", operationId: "op-archive" });
  const record = f.c.snapshot().records.find(r => r.type === "archive-prepared");
  assert.equal(execFileSync("git", ["show", `${record.commit}:openspec/changes/archive/2026-09-20-shared/tasks.md`], { cwd: f.storeRoot, encoding: "utf8" }), expected);
});

test("merge verifies reachable normal and attested squash results, permits unrelated paths, updates only mapped tasks", t => {
  const f = delivery(t); writeFileSync(join(f.root, "output.txt"), "accepted\n"); unlinkSync(join(f.root, "openspec/changes/demo/execution.yaml"));
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Result"); const commit = git(f.root, "rev-parse", "HEAD");
  // Deleting planning files is not permitted by acceptance; restore the approved one before receipt.
  git(f.root, "checkout", f.a.base, "--", "openspec/changes/demo/execution.yaml"); git(f.root, "commit", "-m", "Restore planning"); const result = git(f.root, "rev-parse", "HEAD"); f.submit(result); f.review("combined");
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [ ] 1.1 Deliver API\n");
  git(f.root, "checkout", "-b", "orphan-result", f.a.base); writeFileSync(join(f.root, "output.txt"), "accepted\n"); writeFileSync(join(f.root, "unrelated.txt"), "other\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Squashed"); const squashed = git(f.root, "rev-parse", "HEAD");
  assert.throws(() => f.c.mergePreview({ componentId: "api", deliveryCommit: squashed, mergeStyle: "squash", prUrl: "https://example.test/pr/1", attestedBy: "operator" }), /reach|delivery/i);
  git(f.root, "branch", "-f", "main", squashed);
  assert.throws(() => f.c.mergePreview({ componentId: "api", deliveryCommit: squashed, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" }), /ancestor/i);
  assert.throws(() => f.c.mergePreview({ componentId: "api", deliveryCommit: squashed, mergeStyle: "squash", prUrl: "https://example.test/pr/1", attestedBy: "" }), /attest|explicit/i);
  f.merge(squashed, { mergeStyle: "squash" });
  assert.equal(f.c.status().components.api.deliveryCommit, squashed); assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [x] 1.1 Deliver API\n");
});

test("delivery mismatch requires fresh exact snapshot review and independent acceptance", t => {
  const f = delivery(t); writeFileSync(join(f.root, "output.txt"), "accepted\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Accepted"); f.submit(git(f.root, "rev-parse", "HEAD")); f.review("combined");
  writeFileSync(join(f.root, "output.txt"), "delivered\n"); git(f.root, "commit", "-am", "Delivered difference"); const commit = git(f.root, "rev-parse", "HEAD");
  assert.throws(() => f.merge(commit), /snapshot|fresh|accept/i);
  f.submit(commit, "delivered-receipt"); f.review("combined"); f.merge(commit); assert.equal(f.c.status().components.api.deliveryCommit, commit);
});

test("completion binds latest final review and explicit consent; final milestones and archives remain separate", t => {
  const f = delivery(t, true); f.submit(f.a.base); f.review("combined"); assert.throws(() => f.c.completionPreview({}), /merged|final/i); f.merge(f.a.base);
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [ ] 1.1 Deliver API\n"); f.review("final");
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [x] 1.1 Deliver API\n");
  const p = f.c.completionPreview({}); assert.throws(() => f.c.complete({ token: p.token, approvedBy: "", expectedHead: p.head, id: "complete", operationId: "op-complete" }), /consent|explicit/i);
  const args = f.complete(); assert.equal(f.c.complete(args).created, false); assert.equal(f.c.status().phase, "completed"); assert.equal(f.c.status().archive, "pending");
});

test("approved postmerge archive prepares OpenSpec commits and requires canonical content delivery for every target", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  git(f.storeRoot, "branch", "contracts-main");
  const scope = { componentIds: ["api"], includeStore: true, storeDeliveryBranch: "contracts-main" };
  assert.throws(() => f.c.archivePreview({ scope: { ...scope, storeDeliveryBranch: undefined } }), /branch|Store/i);
  let p = f.c.archivePreview({ scope }); assert.throws(() => f.c.prepareArchive({ scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" }), /approval|consent/i);
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); const args = { scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" }; f.c.prepareArchive(args); f.c.prepareArchive(args);
  assert.equal(f.getControl().archiveCalls, 2); assert.equal(f.c.status().phase, "completed"); assert.equal(f.c.status().archive, "prepared");
  const prepared = f.c.snapshot().records.filter(r => r.type === "archive-prepared"); assert.equal(prepared.length, 2); assert.ok(!JSON.stringify(prepared).includes(f.dir));
  for (const [index, record] of prepared.entries()) {
    const root = record.componentId ? f.root : f.storeRoot, canonical = record.componentId ? "main" : "contracts-main";
    if (record.componentId) git(root, "checkout", "--detach");
    git(root, "branch", "-f", canonical, record.commit);
    const options = { preparedEventId: record.id, deliveryCommit: record.commit }; const p = f.c.archiveDeliveryPreview(options);
    f.c.recordArchiveDelivery({ ...options, token: p.token, expectedHead: p.head, id: `delivered-${record.id}`, operationId: `op-delivered-${record.id}` });
    if (index < prepared.length - 1) assert.equal(f.c.status().archive, "prepared");
  }
  assert.equal(f.c.status().archive, "archived");
});

test("rewritten delivered snapshot revalidation does not require assigned-base ancestry", t => {
  const f = delivery(t); writeFileSync(join(f.root, "output.txt"), "accepted output\n"); git(f.root, "commit", "-am", "Accepted output"); f.submit(git(f.root, "rev-parse", "HEAD")); f.review("combined");
  git(f.root, "checkout", "--orphan", "rewritten");
  writeFileSync(join(f.root, "output.txt"), "rewritten delivery\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Rewritten snapshot");
  const commit = git(f.root, "rev-parse", "HEAD"); git(f.root, "branch", "-f", "main", commit);
  const input = { componentId: "api", deliveryCommit: commit, mergeStyle: "rebase", prUrl: "https://example.test/pr/1", attestedBy: "operator" };
  assert.throws(() => f.merge(commit, { mergeStyle: "rebase" }), /fresh|snapshot|accept/i);
  const p = f.c.deliveryAcceptancePreview(input);
  assert.throws(() => f.c.acceptDelivery({ ...input, token: p.token, expectedHead: p.head, id: "delivered-review", operationId: "op-delivered-review", review: { commit: f.a.base, reviewedBy: "reviewer", summary: "Wrong commit", findings: [] } }), /exact|review/i);
  f.c.acceptDelivery({ ...input, token: p.token, expectedHead: p.head, id: "delivered-review", operationId: "op-delivered-review", review: { commit, reviewedBy: "reviewer", summary: "Inspected rewritten delivered snapshot", findings: [] } });
  f.merge(commit, { mergeStyle: "rebase" }); assert.equal(f.c.status().components.api.deliveryCommit, commit);
});

test("archive interruption retains evidence and never blindly reruns; recovery checks scope", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: ["api"], includeStore: false };
  let p = f.c.archivePreview({ scope }); f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); const args = { scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" };
  f.control({ archiveCrash: true, archiveExtraFile: true });
  assert.throws(() => f.c.prepareArchive(args), /archive|scope|command/i);
  assert.throws(() => f.c.prepareArchive(args), /ambiguous|interrupted|failed|scope/i);
  assert.equal(f.getControl().archiveCalls, 1);
  assert.throws(() => f.c.recoverArchivePreparation({ operationId: "op-archive", targetId: "api", attestedBy: "operator" }), /scope|unexpected/i);
  const receipt = f.c.inspectArchivePreparation({ operationId: "op-archive" }); assert.ok(receipt.targets.api.reason); assert.equal(f.c.status().archive, "pending");
});

test("archive preparation rejects unrelated scope even when OpenSpec exits successfully", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: ["api"], includeStore: false };
  let p = f.c.archivePreview({ scope }); f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); f.control({ archiveExtraFile: true });
  assert.throws(() => f.c.prepareArchive({ scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" }), /scope|unexpected/i);
  assert.equal(f.c.snapshot().records.filter(r => r.type === "archive-prepared").length, 0);
});

test("changed deletion state on delivery requires fresh independent checks and review", t => {
  const f = delivery(t); unlinkSync(join(f.root, "output.txt")); git(f.root, "commit", "-am", "Accepted deletion"); f.submit(git(f.root, "rev-parse", "HEAD")); f.review("combined");
  git(f.root, "checkout", f.a.base, "--", "output.txt"); git(f.root, "commit", "-am", "Delivered restored path");
  const commit = git(f.root, "rev-parse", "HEAD"); const p = f.c.mergePreview({ componentId: "api", deliveryCommit: commit, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" });
  assert.deepEqual(p.mismatches, ["output.txt"]); assert.throws(() => f.merge(commit), /fresh|snapshot|accept/i);
});

test("delivered acceptance reruns approved checks independently and retains failing evidence", t => {
  const check = ["node", "-e", "if(require('node:fs').readFileSync('output.txt','utf8').includes('bad')) process.exit(7)"];
  const f = delivery(t, false, { checks: [check] }); writeFileSync(join(f.root, "output.txt"), "accepted\n"); git(f.root, "commit", "-am", "Accepted"); f.submit(git(f.root, "rev-parse", "HEAD")); f.review("combined");
  writeFileSync(join(f.root, "output.txt"), "bad delivered\n"); git(f.root, "commit", "-am", "Delivered difference"); const commit = git(f.root, "rev-parse", "HEAD");
  const input = { componentId: "api", deliveryCommit: commit, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" }, p = f.c.deliveryAcceptancePreview(input);
  const args = { ...input, token: p.token, expectedHead: p.head, id: "delivery-accept", operationId: "op-delivery-accept", review: { commit, reviewedBy: "reviewer", summary: "Reviewed delivered result", findings: [] } };
  assert.throws(() => f.c.acceptDelivery(args), /check failed/i); assert.throws(() => f.c.acceptDelivery(args), /failed/i);
  const journalPath = join(f.storeRoot, ".git/openspec-runner/delivery-acceptance/op-delivery-accept.json"), original = readFileSync(journalPath, "utf8"), corrupt = JSON.parse(original);
  corrupt.data.stage = "verified"; corrupt.data.index = 0; corrupt.data.evidence = [{ command: check, exitCode: 0, evidence: "Fabricated claim" }];
  writeFileSync(journalPath, JSON.stringify(corrupt)); assert.throws(() => f.c.acceptDelivery(args), /incomplete|journal|inventory/i); writeFileSync(journalPath, original);
  assert.equal(f.c.snapshot().records.filter(r => r.type === "delivery-accepted").length, 0); assert.throws(() => f.merge(commit), /fresh|snapshot|accept/i);
});

test("new merged tuple invalidates completion consent and requires latest final review", t => {
  const f = delivery(t, true); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final");
  const oldPreview = f.c.completionPreview({}); f.complete();
  writeFileSync(join(f.root, "unrelated.txt"), "later canonical\n"); git(f.root, "add", "."); git(f.root, "commit", "-m", "Later delivered snapshot");
  const input = { componentId: "api", deliveryCommit: git(f.root, "rev-parse", "HEAD"), mergeStyle: "merge", prUrl: "https://example.test/pr/2", attestedBy: "operator" }, p = f.c.mergePreview(input);
  f.c.recordMerge({ ...input, token: p.token, expectedHead: p.head, id: "merge-2", operationId: "op-merge-2" });
  assert.equal(f.c.status().phase, "final-verification"); assert.throws(() => f.c.completionPreview({}), /final|review/i);
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [ ] 1.1 Deliver API\n");
  f.review("final"); assert.throws(() => f.c.complete({ token: oldPreview.token, approvedBy: "user", expectedHead: git(f.storeRoot, "rev-parse", "HEAD"), id: "complete-2", operationId: "op-complete-2" }), /stale/i);
  const current = f.c.reviewPreview({ stage: "final" }); f.c.recordReview({ stage: "final", token: current.token, expectedHead: current.head, id: "blocked-final", operationId: "op-blocked-final", review: { tuple: current.tuple, token: current.token, reviewedBy: "reviewer", summary: "New finding", findings: [{ id: "F", category: "correctness", componentId: "api", owner: "alice", location: "output.txt", impact: "Delivered bug", correction: "Correct bug" }] } });
  assert.throws(() => f.c.completionPreview({}), /final|review/i);
});

test("explicit inspected archive recovery resumes produced result without rerunning OpenSpec", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: ["api"], includeStore: false }; let p = f.c.archivePreview({ scope });
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); const args = { scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" };
  f.control({ archiveCrash: true }); assert.throws(() => f.c.prepareArchive(args), /archive/i);
  assert.throws(() => f.c.recoverArchivePreparation({ operationId: "op-archive", targetId: "api", attestedBy: "" }), /attest/i);
  f.c.recoverArchivePreparation({ operationId: "op-archive", targetId: "api", attestedBy: "operator" });
  f.c.prepareArchive(args); assert.equal(f.getControl().archiveCalls, 1); assert.equal(f.c.status().archive, "prepared");
  const record = f.c.snapshot().records.find(r => r.type === "archive-prepared"); assert.match(record.evidence, /operator/);
  assert.throws(() => f.c.prepareArchive({ ...args, token: "different" }), /identity/i);
  git(f.root, "checkout", "--detach"); git(f.root, "branch", "-f", "main", record.commit);
  // Canonical deletion and blob evidence is independent of prepared commit ancestry.
  const input = { preparedEventId: record.id, deliveryCommit: record.commit }, d = f.c.archiveDeliveryPreview(input);
  f.c.recordArchiveDelivery({ ...input, token: d.token, expectedHead: d.head, id: "archive-delivered", operationId: "op-archive-delivered" });
  assert.equal(f.c.status().archive, "archived"); assert.equal(f.c.prepareArchive(args)[0].created, false);
});

test("portable archive records cannot grant unapproved scope or falsely claim delivery", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const completed = f.c.snapshot().records.find(r => r.type === "completed");
  const record = { version: 1, kind: "event", featureId: "feature", id: "forged", operationId: "op-forged", createdAt: "2026-10-05T12:00:00Z", sequence: 99, type: "archive-prepared", componentId: "api", commit: f.a.base, base: f.a.base, branch: "main", paths: ["openspec/specs/demo/spec.md"], completionEventId: completed.id, snapshotToken: "f".repeat(64), evidence: "Claimed archive" };
  assert.throws(() => f.c.store.writeRecord({ record, expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }), /approval|scope|consent/i);
});

test("atomic merge task update recovers one exact record after interrupted ref update", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined");
  const input = { componentId: "api", deliveryCommit: f.a.base, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "operator" }, p = f.c.mergePreview(input);
  const args = { ...input, token: p.token, expectedHead: p.head, id: "merge", operationId: "op-merge" }, persist = f.c.store.writeRecord.bind(f.c.store);
  let once = true; f.c.store.writeRecord = options => { const result = persist(options); if (options.record.type === "merged" && once) { once = false; throw new Error("simulated interruption after ref update"); } return result; };
  assert.throws(() => f.c.recordMerge(args), /interruption/i);
  const head = git(f.storeRoot, "rev-parse", "HEAD"); assert.equal(git(f.storeRoot, "show", `${head}:openspec/changes/shared/tasks.md`), "- [x] 1.1 Deliver API");
  f.c.recordMerge(args); assert.equal(f.c.snapshot().records.filter(r => r.type === "merged").length, 1); assert.equal(git(f.storeRoot, "status", "--porcelain"), "");
  assert.equal(git(f.storeRoot, "rev-parse", "HEAD"), head);
});

test("completion can consent to unchanged component archive scope and canonical delivery rejects mismatch", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final");
  const scope = { componentIds: ["api"], includeStore: false }; f.complete(scope);
  const p = f.c.archivePreview({ scope }); f.c.prepareArchive({ scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" });
  const prepared = f.c.snapshot().records.find(r => r.type === "archive-prepared"); assert.equal(git(f.root, "rev-parse", prepared.preparedBranch), prepared.commit);
  assert.throws(() => f.c.archiveDeliveryPreview({ preparedEventId: prepared.id, deliveryCommit: prepared.commit }), /reachable|canonical/i);
  git(f.root, "checkout", "--detach", prepared.commit); writeFileSync(join(f.root, "openspec/specs/demo/spec.md"), "Different canonical spec\n"); git(f.root, "commit", "-am", "Alter archive spec");
  const wrong = git(f.root, "rev-parse", "HEAD"); git(f.root, "branch", "-f", "main", wrong);
  assert.throws(() => f.c.archiveDeliveryPreview({ preparedEventId: prepared.id, deliveryCommit: wrong }), /content|differ/i);
  assert.equal(f.c.status().archive, "prepared"); assert.equal(f.c.status().phase, "completed");
});

test("archive recovery rejects altered planning bytes rather than normalizing them", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: ["api"], includeStore: false }; let p = f.c.archivePreview({ scope });
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); f.control({ archiveCrash: true }); assert.throws(() => f.c.prepareArchive({ scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" }), /archive/i);
  const receipt = f.c.inspectArchivePreparation({ operationId: "op-archive" }); const file = join(receipt.targets.api.path, "openspec/changes/archive/2026-09-20-demo/execution.yaml");
  writeFileSync(file, readFileSync(file, "utf8") + "\n \n");
  assert.throws(() => f.c.recoverArchivePreparation({ operationId: "op-archive", targetId: "api", attestedBy: "operator" }), /bytes|source|planning/i);
});

test("shared final milestones follow authoritative approval history rather than approval timestamps", t => {
  const f = delivery(t, true, { beforeAssign(f) { f.approve("renewed", { createdAt: "2000-01-01T00:00:00Z" }); } });
  f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final");
  assert.equal(f.c.status().phase, "awaiting-final-approval");
  assert.equal(readFileSync(join(f.storeRoot, "openspec/changes/shared/tasks.md"), "utf8"), "- [x] 1.1 Deliver API\n");
});

test("same Store canonical and coordination branch supports approved archive and preserves unaffected guidance", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: [], includeStore: true, storeDeliveryBranch: "coordination" }; let p = f.c.archivePreview({ scope });
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); f.c.prepareArchive({ scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" });
  const prepared = f.c.snapshot().records.find(r => r.type === "archive-prepared"); git(f.storeRoot, "merge", "--no-edit", prepared.commit);
  const input = { preparedEventId: prepared.id, deliveryCommit: git(f.storeRoot, "rev-parse", "HEAD") }, d = f.c.archiveDeliveryPreview(input);
  f.c.recordArchiveDelivery({ ...input, token: d.token, expectedHead: d.head, id: "archive-delivered", operationId: "op-archive-delivered" });
  assert.equal(f.c.status().phase, "completed"); assert.equal(f.c.status().archive, "archived");
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Changed unauthorized guidance\n"); git(f.storeRoot, "commit", "-am", "Tamper unrelated guidance");
  assert.equal(f.c.status().phase, "awaiting-approval"); assert.match(f.c.status().blocker, /context|drift|guidance|contract/i);
});

test("archive commit recovery binds produced blob tree rather than only changed paths", t => {
  const f = delivery(t); f.submit(f.a.base); f.review("combined"); f.merge(f.a.base); f.review("final"); f.complete();
  const scope = { componentIds: ["api"], includeStore: false }; let p = f.c.archivePreview({ scope });
  f.c.approveArchive({ scope, token: p.token, approvedBy: "user", expectedHead: p.head, id: "archive-approval", operationId: "op-archive-approval" });
  p = f.c.archivePreview({ scope }); const args = { scope, token: p.token, expectedHead: p.head, id: "archive", operationId: "op-archive" };
  git(f.root, "config", "diff.renames", "false");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  f.control({ interruptArchiveCommit: true }); executable(join(f.bin, "git"), `
const fs=require('node:fs'), cp=require('node:child_process'), file=${JSON.stringify(f.controlPath)}, control=JSON.parse(fs.readFileSync(file,'utf8')), args=process.argv.slice(2);
if (args.includes('commit') && process.cwd().includes('archive-checkouts') && control.interruptArchiveCommit) { control.interruptArchiveCommit=false; fs.writeFileSync(file,JSON.stringify(control)); process.exit(1); }
try { cp.execFileSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}); } catch(e) { process.exit(e.status || 1); }
`);
  assert.throws(() => f.c.prepareArchive(args), /git|commit/i);
  const receipt = f.c.inspectArchivePreparation({ operationId: "op-archive" }); assert.equal(receipt.targets.api.stage, "committing");
  const journalPath = join(f.storeRoot, ".git/openspec-runner/archive/op-archive.json"), originalJournal = readFileSync(journalPath, "utf8"), legacy = JSON.parse(originalJournal);
  delete legacy.data.targets.api.tree; writeFileSync(journalPath, JSON.stringify(legacy));
  assert.throws(() => f.c.prepareArchive(args), /saved tree|tree identity/i);
  writeFileSync(journalPath, originalJournal);
  writeFileSync(join(receipt.targets.api.path, "openspec/specs/demo/spec.md"), "Same paths with altered produced blob\n");
  assert.throws(() => f.c.prepareArchive(args), /tree|snapshot|blob|produced|scope/i);
  assert.equal(f.c.snapshot().records.filter(r => r.type === "archive-prepared").length, 0); assert.equal(f.getControl().archiveCalls, 1);
  git(f.root, "config", "--unset", "diff.renames");
  writeFileSync(join(receipt.targets.api.path, "openspec/specs/demo/spec.md"), "Synchronized specification\n");
  f.c.prepareArchive(args); assert.equal(f.c.status().archive, "prepared"); assert.equal(f.getControl().archiveCalls, 1);
});
