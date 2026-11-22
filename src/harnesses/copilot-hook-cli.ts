import { repository } from "../system.js";
import { normalizeHook, recordHook } from "./copilot-hooks.js";
import { assertStoreBindingAuthority, resolveBoundExecutionContext } from "../execution-context.js";

export async function hookCommand(args: string[]): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB");
  }
  const event = normalizeHook(args[0], JSON.parse(input));
  let repo;
  try { repo = repository(event.cwd); } catch { process.stdout.write("{}"); return; }
  let stateDir = repo.stateDir;
  if (args[1] !== undefined) {
    if (args.length !== 3 || args[1] !== "--store-scope" || !/^[A-Za-z0-9_-]+$/.test(args[2])) throw new Error("Invalid Store hook scope");
    const selection = JSON.parse(Buffer.from(args[2], "base64url").toString("utf8"));
    if (!selection || typeof selection.storeRoot !== "string" || typeof selection.change !== "string" || typeof selection.assignmentId !== "string") throw new Error("Incomplete Store hook scope");
    const execution = resolveBoundExecutionContext({ ...selection, implementationRoot: event.cwd });
    assertStoreBindingAuthority(execution, selection.change);
    stateDir = execution.runtimeDir;
  }
  const result = recordHook({ stateDir, event });
  process.stdout.write(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
