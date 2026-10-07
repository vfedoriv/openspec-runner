import { dirname, resolve } from "node:path";
import { assertRepositoryIdentity } from "./coordination.js";
import { json, repository } from "./system.js";

export function readMachineMap(path: string): Record<string, string> {
  const input = json<unknown>(resolve(path));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("--map must contain a repository identity to checkout path object");
  const result: Record<string, string> = {};
  for (const [id, root] of Object.entries(input)) {
    if (!id.trim() || typeof root !== "string" || !root.trim()) throw new Error("--map entries require repository identities and checkout paths");
    result[id] = repository(resolve(dirname(resolve(path)), root)).root;
    assertRepositoryIdentity({ root: result[id], repository: id });
  }
  return result;
}
