import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import type { Assignment } from "../plan.js";
import {
  codexArgs,
  models as codexModels,
  resolveSettings as resolveCodexSettings,
  type Settings,
} from "../codex.js";
import type {
  AgentConfig,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSettings,
  Invocation,
  ModelDiscovery,
  PlanningRulesResult,
} from "./types.js";

const rulesFile = fileURLToPath(
  new URL("../../harnesses/codex/planning-rules.md", import.meta.url),
);

function rules(root?: string, config?: AgentConfig): PlanningRulesResult {
  const content = readFileSync(rulesFile, "utf8");
  const docs = [{
    source: "bundled:harnesses/codex/planning-rules.md",
    version: content.match(/^revision:\s*(.+)$/m)?.[1]?.trim() ?? "unknown",
    hash: createHash("sha256").update(content).digest("hex"),
    content,
  }];
  if (root && config?.planningRules) {
    const supplement = resolve(root, config.planningRules);
    if (!supplement.startsWith(resolve(root) + sep))
      throw new Error("Planning rules supplement must remain inside the repository");
    if (!existsSync(supplement)) throw new Error(`Planning rules supplement does not exist: ${config.planningRules}`);
    const supplementContent = readFileSync(supplement, "utf8");
    docs.push({
      source: config.planningRules,
      version: supplementContent.match(/^revision:\s*(.+)$/m)?.[1]?.trim() ?? "unknown",
      hash: createHash("sha256").update(supplementContent).digest("hex"),
      content: supplementContent,
    });
  }
  return { harness: "codex", documents: docs };
}

function resolveSettings(
  assignment: Assignment,
  inherited?: HarnessSettings,
  _config?: AgentConfig,
): HarnessSettings {
  if (inherited?.harness && inherited.harness !== "codex")
    throw new Error("Codex cannot use settings resolved for another harness");
  const legacy = resolveCodexSettings(assignment, inherited as Settings | undefined);
  const effort = assignment.effort ?? legacy.reasoningEffort;
  return {
    ...legacy,
    harness: "codex",
    requestedModel: assignment.model ?? inherited?.model ?? legacy.model,
    ...(effort ? { effort, reasoningEffort: effort } : {}),
    sources: [
      assignment.model && assignment.model !== "session" ? "task.model" : inherited?.model ? "calling-session" : "agent.defaultModel",
      assignment.effort || assignment.reasoningEffort ? "task.effort" : inherited?.reasoningEffort ? "calling-session.effort" : "codex.model-default",
    ],
  };
}

export const codexHarness: HarnessAdapter = {
  id: "codex",
  displayName: "Codex",
  planningRulesPath: rulesFile,
  resolveSettings,
  async capabilities(cwd = process.cwd()): Promise<HarnessCapabilities> {
    try {
      const { run } = await import("../system.js");
      const help = run("codex", ["exec", "--help"], cwd, 10000);
      const missing = ["--add-dir", "--model", "--cd"].filter((x) => !help.includes(x));
      return {
        harness: "codex", installed: true, supported: !missing.length,
        reasons: missing.length ? [`Codex exec lacks required capabilities: ${missing.join(", ")}`] : [],
        features: {
          supervisedExecution: true, sessionOwnership: true, workerReports: true,
          inspection: true, callingSessionInheritance: true, modelDiscovery: true,
          exactResume: true,
          effort: true,
        },
      };
    } catch (error: any) {
      return {
        harness: "codex", installed: false, supported: false, reasons: [error.message],
        features: {
          supervisedExecution: true, sessionOwnership: true, workerReports: true,
          inspection: true, callingSessionInheritance: true, modelDiscovery: true,
          exactResume: true,
          effort: true,
        },
      };
    }
  },
  async models(): Promise<ModelDiscovery> {
    return {
      harness: "codex",
      status: "available",
      models: await codexModels(),
      exhaustive: true,
    };
  },
  initialInvocation(settings, cwd, commonGitDir, prompt, session = randomUUID()): Invocation {
    const legacy = settings as Settings;
    return { executable: "codex", args: ["exec", ...codexArgs(legacy, cwd, undefined, commonGitDir), prompt], cwd };
  },
  resumeInvocation(settings, cwd, commonGitDir, session): Invocation {
    return { executable: "codex", args: codexArgs(settings as Settings, cwd, session, commonGitDir), cwd };
  },
  planningRules: rules,
};
