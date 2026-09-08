import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (e: any) {
    throw new Error(
      `${cmd} ${args[0] ?? ""}: ${[e.stderr?.toString().trim(), e.stdout?.toString().trim()].filter(Boolean).join("\n") || e.message}`,
    );
  }
}
export const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd);
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
export function repository(cwd = process.cwd()) {
  const root = git(cwd, "rev-parse", "--show-toplevel");
  const common = resolve(root, git(root, "rev-parse", "--git-common-dir"));
  return { root, common, stateDir: resolve(common, "openspec-runner") };
}
export function locked<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, "lock.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, host: hostname() }),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    // Stale-lock removal is explicit: unlinking automatically races another contender.
    throw new Error(
      `Repository is locked: ${file}. If its owner is gone, remove the lock explicitly.`,
    );
  }
  try {
    return fn();
  } finally {
    if (existsSync(file)) unlinkSync(file);
  }
}
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export const shellCommand = (args: string[]) => args.map(quote).join(" ");
export const clean = (cwd: string) => git(cwd, "status", "--porcelain") === "";
