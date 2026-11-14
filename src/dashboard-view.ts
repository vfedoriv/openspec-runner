import type { ActivityEntry, ActivityPage } from "./activity-types.js";
import { actionsFor, projectTarget } from "./dashboard-actions.js";
import type { DashboardSnapshot } from "./dashboard-types.js";
import type { NextAction, RecoveryEntry } from "./runner.js";
import { renderArgument } from "./platform-command.js";
export const dashboardViews = ["Overview", "Attention", "Features", "Sessions", "Assignments"] as const;
export type DashboardView = typeof dashboardViews[number];
export type DashboardFilters = { search: string; status?: string; harness?: string; owner?: string; includeCompleted: boolean; includeOlderAttempts: boolean; sort: "name" | "attention" };
export type DashboardRow = { id: string; label: string; targetId: string; primary?: string; tasks?: string; projectSetup?: boolean };
export const safeText = (value: unknown): string => String(value ?? "unknown").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
export function recoveryLines(entries: RecoveryEntry[] = []): string[] {
  return entries.flatMap(entry => [
    ["Recovery", entry.task && `task ${entry.task}`, entry.attempt && `attempt ${entry.attempt}`].filter(Boolean).join(" · "),
    ...(entry.worktree ? [`Worktree · ${safeText(entry.worktree)}`] : []),
    ...(entry.log ? [`Log · ${safeText(entry.log)}`] : []),
    safeText(entry.evidence), safeText(entry.next),
    ...(entry.argv.length ? nextActionLines({ blocker: { message: "", argv: entry.argv } }).slice(1) : []),
  ]);
}
export function nextActionLines(action: NextAction | undefined): string[] {
  if (!action) return [];
  const shell = process.platform === "win32" ? "powershell" : "posix";
  const command = (argv: string[]) => `openspec-runner ${argv.map(arg => /^[\w.-]+$/.test(arg) ? arg : renderArgument(arg, shell)).join(" ")}`;
  const lines: string[] = [];
  if (action.integrate) lines.push(`Integrate · ${command(action.integrate)}`);
  if (action.launch) lines.push(`Preview launch · ${command(action.launch)}`);
  if (action.blocker) {
    lines.push(`Blocker · ${safeText(action.blocker.message).replace(/\s+/g, " ")}`);
    if (action.blocker.argv) lines.push(`Recovery · ${command(action.blocker.argv)}`);
  }
  return lines;
}
const completed = (s: DashboardSnapshot, id: string) => { const f = s.features.find(f => f.id === id); return !!f && (f.phase === "completed" || !f.phase && f.total > 0 && f.completed === f.total && !s.sessions.some(a => a.featureId === id && ["preparing", "running", "launching", "manual"].includes(a.phase))); };
export function firstRunRows(s: DashboardSnapshot, validated: ReadonlySet<string> = new Set()): DashboardRow[] {
  if (!s.setup) return [];
  const { configuration, scopedChange } = s.setup;
  const row = (key: string, label: string, targetId = projectTarget, suffix?: string): DashboardRow => ({
    id: `first-run:${key}`, label: `First run · ${label}`, targetId,
    ...(suffix ? { primary: actionsFor(s, targetId).find(action => action.available && action.id.endsWith(`:${suffix}`))?.id } : {}),
  });
  if (configuration === "missing") return [{ ...row("setup", "Set up the project (choose a harness)"), projectSetup: true }];
  if (configuration === "invalid") return [row("config", "Check invalid runner configuration", projectTarget, "doctor")];
  const local = s.features.filter(f => f.origin === "local");
  const errors = s.errors.filter(error => error.source.startsWith("local:"));
  const guidance = errors.map(error => row(`error:${error.source}`, `${error.source.slice(6)} · ${error.message}`, error.source));
  for (const feature of local) {
    if (s.sources[feature.id]?.stale || errors.some(error => error.source === feature.id)) continue;
    if (feature.missingExecution) guidance.push(
      row(`starter:${feature.id}`, `${feature.change} · Create starter settings`, feature.id, "starter-create"));
    else if (feature.planFingerprint && !feature.execution && !feature.state &&
      feature.completed < feature.total && !validated.has(`${feature.id}:${feature.planFingerprint}`))
      guidance.push(row(`validate:${feature.id}:${feature.planFingerprint}`, `${feature.change} · Validate the change`, feature.id, "validate"));
  }
  if (guidance.length || local.length || s.errors.length) return guidance;
  return scopedChange ? [row("scope", `No local change named ${scopedChange}. Check --change or create its OpenSpec task list.`)] :
    [row("tasks", "Create an OpenSpec change with numbered checkboxes in tasks.md")];
}

function overviewWork(s: DashboardSnapshot) {
  const rows: Array<DashboardRow & { feature: string; priority: number }> = [];
  for (const feature of s.features) {
    const name = feature.change ?? feature.id;
    const stale = s.sources[feature.id]?.stale || s.errors.some(error => error.source === feature.id);
    const add = (key: string, label: string, priority: number, targetId = feature.id, suffix?: string, tasks?: string) => {
      const primary = !stale && suffix ? actionsFor(s, targetId).find(a => a.available && a.id === `${targetId}:${suffix}`)?.id : undefined;
      rows.push({ id: `${feature.id}:overview:${key}`, targetId, feature: feature.id, priority,
        label: `${priority < 6 ? "Needs you" : "In progress"} · ${name} · ${label}`, primary, tasks });
    };
    if (stale) { add("stale", "Inspect source error", 1); continue; }
    const recovery = feature.recovery ?? [];
    for (const entry of recovery) {
      const session = s.sessions.find(row => row.featureId === feature.id && row.attempt.id === entry.attempt);
      if (entry.kind === "worker")
        add(`worker:${entry.attempt}`, entry.evidence, 6, session?.id);
      else add(`${entry.kind}:${entry.attempt ?? entry.task ?? ""}`, entry.kind === "cleanup" ? "Resume cleanup" :
        /contains unresolved conflicts/.test(entry.evidence) ? `Resolve conflict${entry.task ? ` in task ${entry.task}` : ""}` :
        "Inspect interrupted integration", 0);
    }
    const waiting = new Set(recovery.map(entry => entry.attempt));
    for (const session of s.sessions.filter(row => row.featureId === feature.id)) {
      if (waiting.has(session.attempt.id)) continue;
      const latest = s.sessions.filter(row => row.featureId === feature.id && row.role === session.role && row.taskId === session.taskId).at(-1);
      if (latest?.id === session.id && ["failed", "blocked", "stale"].includes(session.phase))
        add(`failed:${session.id}`, `Inspect ${session.phase} ${session.role} attempt ${session.attempt.id}`, 1, session.id);
    }
    if (feature.phase === "awaiting-plan-approval") add("plan", "Approve plan", 2, feature.id, "managed-plan");
    if (feature.phase === "awaiting-final-approval" && !feature.state?.finalApproval)
      add("final", "Approve final result", 2, feature.id, "managed-final");
    const integrate = feature.nextAction?.integrate;
    if (integrate?.[0] === "integrate" && integrate[1] === feature.change && integrate[2] === "--tasks" && integrate[3])
      add(`integrate:${integrate[3]}`, `Integrate tasks ${integrate[3]}`, 3, feature.id, "integrate-run", integrate[3]);
    const launch = actionsFor(s, feature.id).find(a => a.id.endsWith(":launch-run") && a.available && a.initialTasks);
    if (launch) add(`launch:${launch.initialTasks}`, `Preview launch for tasks ${launch.initialTasks}`, 5, feature.id, "launch-run", launch.initialTasks);
  }
  for (const error of s.errors) if (!s.features.some(f => f.id === error.source))
    rows.push({ id: `overview:error:${error.source}`, targetId: error.source, feature: error.source,
      priority: 1, label: `Needs you · ${error.source} · ${error.message}` });
  return rows;
}
export function selectDashboardRows(s: DashboardSnapshot, view: DashboardView, filters: DashboardFilters): DashboardRow[] {
  const rows: Array<DashboardRow & { feature?: string; status?: string; harness?: string; owner?: string; priority?: number }> = [];
  if (view === "Overview") rows.push(...overviewWork(s));
  if (view === "Overview" || view === "Features") for (const f of s.features) {
    rows.push({ id: f.id, targetId: f.id, feature: f.id, status: f.phase ?? "unmanaged", owner: s.assignments.find(a => a.featureId === f.id)?.owner, label: `${f.change ?? f.id} · ${f.phase ?? "unmanaged"} · ${f.completed}/${f.total} ${f.origin === "shared" ? "components delivered" : "tasks satisfied"}` });
    if (view === "Features") for (const t of s.tasks.filter(t => t.featureId === f.id)) rows.push({ id: t.id, targetId: t.id, feature: f.id, status: t.attempts.at(-1)?.phase ?? (t.task.completed ? "satisfied" : t.ready ? "ready" : "blocked"), harness: t.harness, label: `${t.task.id} ${t.task.description} · ${t.ready ? "ready" : t.reasons.join("; ") || "not ready"}` });
  }
  if (view === "Attention") for (const a of s.attention) rows.push({ id: a.id, targetId: a.targetId ?? a.source, feature: a.source, priority: a.priority, status: "attention", label: a.message });
  if (view === "Sessions" || view === "Overview") for (const a of s.sessions) {
    const latest = a.taskId ? s.sessions.filter(b => b.taskId === a.taskId).at(-1)?.id : s.sessions.filter(b => b.featureId === a.featureId && b.role === a.role).at(-1)?.id;
    if (!filters.includeOlderAttempts && latest !== a.id) continue;
    rows.push({ id: a.id, targetId: a.id, feature: a.featureId, status: a.phase, harness: a.attempt.agent, label: `${a.attempt.id} · ${a.role} · phase ${a.phase} · process ${a.process} · report ${a.reportOutcome ?? "missing"}` });
  }
  if (view === "Assignments") for (const a of s.assignments) rows.push({ id: a.id, targetId: a.id, feature: a.featureId, owner: a.owner, status: a.stale ? "stale" : a.status?.phase ?? a.binding?.phase ?? "unknown", label: `${a.componentId} · owner ${a.owner} · ${a.stale ? "stale" : a.status?.phase ?? a.binding?.phase ?? "unknown"}` });
  for (const row of rows) {
    const task = s.tasks.find(t => t.id === row.targetId), session = s.sessions.find(a => a.id === row.targetId);
    row.owner ??= s.assignments.find(a => a.featureId === row.feature)?.owner;
    row.harness ??= task?.harness ?? session?.attempt.agent ?? s.tasks.find(t => t.featureId === row.feature)?.harness;
  }
  return rows.filter(r => (filters.includeCompleted || !completed(s, r.feature ?? "")) && (!filters.search || safeText(r.label).toLowerCase().includes(filters.search.toLowerCase())) && (!filters.status || r.status === filters.status) && (!filters.harness || r.harness === filters.harness) && (!filters.owner || r.owner === filters.owner)).sort((a, b) => view === "Overview" ? (a.priority ?? 9) - (b.priority ?? 9) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id) : filters.sort === "attention" ? (a.priority ?? Math.min(99, ...s.attention.filter(i => i.targetId === a.targetId || i.source === a.feature).map(i => i.priority))) - (b.priority ?? Math.min(99, ...s.attention.filter(i => i.targetId === b.targetId || i.source === b.feature).map(i => i.priority))) || a.label.localeCompare(b.label) : a.label.localeCompare(b.label)).map(r => ({ id: r.id, targetId: r.targetId, label: safeText(r.label), ...(r.primary ? { primary: r.primary } : {}), ...(r.tasks ? { tasks: r.tasks } : {}) }));
}
export function preserveSelection(rows: Array<{ id: string }>, selected?: string): string | undefined { return rows.some(r => r.id === selected) ? selected : rows[0]?.id; }
export type TimelineEvent = { id: string; title: string; at?: string; targetId: string; evidence?: unknown };

export function featureTimeline(snapshot: DashboardSnapshot, featureId: string): TimelineEvent[] {
  const feature = snapshot.features.find(row => row.id === featureId && row.origin === "local");
  if (!feature) return [];
  const events: TimelineEvent[] = [];
  const add = (id: string, title: string, targetId: string, evidence: unknown, at?: string) =>
    events.push({ id, title, targetId, evidence, ...(at && Number.isFinite(Date.parse(at)) ? { at } : {}) });
  for (const session of snapshot.sessions.filter(row => row.featureId === featureId)) {
    const { attempt, id, role } = session;
    const subject = "task" in attempt ? `Task ${attempt.task}` : role === "review" ? "Review" : "Repair";
    const label = `${subject} · ${attempt.id}`;
    add(`${id}:attempt`, `${subject} attempt recorded · ${attempt.id}`, id, undefined);
    if (attempt.report) add(`${id}:report`, `Report accepted (${attempt.report.outcome}) · ${label}`, id, attempt.report);
    if (attempt.worker?.exitedAt)
      add(`${id}:exit`, `Worker exit recorded · ${label}`, id, attempt.worker, attempt.worker.exitedAt);
    if (attempt.worker?.completion?.source === "agent-stop" || attempt.terminalEvidence?.type === "agent-stop")
      add(`${id}:stop`, `Agent stop recorded · ${label}`, id, attempt.terminalEvidence ?? attempt.worker?.completion, attempt.worker?.completion?.source === "agent-stop" ? attempt.worker.completion.at : undefined);
    if (attempt.phase === "integrated")
      add(`${id}:integrated`, `Result integrated · ${label}`, id, { report: attempt.report, integration: feature.execution });
  }
  const approvalKey = (approval: { token: string; at: string }) => `${approval.token}:${approval.at}`;
  const approvals = new Map((feature.state?.approvalHistory ?? []).map(approval => [approvalKey(approval), approval]));
  if (feature.state?.approval) approvals.set(approvalKey(feature.state.approval), feature.state.approval);
  for (const [key, approval] of approvals)
    add(`approval:${key}`, "Plan approved", featureId, approval, approval.at);
  const final = feature.state?.finalApproval;
  if (final) add(`final:${final.token}`, "Final result approved", featureId, final, final.at);
  const archive = feature.state?.archive;
  if (archive) add(`archive:${archive.marker}`, feature.state?.completedAt ? "Feature archived" : `Archive · ${archive.phase}`,
    featureId, archive, feature.state?.completedAt);
  return events.sort((a, b) => a.at && b.at ? Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id) :
    a.at ? -1 : b.at ? 1 : 0);
}

export function mergeActivity(previous: ActivityEntry[], page: ActivityPage, direction: "older" | "newer"): ActivityEntry[] {
  if (!page.reset && !page.entries.length) return previous;
  if (direction === "older" || page.reset) return page.entries.slice(-1000);
  return [...new Map([...previous, ...page.entries].map(e => [e.id, e])).values()].slice(-1000);
}
/** Human labels retain nested evidence, without requiring operators to decode JSON. */
export function detailLines(s: DashboardSnapshot, targetId: string): string[] {
  const target = [...s.features, ...s.tasks, ...s.sessions, ...s.assignments].find(t => t.id === targetId);
  const lines: string[] = [];
  const walk = (value: unknown, prefix: string, depth = 0) => {
    if (lines.length >= 500 || depth > 8) return;
    if (value === undefined || value === null) { lines.push(`${prefix}: unknown`); return; }
    if (typeof value !== "object") { lines.push(`${prefix}: ${safeText(value)}`); return; }
    if (Array.isArray(value)) { if (!value.length) lines.push(`${prefix}: none`); value.slice(0, 100).forEach((v, i) => walk(v, `${prefix} ${i + 1}`, depth + 1)); return; }
    for (const [key, v] of Object.entries(value)) walk(v, `${prefix ? prefix + " / " : ""}${key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase())}`, depth + 1);
  };
  if (target && "origin" in target) {
    const { nextAction, recovery, ...evidence } = target;
    lines.push(...nextActionLines(nextAction), ...recoveryLines(recovery));
    walk(evidence, "");
  } else {
    const session = s.sessions.find(row => row.id === targetId);
    if (session) lines.push(...recoveryLines(s.features.find(f => f.id === session.featureId)?.recovery
      ?.filter(entry => entry.attempt === session.attempt.id)));
    walk(target, "");
  }
  if (s.features.some(f => f.id === targetId)) walk(s.tasks.filter(t => t.featureId === targetId), "Tasks, dependencies and settings");
  if (target && "featureId" in target) walk(s.features.find(f => f.id === target.featureId)?.state, "Feature settings and evidence");
  for (const e of s.errors) lines.push(`Source ${e.source}${e.stale ? " [STALE]" : " [ERROR]"}: ${safeText(e.message)}`);
  return lines;
}

export function activityLineCount(entries: ActivityEntry[], expanded: boolean): number {
  return entries.reduce((total, entry) => {
    if (!expanded) return total + 1;
    let count = 1;
    for (let i = 0; i < entry.text.length; i++) if (entry.text[i] === "\n") count++;
    return total + count;
  }, 0);
}
/** Traverse the bounded retained feed, allocating only a single entry and the visible viewport. */
export function activityViewport(entries: ActivityEntry[], expanded: boolean, offset: number, limit: number): string[] {
  const visible: string[] = [];
  let skip = offset;
  for (let index = entries.length - 1; index >= 0 && visible.length < limit; index--) {
    const entry = entries[index];
    const label = safeText(`${entry.observedAt ?? "time unknown"} ${entry.kind} [${entry.identity.harness}/${entry.identity.attemptId}] ${entry.text}`);
    const lines = expanded ? label.split("\n") : [label.replace(/\n/g, " ↵ ")];
    if (skip >= lines.length) { skip -= lines.length; continue; }
    for (let line = lines.length - 1 - skip; line >= 0 && visible.length < limit; line--) visible.push(lines[line]);
    skip = 0;
  }
  return visible.reverse();
}

export function filterActivity(entries: ActivityEntry[], search: string): ActivityEntry[] {
  const query = search.toLowerCase();
  return query ? entries.filter(entry => entry.text.toLowerCase().includes(query)) : entries;
}
/** Preserve the last inspected entry/line in the current filtered coordinate space. */
export function preserveActivityOffset(previous: ActivityEntry[], next: ActivityEntry[], offset: number, expanded: boolean): number {
  let remaining = Math.max(0, offset);
  let anchor: { id: string; line: number } | undefined;
  for (let index = previous.length - 1; index >= 0; index--) {
    const count = activityLineCount([previous[index]], expanded);
    if (remaining < count) { anchor = { id: previous[index].id, line: count - 1 - remaining }; break; }
    remaining -= count;
  }
  if (anchor) {
    let after = 0;
    for (let index = next.length - 1; index >= 0; index--) {
      const count = activityLineCount([next[index]], expanded);
      if (next[index].id === anchor.id) return after + Math.max(0, count - 1 - anchor.line);
      after += count;
    }
  }
  // Retention or a changed search can remove the anchor; remain within available history.
  return Math.max(0, Math.min(offset, activityLineCount(next, expanded) - 1));
}
