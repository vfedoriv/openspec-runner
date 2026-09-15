import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep, dirname } from "node:path";
import type { Assignment } from "../plan.js";
import type {
  AgentConfig,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSettings,
  Invocation,
  ModelDiscovery,
  PlanningRulesResult,
} from "./types.js";
import { run } from "../system.js";

const rulesFile = fileURLToPath(
  new URL("../../harnesses/claude/planning-rules.md", import.meta.url),
);

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value);
}

function optionConfig(config?: AgentConfig): Record<string, unknown> {
  return {
    permissionMode: config?.permissionMode ?? "dontAsk",
    allowedTools: config?.allowedTools ?? [],
  };
}

export function resolveClaudeSettings(
  assignment: Assignment,
  inherited?: HarnessSettings,
  config?: AgentConfig,
): HarnessSettings {
  if (inherited?.harness && inherited.harness !== "claude")
    throw new Error("Claude cannot use settings resolved for another harness");
  if (inherited?.reasoningEffort !== undefined)
    throw new Error("Claude uses effort; reasoningEffort is a Codex-only compatibility field");
  if (assignment.reasoningEffort !== undefined)
    throw new Error(
      "Claude assignments use effort in version 2; reasoningEffort belongs to the Codex compatibility schema",
    );
  const explicit = !!assignment.model && assignment.model !== "session";
  const callingSession = assignment.model === "session";
  const model = explicit
    ? assignment.model
    : callingSession
      ? inherited?.model
      : inherited?.model ?? config?.defaultModel;
  if (!model || !identifier(model))
    throw new Error(
      "Claude cannot inherit a calling-session model; pass --default-model or assign an explicit Claude model",
    );
  const effort = assignment.effort ?? inherited?.effort;
  if (effort !== undefined && !identifier(effort))
    throw new Error(`Invalid Claude effort: ${effort}`);
  const options = optionConfig(config);
  return {
    harness: "claude",
    model,
    requestedModel: assignment.model ?? model,
    ...(effort ? { effort } : {}),
    options,
    sources: [
      explicit ? "task.model" : callingSession ? "calling-session" : inherited?.model ? "cli.default-model" : "agent.defaultModel",
      ...(assignment.effort ? ["task.effort"] : effort ? ["inherited.effort"] : ["claude.cli-default"]),
    ],
  };
}

function commonArgs(
  settings: HarnessSettings,
  cwd: string,
  commonGitDir: string,
  session: string,
  resume: boolean,
): string[] {
  const options = settings.options ?? {};
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    settings.model,
    ...(resume ? ["--resume", session] : ["--session-id", session]),
    "--permission-mode",
    typeof options.permissionMode === "string" ? options.permissionMode : "dontAsk",
    "--add-dir",
    commonGitDir,
    "--add-dir",
    cwd,
    "--add-dir",
    dirname(cwd),
  ];
  if (settings.effort) args.splice(args.indexOf("--model"), 0, "--effort", settings.effort);
  const allowed = Array.isArray(options.allowedTools)
    ? options.allowedTools.filter((x): x is string => typeof x === "string")
    : [];
  // Claude accepts a comma- or space-separated value for this variadic
  // option. A single comma-separated argv value avoids shell-like parsing of
  // patterns such as Bash(git *), while retaining argument-array safety.
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  return args;
}

export function claudeArgs(
  settings: HarnessSettings,
  cwd: string,
  commonGitDir: string,
  session: string,
  resume = false,
): string[] {
  // cwd is carried by the child process; retaining it in the signature keeps
  // invocation construction explicit and prevents shell interpolation.
  void cwd;
  return commonArgs(settings, cwd, commonGitDir, session, resume);
}

export function claudeInvocation(
  settings: HarnessSettings,
  cwd: string,
  commonGitDir: string,
  prompt: string,
  session: string = randomUUID(),
): Invocation {
  return {
    executable: "claude",
    args: claudeArgs(settings, cwd, commonGitDir, session),
    cwd,
    stdin: prompt,
    env: { OPENSPEC_RUNNER_SESSION: session },
  };
}

export function claudeResumeInvocation(
  settings: HarnessSettings,
  cwd: string,
  commonGitDir: string,
  session: string,
): Invocation {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session))
    throw new Error("Claude resume requires a confirmed session UUID");
  return {
    executable: "claude",
    args: claudeArgs(settings, cwd, commonGitDir, session, true),
    cwd,
    env: { OPENSPEC_RUNNER_SESSION: session },
  };
}

export async function claudeCapabilities(cwd = process.cwd()): Promise<HarnessCapabilities> {
  try {
    const version = run("claude", ["--version"], cwd, 10000);
    const help = run("claude", ["--help"], cwd, 10000);
    const required = ["-p", "--output-format", "stream-json", "--verbose", "--model", "--session-id", "--resume", "--permission-mode", "--add-dir"];
    const missing = required.filter((flag) => !help.includes(flag));
    if (!help.includes("--allowedTools") && !help.includes("--allowed-tools")) missing.push("--allowedTools");
    const effortIndex = help.indexOf("--effort");
    const effortLine = effortIndex < 0 ? "" : help.slice(effortIndex, effortIndex + 300);
    const effortChoices = effortLine.match(/\(([^)]+)\)/)?.[1];
    const supportedEfforts = effortChoices
      ? effortChoices.split(",").map((value) => value.trim()).filter(Boolean)
      : [...effortLine.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
    return {
      harness: "claude",
      installed: true,
      version,
      supported: missing.length === 0,
      reasons: missing.length ? [`Claude CLI lacks required capabilities: ${missing.join(", ")}`] : [],
      ...(supportedEfforts.length ? { supportedEfforts } : {}),
      features: {
        supervisedExecution: true,
        sessionOwnership: true,
        workerReports: true,
        inspection: true,
        callingSessionInheritance: false,
        modelDiscovery: false,
        exactResume: missing.length === 0,
        effort: help.includes("--effort"),
      },
    };
  } catch (error: any) {
    return {
      harness: "claude",
      installed: false,
      supported: false,
      reasons: [error.message],
      features: {
        supervisedExecution: true,
        sessionOwnership: true,
        workerReports: true,
        inspection: true,
        callingSessionInheritance: false,
        modelDiscovery: false,
        exactResume: false,
        effort: false,
      },
    };
  }
}

export async function claudeModels(): Promise<ModelDiscovery> {
  return {
    harness: "claude",
    status: "unavailable",
    reason: "Claude Code does not expose a stable, non-inference model catalog through the CLI",
    examples: ["haiku", "sonnet", "opus"],
    exhaustive: false,
  };
}

function rules(root?: string, config?: AgentConfig): PlanningRulesResult {
  const content = readFileSync(rulesFile, "utf8");
  const docs = [{
    source: "bundled:harnesses/claude/planning-rules.md",
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
  return { harness: "claude", documents: docs };
}

export const claudeHarness: HarnessAdapter = {
  id: "claude",
  displayName: "Claude Code",
  planningRulesPath: rulesFile,
  resolveSettings: resolveClaudeSettings,
  capabilities: claudeCapabilities,
  models: claudeModels,
  initialInvocation: claudeInvocation,
  resumeInvocation: claudeResumeInvocation,
  planningRules: rules,
};
