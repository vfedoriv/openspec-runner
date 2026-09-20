import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createWorktree, worktrees, type Workspace } from "./adapters.js";
import { git, repository, run } from "./system.js";

export function createOrcaWorktree(root: string, spec: Workspace, branchExists: boolean): Workspace {
  // Orca cannot attach an existing branch. Preserve normal recovery for retained refs.
  if (branchExists) return createWorktree(root, spec, "git");
  const slug = `osr-${createHash("sha256").update(spec.branch).digest("hex").slice(0, 32)}`;
  const intermediateBranch = `orca-${slug}`;
  const runtime = resolve(root, ".openspec-runner");
  const createdPath = resolve(runtime, ".orca", "worktree", slug);
  let actual = worktrees(root).find(w => w.branch === intermediateBranch);
  if (!actual) {
    if (existsSync(spec.path) || existsSync(createdPath))
      throw new Error("Orca worktree path already exists; inspect partial creation before retrying");
    const staging = resolve(repository(root).stateDir, "orca-preparation");
    mkdirSync(staging, { recursive: true });
    const container = mkdtempSync(resolve(staging, "base-"));
    const checkout = resolve(container, "checkout");
    let added = false;
    try {
      // The upstream helper always branches from cwd HEAD and edits cwd .gitignore.
      // An owned detached checkout supplies the exact base without altering user files.
      git(root, "worktree", "add", "--detach", checkout, spec.base);
      added = true;
      let error: unknown;
      try {
        run("env", [`ORCA_ROOT=${runtime}`, "GIT_CONFIG_COUNT=1",
          "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=/dev/null",
          "orca-worktree", "create", slug], checkout, 30000);
      } catch (e) {
        error = e;
      }
      actual = worktrees(root).find(w => w.branch === intermediateBranch);
      if (!actual) throw error ?? new Error("Orca did not create the requested worktree");
    } finally {
      // This checkout only contains the committed base and the helper's .gitignore edit.
      if (added) git(root, "worktree", "remove", "--force", checkout);
      rmdirSync(container);
    }
  }
  if (actual.head !== spec.base || ![createdPath, resolve(spec.path)].includes(resolve(actual.path)))
    throw new Error("Orca created an unexpected worktree path or base; inspect before recovery");
  // Normalize the helper's fixed branch/path scheme to the runner's durable identities.
  if (resolve(actual.path) !== resolve(spec.path)) {
    if (existsSync(spec.path)) throw new Error("Planned worktree path already exists; inspect before recovery");
    mkdirSync(dirname(spec.path), { recursive: true });
    git(root, "worktree", "move", actual.path, spec.path);
  }
  git(spec.path, "branch", "-m", spec.branch);
  return spec;
}
