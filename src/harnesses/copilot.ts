import { run } from "../system.js";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../platform-command.js";
import { copilotRules, copilotRulesFile, resolveCopilotSettings } from "./copilot-settings.js";
import type { HarnessAdapter, HarnessCapabilities } from "./types.js";

// The SDK checks this path directly, rather than resolving a command through PATH.
function copilotExecutable(cwd: string): string {
  const command = resolveCommand({ executable: "copilot", args: [], cwd });
  if (command.args.length) throw new Error("The SDK requires a directly executable Copilot CLI");
  const candidates = isAbsolute(command.executable) ? [command.executable]
    : (command.env.PATH ?? "").split(delimiter).map(directory => resolve(cwd, directory, command.executable));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* Continue searching PATH for a usable executable. */ }
  }
  throw new Error("Copilot executable not found on PATH");
}

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
    const cancellation = new AbortController();
    let interrupted: number | undefined;
    const interrupt = (code: number) => { interrupted ??= code; cancellation.abort(); };
    const sigint = () => interrupt(130), sigterm = () => interrupt(143);
    process.on("SIGINT", sigint); process.on("SIGTERM", sigterm);
    try {
      const cwd = options.cwd ?? process.cwd();
      const executable = copilotExecutable(cwd);
      const probe = fileURLToPath(new URL("./copilot-model-probe.js", import.meta.url));
      const { dashboardChild } = await import("../dashboard-action-runner.js");
      const result = await dashboardChild(process.execPath, [probe, executable], cwd, AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]), false, undefined, true);
      const models: unknown = JSON.parse(result.stdout);
      if (models && typeof models === "object" && "failure" in models) {
        const reasons: Record<string, string> = {
          compatibility: "Copilot SDK/runtime compatibility check failed.",
          authentication: "Copilot authentication is required for model discovery.",
          runtime: "Copilot discovery runtime or optional SDK is unavailable for this platform.",
          unavailable: "Copilot catalog unavailable.",
        };
        const reason = typeof models.failure === "string" ? reasons[models.failure] : undefined;
        return { harness: "copilot", status: "unavailable", exhaustive: false, reason: `${reason ?? reasons.unavailable} ${fallback}.` };
      }
      if (!Array.isArray(models)) throw new Error("Unexpected Copilot catalog response");
      return { harness: "copilot", status: "available", exhaustive: false, models };
    } catch (error) {
      const uncertain = error instanceof Error && error.message.includes("process termination is uncertain")
        ? " Process termination is uncertain; inspect the discovery processes before retrying." : "";
      if (interrupted) throw Object.assign(new Error(`Copilot catalog interrupted.${uncertain}`), { exitCode: interrupted });
      return { harness: "copilot", status: "unavailable", exhaustive: false, reason: `Copilot catalog unavailable.${uncertain} ${fallback}.` };
    } finally {
      process.removeListener("SIGINT", sigint); process.removeListener("SIGTERM", sigterm);
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
