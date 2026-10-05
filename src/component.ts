import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CoordinationStore, stableDigest, replayStatus, decodeRecord, type AssignmentRecord, type ApprovalRecord, type SubmissionRecord, validateId } from "./coordination-state.js";
import { assertRepositoryIdentity, coordinationRevision, currentApproval } from "./coordination.js";
import { atomic, git, json, repository } from "./system.js";
import { assertCommitted, loadPlan } from "./plan.js";
import { portableVerificationEvidence, verificationCommand } from "./submission.js";
import { Feature } from "./feature.js";
import { readFeature, validateDelegatedBinding, delegationForBinding, type FeatureApproval } from "./feature-state.js";
import { getHarness } from "./harnesses/registry.js";
import { safeContextPath, type PinnedContext } from "./openspec-context.js";
import { componentBindingPath, readComponentBinding, decodeResources, expectedContextPaths, type ComponentResources, type ComponentBinding } from "./component-state.js";
export type { ComponentResources, ComponentBinding } from "./component-state.js";

export interface ComponentInspection {
  storeRoot: string;
  featureId: string;
  assignmentId: string;
  owner: string;
  historyRevision?: string;
  resources?: Partial<ComponentResources>;
}
const digest = (value: unknown) => stableDigest({ value });
function known(options: object, extra: string[] = []) {
  for (const key of Object.keys(options)) if (!["storeRoot", "featureId", "assignmentId", "owner", "historyRevision", "resources", ...extra].includes(key))
    throw new Error(`Assignment import forbids scope/settings overlays: unknown ${key}`);
}
export class Component {
  readonly repo: ReturnType<typeof repository>;
  readonly repository: string;
  constructor(options: { root: string; repository: string }) {
    this.repo = repository(options.root);
    this.repository = options.repository;
  }
  private bindingPath(change: string) { return componentBindingPath({ stateDir: this.repo.stateDir, change }); }
  readBinding(options: { change: string }): ComponentBinding | undefined {
    const binding = readComponentBinding({ stateDir: this.repo.stateDir, change: options.change });
    if (binding && binding.repository !== this.repository) throw new Error("Component runtime binding repository identity mismatch");
    return binding;
  }
  async inspect(options: ComponentInspection) {
    known(options); assertRepositoryIdentity({ root: this.repo.root, repository: this.repository });
    const store = new CoordinationStore({ root: options.storeRoot, featureId: options.featureId });
    const historyRevision = coordinationRevision({ store, revision: options.historyRevision }), snapshot = store.readSnapshot({ revision: historyRevision });
    const assignment = snapshot.records.find((record): record is AssignmentRecord => record.kind === "assignment" && record.id === options.assignmentId);
    if (!assignment) throw new Error("Assignment not present in inspected committed history");
    if (assignment.repository !== this.repository) throw new Error("Assignment repository identity mismatch");
    if (!options.owner || options.owner !== assignment.owner) throw new Error("Assignment owner does not match explicit local owner");
    const approval = snapshot.records.find((record): record is ApprovalRecord => record.kind === "approval" && record.id === assignment.approvalId);
    if (!approval || currentApproval({ store, snapshot })?.id !== approval.id || approval.manifestFingerprint !== digest(snapshot.manifest))
      throw new Error("Assignment approval is stale or missing from committed history");
    if (digest({ manifestFingerprint: approval.manifestFingerprint, contract: approval.contract, components: approval.components, verification: approval.verification }) !== approval.consent.token)
      throw new Error("Approval consent token does not bind its committed snapshot");
    if (replayStatus({ snapshot }).components[assignment.componentId]?.assignmentId !== assignment.id) throw new Error("Assignment revoked or no longer active in inspected history");
    const rootIdentity = assignment.contract.repository;
    assertRepositoryIdentity({ root: store.root, repository: rootIdentity });
    const plan = loadPlan(this.repo.root, assignment.change);
    assertCommitted(this.repo.root, plan);
    assertCommitted(this.repo.root, plan, assignment.base);
    if (git(this.repo.root, "rev-parse", "HEAD") !== assignment.base) throw new Error("Local component base differs from assignment");
    if (plan.fingerprint !== assignment.planFingerprint) throw new Error("Committed component plan differs from assignment fingerprint");
    if (digest(plan.config.setup) !== digest(assignment.settings.setup ?? []) || digest(plan.config.verifyIntegration) !== digest(assignment.settings.verifyIntegration) ||
        digest(plan.tasks.map(task => task.id).sort()) !== digest(Object.keys(assignment.settings.tasks).sort())) throw new Error("Assignment task scope/setup/checks differ from committed component plan");
    const settings = [assignment.settings.implementation, ...Object.values(assignment.settings.tasks), assignment.settings.review, assignment.settings.repair];
    for (const harnessId of new Set(settings.map(setting => setting.harness ?? "codex"))) {
      const capability = await getHarness(harnessId).capabilities(this.repo.root);
      if (!capability.installed || !capability.supported || !capability.features.supervisedExecution || !capability.features.sessionOwnership || !capability.features.workerReports)
        throw new Error(`Harness ${harnessId} cannot execute assignment: ${capability.reasons.join("; ")}`);
      for (const setting of settings.filter(setting => (setting.harness ?? "codex") === harnessId)) {
        const effort = setting.effort ?? setting.reasoningEffort;
        if (effort && (!capability.features.effort || (capability.supportedEfforts && !capability.supportedEfforts.includes(effort)))) throw new Error(`Harness ${harnessId} lacks approved effort ${effort}`);
      }
    }
    const resources = decodeResources({ value: options.resources, defaults: { terminal: plan.config.terminal, worktrees: plan.config.worktrees, worktreeRoot: resolve(this.repo.root, ".openspec-runner/worktrees") } });
    const old = this.readBinding({ change: assignment.change });
    if (old && digest(old.assignment) !== digest(assignment)) throw new Error("A different assignment already reserves local component execution");
    const payload = { assignment, historyRevision, resources };
    return { ...payload, token: digest(payload), change: assignment.change, repository: this.repository,
      context: [assignment.contract, ...(assignment.contract.references ?? [])].map(context => ({ repository: context.repository, revision: context.revision, fingerprint: context.fingerprint, paths: context.files.map(file => file.path) })) };
  }
  private materialize(context: PinnedContext, root: string) {
    const ensure = (path: string) => {
      if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("Pinned context directory is unsafe");
      } else mkdirSync(path);
    };
    ensure(root);
    for (const file of context.files) {
      safeContextPath(file.path);
      let parent = root;
      for (const part of file.path.split("/").slice(0, -1)) { parent = resolve(parent, part); ensure(parent); }
      const path = resolve(root, file.path);
      if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, "utf8") !== file.content) throw new Error("Existing pinned context differs from approved content");
      } else writeFileSync(path, file.content, { flag: "wx", mode: 0o444 });
      chmodSync(path, 0o444);
    }
    const readonly = (path: string) => {
      // Lock known parent directories, leaving runtime reservation outside context.
      chmodSync(path, 0o555);
    };
    for (const file of context.files) {
      let parent = dirname(resolve(root, file.path));
      while (parent !== root) { readonly(parent); parent = dirname(parent); }
    }
    readonly(root);
  }
  async import(options: ComponentInspection & { token: string }) {
    known(options, ["token"]);
    const { token, ...inspection } = options;
    const preview = await this.inspect(inspection);
    if (!token || token !== preview.token) throw new Error("Import token is stale; inspect assignment again");
    const assignment = preview.assignment, feature = new Feature(this.repo.root), path = this.bindingPath(assignment.change);
    const binding = feature.runner.lock(() => {
      const old = this.readBinding({ change: assignment.change });
      if (old) {
        if (old.token !== token || digest(old.assignment) !== digest(assignment)) throw new Error("Import reservation differs; reconcile inspected history");
        return old;
      }
      if (readFeature(this.repo.stateDir, assignment.change) || feature.runner.read(assignment.change)) throw new Error("Existing managed local execution cannot be replaced by assignment import");
      const contextPaths = expectedContextPaths({ stateDir: this.repo.stateDir, assignment });
      const reserved: ComponentBinding = { version: 1, phase: "reserved", repository: this.repository, change: assignment.change,
        assignmentId: assignment.id, featureId: assignment.featureId, historyRevision: preview.historyRevision, token, assignment, contextPaths, resources: preview.resources };
      atomic(path, reserved);
      return reserved;
    });
    const contextParent = dirname(binding.contextPaths[0]);
    mkdirSync(contextParent, { recursive: true });
    [assignment.contract, ...(assignment.contract.references ?? [])].forEach((context, index) => this.materialize(context, binding.contextPaths[index]));
    const delegated = delegationForBinding({ stateDir: this.repo.stateDir, binding });
    const approval: FeatureApproval = { token: digest(assignment), fingerprint: assignment.planFingerprint, base: assignment.base,
      ...structuredClone(assignment.settings), at: assignment.createdAt };
    feature.bindAssignment({ change: assignment.change, approval, delegated });
    feature.runner.lock(() => { binding.phase = "ready"; atomic(path, binding); });
    validateDelegatedBinding(delegated);
    return binding;
  }
  submissionPreview(options: { change: string; outcome: SubmissionRecord["outcome"]; reason?: string }) {
    assertRepositoryIdentity({ root: this.repo.root, repository: this.repository });
    const binding = this.readBinding(options);
    if (!binding || binding.phase !== "ready") throw new Error("Component requires completed assignment import");
    const feature = new Feature(this.repo.root), state = feature.read(options.change);
    if (!state.delegated) throw new Error("Missing delegated assignment binding");
    validateDelegatedBinding(state.delegated);
    if (!["completed", "blocked", "failed"].includes(options.outcome)) throw new Error("Invalid submission outcome");
    if (options.outcome !== "completed" && !options.reason?.trim()) throw new Error("Blocked/failed submission requires concrete reason");
    const assignment = binding.assignment;
    const payload = { assignmentId: assignment.id, owner: assignment.owner, repository: assignment.repository,
      change: assignment.change, outcome: options.outcome, ...(options.reason === undefined ? {} : { reason: options.reason }),
      base: assignment.base, planFingerprint: assignment.planFingerprint, contractFingerprint: assignment.contract.fingerprint };
    if (options.outcome !== "completed") return { ...payload, tasks: [], verification: [], token: digest(payload) };
    const evidence = feature.submissionEvidence(options);
    const completed = { ...payload, result: { branch: evidence.branch, commit: evidence.commit }, tasks: evidence.tasks,
      review: evidence.review, verification: evidence.verification };
    return { ...completed, token: digest(completed) };
  }
  exportSubmission(options: { change: string; outcome: SubmissionRecord["outcome"]; reason?: string; id: string; operationId: string; token: string; createdAt?: string }) {
    validateId({ value: options.id }); validateId({ value: options.operationId });
    const path = resolve(this.repo.stateDir, "submissions", `${options.id}.json`);
    return new Feature(this.repo.root).runner.lock(() => {
      if (existsSync(path)) {
        const saved = json<{ input: object; token: string; record: SubmissionRecord; bytes: string }>(path);
        if (digest(saved.input) !== digest(options)) throw new Error("Immutable submission export identity differs");
        decodeRecord({ value: saved.bytes });
        return { record: saved.record, bytes: saved.bytes };
      }
      const preview = this.submissionPreview(options);
      if (!options.token || options.token !== preview.token) throw new Error("Submission token is stale; preview again");
      const binding = this.readBinding(options)!;
      const { token, verification, ...payload } = preview;
      const identity = { version: 1, kind: "submission", id: options.id, operationId: options.operationId,
        featureId: binding.featureId, createdAt: options.createdAt ?? new Date().toISOString() };
      decodeRecord({ value: { ...identity, ...payload, verification: [] } });
      const checks = options.outcome === "completed" ? binding.assignment.settings.verifyIntegration.map(command =>
        verificationCommand({ root: new Feature(this.repo.root).runner.read(options.change)!.integration.path, commit: "result" in preview ? preview.result.commit : "", command })) : [];
      if (checks.some(check => check.exitCode !== 0)) throw new Error("Required submission verification failed");
      // Revalidate after checks so they cannot mutate the reviewed snapshot.
      if (this.submissionPreview(options).token !== preview.token) throw new Error("Submission changed during verification");
      const component = `component:${binding.assignment.componentId}`, integration = new Feature(this.repo.root).runner.read(options.change)!.integration.path;
      const roots = [{ path: this.repo.root, identity: component }, { path: this.repo.common, identity: `${component}:git` },
        { path: this.repo.stateDir, identity: `${component}:runtime` }, { path: binding.resources.worktreeRoot, identity: `${component}:worktrees` },
        { path: integration, identity: component }];
      const record = decodeRecord({ value: { ...identity, ...payload, verification: checks.map(evidence => portableVerificationEvidence({ evidence, roots })) } }) as SubmissionRecord;
      const bytes = JSON.stringify(record, null, 2) + "\n";
      atomic(path, { input: options, token, record, bytes, localVerification: checks });
      return { record, bytes };
    });
  }
  status(options: { change: string; storeRoot?: string; historyRevision?: string }) {
    const binding = this.readBinding(options);
    if (!binding) return { imported: false as const };
    let inspectedHistory = binding.historyRevision, revoked: boolean | undefined;
    if (options.storeRoot) {
      const store = new CoordinationStore({ root: options.storeRoot, featureId: binding.featureId });
      inspectedHistory = coordinationRevision({ store, revision: options.historyRevision });
      const snapshot = store.readSnapshot({ revision: inspectedHistory });
      revoked = replayStatus({ snapshot }).components[binding.assignment.componentId]?.assignmentId !== binding.assignmentId;
    }
    return { ...binding, imported: true as const, inspectedHistory, revoked, nextAction: revoked ? "Stop and reconcile with coordinator" : "Execute, review, then export component receipt" };
  }
}
