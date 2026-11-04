import { repository } from "../system.js";
import { normalizeHook, recordHook } from "./copilot-hooks.js";

export async function hookCommand(args: string[]): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB");
  }
  const event = normalizeHook(args[0], JSON.parse(input));
  let repo;
  try { repo = repository(event.cwd); } catch { process.stdout.write("{}"); return; }
  const result = recordHook({ stateDir: repo.stateDir, event });
  process.stdout.write(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
