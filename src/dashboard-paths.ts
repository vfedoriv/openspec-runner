import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { containedPath, samePath, unredirectedPath } from "./platform-paths.js";
import type { DashboardSnapshot } from "./dashboard-types.js";

export type DashboardPathKind = "worktree" | "integration" | "log";

export function savedDashboardPath(snapshot: DashboardSnapshot, target: string, kind: DashboardPathKind) {
  const task = snapshot.tasks.find(row => row.id === target);
  const session = snapshot.sessions.find(row => row.id === target ||
    task && row.taskId === task.id && row.attempt.id === task.attempts.at(-1)?.id);
  const feature = snapshot.features.find(row => row.id === (session?.featureId ?? task?.featureId ?? target));
  if (feature?.origin !== "local") return;
  const path = kind === "log" ? session?.log : kind === "worktree" ? session?.attempt.path : feature.execution?.path;
  if (!path) return;
  const root = kind === "log" ? resolve(snapshot.repository.stateDir, "logs") :
    feature.state?.delegated?.resources.worktreeRoot ??
    resolve(feature.state?.planningRoot ?? snapshot.repository.root, ".openspec-runner", "worktrees");
  return { path, root, stale: snapshot.sources[feature.id]?.stale === true,
    identity: JSON.stringify([feature.id, session?.attempt.id, session?.attempt.base, session?.attempt.branch, path, root]) };
}

export function validateDashboardPath(path: string, root: string, kind: DashboardPathKind): void {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/.test(path) ||
      !containedPath(root, path) || samePath(root, path) || !unredirectedPath(path))
    throw new Error("Saved path is outside the expected runner location or is redirected");
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!(kind === "log" ? entry?.isFile() && path.endsWith(".log") : entry?.isDirectory()))
    throw new Error("Saved path is unavailable or has the wrong file type");
}

export function desktopPathCommand(path: string, kind: DashboardPathKind, copy: boolean,
  platform = process.platform, env = process.env): { command: string; args: string[]; stdin?: Buffer } | undefined {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return;
  if (platform === "win32") {
    if (copy) return { command: "clip.exe", args: [], stdin: Buffer.from(path, "utf16le") };
    return kind === "log" ? { command: "notepad.exe", args: [path] } : { command: "explorer.exe", args: [path] };
  }
  if (platform === "darwin") return copy ? { command: "pbcopy", args: [], stdin: Buffer.from(path) } :
    { command: "open", args: [...(kind === "log" ? ["-t"] : []), path] };
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    if (!copy) return kind === "log" ? { command: "gedit", args: ["--", path] } : { command: "xdg-open", args: [path] };
    return env.WAYLAND_DISPLAY ? { command: "wl-copy", args: [], stdin: Buffer.from(path) } :
      { command: "xclip", args: ["-selection", "clipboard"], stdin: Buffer.from(path) };
  }
}
