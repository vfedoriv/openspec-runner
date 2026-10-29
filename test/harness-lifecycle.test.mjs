import { test } from "node:test";
import assert from "node:assert/strict";

const lifecycle = await import("../dist/harnesses/lifecycle.js").catch(() => ({}));
const fixture = (agent) => ({ agent, session: "session-1", observedSession: "session-1", identityConfirmed: true,
  report: { outcome: "completed" }, worker: { exitedAt: "now", exitCode: 0 },
  terminalEvidence: { type: "result", subtype: "success" } });

test("uncertain termination blocks completion and cleanup for every harness", async () => {
  const { inspectCleanup } = await import("../dist/cleanup.js");
  for (const agent of ["codex", "claude", "copilot", "copilot-vscode"]) {
    const attempt = fixture(agent);
    attempt.worker.terminationUncertain = true;
    attempt.id = "test"; attempt.task = "1.1"; attempt.path = "/uninspected";
    assert.match(lifecycle.completionProblem(attempt), /termination.*uncertain/i);
    const result = inspectCleanup({ common: "/missing-common" }, {}, attempt);
    assert.equal(result.status, "skipped");
    assert.match(result.reasons[0], /active|uncertain/i);
  }
});

test("legacy Codex and Claude completion preserves process and stream requirements", () => {
  assert.equal(typeof lifecycle.completionProblem, "function");
  assert.equal(lifecycle.completionProblem(fixture("codex")), undefined);
  assert.equal(lifecycle.completionProblem({ ...fixture("codex"), worker: { exitedAt: "now" } }), undefined);
  assert.equal(lifecycle.agentMayBeActive({ ...fixture("copilot"), worker: { exitedAt: "now", launcher: { pid: 123 } } }), true);
  assert.equal(lifecycle.completionProblem(fixture("claude")), undefined);
  assert.match(lifecycle.completionProblem({ ...fixture("claude"), identityConfirmed: false }), /identity|stream/i);
  assert.match(lifecycle.completionProblem({ ...fixture("claude"), terminalEvidence: { metadata: { is_error: true } } }), /failed|error/i);
});

test("editor completion needs observed root stop and accepted report, never launcher exit alone", () => {
  assert.equal(typeof lifecycle.completionProblem, "function");
  const a = fixture("copilot-vscode");
  assert.ok(lifecycle.completionProblem(a));
  a.worker.completion = { source: "agent-stop", at: "now", session: "session-1" };
  a.terminalEvidence = { type: "agent-stop" };
  assert.equal(lifecycle.completionProblem(a), undefined);
  assert.ok(lifecycle.completionProblem({ ...a, report: undefined }));
  assert.ok(lifecycle.completionProblem({ ...a, observedSession: "wrong" }));
  assert.ok(lifecycle.completionProblem({ ...a, worker: { ...a.worker, completion: { ...a.worker.completion, source: "process-exit" } } }));
  assert.equal(lifecycle.agentMayBeActive({ ...a, terminalEvidence: undefined }), true);
});
