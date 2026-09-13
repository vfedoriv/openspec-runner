import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { attempt, git, repository } from "./system.js";
import { inspectTerminal, type TerminalInspection } from "./terminal-cleanup.js";
import { worktrees } from "./adapters.js";
import type { State, TaskAttempt } from "./runner.js";

export interface CleanupResult {
  attempt: string;
  task: string;
  path: string;
  status: "eligible" | "removed" | "already-removed" | "confirmation-required" | "skipped" | "failed";
  reasons: string[];
  token?: string;
  contentsToken?: string;
  head?: string;
  locked?: boolean;
  changes?: string;
  terminal?: TerminalInspection;
}
export interface CleanupOptions {
  all?: boolean;
  dryRun?: boolean;
  attempt?: string;
  confirm?: string;
}

export function inspectCleanup(repo: ReturnType<typeof repository>, s: State, a: TaskAttempt): CleanupResult {
  const result: CleanupResult = { attempt: a.id, task: a.task, path: a.path, status: "skipped", reasons: [] };
  const skip = (reason: string) => ({ ...result, reasons: [reason] });
  if (s.transaction || s.attempts.some(x => ["preparing", "manual", "launching", "running"].includes(x.phase) && x.id === a.id))
    return skip("Active attempt or pending integration");
  const listed = worktrees(repo.root);
  if ([repo.root, s.integration.path, listed[0]?.path].includes(a.path))
    return skip("Main, invoking, or integration worktree is protected");
  const w = listed.find(w => w.path === a.path);
  if (!w) {
    const moved = a.gitDir && listed.find((candidate) =>
      attempt(() => git(candidate.path, "rev-parse", "--absolute-git-dir")) === a.gitDir,
    );
    if (moved)
      return skip(`Recorded worktree moved to ${moved.path}; inspect its current ownership before cleanup`);
    if (existsSync(a.path))
      return skip(
        "Path exists but is not a registered worktree; ownership is uncertain",
      );
    return { ...result, status: "already-removed" };
  }
  if (!existsSync(a.path) || w.prunable !== undefined)
    return skip("Worktree registration is stale; inspect it before cleanup");
  if (realpathSync(a.path) !== resolve(a.path) || lstatSync(a.path).isSymbolicLink())
    return skip("Worktree path is redirected; ownership is uncertain");
  const actual = repository(a.path);
  const gitDir = git(a.path, "rev-parse", "--absolute-git-dir");
  if (realpathSync(actual.common) !== realpathSync(repo.common) ||
      !gitDir.startsWith(resolve(repo.common, "worktrees") + sep) ||
      (a.gitDir ? a.gitDir !== gitDir : w.branch !== a.branch))
    return skip("Worktree identity differs from the recorded attempt; resolve ownership first");
  const issues: string[] = [];
  const head = git(a.path, "rev-parse", "HEAD");
  if (w.head !== head) return skip("Worktree changed during inspection");
  if (a.phase === "integrated") {
    if (!a.report?.commit) return skip("Integrated attempt lacks its report commit");
    try { git(repo.root, "merge-base", "--is-ancestor", a.report.commit, s.head); }
    catch { return skip("Reported commit is not included in recorded integration history"); }
    if (head !== a.report.commit) issues.push("HEAD changed after reporting; retain current commit before removal");
  }
  if (w.branch !== a.branch) issues.push("Worktree branch changed; retain current commit before removal");
  if (w.locked !== undefined) issues.push(`Worktree is locked: ${w.locked || "no reason supplied"}`);
  const changes = git(a.path, "status", "--porcelain", "--untracked-files=all");
  if (changes) issues.push("Deletion discards the listed tracked/untracked local changes");
  const terminal = inspectTerminal(repo.root, a);
  if (terminal.blocked) return { ...skip(terminal.reason!), terminal };
  if (terminal.reason) issues.push(terminal.reason);
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ id: a.id, path: a.path, gitDir, stat: lstatSync(a.path).ino,
    head, branch: w.branch, lock: w.locked, phase: a.phase, integration: s.head,
    fingerprint: s.fingerprint, changes }));
  hash.update(
    git(
      a.path,
      "diff",
      "HEAD",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
    ),
  );
  // Git diff binds tracked changes; hash untracked contents separately. Never follow symlinks.
  for (const name of new Set(
    git(a.path, "ls-files", "-z", "--others", "--exclude-standard")
      .split("\0")
      .filter(Boolean),
  )) {
    const path = resolve(a.path, name);
    if (!path.startsWith(resolve(a.path) + sep)) return skip("Invalid file path in worktree");
    hash.update(name);
    try {
      const stat = lstatSync(path);
      hash.update(String(stat.mode));
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isFile()) hash.update(readFileSync(path));
      else return skip("Nested repository or special file requires manual inspection");
    } catch (error: any) {
      if (error.code === "ENOENT") hash.update("missing");
      else throw error;
    }
  }
  const contentsToken = hash.digest("hex");
  return { ...result, status: issues.length ? "confirmation-required" : "eligible",
    reasons: issues, contentsToken, token: createHash("sha256").update(contentsToken).update(JSON.stringify(terminal)).digest("hex"), head, locked: w.locked !== undefined,
    changes, terminal };
}

export function removeInspectedWorktree(root: string, a: TaskAttempt, inspected: CleanupResult, approved: boolean) {
  if (inspected.status === "confirmation-required" && !approved) throw new Error("User confirmation required");
  // A retained ref protects detached/moved HEADs; normal attempt branches already protect their commit.
  if (
    attempt(() =>
      git(root, "rev-parse", "--verify", `refs/heads/${a.branch}`),
    ) !== inspected.head
  ) {
    const retained = `refs/heads/openspec-runner/retained/${a.id}/${inspected.head}`;
    git(root, "update-ref", retained, inspected.head!);
  }
  git(root, "worktree", "remove", ...(approved ? ["--force", ...(inspected.locked ? ["--force"] : [])] : []), a.path);
}
