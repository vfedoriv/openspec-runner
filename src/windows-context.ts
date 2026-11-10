import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentBinding } from "./component-state.js";
import type { ContextFile } from "./openspec-context.js";
import { resolveCommand } from "./platform-command.js";
import { atomic, json } from "./system.js";

interface ContextRequest {
  stateDir: string;
  journalPath: string;
  roots: { path: string; files: ContextFile[] }[];
  requireStandard?: boolean;
}
type Target = { path: string; directory: boolean; mask: number };
type Descriptor = { before: string; after: string };
type Journal = { version: 1; sid: string; targets: (Target & Descriptor & { identity: string })[] };

const deleteChild = 64;
const deleteObject = 65536;
const changeAttributes = 16 | 256;
const writeData = 2 | 4;
const helper = fileURLToPath(new URL("../bin/windows-context.ps1", import.meta.url));

function windows<T>(input: object): T {
  try {
    const invocation = resolveCommand({ executable: "pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-File", helper], cwd: process.cwd() });
    return JSON.parse(execFileSync(invocation.executable, invocation.args, {
      env: invocation.env, input: JSON.stringify(input), encoding: "utf8", windowsHide: true,
      timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    throw new Error(`Windows delegated-context protection could not be verified: ${failure.stderr?.trim() || failure.message}`);
  }
}

export function assertWindowsContextHost(stateDir: string) {
  windows({ operation: "paths", paths: [stateDir], requireStandard: true });
}

export function windowsContextRequest(stateDir: string, binding: Pick<ComponentBinding, "assignment" | "contextPaths">): ContextRequest {
  const { assignment, contextPaths } = binding;
  const contexts = [assignment.contract, ...(assignment.contract.references ?? [])];
  return { stateDir, requireStandard: true, journalPath: resolve(stateDir, "component-protection", assignment.featureId, `${assignment.id}.json`),
    roots: contexts.map((context, index) => ({ path: contextPaths[index], files: context.files })) };
}

function assertWindowsName(name: string) {
  if (!name || /[<>:"\\|?*\x00-\x1f]|[. ]$/.test(name) ||
      /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(name) ||
      /^[^.\s]{1,6}~\d+(?:\.[^.\s]{1,3})?$/.test(name))
    throw new Error(`Unsafe Windows context name: ${name}`);
}

function inventory(request: ContextRequest) {
  const { stateDir, roots, journalPath } = request;
  const context = resolve(stateDir, "component-context");
  const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(stateDir, journalPath) || inside(context, journalPath) || journalPath === context || !roots.length)
    throw new Error("Invalid Windows context journal or inventory location");
  const assignment = dirname(roots[0].path), feature = dirname(assignment);
  if (dirname(feature) !== context || roots.some((root, index) => root.path !== resolve(assignment, String(index))))
    throw new Error("Invalid Windows assignment context roots");
  assertWindowsName(basename(feature));
  assertWindowsName(basename(assignment));
  const targets = new Map<string, Target>();
  const contents = new Map<string, Buffer>();
  const add = (path: string, directory: boolean, mask: number) => {
    const key = path.toUpperCase();
    const previous = targets.get(key);
    if (previous && (previous.path !== path || !directory || !previous.directory))
      throw new Error(`Windows context has an aliased path: ${path}`);
    targets.set(key, { path, directory, mask });
  };
  add(stateDir, true, deleteChild);
  for (const path of [context, feature]) add(path, true, deleteChild | deleteObject | changeAttributes | 2);
  const directoryMask = deleteChild | deleteObject | changeAttributes | writeData;
  add(assignment, true, directoryMask);
  for (const root of roots) {
    add(root.path, true, directoryMask);
    for (const file of root.files) {
      let path = root.path;
      const parts = file.path.split("/");
      for (const [index, part] of parts.entries()) {
        assertWindowsName(part);
        path = resolve(path, part);
        const directory = index < parts.length - 1;
        add(path, directory, directory ? directoryMask : deleteObject | changeAttributes | writeData);
      }
      contents.set(path, Buffer.from(file.content, "utf8"));
    }
  }
  return { assignment, targets: [...targets.values()], contents };
}

export function validateWindowsContextInventory(request: ContextRequest) {
  inventory(request);
}

function exactInventory(expected: ReturnType<typeof inventory>) {
  assertPathSpelling(expected);
  const paths = new Set(expected.targets.map(target => target.path));
  const identities = new Set<string>();
  return expected.targets.map(target => {
    const info = lstatSync(target.path, { bigint: true });
    if (info.isSymbolicLink() || (target.directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n))
      throw new Error(`Unsafe Windows pinned context path: ${target.path}`);
    if (!target.directory && !readFileSync(target.path).equals(expected.contents.get(target.path)!))
      throw new Error(`Pinned context differs from approved content: ${target.path}`);
    if (target.directory && (target.path === expected.assignment || target.path.startsWith(expected.assignment + sep))) {
      for (const child of readdirSync(target.path)) {
        if (!paths.has(resolve(target.path, child))) throw new Error(`Unexpected pinned context entry: ${child}`);
      }
    }
    const identity = `${info.dev}:${info.ino}`;
    if (identities.has(identity)) throw new Error(`Windows context has an aliased object: ${target.path}`);
    identities.add(identity);
    return { ...target, identity };
  });
}

function assertPathSpelling(expected: ReturnType<typeof inventory>) {
  const siblings = new Map<string, string[]>();
  for (const target of expected.targets.slice(1)) {
    const parent = dirname(target.path);
    if (!existsSync(parent)) continue;
    if (!siblings.has(parent)) siblings.set(parent, readdirSync(parent));
    const entries = siblings.get(parent)!;
    const name = basename(target.path);
    if ((existsSync(target.path) && !entries.includes(name)) ||
        entries.some(entry => entry !== name && entry.toUpperCase() === name.toUpperCase()))
      throw new Error(`Windows context has an aliased path: ${target.path}`);
  }
}

function journalFor(request: ContextRequest, targets: ReturnType<typeof exactInventory>) {
  const info = lstatSync(request.journalPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe Windows context protection journal");
  const journal = json<Journal>(request.journalPath);
  if (journal.version !== 1 || !/^S-\d+(?:-\d+)+$/.test(journal.sid) || !Array.isArray(journal.targets) || journal.targets.length !== targets.length ||
      journal.targets.some(({ before, after, ...target }, index) =>
        typeof before !== "string" || typeof after !== "string" || JSON.stringify(target) !== JSON.stringify(targets[index])))
    throw new Error("Windows context protection journal differs from its approved inventory");
  return journal;
}

export function sealWindowsContext(request: ContextRequest) {
  const expected = inventory(request);
  windows({ operation: "paths", requireStandard: request.requireStandard, paths: [...expected.targets.map(target => target.path), request.journalPath] });
  assertPathSpelling(expected);
  if (!existsSync(request.journalPath)) {
    for (const target of expected.targets) {
      if (existsSync(target.path)) continue;
      if (target.directory) mkdirSync(target.path);
      else writeFileSync(target.path, expected.contents.get(target.path)!, { flag: "wx" });
    }
    const targets = exactInventory(expected);
    const plan = windows<{ sid: string; entries: Descriptor[] }>({ operation: "plan", targets });
    if (plan.entries.length !== targets.length) throw new Error("Windows ACL plan is incomplete");
    mkdirSync(dirname(request.journalPath), { recursive: true });
    atomic(request.journalPath, { version: 1, sid: plan.sid,
      targets: targets.map((target, index) => ({ ...target, ...plan.entries[index] })) } satisfies Journal);
  }
  const journal = journalFor(request, exactInventory(expected));
  const scratch = resolve(request.stateDir, `context-delete-probe-${randomUUID()}.tmp`);
  const runtimeFiles = readdirSync(request.stateDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => resolve(request.stateDir, entry.name));
  writeFileSync(scratch, "", { flag: "wx" });
  let scratchDirectory: string | undefined;
  try {
    scratchDirectory = mkdtempSync(resolve(request.stateDir, "context-delete-probe-"));
    windows({ operation: "apply", ...journal, runtimeFiles: [scratch, scratchDirectory, ...runtimeFiles] });
  } finally {
    unlinkSync(scratch);
    if (scratchDirectory) rmdirSync(scratchDirectory);
  }
}

export function verifyWindowsContext(request: ContextRequest) {
  const expected = inventory(request);
  windows({ operation: "paths", requireStandard: request.requireStandard, paths: [...expected.targets.map(target => target.path), request.journalPath] });
  const journal = journalFor(request, exactInventory(expected));
  windows({ operation: "verify", ...journal });
}

/** Restoration for a disposable runtime with a single assignment. */
export function restoreWindowsContext(request: ContextRequest) {
  if (!existsSync(request.journalPath)) return;
  const expected = inventory(request);
  windows({ operation: "paths", paths: [...expected.targets.map(target => target.path), request.journalPath] });
  for (const path of [dirname(expected.assignment), dirname(dirname(expected.assignment))]) {
    if (readdirSync(path).length !== 1) throw new Error("Refusing to restore shared Windows context protection");
  }
  const journal = journalFor(request, exactInventory(expected));
  windows({ operation: "restore", ...journal, targets: [...journal.targets].reverse() });
}

export function probeWindowsContext(stateDir: string) {
  const scratch = mkdtempSync(resolve(stateDir, "context-probe-"));
  const request = { stateDir: scratch, journalPath: resolve(scratch, "journal.json"),
    roots: [{ path: resolve(scratch, "component-context/probe/assignment/0"), files: [{ path: "probe.txt", content: "probe" }] }] };
  try { sealWindowsContext(request); }
  finally {
    restoreWindowsContext(request);
    rmSync(scratch, { recursive: true, force: true });
  }
}
