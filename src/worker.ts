import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { codexArgs } from "./codex.js";
import { run } from "./system.js";
import type { TaskAttempt } from "./runner.js";

// Exec exits after its turn and preserves session rollouts by default. The parent
// observes close only after the child and its report command have returned.
export async function superviseWorker(a: TaskAttempt, common: string, prompt: string, started: (pid: number) => void): Promise<number | null> {
  const help = run("codex", ["exec", "--help"], a.path, 10000);
  if (!["--add-dir", "--model", "--cd"].every(flag => help.includes(flag)))
    throw new Error("Codex exec lacks required capabilities; use a compatible CLI before retrying");
  mkdirSync(dirname(a.worker!.log), { recursive: true });
  const fd = openSync(a.worker!.log, "ax", 0o600);
  try {
    return await new Promise((resolvePromise, reject) => {
      let failure: unknown;
      const child = spawn("codex", ["exec", ...codexArgs(a.settings, a.path, undefined, common), prompt],
        { cwd: a.path, stdio: ["ignore", "pipe", "pipe"] });
      child.once("spawn", () => {
        try { started(child.pid!); } catch (error) { failure = error; }
      });
      child.stdout.on("data", chunk => { writeSync(fd, chunk); process.stdout.write(chunk); });
      child.stderr.on("data", chunk => { writeSync(fd, chunk); process.stderr.write(chunk); });
      child.once("error", error => { failure = error; });
      child.once("close", code => failure ? reject(failure) : resolvePromise(code));
    });
  } finally {
    fsyncSync(fd);
    closeSync(fd);
  }
}
