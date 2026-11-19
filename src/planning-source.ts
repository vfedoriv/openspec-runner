import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  pinContext, pinReferenceContext, resolveContext, safeContextPath,
  type ContextFile, type OpenSpecExecutor,
} from "./openspec-context.js";
import {
  applyInstructions, assignmentsFrom, configFrom, executionAgentFrom, loadPlan,
  tasksFrom, uncheckedTaskContent, type Config, type Plan,
} from "./plan.js";
import { samePath } from "./platform-paths.js";
import { assertRepositoryIdentity, git, repository, run } from "./system.js";

export interface StorePlanningSource {
  kind: "store";
  repository: string;
  revision: string;
  openspecRoot: string;
  change: string;
  /** Paths are relative to the Store Git root. Content round-trips exact UTF-8 blob bytes. */
  files: ContextFile[];
  /** Independent of unrelated Store commits and completion marks on numbered tasks. */
  fingerprint: string;
}
export type PlanningSource = { kind: "local"; root: string; change: string } | StorePlanningSource;

export function storeId(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(value) || /^(?:aux|con|prn|nul|com[1-9]|lpt[1-9])$/i.test(value))
    throw new Error(`Unsafe Store path ID: ${value}`);
  return value;
}
function filePath(value: string): string {
  safeContextPath(value);
  if (value.split("/").some(part => /[<>:"|?*]|[. ]$/.test(part) ||
      /^(?:\.git|\.openspec-runner)$/i.test(part) || /^(?:aux|con|prn|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error(`Unsafe portable Store file path: ${value}`);
  return value;
}
function projectPath(openspecRoot: string) {
  const match = /^components\/([^/]+)\/openspec$/.exec(filePath(openspecRoot));
  if (!match) throw new Error("Expected a component OpenSpec root under components/<component>/openspec");
  return `components/${storeId(match[1])}`;
}
/** Reject redirected directories, including dangling links, before using paths for commands or writes. */
export function unredirectedStorePath(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Path escapes the selected Store root");
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Redirected Store path contains a symlink: ${ancestor}`);
    if (dirname(ancestor) === ancestor) return path;
  }
}
export function storeCheckout(root: string, identity: string) {
  const path = unredirectedStorePath(root);
  const repo = repository(path);
  if (!samePath(path, repo.root)) throw new Error("Store checkout must be a Git repository root");
  assertRepositoryIdentity({ root: repo.root, repository: identity });
  return repo;
}

type StoreSelection = Pick<StorePlanningSource, "repository" | "revision" | "openspecRoot" | "change">;
function validateSelection(source: StoreSelection) {
  if (typeof source.repository !== "string" || !source.repository.trim() || isAbsolute(source.repository) ||
      /^(?:file:|\.|[a-z]:|\\)/i.test(source.repository) || /[\x00-\x1f]/.test(source.repository))
    throw new Error("Expected a portable Store repository identity");
  if (typeof source.revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.revision))
    throw new Error("Store plan requires a full Git revision");
  storeId(source.change);
  return projectPath(source.openspecRoot);
}
function supplementPaths(config: Config, project: string) {
  const paths = Object.values(config.agents).flatMap(agent => agent.planningRules ? [`${project}/${filePath(agent.planningRules)}`] : []);
  return [...new Set(paths)];
}
function closedObject(value: unknown, fields: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`Invalid Store ${label}`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) throw new Error(`Unknown Store ${label} field: ${field}`);
}
function parseStorePlan(source: StoreSelection & { files: ContextFile[] }): Plan {
  const project = validateSelection(source);
  const directory = `${source.openspecRoot}/changes/${source.change}`;
  const contents = new Map<string, string>();
  if (!Array.isArray(source.files)) throw new Error("Store planning source requires a file inventory");
  for (const file of source.files) {
    closedObject(file, ["path", "content"], "planning file");
    filePath(file.path);
    if (typeof file.content !== "string" || !file.path.startsWith(`${project}/`))
      throw new Error("Store planning file is outside its component project or lacks UTF-8 content");
    if (contents.has(file.path)) throw new Error(`Duplicate Store planning path: ${file.path}`);
    contents.set(file.path, file.content);
  }
  const read = (path: string): string => {
    const content = contents.get(path);
    if (content === undefined) throw new Error(`Missing committed Store planning file: ${path}`);
    return content;
  };
  const tasksPath = `${directory}/tasks.md`, tasks = tasksFrom(read(tasksPath));
  const config = configFrom(parse(read(`${source.openspecRoot}/runner.yaml`)));
  for (const path of supplementPaths(config, project)) read(path);
  const execution = parse(read(`${directory}/execution.yaml`));
  const files = [...contents.keys()].sort();
  const hash = createHash("sha256");
  hash.update(JSON.stringify([source.repository, source.openspecRoot, source.change]));
  for (const path of files) {
    const content = read(path);
    hash.update(JSON.stringify([path, path === tasksPath ? uncheckedTaskContent(content, tasks) : content]));
  }
  return {
    change: source.change, directory, relativeDir: directory, tasks, assignments: assignmentsFrom(execution, tasks),
    config, agent: executionAgentFrom(execution) || config.defaultAgent, fingerprint: hash.digest("hex"), files,
  };
}
export function loadSourcePlan(source: PlanningSource): Plan {
  if (source.kind === "local") return loadPlan(source.root, source.change);
  if (source.kind !== "store") throw new Error("Unknown planning source kind");
  closedObject(source, ["kind", "repository", "revision", "openspecRoot", "change", "files", "fingerprint"], "planning source");
  const plan = parseStorePlan(source);
  if (source.fingerprint !== plan.fingerprint) throw new Error("Store planning source fingerprint mismatch");
  return plan;
}

/** Resolve OpenSpec from the selected project and pin the approved revision without touching code. */
export function pinStorePlan(options: StoreSelection & { storeRoot: string; execute?: OpenSpecExecutor }): StorePlanningSource {
  const project = validateSelection(options), store = storeCheckout(options.storeRoot, options.repository);
  const cwd = unredirectedStorePath(store.root, project);
  const changeRoot = unredirectedStorePath(store.root, options.openspecRoot, "changes", options.change);
  const context = resolveContext({ cwd, change: options.change, execute: options.execute, expectedProjectRoot: cwd });
  unredirectedStorePath(context.changeRoot);
  if (!samePath(context.implementationRoot, store.root) || !samePath(context.planningRoot, cwd) || !samePath(context.changeRoot, changeRoot))
    throw new Error("OpenSpec returned a planning root or change root outside the selected Store project");
  for (const path of context.artifactPaths) unredirectedStorePath(path);
  const { repository: identity, revision, openspecRoot, change } = options;
  const pin = pinContext({ context, repository: identity, revision });
  const files = new Map(pin.files.map(file => [file.path, file]));
  const runner = files.get(`${openspecRoot}/runner.yaml`);
  if (!runner) throw new Error("Missing committed Store runner.yaml");
  const supplements = supplementPaths(configFrom(parse(runner.content)), project).filter(path => !files.has(path));
  if (supplements.length) {
    for (const file of pinReferenceContext({ root: store.root, repository: identity, revision, relevantPaths: supplements }).files)
      files.set(file.path, file);
  }
  for (const path of files.keys()) unredirectedStorePath(store.root, filePath(path));
  const source = { kind: "store" as const, repository: identity, revision, openspecRoot, change,
    files: [...files.keys()].sort().map(path => files.get(path)!) };
  return { ...source, fingerprint: parseStorePlan(source).fingerprint };
}

/** Approval checks must inspect the committed component project and run OpenSpec in that project. */
export function validateStorePlanReadiness(options: { storeRoot: string; source: StorePlanningSource; execute?: OpenSpecExecutor }) {
  const { source, storeRoot, execute } = options;
  loadSourcePlan(source);
  const project = projectPath(source.openspecRoot), root = storeCheckout(storeRoot, source.repository).root;
  const cwd = unredirectedStorePath(root, project);
  function assertRevision() {
    if (git(root, "--no-optional-locks", "diff", "--no-ext-diff", "--name-only", source.revision, "--", project) ||
        git(root, "ls-files", "--others", "-z", "--", project))
      throw new Error("OpenSpec validation requires the committed component project at the approved revision");
    // Git's index can suppress worktree stat checks. Read each selected input as well.
    for (const file of source.files) {
      const actual = readFileSync(unredirectedStorePath(root, file.path), "utf8");
      if (actual.replace(/\r\n/g, "\n") !== file.content.replace(/\r\n/g, "\n"))
        throw new Error(`OpenSpec validation requires committed planning bytes: ${file.path}`);
    }
  }
  assertRevision();
  const pinned = pinStorePlan({ ...source, storeRoot, execute });
  const approved = new Map(source.files.map(file => [file.path, file.content]));
  if (pinned.files.length !== approved.size || pinned.files.some(file => approved.get(file.path) !== file.content))
    throw new Error("Store plan bytes differ from the selected Git revision");
  const instructions = applyInstructions(cwd, source.change, execute);
  const args = ["validate", source.change, "--strict", "--json"];
  if (execute) execute({ command: "openspec", args, cwd });
  else run("openspec", args, cwd);
  assertRevision();
  return instructions;
}
