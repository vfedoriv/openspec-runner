import { readActivityPage } from "./activity-reader.js";
import { collectDashboard } from "./dashboard-reader.js";
import type { CollectorRequest, CollectorResponse } from "./dashboard-types.js";
const maximum = 8 * 1024 * 1024;
process.on("message", (request: CollectorRequest) => {
  if (request?.version !== 1 || typeof request.id !== "string" || typeof request.options?.cwd !== "string") return;
  let response: CollectorResponse;
  try {
    response = request.kind === "activity" && request.activity ? { version: 1, id: request.id, activity: readActivityPage(request.activity) } : { version: 1, id: request.id, snapshot: collectDashboard(request.options) };
    if (Buffer.byteLength(JSON.stringify(response)) > maximum) throw new Error("Dashboard response exceeds 8 MiB");
  } catch (error) {
    response = { version: 1, id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  if (process.connected) process.send?.(response);
});
process.on("disconnect", () => process.exit(0));
