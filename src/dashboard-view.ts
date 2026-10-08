import type { ActivityEntry, ActivityPage } from "./activity-types.js";
import type { DashboardSnapshot } from "./dashboard-types.js";
export const dashboardViews = ["Overview", "Attention", "Features", "Sessions", "Assignments"] as const;
export type DashboardView = typeof dashboardViews[number];
export type DashboardFilters = { search: string; status?: string; harness?: string; owner?: string; includeCompleted: boolean; includeOlderAttempts: boolean; sort: "name" | "attention" };
export type DashboardRow = { id: string; label: string; targetId: string };
export const safeText = (value: unknown): string => String(value ?? "unknown").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const completed = (s: DashboardSnapshot, id: string) => { const f = s.features.find(f => f.id === id); return !!f && (f.phase === "completed" || !f.phase && f.total > 0 && f.completed === f.total && !s.sessions.some(a => a.featureId === id && ["preparing", "running", "launching", "manual"].includes(a.phase))); };
export function selectDashboardRows(s: DashboardSnapshot, view: DashboardView, filters: DashboardFilters): DashboardRow[] {
  const rows: Array<DashboardRow & { feature?: string; status?: string; harness?: string; owner?: string; priority?: number }> = [];
  if (view === "Overview" || view === "Features") for (const f of s.features) {
    rows.push({ id: f.id, targetId: f.id, feature: f.id, status: f.phase ?? "unmanaged", owner: s.assignments.find(a => a.featureId === f.id)?.owner, label: `${f.change ?? f.id} · ${f.phase ?? "unmanaged"} · ${f.completed}/${f.total} tasks satisfied` });
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
  return rows.filter(r => (filters.includeCompleted || !completed(s, r.feature ?? "")) && (!filters.search || safeText(r.label).toLowerCase().includes(filters.search.toLowerCase())) && (!filters.status || r.status === filters.status) && (!filters.harness || r.harness === filters.harness) && (!filters.owner || r.owner === filters.owner)).sort((a, b) => filters.sort === "attention" ? (a.priority ?? Math.min(99, ...s.attention.filter(i => i.targetId === a.targetId || i.source === a.feature).map(i => i.priority))) - (b.priority ?? Math.min(99, ...s.attention.filter(i => i.targetId === b.targetId || i.source === b.feature).map(i => i.priority))) || a.label.localeCompare(b.label) : a.label.localeCompare(b.label)).map(r => ({ id: r.id, targetId: r.targetId, label: safeText(r.label) }));
}
export function preserveSelection(rows: Array<{ id: string }>, selected?: string): string | undefined { return rows.some(r => r.id === selected) ? selected : rows[0]?.id; }
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
  walk(target, "");
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
