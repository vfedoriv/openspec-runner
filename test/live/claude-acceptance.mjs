import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lifecycle-acceptance.mjs";
export { parseLifecycleArgs, runLifecycle } from "./lifecycle-acceptance.mjs";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), "claude");
}
