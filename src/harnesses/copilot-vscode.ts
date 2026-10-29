import { run } from "../system.js";
import { copilotRules, copilotRulesFile, resolveCopilotSettings } from "./copilot-settings.js";
import type { HarnessAdapter } from "./types.js";

export const copilotVscodeHarness: HarnessAdapter = {
  id: "copilot-vscode", displayName: "VS Code Copilot", planningRulesPath: copilotRulesFile("copilot-vscode"),
  lifecycle: { transport: "editor", ownership: "hook", reservedSession: false, skillPrefix: "/" },
  resolveSettings: (a, i, c) => resolveCopilotSettings("copilot-vscode", a, i, c),
  async capabilities(cwd = process.cwd(), settings) {
    const features = { supervisedExecution: true, sessionOwnership: true, workerReports: true, inspection: true, callingSessionInheritance: false, modelDiscovery: false, exactResume: false, effort: false };
    try {
      const executable = String(settings?.options?.executable ?? "code");
      const profile = typeof settings?.options?.profile === "string" ? ["--profile", settings.options.profile] : [];
      const version = run(executable, ["--version"], cwd, 10000), help = run(executable, ["chat", "--help"], cwd, 10000);
      const extensions = run(executable, ["--list-extensions", ...profile], cwd, 10000).toLowerCase();
      const reasons = ["--mode", "--new-window"].filter(f => !help.includes(f)).map(f => `VS Code chat lacks ${f}`);
      if (!extensions.includes("github.copilot-chat")) reasons.push("Install and authenticate GitHub Copilot Chat in this editor host");
      return { harness: "copilot-vscode", installed: true, supported: !reasons.length, version, reasons, features };
    } catch (error) { return { harness: "copilot-vscode", installed: false, supported: false, reasons: [String(error)], features }; }
  },
  async models() { return { harness: "copilot-vscode", status: "unavailable", exhaustive: false, reason: "Use an explicit VS Code model selector from the authenticated editor; a requested model is not runtime attestation" }; },
  initialInvocation(settings, cwd, _common, prompt, mode) {
    return { executable: String(settings.options?.executable ?? "code"), args: ["chat", "--new-window", "--mode", mode,
      ...(typeof settings.options?.profile === "string" ? ["--profile", settings.options.profile] : []), prompt], cwd };
  },
  resumeInvocation() { throw new Error("VS Code exact chat resume is unsupported; open the assigned worktree and locate the saved chat session"); },
  planningRules: (r, c) => copilotRules("copilot-vscode", r, c),
};
