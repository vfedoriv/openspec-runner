import { dirname, join, resolve } from "node:path";
import { canonicalPath, containedPath, samePath, unredirectedPath } from "../platform-paths.js";
import type { StoreInvocationScope } from "./types.js";

/** Scope is supplied by the runner after assignment authority validation. */
export function resolveCopilotRuntime(input: { common: string; worktree: string; store?: StoreInvocationScope }): { stateDir: string; reportsDir: string } {
  if (!input.store) return { stateDir: resolve(input.common, "openspec-runner"), reportsDir: resolve(dirname(input.worktree), "reports") };
  const scope = input.store, runtime = canonicalPath(scope.runtimeDir);
  const parent = join(canonicalPath(scope.root), ".openspec-runner");
  if (!containedPath(parent, runtime) || samePath(parent, runtime) || samePath(input.common, scope.common) ||
      !unredirectedPath(scope.runtimeDir) || !scope.contextPaths.length ||
      scope.contextPaths.some(path => !containedPath(runtime, canonicalPath(path)) || samePath(runtime, canonicalPath(path)) || !unredirectedPath(path)))
    throw new Error("Store worker runtime or protected context is outside its owned scope");
  return { stateDir: resolve(scope.runtimeDir), reportsDir: resolve(scope.runtimeDir, "reports") };
}
