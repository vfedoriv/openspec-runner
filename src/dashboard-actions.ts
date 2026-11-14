import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { DashboardSnapshot, SessionSummary } from "./dashboard-types.js";
import { harnessIds, hasHarness } from "./harnesses/registry.js";
import { loadPlan } from "./plan.js";

export type DashboardAction = {
  id: string; label: string; kind: "inspect" | "diff" | "focus" | "command" | "preview" | "check" | "change" | "timeline" | "path";
  available: boolean; reason?: string; argv?: string[]; sessionId?: string;
  initialTasks?: string; fields?: DashboardField[];
};
export const taskInputLimit = 500;
const validTaskIds = (ids: string[]) => ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => /^\d+(?:\.\d+)+$/.test(id));
export type DashboardField = "destination" | "audience" | "inputFile" | "providerFile" | "assetsFile" | "revision" | "recordKind" | "recordId" | "outcome" | "reason";
export type PreviewInput = Partial<Record<DashboardField, string>> & { taskIds?: string[]; model?: string; effort?: string; settingsFile?: string; modelForSetup?: string; launchAgent?: string; launchBase?: string };

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

export const projectTarget = "project";

export function actionsFor(snapshot: DashboardSnapshot, targetId: string): DashboardAction[] {
  if (targetId === projectTarget) return [
    { id: "project:doctor", label: "Check project", kind: "check", available: true, argv: ["doctor"] },
    { id: "project:models", label: "List project default models", kind: "check", available: true, argv: ["models"] },
    ...harnessIds().flatMap(agent => [
      { id: `project:guidance:${agent}`, label: `Planning guidance · ${agent}`, kind: "check" as const, available: true, argv: ["planning-rules", "--agent", agent] },
      { id: `project:init:${agent}`, label: `Set up project · ${agent}`, kind: "change" as const, available: true, argv: ["init", "--agent", agent] },
    ]),
  ];
  const assignment = snapshot.assignments.find(row => row.id === targetId);
  const task = snapshot.tasks.find(t => t.id === targetId), session = snapshot.sessions.find(s => s.id === targetId);
  const feature = snapshot.features.find(f => f.id === (task?.featureId ?? session?.featureId ?? assignment?.featureId ?? targetId));
  if (!task && !session && !snapshot.features.some(f => f.id === targetId) && !snapshot.assignments.some(a => a.id === targetId)) return [];
  const actions: DashboardAction[] = [{ id: `${targetId}:inspect`, label: "Inspect evidence", kind: "inspect", available: true }];
  const add = (suffix: string, label: string, kind: DashboardAction["kind"], reason?: string, argv?: string[]) => actions.push({ id: `${targetId}:${suffix}`, label, kind, available: !reason, reason, argv });
  const pathActions = (kind: DashboardPathKind, label: string) => {
    const saved = savedDashboardPath(snapshot, targetId, kind);
    if (!saved) return;
    const reason = saved.stale ? "Refresh stale path evidence first" :
      kind === "worktree" && session?.worktreeAvailable === false ? "Saved worktree is missing" : undefined;
    add(`path-open-${kind}`, `Open ${label}`, "path", reason);
    add(`path-copy-${kind}`, `Copy ${label} path`, "path", reason);
  };
  const form = (suffix: string, label: string, kind: "check" | "change", argv: string[], fields: DashboardField[] = [], reason?: string) => {
    add(suffix, label, kind, reason, argv);
    actions.at(-1)!.fields = fields;
  };
  const staleSource = feature && snapshot.sources[feature.id]?.stale ? "Refresh stale evidence first" : undefined;
  if (feature?.summaryCommand && !session && !assignment) {
    const argv = [...feature.summaryCommand, ...(task ? ["--task", task.task.id] : [])];
    form("summary-read", "View saved summary", "check", argv, [], staleSource);
    form("handoff-summary-refresh", "Refresh summary", "change", [...argv, "--refresh"], [], staleSource);
    form("handoff-summary-export", "Export summary", "change", [...argv], ["destination"], staleSource);
    form("handoff-summary-brief", "Create presentation brief", "change", [...argv], ["destination", "audience", "providerFile", "assetsFile"], staleSource);
    const publish = feature.origin === "local" ? ["summary", "publish", ...argv.slice(1)] : [...argv, "--publish"];
    form("handoff-summary-publish", "Publish summary narrative", "change", publish, ["inputFile"], staleSource);
    add("summary-inspect", "Display summary inspection command", "command", undefined, argv);
    add("summary-refresh", "Display summary refresh command", "command", undefined, [...argv, "--refresh"]);
    add("summary-export", "Display summary export command", "command", undefined, [...argv, "--export", "DIRECTORY"]);
  }
  if (session) {
    add("diff", "View saved attempt diff", "diff", session.worktreeAvailable !== true ? session.worktreeAvailable === false ? "Saved worktree is missing" : "Saved worktree availability is unknown; refresh first" : !/^[a-f0-9]{40,64}$/.test(session.attempt.base) ? "Saved base is not a commit identity" : undefined);
    add("focus", "Focus saved terminal", "focus", focusReason(session));
    actions.at(-1)!.sessionId = session.id;
    pathActions("worktree", session.role === "implementation" ? "task worktree" : `${session.role} worktree`);
    pathActions("log", "saved log");
    pathActions("integration", "integration worktree");
  }
  if (feature?.coordination && snapshot.storeContext) {
    const { store, map } = snapshot.storeContext;
    const { featureId, head } = feature.coordination;
    const coordination = (operation: string) => ["coordination", operation, featureId, "--store", store, "--map", map];
    if (!assignment) {
      form("handoff-store-status", "Inspect Store status", "check", [...coordination("status"), "--revision", head], [], staleSource);
      form("handoff-store-record", "Inspect Store record", "check", [...coordination("inspect"), "--revision", head], ["recordKind", "recordId"], staleSource);
      form("handoff-receipt-import", "Import submission receipt", "change", coordination("import"), ["inputFile"], staleSource);
      form("handoff-receipt-accept", "Accept submission", "change", coordination("accept"), ["recordId"], staleSource);
      for (const operation of ["init", "approve", "assign", "revoke", "review", "merge", "accept-delivery", "complete", "archive-approve", "archive-prepare", "archive-inspect", "archive-recover", "archive-deliver"])
        add(`store-${operation}-command`, `Show Store ${operation} CLI help`, "command", undefined, [...coordination(operation), "--help"]);
    } else {
      const id = assignment.assignmentId ?? assignment.binding?.assignmentId;
      const component = (operation: string) => ["component", operation, featureId, "--store", store, "--repository", assignment.repository];
      const owner = id ? ["--assignment", id, "--owner", assignment.owner] : [];
      const change = ["--change", assignment.change];
      const blocked = staleSource ?? (assignment.stale ? "Assignment is stale" : undefined);
      if (id) {
        form("handoff-component-inspect", "Inspect component assignment", "check", [...component("inspect"), ...owner, "--revision", head], [], blocked);
        form("handoff-component-import", "Import component assignment", "change", [...component("import"), ...owner], ["inputFile"], blocked);
      }
      if (assignment.binding) {
        form("handoff-component-status", "Inspect local component status", "check", [...component("status"), ...change, "--revision", head], [], staleSource);
        form("handoff-component-export", "Export component receipt", "change", [...component("export"), ...change], ["outcome", "reason", "destination"], blocked);
        form("handoff-component-retire", "Retire local assignment", "change", [...component("retire"), ...change, ...owner], ["reason"], staleSource);
      }
    }
    return actions;
  }
  if (!feature?.change || feature.origin !== "local" || assignment) return actions;
  const staleExecution = snapshot.sources[feature.id]?.stale ? "Refresh stale change evidence first" : undefined;
  if (session) {
    if (session.role === "implementation") {
      add("resume", "Show saved worker or resume command", "check", staleExecution);
      if (session.taskId && !session.attempt.cleaned) {
        add("cleanup-attempt", "Inspect and clean this attempt", "change", staleExecution);
        add("cleanup-all-scope", "Inspect and clean this attempt (completed change)", "change", staleExecution);
      }
    }
    if (session.role !== "implementation" && feature.state) {
      const job = session.attempt;
      if (session.role === "repair" && job.phase === "completed" && !feature.state.transaction)
        add("managed-repair-integrate", "Integrate saved repair", "change", staleExecution, ["feature", "integrate", feature.change, "--attempt", job.id]);
      if (job.phase !== "integrated" && (job.phase !== "completed" || !job.worker?.exitedAt))
        add("managed-job-recover", "Record stopped job", "change", staleExecution, ["feature", "recover", feature.change, "--attempt", job.id]);
    }
    return actions;
  }
  const change = feature.change;
  pathActions("integration", "integration worktree");
  if (task) {
    pathActions("worktree", "latest task worktree");
    pathActions("log", "latest task log");
  }
  if (!task) {
    const stale = snapshot.sources[feature.id]?.stale ? "Refresh stale change evidence first" : undefined;
    if (feature.missingExecution) {
      add("starter-preview", "Preview starter settings", "check", stale, ["init-execution", change, "--dry-run"]);
      add("starter-create", "Create execution.yaml", "change", stale, ["init-execution", change]);
      add("timeline", "View timeline", "timeline");
      return actions;
    }
  }
  const last = task?.attempts.at(-1), retry = !!last && ["failed", "blocked", "stale"].includes(last.phase);
  const suggested = feature.id === targetId && !snapshot.sources[feature.id]?.stale ? feature.nextAction?.launch : undefined;
  const taskText = suggested?.[3];
  const ids = taskText?.split(",") ?? [];
  const prefill = taskText && taskText.length <= taskInputLimit && validTaskIds(ids) &&
    suggested?.length === 6 && suggested[0] === "launch" && suggested[1] === change && suggested[2] === "--tasks" &&
    suggested[4] === "--dry-run" && suggested[5] === "--json" &&
    ids.every(id => snapshot.tasks.some(t => t.featureId === feature.id && t.task.id === id && t.ready))
    ? taskText : undefined;
  add("launch-preview", prefill ? "Preview suggested batch" : "Preview launch (select exact tasks and settings)", "preview", task && !task.ready ? task.reasons.join("; ") || "Task is not ready" : undefined);
  actions.at(-1)!.initialTasks = task?.task.id ?? prefill;
  add("launch-command", "Display launch command", "command", undefined, ["launch", change, "--tasks", task?.task.id ?? "TASK_IDS"]);
  if (task) {
    add("retry-preview", "Preview retry (select this task)", "preview", retry ? undefined : "Retry requires an unsuccessful attempt");
    actions.at(-1)!.initialTasks = task.task.id;
  }
  if (task) add("retry-command", "Display retry command", "command", undefined, ["retry", change, task.task.id]);
  for (const command of ["integrate", "reconcile", "cleanup"]) add(`${command}-command`, `Display ${command} command`, "command", undefined, [command, change, ...(task && command !== "reconcile" ? ["--tasks", task.task.id] : [])]);
  if (feature.state) {
    const authority = snapshot.tasks.filter(t => t.featureId === feature.id).flatMap(t => t.reasons).find(r => /coordination authority|delegated|component|import|assignment/i.test(r));
    add("approve-preview", "Preview plan approval (existing settings file)", "preview", "Plan preview executes OpenSpec validation; no-write safety is unavailable");
    add("review-preview", "Preview review", "preview", authority);
    add("fix-preview", "Preview repair", "preview", authority);
    for (const suffix of ["final", "archive"]) add(`${suffix}-preview`, `Preview ${suffix}`, "preview", "Existing CLI preview executes configured verification commands that may write files");
    for (const command of ["approve", "review", "fix", "archive"]) add(`feature-${command}-command`, `Display feature ${command}`, "command", undefined, ["feature", command, change]);
    add("feature-final-command", "Display final approval command", "command", undefined, ["feature", "approve", change, "--final"]);
  }
  if (!task) {
    const state = feature.state;
    const delegated = state?.delegated || snapshot.assignments.some(row => row.featureId === feature.id && row.binding)
      ? "This change belongs to a delegated assignment" : undefined;
    const managed = (suffix: string, label: string, command: string, reason?: string, flags: string[] = []) =>
      add(`managed-${suffix}`, label, "change", staleExecution ?? reason, ["feature", command, change, ...flags]);
    if (!state) {
      managed("start", "Start managed feature", "start", delegated ?? (feature.execution ? "Existing work requires adoption" : undefined));
      managed("adopt", "Adopt existing work", "adopt", delegated ?? (!feature.execution ? "No existing runner work to adopt" : undefined));
    } else {
      const closed = state.archive || state.phase === "completed" ? "Feature has entered archival" : undefined;
      const approval = state.approval ? undefined : "Approve the plan first";
      managed("plan", "Check plan for approval (runs OpenSpec)", "approve", delegated ?? closed);
      managed("review", "Start review", "review", approval ?? closed);
      managed("repair", "Start repair", "fix", approval ?? closed);
      const latest = state.jobs?.at(-1);
      if (latest && ["failed", "blocked", "stale"].includes(latest.phase))
        managed("retry", `Retry ${latest.role} job`, latest.role === "review" ? "review" : "fix", approval ?? closed, ["--retry"]);
      if (state.transaction) {
        managed("repair-continue", "Continue repair integration", "integrate", undefined, ["--continue"]);
        managed("repair-abort", "Abort repair integration", "integrate", undefined, ["--abort"]);
      }
      managed("final", "Run final checks (may write to worktree)", "approve", delegated ?? approval ?? closed, ["--final"]);
      managed("archive", state.archive ? "Resume archive" : "Archive (checks may write to worktree)", "archive",
        delegated ?? (state.phase === "completed" ? "Feature is already archived" : !state.archive && !state.finalApproval ? "Approve the final result first" : undefined));
    }
  }
  if (!task) add("timeline", "View timeline", "timeline");
  const launch = actions.find(action => action.id.endsWith(":launch-preview"))!;
  add("launch-run", "Launch tasks after preview", "change", staleExecution ?? launch.reason);
  actions.at(-1)!.initialTasks = launch.initialTasks;
  if (task) {
    add("retry-run", "Retry task after preview", "change", staleExecution ?? (retry ? undefined : "Retry requires an unsuccessful attempt"));
    actions.at(-1)!.initialTasks = task.task.id;
    if (last && ["preparing", "launching"].includes(last.phase) && !last.session && !last.terminal.phase)
      add("recover-run", "Recover preparation (may rerun setup)", "change", staleExecution, ["recover", change, task.task.id]);
  }
  if (feature.execution?.transaction || feature.execution?.cleanupPending) {
    if (!task) add("integrate-continue", "Continue integration", "change", staleExecution, ["integrate", change, "--continue"]);
    if (!task && feature.execution.transaction) add("integrate-abort", "Abort integration", "change", staleExecution, ["integrate", change, "--abort"]);
  } else if (feature.execution) {
    const suggestedIntegration = feature.nextAction?.integrate;
    const completed = snapshot.tasks.some(row => row.featureId === feature.id && row.attempts.at(-1)?.phase === "completed" && (!task || row.id === task.id));
    if (completed) {
      add("integrate-run", "Integrate selected tasks", "change", staleExecution);
      actions.at(-1)!.initialTasks = task?.task.id ?? suggestedIntegration?.[3];
    }
    if (!task) {
      add("reconcile-run", "Reconcile committed plan", "change", staleExecution, ["reconcile", change]);
      add("cleanup-all", "Inspect all cleanup candidates", "check", staleExecution, ["cleanup", change, "--all", "--dry-run"]);
    } else if (last?.phase === "integrated")
      add("cleanup-inspect", "Inspect cleanup for this task", "check", staleExecution, ["cleanup", change, "--tasks", task.task.id, "--dry-run"]);
  }
  if (!task) add("validate", "Validate change (runs OpenSpec)", "check",
    snapshot.sources[feature.id]?.stale ? "Refresh stale change evidence first" : undefined, ["validate", change]);
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
    if (!ids || !validTaskIds(ids)) throw new Error("Select exact task IDs");
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
      if (!feature.state.approval || input.model || input.effort || input.launchAgent || input.launchBase) throw new Error("Managed preview requires approved settings without overrides");
    } else {
      let agent = "codex";
      try { agent = loadPlan(snapshot.repository.root, feature.change).agent; } catch { /* Missing config cannot establish a different harness. */ }
      if (input.launchAgent) {
        if (!hasHarness(input.launchAgent)) throw new Error("Select a registered harness");
        agent = input.launchAgent;
        argv.push("--agent", agent);
      }
      if (input.launchBase) {
        if (/^[\-]|[\0\r\n]/.test(input.launchBase)) throw new Error("Enter a Git ref or commit ID");
        argv.push(`--base=${input.launchBase}`);
      }
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
import { savedDashboardPath, type DashboardPathKind } from "./dashboard-paths.js";
