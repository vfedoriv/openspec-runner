import fs, { type FileHandle } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createActivityDecoder, sanitizeActivityText } from "./activity-parser.js";
import type { ActivityDecoder, ActivityEntry, ActivityIdentity } from "./activity-types.js";

const MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 250;

export interface ActivityWriter {
  feed(chunk: Uint8Array, stream: "stdout" | "stderr"): void;
  close(): Promise<void>;
}

/** Observational capture: no disk operation runs in feed or escapes to supervision. */
export function createActivityWriter(log: string, identity: ActivityIdentity): ActivityWriter {
  const handles: FileHandle[] = [];
  const sizes = [0, 0, 0];
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let disabled = false;
  let ending = false;
  let decoder: ActivityDecoder | undefined;
  let stderrPending = Buffer.alloc(0);
  let stderrObservedAt: string | undefined;
  let stderrSequence = 0;
  let draining: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const disable = (error: unknown): void => {
    if (disabled) return;
    disabled = true;
    queue.length = 0;
    queuedBytes = 0;
    try {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Activity capture disabled: ${message}\n`, () => {});
    } catch { /* Diagnostics are best-effort too. */ }
  };
  try { decoder = createActivityDecoder(identity); } catch (error) { disable(error); }

  // Exclusive handles pin only files created by this capture. Even a later path
  // replacement cannot redirect writes to a preexisting file or symlink target.
  const ready = Promise.resolve().then(async () => {
    if (disabled) return;
    for (const suffix of ["", ".1", ".2"]) {
      if (disabled) return;
      const handle = await fs.open(log + ".activity.jsonl" + suffix, "wx+", 0o600);
      handles.push(handle);
      if (disabled) return;
    }
  }).catch(disable);

  const writeAll = async (handle: FileHandle, bytes: Buffer, position: number): Promise<void> => {
    let offset = 0;
    while (offset < bytes.length && !disabled) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
      if (!bytesWritten) throw new Error("Activity write made no progress");
      offset += bytesWritten;
    }
  };

  // Copy bounded chunks between owned handles instead of replacing filenames.
  // This avoids overwrite races at the fixed rotation names and whole-log reads.
  const copy = async (from: number, to: number): Promise<void> => {
    if (disabled) return;
    await handles[to]!.truncate(0);
    sizes[to] = 0;
    const buffer = Buffer.allocUnsafe(MAX_ENTRY_BYTES);
    let position = 0;
    while (position < sizes[from]! && !disabled) {
      const { bytesRead } = await handles[from]!.read(buffer, 0,
        Math.min(buffer.length, sizes[from]! - position), position);
      if (!bytesRead) throw new Error("Activity rotation read made no progress");
      await writeAll(handles[to]!, buffer.subarray(0, bytesRead), position);
      position += bytesRead;
    }
    sizes[to] = position;
  };

  const startDrain = (): void => {
    if (draining || disabled) return;
    draining = (async () => {
      await ready;
      while (queue.length && !disabled) {
        const bytes = queue.shift()!;
        // Keep the in-flight entry in the queue budget until its write finishes.
        if (sizes[0]! + bytes.length > MAX_FILE_BYTES) {
          await copy(1, 2);
          await copy(0, 1);
          if (disabled) return;
          await handles[0]!.truncate(0);
          sizes[0] = 0;
        }
        if (disabled) return;
        await writeAll(handles[0]!, bytes, sizes[0]!);
        sizes[0]! += bytes.length;
        queuedBytes -= bytes.length;
      }
    })().catch(disable).finally(() => {
      draining = undefined;
      if (queue.length && !disabled) startDrain();
    });
  };

  const enqueue = (entries: ActivityEntry[]): void => {
    for (const entry of entries) {
      if (disabled) return;
      const bytes = Buffer.from(JSON.stringify(entry) + "\n");
      if (bytes.length > MAX_ENTRY_BYTES) throw new Error("Activity entry exceeds the 64 KiB limit");
      if (queuedBytes + bytes.length > MAX_QUEUE_BYTES) throw new Error("Activity queue exceeds the 1 MiB limit");
      queue.push(bytes);
      queuedBytes += bytes.length;
    }
    if (queue.length) startDrain();
  };

  const stderrEntry = (bytes: Buffer, observedAt?: string): void => {
    const text = sanitizeActivityText(bytes.toString("utf8").replace(/\r$/, ""));
    if (!text.trim()) return;
    enqueue([{
      version: 1,
      id: `${identity.attemptId}:stderr:${++stderrSequence}`,
      identity: { ...identity },
      observedAt,
      kind: "raw",
      stream: "stderr",
      text,
    }]);
  };

  const feed = (chunk: Uint8Array, stream: "stdout" | "stderr"): void => {
    if (disabled || ending) return;
    try {
      const observedAt = new Date().toISOString();
      if (stream === "stdout") {
        enqueue(decoder!.feed(chunk, "stdout", observedAt));
        return;
      }
      // Stderr is raw diagnostic text. It cannot mutate stdout tool correlation
      // or acquire structured turn/session meaning through the activity parser.
      const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      while (offset < input.length && !disabled) {
        const newline = input.indexOf(0x0a, offset);
        const part = input.subarray(offset, newline < 0 ? input.length : newline);
        if (stderrPending.length + part.length > MAX_ENTRY_BYTES)
          throw new Error("Activity stderr record exceeds the 64 KiB limit");
        if (!stderrPending.length) stderrObservedAt = observedAt;
        const line = stderrPending.length ? Buffer.concat([stderrPending, part]) : Buffer.from(part);
        if (newline < 0) { stderrPending = line; return; }
        stderrPending = Buffer.alloc(0);
        stderrEntry(line, observedAt);
        stderrObservedAt = undefined;
        offset = newline + 1;
      }
    } catch (error) { disable(error); }
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    ending = true;
    if (!disabled) {
      try {
        enqueue(decoder!.end());
        if (stderrPending.length) stderrEntry(stderrPending, stderrObservedAt);
        stderrPending = Buffer.alloc(0);
      } catch (error) { disable(error); }
    }
    const finish = (async () => {
      await ready;
      while (draining) await draining;
      await Promise.all(handles.map(handle => handle.close().catch(disable)));
    })().catch(disable);
    closing = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        disable(new Error("Activity close exceeded 250 ms"));
        resolve();
      }, CLOSE_TIMEOUT_MS);
      void finish.finally(() => { clearTimeout(timer); resolve(); });
    });
    return closing;
  };

  return { feed, close };
}
