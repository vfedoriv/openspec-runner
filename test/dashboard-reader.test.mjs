import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { repository } from "../dist/system.js";
import { loadPlan } from "../dist/plan.js";
import { processStart } from "../dist/processes.js";
const reader = await import("../dist/dashboard-reader.js").catch(() => ({}));
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/runner.yaml"), "version: 1\n");
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 First\n- [ ] 1.2 Second\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), JSON.stringify({ version: 1, tasks: { "1.1": {}, "1.2": { dependsOn: ["1.1"] } } }));
  const repo = repository(root);
  mkdirSync(repo.stateDir, { recursive: true });
  return { root, repo };
}
function state(root, attempts = [], version = 1) {
  return { version, change: "demo", fingerprint: loadPlan(root, "demo").fingerprint, integration: { path: root, branch: "main", base: "base" }, head: "head", baseline: [], attempts, ...(version === 2 ? { batches: attempts.map(a => ({ id: `batch-${a.id}`, harness: "codex", attempts: [a.id] })) } : {}) };
}
function attempt(root, id, phase = "running") {
  return { id, task: "1.1", description: "First", fingerprint: "fingerprint", settings: { model: "a", reasoningEffort: "high" }, parallel: false, phase, terminal: {}, path: root, branch: id, base: "base", worker: { token: id, log: join(root, `${id}.log`), pid: process.pid, processStart: "reused-pid" } };
}
function collect(root) { assert.equal(typeof reader.collectDashboard, "function", "snapshot reader must exist"); return reader.collectDashboard({ cwd: root }); }
test("reader discovers prelaunch and retained features", t => {
  const { root, repo } = fixture(t);
  mkdirSync(join(repo.stateDir, "features"));
  writeFileSync(join(repo.stateDir, "features/archived.json"), JSON.stringify({ version: 1, change: "archived", planningRoot: root, phase: "completed", jobs: [], fixRounds: 0, approvalHistory: [], completedAt: "now" }));
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(state(root, [attempt(root, "old", "failed"), attempt(root, "new")])));
  writeFileSync(join(repo.stateDir, "lock.json"), "{}");
  const s = collect(root);
  assert.deepEqual(s.features.map(f => f.id), ["local:archived", "local:demo"]);
  assert.equal(s.tasks.length, 2);
  assert.equal(s.sessions.length, 2);
  assert.equal(s.tasks[0].attempts.length, 2);
  assert.equal(s.features[1].total, 2);
  assert.equal(s.features[1].completed, 0);
});
test("reader isolates malformed sources and reads state versions without writes", t => {
  const { root, repo } = fixture(t);
  writeFileSync(join(repo.stateDir, "broken.json"), "{");
  writeFileSync(join(repo.stateDir, "unsupported.json"), '{"version":99}');
  for (const version of [1, 2]) {
    const path = join(repo.stateDir, "demo.json"), bytes = JSON.stringify(state(root, [], version));
    writeFileSync(path, bytes);
    const s = collect(root);
    assert.equal(s.features.find(f => f.change === "demo").total, 2);
    assert.deepEqual(s.errors.map(e => e.source).sort(), ["local:broken", "local:unsupported"]);
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.deepEqual(readdirSync(repo.stateDir).sort(), ["broken.json", "demo.json", "unsupported.json"]);
  }
});
test("reader explains dependencies drift transactions approvals findings and repair limits", t => {
  const { root, repo } = fixture(t);
  const initial = collect(root);
  assert.equal(initial.tasks[0].ready, true);
  assert.match(initial.tasks[1].reasons.join(" "), /depend.*1\.1/i);
  const saved = state(root, [attempt(root, "done", "completed")]);
  saved.fingerprint = "changed";
  saved.transaction = { tasks: ["1.1"], current: "1.1", before: "a", phase: "merging", marker: "m" };
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(saved));
  mkdirSync(join(repo.stateDir, "features"));
  writeFileSync(join(repo.stateDir, "features/demo.json"), JSON.stringify({ version: 1, change: "demo", planningRoot: root, phase: "awaiting-final-approval", fixRounds: 1, jobs: [{ ...attempt(root, "review", "completed"), role: "review", round: 1, approvalToken: "a", findings: [{ id: "blocking", category: "spec", impact: "broken", location: "x", correction: "fix" }, { id: "advisory", category: "style", impact: "style", location: "x", correction: "polish" }] }], approvalHistory: [], approval: { maxFixRounds: 1, fingerprint: "old" } }));
  const s = collect(root), messages = s.attention.map(a => a.message).join(" ");
  for (const pattern of [/drift|changed/i, /integration/i, /missing report/i, /final approval/i, /blocking/i, /advisory/i, /repair.*limit/i]) assert.match(messages, pattern);
  assert.equal(s.tasks.every(t => !t.ready), true);
});
test("reader separates recorded phase report process and terminal", t => {
  const { root, repo } = fixture(t), a = attempt(root, "one", "running");
  a.report = { attempt: "one", task: "1.1", session: "s", outcome: "completed", summary: "turn", verification: [] };
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(state(root, [a])));
  let session = collect(root).sessions[0];
  assert.equal(session.phase, "running"); assert.equal(session.reportOutcome, "completed");
  assert.equal(session.process, "unknown"); assert.equal(session.terminal, "unavailable");
  a.worker.processStart = processStart(process.pid);
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(state(root, [a])));
  session = collect(root).sessions[0];
  assert.equal(session.process, process.platform === "linux" ? "running" : "unknown");
  a.worker.exitedAt = "now";
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(state(root, [a])));
  assert.equal(collect(root).sessions[0].process, "exited");
});
test("reader counts retained completion inventory after planning artifacts are archived", t => {
  const { root, repo } = fixture(t), saved = state(root);
  saved.completion = { tasks: ["1.1", "1.2"], fingerprint: saved.fingerprint, head: "head" };
  saved.baseline = ["1.1", "1.2"];
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(saved));
  rmSync(join(root, "openspec/changes/demo"), { recursive: true });
  const s = collect(root);
  assert.equal(s.features[0].completed, 2); assert.equal(s.features[0].total, 2);
});
test("reader resolves linked worktree and preserves runtime bytes and git refs", t => {
  const { root, repo } = fixture(t);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { cwd: root, stdio: "ignore" });
  const linked = `${root}-linked`;
  t.after(() => rmSync(linked, { recursive: true, force: true }));
  execFileSync("git", ["worktree", "add", "-b", "linked", linked], { cwd: root, stdio: "ignore" });
  const bytes = JSON.stringify(state(root, [attempt(root, "old", "integrated")]));
  writeFileSync(join(repo.stateDir, "demo.json"), bytes);
  const refs = execFileSync("git", ["show-ref"], { cwd: root, encoding: "utf8" });
  const s = collect(linked);
  assert.equal(s.repository.root, linked); assert.equal(s.repository.currentWorktree, linked);
  assert.equal(s.repository.common, repo.common); assert.equal(s.repository.stateDir, repo.stateDir);
  assert.equal(s.features[0].id, "local:demo"); assert.equal(s.sessions[0].phase, "integrated");
  assert.equal(readFileSync(join(repo.stateDir, "demo.json"), "utf8"), bytes);
  assert.equal(execFileSync("git", ["show-ref"], { cwd: root, encoding: "utf8" }), refs);
  assert.deepEqual(readdirSync(repo.stateDir), ["demo.json"]);
});
test("reader blocks managed launch when pinned planning root drifts", t => {
  const { root, repo } = fixture(t), pinned = join(root, "pinned");
  mkdirSync(join(pinned, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(pinned, "openspec/runner.yaml"), "version: 1\n");
  writeFileSync(join(pinned, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Changed description\n- [ ] 1.2 Second\n");
  writeFileSync(join(pinned, "openspec/changes/demo/execution.yaml"), JSON.stringify({ version: 1, tasks: { "1.1": {}, "1.2": { dependsOn: ["1.1"] } } }));
  const settings = { model: "a", reasoningEffort: "high" };
  mkdirSync(join(repo.stateDir, "features"));
  writeFileSync(join(repo.stateDir, "features/demo.json"), JSON.stringify({ version: 1, change: "demo", planningRoot: pinned, phase: "implementing", jobs: [], fixRounds: 0, approvalHistory: [], approval: { token: "token", fingerprint: loadPlan(root, "demo").fingerprint, base: "base", implementation: settings, tasks: { "1.1": settings, "1.2": settings }, review: settings, repair: settings, maxFixRounds: 2, verifyIntegration: [], at: "now" } }));
  const s = collect(root);
  assert.equal(s.tasks[0].ready, false);
  assert.match(s.tasks[0].reasons.join(" "), /approval.*current plan/i);
});
