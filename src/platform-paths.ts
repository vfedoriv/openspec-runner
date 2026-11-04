import { existsSync, lstatSync, realpathSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, parse, relative, resolve, sep } from "node:path";

let emptyHooks: string | undefined;
export function gitHooksPath(): string {
  if (process.platform !== "win32") return "/dev/null";
  if (!emptyHooks) {
    emptyHooks = mkdtempSync(resolve(tmpdir(), "openspec-empty-hooks-"));
    const owned = emptyHooks;
    process.once("exit", () => { try { rmdirSync(owned); } catch { /* Never recursively remove unexpected contents. */ } });
  }
  return emptyHooks;
}

export function canonicalPath(path: string): string {
  const full = resolve(path);
  if (full.includes("\0") || (process.platform === "win32" && full.slice(parse(full).root.length).includes(":"))) throw new Error("Unsafe filesystem path");
  let ancestor = full;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return resolve(realpathSync.native(ancestor), relative(ancestor, full));
}
export function samePath(a: string, b: string): boolean {
  try { return canonicalPath(a) === canonicalPath(b); } catch { return false; }
}
export function containedPath(root: string, candidate: string): boolean {
  try {
    const parent = canonicalPath(root), child = canonicalPath(candidate);
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  } catch { return false; }
}
export function unredirectedPath(path: string): boolean {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return false;
    const parent = dirname(current);
    if (current === parent) return true;
    current = parent;
  }
}
export function protectContext(_root: string): { verified: boolean; reason?: string } {
  return process.platform === "win32"
    ? { verified: false, reason: "Windows delegated-context write protection is not verified; delegated execution is unsupported on this host" }
    : { verified: true };
}
