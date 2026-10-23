import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { atomic, json } from "./system.js";
import type { HarnessSettings } from "./harnesses/types.js";
import type { TaskAttempt } from "./runner.js";
import { loadPlan, type Plan } from "./plan.js";
import { decodeRecord, stableDigest, type AssignmentRecord } from "./coordination-state.js";
import { componentBindingPath, readComponentBinding, type ComponentBinding, type ComponentResources } from "./component-state.js";

export type FeaturePhase = "planning" | "awaiting-plan-approval" | "implementing" |
  "reviewing" | "fixing" | "awaiting-final-approval" | "archiving" | "completed";
export type FindingCategory = "correctness" | "security" | "spec" | "verification" | "style" | "improvement";
export interface Finding {
  id: string;
  category: FindingCategory;
  location: string;
  impact: string;
  correction: string;
}
export interface FeatureReport {
  attempt: string;
  session: string;
  outcome: "completed" | "blocked" | "failed";
  head: string;
  fingerprint: string;
  summary: string;
  verification: string[];
  findings?: Finding[];
  commit?: string;
}
// Feature jobs share supervision/ownership evidence, but are not checkbox tasks.
export interface FeatureJob extends Omit<TaskAttempt, "task" | "description" | "report"> {
  role: "review" | "repair";
  approvalToken: string;
  report?: FeatureReport;
  findings: Finding[];
  round: number;
}
export interface FeatureApproval {
  token: string;
  fingerprint: string;
  base: string;
  implementation: HarnessSettings;
  tasks: Record<string, HarnessSettings>;
  review: HarnessSettings;
  repair: HarnessSettings;
  maxFixRounds: number;
  verifyIntegration: string[][];
  setup?: string[][];
  at: string;
}
export interface FeatureState {
  version: 1;
  change: string;
  planningRoot: string;
  phase: FeaturePhase;
  jobs: FeatureJob[];
  fixRounds: number;
  approval?: FeatureApproval;
  approvalHistory: FeatureApproval[];
  invalidated?: string;
  finalApproval?: { token: string; head: string; review: string; at: string };
  error?: string;
  transaction?: { attempt: string; before: string; marker: string; phase: "merging" | "checking" | "committing" };
  archive?: {
    before: string;
    marker: string;
    phase: "started" | "produced" | "committing" | "committed";
    directories: string[];
    path?: string;
    tree?: string;
    commit?: string;
  };
  completedAt?: string;
  delegated?: DelegatedBinding;
}
export interface DelegatedBinding {
  featureId: string;
  assignmentId: string;
  owner: string;
  historyRevision: string;
  assignmentDigest: string;
  contractFingerprint: string;
  contextPaths: string[];
  bindingPath: string;
  resources: ComponentResources;
}
export function delegationForBinding(options: { stateDir: string; binding: ComponentBinding }): DelegatedBinding {
  const { binding } = options, assignment = binding.assignment;
  return { featureId: assignment.featureId, assignmentId: assignment.id, owner: assignment.owner,
    historyRevision: binding.historyRevision, assignmentDigest: stableDigest({ value: assignment }), contractFingerprint: assignment.contract.fingerprint,
    contextPaths: binding.contextPaths, bindingPath: componentBindingPath({ stateDir: options.stateDir, change: assignment.change }), resources: binding.resources };
}
export function pinnedPrompt(stateDir: string, change: string): string {
  const runtime = readComponentBinding({ stateDir, change }), delegated = readFeature(stateDir, change)?.delegated;
  if (runtime && (runtime.phase !== "ready" || !delegated)) throw new Error("Delegated component binding requires completed import and matching feature state");
  if (!delegated) return "";
  validateDelegatedBinding(delegated);
  return `\nDelegated assignment: ${delegated.featureId}/${delegated.assignmentId}. Read only the pinned Store context at:\n${delegated.contextPaths.join("\n")}\nThese pinned paths are the authoritative shared contracts and linked specifications. Never re-fetch or substitute a registered Store checkout, including through openspec instructions or context commands. OpenSpec commands may inspect repository-local component artifacts only. Do not approve, archive, or complete this shared feature.`;
}
export function validateDelegatedBinding(binding: DelegatedBinding) {
  const stateDir = dirname(dirname(binding.bindingPath)), change = binding.bindingPath.split(/[\\/]/).at(-1)!.replace(/\.json$/, "");
  const runtime = readComponentBinding({ stateDir, change });
  if (!runtime || stableDigest({ value: binding }) !== stableDigest({ value: delegationForBinding({ stateDir, binding: runtime }) }))
    throw new Error("Delegated assignment binding changed; inspect import reservation");
  const assignment = runtime.assignment;
  const contexts = [assignment.contract, ...(assignment.contract.references ?? [])];
  if (contexts.length !== binding.contextPaths.length) throw new Error("Pinned context inventory mismatch");
  contexts.forEach((context, index) => {
    const root = binding.contextPaths[index];
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || (lstatSync(root).mode & 0o222)) throw new Error("Pinned context directory is unsafe or writable");
    for (const file of context.files) {
      let path = root;
      const parts = file.path.split("/");
      for (const [position, part] of parts.entries()) {
        path = resolve(path, part);
        if (lstatSync(path).isSymbolicLink()) throw new Error("Pinned context cannot contain symlinks");
        if (position < parts.length - 1 && (!lstatSync(path).isDirectory() || (lstatSync(path).mode & 0o222))) throw new Error("Pinned context directory is unsafe or writable");
      }
      if (!lstatSync(path).isFile() || (lstatSync(path).mode & 0o222) || readFileSync(path, "utf8") !== file.content)
        throw new Error("Pinned context changed or became writable; restore approved assignment context");
    }
  });
  return assignment;
}
export const featureActive = (a: FeatureJob) =>
  ["preparing", "manual", "launching", "running"].includes(a.phase) || !!(a.worker && !a.worker.exitedAt);
export const blocking = (f: Finding) => ["correctness", "security", "spec", "verification"].includes(f.category);
export function validateFeatureReport(report: unknown, role: "review" | "repair"): asserts report is FeatureReport {
  const r = report as FeatureReport;
  const nonempty = (v: unknown) => typeof v === "string" && !!v.trim();
  if (!r || !["completed", "failed", "blocked"].includes(r.outcome) ||
      ![r.attempt, r.session, r.head, r.fingerprint, r.summary].every(nonempty) ||
      !Array.isArray(r.verification) || !r.verification.length || !r.verification.every(nonempty))
    throw new Error("Feature report requires identity, outcome, summary and verification evidence");
  if (r.outcome !== "completed") return;
  if (role === "repair") {
    if (!r.commit || !/^[a-f0-9]{40,64}$/.test(r.commit)) throw new Error("Repair requires a full commit SHA");
  } else if (!Array.isArray(r.findings) || r.findings.some(f => !f ||
      !["correctness", "security", "spec", "verification", "style", "improvement"].includes(f.category) ||
      ![f.id, f.location, f.impact, f.correction].every(nonempty)) ||
      new Set(r.findings.map(f => f.id)).size !== r.findings.length)
    throw new Error("Review requires unique findings with category, location, impact and correction");
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function featurePath(stateDir: string, change: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change)) throw new Error("Invalid change name");
  return resolve(stateDir, "features", `${change}.json`);
}
export function readFeature(stateDir: string, change: string): FeatureState | undefined {
  const path = featurePath(stateDir, change);
  const runtime = readComponentBinding({ stateDir, change });
  if (!existsSync(path)) {
    if (runtime?.phase === "ready") throw new Error("Delegated component binding is missing its feature state");
    return undefined;
  }
  const s = json<FeatureState>(path);
  if (s.version !== 1 || s.change !== change || !Array.isArray(s.jobs) ||
      !Array.isArray(s.approvalHistory) || !Number.isInteger(s.fixRounds) || s.fixRounds < 0 ||
      typeof s.planningRoot !== "string" || !["planning", "awaiting-plan-approval", "implementing", "reviewing",
        "fixing", "awaiting-final-approval", "archiving", "completed"].includes(s.phase))
    throw new Error("Invalid or unsupported feature state");
  if ((runtime && (!s.delegated || stableDigest({ value: s.delegated }) !== stableDigest({ value: delegationForBinding({ stateDir, binding: runtime }) }))) || (!runtime && s.delegated))
    throw new Error("Feature delegation is missing or mismatched with independent component binding");
  return s;
}
export function saveFeature(stateDir: string, s: FeatureState) {
  atomic(featurePath(stateDir, s.change), s);
}
export function activeFeatureJobs(stateDir: string) {
  const dir = resolve(stateDir, "features");
  return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".json"))
    .flatMap(n => readFeature(stateDir, n.slice(0, -5))!.jobs.filter(featureActive)) : [];
}
export function approvedFeature(stateDir: string, plan: Plan) {
  const s = readFeature(stateDir, plan.change);
  const runtime = readComponentBinding({ stateDir, change: plan.change });
  if (runtime && (runtime.phase !== "ready" || !s)) throw new Error("Delegated component binding requires completed import and matching feature state");
  if (!s) return undefined;
  if (s.delegated) {
    const assignment = validateDelegatedBinding(s.delegated);
    const expected = { token: stableDigest({ value: assignment }), fingerprint: assignment.planFingerprint, base: assignment.base, ...assignment.settings, at: assignment.createdAt };
    if (!s.approval || stableDigest({ value: s.approval }) !== stableDigest({ value: expected }))
      throw new Error("Delegated approval settings differ from imported assignment binding");
  }
  if (!s.approval || s.invalidated || s.approval.fingerprint !== plan.fingerprint ||
      loadPlan(s.planningRoot, plan.change).fingerprint !== s.approval.fingerprint)
    throw new Error("Managed feature requires approval of the current plan; reconcile changed artifacts and run feature approve");
  return s;
}
export function implementationGate(stateDir: string, plan: Plan) {
  const s = approvedFeature(stateDir, plan);
  if (s && (s.phase !== "implementing" || s.jobs.some(featureActive) || s.transaction))
    throw new Error(`Feature is ${s.phase}; implementation is not permitted`);
  return s;
}
// Ignore provenance labels, but compare every setting that changes execution.
export function settingsIdentity(s: HarnessSettings) {
  return digest({ harness: s.harness ?? "codex", model: s.model,
    effort: s.effort ?? s.reasoningEffort ?? null, options: s.options ?? {} });
}
export function invalidateFeature(stateDir: string, change: string, reason: string) {
  const s = readFeature(stateDir, change);
  if (!s) return;
  if (s.jobs.some(featureActive) || s.transaction || s.archive || s.phase === "completed")
    throw new Error("Finish feature jobs/recovery before reconciling; completed features cannot be reopened");
  s.invalidated = reason;
  s.phase = "awaiting-plan-approval";
  delete s.finalApproval;
  saveFeature(stateDir, s);
}
