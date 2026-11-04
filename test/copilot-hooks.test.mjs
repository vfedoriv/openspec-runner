import { test } from "node:test";
import assert from "node:assert/strict";
const hooks = await import("../dist/harnesses/copilot-hooks.js").catch(() => ({}));
const lease = () => ({ version: 1, attempt: "attempt", harness: "copilot-vscode", worktree: process.cwd(), generation: "generation", nonce: "nonce", armedAt: "2026-10-29T00:00:00.000Z" });
const prompt = () => ({ kind: "prompt", session: "session", cwd: process.cwd(), at: "2026-10-29T00:00:01.000Z", prompt: "[openspec-runner:attempt:nonce]" });
test("Copilot and editor payloads normalize to the same observed session", () => {
  assert.equal(typeof hooks.normalizeHook, "function");
  const a = hooks.normalizeHook("userPromptSubmitted", { sessionId: "session", timestamp: 1793232001000, cwd: process.cwd(), prompt: "hello" });
  const b = hooks.normalizeHook("UserPromptSubmit", { session_id: "session", timestamp: "2026-10-29T00:00:01.000Z", cwd: process.cwd(), prompt: "hello" });
  assert.deepEqual(a, b);
  assert.throws(() => hooks.normalizeHook("Stop", { session_id: "bad\n" }), /hook|session|payload/i);
});
test("only a matching root prompt nonce binds ownership and stop cannot precede reporting", () => {
  assert.equal(typeof hooks.transitionHook, "function");
  for (const bad of [{ ...prompt(), prompt: "wrong" }, { ...prompt(), subagent: true }, { ...prompt(), at: "2020-01-01" }, { ...prompt(), cwd: "wrong" }]) {
    assert.throws(() => hooks.transitionHook(lease(), bad), /identity|nonce|root|worktree|stale/i);
  }
  const bound = hooks.transitionHook(lease(), prompt());
  assert.equal(bound.session, "session");
  assert.throws(() => hooks.transitionHook(bound, { ...prompt(), kind: "stop", at: "2026-10-29T00:00:00.500Z" }), /stale|order/i);
  assert.throws(() => hooks.transitionHook({ ...bound, reportAt: "2026-10-29T00:00:02.000Z" }, { ...prompt(), kind: "stop" }), /stale|report|order/i);
  assert.throws(() => hooks.transitionHook(bound, { ...prompt(), kind: "tool", session: "other", subagent: true }), /session/i);
  assert.throws(() => hooks.transitionHook(bound, { ...prompt(), session: "other" }), /session/i);
  const stopped = hooks.transitionHook(bound, { ...prompt(), kind: "stop" });
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(hooks.transitionHook(stopped, { ...prompt(), kind: "stop" }), stopped);
  assert.throws(() => hooks.transitionHook(stopped, prompt()), /terminal/i);
  assert.throws(() => hooks.transitionHook(stopped, { ...prompt(), kind: "tool", subagent: true }), /terminal/i);
  const failed = hooks.transitionHook(bound, { ...prompt(), kind: "error", recoverable: false });
  assert.ok(hooks.transitionHook(failed, { ...prompt(), kind: "stop" }).error);
  assert.equal(hooks.transitionHook(bound, { ...prompt(), kind: "error", recoverable: true }).error, undefined);
});
