import { stableDigest, type CoordinationEvent, type AssignmentRecord, type CoordinationSnapshot, type CoordinationStatus, type ReviewFinding, type VerificationEvidence } from "./coordination-state.js";
import { attempt, clean, git, gitRaw, repository } from "./system.js";
import { resolve } from "node:path";
import { committedPlan, exactCheckout, removeExactCheckout, verificationCommand } from "./submission.js";
import { coordinationOperation } from "./coordination-operation.js";
import type { MutationIdentity } from "./coordination.js";
import type { CoordinationStore } from "./coordination-state.js";

export interface MergeInput {
  componentId: string;
  deliveryCommit: string;
  mergeStyle: "merge" | "squash" | "rebase";
  prUrl: string;
  attestedBy: string;
}
export interface DeliveredReview {
  commit: string;
  reviewedBy: string;
  summary: string;
  findings: ReviewFinding[];
}
export function pathState(options: { root: string; commit: string; path: string }) {
  // Modes matter as well as blob identity (regular files, executable files and symlinks).
  return gitRaw(options.root, "ls-tree", "-z", options.commit, "--", options.path) || null;
}
export function changedPaths(options: { root: string; base: string; commit: string }) {
  return gitRaw(options.root, "diff", "--no-renames", "--name-only", "-z", options.base, options.commit).split("\0").filter(Boolean).sort();
}
export function deliveryEvidence(options: { snapshot: CoordinationSnapshot; status: CoordinationStatus; input: MergeInput; root: string }) {
  const { snapshot, status, input, root } = options;
  const component = status.components[input.componentId];
  if (status.phase === "awaiting-approval" || !component?.acceptedCommit || component.dependencyStale || component.requiresReapproval) throw new Error("Current accepted snapshot required before merge evidence");
  if (!input.attestedBy?.trim()) throw new Error("Merged PR requires explicit operator attestation");
  if (!/^https?:\/\//.test(input.prUrl) || !["merge", "squash", "rebase"].includes(input.mergeStyle)) throw new Error("Merged PR URL and merge style are required");
  const deliveryBranch = snapshot.manifest.components[input.componentId].deliveryBranch;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.deliveryCommit) || attempt(() => git(root, "rev-parse", `${input.deliveryCommit}^{commit}`)) !== input.deliveryCommit) throw new Error("Exact delivery commit unavailable; retrieve explicitly");
  const branchHead = attempt(() => git(root, "rev-parse", `refs/heads/${deliveryBranch}^{commit}`));
  if (!branchHead || attempt(() => git(root, "merge-base", "--is-ancestor", input.deliveryCommit, branchHead)) === undefined) throw new Error("Delivery commit must be reachable from declared delivery branch");
  if (input.mergeStyle === "merge" && attempt(() => git(root, "merge-base", "--is-ancestor", component.acceptedCommit!, input.deliveryCommit)) === undefined) throw new Error("Normal merge requires accepted commit ancestor evidence");
  const accepted = snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "accepted" }> => r.kind === "event" && r.type === "accepted" && r.componentId === input.componentId && r.commit === component.acceptedCommit).sort((a, b) => b.sequence - a.sequence)[0];
  const assignment = snapshot.records.find((r): r is AssignmentRecord => r.kind === "assignment" && r.id === accepted?.assignmentId);
  if (!accepted || !assignment || assignment.approvalId !== status.approvalId) throw new Error("Accepted component approval is stale");
  const paths = changedPaths({ root, base: assignment.base, commit: component.acceptedCommit });
  const mismatches = paths.filter(path => pathState({ root, path, commit: component.acceptedCommit! }) !== pathState({ root, path, commit: input.deliveryCommit }));
  const payload = { componentId: input.componentId, deliveryCommit: input.deliveryCommit, mergeStyle: input.mergeStyle, prUrl: input.prUrl, attestedBy: input.attestedBy, deliveryBranch, commit: component.acceptedCommit, submissionId: accepted.submissionId };
  return { head: snapshot.head, token: stableDigest({ value: { payload, approvalId: assignment.approvalId, acceptanceId: accepted.id, paths, mismatches } }), payload, assignment, acceptanceId: accepted.id, changedPaths: paths, mismatches };
}
export type MergePreview = ReturnType<typeof deliveryEvidence>;
export function deliveredPlan(options: { root: string; preview: MergePreview }) {
  const { assignment } = options.preview;
  // Rewritten history is allowed here; ordinary submission acceptance still checks ancestry.
  const plan = committedPlan({ root: options.root, change: assignment.change, commit: options.preview.payload.deliveryCommit });
  if (plan.fingerprint !== assignment.planFingerprint || !plan.tasks.every(task => task.completed) ||
      stableDigest({ value: plan.tasks.map(task => task.id).sort() }) !== stableDigest({ value: Object.keys(assignment.settings.tasks).sort() }) ||
      stableDigest({ value: plan.verification }) !== stableDigest({ value: assignment.settings.verifyIntegration }) ||
      stableDigest({ value: plan.setup }) !== stableDigest({ value: assignment.settings.setup ?? [] })) throw new Error("Delivered snapshot planning/completion/checks drifted; renew approval");
}
export function acceptDeliveredSnapshot(options: {
  store: CoordinationStore; root: string; input: MutationIdentity & MergeInput & { token: string; review: DeliveredReview }; preview: () => MergePreview;
}) {
  const { store, input, root } = options;
  type Data = { preview: MergePreview; stage: "reserved" | "checking" | "verified" | "failed"; index: number; running?: number; evidence: VerificationEvidence[]; reason?: string };
  return coordinationOperation<Data, ReturnType<CoordinationStore["writeRecord"]>>({ store, input, action: "delivery-acceptance", initialize: () => {
    const preview = options.preview();
    if (input.token !== preview.token) throw new Error("Delivered acceptance token is stale");
    if (input.review.commit !== input.deliveryCommit || !input.review.reviewedBy?.trim() || !input.review.summary?.trim() || input.review.findings.some(f => ["correctness", "security", "spec", "verification"].includes(f.category))) throw new Error("Fresh exact delivered snapshot review without blocking findings is required");
    deliveredPlan({ root, preview });
    return { preview, stage: "reserved", index: 0, evidence: [] };
  }, execute: ({ journal, save, write }) => {
    const data = journal.data;
    const commands = [...(data.preview.assignment.settings.setup ?? []), ...data.preview.assignment.settings.verifyIntegration];
    const assertVerified = () => {
      const assignment = store.readRecord({ kind: "assignment", id: data.preview.assignment.id });
      if (data.stage !== "verified" || data.index !== commands.length || !assignment || stableDigest({ value: assignment }) !== stableDigest({ value: data.preview.assignment }) ||
          data.evidence.some(check => check.exitCode !== 0 || !check.evidence?.trim()) || stableDigest({ value: data.evidence.map(check => check.command) }) !== stableDigest({ value: data.preview.assignment.settings.verifyIntegration })) throw new Error("Delivered coordinator verification journal is incomplete or failed");
    };
    const result = store.readRecord({ kind: "event", id: input.id });
    if (result) { assertVerified(); return write({ id: input.id, operationId: input.operationId, payload: result }); }
    if (data.running !== undefined || data.stage === "failed") throw new Error(data.reason ?? "Interrupted delivered snapshot check has ambiguous side effects; inspect and use a new operation");
    if (options.preview().token !== data.preview.token) throw new Error("Delivered acceptance inputs drifted since durable intent");
    const path = resolve(repository(root).stateDir, "delivery-checkouts", input.operationId);
    if (data.stage !== "verified") {
      exactCheckout({ root, commit: input.deliveryCommit, path });
      data.stage = "checking"; save();
      for (let index = data.index; index < commands.length; index++) {
        data.running = index; save();
        const evidence = verificationCommand({ root: path, commit: input.deliveryCommit, command: commands[index] });
        evidence.evidence = evidence.evidence.replaceAll(path, `component:${input.componentId}`);
        if (index >= (data.preview.assignment.settings.setup ?? []).length) data.evidence.push(evidence);
        data.index = index + 1; delete data.running;
        if (evidence.exitCode !== 0 || !clean(path)) { data.stage = "failed"; data.reason = "Required delivered snapshot check failed"; save(); throw new Error(data.reason); }
        save();
      }
      data.stage = "verified"; save();
    }
    if (options.preview().token !== data.preview.token) throw new Error("Delivered acceptance inputs drifted during checks");
    assertVerified();
    removeExactCheckout({ root, path });
    return write({ id: input.id, operationId: input.operationId, payload: { type: "delivery-accepted", componentId: input.componentId, acceptanceId: data.preview.acceptanceId, deliveryCommit: input.deliveryCommit, snapshotToken: data.preview.token, reviewedBy: input.review.reviewedBy, summary: input.review.summary, findings: input.review.findings, verification: data.evidence } });
  } });
}
