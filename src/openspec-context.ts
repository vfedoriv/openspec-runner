import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { git, gitRaw, repository, run } from "./system.js";

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

/** Read exact Git blob bytes; system.git deliberately trims command output. */
export function committedBlob(options: { root: string; object: string }): Buffer {
  // Refs and abbreviated IDs can resolve differently later and must stay uncached.
  const key = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.object) ? JSON.stringify([resolve(options.root), options.object]) : undefined;
  const cached = key ? blobCache.get(key) : undefined;
  if (cached) {
    blobCache.delete(key!); blobCache.set(key!, cached);
    return Buffer.from(cached);
  }
  const bytes = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "cat-file", "blob", options.object], {
    cwd: options.root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  if (key && bytes.length <= blobCacheLimit) {
    while (blobCache.size && (blobCacheBytes + bytes.length > blobCacheLimit || blobCache.size >= 1024)) {
      const oldest = blobCache.keys().next().value!;
      blobCacheBytes -= blobCache.get(oldest)!.length; blobCache.delete(oldest);
    }
    blobCache.set(key, Buffer.from(bytes)); blobCacheBytes += bytes.length;
  }
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
}): PinnedContext {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.revision)) throw new Error("Context requires a full Git revision");
  if (typeof options.repository !== "string" || !options.repository.trim() || isAbsolute(options.repository)) throw new Error("Context requires a portable repository identity");
  const root = repository(options.context.planningRoot).root;
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

function pinnedFiles(options: { root: string; revision: string; selections: string[]; required: string[] }): ContextFile[] {
  const root = options.root, selections = options.selections, required = options.required;
  const entries = gitRaw(root, "ls-tree", "-r", "-z", options.revision).split("\0").filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Invalid Git tree entry");
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
  for (const path of required) if (!entries.some(e => e.path === path || e.path.startsWith(`${path}/`))) throw new Error(`Committed context path is missing: ${path}`);
  return entries.filter(e => !e.path.startsWith("runner/features/") && e.path !== "runner/features" &&
    selections.some(path => e.path === path || e.path.startsWith(`${path}/`))).map(entry => {
    safeContextPath(entry.path);
    if (entry.mode === "120000") throw new Error(`Committed context cannot contain a symlink: ${entry.path}`);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error(`Context requires regular files: ${entry.path}`);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(committedBlob({ root, object: entry.object }));
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
