import { getHarness } from "./harnesses/registry.js";

export interface CatalogEntry {
  selector: string;
  label?: string;
  source: "discovered" | "example" | "configured" | "saved";
  hidden?: boolean;
  efforts?: string[];
  defaultEffort?: string;
  effortSupport?: "supported" | "unsupported" | "unknown";
}

export interface ModelCatalog {
  harness: string;
  status: "available" | "unavailable" | "partial";
  reason?: string;
  entries: CatalogEntry[];
  scope: string;
  fetchedAt: string;
}

export async function modelCatalog(harness: string, cwd = process.cwd(), configured?: string, includeHidden = false): Promise<ModelCatalog> {
  const adapter = getHarness(harness);
  try {
    const result = await adapter.models({ includeHidden, discover: true, cwd });
    const entries = new Map<string, CatalogEntry>();
    for (const example of result.examples ?? [])
      entries.set(example, { selector: example, source: "example" });
    if (configured && configured !== "session")
      entries.set(configured, { selector: configured, source: "configured" });
    for (const model of result.models ?? []) {
      if (!model || typeof model !== "object") continue;
      const row = model as Record<string, unknown>;
      const selector = row.model ?? row.id;
      if (typeof selector !== "string" || !selector.trim() || /[\x00-\x1f\x7f]/.test(selector) || !includeHidden && row.hidden === true) continue;
      const effortDisabled = harness === "copilot" || harness === "copilot-vscode";
      const efforts = !effortDisabled && Array.isArray(row.supportedReasoningEfforts)
        ? row.supportedReasoningEfforts.flatMap((value: unknown) => {
          const effort = typeof value === "object" && value !== null
            ? (value as Record<string, unknown>).reasoningEffort : value;
          return typeof effort === "string" && /^[a-z][a-z0-9-]*$/.test(effort) ? [effort] : [];
        }) : undefined;
      entries.set(selector, {
        selector, source: "discovered", efforts: efforts && [...new Set(efforts)],
        effortSupport: effortDisabled || efforts?.length === 0 ? "unsupported" : efforts?.length ? "supported" : "unknown",
        label: typeof (row.displayName ?? row.name) === "string" ? String(row.displayName ?? row.name) : undefined,
        ...(row.hidden === true ? { hidden: true } : {}),
        defaultEffort: !effortDisabled && typeof row.defaultReasoningEffort === "string" &&
          (efforts === undefined || efforts.includes(row.defaultReasoningEffort))
          ? row.defaultReasoningEffort : undefined,
      });
    }
    return { harness, status: result.status, reason: result.reason, entries: [...entries.values()], scope: cwd, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return { harness, status: "unavailable", reason: error instanceof Error ? error.message : String(error),
      entries: configured && configured !== "session" ? [{ selector: configured, source: "configured" as const }] : [],
      scope: cwd, fetchedAt: new Date().toISOString() };
  }
}
