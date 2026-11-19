import type { AssignmentRecord, SubmissionRecord } from "./coordination-state.js";
import { loadSourcePlan } from "./planning-source.js";
import { git, gitRaw } from "./system.js";

export function assertStoreCodeTree(root: string, commit: string) {
  const paths = gitRaw(root, "ls-tree", "-r", "--name-only", "-z", commit).split("\0").filter(Boolean);
  if (paths.some(path => /^(?:openspec|\.openspec-runner)(?:\/|$)/i.test(path))) throw new Error("Store code snapshot contains planning or runtime artifacts");
}

/** Verify code evidence independently of completion flags and local runtime journals. */
export function validateStoreSubmission(options: { root: string; assignment: AssignmentRecord; receipt: SubmissionRecord }) {
  const { root, assignment, receipt } = options;
  if (assignment.version !== 2 || receipt.version !== 2) throw new Error("Store submission requires version-2 authority");
  const plan = loadSourcePlan(assignment.planningSource);
  if (!receipt.result || receipt.planningRevision !== assignment.planningSource.revision || plan.fingerprint !== assignment.planFingerprint)
    throw new Error("Store submission planning identity differs");
  const scope = Object.keys(assignment.settings.tasks).sort();
  if (new Set(receipt.tasks.map(task => task.id)).size !== receipt.tasks.length || receipt.tasks.length !== plan.tasks.length ||
      JSON.stringify(scope) !== JSON.stringify(plan.tasks.map(task => task.id).sort())) throw new Error("Store task coverage differs from approved scope");
  git(root, "merge-base", "--is-ancestor", assignment.base, receipt.result.commit);
  const attempts = new Set<string>();
  for (const task of plan.tasks) {
    const submitted = receipt.tasks.find(entry => entry.id === task.id);
    if (!submitted?.completed) throw new Error("Store task coverage is incomplete");
    const evidence = submitted.evidence;
    if (task.completed) {
      if (evidence.kind !== "baseline" || evidence.base !== assignment.base) throw new Error("Approved baseline evidence differs");
      continue;
    }
    if (evidence.kind !== "integrated" || attempts.has(evidence.attemptId)) throw new Error("Task requires distinct integrated evidence, not baseline completion");
    attempts.add(evidence.attemptId);
    const parents = git(root, "show", "-s", "--format=%P", evidence.integrationCommit).split(" ");
    const message = git(root, "show", "-s", "--format=%B", evidence.integrationCommit);
    if (parents.length !== 2 || parents[1] !== evidence.workerCommit || !message.split(/\r?\n/).includes(`openspec-runner:${evidence.attemptId}`))
      throw new Error("Task integration marker or worker merge parent differs");
    git(root, "merge-base", "--is-ancestor", assignment.base, evidence.workerCommit);
    git(root, "merge-base", "--is-ancestor", evidence.integrationCommit, receipt.result.commit);
  }
  assertStoreCodeTree(root, receipt.result.commit);
  return plan;
}
