import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { replaceJson } from "./platform-files.js";
import { resolveCommand, renderArgument, renderCommand } from "./platform-command.js";
import { canonicalPath, gitHooksPath } from "./platform-paths.js";

export function runRaw(cmd: string, args: string[], cwd: string, timeout?: number): string {
  try {
    const invocation = resolveCommand({ executable: cmd, args, cwd });
    return execFileSync(invocation.executable, invocation.args, {
      cwd,
      env: invocation.env,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
  } catch (e: any) {
    throw new Error(
      `${cmd} ${args[0] ?? ""}: ${[e.stderr?.toString().trim(), e.stdout?.toString().trim()].filter(Boolean).join("\n") || e.message}`,
    );
  }
}
export function run(cmd: string, args: string[], cwd: string, timeout?: number): string {
  return runRaw(cmd, args, cwd, timeout).trim();
}
export const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", `core.hooksPath=${gitHooksPath()}`, ...args], cwd);
export const gitRaw = (cwd: string, ...args: string[]) =>
  runRaw("git", ["-c", `core.hooksPath=${gitHooksPath()}`, ...args], cwd);
export function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
export function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function atomic(path: string, value: unknown): void {
  replaceJson(path, value);
}
export function repository(cwd = process.cwd()) {
  const root = canonicalPath(git(cwd, "rev-parse", "--show-toplevel"));
  const common = canonicalPath(resolve(root, git(root, "rev-parse", "--git-common-dir")));
  return { root, common, stateDir: resolve(common, "openspec-runner") };
}
export function locked<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "lock.json"),
    token = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
    });
  const deadline = Date.now() + 3000;
  while (true) {
    try { writeFileSync(file, token, { flag: "wx", mode: 0o600 }); break; }
    catch (error: any) {
      // A supervisor and its reporting child may reach the short
      // critical section together. Wait only for a live, other local owner;
      // never delete/adopt a stale lock or wait for our own nested acquisition.
      if (error.code === "EEXIST" && Date.now() < deadline) {
        const owner = attempt(() => JSON.parse(readFileSync(file, "utf8")));
        if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid !== process.pid &&
            attempt(() => { process.kill(owner.pid, 0); return true; })) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
      }
    // Stale-lock removal is explicit: unlinking automatically races another contender.
    if (error?.code === "EEXIST")
      throw new Error(
        `Repository is locked: ${file}. If its owner is gone, remove the lock explicitly.`,
      );
    throw new Error(
      `Cannot create runner lock at ${file}: ${error?.code ?? error?.message}`,
      { cause: error },
    );
    }
  }
  try {
    return fn();
  } finally {
    if (attempt(() => readFileSync(file, "utf8")) === token) unlinkSync(file);
  }
}
export const quote = (s: string) => renderArgument(s, process.platform === "win32" ? "powershell" : "posix");
export const shellCommand = (args: string[]) => renderCommand(args, process.platform === "win32" ? "powershell" : "posix");
export function workerRunnerCommand(args: string[], agent: string): string {
  const command = process.platform === "win32" && agent === "codex"
    ? [process.execPath, fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url))]
    : ["openspec-runner"];
  return shellCommand([...command, ...args]);
}
export const clean = (cwd: string) => git(cwd, "status", "--porcelain") === "";
