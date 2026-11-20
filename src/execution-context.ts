import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  loadSourcePlan, readStorePlanRevision, storeCheckout, storeId, unredirectedStorePath,
  type PlanningSource, type StorePlanningSource,
} from "./planning-source.js";
import { samePath } from "./platform-paths.js";
import { repository, assertRepositoryIdentity, git } from "./system.js";
import { readComponentBinding } from "./component-state.js";
import { CoordinationStore, replayStatus, stableDigest } from "./coordination-state.js";
import { assertStoreOwnership } from "./store-ownership.js";
import { dependencyBlockers } from "./coordination-dependencies.js";
import { contextFingerprint, repinContext } from "./openspec-context.js";

export interface StoreExecutionSelection {
  storeRoot: string;
  featureId: string;
  componentId: string;
  assignmentId: string;
  source: StorePlanningSource;
}
export interface ExecutionContextInput {
  implementationRoot: string;
  change: string;
  store?: StoreExecutionSelection;
}
export interface ExecutionContext {
  implementation: { root: string; common: string };
  planningSource: PlanningSource;
  planningProjectRoot: string;
  runtimeDir: string;
  worktreeRoot: string;
  store?: Omit<StoreExecutionSelection, "source">;
}
export interface BoundStoreSelection {
  implementationRoot: string;
  storeRoot: string;
  featureId: string;
  componentId: string;
  change: string;
  assignmentId?: string;
}
function runtimeLocation(input: Omit<BoundStoreSelection, "change">) {
  storeId(input.featureId); storeId(input.componentId);
  const implementation = repository(input.implementationRoot);
  const storeRoot = unredirectedStorePath(input.storeRoot), store = repository(storeRoot);
  if (!samePath(store.root, storeRoot) || samePath(store.common, implementation.common))
    throw new Error("Store execution requires a separate explicit Store repository root");
  const owner = createHash("sha256").update(JSON.stringify([input.featureId, input.componentId, implementation.common])).digest("hex");
  return { store, runtimeDir: unredirectedStorePath(store.root, ".openspec-runner", owner, "runtime") };
}
/** Locate imported state using explicit scope; never discover a Store from code-local files. */
export function resolveBoundExecutionContext(input: BoundStoreSelection): ExecutionContext {
  const { runtimeDir } = runtimeLocation(input);
  const binding = readComponentBinding({ stateDir: runtimeDir, change: input.change });
  if (!binding || binding.assignment.version !== 2 || binding.featureId !== input.featureId || binding.assignment.componentId !== input.componentId)
    throw new Error("No matching imported Store assignment for this code clone and component");
  if (input.assignmentId && input.assignmentId !== binding.assignmentId) throw new Error("Store assignment identity changed; old callbacks cannot address its replacement");
  assertRepositoryIdentity({ root: input.implementationRoot, repository: binding.repository });
  return resolveExecutionContext({ implementationRoot: input.implementationRoot, change: input.change,
    store: { storeRoot: input.storeRoot, featureId: input.featureId, componentId: input.componentId,
      assignmentId: binding.assignmentId, source: binding.assignment.planningSource } });
}
/** Read current local branch authority without running OpenSpec or allocating snapshot directories. */
export function assertStoreBindingAuthority(execution: ExecutionContext, change: string, allowReserved = false) {
  if (!execution.store || execution.planningSource.kind !== "store") throw new Error("Expected Store execution scope");
  const binding = readComponentBinding({ stateDir: execution.runtimeDir, change });
  if (!binding || binding.assignment.version !== 2 ||
      !(binding.phase === "ready" || allowReserved && binding.phase === "reserved") ||
      binding.assignmentId !== execution.store.assignmentId || binding.featureId !== execution.store.featureId ||
      binding.assignment.componentId !== execution.store.componentId ||
      stableDigest({ value: binding.assignment.planningSource }) !== stableDigest({ value: execution.planningSource }))
    throw new Error("Store execution requires a matching active assignment import");
  assertStoreOwnership(execution);
  const store = new CoordinationStore({ root: execution.store.storeRoot, featureId: binding.featureId });
  const manifest = store.readManifest({ revision: binding.historyRevision });
  const revision = git(store.root, "rev-parse", `refs/heads/${manifest.coordinationBranch}^{commit}`);
  const snapshot = store.readSnapshot({ revision });
  const approval = store.authoritativeApproval({ snapshot });
  if (!approval || approval.id !== binding.assignment.approvalId || snapshot.manifest.coordinationBranch !== manifest.coordinationBranch ||
      approval.manifestFingerprint !== stableDigest({ value: snapshot.manifest }))
    throw new Error("Store assignment approval is stale; inspect current coordination authority");
  const status = replayStatus({ snapshot, approvalId: approval.id });
  const component = status.components[binding.assignment.componentId];
  const assigned = snapshot.records.find(record => record.kind === "assignment" && record.id === binding.assignmentId);
  if (!assigned || stableDigest({ value: assigned }) !== stableDigest({ value: binding.assignment }) ||
      component?.assignmentId !== binding.assignmentId || component.dependencyStale || component.requiresReapproval ||
      dependencyBlockers({ manifest: snapshot.manifest, componentId: binding.assignment.componentId, components: status.components, assignment: binding.assignment }).length)
    throw new Error("Store assignment is revoked, stale, or blocked by changed dependencies");
  const source = binding.assignment.planningSource;
  if (readStorePlanRevision({ storeRoot: store.root, source, revision }).fingerprint !== source.fingerprint)
    throw new Error("Store planning inputs drifted; renew approval before execution");
  const primary = repinContext({ root: store.root, revision, context: binding.assignment.contract });
  if (contextFingerprint({ ...primary, references: binding.assignment.contract.references }) !== binding.assignment.contract.fingerprint)
    throw new Error("Shared contract drifted; renew approval before execution");
  assertRepositoryIdentity({ root: execution.implementation.root, repository: binding.repository });
  return binding;
}
/** Resolve machine-local ownership without creating files. Replacement assignments reuse the component lock scope. */
export function resolveExecutionContext(input: ExecutionContextInput): ExecutionContext {
  const { root, common, stateDir } = repository(input.implementationRoot);
  const implementation = { root, common };
  if (!input.store) return {
    implementation, planningSource: { kind: "local", root, change: input.change }, planningProjectRoot: root,
    runtimeDir: stateDir, worktreeRoot: resolve(root, ".openspec-runner", "worktrees"),
  };
  const { storeRoot, featureId, componentId, assignmentId, source } = input.store;
  for (const value of [featureId, componentId, assignmentId]) storeId(value);
  if (source.kind !== "store" || source.openspecRoot !== `components/${componentId}/openspec`)
    throw new Error("Store planning root differs from the selected component");
  if (source.change !== input.change) throw new Error("Store planning change differs from the selected change");
  loadSourcePlan(source);
  const checkout = storeCheckout(storeRoot, source.repository);
  if (samePath(checkout.common, common)) throw new Error("Store execution requires a separate implementation Git repository");
  const planningProjectRoot = unredirectedStorePath(checkout.root, "components", componentId);
  const ownerKey = createHash("sha256").update(JSON.stringify([featureId, componentId, common])).digest("hex");
  const owner = unredirectedStorePath(checkout.root, ".openspec-runner", ownerKey);
  return {
    implementation, planningSource: source, planningProjectRoot,
    runtimeDir: unredirectedStorePath(owner, "runtime"), worktreeRoot: unredirectedStorePath(owner, "worktrees"),
    store: { storeRoot: checkout.root, featureId, componentId, assignmentId },
  };
}
