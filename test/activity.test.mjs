import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
  assert.equal(boundedEntries.at(-1).kind, "command");
  assert.equal(boundedEntries.at(-1).toolId, "tool-0");
  assert.match(boundedEntries.at(-1).text, /Claude tool result/);
  assert.doesNotMatch(boundedEntries.at(-1).text, /Bash result/, "correlation forgets IDs older than the latest 1,000");
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

test("activity older pages preserve multi-block records spanning several read blocks", (t) => {
  const dir = fixture(t);
  const log = join(dir, "long-older.log");
  const text = "first-" + "x".repeat(9000) + "middle-" + "y".repeat(9000) + "last-" + "z".repeat(3000);
  writeFileSync(log, JSON.stringify({ type: "agent_message", text: "older prefix" }) + "\n" +
    JSON.stringify({ type: "agent_message", text }) + "\n", "utf8");

  const page = readActivityPage({ log, identity, direction: "older", limit: 2 });
  assert.equal(page.entries.at(-1).text, text);
});

test("activity pages revisit partial JSON and UTF-8 records after append", (t) => {
  const dir = fixture(t);
  const log = join(dir, "partial-json.log");
  const sidecar = log + ".activity.jsonl";
  const full = Buffer.from(JSON.stringify(sidecarEntry("partial-json", "joined ✓")) + "\n");
  const unicode = full.indexOf(Buffer.from("✓"));
  const split = unicode + 1;
  writeFileSync(log, "", "utf8");
  writeFileSync(sidecar, full.subarray(0, split));

  const pending = readActivityPage({ log, sidecar, identity, direction: "newer" });
  assert.deepEqual(pending.entries, [], "an incomplete JSON row must not become a malformed-entry diagnostic");
  assert.ok(pending.cursor, "the cursor must retain the incomplete row boundary");
  writeFileSync(sidecar, full.subarray(split), { flag: "a" });
  const completed = readActivityPage({ log, sidecar, identity, direction: "newer", cursor: pending.cursor });
  assert.deepEqual(completed.entries.map((entry) => [entry.id, entry.text]), [["partial-json", "joined ✓"]]);
});

test("activity pages revisit partial legacy text after append without splitting it", (t) => {
  const dir = fixture(t);
  const log = join(dir, "partial-legacy.log");
  writeFileSync(log, "partial ", "utf8");
  const pending = readActivityPage({ log, identity, direction: "newer" });
  assert.deepEqual(pending.entries.map((entry) => entry.text), ["partial "], "legacy EOF text may be observed provisionally");
  assert.ok(pending.cursor);
  const pendingId = pending.entries[0].id;
  writeFileSync(log, "line\n", { flag: "a" });
  const completed = readActivityPage({ log, identity, direction: "newer", cursor: pending.cursor });
  assert.deepEqual(completed.entries.map((entry) => entry.text), ["partial line"]);
  assert.equal(completed.entries[0].id, pendingId, "completion revisits the same stable record identity");
});

test("activity pagination continues within multi-entry records in both directions", (t) => {
  const dir = fixture(t);
  const log = join(dir, "multi-entry.log");
  const claudeIdentity = { attemptId: "claude-pages", harness: "claude" };
  writeFileSync(log, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "first block" }, { type: "text", text: "second block" }] },
  }) + "\n", "utf8");

  const newerFirst = readActivityPage({ log, identity: claudeIdentity, direction: "newer", limit: 1 });
  const newerSecond = readActivityPage({ log, identity: claudeIdentity, direction: "newer", cursor: newerFirst.cursor, limit: 1 });
  assert.deepEqual([...newerFirst.entries, ...newerSecond.entries].map((entry) => entry.text), ["first block", "second block"]);
  assert.notEqual(newerFirst.entries[0].id, newerSecond.entries[0].id);

  const olderFirst = readActivityPage({ log, identity: claudeIdentity, direction: "older", limit: 1 });
  const olderSecond = readActivityPage({ log, identity: claudeIdentity, direction: "older", cursor: olderFirst.cursor, limit: 1 });
  assert.deepEqual([...olderFirst.entries, ...olderSecond.entries].map((entry) => entry.text), ["second block", "first block"]);
  assert.notEqual(olderFirst.entries[0].id, olderSecond.entries[0].id);
});

test("activity rejects sidecar entries belonging to a different attempt", (t) => {
  const dir = fixture(t);
  const log = join(dir, "identity.log");
  const sidecar = log + ".activity.jsonl";
  writeFileSync(log, "", "utf8");
  writeFileSync(sidecar, JSON.stringify(sidecarEntry("wrong-attempt", "must not appear", {
    attemptId: "attempt-1", harness: "claude",
  })) + "\n", "utf8");

  const page = readActivityPage({
    log, sidecar, identity: { attemptId: "attempt-2", harness: "codex" }, direction: "newer",
  });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].kind, "diagnostic");
  assert.deepEqual(page.entries[0].identity, { attemptId: "attempt-2", harness: "codex" });
  assert.doesNotMatch(page.entries[0].text, /must not appear/);
});

test("activity legacy pages correlate Claude tool records and expose standalone results", (t) => {
  const dir = fixture(t);
  const log = join(dir, "claude-legacy.log");
  const claudeIdentity = { attemptId: "claude-legacy", harness: "claude" };
  const records = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "legacy-tool", name: "Bash", input: { command: "pwd" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "legacy-tool", content: "/repo", is_error: false }] } },
  ];
  writeFileSync(log, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  const page = readActivityPage({ log, identity: claudeIdentity, direction: "newer" });
  const correlated = page.entries.find((entry) => entry.toolId === "legacy-tool" && entry.text.includes("result"));
  assert.ok(correlated);
  assert.match(correlated.text, /Bash result: \/repo/);

  const standalone = join(dir, "claude-result-only.log");
  writeFileSync(standalone, JSON.stringify(records[1]) + "\n", "utf8");
  const older = readActivityPage({ log: standalone, identity: claudeIdentity, direction: "older" });
  assert.ok(older.entries.some((entry) => entry.kind === "command" && entry.toolId === "legacy-tool" && entry.text.includes("/repo")));
});

test("activity retains unknown Claude blocks as raw observations", () => {
  const decoder = decoderFor({ attemptId: "claude-unknown", harness: "claude" });
  const entries = decoder.feed(Buffer.from(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "future_image", source: "opaque payload" }] },
  }) + "\n"), "stdout");
  assert.ok(entries.some((entry) => entry.kind === "raw" && entry.text.includes("future_image")));
});

test("activity counts production reads against the byte and entry page limits", (t) => {
  const dir = fixture(t);
  const log = join(dir, "read-budget.log");
  const sidecar = log + ".activity.jsonl";
  writeFileSync(log, "", "utf8");
  const rows = Array.from({ length: 250 }, (_, index) => JSON.stringify(sidecarEntry("budget-" + index, "x".repeat(1500))));
  writeFileSync(sidecar, rows.join("\n") + "\n", "utf8");

  const original = fs.readSync;
  let bytesRead = 0;
  const mock = t.mock.method(fs, "readSync", (...args) => {
    const count = original(...args);
    bytesRead += count;
    return count;
  });
  syncBuiltinESMExports();
  let page;
  try {
    page = readActivityPage({ log, sidecar, identity, direction: "newer", limit: 500 });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(page.entries.length > 0 && page.entries.length <= 200);
  assert.ok(bytesRead <= 256 * 1024, `production reads used ${bytesRead} bytes`);
});

test("activity raw mode reads the supplied log and binds cursors to mode", (t) => {
  const dir = fixture(t);
  const log = join(dir, "raw-mode.log");
  const sidecar = log + ".activity.jsonl";
  const source = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "normalized" } });
  writeFileSync(log, source + "\n", "utf8");
  writeFileSync(sidecar, JSON.stringify(sidecarEntry("sidecar-id", "sidecar text")) + "\n", "utf8");
  const selected = { attemptId: "true-attempt", harness: "custom-harness" };

  const raw = readActivityPage({ log, sidecar, identity: selected, direction: "newer", mode: "raw" });
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].kind, "raw");
  assert.equal(raw.entries[0].text, source);
  assert.deepEqual(raw.entries[0].identity, selected);
  assert.equal(raw.entries[0].observedAt, undefined);
  assert.notEqual(raw.entries[0].id, "sidecar-id");
  const normalized = readActivityPage({ log, sidecar, identity: selected, direction: "newer", cursor: raw.cursor });
  assert.equal(normalized.reset, true, "a cursor from raw mode cannot be reused in normalized mode");
});

test("activity older pending sidecar cursor resumes its record start in newer mode", (t) => {
  const dir = fixture(t);
  const log = join(dir, "older-pending.log");
  const sidecar = log + ".activity.jsonl";
  const full = Buffer.from(JSON.stringify(sidecarEntry("older-pending", "continued ✓")) + "\n");
  const split = full.indexOf(Buffer.from("✓")) + 1;
  writeFileSync(log, "", "utf8");
  writeFileSync(sidecar, full.subarray(0, split));

  const older = readActivityPage({ log, sidecar, identity, direction: "older" });
  assert.deepEqual(older.entries, []);
  assert.ok(older.cursor);
  writeFileSync(sidecar, full.subarray(split), { flag: "a" });
  const newer = readActivityPage({ log, sidecar, identity, direction: "newer", cursor: older.cursor });
  assert.deepEqual(newer.entries.map((entry) => [entry.id, entry.text, entry.kind]), [
    ["older-pending", "continued ✓", "message"],
  ]);
});

test("activity cursors switch directions at complementary multi-entry boundaries", (t) => {
  const dir = fixture(t);
  const log = join(dir, "direction-switch.log");
  const claudeIdentity = { attemptId: "claude-switch", harness: "claude" };
  writeFileSync(log, JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "first block" }, { type: "text", text: "second block" }] },
  }) + "\n", "utf8");

  const newerFirst = readActivityPage({ log, identity: claudeIdentity, direction: "newer", limit: 1 });
  const newerSecond = readActivityPage({ log, identity: claudeIdentity, direction: "newer", cursor: newerFirst.cursor, limit: 1 });
  const newerPair = [...newerFirst.entries, ...newerSecond.entries];
  assert.deepEqual(newerPair.map((entry) => entry.text), ["first block", "second block"]);
  assert.equal(new Set(newerPair.map((entry) => entry.id)).size, 2);
  const olderFromNewerSecond = readActivityPage({
    log, identity: claudeIdentity, direction: "older", cursor: newerSecond.cursor, limit: 1,
  });
  assert.deepEqual(olderFromNewerSecond.entries.map((entry) => entry.text), ["first block"]);
  assert.equal(olderFromNewerSecond.entries[0].id, newerFirst.entries[0].id);

  const olderFirst = readActivityPage({ log, identity: claudeIdentity, direction: "older", limit: 1 });
  const olderSecond = readActivityPage({ log, identity: claudeIdentity, direction: "older", cursor: olderFirst.cursor, limit: 1 });
  const olderPair = [...olderFirst.entries, ...olderSecond.entries];
  assert.deepEqual(olderPair.map((entry) => entry.text), ["second block", "first block"]);
  assert.equal(new Set(olderPair.map((entry) => entry.id)).size, 2);
  const newerFromOlderSecond = readActivityPage({
    log, identity: claudeIdentity, direction: "newer", cursor: olderSecond.cursor, limit: 1,
  });
  assert.deepEqual(newerFromOlderSecond.entries.map((entry) => entry.text), ["second block"]);
  assert.equal(newerFromOlderSecond.entries[0].id, olderFirst.entries[0].id);
});
