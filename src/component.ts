import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { safeComponentSummary } from "./summary-service.js";
import { CoordinationStore, stableDigest, replayStatus, decodeRecord, type AssignmentRecord, type ApprovalRecord, type SubmissionRecord, validateId } from "./coordination-state.js";
import { assertRepositoryIdentity, coordinationRevision, currentApproval } from "./coordination.js";
import { atomic, git, json, locked, repository } from "./system.js";
import { assertCommitted } from "./plan.js";
import { portableVerificationEvidence, verificationCommand } from "./submission.js";
import { Feature } from "./feature.js";
import { readFeature, featurePath, validateDelegatedBinding, delegationForBinding, type FeatureApproval } from "./feature-state.js";
import { retirementPath, retirementPreview, retireComponent, type RetirementInput } from "./component-retirement.js";
import { withStoreOwnership } from "./store-ownership.js";
import { getHarness } from "./harnesses/registry.js";
import { contextFingerprint, repinContext, safeContextPath, type ContextFile, type OpenSpecExecutor } from "./openspec-context.js";
import { assertDeclaredSnapshotEntries, assignmentContexts, componentBindingPath, readComponentBinding, decodeResources, expectedContextPaths, storeReservation, type ComponentResources, type ComponentBinding } from "./component-state.js";
import { loadSourcePlan, pinStorePlan, unredirectedStorePath } from "./planning-source.js";
import { resolveExecutionContext, type ExecutionContext } from "./execution-context.js";
import { Runner } from "./runner.js";
import { validateStoreSubmission } from "./store-submission.js";
import { dependencyBlockers } from "./coordination-dependencies.js";
import { assertWindowsContextHost, probeWindowsContext, sealWindowsContext, validateWindowsContextInventory, verifyWindowsContext, windowsContextRequest } from "./windows-context.js";
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
  private readonly execute?: OpenSpecExecutor;
  readonly execution?: ExecutionContext;
  constructor(options: { root: string; repository: string; execute?: OpenSpecExecutor; execution?: ExecutionContext }) {
    const runner = new Runner(options.root, undefined, options.execution);
    this.repo = runner.repo;
    this.execution = runner.execution;
    this.repository = options.repository;
    this.execute = options.execute;
  }
  private feature() { return new Feature(this.repo.root, undefined, this.execution); }
  private bindingPath(change: string) { return componentBindingPath({ stateDir: this.repo.stateDir, change }); }
  readBinding(options: { change: string }): ComponentBinding | undefined {
    const binding = readComponentBinding({ stateDir: this.repo.stateDir, change: options.change });
    if (binding && binding.repository !== this.repository) throw new Error("Component runtime binding repository identity mismatch");
    return binding;
  }
  retirementPreview(input: RetirementInput) { return retirementPreview(this.repo.root, this.repository, input, this.execution); }
  retire({ token, ...input }: RetirementInput & { token: string }) { return retireComponent(this.repo.root, this.repository, input, token, this.execution); }
  assignmentContext(options: ComponentInspection) {
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
    const status = replayStatus({ snapshot, approvalId: approval.id });
    if (status.components[assignment.componentId]?.assignmentId !== assignment.id) throw new Error("Assignment revoked or no longer active in inspected history");
    const rootIdentity = assignment.contract.repository;
    assertRepositoryIdentity({ root: store.root, repository: rootIdentity });
    const execution = resolveExecutionContext({ implementationRoot: this.repo.root, change: assignment.change,
      ...(assignment.version === 2 ? { store: { storeRoot: options.storeRoot, featureId: assignment.featureId, componentId: assignment.componentId, assignmentId: assignment.id, source: assignment.planningSource } } : {}) });
    if (existsSync(retirementPath(execution.runtimeDir, assignment.featureId, assignment.id))) throw new Error("Assignment is retired or retirement is pending; import a different approved assignment");
    const plan = loadSourcePlan(execution.planningSource);
    if (assignment.version === 2) {
      storeReservation(execution.runtimeDir, assignment);
      const primary = repinContext({ root: store.root, context: assignment.contract, revision: historyRevision });
      if (contextFingerprint({ ...primary, references: assignment.contract.references }) !== assignment.contract.fingerprint)
        throw new Error("Shared contract drifted in inspected Store history; renew approval");
      const blockers = dependencyBlockers({ manifest: snapshot.manifest, componentId: assignment.componentId, components: status.components, assignment });
      if (status.components[assignment.componentId].dependencyStale || blockers.length) throw new Error(`Stale assignment dependencies: ${blockers.join("; ")}`);
      const source = assignment.planningSource;
      git(store.root, "merge-base", "--is-ancestor", source.revision, historyRevision);
      const historical = pinStorePlan({ ...source, storeRoot: store.root, execute: this.execute });
      if (digest(historical) !== digest(source)) throw new Error("Approved Store planning bytes differ from committed component project");
      if (source.revision !== historyRevision) {
        const inspected = pinStorePlan({ ...source, revision: historyRevision, storeRoot: store.root, execute: this.execute });
        if (inspected.fingerprint !== source.fingerprint) throw new Error("Component planning inputs drifted in the inspected Store history; renew approval");
      }
    } else {
      assertCommitted(this.repo.root, plan);
      assertCommitted(this.repo.root, plan, assignment.base);
    }
    if (git(this.repo.root, "rev-parse", "HEAD") !== assignment.base) throw new Error("Local component base differs from assignment");
    if (plan.fingerprint !== assignment.planFingerprint) throw new Error("Committed component plan differs from assignment fingerprint");
    if (digest(plan.config.setup) !== digest(assignment.settings.setup ?? []) || digest(plan.config.verifyIntegration) !== digest(assignment.settings.verifyIntegration) ||
        digest(plan.tasks.map(task => task.id).sort()) !== digest(Object.keys(assignment.settings.tasks).sort())) throw new Error("Assignment task scope/setup/checks differ from committed component plan");
    return { assignment, historyRevision, coordinationBranch: snapshot.manifest.coordinationBranch, execution, plan };
  }
  async inspect(options: ComponentInspection) {
    const { assignment, historyRevision, execution, plan } = this.assignmentContext(options);
    const stateDir = execution.runtimeDir;
    if (process.platform === "win32") {
      assertWindowsContextHost(stateDir);
      validateWindowsContextInventory(windowsContextRequest(stateDir, { assignment, contextPaths: expectedContextPaths({ stateDir, assignment }) }));
    }
    const settings = [assignment.settings.implementation, ...Object.values(assignment.settings.tasks), assignment.settings.review, assignment.settings.repair];
    for (const harnessId of new Set(settings.map(setting => setting.harness ?? "codex"))) {
      const capability = await getHarness(harnessId).capabilities(this.repo.root, settings.find(setting => (setting.harness ?? "codex") === harnessId));
      if (!capability.installed || !capability.supported || !capability.features.supervisedExecution || !capability.features.sessionOwnership || !capability.features.workerReports)
        throw new Error(`Harness ${harnessId} cannot execute assignment: ${capability.reasons.join("; ")}`);
      for (const setting of settings.filter(setting => (setting.harness ?? "codex") === harnessId)) {
        const effort = setting.effort ?? setting.reasoningEffort;
        if (effort && (!capability.features.effort || (capability.supportedEfforts && !capability.supportedEfforts.includes(effort)))) throw new Error(`Harness ${harnessId} lacks approved effort ${effort}`);
      }
    }
    const resources = decodeResources({ value: options.resources, defaults: { terminal: plan.config.terminal, worktrees: plan.config.worktrees, worktreeRoot: execution.worktreeRoot } });
    if (assignment.version === 2) {
      if (relative(execution.worktreeRoot, resources.worktreeRoot)) throw new Error("Store assignment worktrees must use their Store runtime location");
      resources.worktreeRoot = execution.worktreeRoot;
    }
    const old = readComponentBinding({ stateDir, change: assignment.change });
    if (old && old.phase !== "retired" && digest(old.assignment) !== digest(assignment)) throw new Error("A different assignment already reserves local component execution; explicitly retire it before replacement");
    const payload = { assignment, historyRevision, resources };
    return { ...payload, token: digest(payload), change: assignment.change, repository: this.repository,
      context: assignmentContexts(assignment).map(context => ({ repository: context.repository, revision: context.revision, fingerprint: context.fingerprint, paths: context.files.map(file => file.path) })) };
  }
  private materialize(context: { files: ContextFile[] }, root: string) {
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
    const assignment = preview.assignment;
    if (assignment.version === 2) {
      const { historyRevision } = preview;
      const execution = resolveExecutionContext({ implementationRoot: this.repo.root, change: assignment.change,
        store: { storeRoot: inspection.storeRoot, featureId: assignment.featureId, componentId: assignment.componentId,
          assignmentId: assignment.id, source: assignment.planningSource } });
      const stateDir = execution.runtimeDir, path = componentBindingPath({ stateDir, change: assignment.change });
      const store = repository(inspection.storeRoot);
      const exclude = unredirectedStorePath(store.common, "info", "exclude");
      if (git(store.root, "ls-files", "--", ".openspec-runner")) throw new Error("Store runtime must be untracked");
      const binding = locked(stateDir, () => {
        const authority = new CoordinationStore({ root: store.root, featureId: assignment.featureId });
        const branch = authority.readManifest({ revision: historyRevision }).coordinationBranch;
        const currentRef = `refs/heads/${branch}^{commit}`;
        const current = this.assignmentContext({ ...inspection, historyRevision: git(store.root, "rev-parse", currentRef) });
        if (digest(current.assignment) !== digest(assignment) || (!inspection.historyRevision && current.historyRevision !== historyRevision))
          throw new Error("Assignment or Store history changed during inspection");
        if (current.coordinationBranch !== branch) throw new Error("Declared coordination branch changed since inspection");
        if (inspection.historyRevision) git(store.root, "merge-base", "--is-ancestor", historyRevision, current.historyRevision);
        unredirectedStorePath(stateDir, path);
        if (existsSync(retirementPath(stateDir, assignment.featureId, assignment.id))) throw new Error("Assignment is retired");
        const old = storeReservation(stateDir, assignment);
        if (old && (old.token !== token || !["reserved", "ready"].includes(old.phase))) throw new Error("Store import reservation differs; reconcile existing execution");
        if (!old && (existsSync(featurePath(stateDir, assignment.change)) || existsSync(resolve(stateDir, `${assignment.change}.json`))))
          throw new Error("Existing managed execution cannot be replaced by assignment import");
        const binding: ComponentBinding = { version: 1, phase: "reserved", repository: this.repository, change: assignment.change,
          assignmentId: assignment.id, featureId: assignment.featureId, historyRevision, token, assignment,
          contextPaths: expectedContextPaths({ stateDir, assignment }), resources: preview.resources };
        if (git(store.root, "rev-parse", currentRef) !== current.historyRevision)
          throw new Error("Store authority changed during import; inspect again");
        const excludes = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
        if (!excludes.split(/\r?\n/).includes("/.openspec-runner/")) appendFileSync(exclude, "\n/.openspec-runner/\n");
        withStoreOwnership(execution, assignment.base, () => { if (!old) atomic(path, binding); });
        if (process.platform === "win32") sealWindowsContext(windowsContextRequest(stateDir, binding));
        else {
          mkdirSync(unredirectedStorePath(stateDir, dirname(binding.contextPaths[0])), { recursive: true });
          assignmentContexts(assignment).forEach((context, index) => {
            const root = binding.contextPaths[index];
            assertDeclaredSnapshotEntries(root, context.files, true);
            this.materialize(context, root);
          });
        }
        validateDelegatedBinding(delegationForBinding({ stateDir, binding }));
        return old ?? binding;
      });
      const feature = new Feature(this.repo.root, undefined, execution);
      const delegated = delegationForBinding({ stateDir, binding });
      const approval: FeatureApproval = { token: digest(assignment), fingerprint: assignment.planFingerprint, base: assignment.base,
        ...structuredClone(assignment.settings), at: assignment.createdAt };
      feature.bindAssignment({ change: assignment.change, approval, delegated });
      return feature.runner.lock(() => {
        const current = this.assignmentContext({ ...inspection, historyRevision: undefined });
        if (digest(current.assignment) !== digest(assignment)) throw new Error("Store assignment changed during activation");
        const saved = readComponentBinding({ stateDir, change: assignment.change });
        if (!saved || saved.token !== token || !["reserved", "ready"].includes(saved.phase)) throw new Error("Store reservation changed during activation");
        validateDelegatedBinding(delegated);
        saved.phase = "ready";
        atomic(path, saved);
        return saved;
      });
    }
    const feature = this.feature(), path = this.bindingPath(assignment.change);
    const windows = process.platform === "win32";
    const binding = feature.runner.lock(() => {
      if (existsSync(retirementPath(this.repo.stateDir, assignment.featureId, assignment.id)))
        throw new Error("Assignment retired during inspection; import a different approved assignment");
      const old = this.readBinding({ change: assignment.change });
      if (old && old.phase !== "retired") {
        if (old.token !== token || digest(old.assignment) !== digest(assignment)) throw new Error("Import reservation differs; reconcile inspected history");
        if (windows) {
          if (old.phase === "ready") validateDelegatedBinding(feature.read(assignment.change).delegated!);
          else {
            feature.runner.assertNoActiveWorkers();
            sealWindowsContext(windowsContextRequest(this.repo.stateDir, old));
          }
        }
        return old;
      }
      if (existsSync(featurePath(this.repo.stateDir, assignment.change)) || feature.runner.read(assignment.change)) throw new Error("Existing managed local execution cannot be replaced by assignment import");
      if (windows) {
        feature.runner.assertNoActiveWorkers();
        probeWindowsContext(this.repo.stateDir);
      }
      const contextPaths = expectedContextPaths({ stateDir: this.repo.stateDir, assignment });
      const reserved: ComponentBinding = { version: 1, phase: "reserved", repository: this.repository, change: assignment.change,
        assignmentId: assignment.id, featureId: assignment.featureId, historyRevision: preview.historyRevision, token, assignment, contextPaths, resources: preview.resources };
      atomic(path, reserved);
      if (windows) sealWindowsContext(windowsContextRequest(this.repo.stateDir, reserved));
      return reserved;
    });
    if (windows && binding.phase === "ready") return binding;
    if (!windows) {
      const contextParent = dirname(binding.contextPaths[0]);
      mkdirSync(contextParent, { recursive: true });
      assignmentContexts(assignment).forEach((context, index) => this.materialize(context, binding.contextPaths[index]));
    }
    const delegated = delegationForBinding({ stateDir: this.repo.stateDir, binding });
    const approval: FeatureApproval = { token: digest(assignment), fingerprint: assignment.planFingerprint, base: assignment.base,
      ...structuredClone(assignment.settings), at: assignment.createdAt };
    feature.bindAssignment({ change: assignment.change, approval, delegated });
    feature.runner.lock(() => {
      const current = this.readBinding({ change: assignment.change });
      if (!current || !["reserved", "ready"].includes(current.phase) || current.token !== binding.token || digest(current.assignment) !== digest(assignment))
        throw new Error("Assignment binding changed or retired during import");
      if (windows) verifyWindowsContext(windowsContextRequest(this.repo.stateDir, current));
      binding.phase = "ready"; atomic(path, binding);
    });
    if (!windows) validateDelegatedBinding(delegated);
    return binding;
  }
  submissionPreview(options: { change: string; outcome: SubmissionRecord["outcome"]; reason?: string }) {
    this.feature().runner.assertExecutionAuthority(options.change);
    assertRepositoryIdentity({ root: this.repo.root, repository: this.repository });
    const binding = this.readBinding(options);
    if (!binding || binding.phase !== "ready") throw new Error("Component requires completed assignment import");
    const feature = this.feature(), state = feature.read(options.change);
    if (!state.delegated) throw new Error("Missing delegated assignment binding");
    validateDelegatedBinding(state.delegated);
    if (!["completed", "blocked", "failed"].includes(options.outcome)) throw new Error("Invalid submission outcome");
    if (options.outcome !== "completed" && !options.reason?.trim()) throw new Error("Blocked/failed submission requires concrete reason");
    const assignment = binding.assignment;
    const payload = { assignmentId: assignment.id, owner: assignment.owner, repository: assignment.repository,
      change: assignment.change, outcome: options.outcome, ...(options.reason === undefined ? {} : { reason: options.reason }),
      base: assignment.base, planFingerprint: assignment.planFingerprint, contractFingerprint: assignment.contract.fingerprint,
      ...(assignment.version === 2 ? { planningRevision: assignment.planningSource.revision } : {}) };
    if (options.outcome !== "completed") return { ...payload, tasks: [], verification: [], token: digest(payload) };
    const evidence = feature.submissionEvidence(options);
    const completed = { ...payload, result: { branch: evidence.branch, commit: evidence.commit }, tasks: evidence.tasks,
      review: evidence.review, verification: evidence.verification };
    return { ...completed, token: digest(completed) };
  }
  exportSubmission(options: { change: string; outcome: SubmissionRecord["outcome"]; reason?: string; id: string; operationId: string; token: string; createdAt?: string }) {
    const result = this.exportSubmissionCore(options);
    return { ...result, ...(options.outcome === "completed" ? { summary: safeComponentSummary(this.repo.root, options.change, result.record.id, this.execution) } : {}) };
  }
  private exportSubmissionCore(options: { change: string; outcome: SubmissionRecord["outcome"]; reason?: string; id: string; operationId: string; token: string; createdAt?: string }) {
    const version = this.readBinding(options)?.assignment.version;
    validateId({ value: options.id, version }); validateId({ value: options.operationId, version });
    const path = resolve(this.repo.stateDir, "submissions", `${options.id}.json`);
    return this.feature().runner.lock(() => {
      if (existsSync(path)) {
        const saved = json<{ input: object; token: string; record: SubmissionRecord; bytes: string }>(path);
        if (digest(saved.input) !== digest(options)) throw new Error("Immutable submission export identity differs");
        if (process.platform === "win32") {
          const state = readFeature(this.repo.stateDir, options.change);
          if (!state?.delegated || this.readBinding(options)?.phase !== "ready")
            throw new Error("Component requires completed assignment import");
          validateDelegatedBinding(state.delegated);
        }
        decodeRecord({ value: saved.bytes });
        return { record: saved.record, bytes: saved.bytes };
      }
      const preview = this.submissionPreview(options);
      if (!options.token || options.token !== preview.token) throw new Error("Submission token is stale; preview again");
      const binding = this.readBinding(options)!;
      const { token, verification, ...payload } = preview;
      const identity = { version: binding.assignment.version, kind: "submission", id: options.id, operationId: options.operationId,
        featureId: binding.featureId, createdAt: options.createdAt ?? new Date().toISOString() };
      decodeRecord({ value: { ...identity, ...payload, verification: [] } });
      const checks = options.outcome === "completed" ? binding.assignment.settings.verifyIntegration.map(command =>
        verificationCommand({ root: this.feature().runner.read(options.change)!.integration.path, commit: "result" in preview ? preview.result.commit : "", command })) : [];
      if (checks.some(check => check.exitCode !== 0)) throw new Error("Required submission verification failed");
      // Revalidate after checks so they cannot mutate the reviewed snapshot.
      if (this.submissionPreview(options).token !== preview.token) throw new Error("Submission changed during verification");
      const component = `component:${binding.assignment.componentId}`, integration = this.feature().runner.read(options.change)!.integration.path;
      const roots = [{ path: this.repo.root, identity: component }, { path: this.repo.common, identity: `${component}:git` },
        { path: this.repo.stateDir, identity: `${component}:runtime` }, { path: binding.resources.worktreeRoot, identity: `${component}:worktrees` },
        { path: integration, identity: component }];
      const record = decodeRecord({ value: { ...identity, ...payload, verification: checks.map(evidence => portableVerificationEvidence({ evidence, roots })) } }) as SubmissionRecord;
      if (record.version === 2 && record.outcome === "completed") validateStoreSubmission({ root: this.repo.root, assignment: binding.assignment, receipt: record });
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
    return { ...binding, imported: true as const, inspectedHistory, revoked, nextAction: binding.phase === "retired" ? "Import a different approved assignment; old evidence and resources are retained" : binding.phase === "retiring" ? "Resume the same retirement confirmation" : revoked ? "Stop and reconcile with coordinator" : "Execute, review, then export component receipt" };
  }
}
