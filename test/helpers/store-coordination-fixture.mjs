import { mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coordination } from "../../dist/coordination.js";
import { stableDigest } from "../../dist/coordination-state.js";
import { storePlanningFixture, git } from "./store-planning-fixture.mjs";

/** Coordinator-only fixture; portable receipts still carry real code merge evidence. */
export function deliveredStoreFixture(t, ids = ["api", "web", "worker"]) {
  const f = storePlanningFixture(t), roots = {}, components = {};
  const head = () => git(f.storeRoot, "rev-parse", "HEAD");
  for (const [index, id] of ids.entries()) {
    const root = index === 0 ? f.code : join(f.dir, id);
    if (index) {
      mkdirSync(root); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Code owner");
      git(root, "config", "user.email", "code@example.test"); git(root, "commit", "--allow-empty", "-m", "Code base");
    }
    git(root, "config", "openspec-runner.repository", id); roots[id] = root;
    if (!["api", "web"].includes(id)) cpSync(join(f.storeRoot, "components/api"), join(f.storeRoot, "components", id), { recursive: true });
    f.write(`components/${id}/openspec/runner.yaml`, JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: id } } }));
    const role = { harness: "codex", model: id, effort: "low" };
    components[id] = { repository: id, change: "demo", deliveryBranch: "main", dependencies: [], planning: { repository: "contracts", openspecRoot: `components/${id}/openspec` },
      settings: { implementation: role, tasks: {}, review: role, repair: role, maxFixRounds: 2, setup: [], verifyIntegration: [] } };
  }
  f.write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Deliver all components\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Shared feature");
  const contract = { repository: "contracts", context: { implementationRoot: f.code, planningRoot: f.storeRoot,
    changeRoot: join(f.storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] } };
  const c = new Coordination({ root: f.storeRoot, featureId: "product", repositories: { contracts: f.storeRoot, ...roots }, execute: f.input().execute });
  const manifest = { version: 2, featureId: "product", storeId: "team", sharedChange: "shared", coordinationBranch: "main", components,
    taskMapping: { "1.1": ids.map(componentId => ({ type: "merged", componentId })) }, verification: [], completion: { requireAllMerged: true } };
  c.init({ contract, manifest, expectedHead: head(), operationId: "init" });
  c.approve({ contract, id: "approval", operationId: "approval", expectedHead: head(), token: c.approvalPreview({ contract }).token, approvedBy: "user" });
  const approved = c.snapshot().records.find(record => record.kind === "approval");
  const write = record => c.store.writeRecord({ record: { version: 2, featureId: "product", createdAt: new Date().toISOString(), ...record }, expectedHead: head() });
  const event = record => write({ kind: "event", sequence: Math.max(0, ...c.snapshot().records.filter(record => record.kind === "event").map(record => record.sequence)) + 1, ...record });
  const commits = {};
  for (const id of ids) {
    const assignment = { version: 2, kind: "assignment", id: `assignment-${id}`, operationId: `assignment-${id}`, componentId: id,
      approvalId: approved.id, owner: "owner", ...approved.components[id], contract: approved.contract, dependencies: [] };
    write(assignment);
    const root = roots[id];
    git(root, "checkout", "-b", "worker"); writeFileSync(join(root, "result.txt"), `${id}\n`);
    git(root, "add", "."); git(root, "commit", "-m", "Implement");
    const workerCommit = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-b", "integration", assignment.base);
    git(root, "merge", "--no-ff", "worker", "-m", `Integrate\n\nopenspec-runner:attempt-${id}`);
    const commit = commits[id] = git(root, "rev-parse", "HEAD");
    const receipt = { version: 2, kind: "submission", featureId: "product", id: `receipt-${id}`, operationId: `receipt-${id}`, createdAt: new Date().toISOString(),
      assignmentId: assignment.id, owner: assignment.owner, repository: id, change: "demo", outcome: "completed", base: assignment.base, planFingerprint: assignment.planFingerprint,
      planningRevision: assignment.planningSource.revision, contractFingerprint: assignment.contract.fingerprint, result: { commit, branch: "integration" },
      tasks: [{ id: "1.1", completed: true, evidence: { kind: "integrated", attemptId: `attempt-${id}`, workerCommit, integrationCommit: commit } }], review: { commit, findings: [] }, verification: [] };
    c.importSubmission({ bytes: JSON.stringify(receipt), expectedHead: head() });
    event({ id: `accept-${id}`, operationId: `accept-${id}`, type: "accepted", componentId: id, assignmentId: assignment.id, submissionId: receipt.id, commit, verification: [] });
    git(root, "checkout", "main"); git(root, "merge", "--ff-only", commit);
    event({ id: `merge-${id}`, operationId: `merge-${id}`, type: "merged", componentId: id, submissionId: receipt.id, commit,
      deliveryCommit: commit, deliveryBranch: "main", mergeStyle: "merge", prUrl: `https://example.test/pr/${id}`, attestedBy: "user" });
  }
  const final = c.reviewPreview({ stage: "final" });
  event({ id: "final", operationId: "final", type: "reviewed", stage: "final", tuple: final.tuple, approvalId: final.approvalId,
    snapshotToken: final.token, reviewedBy: "user", summary: "Exact fixture tuple verified", findings: [], verification: [] });
  const token = stableDigest({ value: { tuple: final.tuple, reviewEventId: "final", approvalId: final.approvalId, reviewToken: final.token } });
  event({ id: "completed", operationId: "completed", type: "completed", tuple: final.tuple, reviewEventId: "final", consent: { token, approvedBy: "user" } });
  return { ...f, c, roots, commits, head };
}
