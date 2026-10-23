import { existsSync, realpathSync } from "node:fs";
import { CoordinationStore, decodeManifest, stableDigest, replayStatus, type FeatureManifest, type ApprovalRecord, type ComponentSnapshot, type CoordinationSnapshot, type AssignmentRecord, type CoordinationEvent, type SubmissionRecord, type VerificationEvidence, decodeRecord, validateId, type ArchiveScope, type ArchiveBases } from "./coordination-state.js";
import { committedBlob, pinContext, pinReferenceContext, repinContext, contextFingerprint, type ResolvedContext } from "./openspec-context.js";
import { loadPlan, assertCommitted, readiness, tasksFrom } from "./plan.js";
import { resolveFeatureApprovalSettings } from "./feature.js";
import { resolve } from "node:path";
import { committedPlan, exactCheckout, removeExactCheckout, portableVerificationEvidence, verificationCommand } from "./submission.js";
import { git, gitRaw, attempt, run, repository, atomic, json, clean, locked } from "./system.js";
import { affectedDependents, dependencyBlockers } from "./coordination-dependencies.js";
import { recordTupleReview, type ReviewStage, type TupleReviewMutation, type TupleReviewPreview } from "./coordination-review.js";

import { deliveryEvidence, changedPaths, pathState, deliveredPlan, acceptDeliveredSnapshot, type MergeInput, type DeliveredReview } from "./coordination-delivery.js";
import { coordinationOperation } from "./coordination-operation.js";
import { normalizeArchiveScope, archiveTarget, prepareApprovedArchive, inspectArchivePreparation, recoverArchivePreparation, archiveDeliveryEvidence, type ArchivePreview } from "./coordination-archive.js";

export interface ContextInput {
  repository: string;
  context: ResolvedContext;
  revision?: string;
  relevantPaths?: string[];
}
export interface CanonicalReferenceInput {
  repository: string;
  root: string;
  storeId?: string;
  revision?: string;
  relevantPaths?: string[];
}
export type ReferenceInput = ContextInput | CanonicalReferenceInput;
export interface ApprovalInputs { contract: ContextInput; references?: ReferenceInput[] }
export interface MutationIdentity { id: string; operationId: string; expectedHead: string; createdAt?: string }
export function assertRepositoryIdentity(options: { root: string; repository: string }) {
  const identity = attempt(() => git(options.root, "config", "--get", "openspec-runner.repository")) ??
    attempt(() => git(options.root, "remote", "get-url", "origin"));
  if (!identity || identity !== options.repository) throw new Error(`Repository identity mismatch: expected ${options.repository}; set openspec-runner.repository or use its exact origin identity`);
}
/** Latest introduction on the declared branch's first-parent history is authoritative. */
export function currentApproval(options: { store: CoordinationStore; snapshot: CoordinationSnapshot }): ApprovalRecord | undefined {
  return options.store.authoritativeApproval({ snapshot: options.snapshot });
}
export function coordinationRevision(options: { store: CoordinationStore; revision?: string }) {
  const manifest = options.store.readManifest({ revision: options.revision });
  const branchHead = git(options.store.root, "rev-parse", `refs/heads/${manifest.coordinationBranch}^{commit}`);
  if (options.revision) {
    // Locally available history only. Never fetch or use a handoff branch as authority.
    git(options.store.root, "merge-base", "--is-ancestor", options.revision, branchHead);
    return options.revision;
  }
  return branchHead;
}
const digest = (value: unknown) => stableDigest({ value });
function label(value: string, name: string) { if (!value?.trim()) throw new Error(`${name} requires explicit nonempty text`); }

export class Coordination {
  readonly store: CoordinationStore;
  readonly repositories: Record<string, string>;
  constructor(options: { root: string; featureId: string; repositories: Record<string, string> }) {
    this.store = new CoordinationStore(options);
    this.repositories = { ...options.repositories };
  }
  private mapped(repository: string, root?: string) {
    const mapped = this.repositories[repository];
    if (!mapped || (root && realpathSync(mapped) !== realpathSync(root))) throw new Error(`Explicit repository map missing or mismatched for ${repository}`);
    assertRepositoryIdentity({ root: mapped, repository });
    return mapped;
  }
  private pinned(inputs: ApprovalInputs, manifest: FeatureManifest) {
    const contractRoot = this.mapped(inputs.contract.repository, inputs.contract.context.planningRoot);
    if (realpathSync(contractRoot) !== realpathSync(this.store.root) || inputs.contract.context.change !== manifest.sharedChange || inputs.contract.context.storeId !== manifest.storeId)
      throw new Error("Contract Store/change identity mismatch");
    const pin = (input: ReferenceInput) => {
      const root = this.mapped(input.repository, "context" in input ? input.context.planningRoot : input.root);
      const revision = input.revision ?? git(root, "rev-parse", "HEAD");
      return "context" in input ? pinContext({ context: input.context, repository: input.repository, revision, relevantPaths: input.relevantPaths }) :
        pinReferenceContext({ root: input.root, repository: input.repository, revision, storeId: input.storeId, relevantPaths: input.relevantPaths });
    };
    const references = inputs.references ?? [];
    for (const reference of inputs.contract.context.references) {
      if (!references.some(input => ("context" in input ? input.context.storeId : input.storeId) === reference.storeId && realpathSync("context" in input ? input.context.planningRoot : input.root) === realpathSync(reference.root)))
        throw new Error(`Referenced Store ${reference.storeId} requires explicit pinned input and repository map`);
    }
    for (const input of references) if ("context" in input && input.context.references.length) throw new Error("Nested Store references require an explicit flattened reference inventory");
    const contract = pin(inputs.contract);
    if (references.length) {
      contract.references = references.map(pin).sort((a, b) => `${a.repository}/${a.change ?? "canonical"}`.localeCompare(`${b.repository}/${b.change ?? "canonical"}`));
      contract.fingerprint = contextFingerprint(contract);
    }
    return contract;
  }
  private sharedTasks(contract: ReturnType<Coordination["pinned"]>) {
    const tasks = contract.files.find(file => file.path.endsWith(`/changes/${contract.change}/tasks.md`));
    if (!tasks) throw new Error("Committed shared tasks.md is required");
    return tasksFrom(tasks.content);
  }
  initPreview(options: ApprovalInputs & { manifest: FeatureManifest }) {
    const manifest = decodeManifest({ value: options.manifest });
    const contract = this.pinned(options, manifest);
    for (const component of Object.values(manifest.components)) this.mapped(component.repository);
    const payload = { manifest, contract, sharedTasks: this.sharedTasks(contract) };
    decodeManifest({ value: manifest, sharedTasks: payload.sharedTasks });
    return { ...payload, head: git(this.store.root, "rev-parse", "HEAD"), token: digest(payload) };
  }
  init(options: ApprovalInputs & { manifest: FeatureManifest; expectedHead: string; operationId: string }) {
    const preview = this.initPreview(options);
    return this.store.writeManifest({ manifest: preview.manifest, sharedTasks: preview.sharedTasks, expectedHead: options.expectedHead, operationId: options.operationId });
  }
  snapshot(options: { revision?: string } = {}) {
    return this.store.readSnapshot({ revision: coordinationRevision({ store: this.store, revision: options.revision }) });
  }
  status(options: { revision?: string } = {}) {
    const snapshot = this.snapshot(options);
    const approval = currentApproval({ store: this.store, snapshot });
    const result = replayStatus({ snapshot, approvalId: approval?.id });
    try {
      if (!approval) throw new Error("Approve the committed feature inputs");
      if (approval.manifestFingerprint !== digest(snapshot.manifest)) throw new Error("Manifest changed; renew approval");
      if (digest({ manifestFingerprint: approval.manifestFingerprint, contract: approval.contract, components: approval.components, verification: approval.verification }) !== approval.consent.token) throw new Error("Approval consent does not bind approved snapshot");
      if (!options.revision && !this.matchesApprovedContract({ approval, snapshot, completed: result.phase === "completed" })) throw new Error("Approved contract/reference context drifted; renew approval");
      for (const [id, component] of Object.entries(result.components)) {
        const historical = component.mergedHistory?.at(-1), current = approval.components[id];
        if (historical && current && historical.planFingerprint !== current.planFingerprint) {
          const acceptance = snapshot.records.filter((record): record is Extract<CoordinationEvent, { type: "accepted" }> => record.kind === "event" && record.type === "accepted" && record.componentId === id && record.commit === component.acceptedCommit).sort((a, b) => b.sequence - a.sequence)[0];
          const acceptedAssignment = snapshot.records.find((record): record is AssignmentRecord => record.kind === "assignment" && record.id === acceptance?.assignmentId);
          delete component.deliveryCommit;
          if (!acceptedAssignment || acceptedAssignment.approvalId !== approval.id || acceptedAssignment.planFingerprint !== current.planFingerprint) {
            delete component.acceptedCommit;
            component.phase = component.assignmentId ? "assigned" : "planned";
            component.nextAction = "Issue and execute a new assignment for the revised approved component plan";
            result.phase = "implementing"; result.nextAction = "Issue and execute assignments for revised component plans, then accept current results";
          }
        }
        const assignment = snapshot.records.find((record): record is AssignmentRecord => record.kind === "assignment" && record.id === component.assignmentId);
        if (assignment && assignment.approvalId !== approval.id && !component.deliveryCommit) {
          delete component.acceptedCommit; component.blocker = "Assignment approval is stale; revoke and reassign under current approval";
          component.nextAction = "Revoke stale assignment and issue an assignment under current approval"; result.phase = "implementing";
          result.blocker = [result.blocker, `${id}: ${component.blocker}`].filter(Boolean).join("; ");
        }
      }
    } catch (error: any) {
      result.phase = "awaiting-approval"; result.blocker = error.message; result.nextAction = "Preview and approve current committed inputs";
    }
    return result;
  }
  private matchesApprovedContract(options: { approval: ApprovalRecord; snapshot: CoordinationSnapshot; completed: boolean }) {
    try { if (this.freshContract(options.approval).fingerprint === options.approval.contract.fingerprint) return true; } catch { /* A sanctioned archive may move the active files. */ }
    if (!options.completed) return false;
    const completed = options.snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "completed" }> => r.kind === "event" && r.type === "completed").sort((a, b) => b.sequence - a.sequence)[0];
    const prepared = options.snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "archive-prepared" | "archive-delivered" }> => r.kind === "event" && r.type === "archive-prepared" && r.componentId === undefined && r.completionEventId === completed?.id).sort((a, b) => b.sequence - a.sequence)[0];
    if (!prepared) return false;
    const root = this.mapped(options.approval.contract.repository);
    try {
      // Canonical reachability, all produced blobs and every active deletion must match.
      archiveDeliveryEvidence({ store: this.store, root, preparedEventId: prepared.id, deliveryCommit: options.snapshot.head });
      const context = { ...options.approval.contract, files: options.approval.contract.files.filter(file => pathState({ root, commit: prepared.commit, path: file.path }) !== null) };
      const expected = repinContext({ root, revision: prepared.commit, context });
      if (options.approval.contract.references?.length) {
        expected.references = options.approval.contract.references;
        expected.fingerprint = contextFingerprint(expected);
      }
      return this.freshContract({ contract: expected }).fingerprint === expected.fingerprint;
    } catch { return false; }
  }
  approvalPreview(options: ApprovalInputs) {
    const snapshot = this.snapshot(), manifest = snapshot.manifest, contract = this.pinned(options, manifest);
    decodeManifest({ value: manifest, sharedTasks: this.sharedTasks(contract) });
    const components: Record<string, ComponentSnapshot> = {};
    for (const [componentId, definition] of Object.entries(manifest.components)) {
      const root = this.mapped(definition.repository), plan = loadPlan(root, definition.change);
      assertCommitted(root, plan); readiness(root, definition.change); run("openspec", ["validate", definition.change, "--strict", "--json"], root);
      const { implementation, tasks, review, repair } = resolveFeatureApprovalSettings({ plan, input: definition.settings });
      if (digest(definition.settings.verifyIntegration) !== digest(plan.config.verifyIntegration) ||
          (definition.settings.setup && digest(definition.settings.setup) !== digest(plan.config.setup))) throw new Error("Manifest checks/setup differ from committed component plan");
      components[componentId] = { repository: definition.repository, change: definition.change, base: git(root, "rev-parse", "HEAD"), planFingerprint: plan.fingerprint,
        settings: { implementation, tasks, review, repair, maxFixRounds: definition.settings.maxFixRounds,
          verifyIntegration: structuredClone(plan.config.verifyIntegration), setup: structuredClone(plan.config.setup) } };
    }
    const payload = { manifestFingerprint: digest(manifest), contract, components, verification: manifest.verification };
    return { ...payload, token: digest(payload), head: snapshot.head };
  }
  approve(options: ApprovalInputs & MutationIdentity & { token: string; approvedBy: string }) {
    label(options.approvedBy, "consent approvedBy");
    const existing = this.store.readRecord({ kind: "approval", id: options.id });
    if (existing?.kind === "approval") {
      if (existing.operationId !== options.operationId || existing.consent.token !== options.token || existing.consent.approvedBy !== options.approvedBy) throw new Error("Immutable approval identity differs");
      return this.store.writeRecord({ record: existing, expectedHead: options.expectedHead });
    }
    const preview = this.approvalPreview(options);
    if (!options.token || options.token !== preview.token) throw new Error("Approval token is stale; inspect current committed inputs");
    const { token, head, ...payload } = preview;
    const record: ApprovalRecord = { ...this.identity(options), kind: "approval", ...payload, consent: { token, approvedBy: options.approvedBy } };
    return this.store.writeRecord({ record, expectedHead: options.expectedHead });
  }
  private identity(options: MutationIdentity) {
    return { version: 1 as const, id: options.id, featureId: this.store.featureId, operationId: options.operationId, createdAt: options.createdAt ?? new Date().toISOString() };
  }
  assignmentPreview(options: ApprovalInputs & { componentId: string; owner: string }) {
    label(options.owner, "owner");
    const snapshot = this.snapshot(), approval = currentApproval({ store: this.store, snapshot });
    if (!approval) throw new Error("Approve the committed inputs before assignment");
    const preview = this.approvalPreview(options);
    // Revisions record provenance; only relevant content drift invalidates approval.
    const inputIdentity = (value: typeof preview) => ({ manifestFingerprint: value.manifestFingerprint, contractFingerprint: value.contract.fingerprint, components: value.components, verification: value.verification });
    if (digest(inputIdentity(preview)) !== digest(inputIdentity({ ...approval, token: approval.consent.token, head: snapshot.head }))) throw new Error("Approved inputs drifted; renew approval");
    const component = approval.components[options.componentId];
    if (!component) throw new Error("Unknown component");
    const status = this.status({});
    if (status.components[options.componentId].assignmentId) throw new Error("Component already has an active assignment");
      const historical = status.components[options.componentId].mergedHistory?.at(-1);
      if (historical && (historical.approvalId === approval.id || historical.planFingerprint === component.planFingerprint)) throw new Error("Further implementation of a merged component requires a revised plan and renewed approval");
      const blockers = dependencyBlockers({ manifest: snapshot.manifest, componentId: options.componentId, components: status.components });
      if (blockers.length) throw new Error(blockers.join("; "));
    const dependencies = snapshot.manifest.components[options.componentId].dependencies.map(dependency => {
      const upstream = status.components[dependency.componentId], commit = dependency.milestone === "merged" ? upstream.deliveryCommit : upstream.acceptedCommit;
      if (!commit) throw new Error(`Dependency ${dependency.componentId} requires ${dependency.milestone}`);
      return { ...dependency, commit };
    });
    const payload = { approvalId: approval.id, componentId: options.componentId, owner: options.owner, ...component, contract: approval.contract, dependencies };
    return { ...payload, token: digest(payload), head: snapshot.head };
  }
  assign(options: ApprovalInputs & MutationIdentity & { componentId: string; owner: string; token: string }) {
    const existing = this.store.readRecord({ kind: "assignment", id: options.id });
    if (existing?.kind === "assignment") {
      const { version, id, featureId, operationId, createdAt, kind, ...payload } = existing;
      if (operationId !== options.operationId || existing.owner !== options.owner || existing.componentId !== options.componentId || digest(payload) !== options.token) throw new Error("Immutable assignment identity differs");
      return this.store.writeRecord({ record: existing, expectedHead: options.expectedHead });
    }
    const preview = this.assignmentPreview(options);
    if (!options.token || options.token !== preview.token) throw new Error("Assignment token is stale");
    const { token, head, ...payload } = preview;
    const record: AssignmentRecord = { ...this.identity(options), kind: "assignment", ...payload };
    return this.store.writeRecord({ record, expectedHead: options.expectedHead });
  }
  importSubmission(options: { bytes: Buffer | string; expectedHead: string }) {
    const bytes = Buffer.from(options.bytes), record = decodeRecord({ value: bytes.toString("utf8") });
    if (record.kind !== "submission") throw new Error("Import requires a submission receipt");
    // Import retains stale/revoked/failed claims for inspection; acceptance is a separate action.
    return this.store.writeRecord({ record, bytes, expectedHead: options.expectedHead });
  }
  private freshContract(assignment: Pick<AssignmentRecord, "contract">, inputs?: ApprovalInputs) {
    const snapshot = this.snapshot();
    const approved = [assignment.contract, ...(assignment.contract.references ?? [])];
    const scoped = approved.map(context => {
      if (context.selections) return context;
      // Legacy pins cannot attest custom selector roots. Prove the historical default
      // inventory before using a conservative default-scope fallback.
      const root = this.mapped(context.repository), revision = context.revision;
      const suffix = context.change ? `changes/${context.change}/` : undefined;
      const active = suffix ? context.files.find(file => file.path.includes(suffix)) : undefined;
      const canonical = context.files.find(file => file.path.includes("openspec/"));
      const prefix = canonical ? canonical.path.slice(0, canonical.path.indexOf("openspec/")) : "";
      const planningRoot = resolve(root, prefix);
      const historical = context.change && active && suffix ? pinContext({ repository: context.repository, revision,
        context: { implementationRoot: root, planningRoot, changeRoot: resolve(root, active.path.slice(0, active.path.indexOf(suffix) + suffix.length - 1)),
          change: context.change, source: "store", storeId: context.storeId, artifactPaths: [], references: [] } }) :
        pinReferenceContext({ repository: context.repository, root: planningRoot, revision, storeId: context.storeId });
      if (contextFingerprint({ files: historical.files }) !== contextFingerprint({ files: context.files }))
        throw new Error("Legacy custom selection scope cannot be reconstructed safely; renew approval with portable selections");
      return { ...context, selections: historical.selections };
    });
    const scopeIdentity = (contexts: typeof scoped) => contexts.map(context => ({ repository: context.repository,
      change: context.change ?? null, storeId: context.storeId ?? null, selections: context.selections })).sort((a, b) => digest(a).localeCompare(digest(b)));
    if (inputs) {
      const candidate = this.pinned({ contract: { ...inputs.contract, revision: snapshot.head },
        references: inputs.references?.map(input => ({ ...input, revision: git(this.mapped(input.repository), "rev-parse", "HEAD") })) }, snapshot.manifest);
      if (digest(scopeIdentity([candidate, ...(candidate.references ?? [])])) !== digest(scopeIdentity(scoped)))
        throw new Error("Context selection scope drifted from approval; selectors cannot be narrowed or replaced");
    }
    const refreshed = scoped.map((context, index) => {
      const root = this.mapped(context.repository), revision = index === 0 ? snapshot.head : git(root, "rev-parse", "HEAD");
      const fresh = repinContext({ root, revision, context });
      if (!approved[index].selections) { delete fresh.selections; fresh.fingerprint = contextFingerprint({ files: fresh.files }); }
      return fresh;
    });
    const contract = refreshed[0];
    if (refreshed.length > 1) { contract.references = refreshed.slice(1); contract.fingerprint = contextFingerprint(contract); }
    return contract;
  }
  acceptancePreview(options: { submissionId: string; inputs?: ApprovalInputs }) {
    const snapshot = this.snapshot(), status = this.status(), approval = currentApproval({ store: this.store, snapshot });
    const receipt = snapshot.records.find((record): record is SubmissionRecord => record.kind === "submission" && record.id === options.submissionId);
    if (!receipt) throw new Error("Submission not present in authoritative committed history");
    const assignment = snapshot.records.find((record): record is AssignmentRecord => record.kind === "assignment" && record.id === receipt.assignmentId);
    if (!assignment || status.components[assignment.componentId]?.assignmentId !== assignment.id) throw new Error("Assignment is revoked or no longer active");
    if (!approval || approval.id !== assignment.approvalId || approval.manifestFingerprint !== digest(snapshot.manifest)) throw new Error("Assignment approval is stale; renew approval");
    const blockers = dependencyBlockers({ manifest: snapshot.manifest, componentId: assignment.componentId, components: status.components, assignment });
    if (status.components[assignment.componentId].dependencyStale || blockers.length) throw new Error(`Assignment has stale upstream dependencies: ${blockers.join("; ") || "upstream acceptance changed; revoke and reassign"}`);
    const historical = status.components[assignment.componentId].mergedHistory?.at(-1);
    if (historical && (historical.approvalId === assignment.approvalId || historical.planFingerprint === assignment.planFingerprint)) throw new Error("Further merged-component acceptance requires a revised plan and renewed approval");
    if (digest({ manifestFingerprint: approval.manifestFingerprint, contract: approval.contract, components: approval.components, verification: approval.verification }) !== approval.consent.token)
      throw new Error("Approval consent does not bind approved snapshot");
    if (status.submissions[receipt.id]?.disposition === "stale") throw new Error("Submission assignment/input identity is stale");
    if (receipt.outcome !== "completed" || !receipt.result || !receipt.review) throw new Error("Acceptance requires a completed receipt");
    if (receipt.review.commit !== receipt.result.commit || receipt.review.findings.some(finding => ["correctness", "security", "spec", "verification"].includes(finding.category)))
      throw new Error("Receipt requires exact-commit review without blocking findings");
    const contract = this.freshContract(assignment, options.inputs);
    if (contract.fingerprint !== assignment.contract.fingerprint) throw new Error("Approved contract/reference context drifted; renew approval");
    const root = this.mapped(receipt.repository), commit = receipt.result.commit;
    if (attempt(() => git(root, "rev-parse", `${commit}^{commit}`)) !== commit) throw new Error(`Submitted commit ${commit} unavailable in mapped repository ${receipt.repository}; retrieve result branch ${receipt.result.branch} explicitly`);
    if (attempt(() => git(root, "merge-base", "--is-ancestor", assignment.base, commit)) === undefined) throw new Error("Assigned base is not an ancestor of submitted commit");
    const base = committedPlan({ root, change: assignment.change, commit: assignment.base });
    const plan = committedPlan({ root, change: assignment.change, commit });
    if (base.fingerprint !== assignment.planFingerprint || plan.fingerprint !== assignment.planFingerprint) throw new Error("Submitted planning artifacts drifted from approved plan");
    if (digest(plan.tasks) !== digest(receipt.tasks) || !plan.tasks.every(task => task.completed) ||
        digest(plan.tasks.map(task => task.id).sort()) !== digest(Object.keys(assignment.settings.tasks).sort())) throw new Error("Canonical task completion does not match receipt and approved task scope");
    if (digest(plan.verification) !== digest(assignment.settings.verifyIntegration) || digest(plan.setup) !== digest(assignment.settings.setup ?? [])) throw new Error("Approved checks/setup drifted");
    if (receipt.verification.some(check => check.exitCode !== 0) || digest(receipt.verification.map(check => check.command)) !== digest(assignment.settings.verifyIntegration)) throw new Error("Receipt required verification evidence is missing or failed");
    const changedPaths = gitRaw(root, "diff", "--name-only", "-z", assignment.base, commit).split("\0").filter(Boolean).sort();
    const dependents = affectedDependents({ manifest: snapshot.manifest, componentId: assignment.componentId });
    const payload = { assignment, receipt, componentId: assignment.componentId, commit, branch: receipt.result.branch,
      changedPaths, verification: assignment.settings.verifyIntegration, findings: receipt.review.findings, dependents,
      approvalId: approval.id, contractFingerprint: contract.fingerprint };
    return { ...payload, head: snapshot.head, token: digest(payload) };
  }
  accept(options: MutationIdentity & { submissionId: string; token: string; inputs?: ApprovalInputs }) {
    validateId({ value: options.id }); validateId({ value: options.operationId });
    const runtime = repository(this.store.root).stateDir, journalPath = resolve(runtime, "acceptance", `${options.operationId}.json`);
    return locked(runtime, () => {
      type Journal = { input: { id: string; operationId: string; submissionId: string; token: string; expectedHead: string; createdAt?: string };
        preview: ReturnType<Coordination["acceptancePreview"]>; createdAt: string; stage: "reserved" | "checking" | "verified" | "failed";
        expectedHead: string; checkIndex: number; running?: number; evidence: VerificationEvidence[]; reason?: string; pendingEvent?: CoordinationEvent };
      const { inputs, ...input } = options;
      let journal = existsSync(journalPath) ? json<Journal>(journalPath) : undefined;
      if (journal && digest(journal.input) !== digest(input)) throw new Error("Immutable acceptance operation identity differs");
      const snapshot = this.snapshot();
      if (git(this.store.root, "branch", "--show-current") !== snapshot.manifest.coordinationBranch) throw new Error("Acceptance mutation requires declared coordination branch");
      if (!journal) {
        if (snapshot.head !== options.expectedHead || !clean(this.store.root)) throw new Error("Acceptance requires expected head and clean Store checkout");
        if (snapshot.records.some(record => record.id === options.id && record.kind === "event")) throw new Error("Acceptance identity already exists without coordinator operation evidence");
        const preview = this.acceptancePreview(options);
        if (!options.token || options.token !== preview.token) throw new Error("Acceptance token is stale; preview again");
        journal = { input, preview, createdAt: options.createdAt ?? new Date().toISOString(), stage: "reserved", expectedHead: options.expectedHead, checkIndex: 0, evidence: [] };
        atomic(journalPath, journal);
      }
      const save = () => atomic(journalPath, journal);
      const assertVerified = () => {
        if (journal!.stage !== "verified" || journal!.running !== undefined ||
            journal!.checkIndex !== (journal!.preview.assignment.settings.setup ?? []).length + journal!.preview.verification.length ||
            journal!.evidence.some(check => check.exitCode !== 0 || !check.evidence?.trim()) ||
            digest(journal!.evidence.map(check => check.command)) !== digest(journal!.preview.verification))
          throw new Error("Coordinator verification evidence is incomplete or failed");
      };
      const portableEvidence = () => {
        const component = `component:${journal!.preview.componentId}`;
        const roots = Object.entries(this.repositories).flatMap(([id, path]) => {
          const repo = repository(path), identity = id === journal!.preview.receipt.repository ? component : `repository:${id}`;
          return [{ path: repo.root, identity }, { path: repo.common, identity: `${identity}:git` }, { path: repo.stateDir, identity: `${identity}:runtime` }];
        });
        roots.push({ path: resolve(repository(this.mapped(journal!.preview.receipt.repository)).stateDir, "acceptance-checkouts", options.operationId), identity: component });
        return journal!.evidence.map(evidence => portableVerificationEvidence({ evidence, roots }));
      };
      const savedAcceptance = (record: NonNullable<ReturnType<CoordinationStore["readRecord"]>>) => {
        assertVerified();
        if (record.kind !== "event" || record.type !== "accepted") throw new Error("Immutable coordinator event identity differs");
        const expected = { version: 1, kind: "event", featureId: this.store.featureId, id: options.id, operationId: options.operationId,
          createdAt: journal!.createdAt, sequence: record.sequence, type: "accepted", componentId: journal!.preview.componentId,
          assignmentId: journal!.preview.assignment.id, submissionId: options.submissionId, commit: journal!.preview.commit, verification: record.verification };
        if (digest(record) !== digest(expected) || (options.createdAt !== undefined && record.createdAt !== options.createdAt) ||
            journal!.preview.token !== options.token || journal!.preview.receipt.id !== options.submissionId ||
            journal!.preview.receipt.assignmentId !== journal!.preview.assignment.id ||
            journal!.preview.assignment.componentId !== journal!.preview.componentId || journal!.preview.receipt.result?.commit !== journal!.preview.commit)
          throw new Error("Immutable coordinator event identity differs");
        // Existing immutable events may predate output normalization. Accept only the exact
        // raw journal evidence or its current portable representation, without rewriting either.
        if (digest(record.verification) !== digest(journal!.evidence) && digest(record.verification) !== digest(portableEvidence()))
          throw new Error("Immutable coordinator verification evidence differs");
        return record;
      };
      if (journal.pendingEvent) {
        const pending = journal.pendingEvent;
        if (pending.id === options.id) savedAcceptance(pending);
        else {
          const phase = pending.id === `${options.id}-started` ? "started" : pending.id === `${options.id}-finished` ? "finished" : undefined;
          const expected = { version: 1, kind: "event", featureId: this.store.featureId, id: `${options.id}-${phase}`,
            operationId: `${options.operationId}-${phase}`, createdAt: journal.createdAt, sequence: pending.sequence,
            type: `operation-${phase}`, targetOperationId: options.operationId, action: "acceptance", snapshotToken: options.token };
          if (!phase || digest(pending) !== digest(expected) || (options.createdAt !== undefined && pending.createdAt !== options.createdAt))
            throw new Error("Immutable coordinator event identity differs");
        }
        const recovered = this.store.writeRecord({ record: journal.pendingEvent, expectedHead: journal.expectedHead });
        journal.expectedHead = recovered.head; delete journal.pendingEvent; save();
      }
      if (this.snapshot().head !== journal.expectedHead) throw new Error("Coordination head changed since acceptance intent; reconcile history");
      const sequence = () => Math.max(0, ...this.snapshot().records.filter((record): record is CoordinationEvent => record.kind === "event").map(record => record.sequence)) + 1;
      const event = (id: string, operationId: string, payload: object) => ({ version: 1, kind: "event", featureId: this.store.featureId,
        id, operationId, createdAt: journal!.createdAt, sequence: sequence(), ...payload }) as CoordinationEvent;
      const write = (record: CoordinationEvent) => {
        const existing = this.store.readRecord({ kind: "event", id: record.id });
        if (existing && (existing.kind !== "event" || existing.operationId !== record.operationId ||
            digest({ ...existing, sequence: 0 }) !== digest({ ...record, sequence: 0 }))) throw new Error("Immutable coordinator event identity differs");
        if (existing) return { path: `${this.store.directory}/events/${record.id}.json`, created: false, head: journal!.expectedHead, operationId: record.operationId };
        journal!.pendingEvent = record; save();
        const result = this.store.writeRecord({ record, expectedHead: journal!.expectedHead });
        journal!.expectedHead = result.head; delete journal!.pendingEvent; save(); return result;
      };
      write(event(`${options.id}-started`, `${options.operationId}-started`, { type: "operation-started", targetOperationId: options.operationId, action: "acceptance", snapshotToken: options.token }));
      const accepted = this.store.readRecord({ kind: "event", id: options.id });
      if (accepted) {
        if (journal.stage !== "verified") throw new Error("Recorded acceptance lacks verified coordinator journal");
      } else {
        if (journal.stage === "failed") throw new Error(journal.reason ?? "Acceptance checks failed; use a new reviewed operation");
        if (journal.running !== undefined) throw new Error("Interrupted acceptance check has ambiguous side effects; inspect coordinator checkout and reconcile with a new operation");
        if (this.acceptancePreview(options).token !== journal.preview.token) throw new Error("Acceptance inputs drifted since durable intent");
        const root = this.mapped(journal.preview.receipt.repository), path = resolve(repository(root).stateDir, "acceptance-checkouts", options.operationId);
        if (journal.stage !== "verified") {
          exactCheckout({ root, commit: journal.preview.commit, path });
          const setup = journal.preview.assignment.settings.setup ?? [], commands = [...setup, ...journal.preview.verification];
          journal.stage = "checking"; save();
          for (let index = journal.checkIndex; index < commands.length; index++) {
            journal.running = index; save();
            const evidence = verificationCommand({ root: path, commit: journal.preview.commit, command: commands[index] });
            journal.checkIndex = index + 1; delete journal.running;
            if (index >= setup.length) journal.evidence.push(evidence);
            if (evidence.exitCode !== 0) { journal.stage = "failed"; journal.reason = `Required acceptance command failed: ${commands[index].join(" ")}`; save(); throw new Error(journal.reason); }
            save();
          }
          journal.stage = "verified"; save();
        }
        removeExactCheckout({ root, path });
        if (this.acceptancePreview(options).token !== journal.preview.token) throw new Error("Acceptance inputs drifted during checks");
      }
      assertVerified();
      const result = write(accepted ? savedAcceptance(accepted) : event(options.id, options.operationId, { type: "accepted", componentId: journal.preview.componentId,
        assignmentId: journal.preview.assignment.id, submissionId: options.submissionId, commit: journal.preview.commit,
        verification: portableEvidence() }));
      const finished = write(event(`${options.id}-finished`, `${options.operationId}-finished`, { type: "operation-finished", targetOperationId: options.operationId, action: "acceptance", snapshotToken: options.token }));
      return { ...result, head: finished.head };
    });
  }
  reviewPreview(options: { stage: ReviewStage; inputs?: ApprovalInputs }): TupleReviewPreview {
    if (!["combined", "final"].includes(options.stage)) throw new Error("Review stage requires combined or final");
    const snapshot = this.snapshot(), status = this.status(), approval = currentApproval({ store: this.store, snapshot });
    if (!approval || status.phase === "awaiting-approval") throw new Error(status.blocker ?? "Current approval is required before tuple review");
    const contract = this.freshContract(approval, options.inputs);
    if (contract.fingerprint !== approval.contract.fingerprint) throw new Error("Approved contract/reference context drifted; renew approval");
    const tuple: Record<string, string> = {}, components: TupleReviewPreview["components"] = {};
    const milestones: Record<string, string> = {};
    for (const id of Object.keys(snapshot.manifest.components).sort()) {
      const component = status.components[id], commit = options.stage === "combined" ? component.acceptedCommit : component.deliveryCommit;
      if (!commit || component.dependencyStale || component.requiresReapproval) throw new Error(`Every component must be ${options.stage === "combined" ? "accepted" : "merged"} before tuple review: ${id}`);
      const acceptance = snapshot.records.filter((record): record is Extract<CoordinationEvent, { type: "accepted" }> => record.kind === "event" && record.type === "accepted" && record.componentId === id && record.commit === component.acceptedCommit).sort((a, b) => b.sequence - a.sequence)[0];
      const assignment = snapshot.records.find((record): record is AssignmentRecord => record.kind === "assignment" && record.id === acceptance?.assignmentId);
      if (!assignment || assignment.approvalId !== approval.id) throw new Error(`Component ${id} acceptance approval is stale; renew acceptance under current approval`);
      const root = this.mapped(assignment.repository);
      if (attempt(() => git(root, "rev-parse", `${commit}^{commit}`)) !== commit) throw new Error(`Tuple commit ${commit} unavailable in ${assignment.repository}; retrieve explicitly`);
      const plan = committedPlan({ root, change: assignment.change, commit });
      if (plan.fingerprint !== approval.components[id].planFingerprint || !plan.tasks.every(task => task.completed)) throw new Error(`Tuple component ${id} planning/completion drifted`);
      tuple[id] = commit;
      components[id] = { repository: assignment.repository, change: assignment.change, assignmentId: assignment.id, owner: assignment.owner, setup: assignment.settings.setup ?? [] };
      const merge = snapshot.records.filter((record): record is Extract<CoordinationEvent, { type: "merged" }> => record.kind === "event" && record.type === "merged" && record.componentId === id && record.deliveryCommit === commit).sort((a, b) => b.sequence - a.sequence)[0];
      milestones[id] = options.stage === "combined" ? acceptance.id : merge?.id ?? "";
    }
    const payload = { stage: options.stage, tuple, approvalId: approval.id, contractFingerprint: contract.fingerprint, components, verification: approval.verification };
    return { ...payload, head: snapshot.head, token: digest({ ...payload, milestones }) };
  }
  recordReview(options: TupleReviewMutation & { inputs?: ApprovalInputs }) {
    const { inputs, ...input } = options;
    const roots = Object.fromEntries(Object.entries(this.snapshot().manifest.components).map(([id, component]) => [id, this.mapped(component.repository)]));
    return recordTupleReview({ store: this.store, input, roots, preview: () => this.reviewPreview({ stage: input.stage, inputs }) });
  }
  mergePreview(options: MergeInput) {
    const snapshot = this.snapshot(), status = this.status(), definition = snapshot.manifest.components[options.componentId];
    if (!definition) throw new Error("Unknown merge component");
    const root = this.mapped(definition.repository);
    const preview = deliveryEvidence({ snapshot, status, input: options, root });
    deliveredPlan({ root, preview });
    return preview;
  }
  deliveryAcceptancePreview(options: MergeInput) { return this.mergePreview(options); }
  acceptDelivery(options: MutationIdentity & MergeInput & { token: string; review: DeliveredReview }) {
    const definition = this.snapshot().manifest.components[options.componentId];
    if (!definition) throw new Error("Unknown delivery component");
    return acceptDeliveredSnapshot({ store: this.store, root: this.mapped(definition.repository), input: options, preview: () => this.deliveryAcceptancePreview(options) });
  }
  recordMerge(options: MutationIdentity & MergeInput & { token: string }) {
    return coordinationOperation({ store: this.store, input: options, action: "merge", initialize: () => {
      const preview = this.mergePreview(options);
      if (preview.token !== options.token) throw new Error("Merge evidence token is stale");
      if (preview.mismatches.length) {
        const accepted = this.snapshot().records.find((r): r is Extract<CoordinationEvent, { type: "delivery-accepted" }> => r.kind === "event" && r.type === "delivery-accepted" && r.componentId === options.componentId && r.acceptanceId === preview.acceptanceId && r.deliveryCommit === options.deliveryCommit && r.snapshotToken === preview.token);
        if (!accepted || accepted.findings.some(finding => ["correctness", "security", "spec", "verification"].includes(finding.category)) || accepted.verification.some(check => check.exitCode !== 0) || digest(accepted.verification.map(check => check.command)) !== digest(preview.assignment.settings.verifyIntegration)) throw new Error("Changed delivered snapshot requires fresh exact review and independent delivered acceptance");
      }
      return preview;
    }, execute: ({ journal, write }) => {
      if (!this.store.readRecord({ kind: "event", id: options.id }) && this.mergePreview(options).token !== journal.data.token) throw new Error("Merge evidence changed since durable intent");
      return write({ id: options.id, operationId: options.operationId, payload: { type: "merged", ...journal.data.payload } });
    } });
  }
  completionPreview(options: { archive?: ArchiveScope } = {}) {
    const preview = this.reviewPreview({ stage: "final" }), status = this.status(), snapshot = this.snapshot();
    if (!["awaiting-final-approval", "completed"].includes(status.phase)) throw new Error("Latest final merged tuple checks/review must pass before completion");
    const review = snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "reviewed" }> => r.kind === "event" && r.type === "reviewed" && r.stage === "final" && r.snapshotToken === preview.token).sort((a, b) => b.sequence - a.sequence)[0];
    if (!review || review.findings.some(f => ["correctness", "security", "spec", "verification"].includes(f.category))) throw new Error("Latest exact final review required");
    const archive = options.archive ? this.archiveInputs({ scope: options.archive, tuple: preview.tuple, reviewEventId: review.id }) : undefined;
    const payload = { tuple: preview.tuple, reviewEventId: review.id, approvalId: preview.approvalId, reviewToken: preview.token, ...(archive ? { archive: archive.scope, archiveToken: archive.token, archiveBases: this.archiveBases(archive) } : {}) };
    return { ...payload, token: digest(payload), head: snapshot.head };
  }
  complete(options: MutationIdentity & { token: string; approvedBy: string; archive?: ArchiveScope }) {
    label(options.approvedBy, "explicit completion consent");
    return coordinationOperation({ store: this.store, input: options, action: "completion", initialize: () => {
      const preview = this.completionPreview(options);
      if (preview.token !== options.token) throw new Error("Final completion token is stale; inspect current merged tuple/review");
      return preview;
    }, execute: ({ journal, write }) => {
      if (!this.store.readRecord({ kind: "event", id: options.id }) && this.completionPreview(options).token !== journal.data.token) throw new Error("Final tuple/review changed since completion intent");
      return write({ id: options.id, operationId: options.operationId, payload: { type: "completed", tuple: journal.data.tuple, reviewEventId: journal.data.reviewEventId, consent: { token: options.token, approvedBy: options.approvedBy }, ...(journal.data.archive ? { archive: journal.data.archive, archiveToken: journal.data.archiveToken, archiveBases: journal.data.archiveBases } : {}) } });
    } });
  }
  private completedEvent() {
    if (this.status().phase !== "completed") throw new Error("Delivery completion and final approval required before archive actions");
    const snapshot = this.snapshot();
    const event = snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "completed" }> => r.kind === "event" && r.type === "completed").sort((a, b) => b.sequence - a.sequence)[0];
    if (!event) throw new Error("Completed feature record required");
    return event;
  }
  private archiveBases(preview: ArchivePreview): ArchiveBases {
    return { components: Object.fromEntries(Object.values(preview.targets).filter(target => target.componentId).map(target => [target.componentId!, target.base])), ...(preview.targets._store ? { store: preview.targets._store.base } : {}) };
  }
  private archiveInputs(options: { scope: ArchiveScope; tuple: Record<string, string>; reviewEventId: string }): ArchivePreview {
    const snapshot = this.snapshot(), approval = currentApproval({ store: this.store, snapshot });
    if (!approval || this.status().phase === "awaiting-approval") throw new Error("Current approved archive inputs required");
    const scope = normalizeArchiveScope({ scope: options.scope, componentIds: Object.keys(snapshot.manifest.components) });
    const completed = snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "completed" }> => r.kind === "event" && r.type === "completed" && r.reviewEventId === options.reviewEventId && digest(r.tuple) === digest(options.tuple)).sort((a, b) => b.sequence - a.sequence)[0];
    const scopeApproval = snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "archive-approved" }> => r.kind === "event" && r.type === "archive-approved" && r.completionEventId === completed?.id && digest(r.scope) === digest(scope)).sort((a, b) => b.sequence - a.sequence)[0];
    const bases = scopeApproval?.bases ?? (completed?.archive && digest(completed.archive) === digest(scope) ? completed.archiveBases : undefined);
    const targets: ArchivePreview["targets"] = {};
    for (const id of scope.componentIds) {
      const component = snapshot.manifest.components[id], root = this.mapped(component.repository);
      const target = archiveTarget({ root, repository: component.repository, change: component.change, branch: component.deliveryBranch, componentId: id, deliveredCommit: options.tuple[id], pinnedBase: bases?.components[id] });
      const branchHead = git(root, "rev-parse", `refs/heads/${target.branch}^{commit}`);
      if (bases?.components[id] && changedPaths({ root, base: target.base, commit: branchHead }).some(path => path.startsWith("openspec/") && pathState({ root, commit: target.base, path }) !== pathState({ root, commit: branchHead, path }))) throw new Error("Approved archive component scope drifted on canonical branch");
      const plan = committedPlan({ root, change: component.change, commit: target.base });
      if (plan.fingerprint !== approval.components[id].planFingerprint || !plan.tasks.every(task => task.completed)) throw new Error("Post-merge archive component planning inputs changed");
      targets[id] = target;
    }
    if (scope.includeStore) {
      const root = this.mapped(approval.contract.repository);
      const file = approval.contract.files.find(file => file.path.endsWith(`/changes/${snapshot.manifest.sharedChange}/tasks.md`));
      if (!file || file.path !== `openspec/changes/${snapshot.manifest.sharedChange}/tasks.md`) throw new Error("Store archival currently requires openspec/changes/<shared-change>/tasks.md at the Store repository root; use component-only archive scope (includeStore: false) or move the shared plan to the supported root and renew approval");
      const tasksContent = committedBlob({ root, object: git(root, "rev-parse", `${snapshot.head}:${file.path}`) }).toString("utf8");
      const target = archiveTarget({ root, repository: approval.contract.repository, change: snapshot.manifest.sharedChange, branch: scope.storeDeliveryBranch!, tasksContent, pinnedBase: bases?.store });
      const branchHead = git(root, "rev-parse", `refs/heads/${target.branch}^{commit}`);
      if (bases?.store && changedPaths({ root, base: target.base, commit: branchHead }).some(path => path !== file.path && !path.startsWith(`${this.store.directory}/`))) throw new Error("Store archive base may advance only across coordination records and approved task milestones");
      const canonical = repinContext({ root, context: approval.contract, revision: branchHead });
      if (canonical.fingerprint !== approval.contract.fingerprint) throw new Error("Store canonical archive inputs differ from approved contract");
      targets._store = target;
    }
    const payload = { scope, tuple: options.tuple, reviewEventId: options.reviewEventId, targets };
    return { ...payload, head: snapshot.head, token: digest({ ...payload, approvalId: approval.id, contractFingerprint: approval.contract.fingerprint }) };
  }
  archivePreview(options: { scope: ArchiveScope }) {
    const completed = this.completedEvent();
    return this.archiveInputs({ scope: options.scope, tuple: completed.tuple, reviewEventId: completed.reviewEventId });
  }
  approveArchive(options: MutationIdentity & { scope: ArchiveScope; token: string; approvedBy: string }) {
    label(options.approvedBy, "explicit archive consent");
    return coordinationOperation({ store: this.store, input: options, action: "archive-approval", initialize: () => {
      const preview = this.archivePreview(options);
      if (preview.token !== options.token) throw new Error("Archive scope token is stale");
      return { preview, completionEventId: this.completedEvent().id };
    }, execute: ({ journal, write }) => write({ id: options.id, operationId: options.operationId, payload: { type: "archive-approved", scope: journal.data.preview.scope, bases: this.archiveBases(journal.data.preview), completionEventId: journal.data.completionEventId, snapshotToken: journal.data.preview.token, consent: { token: options.token, approvedBy: options.approvedBy } } }) });
  }
  prepareArchive(options: MutationIdentity & { scope: ArchiveScope; token: string }) {
    const completed = this.completedEvent(), manifest = this.snapshot().manifest, approval = currentApproval({ store: this.store, snapshot: this.snapshot() })!;
    const roots = Object.fromEntries(Object.entries(manifest.components).map(([id, component]) => [id, this.mapped(component.repository)]));
    roots._store = this.mapped(approval.contract.repository);
    return prepareApprovedArchive({ store: this.store, input: options, roots, completionEventId: completed.id, preview: () => this.archivePreview(options), authorized: preview => {
      if (completed.archiveToken === preview.token && digest(completed.archive) === digest(preview.scope)) return true;
      return this.snapshot().records.some(r => r.kind === "event" && r.type === "archive-approved" && r.completionEventId === completed.id && r.snapshotToken === preview.token && r.consent.token === preview.token && digest(r.scope) === digest(preview.scope));
    } });
  }
  inspectArchivePreparation(options: { operationId: string }) { return inspectArchivePreparation({ store: this.store, ...options }); }
  recoverArchivePreparation(options: { operationId: string; targetId: string; attestedBy: string }) { return recoverArchivePreparation({ store: this.store, ...options }); }
  archiveDeliveryPreview(options: { preparedEventId: string; deliveryCommit: string }) {
    const prepared = this.snapshot().records.find((r): r is Extract<CoordinationEvent, { type: "archive-prepared" | "archive-delivered" }> => r.kind === "event" && r.type === "archive-prepared" && r.id === options.preparedEventId);
    if (!prepared) throw new Error("Prepared archive event required");
    const manifest = this.snapshot().manifest, approval = currentApproval({ store: this.store, snapshot: this.snapshot() })!;
    const root = this.mapped(prepared.componentId ? manifest.components[prepared.componentId].repository : approval.contract.repository);
    return archiveDeliveryEvidence({ store: this.store, root, ...options });
  }
  recordArchiveDelivery(options: MutationIdentity & { preparedEventId: string; deliveryCommit: string; token: string }) {
    return coordinationOperation({ store: this.store, input: options, action: "archive-delivery", initialize: () => {
      this.completedEvent();
      const preview = this.archiveDeliveryPreview(options);
      if (preview.token !== options.token) throw new Error("Canonical archive delivery token is stale");
      return preview;
    }, execute: ({ journal, write }) => {
      if (!this.store.readRecord({ kind: "event", id: options.id }) && this.archiveDeliveryPreview(options).token !== journal.data.token) throw new Error("Canonical archive delivery evidence changed since durable intent");
      return write({ id: options.id, operationId: options.operationId, payload: journal.data.payload });
    } });
  }
  revoke(options: MutationIdentity & { assignmentId: string; reason: string }) {
    label(options.reason, "revocation reason");
    const existing = this.store.readRecord({ kind: "event", id: options.id });
    if (existing) {
      if (existing.kind !== "event" || existing.type !== "revoked" || existing.assignmentId !== options.assignmentId ||
          existing.reason !== options.reason || existing.operationId !== options.operationId ||
          (options.createdAt !== undefined && existing.createdAt !== options.createdAt)) throw new Error("Immutable revocation identity differs");
      return this.store.writeRecord({ record: existing, expectedHead: options.expectedHead });
    }
    const snapshot = this.snapshot(), assignment = snapshot.records.find((r): r is AssignmentRecord => r.kind === "assignment" && r.id === options.assignmentId);
    if (!assignment) throw new Error("Unknown assignment");
    const sequence = Math.max(0, ...snapshot.records.filter((r): r is CoordinationEvent => r.kind === "event").map(event => event.sequence)) + 1;
    const record: CoordinationEvent = { ...this.identity(options), kind: "event", type: "revoked", sequence, componentId: assignment.componentId, assignmentId: assignment.id, reason: options.reason };
    return this.store.writeRecord({ record, expectedHead: options.expectedHead });
  }
}
