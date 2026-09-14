import {
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { git, run } from "./system.js";
import { hasHarness, harnessIds } from "./harnesses/registry.js";
import type { AgentConfig } from "./harnesses/types.js";
export interface Assignment {
  model?: string;
  effort?: string;
  reasoningEffort?: string;
  dependsOn: string[];
  parallel: boolean;
}
export interface Task {
  id: string;
  description: string;
  completed: boolean;
  line: number;
}
export interface Config {
  version: 1 | 2;
  defaultModel: string;
  defaultAgent: string;
  agents: Record<string, AgentConfig>;
  maxParallel: number;
  worktrees: "auto" | "git" | "worktrunk";
  terminal: "auto" | "manual" | "herdr";
  cleanup: "automatic" | "manual";
  setup: string[][];
  verifyIntegration: string[][];
}
export interface Plan {
  change: string;
  directory: string;
  relativeDir: string;
  tasks: Task[];
  assignments: Record<string, Assignment>;
  config: Config;
  agent: string;
  fingerprint: string;
  files: string[];
}
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
function keys(x: Record<string, any>, allowed: string[]) {
  for (const k of Object.keys(x))
    if (!allowed.includes(k))
      throw new Error(`Unknown configuration field: ${k}`);
}
function identifier(x: unknown): x is string {
  return typeof x === "string" && !!x.trim() && !/[\0\r\n]/.test(x);
}
export function tasksFrom(text: string): Task[] {
  const tasks: Task[] = [];
  let fence: string | undefined;
  text.split("\n").forEach((line, i) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length)
        fence = undefined;
      return;
    }
    if (fence) return;
    const box = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (!box) return;
    const m = box[2].match(/^(\d+(?:\.\d+)+)\s+(.+?)\s*$/);
    if (!m)
      throw new Error(
        `Checkbox on line ${i + 1} requires a numbered identifier such as 2.1 and a description`,
      );
    if (tasks.some((t) => t.id === m[1]))
      throw new Error(`Duplicate task number: ${m[1]}`);
    tasks.push({
      id: m[1],
      description: m[2],
      completed: box[1] !== " ",
      line: i,
    });
  });
  if (!tasks.length) throw new Error("No numbered checkbox tasks found");
  return tasks;
}
export function configFrom(raw: unknown): Config {
  if (!object(raw) || ![1, 2].includes(raw.version))
    throw new Error("runner.yaml requires version: 1 or 2");
  const version = raw.version as 1 | 2;
  keys(
    raw,
    version === 1
      ? [
          "version",
          "defaultModel",
          "maxParallel",
          "worktrees",
          "terminal",
          "cleanup",
          "setup",
          "verifyIntegration",
        ]
      : [
          "version",
          "defaultAgent",
          "agents",
          "maxParallel",
          "worktrees",
          "terminal",
          "cleanup",
          "setup",
          "verifyIntegration",
        ],
  );
  if (version === 1) {
    const c = {
      version: 1 as const,
      defaultModel: "session",
      defaultAgent: "codex",
      agents: { codex: { defaultModel: "session" } },
      maxParallel: 4,
      worktrees: "auto" as const,
      terminal: "auto" as const,
      cleanup: "automatic" as const,
      setup: [] as string[][],
      verifyIntegration: [] as string[][],
      ...raw,
    } as Config;
    c.agents = { codex: { defaultModel: c.defaultModel } };
    return validateConfig(c);
  }
  if (raw.defaultAgent !== undefined && !hasHarness(raw.defaultAgent))
    throw new Error(
      `Unknown defaultAgent ${String(raw.defaultAgent)}; available harnesses: ${harnessIds().join(", ")}`,
    );
  if (!object(raw.agents)) throw new Error("version 2 runner.yaml requires agents mapping");
  const agents: Record<string, AgentConfig> = {};
  for (const [id, value] of Object.entries(raw.agents)) {
    if (!hasHarness(id))
      throw new Error(`Unknown harness configuration: ${id}; available harnesses: ${harnessIds().join(", ")}`);
    if (!object(value)) throw new Error(`Agent configuration must be a mapping: ${id}`);
    keys(value, ["defaultModel", "permissionMode", "allowedTools", "planningRules"]);
    const agent = {
      defaultModel: value.defaultModel,
      ...(value.permissionMode !== undefined ? { permissionMode: value.permissionMode } : {}),
      ...(value.allowedTools !== undefined ? { allowedTools: value.allowedTools } : {}),
      ...(value.planningRules !== undefined ? { planningRules: value.planningRules } : {}),
    } as AgentConfig;
    if (!identifier(agent.defaultModel)) throw new Error(`Invalid defaultModel for harness ${id}`);
    if (agent.permissionMode !== undefined && !identifier(agent.permissionMode))
      throw new Error(`Invalid permissionMode for harness ${id}`);
    if (agent.permissionMode === "bypassPermissions")
      throw new Error("bypassPermissions is not allowed; use an explicit reviewed permission policy");
    if (agent.planningRules !== undefined && (!identifier(agent.planningRules) || agent.planningRules.startsWith("/")))
      throw new Error(`Invalid planningRules path for harness ${id}`);
    if (
      agent.allowedTools !== undefined &&
      (!Array.isArray(agent.allowedTools) || agent.allowedTools.some((x) => !identifier(x)))
    )
      throw new Error(`allowedTools must contain safe strings for harness ${id}`);
    agents[id] = agent;
  }
  const defaultAgent = raw.defaultAgent as string | undefined;
  if (!defaultAgent || !agents[defaultAgent])
    throw new Error("version 2 runner.yaml defaultAgent must have an agents entry");
  const c = {
    version: 2 as const,
    defaultAgent,
    defaultModel: agents[defaultAgent].defaultModel,
    agents,
    maxParallel: 4,
    worktrees: "auto" as const,
    terminal: "auto" as const,
    cleanup: "automatic" as const,
    setup: [] as string[][],
    verifyIntegration: [] as string[][],
    ...raw,
  } as Config;
  return validateConfig(c);
}
function validateConfig(c: Config): Config {
  if (
    !identifier(c.defaultModel) ||
    !Number.isInteger(c.maxParallel) ||
    c.maxParallel < 1
  )
    throw new Error("Invalid defaultModel or maxParallel");
  if (
    !["auto", "git", "worktrunk"].includes(c.worktrees) ||
    !["auto", "manual", "herdr"].includes(c.terminal)
  )
    throw new Error("Invalid worktrees or terminal adapter");
  if (!["automatic", "manual"].includes(c.cleanup))
    throw new Error("Invalid cleanup policy; use automatic or manual");
  for (const commands of [c.setup, c.verifyIntegration])
    if (
      !Array.isArray(commands) ||
      commands.some(
        (a) =>
          !Array.isArray(a) ||
          !a.length ||
          a.some((s) => typeof s !== "string" || s.includes("\0")),
      )
    )
      throw new Error("Commands must be nonempty argument arrays");
  return c;
}

export function executionAgentFrom(raw: unknown): string {
  if (!object(raw) || ![1, 2].includes(raw.version))
    throw new Error("execution.yaml requires version: 1 or 2");
  if (raw.version === 1) return "codex";
  if (raw.agent === undefined) return "";
  if (!hasHarness(raw.agent))
    throw new Error(
      `Unknown execution agent ${String(raw.agent)}; available harnesses: ${harnessIds().join(", ")}`,
    );
  return raw.agent;
}
export function assignmentsFrom(
  raw: unknown,
  tasks: Task[],
): Record<string, Assignment> {
  if (!object(raw) || ![1, 2].includes(raw.version) || !object(raw.tasks))
    throw new Error("execution.yaml requires version: 1 or 2 and tasks mapping");
  const version = raw.version as 1 | 2;
  keys(raw, version === 1 ? ["version", "tasks"] : ["version", "agent", "tasks"]);
  if (version === 2) {
    if (raw.agent !== undefined && !hasHarness(raw.agent))
      throw new Error(
        `Unknown execution agent ${String(raw.agent)}; available harnesses: ${harnessIds().join(", ")}`,
      );
  }
  const result: Record<string, Assignment> = {};
  for (const task of tasks) {
    const a = raw.tasks[task.id];
    if (!object(a)) throw new Error(`Missing assignment: ${task.id}`);
    keys(
      a,
      version === 1
        ? ["model", "reasoningEffort", "dependsOn", "parallel"]
        : ["model", "effort", "dependsOn", "parallel"],
    );
    if (a.model !== undefined && !identifier(a.model))
      throw new Error(`Invalid model: ${task.id}`);
    const effort = version === 1 ? a.reasoningEffort : a.effort;
    if (effort !== undefined && !identifier(effort))
      throw new Error(`Invalid ${version === 1 ? "reasoningEffort" : "effort"}: ${task.id}`);
    if (a.parallel !== undefined && typeof a.parallel !== "boolean")
      throw new Error(`Invalid parallel permission: ${task.id}`);
    const deps = a.dependsOn ?? [];
    if (
      !Array.isArray(deps) ||
      deps.some(
        (d) => typeof d !== "string" || !tasks.some((t) => t.id === d),
      ) ||
      new Set(deps).size !== deps.length
    )
      throw new Error(`Invalid dependencies: ${task.id}`);
    result[task.id] = {
      ...(a.model !== undefined ? { model: a.model } : {}),
      ...(version === 1
        ? effort !== undefined
          ? { reasoningEffort: effort }
          : {}
        : effort !== undefined
          ? { effort }
          : {}),
      dependsOn: deps,
      parallel: a.parallel === true,
    };
  }
  for (const id of Object.keys(raw.tasks))
    if (!result[id]) throw new Error(`Unknown task assignment: ${id}`);
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    result[id].dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  Object.keys(result).forEach(visit);
  return result;
}
export function loadPlan(root: string, change: string): Plan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change))
    throw new Error("Expected a repository-local change name");
  const directory = resolve(root, "openspec", "changes", change);
  if (!realpathSync(directory).startsWith(realpathSync(root) + sep))
    throw new Error("External planning stores are outside v1");
  const tasks = tasksFrom(readFileSync(resolve(directory, "tasks.md"), "utf8"));
  const config = configFrom(
    parse(readFileSync(resolve(root, "openspec/runner.yaml"), "utf8")),
  );
  const assignments = assignmentsFrom(
    parse(readFileSync(resolve(directory, "execution.yaml"), "utf8")),
    tasks,
  );
  const execution = parse(readFileSync(resolve(directory, "execution.yaml"), "utf8"));
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir).sort()) {
      const p = resolve(dir, entry);
      const s = lstatSync(p);
      if (s.isSymbolicLink())
        throw new Error(`Planning artifact cannot be a symlink: ${p}`);
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) files.push(relative(root, p));
    }
  }
  walk(directory);
  files.push("openspec/runner.yaml");
  if (existsSync(resolve(root, "openspec/config.yaml")))
    files.push("openspec/config.yaml");
  // Project planning-rule supplements are reviewed planning inputs too. Keep
  // them inside the repository and require ordinary committed-file checks to
  // cover drift just like the runner and execution artifacts.
  for (const agent of Object.values(config.agents)) {
    if (!agent.planningRules) continue;
    const supplement = resolve(root, agent.planningRules);
    if (!supplement.startsWith(resolve(root) + sep))
      throw new Error("Planning rules supplement must remain inside the repository");
    if (!existsSync(supplement) || !lstatSync(supplement).isFile())
      throw new Error(`Planning rules supplement does not exist: ${agent.planningRules}`);
    if (lstatSync(supplement).isSymbolicLink())
      throw new Error(`Planning rules supplement cannot be a symlink: ${supplement}`);
    files.push(relative(root, supplement));
  }
  const hash = createHash("sha256");
  for (const p of files.sort()) {
    let content = readFileSync(resolve(root, p), "utf8");
    if (p === relative(root, resolve(directory, "tasks.md"))) {
      const lines = content.split("\n");
      for (const task of tasks)
        lines[task.line] = lines[task.line].replace(/\[[ xX]\]/, "[ ]");
      content = lines.join("\n");
    }
    hash.update(p).update("\0").update(content).update("\0");
  }
  return {
    change,
    directory,
    relativeDir: relative(root, directory),
    tasks,
    assignments,
    config,
    agent: executionAgentFrom(execution) || config.defaultAgent,
    fingerprint: hash.digest("hex"),
    files,
  };
}
export function assertCommitted(root: string, plan: Plan, ref = "HEAD") {
  for (const file of plan.files) {
    // Compare bytes against the selected commit, including untracked planning files.
    const committed = run("git", ["show", `${ref}:${file}`], root);
    if (committed !== readFileSync(resolve(root, file), "utf8").trim())
      throw new Error(
        `Commit current planning artifact before launch: ${file}`,
      );
  }
  if (git(root, "status", "--porcelain", "--", ...plan.files))
    throw new Error("Planning artifacts must be committed");
}
function openspecJson<T>(root: string, args: string[]): T {
  const command = `openspec ${args.join(" ")}`,
    output = run("openspec", args, root);
  if (!output) throw new Error(`${command} returned empty stdout`);
  try {
    return JSON.parse(output) as T;
  } catch (e: any) {
    throw new Error(`${command} returned invalid JSON: ${e.message}`);
  }
}
export function readiness(root: string, change: string) {
  const status = openspecJson(
      root,
      ["status", "--change", change, "--json"],
    ),
    instructions = openspecJson<any>(
      root,
      ["instructions", "apply", "--change", change, "--json"],
    );
  if (!["ready", "all_done"].includes(instructions.state))
    throw new Error(
      `OpenSpec is not ready: ${instructions.instruction ?? instructions.state}`,
    );
  return { status, instructions };
}
