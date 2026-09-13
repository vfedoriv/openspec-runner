import { existsSync } from "node:fs";
import { git, run, attempt } from "./system.js";
import type { Settings } from "./codex.js";
import { codexArgs } from "./codex.js";
export interface Workspace {
  branch: string;
  path: string;
  base: string;
}
export interface Terminal {
  owned?: boolean;
  closed?: boolean;
  workspace?: string;
  pane?: string;
  terminal?: string;
  agent?: string;
  sessionContext?: string;
  phase?: string;
}
export function worktrees(
  root: string,
): Array<{ branch: string; path: string; head: string; locked?: string; prunable?: string }> {
  return git(root, "worktree", "list", "--porcelain", "-z")
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const fields = Object.fromEntries(
        block.split("\0").map((line) => {
          const i = line.indexOf(" ");
          return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
        }),
      );
      return {
        branch: fields.branch?.replace(/^refs\/heads\//, ""),
        path: fields.worktree,
        head: fields.HEAD,
        locked: fields.locked,
        prunable: fields.prunable,
      };
    });
}
export function createWorktree(
  root: string,
  spec: Workspace,
  adapter: "auto" | "git" | "worktrunk",
): Workspace {
  const existing = worktrees(root).find((w) => w.branch === spec.branch);
  if (existing) {
    if (existing.head !== spec.base)
      throw new Error(
        `Existing worktree moved from planned base: ${existing.path}`,
      );
    return { ...spec, path: existing.path };
  }
  const branchExists = !!attempt(() =>
    git(root, "rev-parse", "--verify", `refs/heads/${spec.branch}`),
  );
  if (branchExists && git(root, "rev-parse", spec.branch) !== spec.base)
    throw new Error("Existing branch differs from planned base");
  if (adapter !== "git") {
    const help = attempt(() => run("wt", ["switch", "--help"], root));
    const capable =
      help &&
      ["--no-hooks", "--format", "--base", "--create"].every((f) =>
        help.includes(f),
      );
    if (capable) {
      let error: unknown;
      try {
        const result = JSON.parse(
          run(
            "wt",
            [
              "switch",
              ...(branchExists ? [] : ["--create"]),
              spec.branch,
              "--base",
              spec.base,
              "--no-hooks",
              "--no-cd",
              "--yes",
              "--format",
              "json",
            ],
            root,
          ),
        );
        if (!result || typeof result !== "object")
          throw new Error("Invalid Worktrunk JSON");
      } catch (e) {
        error = e;
      }
      // Git is authoritative even if wt created a worktree but failed before returning JSON.
      const actual = worktrees(root).find((w) => w.branch === spec.branch);
      if (actual) {
        if (actual.head !== spec.base)
          throw new Error("Worktrunk created an unexpected base");
        return { ...spec, path: actual.path };
      }
      if (error && adapter === "worktrunk") throw error;
    } else if (adapter === "worktrunk")
      throw new Error("Worktrunk lacks required automation capabilities");
  }
  if (existsSync(spec.path))
    throw new Error(
      `Worktree path already exists: ${spec.path}; inspect partial creation before retrying`,
    );
  const branchNowExists = !!attempt(() =>
    git(root, "rev-parse", "--verify", `refs/heads/${spec.branch}`),
  );
  if (branchNowExists && git(root, "rev-parse", spec.branch) !== spec.base)
    throw new Error("Partially created branch has an unexpected base");
  git(
    root,
    "worktree",
    "add",
    ...(branchNowExists
      ? [spec.path, spec.branch]
      : ["-b", spec.branch, spec.path, spec.base]),
  );
  return spec;
}
function herdr(root: string, args: string[]) {
  if (process.env.HERDR_ENV !== "1")
    throw new Error(
      "Run this command inside the saved Herdr session, or use the returned manual resume command",
    );
  const value = JSON.parse(run("herdr", args, root, 10000));
  if (value.error || !value.result)
    throw new Error(`Herdr error: ${JSON.stringify(value)}`);
  return value.result;
}
export function startTerminal(
  root: string,
  path: string,
  commonGitDir: string,
  label: string,
  settings: Settings,
  prompt: string,
  terminal: Terminal,
  save: () => void,
  workerCommand?: string,
) {
  if (terminal.phase)
    throw new Error(
      "Launch already attempted. Inspect saved pane/session with attach; no automatic resubmission.",
    );
  terminal.phase = "creating";
  terminal.sessionContext =
    process.env.HERDR_SESSION ?? process.env.HERDR_SOCKET_PATH;
  save();
  const result = herdr(root, [
    "workspace",
    "create",
    "--cwd",
    path,
    "--label",
    label,
    "--no-focus",
  ]);
  terminal.workspace = result.workspace?.workspace_id;
  terminal.pane = result.root_pane?.pane_id;
  terminal.terminal = result.root_pane?.terminal_id;
  terminal.owned = !!terminal.terminal;
  save();
  if (!terminal.workspace || !terminal.pane)
    throw new Error(
      "Unsupported Herdr creation response; inspect workspace list before recovery",
    );
  terminal.phase = "starting";
  if (workerCommand) {
    save();
    herdr(root, ["pane", "run", terminal.pane, workerCommand]);
    terminal.phase = "submitted";
    save();
    return;
  }
  terminal.agent = `osr-${label.replace(/[^a-z0-9]/g, "").slice(-27)}`;
  save();
  herdr(root, [
    "agent",
    "start",
    terminal.agent,
    "--kind",
    "codex",
    "--pane",
    terminal.pane,
    "--",
    ...codexArgs(settings, path, undefined, commonGitDir),
  ]);
  terminal.phase = "submitting";
  save();
  herdr(root, ["agent", "prompt", terminal.pane, prompt]);
  terminal.phase = "submitted";
  save();
}
export function attachTerminal(root: string, terminal: Terminal) {
  const current = process.env.HERDR_SESSION ?? process.env.HERDR_SOCKET_PATH;
  if (terminal.sessionContext && terminal.sessionContext !== current)
    throw new Error(
      "Saved Herdr session differs from caller; reconnect to the original session first",
    );
  if (!terminal.pane)
    throw new Error(
      "No recorded pane. Inspect Herdr workspace list; do not relaunch an ambiguous attempt.",
    );
  herdr(root, ["agent", "get", terminal.pane]);
  return herdr(root, ["agent", "focus", terminal.pane]);
}
