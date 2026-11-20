import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  committedBlob, committedBlobs, committedTreeEntries, pinContext, pinReferenceContext, repinContext, resolveContext, safeContextPath,
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
  /** Approved selection roots, including custom artifact directories. Absent on older pins. */
  selections?: string[];
  /** Independent of unrelated Store commits and completion marks on numbered tasks. */
  fingerprint: string;
}
export type PlanningSource = { kind: "local"; root: string; change: string } | StorePlanningSource;

export function storeId(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) ||
      ["__proto__", "constructor", "prototype"].includes(value) || /^(?:aux|con|prn|nul|com[0-9]|lpt[0-9])$/i.test(value))
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
function assertPortableInventory(paths: string[]) {
  const seen = new Map<string, { spelling: string; directory: boolean }>();
  for (const path of paths) {
    const parts = filePath(path).split("/");
    let spelling = "";
    for (const [index, part] of parts.entries()) {
      spelling = spelling ? `${spelling}/${part}` : part;
      const key = spelling.normalize("NFC").toUpperCase(), previous = seen.get(key);
      const directory = index < parts.length - 1;
      if (previous && (previous.spelling !== spelling || !previous.directory || !directory))
        throw new Error(`Conflicting portable Store paths: ${previous.spelling} and ${spelling}`);
      seen.set(key, { spelling, directory });
    }
  }
}
function parseStorePlan(source: StoreSelection & { files: ContextFile[]; selections?: string[] }): Plan {
  const project = validateSelection(source);
  const directory = `${source.openspecRoot}/changes/${source.change}`;
  const contents = new Map<string, string>();
  if (!Array.isArray(source.files)) throw new Error("Store planning source requires a file inventory");
  for (const file of source.files) {
    closedObject(file, ["path", "content"], "planning file");
    if (typeof file.content !== "string" || typeof file.path !== "string" || !file.path.startsWith(`${project}/`))
      throw new Error("Store planning file is outside its component project or lacks UTF-8 content");
    if (contents.has(file.path)) throw new Error(`Duplicate Store planning path: ${file.path}`);
    contents.set(file.path, file.content);
  }
  assertPortableInventory([...contents.keys()]);
  if (source.selections !== undefined) {
    if (!Array.isArray(source.selections) || !source.selections.length ||
        source.selections.some(path => typeof path !== "string" || !filePath(path).startsWith(`${project}/`)) ||
        JSON.stringify(source.selections) !== JSON.stringify([...new Set(source.selections)].sort()) ||
        [...contents.keys()].some(path => !source.selections!.some(selection => path === selection || path.startsWith(`${selection}/`))))
      throw new Error("Invalid Store planning selection scope");
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
  if (source.selections) hash.update(JSON.stringify(source.selections));
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
  return loadStorePlan(source);
}
function loadStorePlan(source: StorePlanningSource): Plan {
  if (source?.kind !== "store") throw new Error("Expected a Store planning source");
  closedObject(source, ["kind", "repository", "revision", "openspecRoot", "change", "files", "fingerprint", "selections"], "planning source");
  const plan = parseStorePlan(source);
  if (source.fingerprint !== plan.fingerprint) throw new Error("Store planning source fingerprint mismatch");
  return plan;
}

type PinOptions = StoreSelection & { storeRoot: string; execute?: OpenSpecExecutor; kind?: "store"; selections?: string[] };

/** Materialize the committed component for discovery, including auxiliary schema inputs and binary assets. */
function withCommittedProject<T>(options: PinOptions, inspect: (root: string, cwd: string) => T): T {
  const project = validateSelection(options), store = storeCheckout(options.storeRoot, options.repository);
  unredirectedStorePath(store.root, options.openspecRoot, "changes", options.change);
  if (git(store.root, "rev-parse", `${options.revision}^{commit}`) !== options.revision)
    throw new Error("Store plan revision must identify a commit");
  const entries = committedTreeEntries(store.root, options.revision, project);
  if (!entries.length) throw new Error(`Missing committed Store project: ${project}`);
  assertPortableInventory(entries.map(entry => entry.path));
  for (const entry of entries) {
    if (!entry.path.startsWith(`${project}/`) || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new Error(`Committed Store project cannot contain a symlink or non-file: ${entry.path}`);
  }
  const runtime = resolve(store.root, ".openspec-runner");
  let createdRuntime = false, scratch: string | undefined;
  try {
    while (!scratch) {
      unredirectedStorePath(store.root, runtime);
      try { mkdirSync(runtime, { mode: 0o700 }); createdRuntime = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      try { scratch = mkdtempSync(unredirectedStorePath(runtime, "validate-")); }
      catch (error) {
        // A finishing preview can remove its empty parent between mkdir and mkdtemp.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        createdRuntime = false;
      }
    }
    const blobs = committedBlobs({ root: store.root, objects: entries.map(entry => entry.object) });
    for (const [index, entry] of entries.entries()) {
      const path = unredirectedStorePath(scratch, entry.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, blobs[index], { flag: "wx", mode: 0o600 });
    }
    return inspect(store.root, resolve(scratch, project));
  } finally {
    if (scratch) rmSync(unredirectedStorePath(runtime, scratch), { recursive: true, force: true });
    if (createdRuntime) {
      try { rmdirSync(runtime); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    }
  }
}
function pinProject(options: PinOptions, root: string, cwd: string): StorePlanningSource {
  const project = projectPath(options.openspecRoot), changeRoot = resolve(cwd, "openspec/changes", options.change);
  const context = resolveContext({ cwd, change: options.change, execute: options.execute, expectedProjectRoot: cwd });
  unredirectedStorePath(context.changeRoot);
  if (!samePath(context.implementationRoot, root) || !samePath(context.planningRoot, cwd) || !samePath(context.changeRoot, changeRoot))
    throw new Error("OpenSpec returned a planning root or change root outside the selected Store project");
  for (const path of context.artifactPaths) unredirectedStorePath(path);
  const { repository: identity, revision, openspecRoot, change } = options;
  // Git selection paths are Store-relative; the tool reported paths in the isolated component.
  const planningRoot = resolve(root, project);
  const fromSnapshot = (path: string) => unredirectedStorePath(planningRoot, relative(cwd, path));
  const pin = pinContext({ planningRepositoryRoot: root, context: { ...context, planningRoot, changeRoot: fromSnapshot(changeRoot),
    artifactPaths: context.artifactPaths.map(fromSnapshot) }, repository: identity, revision });
  const files = new Map(pin.files.map(file => [file.path, file]));
  const runner = files.get(`${openspecRoot}/runner.yaml`);
  if (!runner) throw new Error("Missing committed Store runner.yaml");
  const supplements = supplementPaths(configFrom(parse(runner.content)), project).filter(path => !files.has(path));
  if (supplements.length) {
    for (const file of pinReferenceContext({ root, repository: identity, revision, relevantPaths: supplements }).files)
      files.set(file.path, file);
  }
  for (const path of files.keys()) unredirectedStorePath(root, filePath(path));
  const source = { kind: "store" as const, repository: identity, revision, openspecRoot, change,
    // Revalidating an older persisted pin must retain its original fingerprint format.
    ...(options.kind === "store" && options.selections === undefined ? {} :
      { selections: [...new Set([...(pin.selections ?? []), ...supplements])].sort() }),
    files: [...files.keys()].sort().map(path => files.get(path)!) };
  return { ...source, fingerprint: parseStorePlan(source).fingerprint };
}
/** Resolve OpenSpec from the approved Git project and pin its portable file inventory. */
export function pinStorePlan(options: PinOptions): StorePlanningSource {
  return withCommittedProject(options, (root, cwd) => pinProject(options, root, cwd));
}

/** Observe pinned inputs and default project selections using Git only; no tool or scratch checkout. */
export function readStorePlanRevision(options: { storeRoot: string; source: StorePlanningSource; revision: string }): StorePlanningSource {
  const { source, revision } = options;
  loadSourcePlan(source);
  const root = storeCheckout(options.storeRoot, source.repository).root;
  if (source.selections) {
    const pinned = repinContext({ root, revision, context: { version: 1, repository: source.repository,
      revision: source.revision, files: source.files, selections: source.selections, fingerprint: "" } });
    const candidate = { ...source, revision, files: pinned.files };
    return { ...candidate, fingerprint: parseStorePlan(candidate).fingerprint };
  }
  // Legacy pins lost custom directory selectors. Refuse additions in their component
  // project rather than silently execute against potentially unobserved new inputs.
  const project = projectPath(source.openspecRoot);
  const originalPaths = new Set(committedTreeEntries(root, source.revision, project).map(entry => entry.path));
  if (committedTreeEntries(root, revision, project).some(entry => !originalPaths.has(entry.path)))
    throw new Error("Store planning selection scope is stale after project additions; renew approval");
  const planningRoot = resolve(root, projectPath(source.openspecRoot));
  const pinned = pinContext({ repository: source.repository, revision, planningRepositoryRoot: root, context: {
    implementationRoot: root, planningRoot, changeRoot: resolve(root, source.openspecRoot, "changes", source.change), change: source.change,
    source: "store", artifactPaths: source.files.map(file => resolve(root, file.path)), references: [],
  } });
  const candidate = { ...source, revision, files: pinned.files };
  return { ...candidate, fingerprint: parseStorePlan(candidate).fingerprint };
}

/** Approval checks must inspect the committed component project and run OpenSpec in that project. */
export function validateStorePlanReadiness(options: { storeRoot: string; source: StorePlanningSource; execute?: OpenSpecExecutor }) {
  const { source, storeRoot, execute } = options;
  loadStorePlan(source);
  const project = projectPath(source.openspecRoot), root = storeCheckout(storeRoot, source.repository).root;
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
  const pin = { ...source, storeRoot, execute };
  return withCommittedProject(pin, (store, cwd) => {
    const pinned = pinProject(pin, store, cwd);
    const approved = new Map(source.files.map(file => [file.path, file.content]));
    if (pinned.files.length !== approved.size || pinned.files.some(file => approved.get(file.path) !== file.content))
      throw new Error("Store plan bytes differ from the selected Git revision");
    const instructions = applyInstructions(cwd, source.change, execute);
    const args = ["validate", source.change, "--strict", "--json"];
    if (execute) execute({ command: "openspec", args, cwd });
    else run("openspec", args, cwd);
    assertRevision();
    return instructions;
  });
}
