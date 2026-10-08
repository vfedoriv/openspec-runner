import type { ActivityPage, ActivityPageOptions } from "./activity-types.js";
import childProcess, { type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CollectorResponse, DashboardOptions, DashboardSnapshot } from "./dashboard-types.js";

function retainSources(previous: DashboardSnapshot | undefined, next: DashboardSnapshot): DashboardSnapshot {
  if (!previous) return next;
  const coordinationFailure = next.errors.find(error => error.source === "coordination");
  if (coordinationFailure) {
    for (const feature of previous.features.filter(feature => feature.origin === "shared")) {
      if (!next.errors.some(error => error.source === feature.id))
        next.errors.push({ ...coordinationFailure, source: feature.id });
    }
  }
  for (const error of next.errors) {
    const source = error.source;
    if (!previous.sources[source]) continue;
    error.stale = true;
    next.sources[source] = { ...previous.sources[source], stale: true };
    const features = previous.features.filter(f => f.id === source);
    const ids = new Set(features.map(f => f.id));
    next.features = [...next.features.filter(f => !ids.has(f.id)), ...features];
    next.tasks = [...next.tasks.filter(t => !ids.has(t.featureId)), ...previous.tasks.filter(t => ids.has(t.featureId)).map(t => ({ ...t, ready: false, reasons: [...new Set([...t.reasons, "Source data is stale"])] }))];
    next.sessions = [...next.sessions.filter(s => !ids.has(s.featureId)), ...previous.sessions.filter(s => ids.has(s.featureId)).map(s => ({ ...s, process: "unknown" as const, terminal: "unknown" as const }))];
    const retainedAssignments = previous.assignments.filter(a => ids.has(a.featureId)).map(a => ({ ...a, stale: true }));
    next.assignments = [...next.assignments.filter(a => !ids.has(a.featureId) && !retainedAssignments.some(retained =>
      a.binding && retained.featureId === `shared:${a.binding.featureId}` && retained.repository === a.repository && retained.id === `shared:${a.binding.featureId}:assignment:${a.binding.assignmentId}`)), ...retainedAssignments];
    next.attention.push(...previous.attention.filter(a => a.source === source && !next.attention.some(n => n.id === a.id)));
  }
  return next;
}


type ActivityRequest = { options: ActivityPageOptions; resolve(page: ActivityPage): void; reject(error: Error): void; signal?: AbortSignal; abort?: () => void; cancelled?: boolean };
export function startDashboardCollector(options: DashboardOptions, receive: (snapshot: DashboardSnapshot) => void, fail: (message: string) => void): { refresh(): void; readActivity(options: ActivityPageOptions, signal?: AbortSignal): Promise<ActivityPage>; close(): Promise<void> } {
  let child: ChildProcess | undefined, generation = 0, sequence = 0;
  let pending: { id: string; activity?: ActivityRequest } | undefined, queued = false, closed = false, latest: DashboardSnapshot | undefined;
  const activities: ActivityRequest[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (request: ActivityRequest, page?: ActivityPage, error?: Error) => {
    if (request.abort) request.signal?.removeEventListener("abort", request.abort);
    if (error) request.reject(error); else if (page) request.resolve(page);
  };
  const clearRequest = () => { if (timeout) clearTimeout(timeout); timeout = undefined; pending = undefined; };
  const stop = () => {
    const old = child; child = undefined; generation++;
    if (old) { old.removeAllListeners(); old.on("error", () => {}); old.kill(); }
  };
  const reportFailure = (message: string) => {
    if (latest) {
      const sources = Object.keys(latest.sources);
      latest = retainSources(latest, { ...latest, features: [], tasks: [], sessions: [], assignments: [], sources: { ...latest.sources }, errors: sources.map(source => ({ source, message, stale: true })), attention: sources.map(source => ({ id: `${source}:collector-error`, source, priority: 1, message })) });
      receive(latest);
    }
    fail(message);
  };
  const restart = (message: string) => {
    if (closed) return;
    const request = pending; clearRequest(); stop();
    if (request?.activity) settle(request.activity, undefined, new Error(message)); else reportFailure(message);
    pump();
  };
  const start = () => {
    const ownGeneration = ++generation;
    const current = childProcess.fork(fileURLToPath(new URL("./dashboard-collector.js", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
    child = current;
    current.on("message", (response: CollectorResponse) => {
      if (closed || ownGeneration !== generation || response?.version !== 1 || response.id !== pending?.id) return;
      if (Buffer.byteLength(JSON.stringify(response)) > 8 * 1024 * 1024) { restart("Dashboard response exceeds 8 MiB"); return; }
      const request = pending; clearRequest();
      if (request.activity) {
        if (!request.activity.cancelled) settle(request.activity, response.activity, response.activity ? undefined : new Error(response.error ?? "Invalid activity response"));
      } else if (response.snapshot) { latest = retainSources(latest, response.snapshot); receive(latest); }
      else reportFailure(response.error ?? "Invalid dashboard collector response");
      pump();
    });
    current.on("error", error => restart(`Dashboard collector: ${error.message}`));
    current.on("exit", () => restart("Dashboard collector exited"));
  };
  function pump() {
    if (closed || pending) return;
    const activity = activities.shift();
    if (!activity && !queued) return;
    if (!activity) queued = false;
    if (!child) start();
    pending = { id: `${generation}:${++sequence}`, activity };
    timeout = setTimeout(() => restart("Dashboard collector timeout after ten seconds"), 10000);
    try { child!.send({ version: 1, id: pending.id, options, kind: activity ? "activity" : "snapshot", activity: activity?.options }); }
    catch (error) { restart(error instanceof Error ? error.message : String(error)); }
  }
  function refresh() { if (closed) return; queued = true; pump(); }
  const interval = setInterval(refresh, 2000);
  refresh();
  return {
    refresh,
    readActivity(activityOptions, signal) {
      return new Promise((resolve, reject) => {
        if (closed || signal?.aborted) { reject(new Error(closed ? "Dashboard collector closed" : "Activity request cancelled")); return; }
        if (activities.length >= 8) { reject(new Error("Activity request queue is full")); return; }
        const request: ActivityRequest = { options: activityOptions, resolve, reject, signal };
        request.abort = () => {
          request.cancelled = true;
          const index = activities.indexOf(request); if (index >= 0) activities.splice(index, 1);
          settle(request, undefined, new Error("Activity request cancelled"));
          if (pending?.activity === request) { clearRequest(); stop(); pump(); }
        };
        signal?.addEventListener("abort", request.abort, { once: true });
        activities.push(request); pump();
      });
    },
    async close() {
      closed = true; clearInterval(interval); queued = false;
      if (pending?.activity) settle(pending.activity, undefined, new Error("Dashboard collector closed"));
      for (const request of activities.splice(0)) settle(request, undefined, new Error("Dashboard collector closed"));
      clearRequest(); stop();
    },
  };
}
