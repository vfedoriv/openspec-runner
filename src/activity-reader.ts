import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ActivityEntry, ActivityIdentity, ActivityPage, ActivityPageOptions } from "./activity-types.js";
import { createActivityRecordNormalizer, sanitizeActivityText } from "./activity-parser.js";

const MAX_PAGE_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_PAGE_ENTRIES = 200;
type StreamName = "stdout" | "stderr";
type SkipKind = "forward" | "backward" | "pending";
type Position = {
  fileId: string;
  offset: number;
  size: number;
  signature: string;
  skip?: SkipKind;
  entryOffset?: number;
  pendingStart?: number;
};
type CursorState = { version: 1; source: string; start: Position; end: Position };
type FileRef = { path: string; fileId: string; size: number; signature: string; signatureBytes: number };
type Budget = { remaining: number };
type ScannedRecord = {
  start: number;
  end: number;
  nextOffset: number;
  bytes?: Buffer;
  oversized?: boolean;
  partial?: boolean;
  eofPartial?: boolean;
};
type RecordNormalizer = (line: string, stream: StreamName, idPrefix: string) => ActivityEntry[];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileIdentity(path: string): FileRef | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    const length = Math.min(64, stat.size);
    const signature = Buffer.alloc(length);
    let signatureBytes = 0;
    if (length > 0) {
      const fd = openSync(path, "r");
      try {
        signatureBytes = readSync(fd, signature, 0, length, 0);
      } finally {
        closeSync(fd);
      }
    }
    const marker = [stat.dev, stat.ino, stat.birthtimeMs].join(":");
    return {
      path,
      fileId: digest(marker),
      size: stat.size,
      signature: signature.subarray(0, signatureBytes).toString("hex"),
      signatureBytes,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function encodeCursor(value: CursorState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorState | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const cursor = parsed as Partial<CursorState>;
    if (cursor.version !== 1 || typeof cursor.source !== "string") return undefined;
    const validPosition = (position: unknown): position is Position => {
      if (!position || typeof position !== "object" || Array.isArray(position)) return false;
      const candidate = position as Partial<Position>;
      return typeof candidate.fileId === "string" && Number.isSafeInteger(candidate.offset) &&
        (candidate.offset as number) >= 0 && Number.isSafeInteger(candidate.size) && (candidate.size as number) >= 0 &&
        typeof candidate.signature === "string" &&
        (candidate.skip === undefined || candidate.skip === "forward" || candidate.skip === "backward" || candidate.skip === "pending") &&
        (candidate.entryOffset === undefined || (Number.isSafeInteger(candidate.entryOffset) && candidate.entryOffset >= 0)) &&
        (candidate.pendingStart === undefined || (Number.isSafeInteger(candidate.pendingStart) && candidate.pendingStart >= 0 && candidate.pendingStart <= (candidate.offset as number)));
    };
    if (!validPosition(cursor.start) || !validPosition(cursor.end)) return undefined;
    return cursor as CursorState;
  } catch {
    return undefined;
  }
}

function diagnosticEntry(
  identity: ActivityIdentity,
  message: string,
  stream: StreamName,
  id: string,
): ActivityEntry {
  return {
    version: 1,
    id,
    identity: { ...identity },
    kind: "diagnostic",
    stream,
    text: sanitizeActivityText(message),
  };
}

function normalizeFileRecord(
  bytes: Buffer,
  identity: ActivityIdentity,
  file: FileRef,
  offset: number,
  sidecar: boolean,
  normalizer?: RecordNormalizer,
): ActivityEntry[] {
  const source = bytes.toString("utf8").replace(/\r$/, "");
  const stablePrefix = (sidecar ? "sidecar-" : "legacy-") + file.fileId.slice(0, 20) + "-" + offset.toString(16);
  if (!sidecar) {
    const entries = normalizer
      ? normalizer(source, "stdout", stablePrefix)
      : [];
    return entries;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return [diagnosticEntry(identity, "Malformed activity sidecar record", "stdout", stablePrefix + ":0")];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [diagnosticEntry(identity, "Activity sidecar record is not an object", "stdout", stablePrefix + ":0")];
  }
  const raw = value as Record<string, unknown>;
  const savedIdentity = raw.identity;
  const allowedKinds = ["message", "command", "file-change", "diagnostic", "turn", "raw"];
  if (raw.version !== 1 || typeof raw.id !== "string" || !raw.id ||
      !savedIdentity || typeof savedIdentity !== "object" || Array.isArray(savedIdentity) ||
      typeof (savedIdentity as Record<string, unknown>).attemptId !== "string" ||
      typeof (savedIdentity as Record<string, unknown>).harness !== "string" ||
      !allowedKinds.includes(String(raw.kind)) ||
      (raw.stream !== "stdout" && raw.stream !== "stderr") ||
      typeof raw.text !== "string") {
    return [diagnosticEntry(identity, "Invalid activity sidecar entry", raw.stream === "stderr" ? "stderr" : "stdout", stablePrefix + ":0")];
  }
  const saved = savedIdentity as Record<string, string>;
  if (saved.attemptId !== identity.attemptId || saved.harness !== identity.harness) {
    return [diagnosticEntry(identity, "Activity sidecar entry identity does not match the selected attempt", raw.stream, stablePrefix + ":0")];
  }
  const entry: ActivityEntry = {
    version: 1,
    id: raw.id,
    identity: { attemptId: saved.attemptId, harness: saved.harness },
    kind: raw.kind as ActivityEntry["kind"],
    stream: raw.stream,
    text: sanitizeActivityText(raw.text),
  };
  if (typeof raw.observedAt === "string") entry.observedAt = raw.observedAt;
  if (typeof raw.toolId === "string") entry.toolId = raw.toolId;
  if (typeof raw.outcome === "string") entry.outcome = raw.outcome;
  return [entry];
}

function oversizedEntry(identity: ActivityIdentity, file: FileRef, offset: number): ActivityEntry {
  return diagnosticEntry(
    identity,
    "Oversized activity record exceeded the 64 KiB limit; discarded through its next newline",
    "stdout",
    "oversize-" + file.fileId.slice(0, 20) + "-" + offset.toString(16),
  );
}

function readAt(fd: number, position: number, length: number, budget: Budget): Buffer {
  const allowed = Math.min(length, budget.remaining);
  if (allowed <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(allowed);
  const count = readSync(fd, buffer, 0, allowed, position);
  budget.remaining -= count;
  return count === allowed ? buffer : buffer.subarray(0, count);
}

function scanForward(file: FileRef, offset: number, budget: Budget): ScannedRecord | undefined {
  if (offset >= file.size || budget.remaining <= 0) return undefined;
  const fd = openSync(file.path, "r");
  try {
    let position = offset;
    let lineLength = 0;
    let oversized = false;
    const pieces: Buffer[] = [];
    while (position < file.size && budget.remaining > 0) {
      const chunk = readAt(fd, position, 8192, budget);
      if (!chunk.length) break;
      const newline = chunk.indexOf(0x0a);
      const content = newline < 0 ? chunk : chunk.subarray(0, newline);
      if (!oversized && lineLength + content.length > MAX_RECORD_BYTES) {
        oversized = true;
        pieces.length = 0;
      }
      if (!oversized && content.length) pieces.push(Buffer.from(content));
      lineLength += content.length;
      position += newline < 0 ? chunk.length : newline + 1;
      if (newline >= 0) {
        return {
          start: offset,
          end: position,
          nextOffset: position,
          ...(oversized ? { oversized: true } : { bytes: Buffer.concat(pieces) }),
        };
      }
      if (budget.remaining <= 0 && position < file.size) {
        return oversized
          ? { start: offset, end: position, nextOffset: position, oversized: true, partial: true }
          : undefined;
      }
    }
    if (position >= file.size && lineLength > 0) {
      return {
        start: offset,
        end: file.size,
        nextOffset: file.size,
        eofPartial: true,
        ...(oversized ? { oversized: true } : { bytes: Buffer.concat(pieces) }),
      };
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function scanForwardSkip(file: FileRef, offset: number, budget: Budget): { offset: number; complete: boolean } {
  if (offset >= file.size) return { offset: file.size, complete: true };
  const fd = openSync(file.path, "r");
  try {
    let position = offset;
    while (position < file.size && budget.remaining > 0) {
      const chunk = readAt(fd, position, 8192, budget);
      if (!chunk.length) break;
      const newline = chunk.indexOf(0x0a);
      position += newline < 0 ? chunk.length : newline + 1;
      if (newline >= 0) return { offset: position, complete: true };
    }
    return { offset: position, complete: position >= file.size };
  } finally {
    closeSync(fd);
  }
}

function scanBackward(file: FileRef, offset: number, budget: Budget): ScannedRecord | undefined {
  if (offset <= 0 || budget.remaining <= 0) return undefined;
  const fd = openSync(file.path, "r");
  try {
    const recordEnd = Math.min(offset, file.size);
    let position = recordEnd;
    let first = true;
    let terminatedAtEnd = false;
    let lineLength = 0;
    let oversized = false;
    const pieces: Buffer[] = [];
    while (position > 0 && budget.remaining > 0) {
      const blockLength = Math.min(8192, position, budget.remaining);
      const blockStart = position - blockLength;
      const block = readAt(fd, blockStart, blockLength, budget);
      if (!block.length) break;
      let content = block;
      if (first) {
        terminatedAtEnd = content[content.length - 1] === 0x0a;
        if (terminatedAtEnd) content = content.subarray(0, content.length - 1);
      }
      first = false;
      const newline = content.lastIndexOf(0x0a);
      if (newline >= 0) {
        const tail = content.subarray(newline + 1);
        const totalLength = lineLength + tail.length;
        if (!oversized && totalLength > MAX_RECORD_BYTES) oversized = true;
        const start = blockStart + newline + 1;
        return {
          start,
          end: recordEnd,
          nextOffset: start,
          ...(recordEnd === file.size && !terminatedAtEnd ? { eofPartial: true } : {}),
          ...(oversized ? { oversized: true } : { bytes: Buffer.concat([Buffer.from(tail), ...pieces.reverse()]) }),
        };
      }
      if (!oversized && content.length) {
        if (lineLength + content.length > MAX_RECORD_BYTES) {
          oversized = true;
          pieces.length = 0;
        } else {
          pieces.push(Buffer.from(content));
        }
      }
      lineLength += content.length;
      position = blockStart;
    }
    if (position === 0 && lineLength > 0) {
      return {
        start: 0,
        end: recordEnd,
        nextOffset: 0,
        ...(recordEnd === file.size && !terminatedAtEnd ? { eofPartial: true } : {}),
        ...(oversized ? { oversized: true } : { bytes: Buffer.concat(pieces.reverse()) }),
      };
    }
    if (budget.remaining <= 0 && position > 0 && oversized) {
      return { start: position, end: recordEnd, nextOffset: position, oversized: true, partial: true };
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function scanBackwardSkip(file: FileRef, offset: number, budget: Budget): { offset: number; complete: boolean } {
  if (offset <= 0) return { offset: 0, complete: true };
  const fd = openSync(file.path, "r");
  try {
    let position = offset;
    let first = true;
    while (position > 0 && budget.remaining > 0) {
      const blockLength = Math.min(8192, position, budget.remaining);
      const blockStart = position - blockLength;
      const block = readAt(fd, blockStart, blockLength, budget);
      if (!block.length) break;
      let content = block;
      if (first && content[content.length - 1] === 0x0a) content = content.subarray(0, content.length - 1);
      first = false;
      const newline = content.lastIndexOf(0x0a);
      if (newline >= 0) return { offset: blockStart + newline + 1, complete: true };
      position = blockStart;
    }
    return { offset: position, complete: position === 0 };
  } finally {
    closeSync(fd);
  }
}

function positionFor(
  files: FileRef[],
  index: number,
  offset: number,
  skip?: SkipKind,
  entryOffset?: number,
  pendingStart?: number,
): Position {
  return {
    fileId: files[index].fileId,
    offset,
    size: files[index].size,
    signature: files[index].signature,
    ...(skip ? { skip } : {}),
    ...(entryOffset !== undefined && entryOffset > 0 ? { entryOffset } : {}),
    ...(pendingStart !== undefined ? { pendingStart } : {}),
  };
}

function entryIdPrefix(file: FileRef, offset: number): string {
  return "legacy-" + file.fileId.slice(0, 20) + "-" + offset.toString(16);
}

function recordEntries(
  record: ScannedRecord,
  identity: ActivityIdentity,
  file: FileRef,
  sidecar: boolean,
  mode: "normalized" | "raw",
  normalizer?: RecordNormalizer,
): ActivityEntry[] {
  if (record.oversized) {
    if (record.eofPartial) return [];
    return [oversizedEntry(identity, file, record.start)];
  }
  if (!record.bytes) return [];
  const prefix = entryIdPrefix(file, record.start);
  const source = record.bytes.toString("utf8").replace(/\r$/, "");
  if (mode === "raw") {
    const text = sanitizeActivityText(source);
    if (!text) return [];
    return [{ version: 1, id: prefix + ":1", identity: { ...identity }, kind: "raw", stream: "stdout", text }];
  }
  if (record.eofPartial && sidecar) return [];
  const normalized = normalizeFileRecord(record.bytes, identity, file, record.start, sidecar, normalizer);
  const visible = record.eofPartial && normalized.length > 0 &&
    normalized.every((entry) => entry.kind === "diagnostic" && /Malformed activity record/.test(entry.text))
    ? []
    : normalized;
  return sidecar
    ? visible
    : visible.map((entry, index) => ({ ...entry, id: prefix + ":" + (index + 1).toString(36) }));
}

function buildPage(
  options: ActivityPageOptions,
  files: FileRef[],
  sidecar: boolean,
  source: string,
  cursor: CursorState | undefined,
  reset: boolean,
  errors: string[],
): ActivityPage {
  const limitValue = options.limit;
  const limit = typeof limitValue === "number" && Number.isFinite(limitValue)
    ? Math.max(1, Math.min(MAX_PAGE_ENTRIES, Math.floor(limitValue)))
    : MAX_PAGE_ENTRIES;
  const mode = options.mode ?? "normalized";
  const identityReadBytes = files.reduce((sum, file) => sum + file.signatureBytes, 0);
  const budget: Budget = { remaining: MAX_PAGE_BYTES - identityReadBytes };
  const entries: ActivityEntry[] = [];
  const legacyNormalizer = !sidecar && mode === "normalized"
    ? createActivityRecordNormalizer(options.identity)
    : undefined;
  let startPosition: Position | undefined;
  let endPosition: Position | undefined;
  let progressed = false;

  if (options.direction === "newer") {
    let index = cursor ? files.findIndex((file) => file.fileId === cursor.end.fileId) : 0;
    let offset = cursor ? cursor.end.offset : 0;
    let skip = cursor?.end.skip;
    let entryOffset = cursor?.end.entryOffset ?? 0;
    if (index < 0) index = 0;
    startPosition = cursor?.end ?? positionFor(files, index, offset);
    if (skip === "pending" && cursor) {
      const file = files[index];
      const appended = file && file.size > cursor.end.size;
      offset = cursor.end.pendingStart ?? cursor.end.offset;
      if (appended) {
        skip = undefined;
        entryOffset = 0;
        startPosition = positionFor(files, index, offset);
      }
    }
    while (index < files.length && entries.length < limit && budget.remaining > 0) {
      const file = files[index];
      if (skip === "forward") {
        const result = scanForwardSkip(file, offset, budget);
        progressed ||= result.offset !== offset;
        offset = result.offset;
        skip = undefined;
        entryOffset = 0;
        endPosition = positionFor(files, index, offset);
        if (!result.complete) {
          endPosition = positionFor(files, index, offset, "forward");
          break;
        }
      }
      if (offset >= file.size) {
        endPosition = positionFor(files, index, offset);
        index += 1;
        if (index < files.length) {
          offset = 0;
          skip = undefined;
          entryOffset = 0;
          continue;
        }
        break;
      }
      const record = scanForward(file, offset, budget);
      if (!record) break;
      progressed = true;
      const normalized = recordEntries(record, options.identity, file, sidecar, mode, legacyNormalizer);
      const remaining = normalized.slice(entryOffset);
      const available = limit - entries.length;
      const selected = remaining.slice(0, available);
      if (selected.length) entries.push(...selected);
      const consumed = entryOffset + selected.length;
      if (record.eofPartial) {
        endPosition = positionFor(files, index, record.start, "pending", consumed, record.start);
        offset = record.start;
        skip = "pending";
        entryOffset = consumed;
        break;
      }
      if (selected.length < remaining.length) {
        endPosition = positionFor(files, index, record.start, undefined, consumed);
        offset = record.start;
        skip = undefined;
        entryOffset = consumed;
        break;
      }
      endPosition = positionFor(files, index, record.end, record.partial ? "forward" : undefined);
      if (record.partial) {
        offset = record.nextOffset;
        skip = "forward";
        break;
      }
      offset = record.nextOffset;
      skip = undefined;
      entryOffset = 0;
    }
    if (!endPosition && cursor) endPosition = cursor.end;
    if (!endPosition && files[index]) endPosition = positionFor(files, index, Math.min(offset, files[index].size));
  } else {
    let index = cursor ? files.findIndex((file) => file.fileId === cursor.start.fileId) : files.length - 1;
    let offset = cursor ? cursor.start.offset : files.at(-1)!.size;
    let skip = cursor?.start.skip;
    let entryBoundary = cursor?.start.entryOffset;
    if (index < 0) index = files.length - 1;
    endPosition = cursor?.start ?? positionFor(files, files.length - 1, files.at(-1)!.size);
    if (skip === "pending" && cursor) {
      offset = cursor.start.pendingStart ?? cursor.start.offset;
      skip = undefined;
    }
    const reversed: ActivityEntry[] = [];
    while (index >= 0 && reversed.length < limit && budget.remaining > 0) {
      const file = files[index];
      if (skip === "backward") {
        const result = scanBackwardSkip(file, offset, budget);
        progressed ||= result.offset !== offset;
        offset = result.offset;
        skip = undefined;
        entryBoundary = undefined;
        startPosition = positionFor(files, index, offset);
        if (!result.complete) {
          startPosition = positionFor(files, index, offset, "backward");
          break;
        }
      }
      if (offset <= 0 && !(entryBoundary !== undefined && entryBoundary > 0)) {
        index -= 1;
        if (index >= 0) {
          offset = files[index].size;
          skip = undefined;
          entryBoundary = undefined;
          continue;
        }
        break;
      }
      const record = entryBoundary !== undefined && entryBoundary > 0
        ? scanForward(file, offset, budget)
        : scanBackward(file, offset, budget);
      if (!record) break;
      progressed = true;
      const normalized = recordEntries(record, options.identity, file, sidecar, mode, legacyNormalizer);
      const boundary = entryBoundary === undefined ? normalized.length : Math.min(entryBoundary, normalized.length);
      const eligible = normalized.slice(0, boundary);
      const available = limit - reversed.length;
      const selected = eligible.slice(Math.max(0, eligible.length - available));
      if (record.eofPartial && !cursor) {
        endPosition = positionFor(files, index, record.start, "pending", normalized.length, record.start);
      }
      if (selected.length) {
        reversed.push(...selected.slice().reverse());
        const nextBoundary = eligible.length - selected.length;
        if (selected.length < eligible.length) {
          startPosition = positionFor(
            files,
            index,
            record.start,
            record.eofPartial ? "pending" : undefined,
            nextBoundary,
            record.eofPartial ? record.start : undefined,
          );
          offset = record.start;
          skip = record.eofPartial ? "pending" : undefined;
          entryBoundary = nextBoundary;
          break;
        }
      }
      if (record.partial) {
        startPosition = positionFor(files, index, record.start, "backward");
        offset = record.start;
        skip = "backward";
        entryBoundary = undefined;
        break;
      }
      startPosition = positionFor(files, index, record.start);
      offset = record.start;
      skip = undefined;
      entryBoundary = undefined;
    }
    entries.push(...reversed.reverse());
    if (!endPosition && cursor) endPosition = cursor.start;
  }

  if (!startPosition && cursor) startPosition = options.direction === "newer" ? cursor.end : cursor.start;
  if (!startPosition && endPosition) startPosition = endPosition;
  let nextCursor: string | undefined;
  const pending = startPosition?.skip === "pending" || endPosition?.skip === "pending";
  if (startPosition && endPosition && (entries.length > 0 || progressed || pending)) {
    nextCursor = encodeCursor({ version: 1, source, start: startPosition, end: endPosition });
  }
  return { entries, ...(nextCursor ? { cursor: nextCursor } : {}), reset, errors };
}

export function readActivityPage(options: ActivityPageOptions): ActivityPage {
  const mode = options.mode ?? "normalized";
  const log = resolve(options.log);
  const sidecarPath = mode === "normalized" ? resolve(options.sidecar ?? (options.log + ".activity.jsonl")) : undefined;
  const sidecarCandidates = sidecarPath ? [sidecarPath + ".2", sidecarPath + ".1", sidecarPath] : [];
  let sidecar = false;
  let files: FileRef[] = [];
  const errors: string[] = [];
  try {
    if (mode === "raw") {
      files = [fileIdentity(log)].filter((file): file is FileRef => Boolean(file));
    } else {
      const sidecarFiles = sidecarCandidates.map((path) => fileIdentity(path));
      sidecar = sidecarFiles.some(Boolean);
      files = sidecar
        ? sidecarFiles.filter((file): file is FileRef => Boolean(file))
        : [fileIdentity(log)].filter((file): file is FileRef => Boolean(file));
    }
  } catch (error) {
    return { entries: [], reset: Boolean(options.cursor), errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (!files.length) {
    return {
      entries: [],
      reset: Boolean(options.cursor),
      errors: ["Activity log not found: " + log],
    };
  }

  const source = digest(mode + "\0" + (sidecar ? "sidecar" : "log") + "\0" + log + "\0" +
    (sidecarPath ?? "") + "\0" + options.identity.attemptId + "\0" + options.identity.harness);
  let reset = false;
  let cursor: CursorState | undefined;
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    const findPosition = (position: Position): FileRef | undefined => files.find((file) => file.fileId === position.fileId);
    const startFile = decoded ? findPosition(decoded.start) : undefined;
    const endFile = decoded ? findPosition(decoded.end) : undefined;
    const valid = decoded && decoded.source === source && startFile && endFile &&
      decoded.start.offset <= startFile.size && decoded.end.offset <= endFile.size &&
      startFile.size >= decoded.start.size && endFile.size >= decoded.end.size &&
      startFile.signature.startsWith(decoded.start.signature) && endFile.signature.startsWith(decoded.end.signature);
    if (valid) cursor = decoded;
    else {
      reset = true;
      errors.push("Activity cursor was invalid or its source changed; restarted from the available log.");
    }
  }

  try {
    return buildPage(options, files, sidecar, source, cursor, reset, errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { entries: [], ...(cursor ? { cursor: options.cursor } : {}), reset, errors };
  }
}
