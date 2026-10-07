import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { collectDashboard } from "./dashboard-reader.js";
import type { DashboardSnapshot } from "./dashboard-types.js";

export function formatDashboard(snapshot: DashboardSnapshot): string {
  const lines = [`Repository: ${snapshot.repository.root}`, `Features: ${snapshot.features.length}  Tasks: ${snapshot.tasks.length}  Sessions: ${snapshot.sessions.length}`];
  for (const feature of snapshot.features) lines.push(`${feature.change ?? feature.id}: ${feature.phase ?? "unmanaged"} (${feature.completed}/${feature.total} tasks satisfied)`);
  for (const task of snapshot.tasks) lines.push(`  ${task.task.id}: ${task.ready ? "ready" : task.reasons.join("; ") || "not ready"}`);
  for (const session of snapshot.sessions) lines.push(`  ${session.attempt.id}: phase=${session.phase} report=${session.reportOutcome ?? "missing"} process=${session.process} terminal=${session.terminal}`);
  for (const item of snapshot.attention) lines.push(`Attention: ${item.message}`);
  for (const error of snapshot.errors) lines.push(`Error [${error.source}${error.stale ? ", stale" : ""}]: ${error.message}`);
  return lines.join("\n");
}

export async function dashboardCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    once: { type: "boolean" }, json: { type: "boolean" }, change: { type: "string" }, store: { type: "string" }, map: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (positionals.length) throw new Error(`Unexpected dashboard argument: ${positionals[0]}`);
  if (values.help) { console.log("dashboard [--change NAME] [--store PATH --map FILE] [--once] [--json]"); return; }
  if (!!values.store !== !!values.map) throw new Error("Dashboard --store and --map must be supplied together");
  if (process.platform === "win32") throw new Error("Native Windows is outside v1; use WSL");
  const snapshot = collectDashboard({ cwd: process.cwd(), change: values.change, store: values.store ? resolve(values.store) : undefined, map: values.map ? resolve(values.map) : undefined });
  console.log(values.json ? JSON.stringify(snapshot, null, 2) : formatDashboard(snapshot));
}
