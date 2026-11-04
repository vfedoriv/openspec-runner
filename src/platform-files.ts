import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Windows supports file flushing but not fsync of directory handles. */
export function flushDirectory(path: string): "flushed" | "unsupported" {
  if (process.platform === "win32") return "unsupported";
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return "flushed";
}

function publish(path: string, bytes: Uint8Array, exclusive: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    if (exclusive) linkSync(temporary, path);
    else {
      const deadline = Date.now() + 3000;
      while (true) {
        try { renameSync(temporary, path); break; }
        catch (error: any) {
          // Readers/scanners can briefly hold an NTFS sharing lock. Keep both
          // files intact and bound retries to replacement of a writable file.
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
              Date.now() >= deadline || !existsSync(path) || !statSync(path).isFile() || !(statSync(path).mode & 0o200)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    }
    flushDirectory(dirname(path));
  } finally {
    try { unlinkSync(temporary); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
}

export function replaceBytes(path: string, bytes: Uint8Array): void { publish(path, bytes, false); }
export function replaceJson(path: string, value: unknown): void {
  replaceBytes(path, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}
export function publishExclusive(path: string, bytes: Uint8Array): void { publish(path, bytes, true); }
