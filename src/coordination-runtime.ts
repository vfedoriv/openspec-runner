import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { validateId, type CoordinationStore } from "./coordination-state.js";
import { repository } from "./system.js";

/** Private coordinator state is feature-owned in v2; v1 retains its original roots. */
export function coordinationRuntimePath(options: {
  store: CoordinationStore; area: string; operationId: string; componentId?: string; legacyRoot?: string;
}): string {
  const { store, area, operationId, componentId } = options, { version } = store.readManifest();
  const ids = [store.featureId, area, operationId];
  // Archive previews reserve _store for the shared project, outside component IDs.
  if (componentId !== undefined && !(area === "archive-checkouts" && componentId === "_store")) ids.push(componentId);
  for (const value of ids) validateId({ value, version });
  const runtime = repository(version === 2 ? store.root : options.legacyRoot ?? store.root).stateDir;
  return resolve(runtime, ...(version === 2 ? ["coordination", "features", store.featureId] : []), area, operationId, ...(componentId === undefined ? [] : [componentId]));
}

/** Legacy v2 journals have uncertain ownership and must never trigger an automatic rerun. */
export function coordinationJournalPath(options: { store: CoordinationStore; area: string; operationId: string }): string {
  const path = `${coordinationRuntimePath(options)}.json`;
  const legacy = resolve(repository(options.store.root).stateDir, options.area, `${options.operationId}.json`);
  if (options.store.readManifest().version === 2 && !existsSync(path) && existsSync(legacy)) {
    throw new Error(`Legacy coordinator journal requires explicit reconciliation before continuing: ${legacy}`);
  }
  return path;
}
