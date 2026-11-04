import { safeContextPath, type PinnedContext } from "./openspec-context.js";

/** The approved tasks inventory, never a caller-supplied root, selects scope. */
export function storeArchiveRoot(context: PinnedContext, change: string): string {
  if (context.change !== change) throw new Error("Store archive change differs from approved context");
  const suffix = `/changes/${change}/tasks.md`, files = context.files.filter(file => file.path.endsWith(suffix));
  if (files.length !== 1) throw new Error("Store archive requires one unambiguous approved tasks.md root");
  const root = files[0].path.slice(0, -suffix.length);
  archivePaths(root, change);
  return root;
}
export function archivePaths(root: string, change: string) {
  safeContextPath(root);
  if ((root !== "openspec" && !root.endsWith("/openspec")) || root.split("/").some(part => part === ".git" || part.includes(":")) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change)) throw new Error("Unsafe or unsupported OpenSpec archive root/change");
  return { active: `${root}/changes/${change}/`, archived: `${root}/changes/archive/`, specs: `${root}/specs/`, tasks: `${root}/changes/${change}/tasks.md` };
}
