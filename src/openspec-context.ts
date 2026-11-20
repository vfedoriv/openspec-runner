import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { git, gitRaw, repository, run } from "./system.js";
import { resolveCommand } from "./platform-command.js";
import { gitHooksPath } from "./platform-paths.js";

export interface ContextFile { path: string; content: string }
/** Portable approved input. Checkout paths belong only to ResolvedContext. */
export interface PinnedContext {
  version: 1;
  repository: string;
  revision: string;
  change?: string;
  storeId?: string;
  fingerprint: string;
  files: ContextFile[];
  references?: PinnedContext[];
  /** Approved portable selection roots, including directories that may gain files. */
  selections?: string[];
}
export interface ResolvedContext {
  implementationRoot: string;
  planningRoot: string;
  changeRoot: string;
  change: string;
  source: string;
  storeId?: string;
  artifactPaths: string[];
  references: { storeId: string; root: string; status: unknown[] }[];
}
export type OpenSpecExecutor = (request: { command: string; args: string[]; cwd: string }) => string;

export function safeContextPath(path: string): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes("\\") ||
      path.split("/").some(p => !p || p === "." || p === "..") || /[\x00-\x1f\x7f]/.test(path))
    throw new Error(`Unsafe portable path: ${path}`);
  return path;
}
function id(value: string, label: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error(`Invalid ${label} ID`);
}
function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function capability(detail: string): never {
  throw new Error(`OpenSpec JSON capability missing: ${detail}. Upgrade OpenSpec to a Stores-capable version; run openspec status --change <id> --json and openspec doctor --json (or openspec context --json) to inspect root and references.`);
}
export function resolveContext(options: {
  cwd: string;
  change: string;
  store?: string;
  execute?: OpenSpecExecutor;
  /** Explicit component projects must not be redirected by OpenSpec configuration. */
  expectedProjectRoot?: string;
}): ResolvedContext {
  id(options.change, "change");
  if (options.store) id(options.store, "Store");
  const execute = options.execute ?? ((r) => run(r.command, r.args, r.cwd));
  const selector = options.store ? ["--store", options.store] : [];
  const call = (args: string[]) => {
    try { return object(JSON.parse(execute({ command: "openspec", args: [...args, ...selector], cwd: options.cwd }))); }
    catch (error) { capability(`command ${args[0]} failed or returned invalid JSON (${(error as Error).message})`); }
  };
  const status = call(["status", "--change", options.change, "--json"]);
  const root = object(status?.root);
  if (!root || typeof root.path !== "string" || !isAbsolute(root.path) || typeof root.source !== "string") capability("status root.path/source");
  if (options.store && root.store_id !== options.store) capability("status root.store_id does not match selected Store");
  const planningHome = object(status?.planningHome);
  const planningRoot = resolve(planningHome?.root ?? root.path);
  if (options.expectedProjectRoot && (relative(options.expectedProjectRoot, root.path) ||
      relative(options.expectedProjectRoot, planningRoot)))
    throw new Error("OpenSpec reported a root outside the selected planning project");
  const inside = (path: string) => {
    const rel = relative(planningRoot, resolve(planningRoot, path));
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("OpenSpec artifact path must remain inside the planning root");
    safeContextPath(rel.split(sep).join("/"));
    return resolve(planningRoot, path);
  };
  if (typeof status?.changeRoot !== "string" || !status.changeRoot.trim()) capability("status changeRoot");
  const changeRoot = inside(status!.changeRoot);
  const artifactObject = object(status?.artifactPaths);
  if (!artifactObject) capability("status artifactPaths");
  const paths: string[] = Object.values(artifactObject).flatMap(value => {
    const artifact = object(value);
    if (!artifact || typeof artifact.outputPath !== "string" || typeof artifact.resolvedOutputPath !== "string" ||
        !Array.isArray(artifact.existingOutputPaths) || artifact.existingOutputPaths.some((path: unknown) => typeof path !== "string"))
      capability("status artifactPaths entries require outputPath/resolvedOutputPath/existingOutputPaths");
    // resolvedOutputPath can be a glob or an artifact not yet written. The
    // documented existingOutputPaths list contains the concrete files to read.
    return artifact.existingOutputPaths;
  });
  let references: ResolvedContext["references"];
  let doctor: Record<string, any> | undefined;
  try { doctor = object(JSON.parse(execute({ command: "openspec", args: ["doctor", "--json", ...selector], cwd: options.cwd }))); } catch { /* context is the documented alternative */ }
  if (Array.isArray(doctor?.references)) {
    references = doctor.references.map((r: any) => {
      if (!object(r) || typeof r.store_id !== "string" || typeof r.root !== "string" || !isAbsolute(r.root) || !Array.isArray(r.status)) capability("doctor references store_id/root/status");
      id(r.store_id, "reference Store");
      return { storeId: r.store_id, root: resolve(r.root), status: r.status };
    });
  } else {
    const context = call(["context", "--json"]);
    if (!Array.isArray(context?.members)) capability("doctor references or context members");
    references = context!.members.filter((r: any) => r?.role === "referenced_store").map((r: any) => {
      if (typeof r.id !== "string" || typeof r.path !== "string" || !isAbsolute(r.path) || typeof r.fetch !== "string" || !Array.isArray(r.status)) capability("context referenced_store id/path/fetch/status");
      id(r.id, "reference Store");
      return { storeId: r.id, root: resolve(r.path), status: r.status };
    });
  }
  return { implementationRoot: repository(options.cwd).root, planningRoot, changeRoot, change: options.change,
    source: root.source, ...(root.store_id ? { storeId: root.store_id } : {}),
    artifactPaths: [...new Set(paths.map(inside))].sort(), references };
}

// Bound retained immutable bytes across repositories in long-lived runner processes.
const blobCache = new Map<string, Buffer>();
const blobCacheLimit = 16 * 1024 * 1024;
let blobCacheBytes = 0;
function rememberBlob(root: string, object: string, bytes: Buffer) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object) || bytes.length > blobCacheLimit) return;
  const key = JSON.stringify([resolve(root), object]);
  if (blobCache.has(key)) { blobCacheBytes -= blobCache.get(key)!.length; blobCache.delete(key); }
  while (blobCache.size && (blobCacheBytes + bytes.length > blobCacheLimit || blobCache.size >= 1024)) {
    const oldest = blobCache.keys().next().value!;
    blobCacheBytes -= blobCache.get(oldest)!.length; blobCache.delete(oldest);
  }
  blobCache.set(key, Buffer.from(bytes)); blobCacheBytes += bytes.length;
}

/** Batch exact immutable objects; lengths delimit binary payloads rather than line splitting. */
export function committedBlobs(options: { root: string; objects: string[] }): Buffer[] {
  const values = new Map<string, Buffer>();
  for (const object of options.objects) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object)) throw new Error("Batched Git reads require full object hashes");
    const cached = blobCache.get(JSON.stringify([resolve(options.root), object]));
    if (cached) values.set(object, cached);
  }
  const missing = [...new Set(options.objects.filter(object => !values.has(object)))];
  if (missing.length) {
    const invocation = resolveCommand({ executable: "git", args: ["-c", `core.hooksPath=${gitHooksPath()}`, "cat-file", "--batch"], cwd: options.root });
    const output = execFileSync(invocation.executable, invocation.args, { cwd: options.root, env: invocation.env, windowsHide: true,
      input: `${missing.join("\n")}\n`, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    let offset = 0;
    for (const object of missing) {
      const end = output.indexOf(10, offset);
      const header = end < 0 ? undefined : /^([a-f0-9]+) blob (\d+)$/.exec(output.subarray(offset, end).toString("ascii"));
      if (!header || header[1] !== object) throw new Error("Invalid or unavailable Git blob in batch response");
      const size = Number(header[2]), start = end + 1;
      if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || start + size >= output.length || output[start + size] !== 10)
        throw new Error("Invalid Git blob batch payload length");
      const bytes = Buffer.from(output.subarray(start, start + size));
      values.set(object, bytes); rememberBlob(options.root, object, bytes); offset = start + size + 1;
    }
    if (offset !== output.length) throw new Error("Unexpected trailing Git blob batch output");
  }
  return options.objects.map(object => Buffer.from(values.get(object)!));
}

/** Read exact Git blob bytes; system.git deliberately trims command output. */
export function committedBlob(options: { root: string; object: string }): Buffer {
  // Refs and abbreviated IDs can resolve differently later and must stay uncached.
  const key = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.object) ? JSON.stringify([resolve(options.root), options.object]) : undefined;
  const cached = key ? blobCache.get(key) : undefined;
  if (cached) {
    blobCache.delete(key!); blobCache.set(key!, cached);
    return Buffer.from(cached);
  }
  const invocation = resolveCommand({ executable: "git", args: ["-c", `core.hooksPath=${gitHooksPath()}`, "cat-file", "blob", options.object], cwd: options.root });
  const bytes = execFileSync(invocation.executable, invocation.args, {
    env: invocation.env, windowsHide: true,
    cwd: options.root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  if (key) rememberBlob(options.root, options.object, bytes);
  return bytes;
}
export function contextFingerprint(options: { files: ContextFile[]; references?: PinnedContext[]; selections?: string[] }): string {
  const files = [...options.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => {
    let content = file.content;
    if (file.path.endsWith("/tasks.md") || file.path === "tasks.md")
      content = content.replace(/^(\s*[-*]\s+)\[[ xX]\](?=\s)/gm, "$1[ ]");
    return [file.path, content];
  });
  const references = options.references?.map(reference => [reference.repository, reference.change ?? null, reference.storeId ?? null, reference.fingerprint])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const payload = options.selections ? { files, selections: normalizeSelections(options.selections), ...(references?.length ? { references } : {}) } :
    references?.length ? { files, references } : files;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function normalizeSelections(paths: string[]): string[] {
  const sorted = [...new Set(paths.map(safeContextPath))].sort();
  return sorted.filter(path => !sorted.some(parent => parent !== path && path.startsWith(`${parent}/`)));
}
export function pinContext(options: {
  context: ResolvedContext;
  repository: string;
  revision: string;
  relevantPaths?: string[];
  /** Explicit Git root when the selection describes a historical project absent from the worktree. */
  planningRepositoryRoot?: string;
}): PinnedContext {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.revision)) throw new Error("Context requires a full Git revision");
  if (typeof options.repository !== "string" || !options.repository.trim() || isAbsolute(options.repository)) throw new Error("Context requires a portable repository identity");
  const root = repository(options.planningRepositoryRoot ?? options.context.planningRoot).root;
  if (git(root, "rev-parse", `${options.revision}^{commit}`) !== options.revision) throw new Error("Context revision must identify an available commit");
  const rootRelative = relative(root, options.context.planningRoot).split(sep).join("/");
  const fromRoot = (path: string) => safeContextPath(relative(root, path).split(sep).join("/"));
  const active = fromRoot(options.context.changeRoot);
  const planningDir = dirname(dirname(active));
  const requested = options.relevantPaths?.map(safeContextPath) ?? [
    `${planningDir}/specs`, `${planningDir}/config.yaml`, `${planningDir}/runner.yaml`,
    rootRelative ? `${rootRelative}/AGENTS.md` : "AGENTS.md",
  ];
  const required = [active, ...options.context.artifactPaths.map(fromRoot), ...(options.relevantPaths ? requested : [])];
  const selections = normalizeSelections([active, ...requested, ...options.context.artifactPaths.map(fromRoot)]);
  for (const path of selections) if (path === "runner/features" || path.startsWith("runner/features/")) throw new Error("Coordination records cannot be pinned contract inputs");
  const files = pinnedFiles({ root, revision: options.revision, selections, required });
  return { version: 1, repository: options.repository, revision: options.revision, change: options.context.change,
    ...(options.context.storeId ? { storeId: options.context.storeId } : {}), fingerprint: contextFingerprint({ files, selections }), files, selections };
}

export function committedTreeEntries(root: string, revision: string, scope?: string) {
  return gitRaw(root, "ls-tree", "-r", "-z", revision, ...(scope ? ["--", safeContextPath(scope)] : [])).split("\0").filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Invalid Git tree entry");
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
}
function pinnedFiles(options: { root: string; revision: string; selections: string[]; required: string[] }): ContextFile[] {
  const root = options.root, selections = options.selections, required = options.required;
  const entries = committedTreeEntries(root, options.revision);
  for (const path of required) if (!entries.some(e => e.path === path || e.path.startsWith(`${path}/`))) throw new Error(`Committed context path is missing: ${path}`);
  const selected = entries.filter(e => !e.path.startsWith("runner/features/") && e.path !== "runner/features" &&
    selections.some(path => e.path === path || e.path.startsWith(`${path}/`)));
  for (const entry of selected) {
    safeContextPath(entry.path);
    if (entry.mode === "120000") throw new Error(`Committed context cannot contain a symlink: ${entry.path}`);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error(`Context requires regular files: ${entry.path}`);
  }
  const blobs = committedBlobs({ root, objects: selected.map(entry => entry.object) });
  return selected.map((entry, index) => {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blobs[index]);
    return { path: entry.path, content };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
 }
export function pinReferenceContext(options: {
  root: string; repository: string; revision: string; storeId?: string; relevantPaths?: string[];
}): PinnedContext {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.revision)) throw new Error("Context requires a full Git revision");
  if (!options.repository?.trim() || isAbsolute(options.repository)) throw new Error("Context requires a portable repository identity");
  const root = repository(options.root).root;
  if (git(root, "rev-parse", `${options.revision}^{commit}`) !== options.revision) throw new Error("Context revision must identify an available commit");
  const prefix = relative(root, options.root).split(sep).join("/");
  const selections = normalizeSelections(options.relevantPaths ?? ["openspec/specs", "openspec/config.yaml", "openspec/runner.yaml", "AGENTS.md"].map(path => prefix ? `${prefix}/${path}` : path));
  for (const path of selections) if (path === "runner/features" || path.startsWith("runner/features/")) throw new Error("Coordination records cannot be pinned contract inputs");
  const files = pinnedFiles({ root, revision: options.revision, selections, required: options.relevantPaths ? selections : [] });
  if (!files.length) throw new Error("Canonical reference context requires committed specs/config/guidance");
  return { version: 1, repository: options.repository, revision: options.revision,
    ...(options.storeId ? { storeId: options.storeId } : {}), fingerprint: contextFingerprint({ files, selections }), files, selections };
}

/** Refresh exactly the approved portable scope; callers resolve repository identities explicitly. */
export function repinContext(options: { root: string; revision: string; context: PinnedContext }): PinnedContext {
  if (!options.context.selections?.length) throw new Error("Pinned selection scope is missing; renew approval");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.revision) || git(options.root, "rev-parse", `${options.revision}^{commit}`) !== options.revision)
    throw new Error("Context revision must identify an available full commit");
  const selections = normalizeSelections(options.context.selections);
  const files = pinnedFiles({ root: options.root, revision: options.revision, selections, required: options.context.files.map(file => file.path) });
  const { references, ...context } = options.context;
  return { ...context, revision: options.revision, selections, files, fingerprint: contextFingerprint({ files, selections }) };
}
