import { claudeHarness } from "./claude.js";
import { codexHarness } from "./codex.js";
import type { HarnessAdapter, HarnessId } from "./types.js";

const adapters = new Map<string, HarnessAdapter>([
  [codexHarness.id, codexHarness],
  [claudeHarness.id, claudeHarness],
]);

export function harnessIds(): string[] {
  return [...adapters.keys()];
}

export function getHarness(id = "codex"): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter)
    throw new Error(`Unknown harness ${id}; available harnesses: ${harnessIds().join(", ")}`);
  return adapter;
}

export function hasHarness(id: unknown): id is HarnessId {
  return typeof id === "string" && adapters.has(id);
}

export function registerHarness(adapter: HarnessAdapter): void {
  if (!/^[a-z][a-z0-9-]*$/.test(adapter.id)) throw new Error(`Invalid harness ID: ${adapter.id}`);
  if (adapters.has(adapter.id)) throw new Error(`Harness already registered: ${adapter.id}`);
  adapters.set(adapter.id, adapter);
}

export function planningRules(id: string, root?: string, config?: Parameters<HarnessAdapter["planningRules"]>[1]) {
  return getHarness(id).planningRules(root, config);
}

