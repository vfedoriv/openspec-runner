import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../dist/coordination.js";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";

test("Store acceptance independently checks code and recovers atomic progress before tuple delivery", t => {
  const f = storePlanningFixture(t), head = () => git(f.storeRoot, "rev-parse", "HEAD");
  git(f.code, "config", "openspec-runner.repository", "api");
  const checks = [["node", "-e", "if(process.env.STORE_ACCEPT_FAIL) process.exit(1); console.log('Code independently verified')"]];
  f.write("components/api/openspec/runner.yaml", JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "api" } }, verifyIntegration: checks }));
  f.write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Deliver API\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Shared plan");
  const role = { harness: "codex", model: "api", effort: "low" };
  const contract = { repository: "contracts", context: { implementationRoot: f.code, planningRoot: f.storeRoot,
    changeRoot: join(f.storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] } };
  const c = new Coordination({ root: f.storeRoot, featureId: "product", repositories: { contracts: f.storeRoot, api: f.code }, execute: f.input().execute });
  const manifest = { version: 2, featureId: "product", storeId: "team", sharedChange: "shared", coordinationBranch: "main",
    components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [], planning: { repository: "contracts", openspecRoot: "components/api/openspec" },
      settings: { implementation: role, tasks: {}, review: role, repair: role, maxFixRounds: 2, setup: [], verifyIntegration: checks } } },
    taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  c.init({ contract, manifest, expectedHead: head(), operationId: "init" });
  c.approve({ contract, id: "approval", operationId: "approval", expectedHead: head(), token: c.approvalPreview({ contract }).token, approvedBy: "user" });
  const request = { contract, componentId: "api", owner: "owner" };
  c.assign({ ...request, id: "assignment", operationId: "assignment", expectedHead: head(), token: c.assignmentPreview(request).token });
  const assignment = c.snapshot().records.find(record => record.kind === "assignment");
  git(f.code, "checkout", "-b", "worker"); writeFileSync(join(f.code, "result.txt"), "implemented\n");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Implement");
  const workerCommit = git(f.code, "rev-parse", "HEAD");
  git(f.code, "checkout", "-b", "integration", assignment.base);
  git(f.code, "merge", "--no-ff", "worker", "-m", "Integrate\n\nopenspec-runner:attempt");
  const commit = git(f.code, "rev-parse", "HEAD");
  const receipt = { version: 2, kind: "submission", featureId: "product", id: "receipt", operationId: "receipt", createdAt: new Date().toISOString(),
    assignmentId: assignment.id, owner: assignment.owner, repository: assignment.repository, change: assignment.change, outcome: "completed", base: assignment.base,
    planFingerprint: assignment.planFingerprint, planningRevision: assignment.planningSource.revision, contractFingerprint: assignment.contract.fingerprint,
    result: { commit, branch: "integration" }, tasks: [{ id: "1.1", completed: true, evidence: { kind: "integrated", attemptId: "attempt", workerCommit, integrationCommit: commit } }],
    review: { commit, findings: [] }, verification: checks.map(command => ({ command, exitCode: 0, evidence: "Owner verification" })) };
  c.importSubmission({ bytes: JSON.stringify(receipt), expectedHead: head() });
  const storeClone = join(f.dir, "store-clone"), codeClone = join(f.dir, "code-clone");
  git(f.dir, "clone", "--quiet", "--config", "core.autocrlf=true", f.storeRoot, storeClone); git(f.dir, "clone", "--quiet", f.code, codeClone);
  assert.match(readFileSync(join(storeClone, "components/api/openspec/changes/demo/tasks.md"), "utf8"), /\r\n/);
  for (const [root, identity] of [[storeClone, "contracts"], [codeClone, "api"]]) {
    git(root, "config", "openspec-runner.repository", identity); git(root, "config", "user.name", "Independent coordinator"); git(root, "config", "user.email", "independent@example.test");
  }
  const independent = new Coordination({ root: storeClone, featureId: "product", repositories: { contracts: storeClone, api: codeClone }, execute: f.input().execute });
  const independentPreview = independent.acceptancePreview({ submissionId: "receipt" });
  independent.accept({ id: "independent-accept", operationId: "independent-accept", submissionId: "receipt", token: independentPreview.token, expectedHead: independentPreview.head });
  assert.equal(independent.status().components.api.acceptedCommit, commit);
  assert.equal(existsSync(join(codeClone, ".git", "openspec-runner")), false);
  f.write("components/api/openspec/changes/demo/tasks.md", "- [ ] 1.1 Changed approved requirement\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Change component requirement");
  assert.throws(() => c.acceptancePreview({ submissionId: "receipt" }), /drift/i);
  git(f.storeRoot, "revert", "--no-edit", "HEAD");
  const preview = c.acceptancePreview({ submissionId: "receipt" });
  assert.throws(() => c.accept({ id: "stale", operationId: "stale", submissionId: "receipt", token: preview.token, expectedHead: assignment.base }), /head/i);
  process.env.STORE_ACCEPT_FAIL = "1";
  try { assert.throws(() => c.accept({ id: "failed", operationId: "failed", submissionId: "receipt", token: preview.token, expectedHead: head() }), /command failed/i); }
  finally { delete process.env.STORE_ACCEPT_FAIL; }
  assert.doesNotMatch(git(f.storeRoot, "show", "HEAD:components/api/openspec/changes/demo/tasks.md"), /\[x\]/);
  const accept = { id: "accepted", operationId: "accepted", submissionId: "receipt", token: preview.token, expectedHead: head() };
  const writeRecord = c.store.writeRecord.bind(c.store);
  c.store.writeRecord = input => { const result = writeRecord(input); if (input.record.type === "accepted") throw new Error("Interrupted after atomic acceptance commit"); return result; };
  try { assert.throws(() => c.accept(accept), /Interrupted after atomic/); }
  finally { c.store.writeRecord = writeRecord; }
  assert.match(git(f.storeRoot, "show", "HEAD:components/api/openspec/changes/demo/tasks.md"), /\[x\]/);
  assert.deepEqual(git(f.storeRoot, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort(),
    ["components/api/openspec/changes/demo/tasks.md", "runner/features/product/events/accepted.json"]);
  assert.equal(c.status().components.api.acceptedCommit, commit);
  c.accept(accept); const acceptedHead = head(); c.accept(accept); assert.equal(head(), acceptedHead);
  const combined = c.reviewPreview({ stage: "combined" });
  c.recordReview({ stage: "combined", id: "combined", operationId: "combined", expectedHead: head(), token: combined.token,
    review: { tuple: combined.tuple, token: combined.token, reviewedBy: "user", summary: "Combined code verified", findings: [] } });
  git(f.code, "checkout", "main"); git(f.code, "merge", "--ff-only", commit);
  const delivery = { componentId: "api", deliveryCommit: commit, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "user" };
  c.recordMerge({ ...delivery, id: "merged", operationId: "merged", expectedHead: head(), token: c.mergePreview(delivery).token });
  assert.equal(c.reviewPreview({ stage: "final" }).tuple.api, commit);
  assert.equal(existsSync(join(f.code, "openspec")), false);
  assert.equal(existsSync(join(f.code, ".openspec-runner")), false);
});
