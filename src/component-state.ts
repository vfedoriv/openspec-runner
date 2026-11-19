import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { decodeRecord, stableDigest, validateId, type AssignmentRecord } from "./coordination-state.js";
import { json } from "./system.js";
import type { Config } from "./plan.js";
import { unredirectedStorePath } from "./planning-source.js";
import type { ContextFile } from "./openspec-context.js";

export interface ComponentResources {
  terminal: Config["terminal"];
  worktrees: Config["worktrees"];
  worktreeRoot: string;
}
export interface ComponentBinding {
  version: 1;
  phase: "reserved" | "ready" | "retiring" | "retired";
  retirement?: { token: string; reason: string };
  repository: string;
  change: string;
  assignmentId: string;
  featureId: string;
  historyRevision: string;
  token: string;
  assignment: AssignmentRecord;
  contextPaths: string[];
  resources: ComponentResources;
}
export function componentBindingPath(options: { stateDir: string; change: string }) {
  validateId({ value: options.change, label: "change" });
  return resolve(options.stateDir, "components", `${options.change}.json`);
}
export function decodeResources(options: { value: unknown; defaults?: ComponentResources }): ComponentResources {
  const input = options.value ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
    throw new Error("Local resources must be an object");
  for (const key of Object.keys(input)) if (!["terminal", "worktrees", "worktreeRoot"].includes(key)) throw new Error(`Local resources forbid behavior overlays: unknown ${key}`);
  const value = { ...options.defaults, ...input } as ComponentResources;
  if (!["auto", "manual", "herdr", "orca"].includes(value.terminal) || !["auto", "git", "worktrunk", "orca"].includes(value.worktrees))
    throw new Error("Invalid local resource adapter");
  if (typeof value.worktreeRoot !== "string" || !isAbsolute(value.worktreeRoot) || value.worktreeRoot.includes("\0") || value.worktreeRoot.split(/[\\/]/).includes(".git"))
    throw new Error("Local resource worktreeRoot requires an absolute path outside Git metadata");
  return { terminal: value.terminal, worktrees: value.worktrees, worktreeRoot: resolve(value.worktreeRoot) };
}
export function expectedContextPaths(options: { stateDir: string; assignment: AssignmentRecord }) {
  return assignmentContexts(options.assignment).map((_, index) => resolve(options.stateDir, "component-context", options.assignment.featureId, options.assignment.id, String(index)));
}
export function assignmentContexts(assignment: AssignmentRecord) {
  return [assignment.contract, ...(assignment.contract.references ?? []), ...(assignment.version === 2 ? [assignment.planningSource] : [])];
}
/** A partial import may lack approved entries, but must never contribute extra planning inputs. */
export function assertDeclaredSnapshotEntries(root: string, files: ContextFile[], partial = false) {
  const expected = new Map<string, "directory" | "file">();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) expected.set(parts.slice(0, count).join("/"), "directory");
    expected.set(file.path, "file");
  }
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat && partial) return;
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Pinned snapshot root is missing or redirected");
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name, type = expected.get(path);
      if (!type || (type === "directory" ? !entry.isDirectory() : !entry.isFile())) throw new Error(`Unexpected pinned snapshot entry: ${path}`);
      expected.delete(path);
      if (type === "directory") walk(resolve(directory, entry.name), path + "/");
    }
  };
  walk(root, "");
  if (!partial && expected.size) throw new Error("Pinned snapshot is missing approved entries");
}
/** A replacement shares the code clone/component scope, including when its OpenSpec change ID differs. */
export function storeReservation(stateDir: string, assignment: Extract<AssignmentRecord, { version: 2 }>) {
  const directory = unredirectedStorePath(stateDir, "components");
  if (!existsSync(directory)) return undefined;
  let current: ComponentBinding | undefined;
  for (const name of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    const binding = readComponentBinding({ stateDir, change: name.slice(0, -5) });
    if (!binding) throw new Error("Store import reservation changed during inspection");
    if (binding.phase === "retired" && binding.assignmentId !== assignment.id) continue;
    if (binding.phase === "retired" || binding.phase === "retiring") throw new Error("Store assignment is retiring or retired");
    if (stableDigest({ value: binding.assignment }) !== stableDigest({ value: assignment })) throw new Error("A different assignment reserves this Store runtime; retire it before replacement");
    current = binding;
  }
  return current;
}
export function readComponentBinding(options: { stateDir: string; change: string }): ComponentBinding | undefined {
  const path = componentBindingPath(options);
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Unsafe component runtime binding path");
  const binding = json<ComponentBinding>(path);
  const allowed = ["version", "phase", "repository", "change", "assignmentId", "featureId", "historyRevision", "token", "assignment", "contextPaths", "resources", "retirement"];
  if (!binding || typeof binding !== "object" || Object.keys(binding).some(key => !allowed.includes(key))) throw new Error("Invalid component runtime binding fields");
  const assignment = decodeRecord({ value: binding.assignment });
  if (binding.version !== 1 || assignment.kind !== "assignment" || binding.change !== options.change || binding.assignmentId !== assignment.id || binding.featureId !== assignment.featureId || binding.repository !== assignment.repository || binding.change !== assignment.change || !["reserved", "ready", "retiring", "retired"].includes(binding.phase) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.historyRevision))
    throw new Error("Invalid component runtime binding identity");
  if (["retiring", "retired"].includes(binding.phase) ? !binding.retirement || !/^[a-f0-9]{64}$/.test(binding.retirement.token) || !binding.retirement.reason?.trim() || Object.keys(binding.retirement).some(key => !["token", "reason"].includes(key)) : binding.retirement !== undefined)
    throw new Error("Invalid component retirement intent");
  const resources = decodeResources({ value: binding.resources });
  if (stableDigest({ value: binding.resources }) !== stableDigest({ value: resources }) ||
      stableDigest({ value: binding.contextPaths }) !== stableDigest({ value: expectedContextPaths({ stateDir: options.stateDir, assignment }) })) throw new Error("Component runtime binding resources/context paths changed");
  const expectedToken = stableDigest({ value: { assignment, historyRevision: binding.historyRevision, resources } });
  if (binding.token !== expectedToken) throw new Error("Component runtime binding token does not match import reservation");
  return binding;
}
