import type { readDashboardCatalog } from "./dashboard-action-runner.js";

type Catalog = Awaited<ReturnType<typeof readDashboardCatalog>>;
export type CatalogCache = Map<string, { result: Catalog; fetchedAt: number }>;

export async function loadPickerCatalog(
  cache: CatalogCache,
  key: string,
  signal: AbortSignal,
  read: () => Promise<Catalog>,
  show: (result: Catalog | undefined, notice: string) => void,
) {
  if (signal.aborted) return;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 60_000) {
    show(cached.result, "");
    return;
  }
  show(cached?.result, cached ? "Refreshing cached catalog" : "Loading catalog");
  let result: Catalog | undefined;
  try { result = await read(); } catch { /* Retain the previous successful response below. */ }
  if (signal.aborted) return;
  if (!result || result.status === "unavailable") {
    show(cached?.result ?? result, cached ? "Cached catalog · refresh failed" : "Catalog unavailable · enter a selector");
    return;
  }
  cache.set(key, { result, fetchedAt: Date.now() });
  show(result, "");
}
