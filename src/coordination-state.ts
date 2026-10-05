import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import type { HarnessSettings } from "./harnesses/types.js";
import { committedBlob, contextFingerprint, safeContextPath, type PinnedContext, type ContextFile } from "./openspec-context.js";
import { tasksFrom } from "./plan.js";
import { attempt, git, gitRaw, repository } from "./system.js";
import { affectedDependents, dependencyBlockers } from "./coordination-dependencies.js";

export interface ComponentSettings {
  implementation: HarnessSettings;
  tasks: Record<string, HarnessSettings>;
  review: HarnessSettings;
  repair: HarnessSettings;
  maxFixRounds: number;
  verifyIntegration: string[][];
  setup?: string[][];
}
export interface ComponentDependency { componentId: string; milestone: "accepted" | "merged" }
export interface ComponentDefinition {
  repository: string;
  change: string;
  deliveryBranch: string;
  settings: ComponentSettings;
  dependencies: ComponentDependency[];
}
export type SharedTaskMilestone = { type: "merged"; componentId: string } | { type: "final-verification" };
export interface VerificationCommand { componentId: string; command: string[] }
export interface FeatureManifest {
  version: 1;
  featureId: string;
  storeId: string;
  sharedChange: string;
  coordinationBranch: string;
  components: Record<string, ComponentDefinition>;
  taskMapping: Record<string, SharedTaskMilestone[]>;
  verification: VerificationCommand[];
  completion: { requireAllMerged: true };
}
export interface RecordIdentity {
  version: 1;
  id: string;
  featureId: string;
  operationId: string;
  createdAt: string;
}
export interface ComponentSnapshot {
  repository: string;
  change: string;
  base: string;
  planFingerprint: string;
  settings: ComponentSettings;
}
export interface ApprovalRecord extends RecordIdentity {
  kind: "approval";
  manifestFingerprint: string;
  contract: PinnedContext;
  components: Record<string, ComponentSnapshot>;
  verification: VerificationCommand[];
  consent: { token: string; approvedBy: string };
}
export interface AssignmentRecord extends RecordIdentity, ComponentSnapshot {
  kind: "assignment";
  approvalId: string;
  componentId: string;
  owner: string;
  contract: PinnedContext;
  dependencies: (ComponentDependency & { commit: string })[];
}
export interface ReviewFinding {
  id: string;
  category: "correctness" | "security" | "spec" | "verification" | "style" | "improvement";
  location: string;
  impact: string;
  correction: string;
  componentId?: string;
  owner?: string;
}
export interface VerificationEvidence { command: string[]; exitCode: number; evidence: string }
export interface SubmissionRecord extends RecordIdentity {
  kind: "submission";
  assignmentId: string;
  owner: string;
  repository: string;
  change: string;
  outcome: "completed" | "blocked" | "failed";
  reason?: string;
  base: string;
  planFingerprint: string;
  contractFingerprint: string;
  result?: { branch: string; commit: string };
  tasks: { id: string; completed: boolean }[];
  review?: { commit: string; findings: ReviewFinding[] };
  verification: VerificationEvidence[];
}
export interface ArchiveBases { components: CommitTuple; store?: string }
export interface ArchiveScope { componentIds: string[]; includeStore: boolean; storeDeliveryBranch?: string }
export type CommitTuple = Record<string, string>;
interface EventIdentity extends RecordIdentity { kind: "event"; sequence: number }
export type CoordinationEvent = EventIdentity & (
  { type: "revoked"; componentId: string; assignmentId: string; reason: string } |
  { type: "accepted"; componentId: string; assignmentId: string; submissionId: string; commit: string; verification?: VerificationEvidence[] } |
  { type: "rejected"; componentId: string; assignmentId: string; submissionId: string; reason: string } |
  { type: "invalidated"; componentId: string; reason: string } |
  { type: "merged"; componentId: string; submissionId: string; commit: string; deliveryBranch: string; deliveryCommit: string; mergeStyle: "merge" | "squash" | "rebase"; prUrl: string; attestedBy: string } |
  { type: "reviewed"; stage: "combined" | "final"; tuple: CommitTuple; verification: VerificationEvidence[]; findings: ReviewFinding[]; approvalId?: string; snapshotToken?: string; reviewedBy?: string; summary?: string } |
  { type: "delivery-accepted"; componentId: string; acceptanceId: string; deliveryCommit: string; snapshotToken: string; reviewedBy: string; summary: string; findings: ReviewFinding[]; verification: VerificationEvidence[] } |
  { type: "archive-approved"; snapshotToken: string; completionEventId: string; scope: ArchiveScope; bases?: ArchiveBases; consent: { token: string; approvedBy: string } } |
  { type: "completed"; tuple: CommitTuple; reviewEventId: string; consent: { token: string; approvedBy: string }; archiveScope?: string[]; archive?: ArchiveScope; archiveToken?: string; archiveBases?: ArchiveBases } |
  { type: "archive-prepared" | "archive-delivered"; componentId?: string; commit: string; branch: string; paths: string[]; preparedBranch?: string; preparedEventId?: string; completionEventId?: string; snapshotToken?: string; base?: string; evidence?: string } |
  { type: "operation-started" | "operation-finished"; targetOperationId: string; action: string; snapshotToken: string }
);
export type CoordinationRecord = ApprovalRecord | AssignmentRecord | SubmissionRecord | CoordinationEvent;
export type RecordKind = CoordinationRecord["kind"];

function fail(message: string): never { throw new Error(`Invalid coordination contract: ${message}`); }
function obj(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be an object`);
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} unknown field ${key}`);
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(`${label} must be nonempty text`);
}
export function validateId(options: { value: unknown; label?: string }): asserts options is { value: string; label?: string } {
  if (typeof options.value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.value) || ["__proto__", "prototype", "constructor"].includes(options.value)) fail(`${options.label ?? "record"} ID is unsafe`);
}
function id(value: unknown, label: string) { validateId({ value, label }); }
function sha(value: unknown, label: string) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail(`${label} requires a full commit SHA`);
}
function fingerprint(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} requires a SHA-256 fingerprint`);
}
function branch(value: unknown, label: string) {
  text(value, label);
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || value.includes("@{") || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(value) || value.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".lock")) || value === "@") fail(`${label} is an unsafe branch`);
}
function repo(value: unknown, label: string) {
  text(value, label);
  if (isAbsolute(value) || value.startsWith("file:") || value.startsWith(".") || /^[a-zA-Z]:[\\/]/.test(value)) fail(`${label} requires a portable repository identity, not a checkout path`);
}
function array(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}
function integer(value: unknown, label: string, min = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail(`${label} must be an integer >= ${min}`);
}
function commands(value: unknown, label: string) {
  for (const command of array(value, label)) {
    if (!Array.isArray(command) || !command.length) fail(`${label} command requires arguments`);
    for (const argument of command) text(argument, `${label} argument`);
  }
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  const object = obj(value, "digest value");
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]));
}
export function stableDigest(options: { value: unknown }): string {
  return createHash("sha256").update(JSON.stringify(canonical(options.value))).digest("hex");
}
function harness(value: unknown, label: string) {
  const settings = obj(value, label);
  keys(settings, ["harness", "model", "requestedModel", "effort", "reasoningEffort", "options", "observedModel", "sources"], label);
  text(settings.model, `${label}.model`);
  for (const key of ["harness", "requestedModel", "effort", "reasoningEffort", "observedModel"]) if (settings[key] !== undefined) text(settings[key], `${label}.${key}`);
  if (settings.harness !== undefined && !["codex", "claude"].includes(settings.harness)) fail(`${label}.harness is unsupported`);
  if (settings.sources !== undefined) for (const source of array(settings.sources, `${label}.sources`)) text(source, "setting source");
  if (settings.options !== undefined) {
    obj(settings.options, `${label}.options`); canonical(settings.options);
    const portable = (value: any) => {
      if (Array.isArray(value)) return value.forEach(portable);
      if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        if (["cwd", "worktree", "worktreePath", "session", "sessionId", "pid", "planningRoot", "stateDir"].includes(key)) fail(`${label}.options runtime field ${key} is not portable`);
        portable(child);
      }
    };
    portable(settings.options);
  }
}
function execution(value: unknown) {
  const settings = obj(value, "settings");
  keys(settings, ["implementation", "tasks", "review", "repair", "maxFixRounds", "verifyIntegration", "setup"], "settings");
  for (const role of ["implementation", "review", "repair"]) harness(settings[role], role);
  for (const [task, setting] of Object.entries(obj(settings.tasks, "task settings"))) { text(task, "task ID"); harness(setting, `task ${task}`); }
  integer(settings.maxFixRounds, "maxFixRounds"); commands(settings.verifyIntegration, "verifyIntegration");
  if (settings.setup !== undefined) commands(settings.setup, "setup");
}
function dependency(value: unknown, withCommit = false) {
  const d = obj(value, "dependency"); keys(d, ["componentId", "milestone", ...(withCommit ? ["commit"] : [])], "dependency");
  id(d.componentId, "dependency component");
  if (!["accepted", "merged"].includes(d.milestone)) fail("dependency milestone must be accepted or merged");
  if (withCommit) sha(d.commit, "dependency commit");
}
function verificationCommands(value: unknown, components?: Record<string, unknown>) {
  for (const entry of array(value, "verification")) {
    const v = obj(entry, "verification command"); keys(v, ["componentId", "command"], "verification command");
    id(v.componentId, "verification component"); commands([v.command], "verification");
    if (components && !Object.hasOwn(components, v.componentId)) fail(`verification references unknown component ${v.componentId}`);
  }
}
function evidence(value: unknown) {
  for (const entry of array(value, "verification evidence")) {
    const v = obj(entry, "verification evidence"); keys(v, ["command", "exitCode", "evidence"], "verification evidence");
    commands([v.command], "verification"); integer(v.exitCode, "verification exitCode"); text(v.evidence, "verification evidence");
  }
}
function findings(value: unknown) {
  const seen = new Set<string>();
  for (const entry of array(value, "review findings")) {
    const f = obj(entry, "finding"); keys(f, ["id", "category", "location", "impact", "correction", "componentId", "owner"], "finding"); id(f.id, "finding");
    if (seen.has(f.id)) fail("duplicate finding ID"); seen.add(f.id);
    if (!["correctness", "security", "spec", "verification", "style", "improvement"].includes(f.category)) fail("invalid finding category");
    for (const key of ["location", "impact", "correction"]) text(f[key], `finding ${key}`);
    if (f.componentId !== undefined) id(f.componentId, "finding component");
    if (f.owner !== undefined) text(f.owner, "finding owner");
  }
}
export function decodePinnedContext(options: { value: unknown }): PinnedContext {
  const c = obj(options.value, "pinned context"); keys(c, ["version", "repository", "revision", "change", "storeId", "fingerprint", "files", "references", "selections"], "pinned context");
  if (c.version !== 1) fail("unsupported pinned context version");
  repo(c.repository, "context repository"); sha(c.revision, "context revision"); if (c.change !== undefined) id(c.change, "context change"); fingerprint(c.fingerprint, "context fingerprint");
  if (c.storeId !== undefined) id(c.storeId, "context Store");
  const seen = new Set<string>();
  if (!array(c.files, "context files").length) fail("pinned context requires files");
  for (const entry of c.files) {
    const f = obj(entry, "context file"); keys(f, ["path", "content"], "context file"); safeContextPath(f.path);
    if (f.path === "runner/features" || f.path.startsWith("runner/features/")) fail("coordination records are outside pinned context");
    if (seen.has(f.path)) fail("duplicate context path"); seen.add(f.path);
    if (typeof f.content !== "string") fail("context content must be text");
  }
  if (c.selections !== undefined) {
    const selections = array(c.selections, "context selections"), scope = new Set<string>();
    if (!selections.length) fail("context selections require approved roots");
    for (const path of selections) {
      safeContextPath(path);
      if (path === "runner/features" || path.startsWith("runner/features/")) fail("coordination records are outside selection scope");
      if (scope.has(path)) fail("duplicate context selection"); scope.add(path);
    }
    if (c.files.some((file: ContextFile) => !selections.some(path => file.path === path || file.path.startsWith(`${path}/`)))) fail("context file is outside approved selection scope");
  }
  if (c.references !== undefined) {
    const identities = new Set<string>();
    for (const reference of array(c.references, "context references")) {
      const pinned = decodePinnedContext({ value: reference });
      const identity = `${pinned.repository}/${pinned.change ?? "canonical"}`;
      if (identities.has(identity)) fail("duplicate pinned reference identity");
      identities.add(identity);
    }
  }
  if (contextFingerprint({ files: c.files, references: c.references, selections: c.selections }) !== c.fingerprint) fail("pinned context content fingerprint mismatch");
  return structuredClone(c) as PinnedContext;
}
export function decodeManifest(options: { value: unknown; sharedTasks?: { id: string; completed: boolean }[] }): FeatureManifest {
  const value = typeof options.value === "string" ? parse(options.value) : options.value;
  const m = obj(value, "manifest");
  keys(m, ["version", "featureId", "storeId", "sharedChange", "coordinationBranch", "components", "taskMapping", "verification", "completion"], "manifest");
  if (m.version !== 1) fail("unsupported manifest version");
  id(m.featureId, "feature"); id(m.storeId, "Store"); id(m.sharedChange, "shared change"); branch(m.coordinationBranch, "coordination branch");
  const components = obj(m.components, "components");
  if (!Object.keys(components).length) fail("manifest requires components");
  for (const [componentId, value] of Object.entries(components)) {
    id(componentId, "component"); const c = obj(value, "component"); keys(c, ["repository", "change", "deliveryBranch", "settings", "dependencies"], "component");
    repo(c.repository, "component repository"); id(c.change, "component change"); branch(c.deliveryBranch, "delivery branch"); execution(c.settings);
    const seen = new Set<string>();
    for (const d of array(c.dependencies, "dependencies")) {
      dependency(d);
      if (!Object.hasOwn(components, d.componentId)) fail(`dependency references unknown component ${d.componentId}`);
      if (seen.has(d.componentId)) fail("duplicate dependency component"); seen.add(d.componentId);
    }
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (componentId: string) => {
    if (visiting.has(componentId)) fail("component dependency cycle");
    if (visited.has(componentId)) return;
    visiting.add(componentId);
    for (const dependency of components[componentId].dependencies) visit(dependency.componentId);
    visiting.delete(componentId); visited.add(componentId);
  };
  for (const componentId of Object.keys(components)) visit(componentId);
  const mappings = obj(m.taskMapping, "taskMapping");
  for (const [taskId, value] of Object.entries(mappings)) {
    text(taskId, "shared task ID");
    if (!array(value, "task mapping").length) fail(`task mapping ${taskId} requires milestones`);
    for (const entry of value) {
      const milestone = obj(entry, "milestone");
      if (milestone.type === "merged") {
        keys(milestone, ["type", "componentId"], "milestone"); id(milestone.componentId, "milestone component");
        if (!Object.hasOwn(components, milestone.componentId)) fail(`mapping references unknown component ${milestone.componentId}`);
      } else if (milestone.type === "final-verification") keys(milestone, ["type"], "milestone");
      else fail("mapping milestone must be merged or final-verification");
    }
  }
  for (const task of options.sharedTasks ?? []) if (!task.completed && !Object.hasOwn(mappings, task.id)) fail(`missing mapping for unfinished shared task ${task.id}`);
  verificationCommands(m.verification, components);
  const completion = obj(m.completion, "completion"); keys(completion, ["requireAllMerged"], "completion");
  if (completion.requireAllMerged !== true) fail("completion requires every component merged");
  return structuredClone(m) as FeatureManifest;
}

const identityKeys = ["version", "id", "featureId", "operationId", "createdAt", "kind"];
function snapshot(c: Record<string, any>) {
  repo(c.repository, "repository"); id(c.change, "change"); sha(c.base, "base"); fingerprint(c.planFingerprint, "plan fingerprint"); execution(c.settings);
}
function consent(value: unknown) {
  const c = obj(value, "consent"); keys(c, ["token", "approvedBy"], "consent"); fingerprint(c.token, "consent token"); text(c.approvedBy, "consent approvedBy");
}
function tuple(value: unknown) {
  const t = obj(value, "commit tuple"); if (!Object.keys(t).length) fail("commit tuple requires components");
  for (const [componentId, commit] of Object.entries(t)) { id(componentId, "tuple component"); sha(commit, "tuple commit"); }
}
function archiveBases(value: unknown) {
  const bases = obj(value, "archive bases"); keys(bases, ["components", "store"], "archive bases");
  const components = obj(bases.components, "archive component bases");
  for (const [componentId, commit] of Object.entries(components)) { id(componentId, "archive component"); sha(commit, "archive base"); }
  if (!Object.keys(components).length && bases.store === undefined) fail("archive bases require targets");
  if (bases.store !== undefined) sha(bases.store, "Store archive base");
}
function archiveScope(value: unknown) {
  const scope = obj(value, "archive scope"); keys(scope, ["componentIds", "includeStore", "storeDeliveryBranch"], "archive scope");
  const ids = array(scope.componentIds, "archive component IDs"); for (const item of ids) id(item, "archive component");
  if (new Set(ids).size !== ids.length || typeof scope.includeStore !== "boolean" || (!ids.length && !scope.includeStore)) fail("archive scope requires unique explicit targets");
  if (scope.includeStore) branch(scope.storeDeliveryBranch, "Store canonical delivery branch");
  else if (scope.storeDeliveryBranch !== undefined) fail("Store branch requires Store archive target");
}
export function decodeRecord(options: { value: unknown }): CoordinationRecord {
  const value = typeof options.value === "string" ? JSON.parse(options.value) : options.value;
  const r = obj(value, "record");
  if (r.version !== 1) fail("unsupported record version");
  for (const key of ["id", "featureId", "operationId"]) id(r[key], key);
  text(r.createdAt, "createdAt"); if (!/^\d{4}-\d\d-\d\dT/.test(r.createdAt) || !Number.isFinite(Date.parse(r.createdAt))) fail("createdAt requires an ISO timestamp");
  if (r.kind === "approval") {
    keys(r, [...identityKeys, "manifestFingerprint", "contract", "components", "verification", "consent"], "approval");
    fingerprint(r.manifestFingerprint, "manifest fingerprint"); decodePinnedContext({ value: r.contract }); id(r.contract.change, "primary contract change"); consent(r.consent);
    const components = obj(r.components, "approval components"); if (!Object.keys(components).length) fail("approval requires components");
    for (const [componentId, value] of Object.entries(components)) {
      id(componentId, "component"); const c = obj(value, "component snapshot"); keys(c, ["repository", "change", "base", "planFingerprint", "settings"], "component snapshot"); snapshot(c);
    }
    verificationCommands(r.verification, components);
  } else if (r.kind === "assignment") {
    keys(r, [...identityKeys, "approvalId", "componentId", "owner", "repository", "change", "base", "planFingerprint", "contract", "settings", "dependencies"], "assignment");
    id(r.approvalId, "approval"); id(r.componentId, "component"); text(r.owner, "owner"); snapshot(r); decodePinnedContext({ value: r.contract }); id(r.contract.change, "primary contract change");
    for (const d of array(r.dependencies, "dependencies")) dependency(d, true);
  } else if (r.kind === "submission") {
    keys(r, [...identityKeys, "assignmentId", "owner", "repository", "change", "outcome", "reason", "base", "planFingerprint", "contractFingerprint", "result", "tasks", "review", "verification"], "submission");
    id(r.assignmentId, "assignment"); text(r.owner, "owner"); repo(r.repository, "repository"); id(r.change, "change"); sha(r.base, "base"); fingerprint(r.planFingerprint, "plan fingerprint"); fingerprint(r.contractFingerprint, "contract fingerprint");
    if (!["completed", "blocked", "failed"].includes(r.outcome)) fail("invalid submission outcome");
    if (r.outcome !== "completed") text(r.reason, "blocked/failed reason"); else if (!r.result || !r.review) fail("completed submission requires result and review");
    if (r.reason !== undefined) text(r.reason, "reason");
    if (r.result !== undefined) { const result = obj(r.result, "result"); keys(result, ["branch", "commit"], "result"); branch(result.branch, "result branch"); sha(result.commit, "result commit"); }
    const tasks = new Set<string>();
    for (const entry of array(r.tasks, "tasks")) {
      const task = obj(entry, "task"); keys(task, ["id", "completed"], "task"); text(task.id, "task ID");
      if (tasks.has(task.id)) fail("duplicate task ID"); tasks.add(task.id);
      if (typeof task.completed !== "boolean") fail("task completed must be boolean");
    }
    if (r.review !== undefined) { const review = obj(r.review, "review"); keys(review, ["commit", "findings"], "review"); sha(review.commit, "review commit"); findings(review.findings); }
    evidence(r.verification);
  } else if (r.kind === "event") {
    integer(r.sequence, "event sequence", 1);
    const common = [...identityKeys, "type", "sequence"];
    const component = () => id(r.componentId, "event component");
    if (["revoked", "rejected", "accepted"].includes(r.type)) {
      keys(r, [...common, "componentId", "assignmentId", ...(r.type === "revoked" ? [] : ["submissionId"]), ...(r.type === "accepted" ? ["commit", "verification"] : ["reason"])], "event");
      component(); id(r.assignmentId, "event assignment");
      if (r.type !== "revoked") id(r.submissionId, "event submission");
      if (r.type === "accepted") { sha(r.commit, "accepted commit"); if (r.verification !== undefined) evidence(r.verification); } else text(r.reason, "event reason");
    } else if (r.type === "invalidated") {
      keys(r, [...common, "componentId", "reason"], "event"); component(); text(r.reason, "invalidation reason");
    } else if (r.type === "merged") {
      keys(r, [...common, "componentId", "submissionId", "commit", "deliveryBranch", "deliveryCommit", "mergeStyle", "prUrl", "attestedBy"], "merge event");
      component(); id(r.submissionId, "merge submission"); sha(r.commit, "accepted commit"); sha(r.deliveryCommit, "delivery commit"); branch(r.deliveryBranch, "delivery branch");
      if (!["merge", "squash", "rebase"].includes(r.mergeStyle)) fail("invalid merge style");
      text(r.prUrl, "PR URL"); if (!/^https?:\/\//.test(r.prUrl)) fail("PR URL must use HTTP(S)"); text(r.attestedBy, "merge attestedBy");
    } else if (r.type === "reviewed") {
      keys(r, [...common, "stage", "tuple", "verification", "findings", "approvalId", "snapshotToken", "reviewedBy", "summary"], "review event");
      if (!["combined", "final"].includes(r.stage)) fail("invalid review stage"); tuple(r.tuple); evidence(r.verification); findings(r.findings);
      if ([r.approvalId, r.snapshotToken, r.reviewedBy, r.summary].some(value => value !== undefined)) {
        id(r.approvalId, "review approval"); fingerprint(r.snapshotToken, "review snapshot token"); text(r.reviewedBy, "reviewedBy"); text(r.summary, "review summary");
      }
    } else if (r.type === "completed") {
      keys(r, [...common, "tuple", "reviewEventId", "consent", "archiveScope", "archive", "archiveToken", "archiveBases"], "completion event"); tuple(r.tuple); id(r.reviewEventId, "review event"); consent(r.consent);
      if (r.archive !== undefined) { archiveScope(r.archive); fingerprint(r.archiveToken, "archive token"); }
      if (r.archiveBases !== undefined) archiveBases(r.archiveBases);
      if (r.archiveScope !== undefined) for (const path of array(r.archiveScope, "archiveScope")) safeContextPath(path);
    } else if (r.type === "delivery-accepted") {
      keys(r, [...common, "componentId", "acceptanceId", "deliveryCommit", "snapshotToken", "reviewedBy", "summary", "findings", "verification"], "delivery acceptance");
      component(); id(r.acceptanceId, "accepted event"); sha(r.deliveryCommit, "delivery commit"); fingerprint(r.snapshotToken, "delivery snapshot token");
      text(r.reviewedBy, "delivered reviewedBy"); text(r.summary, "delivered review summary"); findings(r.findings); evidence(r.verification);
    } else if (r.type === "archive-approved") {
      keys(r, [...common, "snapshotToken", "completionEventId", "scope", "bases", "consent"], "archive approval");
      fingerprint(r.snapshotToken, "archive snapshot token"); id(r.completionEventId, "completion event"); archiveScope(r.scope); consent(r.consent); if (r.bases !== undefined) archiveBases(r.bases);
    } else if (["archive-prepared", "archive-delivered"].includes(r.type)) {
      keys(r, [...common, "componentId", "commit", "branch", "paths", "preparedBranch", "preparedEventId", "completionEventId", "snapshotToken", "base", "evidence"], "archive event");
      if (r.componentId !== undefined) component(); sha(r.commit, "archive commit"); branch(r.branch, "archive branch");
      if (r.preparedBranch !== undefined) branch(r.preparedBranch, "prepared archive branch");
      if (r.preparedEventId !== undefined) id(r.preparedEventId, "prepared event");
      if (r.completionEventId !== undefined) id(r.completionEventId, "completion event");
      if (r.snapshotToken !== undefined) fingerprint(r.snapshotToken, "archive token");
      if (r.base !== undefined) sha(r.base, "archive base");
      if (r.evidence !== undefined) text(r.evidence, "archive evidence");
      if (!array(r.paths, "archive paths").length) fail("archive paths are required"); for (const path of r.paths) safeContextPath(path);
    } else if (["operation-started", "operation-finished"].includes(r.type)) {
      keys(r, [...common, "targetOperationId", "action", "snapshotToken"], "operation event"); id(r.targetOperationId, "target operation"); text(r.action, "operation action"); fingerprint(r.snapshotToken, "operation snapshot token");
    } else fail("unsupported event type");
  } else fail("unsupported record kind");
  return structuredClone(r) as CoordinationRecord;
}

export interface CoordinationSnapshot { manifest: FeatureManifest; records: CoordinationRecord[]; head: string }
export interface ComponentStatus {
  phase: "planned" | "assigned" | "submitted" | "blocked" | "failed" | "accepted" | "merged";
  assignmentId?: string;
  submissionId?: string;
  acceptedCommit?: string;
  deliveryCommit?: string;
  blocker?: string;
  dependencyStale?: boolean;
  requiresReapproval?: boolean;
  mergedHistory?: { assignmentId: string; submissionId: string; commit: string; deliveryCommit: string; approvalId: string; planFingerprint: string }[];
  nextAction: string;
}
export interface CoordinationStatus {
  featureId: string;
  head: string;
  approvalId?: string;
  phase: "awaiting-approval" | "implementing" | "verifying" | "ready-for-delivery" | "awaiting-merges" | "final-verification" | "awaiting-final-approval" | "completed";
  components: Record<string, ComponentStatus>;
  submissions: Record<string, { assignmentId: string; disposition: "pending" | "accepted" | "rejected" | "stale"; reason?: string }>;
  archive: "pending" | "prepared" | "archived";
  blocker?: string;
  nextAction: string;
  pendingOperations: string[];
}
const blocking = (value: ReviewFinding) => ["correctness", "security", "spec", "verification"].includes(value.category);
export function replayStatus(options: { snapshot: CoordinationSnapshot; approvalId?: string }): CoordinationStatus {
  const { manifest: rawManifest, records: rawRecords, head } = options.snapshot;
  const manifest = decodeManifest({ value: rawManifest }), records = rawRecords.map(record => decodeRecord({ value: record }));
  const byKind = <K extends RecordKind>(kind: K) => records.filter(record => record.kind === kind) as Extract<CoordinationRecord, { kind: K }>[];
  const approvals = byKind("approval").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const assignments = byKind("assignment"), submissions = byKind("submission");
  const events = byKind("event").sort((a, b) => a.sequence - b.sequence);
  const approvalMap = new Map(approvals.map(record => [record.id, record]));
  const assignmentMap = new Map(assignments.map(record => [record.id, record]));
  const submissionMap = new Map(submissions.map(record => [record.id, record]));
  const identities = new Set<string>(), operations = new Set<string>();
  for (const record of records) {
    if (record.featureId !== manifest.featureId) fail("record feature identity mismatch");
    const key = `${record.kind}/${record.id}`;
    if (identities.has(key)) fail("duplicate record identity"); identities.add(key);
    if (operations.has(record.operationId)) fail("duplicate operation identity"); operations.add(record.operationId);
  }
  const sequences = new Set<number>(), revoked = new Set<string>();
  for (const event of events) {
    if (sequences.has(event.sequence)) fail("duplicate event sequence"); sequences.add(event.sequence);
    if ("componentId" in event && event.componentId !== undefined && !Object.hasOwn(manifest.components, event.componentId)) fail("event references unknown component");
    if ("assignmentId" in event) {
      const assignment = assignmentMap.get(event.assignmentId);
      if (!assignment || assignment.componentId !== event.componentId) fail("event references unknown or mismatched assignment");
    }
    if ("submissionId" in event) {
      const submission = submissionMap.get(event.submissionId);
      if (!submission || ("assignmentId" in event && submission.assignmentId !== event.assignmentId)) fail("event references unknown or mismatched submission");
    }
    if (event.type === "revoked") revoked.add(event.assignmentId);
  }
  const status: CoordinationStatus = { featureId: manifest.featureId, head, ...(approvals.length ? { approvalId: approvals.at(-1)!.id } : {}),
    phase: approvals.length ? "implementing" : "awaiting-approval", components: {}, submissions: {}, archive: "pending", nextAction: "Approve committed feature inputs", pendingOperations: [] };
  if (Object.hasOwn(options, "approvalId")) status.approvalId = options.approvalId;
  for (const componentId of Object.keys(manifest.components)) status.components[componentId] = { phase: "planned", nextAction: "Issue an assignment" };
  for (const assignment of assignments) {
    const approved = approvalMap.get(assignment.approvalId), component = status.components[assignment.componentId];
    if (!approved || !Object.hasOwn(approved.components, assignment.componentId) || !component) fail("assignment references unknown approval or component");
    const original = approved.components[assignment.componentId];
    if (assignment.repository !== original.repository || assignment.change !== original.change || assignment.base !== original.base || assignment.planFingerprint !== original.planFingerprint || stableDigest({ value: assignment.settings }) !== stableDigest({ value: original.settings }) || stableDigest({ value: assignment.contract }) !== stableDigest({ value: approved.contract })) fail("assignment does not match approval snapshot");
    if (!revoked.has(assignment.id)) {
      if (component.assignmentId) fail(`component ${assignment.componentId} has more than one active assignment`);
      component.assignmentId = assignment.id; component.phase = "assigned"; component.nextAction = "Execute assigned component";
    }
  }
  for (const submission of [...submissions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const assignment = assignmentMap.get(submission.assignmentId);
    if (!assignment) fail("submission references unknown assignment");
    const component = status.components[assignment.componentId];
    const stale = revoked.has(assignment.id) || component.assignmentId !== assignment.id || submission.owner !== assignment.owner || submission.repository !== assignment.repository || submission.change !== assignment.change || submission.base !== assignment.base || submission.planFingerprint !== assignment.planFingerprint || submission.contractFingerprint !== assignment.contract.fingerprint;
    status.submissions[submission.id] = { assignmentId: assignment.id, disposition: stale ? "stale" : "pending", ...(stale ? { reason: "Assignment revoked or approved input identity mismatch" } : {}) };
    if (!stale) {
      component.submissionId = submission.id; component.phase = submission.outcome === "completed" ? "submitted" : submission.outcome;
      component.blocker = submission.reason; component.nextAction = submission.outcome === "completed" ? "Inspect and accept exact result" : "Resolve component blocker and resubmit";
    }
  }
  const pending = new Set<string>();
  const reviews: Extract<CoordinationEvent, { type: "reviewed" }>[] = [];
  const revokedSoFar = new Set<string>();
  const acceptedAssignments = new Map<string, AssignmentRecord>();
  const acceptedMilestones = new Map<string, Extract<CoordinationEvent, { type: "accepted" }>>();
  const mergedMilestones = new Map<string, Extract<CoordinationEvent, { type: "merged" }>>();
  const staleAcceptanceAssignments = new Set<string>();
  let completed: Extract<CoordinationEvent, { type: "completed" }> | undefined;
  const tupleFor = (stage: "combined" | "final") => Object.fromEntries(Object.entries(status.components).flatMap(([id, c]) => {
    const commit = stage === "combined" ? c.acceptedCommit : c.deliveryCommit; return commit ? [[id, commit]] : [];
  }));
  const exactTuple = (tuple: CommitTuple, stage: "combined" | "final") => Object.keys(tuple).length === Object.keys(status.components).length && stableDigest({ value: tuple }) === stableDigest({ value: tupleFor(stage) });
  const invalidate = (componentId: string, reason: string) => {
    const component = status.components[componentId];
    component.blocker = reason;
    if (component.deliveryCommit) {
      component.requiresReapproval = true; component.nextAction = "Revise component plan and renew approval before further implementation";
    } else {
      delete component.acceptedCommit; component.dependencyStale = true;
      const acceptedAssignment = acceptedAssignments.get(componentId);
      if (acceptedAssignment) staleAcceptanceAssignments.add(acceptedAssignment.id);
      component.phase = component.assignmentId ? "assigned" : "planned";
      component.nextAction = "Revoke stale assignment and issue a new assignment against current dependencies";
      if (component.submissionId) { status.submissions[component.submissionId].disposition = "stale"; status.submissions[component.submissionId].reason = reason; }
    }
    reviews.length = 0; completed = undefined;
  };
  const invalidateDependents = (componentId: string) => {
    for (const dependent of affectedDependents({ manifest, componentId })) {
      const component = status.components[dependent];
      if (component.acceptedCommit || component.deliveryCommit || component.assignmentId) invalidate(dependent, `Upstream dependency ${componentId} acceptance changed`);
    }
  };
  for (const event of events) {
    if (event.type === "operation-started") pending.add(event.targetOperationId);
    else if (event.type === "operation-finished") pending.delete(event.targetOperationId);
    else if (event.type === "reviewed") {
      for (const finding of event.findings) if (finding.componentId && !Object.hasOwn(manifest.components, finding.componentId)) fail("review finding references unknown component");
      reviews.push(event);
      if (event.stage === "final") completed = undefined;
    }
    else if (event.type === "completed") {
      const review = reviews.find(review => review.id === event.reviewEventId && review.stage === "final");
      if (!review || review !== [...reviews].reverse().find(review => review.stage === "final" && exactTuple(review.tuple, "final")) || !exactTuple(event.tuple, "final") || stableDigest({ value: event.tuple }) !== stableDigest({ value: review.tuple }) || review.findings.some(blocking) || review.verification.some(check => check.exitCode !== 0)) fail("completion requires the latest passing exact merged tuple review");
      if (review.approvalId && event.consent.token !== stableDigest({ value: { tuple: event.tuple, reviewEventId: review.id, approvalId: review.approvalId, reviewToken: review.snapshotToken, ...(event.archive ? { archive: event.archive, archiveToken: event.archiveToken, ...(event.archiveBases ? { archiveBases: event.archiveBases } : {}) } : {}) } })) fail("completion consent does not bind exact final review and tuple");
      completed = event;
    } else if (event.type === "delivery-accepted") {
      const accepted = acceptedMilestones.get(event.componentId), assignment = acceptedAssignments.get(event.componentId);
      if (!accepted || !assignment || accepted.id !== event.acceptanceId || event.findings.some(blocking) || event.verification.some(check => check.exitCode !== 0) || stableDigest({ value: event.verification.map(check => check.command) }) !== stableDigest({ value: assignment.settings.verifyIntegration })) fail("delivered acceptance requires current accepted snapshot and passing exact independent checks/review");
    } else if (event.type === "archive-approved") {
      if (!completed || completed.id !== event.completionEventId || event.snapshotToken !== event.consent.token || event.scope.componentIds.some(id => !Object.hasOwn(manifest.components, id))) fail("archive scope approval requires delivery completion and explicit bound consent");
    } else if (event.type === "archive-prepared") {
      if (!completed || completed.id !== event.completionEventId || !event.base || !event.snapshotToken || !event.preparedBranch || !event.evidence?.trim()) fail("archive preparation requires current delivery completion and modern scope/base evidence");
      const approval = events.filter((candidate): candidate is Extract<CoordinationEvent, { type: "archive-approved" }> => candidate.type === "archive-approved" && candidate.sequence < event.sequence && candidate.completionEventId === event.completionEventId && candidate.snapshotToken === event.snapshotToken).at(-1);
      const scope = approval?.scope ?? (completed.archiveToken === event.snapshotToken ? completed.archive : undefined);
      const bases = approval?.bases ?? (completed.archiveToken === event.snapshotToken ? completed.archiveBases : undefined);
      if (!scope || (event.componentId ? !scope.componentIds.includes(event.componentId) || event.branch !== manifest.components[event.componentId].deliveryBranch : !scope.includeStore || event.branch !== scope.storeDeliveryBranch)) fail("archive prepared result lacks approved exact scope and canonical branch");
      const base = event.componentId ? bases?.components[event.componentId] : bases?.store;
      if (!base || event.base !== base) fail("archive prepared base differs from approved consent scope");
      const change = event.componentId ? manifest.components[event.componentId].change : manifest.sharedChange;
      const active = `openspec/changes/${change}/`, archived = "openspec/changes/archive/", folders = new Set<string>();
      if (!event.paths.length || new Set(event.paths).size !== event.paths.length) fail("archive path scope requires unique changed paths");
      for (const path of event.paths) {
        safeContextPath(path);
        if (path.startsWith(active) || path.startsWith("openspec/specs/")) continue;
        const folder = path.startsWith(archived) ? path.slice(archived.length).split("/")[0] : "";
        if (/^\d{4}-\d{2}-\d{2}-/.test(folder) && folder.slice(11) === change && path.startsWith(`${archived}${folder}/`)) { folders.add(folder); continue; }
        fail("archive prepared path is outside approved target scope");
      }
      if (!event.paths.some(path => path.startsWith(active)) || folders.size !== 1) fail("archive path scope requires active removal and one dated target archive");
    } else if (event.type === "archive-delivered") {
      const prepared = events.find((candidate): candidate is Extract<CoordinationEvent, { type: "archive-prepared" | "archive-delivered" }> => candidate.type === "archive-prepared" && candidate.id === event.preparedEventId && candidate.sequence < event.sequence);
      if (!prepared || !completed || !event.base || event.base !== prepared.base || event.completionEventId !== completed.id || prepared.completionEventId !== completed.id || event.branch !== prepared.branch || event.componentId !== prepared.componentId || event.snapshotToken !== prepared.snapshotToken || stableDigest({ value: event.paths }) !== stableDigest({ value: prepared.paths })) fail("canonical archive delivery requires approved prepared scope/base and delivery evidence");
    }
    else if (event.type === "revoked") {
      revokedSoFar.add(event.assignmentId);
      for (const [id, receipt] of submissionMap) if (receipt.assignmentId === event.assignmentId) {
        status.submissions[id].disposition = "stale"; status.submissions[id].reason = event.reason;
      }
      const component = status.components[event.componentId];
      if (acceptedAssignments.get(event.componentId)?.id === event.assignmentId && !component.deliveryCommit) {
        delete component.acceptedCommit; component.phase = component.assignmentId ? "assigned" : "planned";
        component.blocker = event.reason; component.nextAction = "Issue a replacement assignment";
        reviews.length = 0; completed = undefined; invalidateDependents(event.componentId);
      }
    }
    else if ("componentId" in event && event.componentId !== undefined) {
      const component = status.components[event.componentId];
      if (event.type === "rejected") {
        status.submissions[event.submissionId].disposition = "rejected"; status.submissions[event.submissionId].reason = event.reason;
        if (component.assignmentId === event.assignmentId && component.phase !== "merged") { component.phase = "assigned"; component.blocker = event.reason; component.nextAction = "Correct and resubmit under active assignment"; }
      } else if (event.type === "accepted") {
        const receipt = submissionMap.get(event.submissionId)!;
        const assignment = assignmentMap.get(event.assignmentId)!;
        // Later revocation must never erase an earlier accepted/merged historical fact.
        if (revokedSoFar.has(event.assignmentId) || receipt.owner !== assignment.owner || receipt.repository !== assignment.repository || receipt.change !== assignment.change || receipt.base !== assignment.base || receipt.planFingerprint !== assignment.planFingerprint || receipt.contractFingerprint !== assignment.contract.fingerprint) continue;
        if (staleAcceptanceAssignments.has(assignment.id) || dependencyBlockers({ manifest, componentId: event.componentId, components: status.components, assignment, historical: true }).length) fail("acceptance requires exact current dependency commits; assignment is stale");
        if (receipt.outcome !== "completed" || receipt.result?.commit !== event.commit || receipt.review?.commit !== event.commit || receipt.review.findings.some(blocking) || receipt.tasks.some(task => !task.completed) || receipt.verification.some(check => check.exitCode !== 0)) fail("acceptance requires a completed exact-commit passing receipt");
        if (component.acceptedCommit !== event.commit || component.submissionId !== event.submissionId || acceptedAssignments.get(event.componentId)?.id !== event.assignmentId) {
          if (component.acceptedCommit) invalidateDependents(event.componentId);
          reviews.length = 0; completed = undefined;
          if (component.deliveryCommit) {
            const historical = component.mergedHistory?.at(-1);
            if (!historical || historical.approvalId === assignment.approvalId || historical.planFingerprint === assignment.planFingerprint) fail("further merged-component implementation requires revised plan and renewed approval");
            delete component.deliveryCommit;
          }
        }
        acceptedAssignments.set(event.componentId, assignment);
        acceptedMilestones.set(event.componentId, event);
        status.submissions[event.submissionId].disposition = "accepted";
        component.phase = "accepted"; component.submissionId = event.submissionId; component.acceptedCommit = event.commit; delete component.blocker; delete component.dependencyStale; delete component.requiresReapproval; component.nextAction = "Deliver accepted component through PR merge";
      } else if (event.type === "merged") {
        completed = undefined;
        if (component.acceptedCommit !== event.commit || component.submissionId !== event.submissionId || event.deliveryBranch !== manifest.components[event.componentId].deliveryBranch) fail("merge requires current accepted component and declared delivery branch");
        component.phase = "merged"; component.deliveryCommit = event.deliveryCommit; component.nextAction = "Verify merged feature";
        mergedMilestones.set(event.componentId, event);
        const assignment = acceptedAssignments.get(event.componentId)!;
        (component.mergedHistory ??= []).push({ assignmentId: assignment.id, submissionId: event.submissionId, commit: event.commit, deliveryCommit: event.deliveryCommit, approvalId: assignment.approvalId, planFingerprint: assignment.planFingerprint });
      } else if (event.type === "invalidated") {
        invalidate(event.componentId, event.reason); invalidateDependents(event.componentId);
      }
    }
  }
  const current = status.approvalId ? approvalMap.get(status.approvalId) : undefined;
  for (const [componentId, component] of Object.entries(status.components)) {
    const acceptedAssignment = acceptedAssignments.get(componentId);
    if (current && component.acceptedCommit && acceptedAssignment &&
        (acceptedAssignment.approvalId !== current.id || acceptedAssignment.contract.fingerprint !== current.contract.fingerprint)) {
      component.blocker = "Accepted snapshot approval/context is stale; reconcile against current approved inputs";
      if (component.deliveryCommit) {
        component.requiresReapproval = true;
        component.nextAction = "Revise component plan and renew approval before further implementation; historical merge remains recorded";
      } else {
        delete component.acceptedCommit; component.phase = component.assignmentId ? "assigned" : "planned";
        component.nextAction = "Revoke stale assignment and issue a new assignment under current approval";
      }
    }
  }
  for (const [componentId, component] of Object.entries(status.components)) {
    const assignment = component.assignmentId ? assignmentMap.get(component.assignmentId) : undefined;
    const blockers = dependencyBlockers({ manifest, componentId, components: status.components, assignment });
    if (!blockers.length && assignment && !staleAcceptanceAssignments.has(assignment.id) && component.dependencyStale) {
      delete component.dependencyStale; delete component.blocker;
    }
    if (blockers.length && !component.deliveryCommit) {
      component.blocker = blockers.join("; "); component.nextAction = assignment ? "Revoke stale assignment and satisfy current dependencies before reassignment" : "Wait for declared upstream milestone before assignment";
      if (assignment) component.dependencyStale = true;
    }
  }
  const allAccepted = Object.values(status.components).every(c => c.acceptedCommit && !c.requiresReapproval && !c.dependencyStale), allMerged = Object.values(status.components).every(c => c.deliveryCommit && !c.requiresReapproval);
  const latestReview = (stage: "combined" | "final") => [...reviews].reverse().find(review => review.stage === stage && exactTuple(review.tuple, stage));
  const currentReviewToken = (stage: "combined" | "final") => {
    if (!current || current.manifestFingerprint !== stableDigest({ value: manifest }) ||
        current.consent.token !== stableDigest({ value: { manifestFingerprint: current.manifestFingerprint, contract: current.contract, components: current.components, verification: current.verification } })) return undefined;
    const components: Record<string, { repository: string; change: string; assignmentId: string; owner: string; setup: string[][] }> = {}, milestones: Record<string, string> = {};
    for (const id of Object.keys(status.components).sort()) {
      const component = status.components[id], assignment = acceptedAssignments.get(id);
      const milestone = stage === "combined" ? acceptedMilestones.get(id) : mergedMilestones.get(id);
      if (!assignment || assignment.approvalId !== current.id || assignment.contract.fingerprint !== current.contract.fingerprint ||
          assignment.planFingerprint !== current.components[id]?.planFingerprint || component.requiresReapproval || component.dependencyStale || !milestone ||
          !(stage === "combined" ? component.acceptedCommit : component.deliveryCommit)) return undefined;
      components[id] = { repository: assignment.repository, change: assignment.change, assignmentId: assignment.id, owner: assignment.owner, setup: assignment.settings.setup ?? [] };
      milestones[id] = milestone.id;
    }
    return stableDigest({ value: { stage, tuple: tupleFor(stage), approvalId: current.id, contractFingerprint: current.contract.fingerprint,
      components, verification: current.verification, milestones } });
  };
  const passedReview = (stage: "combined" | "final") => {
    const review = latestReview(stage);
    return review && review.reviewedBy && review.summary && review.approvalId === current?.id && review.snapshotToken === currentReviewToken(stage) &&
      stableDigest({ value: review.verification.map(check => check.command) }) === stableDigest({ value: manifest.verification.map(check => check.command) }) &&
      !review.findings.some(blocking) && review.verification.every(check => check.exitCode === 0) ? review : undefined;
  };
  if (completed) {
    const approved = events.filter(event => event.type === "archive-approved" && event.completionEventId === completed!.id).at(-1) as Extract<CoordinationEvent, { type: "archive-approved" }> | undefined;
    const scope = approved?.scope ?? completed.archive;
    if (scope) {
      const targets = [...scope.componentIds, ...(scope.includeStore ? ["@store"] : [])];
      const prepared = targets.map(target => events.filter((event): event is Extract<CoordinationEvent, { type: "archive-prepared" | "archive-delivered" }> => event.type === "archive-prepared" && event.completionEventId === completed!.id && (event.componentId ?? "@store") === target).at(-1));
      const delivered = prepared.map(record => record && events.some(event => event.type === "archive-delivered" && event.preparedEventId === record.id && event.branch === record.branch && event.completionEventId === completed!.id));
      if (prepared.some(Boolean)) status.archive = delivered.every(Boolean) ? "archived" : "prepared";
    }
  }
  if (completed && exactTuple(completed.tuple, "final") && passedReview("final")?.id === completed.reviewEventId) { status.phase = "completed"; status.nextAction = status.archive === "archived" ? "Feature delivered and archived" : "Record approved archive delivery separately"; }
  else if (allMerged) { status.phase = passedReview("final") ? "awaiting-final-approval" : "final-verification"; status.nextAction = passedReview("final") ? "Approve exact merged tuple" : "Verify and review merged feature"; }
  else if (allAccepted) { status.phase = passedReview("combined") ? (Object.values(status.components).some(c => c.deliveryCommit) ? "awaiting-merges" : "ready-for-delivery") : "verifying"; status.nextAction = passedReview("combined") ? "Merge every required component PR" : "Run combined verification and review"; }
  else if (approvals.length) status.nextAction = "Assign, execute and accept remaining components";
  if (Object.values(status.components).some(component => component.requiresReapproval)) status.nextAction = "Reconcile historical merged work with current approved inputs; revise affected component plans and renew approval before further implementation";
  status.pendingOperations = [...pending].sort();
  const blockers = Object.entries(status.components).filter(([, c]) => c.blocker).map(([id, c]) => `${id}: ${c.blocker}`);
  const latest = latestReview(allMerged ? "final" : "combined");
  if (latest && !passedReview(latest.stage)) {
    const stale = latest.approvalId !== current?.id || latest.snapshotToken !== currentReviewToken(latest.stage);
    blockers.push(stale ? `Whole-feature ${latest.stage} review approval/context/snapshot is stale; reconcile current inputs and obtain a fresh exact-tuple review` : `Whole-feature ${latest.stage} review/checks blocked: ${latest.findings.filter(blocking).map(finding => `${finding.componentId ?? "feature"}${finding.owner ? ` (${finding.owner})` : ""}: ${finding.impact}`).join("; ") || "required verification failed"}`);
    status.nextAction = stale ? "Reconcile current approved inputs and obtain a fresh exact-tuple review" : "Resolve blocking findings with the affected component owners, then verify and review the exact tuple again";
  }
  if (blockers.length) status.blocker = blockers.join("; ");
  return status;
}

const directories: Record<RecordKind, string> = { approval: "approvals", assignment: "assignments", submission: "submissions", event: "events" };
export interface RecordWriteResult { path: string; created: boolean; head: string; operationId: string }
export class CoordinationStore {
  readonly root: string;
  readonly featureId: string;
  readonly directory: string;
  private validatedHead?: string;
  private immutableObjects = new Map<string, string>();
  constructor(options: { root: string; featureId: string }) {
    id(options.featureId, "feature");
    this.root = repository(options.root).root;
    if (realpathSync(this.root) !== resolve(this.root)) throw new Error("Store root cannot contain a symlink");
    this.featureId = options.featureId;
    this.directory = `runner/features/${this.featureId}`;
    this.safePath(`${this.directory}/manifest.yaml`);
  }
  private safePath(path: string, createDirectories = false) {
    safeContextPath(path);
    const destination = resolve(this.root, path), rel = relative(this.root, destination);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Record path escapes Store");
    const parts = path.split("/");
    let parent = this.root;
    for (let i = 0; i < parts.length; i++) {
      parent = resolve(parent, parts[i]);
      if (existsSync(parent) || (() => { try { lstatSync(parent); return true; } catch { return false; } })()) {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink()) throw new Error(`Record path cannot contain a symlink: ${path}`);
        if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Record path requires regular files and directories: ${path}`);
      } else if (createDirectories && i < parts.length - 1) mkdirSync(parent);
    }
    return destination;
  }
  private entries(revision: string) {
    sha(revision, "Store history revision");
    if (git(this.root, "rev-parse", `${revision}^{commit}`) !== revision) throw new Error("Store history revision must be a commit");
    return gitRaw(this.root, "ls-tree", "-r", "-z", revision, "--", this.directory).split("\0").filter(Boolean).map(line => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match || !["100644", "100755"].includes(match[1]) || match[2] !== "blob") throw new Error("Coordination history cannot contain symlinks or non-files");
      safeContextPath(match[4]);
      return { path: match[4], object: match[3] };
    });
  }
  private validateHistory(head: string) {
    if (head === this.validatedHead) return;
    const history = git(this.root, "rev-list", "--first-parent", "--reverse", head).split("\n");
    const previousIndex = this.validatedHead ? history.indexOf(this.validatedHead) : -1;
    const objects = previousIndex >= 0 ? new Map(this.immutableObjects) : new Map<string, string>();
    for (const revision of history.slice(previousIndex + 1)) {
      const records = this.entries(revision).filter(entry => entry.path !== `${this.directory}/manifest.yaml`);
      const present = new Set(records.map(entry => entry.path));
      for (const path of objects.keys()) if (!present.has(path)) throw new Error(`Immutable coordination record deleted after authoritative introduction: ${path}`);
      for (const entry of records) {
        const original = objects.get(entry.path);
        if (original && original !== entry.object) throw new Error(`Immutable coordination record bytes changed after authoritative introduction: ${entry.path}`);
        objects.set(entry.path, entry.object);
      }
    }
    this.immutableObjects = objects;
    this.validatedHead = head;
  }
  readSnapshot(options: { revision?: string } = {}): CoordinationSnapshot {
    const head = options.revision ?? git(this.root, "rev-parse", "HEAD");
    this.validateHistory(head);
    const entries = this.entries(head), manifestEntry = entries.find(e => e.path === `${this.directory}/manifest.yaml`);
    if (!manifestEntry) throw new Error(`Missing committed feature manifest: ${this.featureId}`);
    const manifest = decodeManifest({ value: committedBlob({ root: this.root, object: manifestEntry.object }).toString("utf8") });
    if (manifest.featureId !== this.featureId) throw new Error("Manifest feature identity mismatch");
    const records = entries.filter(e => e !== manifestEntry).map(entry => {
      const record = decodeRecord({ value: committedBlob({ root: this.root, object: entry.object }).toString("utf8") });
      if (entry.path !== this.recordPath(record.kind, record.id)) throw new Error("Record filename or kind does not match its immutable identity");
      return record;
    });
    return { manifest, records, head };
  }
  /** Approval authority follows introduction on first-parent history, never user timestamps. */
  authoritativeApproval(options: { snapshot?: CoordinationSnapshot } = {}): ApprovalRecord | undefined {
    const snapshot = options.snapshot ?? this.readSnapshot();
    const approvals = snapshot.records.filter((r): r is ApprovalRecord => r.kind === "approval");
    const commits = git(this.root, "rev-list", "--first-parent", snapshot.head).split("\n");
    for (const commit of commits) {
      const parent = attempt(() => git(this.root, "rev-parse", `${commit}^1`));
      const introduced = approvals.filter(record => {
        const path = `${this.directory}/approvals/${record.id}.json`;
        return attempt(() => git(this.root, "rev-parse", `${commit}:${path}`)) !== undefined &&
          (!parent || attempt(() => git(this.root, "rev-parse", `${parent}:${path}`)) === undefined);
      });
      if (introduced.length > 1) throw new Error("Ambiguous approval history: multiple approvals introduced in one coordination commit");
      if (introduced.length) return introduced[0];
    }
    if (approvals.length) throw new Error("Approval is not introduced on authoritative coordination history");
    return undefined;
  }
  readManifest(options: { revision?: string } = {}): FeatureManifest { return this.readSnapshot(options).manifest; }
  readRecord(options: { kind: RecordKind; id: string; revision?: string }): CoordinationRecord | undefined {
    this.recordPath(options.kind, options.id);
    return this.readSnapshot({ revision: options.revision }).records.find(record => record.kind === options.kind && record.id === options.id);
  }
  status(options: { revision?: string } = {}): CoordinationStatus { const snapshot = this.readSnapshot(options); return replayStatus({ snapshot, approvalId: this.authoritativeApproval({ snapshot })?.id }); }
  private recordPath(kind: RecordKind, recordId: string) {
    id(recordId, "record"); if (!Object.hasOwn(directories, kind)) throw new Error("Invalid record kind");
    return `${this.directory}/${directories[kind]}/${recordId}.json`;
  }
  writeManifest(options: { manifest: FeatureManifest; sharedTasks: { id: string; completed: boolean }[]; expectedHead: string; operationId: string }): RecordWriteResult {
    const manifest = decodeManifest({ value: options.manifest, sharedTasks: options.sharedTasks });
    if (manifest.featureId !== this.featureId) throw new Error("Manifest feature identity mismatch");
    return this.persist({ path: `${this.directory}/manifest.yaml`, bytes: Buffer.from(stringify(manifest)), branch: manifest.coordinationBranch, expectedHead: options.expectedHead, operationId: options.operationId });
  }
  writeRecord(options: { record: CoordinationRecord; expectedHead: string; bytes?: Buffer | string }): RecordWriteResult {
    const record = decodeRecord({ value: options.record });
    if (record.featureId !== this.featureId) throw new Error("Record feature identity mismatch");
    const snapshot = this.readSnapshot();
    const previous = snapshot.records.find(r => r.kind === record.kind && r.id === record.id);
    if (previous && stableDigest({ value: previous }) !== stableDigest({ value: record })) throw new Error("Immutable record identity reused with different payload");
    const candidate = previous ? snapshot : { ...snapshot, records: [...snapshot.records, record] };
    // Newly persisted approvals are introduced only by this expected-head mutation.
    const approvalId = record.kind === "approval" && !previous ? record.id : this.authoritativeApproval({ snapshot })?.id;
    const nextStatus = replayStatus({ snapshot: candidate, approvalId });
    const bytes = options.bytes === undefined ? Buffer.from(JSON.stringify(record, null, 2) + "\n") : Buffer.from(options.bytes);
    if (stableDigest({ value: decodeRecord({ value: bytes.toString("utf8") }) }) !== stableDigest({ value: record })) throw new Error("Imported receipt bytes do not match record payload");
    const companions: { path: string; bytes: Buffer }[] = [];
    if (record.kind === "event" && (record.type === "merged" || (record.type === "reviewed" && record.stage === "final"))) {
      const approvals = snapshot.records.filter((r): r is ApprovalRecord => r.kind === "approval");
      // Current authority is explicit in reviewed evidence; merge uses its accepted assignment.
      const acceptance = record.type === "merged" ? snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "accepted" }> => r.kind === "event" && r.type === "accepted" && r.componentId === record.componentId && r.commit === record.commit).sort((a, b) => b.sequence - a.sequence)[0] : undefined;
      const assignment = snapshot.records.find((r): r is AssignmentRecord => r.kind === "assignment" && r.id === acceptance?.assignmentId);
      const approved = approvals.find(r => r.id === (record.type === "reviewed" ? record.approvalId : assignment?.approvalId));
      const file = approved?.contract.files.find(file => file.path.endsWith(`/changes/${snapshot.manifest.sharedChange}/tasks.md`));
      if (file) {
        const source = committedBlob({ root: this.root, object: git(this.root, "rev-parse", `${snapshot.head}:${file.path}`) }).toString("utf8");
        const normalize = (value: string) => value.replace(/(\[[ xX]\])/g, "[ ]").trimEnd();
        if (normalize(source) !== normalize(file.content)) throw new Error("Shared task text drifted from approved input");
        const lines = source.split("\n");
        for (const task of tasksFrom(source)) {
          const mappings = snapshot.manifest.taskMapping[task.id];
          if (!mappings) continue;
          const done = mappings.every(milestone => milestone.type === "merged" ? !!nextStatus.components[milestone.componentId]?.deliveryCommit && !nextStatus.components[milestone.componentId]?.requiresReapproval : ["awaiting-final-approval", "completed"].includes(nextStatus.phase));
          lines[task.line] = lines[task.line].replace(/\[[ xX]\]/, done ? "[x]" : "[ ]");
        }
        const content = lines.join("\n");
        companions.push({ path: file.path, bytes: Buffer.from(content) });
      }
    }
    return this.persist({ companions, path: this.recordPath(record.kind, record.id), bytes, branch: snapshot.manifest.coordinationBranch, expectedHead: options.expectedHead, operationId: record.operationId });
  }
  private persist(options: { path: string; bytes: Buffer; branch: string; expectedHead: string; operationId: string; companions?: { path: string; bytes: Buffer }[] }): RecordWriteResult {
    sha(options.expectedHead, "expected head"); id(options.operationId, "operation");
    const path = this.safePath(options.path), head = git(this.root, "rev-parse", "HEAD");
    if (git(this.root, "branch", "--show-current") !== options.branch) throw new Error(`Coordination mutation requires branch ${options.branch}`);
    const companions = options.companions ?? [];
    for (const companion of companions) this.safePath(companion.path);
    const allowed = [options.path, ...companions.map(companion => companion.path)];
    const currentEntries = this.entries(head), existing = currentEntries.find(e => e.path === options.path);
    const payloadDigest = createHash("sha256").update(options.bytes).digest("hex");
    if (existing && !committedBlob({ root: this.root, object: existing.object }).equals(options.bytes)) throw new Error("Immutable record bytes differ for existing identity");
    const message = git(this.root, "show", "-s", "--format=%B", head);
    const marker = `Runner-Operation: ${options.operationId}\nRunner-Payload: ${payloadDigest}`;
    const parents = git(this.root, "show", "-s", "--format=%P", head).split(" ");
    const recovered = !!existing && message.includes(marker) && parents.length === 1 && parents[0] === options.expectedHead;
    if (head !== options.expectedHead && !recovered) throw new Error(`Coordination head changed: expected ${options.expectedHead}, found ${head}; reconcile Git history`);
    if (existing) {
      // The ref update may have succeeded immediately before the local index
      // refresh failed. Repair only the exact operation's regular, unchanged file.
      if (recovered && existsSync(path) && readFileSync(path).equals(options.bytes)) {
        const dirtyIndex = gitRaw(this.root, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);
        if (dirtyIndex.every(p => allowed.includes(p))) git(this.root, "add", "--", ...allowed);
      }
      return { path: options.path, created: false, head, operationId: options.operationId };
    }
    // A recovery may adopt only the exact pending file, never unrelated changes.
    const staged = gitRaw(this.root, "diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);
    if (staged.some(p => !allowed.includes(p))) throw new Error("Unrelated staged files prevent coordination record commit");
    const trackedDirty = gitRaw(this.root, "diff", "--name-only", "-z").split("\0").filter(Boolean);
    const untracked = gitRaw(this.root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    if (untracked.some(p => !allowed.includes(p))) throw new Error("Unrelated untracked files prevent coordination mutation");
    if (trackedDirty.some(p => !allowed.includes(p))) throw new Error("A clean Store checkout is required for coordination mutation");
    if (existsSync(path) && !readFileSync(path).equals(options.bytes)) throw new Error("Immutable pending record bytes differ for existing identity");
    for (const companion of companions) {
      const target = this.safePath(companion.path);
      const original = committedBlob({ root: this.root, object: git(this.root, "rev-parse", `${options.expectedHead}:${companion.path}`) });
      if (!existsSync(target) || (!readFileSync(target).equals(original) && !readFileSync(target).equals(companion.bytes))) throw new Error("Shared task checkout conflicts with pending milestone bytes");
    }
    const created = !existsSync(path);
    this.safePath(options.path, true);
    if (created) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, options.bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
      const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    for (const companion of companions) writeFileSync(this.safePath(companion.path), companion.bytes);
    // Recheck after durable intent is on disk. A failed guard leaves it recoverable.
    if (git(this.root, "branch", "--show-current") !== options.branch || git(this.root, "rev-parse", "HEAD") !== options.expectedHead) throw new Error("Coordination branch/head changed before record commit; recover pending operation");
    // Build only the intended record on the expected parent, then compare-and-swap
    // its branch. A concurrent external commit is retained and this intent remains
    // available for explicit reconciliation; it can never become our parent.
    const common = repository(this.root).common;
    const temporaryIndex = resolve(common, `runner-coordination-index-${randomUUID()}`);
    const execute = (args: string[], input?: Buffer) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: this.root, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex },
      input, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    }).trim();
    try {
      execute(["read-tree", options.expectedHead]);
      const blob = execute(["hash-object", "-w", "--stdin"], options.bytes);
      execute(["update-index", "--add", "--cacheinfo", "100644", blob, options.path]);
      for (const companion of companions) {
        const object = execute(["hash-object", "-w", "--stdin"], companion.bytes);
        execute(["update-index", "--add", "--cacheinfo", "100644", object, companion.path]);
      }
      const tree = execute(["write-tree"]);
      const commit = execute(["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", options.expectedHead, "-m", `Record ${this.featureId} ${options.operationId}\n\n${marker}`]);
      git(this.root, "update-ref", "-m", `runner ${options.operationId}`, `refs/heads/${options.branch}`, commit, options.expectedHead);
      git(this.root, "add", "--", ...allowed);
    } finally {
      if (existsSync(temporaryIndex)) unlinkSync(temporaryIndex);
      if (existsSync(`${temporaryIndex}.lock`)) unlinkSync(`${temporaryIndex}.lock`);
    }
    return { path: options.path, created, head: git(this.root, "rev-parse", "HEAD"), operationId: options.operationId };
  }
}
