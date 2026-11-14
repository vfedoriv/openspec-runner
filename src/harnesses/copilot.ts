import { run } from "../system.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../platform-command.js";
import { copilotRules, copilotRulesFile, resolveCopilotSettings } from "./copilot-settings.js";
import type { HarnessAdapter, HarnessCapabilities } from "./types.js";

export async function copilotCapabilities(cwd = process.cwd()): Promise<HarnessCapabilities> {
  const features = { supervisedExecution: true, sessionOwnership: true, workerReports: true, inspection: true, callingSessionInheritance: false, modelDiscovery: false, exactResume: false, effort: false };
  try {
    const version = run("copilot", ["--version"], cwd, 10000), help = run("copilot", ["--help"], cwd, 10000);
    const missing = ["--model", "--trust-folder", "--prompt", "--add-dir", "--allow-tool"].filter(flag => !help.includes(flag));
    return { harness: "copilot", installed: true, version, supported: !missing.length, reasons: missing.map(flag => `Copilot lacks ${flag}`), features: { ...features, exactResume: !missing.length && help.includes("--resume") } };
  } catch (error) { return { harness: "copilot", installed: false, supported: false, reasons: [String(error)], features }; }
}
export const copilotHarness: HarnessAdapter = {
  id: "copilot", displayName: "GitHub Copilot CLI", planningRulesPath: copilotRulesFile("copilot"),
  lifecycle: { transport: "process", ownership: "hook", reservedSession: false, skillPrefix: "/" },
  resolveSettings: (a, i, c) => resolveCopilotSettings("copilot", a, i, c), capabilities: copilotCapabilities,
  async models(options) {
    const fallback = "Choose a selector from /model in your authenticated Copilot CLI";
    if (!options?.discover) return { harness: "copilot", status: "unavailable", exhaustive: false, reason: fallback };
    try {
      const cwd = options.cwd ?? process.cwd();
      const command = resolveCommand({ executable: "copilot", args: [], cwd });
      if (command.args.length) throw new Error("The SDK requires a directly executable Copilot CLI");
      const probe = fileURLToPath(new URL("./copilot-model-probe.js", import.meta.url));
      const { dashboardChild } = await import("../dashboard-action-runner.js");
      const result = await dashboardChild(process.execPath, [probe, command.executable], cwd, AbortSignal.timeout(15_000));
      const models: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(models)) throw new Error("Unexpected Copilot catalog response");
      return { harness: "copilot", status: "available", exhaustive: false, models };
    } catch {
      return { harness: "copilot", status: "unavailable", exhaustive: false, reason: `Copilot catalog unavailable. ${fallback}.` };
    }
  },
  initialInvocation(settings, cwd, common, prompt) {
    return { executable: "copilot", args: ["--model", settings.model, "--trust-folder", "-p", prompt, "--add-dir", common,
      "--add-dir", resolve(dirname(cwd), "reports"),
      ...((settings.options?.allowedTools as string[] | undefined) ?? []).flatMap(t => ["--allow-tool", t])], cwd };
  },
  resumeInvocation(settings, cwd, _common, session) {
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("Invalid Copilot session ID");
    return { executable: "copilot", args: ["--resume", session, "--model", settings.model], cwd };
  },
  planningRules: (r, c) => copilotRules("copilot", r, c),
};
