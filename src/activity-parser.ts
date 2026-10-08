import { Buffer } from "node:buffer";
import type { ActivityDecoder, ActivityEntry, ActivityIdentity } from "./activity-types.js";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TOOL_CORRELATIONS = 1000;
type ActivityStream = "stdout" | "stderr";
type ActivityKind = ActivityEntry["kind"];
type ToolSummary = { name: string; command: string };
type StreamState = { pending: Buffer; dropping: boolean; pendingObservedAt?: string };

export function sanitizeActivityText(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    }).filter(Boolean).join("\n");
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function outcomeFor(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.status === "string") return raw.status;
  if (typeof raw.subtype === "string") return raw.subtype;
  if (typeof raw.is_error === "boolean") return raw.is_error ? "error" : "success";
  if (typeof raw.exit_code === "number") return raw.exit_code === 0 ? "success" : "error";
  return undefined;
}

class ActivityNormalizer {
  private sequence = 0;
  private readonly tools = new Map<string, ToolSummary>();

  constructor(
    private readonly identity: ActivityIdentity,
    private readonly idPrefix = identity.attemptId,
  ) {}

  consume(line: string, stream: ActivityStream, observedAt?: string): ActivityEntry[] {
    const source = line.replace(/\r$/, "");
    if (!source.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      if (!/^[\s]*[\[{]/.test(source)) return [this.entry("raw", source, stream, observedAt)];
      const message = error instanceof Error ? error.message : "invalid JSON";
      return [this.entry("diagnostic", "Malformed activity record: " + message, stream, observedAt)];
    }
    if (!isRecord(value)) return [this.entry("raw", source, stream, observedAt)];
    const raw = value;
    const harness = this.identity.harness.toLowerCase();
    if (harness.includes("claude")) return this.consumeClaude(raw, source, stream, observedAt);
    return this.consumeCodex(raw, source, stream, observedAt);
  }

  private consumeCodex(
    raw: Record<string, unknown>,
    source: string,
    stream: ActivityStream,
    observedAt?: string,
  ): ActivityEntry[] {
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type.startsWith("turn.")) {
      const suffix = type.slice("turn.".length);
      const outcome = suffix === "started" ? "started" : suffix === "completed" ? "completed" :
        suffix === "failed" ? "failed" : suffix === "cancelled" ? "cancelled" : undefined;
      return [this.entry("turn", type, stream, observedAt, undefined, outcome)];
    }
    if (type === "error") {
      return [this.entry("diagnostic", textContent(raw.message) || source, stream, observedAt)];
    }
    if (type.startsWith("item.") || ["agent_message", "command_execution", "file_change"].includes(type)) {
      const item = isRecord(raw.item) ? raw.item : raw;
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType === "reasoning") return [];
      if (itemType === "agent_message") {
        const text = typeof item.text === "string" ? item.text :
          typeof item.message === "string" ? item.message : "";
        return text ? [this.entry("message", text, stream, observedAt)] : [];
      }
      if (itemType === "command_execution") {
        const command = typeof item.command === "string" ? item.command : "";
        if (!command) return [this.entry("raw", source, stream, observedAt)];
        return [this.entry("command", command, stream, observedAt, undefined, outcomeFor(item))];
      }
      if (itemType === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const summary = changes.map((change) => {
          if (!isRecord(change)) return textContent(change);
          const path = typeof change.path === "string" ? change.path : "";
          const action = typeof change.kind === "string" ? change.kind : "";
          return [action, path].filter(Boolean).join(": ") || JSON.stringify(change);
        }).filter(Boolean).join("\n");
        const text = summary || (typeof item.path === "string" ? item.path : "");
        return text ? [this.entry("file-change", text, stream, observedAt)] :
          [this.entry("raw", source, stream, observedAt)];
      }
      return [this.entry("raw", source, stream, observedAt)];
    }
    return [this.entry("raw", source, stream, observedAt)];
  }

  private consumeClaude(
    raw: Record<string, unknown>,
    source: string,
    stream: ActivityStream,
    observedAt?: string,
  ): ActivityEntry[] {
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type === "stream_event" || type.startsWith("content_block_")) return [];
    if (type === "result") {
      const text = typeof raw.result === "string" ? raw.result : "Claude turn result";
      return [this.entry("turn", text, stream, observedAt, undefined, outcomeFor(raw))];
    }
    if (type !== "assistant" && type !== "user") {
      return [this.entry("raw", source, stream, observedAt)];
    }
    const message = isRecord(raw.message) ? raw.message : undefined;
    if (!message) return [this.entry("raw", source, stream, observedAt)];
    const content = Array.isArray(message.content) ? message.content :
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    const entries: ActivityEntry[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text) entries.push(this.entry("message", block.text, stream, observedAt));
        continue;
      }
      if (block.type === "tool_use" && typeof block.id === "string" && block.id) {
        const name = typeof block.name === "string" && block.name ? block.name : "tool";
        const input = isRecord(block.input) ? block.input : {};
        const command = typeof input.command === "string" ? input.command :
          typeof input.file_path === "string" ? input.file_path :
          typeof input.path === "string" ? input.path : JSON.stringify(input);
        const summary = { name, command };
        this.tools.delete(block.id);
        this.tools.set(block.id, summary);
        if (this.tools.size > MAX_TOOL_CORRELATIONS) {
          const oldest = this.tools.keys().next().value as string | undefined;
          if (oldest !== undefined) this.tools.delete(oldest);
        }
        entries.push(this.entry("command", name + ": " + command, stream, observedAt, block.id));
        continue;
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && block.tool_use_id) {
        const summary = this.tools.get(block.tool_use_id);
        if (!summary) {
          entries.push(this.entry("diagnostic", "Claude tool result has no recent matching tool_use ID", stream, observedAt));
          continue;
        }
        this.tools.delete(block.tool_use_id);
        const result = textContent(block.content);
        const text = summary.name + " result: " + (result || summary.command);
        entries.push(this.entry("command", text, stream, observedAt, block.tool_use_id,
          block.is_error === true ? "error" : "success"));
      }
    }
    return entries;
  }

  entry(
    kind: ActivityKind,
    value: string,
    stream: ActivityStream,
    observedAt?: string,
    toolId?: string,
    outcome?: string,
  ): ActivityEntry {
    const entry: ActivityEntry = {
      version: 1,
      id: this.idPrefix + ":" + (++this.sequence).toString(36),
      identity: { ...this.identity },
      kind,
      stream,
      text: sanitizeActivityText(value),
    };
    if (observedAt !== undefined) entry.observedAt = observedAt;
    if (toolId !== undefined) entry.toolId = toolId;
    if (outcome !== undefined) entry.outcome = outcome;
    return entry;
  }
}

export function createActivityDecoder(identity: ActivityIdentity): ActivityDecoder {
  const normalizer = new ActivityNormalizer(identity);
  const streams: Record<ActivityStream, StreamState> = {
    stdout: { pending: Buffer.alloc(0), dropping: false },
    stderr: { pending: Buffer.alloc(0), dropping: false },
  };
  let ended = false;

  const processRecord = (bytes: Buffer, stream: ActivityStream, observedAt?: string): ActivityEntry[] => {
    const line = bytes.length && bytes[bytes.length - 1] === 0x0d
      ? bytes.subarray(0, bytes.length - 1)
      : bytes;
    return normalizer.consume(line.toString("utf8"), stream, observedAt);
  };

  const feed = (chunk: Uint8Array, stream: ActivityStream, observedAt?: string): ActivityEntry[] => {
    if (ended) return [];
    const state = streams[stream];
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const entries: ActivityEntry[] = [];
    let offset = 0;
    while (offset < input.length) {
      if (state.dropping) {
        const newline = input.indexOf(0x0a, offset);
        if (newline < 0) return entries;
        state.dropping = false;
        offset = newline + 1;
        continue;
      }
      const newline = input.indexOf(0x0a, offset);
      const end = newline < 0 ? input.length : newline;
      const part = input.subarray(offset, end);
      if (state.pending.length + part.length > MAX_RECORD_BYTES) {
        entries.push(normalizer.entry(
          "diagnostic",
          "Oversized activity record exceeded the 64 KiB limit; discarded through its next newline",
          stream,
          observedAt ?? state.pendingObservedAt,
        ));
        state.pending = Buffer.alloc(0);
        state.pendingObservedAt = undefined;
        if (newline < 0) {
          state.dropping = true;
          return entries;
        }
        offset = newline + 1;
        continue;
      }
      if (newline < 0) {
        if (state.pending.length === 0) {
          state.pendingObservedAt = observedAt;
        }
        state.pending = part.length
          ? state.pending.length ? Buffer.concat([state.pending, part]) : Buffer.from(part)
          : state.pending;
        return entries;
      }
      const line = state.pending.length ? Buffer.concat([state.pending, part]) : Buffer.from(part);
      const recordObservedAt = observedAt ?? state.pendingObservedAt;
      state.pending = Buffer.alloc(0);
      state.pendingObservedAt = undefined;
      entries.push(...processRecord(line, stream, recordObservedAt));
      offset = newline + 1;
    }
    return entries;
  };

  const end = (): ActivityEntry[] => {
    if (ended) return [];
    ended = true;
    const entries: ActivityEntry[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const state = streams[stream];
      if (state.pending.length && !state.dropping) {
        entries.push(...processRecord(state.pending, stream, state.pendingObservedAt));
      }
      state.pending = Buffer.alloc(0);
      state.pendingObservedAt = undefined;
      state.dropping = false;
    }
    return entries;
  };

  return { feed, end };
}

export function normalizeActivityRecord(
  line: string,
  identity: ActivityIdentity,
  stream: ActivityStream,
  idPrefix: string,
): ActivityEntry[] {
  return new ActivityNormalizer(identity, idPrefix).consume(line, stream);
}
