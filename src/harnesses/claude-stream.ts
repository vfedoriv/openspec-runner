import { TextDecoder } from "node:util";
import type { SessionEvidence } from "./types.js";

export interface ClaudeStreamEvent extends SessionEvidence {
  type: string;
  raw: Record<string, unknown>;
}

/**
 * Incremental decoder for Claude Code's newline-delimited stream-json output.
 * It deliberately retains only the current line and normalized terminal
 * evidence; callers own the log when they need the complete diagnostic trail.
 */
export class ClaudeStreamDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private expected?: string;
  private sawTerminal = false;
  private ended = false;
  private readonly maxLineBytes: number;
  constructor(
    private readonly onEvent?: (event: ClaudeStreamEvent) => void,
    maxLineBytes = 1024 * 1024,
  ) {
    this.maxLineBytes = maxLineBytes;
  }

  feed(chunk: string | Uint8Array): void {
    if (this.ended) throw new Error("Claude stream received data after close");
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.drain(false);
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes)
      throw new Error("Claude stream line exceeds the safety limit");
  }

  end(): void {
    if (this.ended) return;
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.ended = true;
    if (!this.sawTerminal)
      throw new Error("Claude stream ended without a terminal result event");
  }

  get sessionId(): string | undefined {
    return this.expected;
  }

  get terminal(): boolean {
    return this.sawTerminal;
  }

  private drain(final: boolean): void {
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes)
        throw new Error("Claude stream line exceeds the safety limit");
      if (line.trim()) this.parseLine(line);
    }
    if (final && this.buffer.trim()) {
      const line = this.buffer;
      this.buffer = "";
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes)
        throw new Error("Claude stream line exceeds the safety limit");
      this.parseLine(line);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes)
      throw new Error("Claude stream line exceeds the safety limit");
  }

  private parseLine(line: string): void {
    let raw: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event is not an object");
      raw = value as Record<string, unknown>;
    } catch (error: any) {
      throw new Error(`Malformed Claude stream event: ${error.message}`);
    }
    const type = raw.type;
    if (typeof type !== "string" || !type) throw new Error("Claude stream event has no type");
    const requiredIdentity = type === "system" || type === "result";
    const sessionId = raw.session_id;
    if (requiredIdentity && (typeof sessionId !== "string" || !sessionId))
      throw new Error(`Claude ${type} event has no session_id`);
    if (sessionId !== undefined && typeof sessionId !== "string")
      throw new Error("Claude stream session_id must be a string");
    if (typeof sessionId === "string") {
      if (this.expected && this.expected !== sessionId)
        throw new Error(`Claude stream session mismatch: expected ${this.expected}, received ${sessionId}`);
      this.expected ??= sessionId;
    }
    if (type === "result") {
      if (this.sawTerminal) throw new Error("Claude stream emitted duplicate terminal result");
      this.sawTerminal = true;
    }
    this.onEvent?.({
      type,
      raw,
      ...(this.expected ? { sessionId: this.expected } : {}),
      ...(type === "result" ? { terminal: true, subtype: typeof raw.subtype === "string" ? raw.subtype : undefined } : {}),
    });
  }
}

export function decodeClaudeStream(text: string): ClaudeStreamEvent[] {
  const events: ClaudeStreamEvent[] = [];
  const decoder = new ClaudeStreamDecoder((event) => events.push(event));
  decoder.feed(text);
  decoder.end();
  return events;
}
