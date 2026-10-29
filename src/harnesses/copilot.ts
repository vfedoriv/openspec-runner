import { run } from "../system.js";
import { dirname, resolve } from "node:path";
import { copilotRules, copilotRulesFile, resolveCopilotSettings } from "./copilot-settings.js";
import type { HarnessAdapter, HarnessCapabilities } from "./types.js";

export async function copilotCapabilities(cwd = process.cwd()): Promise<HarnessCapabilities> {
  const features = { supervisedExecution: true, sessionOwnership: true, workerReports: true, inspection: true, callingSessionInheritance: false, modelDiscovery: false, exactResume: false, effort: false };
  try {
    const version = run("copilot", ["--version"], cwd, 10000), help = run("copilot", ["--help"], cwd, 10000);
    const missing = ["--model", "--session-id", "--add-dir", "--allow-tool"].filter(flag => !help.includes(flag));
    return { harness: "copilot", installed: true, version, supported: !missing.length, reasons: missing.map(flag => `Copilot lacks ${flag}`), features: { ...features, exactResume: !missing.length } };
  } catch (error) { return { harness: "copilot", installed: false, supported: false, reasons: [String(error)], features }; }
}
export const copilotHarness: HarnessAdapter = {
  id: "copilot", displayName: "GitHub Copilot CLI", planningRulesPath: copilotRulesFile("copilot"),
  lifecycle: { transport: "process", ownership: "hook", reservedSession: true, skillPrefix: "/" },
  resolveSettings: (a, i, c) => resolveCopilotSettings("copilot", a, i, c), capabilities: copilotCapabilities,
  async models() { return { harness: "copilot", status: "unavailable", exhaustive: false, reason: "Choose an explicit model supported by your authenticated Copilot CLI; no non-inference catalog is queried" }; },
  initialInvocation(settings, cwd, common, prompt, session) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session)) throw new Error("Copilot requires a reserved session UUID");
    return { executable: "copilot", args: ["--model", settings.model, "--session-id", session, "--add-dir", common,
      "--add-dir", resolve(dirname(cwd), "reports"),
      ...((settings.options?.allowedTools as string[] | undefined) ?? []).flatMap(t => ["--allow-tool", t])], cwd, stdin: prompt };
  },
  resumeInvocation(settings, cwd, _common, session) {
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("Invalid Copilot session ID");
    return { executable: "copilot", args: ["--session-id", session, "--model", settings.model], cwd };
  },
  planningRules: (r, c) => copilotRules("copilot", r, c),
};
