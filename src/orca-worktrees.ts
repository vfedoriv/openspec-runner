import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { worktrees, type Workspace } from "./adapters.js";
import { git, repository } from "./system.js";
import { checkOrcaContext, orcaCall, orcaContext, orcaTerminals, orcaWorktree, type OrcaContext } from "./orca.js";

export interface OrcaWorkspace {
  context: OrcaContext;
  id: string;
}

export function createOrcaWorktree(root: string, spec: Workspace): Workspace {
  const context = orcaContext(root);
  if (spec.orcaWorktree) {
    checkOrcaContext(root, spec.orcaWorktree.context);
    const saved = orcaWorktree(root, spec.path, context);
    if (saved.id !== spec.orcaWorktree.id) throw new Error("Saved Orca worktree identity changed");
    return validate(saved);
  }
  const repos = orcaCall(root, ["repo", "list"], context).result.repos;
  if (!Array.isArray(repos)) throw new Error("Unsupported Orca repository list");
  const matches = repos.filter((r: any) => {
    if (r.connectionId || (r.executionHostId && r.executionHostId !== "local") || typeof r.path !== "string") return false;
    try { return realpathSync(repository(r.path).common) === realpathSync(repository(root).common); }
    catch { return false; }
  });
  if (matches.length !== 1 || typeof matches[0].id !== "string")
    throw new Error("Open this repository once in the local Orca app before using worktrees: orca");
  const repo = matches[0];
  const token = `openspec-runner:${createHash("sha256").update(spec.branch).digest("hex")}`;
  const find = () => {
    const result = orcaCall(root, ["worktree", "list", "--repo", `id:${repo.id}`], context).result;
    if (!Array.isArray(result.worktrees) || result.truncated !== false ||
        !result.hostScope?.hostIds?.includes("local") || result.hostScope?.omittedHostIds?.includes("local"))
      throw new Error("Orca worktree listing is incomplete; cannot safely create or recover");
    const found = result.worktrees.filter((w: any) => w.comment === token && w.repoId === repo.id);
    if (found.length > 1) throw new Error("Multiple Orca worktrees match this attempt; inspect before recovery");
    return found[0];
  };
  const previous = find();
  if (previous) return validate(previous, token);
  let result;
  try {
    result = orcaCall(root, ["worktree", "create", "--repo", `id:${repo.id}`,
      "--name", `osr-${token.slice(-24)}`, "--base-branch", spec.base,
      "--comment", token, "--setup", "skip", "--no-parent"], context).result.worktree;
  } catch (error) {
    // A timeout can follow successful creation. Reconcile the unique attempt marker before retrying.
    const created = find();
    if (!created) throw error;
    return validate(created, token);
  }
  return validate(result, token);

  function validate(value: any, marker?: string): Workspace {
    if (!value || typeof value.path !== "string" || typeof value.id !== "string" ||
        typeof value.branch !== "string" || value.hostId !== "local" || value.isMainWorktree !== false)
      throw new Error("Unsupported Orca worktree creation response; inspect before recovery");
    if (marker && (value.comment !== marker || value.repoId !== repo.id))
      throw new Error("Orca returned a worktree belonging to a different attempt or repository");
    const actual = worktrees(root).find(w => w.path === value.path);
    const branch = value.branch.replace(/^refs\/heads\//, "");
    if (!actual || actual.head !== spec.base || actual.branch !== branch ||
        git(value.path, "rev-parse", "HEAD") !== spec.base)
      throw new Error("Orca created an unexpected worktree or base; inspect before recovery");
    if (orcaWorktree(root, actual.path, context).id !== value.id)
      throw new Error("Orca worktree identity changed during creation");
    return { ...spec, branch, path: actual.path, orcaWorktree: { context, id: value.id } };
  }
}

export function inspectOrcaWorktree(root: string, spec: Workspace, allowedTerminal?: string): void {
  if (!spec.orcaWorktree) return;
  const saved = spec.orcaWorktree;
  checkOrcaContext(root, saved.context);
  if (orcaWorktree(root, spec.path, saved.context).id !== saved.id)
    throw new Error("Saved Orca worktree identity changed");
  if (orcaTerminals(root, saved.id, saved.context).some(t => t.handle !== allowedTerminal))
    throw new Error("Other Orca terminals remain in this worktree; inspect and close them before cleanup");
}
