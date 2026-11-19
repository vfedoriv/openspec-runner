import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  loadSourcePlan, storeCheckout, storeId, unredirectedStorePath,
  type PlanningSource, type StorePlanningSource,
} from "./planning-source.js";
import { samePath } from "./platform-paths.js";
import { repository } from "./system.js";

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
  const cloneKey = createHash("sha256").update(common).digest("hex");
  const owner = unredirectedStorePath(checkout.root, ".openspec-runner", featureId, componentId, cloneKey);
  return {
    implementation, planningSource: source, planningProjectRoot,
    runtimeDir: unredirectedStorePath(owner, "runtime"), worktreeRoot: unredirectedStorePath(owner, "worktrees"),
    store: { storeRoot: checkout.root, featureId, componentId, assignmentId },
  };
}
