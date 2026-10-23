import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { DashboardSnapshot, SessionSummary } from "./dashboard-types.js";
import { loadPlan } from "./plan.js";

export type DashboardAction = {
  id: string; label: string; kind: "inspect" | "diff" | "focus" | "command" | "preview";
  available: boolean; reason?: string; argv?: string[]; sessionId?: string;
};
export type PreviewInput = { taskIds?: string[]; model?: string; effort?: string; settingsFile?: string };

export function focusReason(session: SessionSummary): string | undefined {
  const a = session.attempt;
  if (a.cleaned || a.worker?.exitedAt || a.terminal.closed || a.report || ["completed", "integrated", "failed", "blocked", "stale"].includes(a.phase)) return "Worker finished; inspect retained evidence";
  if (session.worktreeAvailable !== true) return session.worktreeAvailable === false ? "Saved worktree is missing" : "Saved worktree availability is unknown; refresh first";
  if (a.phase === "manual") return "Manual session; inspect saved details";
  if (!a.session) return "Ambiguous startup without a registered session";
  if (!a.terminal.pane) return "No existing saved terminal";
  if (a.terminal.backend !== "orca" && process.env.HERDR_ENV !== "1") return "Reconnect to the saved Herdr context";
  if (a.terminal.backend !== "orca" && a.terminal.sessionContext && a.terminal.sessionContext !== (process.env.HERDR_SESSION ?? process.env.HERDR_SOCKET_PATH)) return "Saved Herdr session differs from caller";
  return undefined;
}

export function actionsFor(snapshot: DashboardSnapshot, targetId: string): DashboardAction[] {
  const task = snapshot.tasks.find(t => t.id === targetId), session = snapshot.sessions.find(s => s.id === targetId);
  const feature = snapshot.features.find(f => f.id === (task?.featureId ?? session?.featureId ?? targetId));
  if (!task && !session && !snapshot.features.some(f => f.id === targetId) && !snapshot.assignments.some(a => a.id === targetId)) return [];
  const actions: DashboardAction[] = [{ id: `${targetId}:inspect`, label: "Inspect evidence", kind: "inspect", available: true }];
  const add = (suffix: string, label: string, kind: DashboardAction["kind"], reason?: string, argv?: string[]) => actions.push({ id: `${targetId}:${suffix}`, label, kind, available: !reason, reason, argv });
  if (session) {
    add("diff", "View saved attempt diff", "diff", session.worktreeAvailable !== true ? session.worktreeAvailable === false ? "Saved worktree is missing" : "Saved worktree availability is unknown; refresh first" : !/^[a-f0-9]{40,64}$/.test(session.attempt.base) ? "Saved base is not a commit identity" : undefined);
    add("focus", "Focus saved terminal", "focus", focusReason(session));
    actions.at(-1)!.sessionId = session.id;
  }
  if (!feature?.change || feature.origin !== "local" || session) return actions;
  const change = feature.change;
  const last = task?.attempts.at(-1), retry = !!last && ["failed", "blocked", "stale"].includes(last.phase);
  add("launch-preview", "Preview launch (select exact tasks and settings)", "preview", task && !task.ready ? task.reasons.join("; ") || "Task is not ready" : undefined);
  add("launch-command", "Display launch command", "command", undefined, ["launch", change, "--tasks", task?.task.id ?? "TASK_IDS"]);
  if (task) add("retry-preview", "Preview retry (select this task)", "preview", retry ? undefined : "Retry requires an unsuccessful attempt");
  if (task) add("retry-command", "Display retry command", "command", undefined, ["retry", change, task.task.id]);
  for (const command of ["integrate", "reconcile", "cleanup"]) add(`${command}-command`, `Display ${command} command`, "command", undefined, [command, change, ...(task ? ["--tasks", task.task.id] : [])]);
  if (feature.state) {
    const authority = snapshot.tasks.filter(t => t.featureId === feature.id).flatMap(t => t.reasons).find(r => /coordination authority|delegated|component|import|assignment/i.test(r));
    add("approve-preview", "Preview plan approval (existing settings file)", "preview", "Plan preview executes OpenSpec validation; no-write safety is unavailable");
    add("review-preview", "Preview review", "preview", authority);
    add("fix-preview", "Preview repair", "preview", authority);
    for (const suffix of ["final", "archive"]) add(`${suffix}-preview`, `Preview ${suffix}`, "preview", "Existing CLI preview executes configured verification commands that may write files");
    for (const command of ["approve", "review", "fix", "archive"]) add(`feature-${command}-command`, `Display feature ${command}`, "command", undefined, ["feature", command, change]);
    add("feature-final-command", "Display final approval command", "command", undefined, ["feature", "approve", change, "--final"]);
  }
  return actions;
}

/** Reconstruct from the selected target and allowlist; caller argv is never authority. */
export function previewCommand(snapshot: DashboardSnapshot, action: DashboardAction, input: PreviewInput = {}): string[] {
  if (action.kind !== "preview") throw new Error("Only explicit preview actions can execute");
  const targets = [...snapshot.features, ...snapshot.tasks, ...snapshot.sessions, ...snapshot.assignments];
  const target = targets.find(t => actionsFor(snapshot, t.id).some(a => a.id === action.id));
  if (!target) throw new Error("Unknown preview target/action");
  const saved = actionsFor(snapshot, target.id).find(a => a.id === action.id)!;
  if (saved.kind !== "preview" || !saved.available) throw new Error(saved.reason ?? "Preview unavailable");
  const selectedTask = snapshot.tasks.find(t => t.id === target.id);
  const feature = snapshot.features.find(f => f.id === (selectedTask?.featureId ?? target.id));
  if (!feature?.change || feature.origin !== "local") throw new Error("Preview requires a local change");
  let argv: string[];
  if (action.id.endsWith(":launch-preview") || action.id.endsWith(":retry-preview")) {
    const ids = input.taskIds;
    if (!ids?.length || new Set(ids).size !== ids.length || ids.some(id => !/^\d+(?:\.\d+)+$/.test(id))) throw new Error("Select exact task IDs");
    const retry = action.id.endsWith(":retry-preview");
    if (retry && (ids.length !== 1 || ids[0] !== selectedTask?.task.id)) throw new Error("Retry requires exactly the selected task");
    if (selectedTask && ids.some(id => id !== selectedTask.task.id)) throw new Error("Task selection differs from selected target");
    for (const id of ids) {
      const task = snapshot.tasks.find(t => t.featureId === feature.id && t.task.id === id);
      if (!task) throw new Error("Unknown task selection");
      if (!retry && !task.ready) throw new Error(task.reasons.join("; ") || "Task is not ready");
      if (retry && task.reasons.some(r => !r.startsWith("Existing attempt is"))) throw new Error(task.reasons.join("; "));
      const last = task.attempts.at(-1);
      if (retry && (!last || !["failed", "blocked", "stale"].includes(last.phase) || last.worker && !last.worker.exitedAt)) throw new Error("Retry requires a stopped unsuccessful attempt");
    }
    argv = retry ? ["retry", feature.change, ids[0]] : ["launch", feature.change, "--tasks", ids.join(",")];
    if (feature.state) {
      if (!feature.state.approval || input.model || input.effort) throw new Error("Managed preview requires approved settings without overrides");
    } else {
      let agent = "codex";
      try { agent = loadPlan(snapshot.repository.root, feature.change).agent; } catch { /* Missing config cannot establish a different harness. */ }
      const tasks = ids.map(id => snapshot.tasks.find(t => t.featureId === feature.id && t.task.id === id)!);
      const inheritedModel = tasks.some(t => !t.assignment?.model || t.assignment.model === "session");
      const inheritedEffort = agent === "codex" && tasks.some(t => !t.assignment?.reasoningEffort && !t.assignment?.effort);
      if ((inheritedModel && !input.model?.trim()) || input.model === "session" || (inheritedEffort && !input.effort?.trim()) || [input.model, input.effort].some(v => v !== undefined && (!v.trim() || /[\0\r\n]/.test(v)))) throw new Error("Inherited settings require explicit model and effort (Codex); Claude effort is optional");
      if (input.model) argv.push("--default-model", input.model);
      if (input.effort) argv.push("--default-effort", input.effort);
    }
  } else if (action.id.endsWith(":review-preview") || action.id.endsWith(":fix-preview")) {
    if (!feature.state?.approval) throw new Error("Approved feature settings required");
    argv = ["feature", action.id.endsWith(":review-preview") ? "review" : "fix", feature.change];
  } else if (action.id.endsWith(":approve-preview")) {
    if (!input.settingsFile || !existsSync(resolve(snapshot.repository.root, input.settingsFile)) || !statSync(resolve(snapshot.repository.root, input.settingsFile)).isFile()) throw new Error("Existing settings file required");
    argv = ["feature", "approve", feature.change, "--file", input.settingsFile];
  } else throw new Error("Preview unavailable");
  return [...argv, "--dry-run", "--json"];
}
