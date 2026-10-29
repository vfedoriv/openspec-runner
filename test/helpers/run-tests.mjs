import { resolve, dirname, basename } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "node:test";
import progressReporter from "./progress-reporter.mjs";

const requested = process.argv.slice(2);
const files = [...new Set((requested.length ? requested : [fileURLToPath(new URL("../*.test.mjs", import.meta.url))]).flatMap(file => {
  if (basename(file) !== "*.test.mjs") return [resolve(file)];
  const root = resolve(dirname(file));
  return readdirSync(root).filter(name => name.endsWith(".test.mjs")).sort().map(name => resolve(root, name));
}))];
if (!files.length) throw new Error("No test files found");
const timeout = Number(process.env.OPENSPEC_TEST_TIMEOUT_MS ?? 300000);
if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("OPENSPEC_TEST_TIMEOUT_MS must be a positive integer");
const fileSet = new Set(files), timers = new Map();
const controller = new AbortController();
const abort = () => { process.exitCode = 1; controller.abort(new Error("Test run interrupted")); };
process.once("SIGINT", abort); process.once("SIGTERM", abort);
const stream = run({ files, concurrency: 4, signal: controller.signal });
// Consume queued events too: Node 22 can emit its first file-start before run()
// returns, so attaching an EventEmitter listener would miss that watchdog.
async function* monitored(source) {
  try {
    for await (const event of source) {
      const name = event.data?.name;
      if (event.type === "test:dequeue" && fileSet.has(name)) {
        timers.set(name, setTimeout(() => {
          process.exitCode = 1;
          controller.abort(new Error(`Test file exceeded ${timeout}ms: ${name}`));
        }, timeout));
      }
      if (event.type === "test:complete") { clearTimeout(timers.get(name)); timers.delete(name); }
      if (event.type === "test:fail") process.exitCode = 1;
      yield event;
    }
  } finally {
    for (const timer of timers.values()) clearTimeout(timer);
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
stream.compose(monitored).compose(progressReporter).pipe(process.stdout);
