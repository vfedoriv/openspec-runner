import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, readFileSync, truncateSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parser = await import("../dist/activity-parser.js").catch(() => ({}));
const reader = await import("../dist/activity-reader.js").catch(() => ({}));
const createActivityDecoder = parser.createActivityDecoder;
const readActivityPage = reader.readActivityPage;
const identity = { attemptId: "attempt-1", harness: "codex" };

function decoderFor(value = identity) {
  assert.equal(typeof createActivityDecoder, "function", "activity decoder must normalize observed harness records");
  return createActivityDecoder(value);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "activity-pages-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sidecarEntry(id, text, value = identity) {
  return { version: 1, id, identity: value, kind: "message", stream: "stdout", text };
}

test("activity normalizes codex messages commands changes turn outcomes", () => {
  const decoder = decoderFor();
  const events = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started", turn_id: "turn-1" },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "Hello ✓" } },
    { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "git status", status: "completed" } },
    { type: "item.completed", item: { id: "change-1", type: "file_change", changes: [{ path: "src/a.ts", kind: "add" }] } },
    { type: "turn.completed", turn_id: "turn-1" },
    { type: "future.event", payload: "retain this record" },
  ];
  const stdout = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n{broken json\n");
  const unicodeByte = stdout.indexOf(Buffer.from("✓")) + 1;
  const entries = [];
  entries.push(...decoder.feed(stdout.subarray(0, unicodeByte), "stdout", "2026-10-08T12:00:00.000Z"));
  const stderr = Buffer.from(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "stderr note" },
  }) + "\n");
  entries.push(...decoder.feed(stderr, "stderr", "2026-10-08T12:00:00.000Z"));
  entries.push(...decoder.feed(stdout.subarray(unicodeByte), "stdout", "2026-10-08T12:00:00.000Z"));
  entries.push(...decoder.end());

  const message = entries.find((entry) => entry.text === "Hello ✓");
  assert.equal(message.kind, "message");
  assert.deepEqual(message.identity, identity);
  assert.equal(message.observedAt, "2026-10-08T12:00:00.000Z");
  const command = entries.find((entry) => entry.text.includes("git status"));
  assert.equal(command.kind, "command");
  assert.equal(command.outcome, "completed");
  const change = entries.find((entry) => entry.text.includes("src/a.ts"));
  assert.equal(change.kind, "file-change");
  const turn = entries.find((entry) => entry.kind === "turn" && entry.text.includes("turn.completed"));
  assert.equal(turn.outcome, "completed");
  assert.ok(entries.some((entry) => entry.text === "stderr note" && entry.stream === "stderr"));
  assert.ok(entries.some((entry) => entry.text.includes("future.event") && ["raw", "diagnostic"].includes(entry.kind)));
  assert.ok(entries.some((entry) => entry.kind === "diagnostic" && /malformed/i.test(entry.text)));
  assert.equal(turn.kind, "turn", "a harness turn is activity evidence, not runner lifecycle state");
});

test("activity correlates complete claude tool blocks", () => {
  const claudeIdentity = { attemptId: "claude-attempt", harness: "claude" };
  const decoder = decoderFor(claudeIdentity);
  const records = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Checking the repository." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
      session_id: "session-from-log",
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "token-level secret" } },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "/repo", is_error: false }],
      },
    },
    { type: "result", subtype: "success", result: "finished", session_id: "session-from-log" },
  ];
  const entries = decoder.feed(Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n"), "stdout");
  entries.push(...decoder.end());

  assert.ok(entries.some((entry) => entry.kind === "message" && entry.text === "Checking the repository."));
  const toolEntries = entries.filter((entry) => entry.toolId === "tool-1");
  assert.equal(toolEntries.length, 2);
  assert.ok(toolEntries.every((entry) => entry.kind === "command"));
  assert.match(toolEntries[0].text, /Bash.*pwd/);
  assert.match(toolEntries[1].text, /\/repo/);
  assert.equal(toolEntries[1].outcome, "success");
  assert.ok(entries.some((entry) => entry.kind === "turn" && entry.outcome === "success"));
  assert.equal(entries.some((entry) => entry.text.includes("token-level secret")), false);
  assert.ok(entries.every((entry) => entry.identity.attemptId === "claude-attempt"));

  const bounded = decoderFor(claudeIdentity);
  const calls = [];
  for (let index = 0; index < 1001; index += 1) {
    calls.push(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-" + index, name: "Bash", input: { command: "echo" } }] },
    }));
  }
  calls.push(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-0", content: "old result" }] },
  }));
  const boundedEntries = bounded.feed(Buffer.from(calls.join("\n") + "\n"), "stdout");
  assert.ok(["diagnostic", "raw"].includes(boundedEntries.at(-1).kind));
  assert.equal(boundedEntries.at(-1).toolId, undefined, "correlation forgets IDs older than the latest 1,000");
});

test("activity bounds partial unicode oversized and control records", () => {
  const decoder = decoderFor();
  const source = Buffer.from(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Café ✓" },
  }) + "\n");
  const split = source.indexOf(Buffer.from("✓")) + 1;
  assert.deepEqual(decoder.feed(source.subarray(0, split), "stdout"), []);

  const controls = Buffer.from(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "\u001b[31mreadable\u001b[0m\u001b]0;title\u0007" },
  }) + "\n");
  const interleaved = decoder.feed(controls, "stderr");
  assert.equal(interleaved.length, 1);
  assert.equal(interleaved[0].text, "readable");
  assert.equal(interleaved[0].stream, "stderr");

  const resumed = decoder.feed(source.subarray(split), "stdout");
  assert.equal(resumed[0].text, "Café ✓");
  const oversized = Buffer.from(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "x".repeat(65 * 1024) },
  }) + "\n" + JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "after oversize" },
  }) + "\n");
  const afterOversize = decoder.feed(oversized, "stdout");
  assert.ok(afterOversize.some((entry) => entry.kind === "diagnostic" && /oversiz|64\s*kb|limit/i.test(entry.text)));
  assert.ok(afterOversize.some((entry) => entry.text === "after oversize"));
  assert.equal(afterOversize.some((entry) => entry.text.includes("x".repeat(100))), false);

  const finalLine = Buffer.from(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "unterminated final record" },
  }));
  assert.deepEqual(decoder.feed(finalLine, "stdout"), []);
  const ended = decoder.end();
  assert.ok(ended.some((entry) => entry.text === "unterminated final record"));
});

test("activity pages legacy logs and resets", (t) => {
  assert.equal(typeof readActivityPage, "function", "activity reader must provide bounded direction-aware pages");
  const dir = fixture(t);
  const log = join(dir, "worker.log");
  writeFileSync(log, "zero\none\ntwo\nthree\nfour\nfive", "utf8");

  const first = readActivityPage({ log, identity, direction: "newer", limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.text), ["zero", "one"]);
  assert.ok(first.entries.every((entry) => entry.observedAt === undefined));
  const repeated = readActivityPage({ log, identity, direction: "newer", limit: 2 });
  assert.deepEqual(repeated.entries.map((entry) => entry.id), first.entries.map((entry) => entry.id));
  const second = readActivityPage({ log, identity, direction: "newer", cursor: first.cursor, limit: 2 });
  const third = readActivityPage({ log, identity, direction: "newer", cursor: second.cursor, limit: 2 });
  assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.text), [
    "zero", "one", "two", "three", "four", "five",
  ]);
  assert.equal(new Set([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.id)).size, 6);

  const older = readActivityPage({ log, identity, direction: "older", limit: 2 });
  assert.deepEqual(older.entries.map((entry) => entry.text), ["four", "five"]);
  const olderAgain = readActivityPage({ log, identity, direction: "older", cursor: older.cursor, limit: 2 });
  assert.deepEqual(olderAgain.entries.map((entry) => entry.text), ["two", "three"]);

  const missing = readActivityPage({ log: join(dir, "missing.log"), identity, direction: "newer" });
  assert.deepEqual(missing.entries, []);
  assert.ok(missing.errors.length > 0);

  const cursor = first.cursor;
  truncateSync(log, 0);
  writeFileSync(log, "replacement\n", "utf8");
  const reset = readActivityPage({ log, identity, direction: "newer", cursor, limit: 2 });
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.entries.map((entry) => entry.text), ["replacement"]);

  const sidecarLog = join(dir, "sidecar-worker.log");
  const sidecar = sidecarLog + ".activity.jsonl";
  writeFileSync(sidecarLog, "ignored legacy bytes\n", "utf8");
  const current = [sidecarEntry("current-0", "current 0"), sidecarEntry("current-1", "current 1")];
  const rotation1 = [sidecarEntry("rotation1-0", "rotation 1 0"), sidecarEntry("rotation1-1", "rotation 1 1")];
  const rotation2 = [sidecarEntry("rotation2-0", "rotation 2 0"), sidecarEntry("rotation2-1", "rotation 2 1")];
  writeFileSync(sidecar, current.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  writeFileSync(sidecar + ".1", rotation1.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  writeFileSync(sidecar + ".2", rotation2.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

  const newest = readActivityPage({ log: sidecarLog, sidecar, identity, direction: "older", limit: 2 });
  assert.deepEqual(newest.entries.map((entry) => entry.id), ["current-0", "current-1"]);
  const middle = readActivityPage({ log: sidecarLog, sidecar, identity, direction: "older", cursor: newest.cursor, limit: 2 });
  assert.deepEqual(middle.entries.map((entry) => entry.id), ["rotation1-0", "rotation1-1"]);
  const oldest = readActivityPage({ log: sidecarLog, sidecar, identity, direction: "older", cursor: middle.cursor, limit: 2 });
  assert.deepEqual(oldest.entries.map((entry) => entry.id), ["rotation2-0", "rotation2-1"]);
  assert.equal(readFileSync(sidecarLog, "utf8"), "ignored legacy bytes\n");

  const largeLog = join(dir, "large.log");
  const largeSidecar = largeLog + ".activity.jsonl";
  writeFileSync(largeLog, "", "utf8");
  const expectedIds = [];
  const lines = [];
  for (let index = 0; index < 250; index += 1) {
    const id = "large-" + index;
    expectedIds.push(id);
    lines.push(JSON.stringify(sidecarEntry(id, "x".repeat(1500))));
  }
  writeFileSync(largeSidecar, lines.join("\n") + "\n", "utf8");
  const pages = [];
  let page = readActivityPage({ log: largeLog, identity, direction: "newer", limit: 500 });
  pages.push(...page.entries);
  assert.ok(page.entries.length > 0 && page.entries.length < 200, "a page obeys both the 200-entry and 256 KiB read caps");
  let iterations = 0;
  while (page.cursor && iterations < 10) {
    page = readActivityPage({ log: largeLog, identity, direction: "newer", cursor: page.cursor, limit: 500 });
    pages.push(...page.entries);
    iterations += 1;
    if (page.entries.length === 0) break;
  }
  assert.deepEqual(pages.map((entry) => entry.id), expectedIds);
  assert.equal(new Set(pages.map((entry) => entry.id)).size, expectedIds.length);

  const otherLog = join(dir, "other.log");
  writeFileSync(otherLog, "other\n", "utf8");
  const reused = readActivityPage({ log: otherLog, identity, direction: "newer", cursor: first.cursor });
  assert.equal(reused.reset, true, "a cursor is tied to the supplied source and cannot redirect file reads");
  assert.deepEqual(reused.entries.map((entry) => entry.text), ["other"]);
});
