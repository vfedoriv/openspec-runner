import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

export default async function* progressReporter(source) {
  const running = new Map();
  const heartbeat = setInterval(() => {
    if (!running.size) return;
    const files = [...running].map(([file, start]) => `${file} (${Math.round((Date.now() - start) / 1000)}s)`);
    process.stderr.write(`[tests] running: ${files.join(", ")}\n`);
  }, 15000);
  heartbeat.unref();
  async function* events() {
    try {
      for await (const event of source) {
        const name = event.data?.name;
        if (event.type === "test:dequeue" && event.data.nesting === 0 && name?.endsWith(".test.mjs")) {
          running.set(name, Date.now());
          process.stderr.write(`[tests] started ${name}\n`);
        }
        if (event.type === "test:complete") running.delete(name);
        yield event;
      }
    } finally { clearInterval(heartbeat); }
  }
  yield* Readable.from(events()).pipe(new spec());
}
