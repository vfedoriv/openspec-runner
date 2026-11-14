import type { readDashboardCatalog } from "./dashboard-action-runner.js";
import type { DashboardSnapshot } from "./dashboard-types.js";
import type { CatalogEntry } from "./model-catalog.js";

export function searchCatalog(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const filter = query.toLowerCase();
  return entries.filter(entry => `${entry.selector} ${entry.label ?? ""}`.toLowerCase().includes(filter));
}

type Catalog = Awaited<ReturnType<typeof readDashboardCatalog>>;
export type CatalogCache = Map<string, { result: Catalog; fetchedAt: number }>;
const pending = new WeakMap<CatalogCache, Map<string, { promise: Promise<Catalog>; controller: AbortController; readers: number }>>();

export function catalogEntries(catalog: Catalog | undefined, snapshot: DashboardSnapshot | undefined, harness: string | undefined): CatalogEntry[] {
  const entries = new Map((catalog?.entries ?? []).map(entry => [entry.selector, entry]));
  const add = (selector?: string) => {
    if (selector && selector !== "session" && !entries.has(selector)) entries.set(selector, { selector, source: "saved" });
  };
  for (const task of snapshot?.tasks ?? []) if (task.harness === harness) add(task.assignment?.model);
  for (const session of snapshot?.sessions ?? []) if (session.attempt.agent === harness) add(session.attempt.settings?.model);
  for (const feature of snapshot?.features ?? []) {
    const approval = feature.state?.approval;
    for (const role of [approval?.implementation, approval?.review, approval?.repair])
      if (role?.harness === harness) add(role?.model);
  }
  return [...entries.values()];
}

export async function loadPickerCatalog(
  cache: CatalogCache,
  key: string,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<Catalog>,
  show: (result: Catalog | undefined, notice: string) => void,
) {
  if (signal.aborted) return;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    show(cached.result, "");
    return;
  }
  show(cached?.result, cached ? "Refreshing cached catalog" : "Loading catalog");
  let requests = pending.get(cache);
  if (!requests) { requests = new Map(); pending.set(cache, requests); }
  let request = requests.get(key);
  if (!request) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => read(controller.signal));
    request = { promise, controller, readers: 0 };
    requests.set(key, request);
  }
  const current = request;
  current.readers++;
  const release = () => {
    if (--current.readers === 0 && requests.get(key) === current) {
      requests.delete(key);
      current.controller.abort();
    }
  };
  signal.addEventListener("abort", release, { once: true });
  let result: Catalog | undefined;
  try { result = await current.promise; } catch { /* Retain the previous successful response below. */ }
  finally {
    signal.removeEventListener("abort", release);
    if (!signal.aborted) release();
  }
  if (signal.aborted) return;
  if (!result || result.status === "unavailable") {
    show(cached?.result ?? result, cached ? "Cached catalog · refresh failed" : "Catalog unavailable · enter a selector");
    return;
  }
  cache.set(key, { result, fetchedAt: Date.now() });
  show(result, "");
}
