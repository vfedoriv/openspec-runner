import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { decodeRecord, stableDigest, validateId, type AssignmentRecord } from "./coordination-state.js";
import { json } from "./system.js";
import type { Config } from "./plan.js";

export interface ComponentResources {
  terminal: Config["terminal"];
  worktrees: Config["worktrees"];
  worktreeRoot: string;
}
export interface ComponentBinding {
  version: 1;
  phase: "reserved" | "ready";
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
  return [options.assignment.contract, ...(options.assignment.contract.references ?? [])].map((_, index) => resolve(options.stateDir, "component-context", options.assignment.featureId, options.assignment.id, String(index)));
}
export function readComponentBinding(options: { stateDir: string; change: string }): ComponentBinding | undefined {
  const path = componentBindingPath(options);
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Unsafe component runtime binding path");
  const binding = json<ComponentBinding>(path);
  const allowed = ["version", "phase", "repository", "change", "assignmentId", "featureId", "historyRevision", "token", "assignment", "contextPaths", "resources"];
  if (!binding || typeof binding !== "object" || Object.keys(binding).some(key => !allowed.includes(key))) throw new Error("Invalid component runtime binding fields");
  const assignment = decodeRecord({ value: binding.assignment });
  if (binding.version !== 1 || assignment.kind !== "assignment" || binding.change !== options.change || binding.assignmentId !== assignment.id || binding.featureId !== assignment.featureId || binding.repository !== assignment.repository || binding.change !== assignment.change || !["reserved", "ready"].includes(binding.phase) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.historyRevision))
    throw new Error("Invalid component runtime binding identity");
  const resources = decodeResources({ value: binding.resources });
  if (stableDigest({ value: binding.resources }) !== stableDigest({ value: resources }) ||
      stableDigest({ value: binding.contextPaths }) !== stableDigest({ value: expectedContextPaths({ stateDir: options.stateDir, assignment }) })) throw new Error("Component runtime binding resources/context paths changed");
  const expectedToken = stableDigest({ value: { assignment, historyRevision: binding.historyRevision, resources } });
  if (binding.token !== expectedToken) throw new Error("Component runtime binding token does not match import reservation");
  return binding;
}
