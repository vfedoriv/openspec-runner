import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assignment } from "../plan.js";
import { containedPath, unredirectedPath } from "../platform-paths.js";
import type { AgentConfig, HarnessSettings, PlanningRulesResult } from "./types.js";

export type CopilotId = "copilot" | "copilot-vscode";
export function resolveCopilotSettings(id: CopilotId, assignment: Assignment, inherited?: HarnessSettings, config?: AgentConfig): HarnessSettings {
  if (inherited?.harness && inherited.harness !== id) throw new Error("Copilot cannot inherit another harness's settings");
  const model = assignment.model ?? inherited?.model ?? config?.defaultModel;
  if (!model || model === "session" || /[\0\r\n]/.test(model)) throw new Error("Copilot requires an explicit model; calling-session inheritance is unavailable");
  if (assignment.effort || assignment.reasoningEffort || inherited?.effort || inherited?.reasoningEffort)
    throw new Error("Copilot effort is unsupported by this adapter");
  if (config?.permissionMode) throw new Error("Copilot permissionMode is unsupported; use explicit allowedTools for CLI or editor permissions");
  if (id === "copilot-vscode" && config?.allowedTools?.length) throw new Error("VS Code tool permissions must be configured in the editor");
  const options: Record<string, unknown> = {
    hookFormat: id === "copilot" ? "copilot" : "vscode", startupTimeoutMs: 60000, completionTimeoutMs: 1800000,
    ...(id === "copilot-vscode" ? { executable: "code" } : {}),
    ...(config?.options ?? {}), ...(inherited?.options ?? {}),
  };
  const allowed = ["hookFormat", "startupTimeoutMs", "completionTimeoutMs", "allowedTools", ...(id === "copilot-vscode" ? ["executable", "profile"] : [])];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Unknown Copilot option: ${key}`);
  if (!["copilot", "vscode"].includes(String(options.hookFormat))) throw new Error("Invalid hookFormat option");
  for (const [key, max] of [["startupTimeoutMs", 600000], ["completionTimeoutMs", 86400000]] as const) {
    const value = options[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1000 || value > max) throw new Error(`Invalid ${key} option`);
  }
  for (const key of ["executable", "profile"]) if (options[key] !== undefined && (typeof options[key] !== "string" || !options[key] || /[\0\r\n]/.test(options[key] as string))) throw new Error(`Invalid ${key} option`);
  const tools = options.allowedTools ?? config?.allowedTools ?? [];
  if (!Array.isArray(tools) || tools.some(t => typeof t !== "string" || !t || /[\0\r\n]/.test(t))) throw new Error("Invalid allowedTools option");
  if (id === "copilot") options.allowedTools = tools;
  else if (tools.length) throw new Error("VS Code allowedTools option is unsupported");
  return { harness: id, model, requestedModel: assignment.model ?? model, options, sources: [assignment.model ? "task.model" : inherited?.model ? "cli.default-model" : "agent.defaultModel"] };
}
export function copilotRulesFile(id: CopilotId): string {
  return fileURLToPath(new URL(`../../harnesses/${id}/planning-rules.md`, import.meta.url));
}
export function copilotRules(id: CopilotId, root?: string, config?: AgentConfig): PlanningRulesResult {
  const paths = [{ path: copilotRulesFile(id), source: `bundled:harnesses/${id}/planning-rules.md` }];
  if (root && config?.planningRules) {
    const path = resolve(root, config.planningRules);
    if (!containedPath(root, path) || !unredirectedPath(path)) throw new Error("Planning supplement must remain inside repository");
    paths.push({ path, source: config.planningRules });
  }
  return { harness: id, documents: paths.map(({ path, source }) => {
    const content = readFileSync(path, "utf8");
    return { source, content, version: content.match(/^revision:\s*(.+)$/m)?.[1] ?? "unknown", hash: createHash("sha256").update(content).digest("hex") };
  }) };
}
