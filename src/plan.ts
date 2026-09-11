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
export interface Assignment {
  model?: string;
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
  version: 1;
  defaultModel: string;
  maxParallel: number;
  worktrees: "auto" | "git" | "worktrunk";
  terminal: "auto" | "manual" | "herdr";
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
  return typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(x);
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
  if (!object(raw) || raw.version !== 1)
    throw new Error("runner.yaml requires version: 1");
  keys(raw, [
    "version",
    "defaultModel",
    "maxParallel",
    "worktrees",
    "terminal",
    "setup",
    "verifyIntegration",
  ]);
  const c = {
    version: 1,
    defaultModel: "session",
    maxParallel: 4,
    worktrees: "auto",
    terminal: "auto",
    setup: [],
    verifyIntegration: [],
    ...raw,
  } as Config;
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
export function assignmentsFrom(
  raw: unknown,
  tasks: Task[],
): Record<string, Assignment> {
  if (!object(raw) || raw.version !== 1 || !object(raw.tasks))
    throw new Error("execution.yaml requires version: 1 and tasks mapping");
  keys(raw, ["version", "tasks"]);
  const result: Record<string, Assignment> = {};
  for (const task of tasks) {
    const a = raw.tasks[task.id];
    if (!object(a)) throw new Error(`Missing assignment: ${task.id}`);
    keys(a, ["model", "reasoningEffort", "dependsOn", "parallel"]);
    if (a.model !== undefined && !identifier(a.model))
      throw new Error(`Invalid model: ${task.id}`);
    if (a.reasoningEffort !== undefined && !identifier(a.reasoningEffort))
      throw new Error(`Invalid reasoningEffort: ${task.id}`);
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
    result[task.id] = { ...a, dependsOn: deps, parallel: a.parallel === true };
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
