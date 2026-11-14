import { getHarness } from "./harnesses/registry.js";

export async function modelCatalog(harness: string) {
  const adapter = getHarness(harness);
  try {
    const result = await adapter.models({ includeHidden: false });
    const entries = new Map<string, {
      selector: string;
      source: "discovered" | "example";
      efforts?: string[];
      defaultEffort?: string;
    }>();
    for (const example of result.examples ?? [])
      entries.set(example, { selector: example, source: "example" });
    for (const model of result.models ?? []) {
      if (!model || typeof model !== "object") continue;
      const row = model as Record<string, unknown>;
      const selector = row.model ?? row.id;
      if (typeof selector !== "string" || !selector.trim() || /[\x00-\x1f\x7f]/.test(selector) || row.hidden === true) continue;
      const efforts = Array.isArray(row.supportedReasoningEfforts)
        ? row.supportedReasoningEfforts.flatMap((value: unknown) => {
          const effort = typeof value === "object" && value !== null
            ? (value as Record<string, unknown>).reasoningEffort : value;
          return typeof effort === "string" ? [effort] : [];
        }) : undefined;
      entries.set(selector, {
        selector, source: "discovered", efforts,
        defaultEffort: typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : undefined,
      });
    }
    return { harness, status: result.status, reason: result.reason, entries: [...entries.values()] };
  } catch (error) {
    return { harness, status: "unavailable", reason: error instanceof Error ? error.message : String(error), entries: [] };
  }
}
