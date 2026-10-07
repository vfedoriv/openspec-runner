import childProcess, { type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CollectorResponse, DashboardOptions, DashboardSnapshot } from "./dashboard-types.js";

function retainSources(previous: DashboardSnapshot | undefined, next: DashboardSnapshot): DashboardSnapshot {
  if (!previous) return next;
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
    next.assignments = [...next.assignments.filter(a => !ids.has(a.featureId)), ...previous.assignments.filter(a => ids.has(a.featureId)).map(a => ({ ...a, stale: true }))];
    next.attention.push(...previous.attention.filter(a => a.source === source && !next.attention.some(n => n.id === a.id)));
  }
  return next;
}

export function startDashboardCollector(options: DashboardOptions, receive: (snapshot: DashboardSnapshot) => void, fail: (message: string) => void): { refresh(): void; close(): Promise<void> } {
  let child: ChildProcess | undefined, generation = 0, sequence = 0;
  let pending: string | undefined, queued = false, closed = false, latest: DashboardSnapshot | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clearRequest = () => { if (timeout) clearTimeout(timeout); timeout = undefined; pending = undefined; };
  const stop = () => {
    const old = child; child = undefined; generation++; clearRequest();
    if (old) { old.removeAllListeners(); old.on("error", () => {}); old.kill(); }
  };
  const reportFailure = (message: string) => {
    if (latest) {
      const sources = Object.keys(latest.sources);
      latest = retainSources(latest, {
        ...latest,
        features: [], tasks: [], sessions: [], assignments: [],
        sources: { ...latest.sources },
        errors: sources.map(source => ({ source, message, stale: true })),
        attention: sources.map(source => ({
          id: `${source}:collector-error`, source, priority: 1, message,
        })),
      });
      receive(latest);
    }
    fail(message);
  };
  const restart = (message: string) => {
    if (closed) return;
    stop(); reportFailure(message); queued = false; refresh();
  };
  const start = () => {
    const ownGeneration = ++generation;
    const current = childProcess.fork(fileURLToPath(new URL("./dashboard-collector.js", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
    child = current;
    current.on("message", (response: CollectorResponse) => {
      if (closed || ownGeneration !== generation || response?.version !== 1 || response.id !== pending) return;
      if (Buffer.byteLength(JSON.stringify(response)) > 8 * 1024 * 1024) { restart("Dashboard response exceeds 8 MiB"); return; }
      clearRequest();
      if (response.snapshot) { latest = retainSources(latest, response.snapshot); receive(latest); }
      else reportFailure(response.error ?? "Invalid dashboard collector response");
      if (queued) { queued = false; refresh(); }
    });
    current.on("error", error => restart(`Dashboard collector: ${error.message}`));
    current.on("exit", () => restart("Dashboard collector exited"));
  };
  function refresh() {
    if (closed) return;
    if (pending) { queued = true; return; }
    if (!child) start();
    pending = `${generation}:${++sequence}`;
    timeout = setTimeout(() => restart("Dashboard collector timeout after ten seconds"), 10000);
    try { child!.send({ version: 1, id: pending, options }); }
    catch (error) { restart(error instanceof Error ? error.message : String(error)); }
  }
  const interval = setInterval(refresh, 2000);
  refresh();
  return {
    refresh,
    async close() { closed = true; clearInterval(interval); queued = false; stop(); },
  };
}
