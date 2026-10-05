import { resolve } from "node:path";
import { run } from "node:test";
import progressReporter from "./progress-reporter.mjs";

const files = process.argv.slice(2).map(file => resolve(file));
if (!files.length) throw new Error("Supply at least one test file");
const timeout = Number(process.env.OPENSPEC_TEST_TIMEOUT_MS ?? 300000);
if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("OPENSPEC_TEST_TIMEOUT_MS must be a positive integer");
const fileSet = new Set(files), timers = new Map();
const controller = new AbortController();
const abort = () => { process.exitCode = 1; controller.abort(new Error("Test run interrupted")); };
process.once("SIGINT", abort); process.once("SIGTERM", abort);
const stream = run({ files, concurrency: true, signal: controller.signal });
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
