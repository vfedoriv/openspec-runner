import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const entry = resolve("bin/openspec-runner.js");
test("dashboard emits once json and plain without ui", t => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  for (const args of [["--once"], [], ["--json"], ["--json", "--change", "missing"]]) {
    const result = spawnSync(process.execPath, [entry, "dashboard", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    if (args.includes("--json")) { const s = JSON.parse(result.stdout); assert.equal(s.version, 1); assert.deepEqual(s.features, []); }
    else assert.match(result.stdout, /Features.*0|0 features/i);
  }
  for (const args of [["--bogus"], ["--store", "store"], ["--map", "map"], ["extra"]]) {
    const result = spawnSync(process.execPath, [entry, "dashboard", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Unknown|together|Unexpected/);
  }
});
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
const client = await import("../dist/dashboard-client.js").catch(() => ({}));
test("collector coalesces slow refresh retains failed sources rejects late replies and closes", async t => {
  assert.equal(typeof client.startDashboardCollector, "function", "asynchronous collector must exist");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const children = [];
  t.mock.method(childProcess, "fork", () => {
    const child = new EventEmitter(); child.connected = true;
    child.requests = []; child.send = request => child.requests.push(request);
    child.kill = () => { child.connected = false; child.emit("exit", 0); };
    children.push(child); return child;
  });
  const snapshots = [], errors = [];
  const collector = client.startDashboardCollector({ cwd: "/repo" }, s => snapshots.push(s), e => errors.push(e));
  const child = children[0];
  collector.refresh(); collector.refresh();
  assert.equal(child.requests.length, 1);
  const good = { version: 1, collectedAt: "first", repository: {}, features: [{ id: "local:a", completed: 0, total: 0, taskIds: [], sessionIds: [] }], tasks: [], sessions: [], assignments: [], attention: [], errors: [], sources: { "local:a": { collectedAt: "first", stale: false } } };
  child.emit("message", { version: 1, id: child.requests[0].id, snapshot: good });
  assert.equal(child.requests.length, 2);
  const failed = { ...good, collectedAt: "second", features: [], errors: [{ source: "local:a", message: "broken", stale: false }], sources: { "local:a": { collectedAt: "second", stale: false } } };
  child.emit("message", { version: 1, id: child.requests[1].id, snapshot: failed });
  assert.equal(snapshots.at(-1).features[0].id, "local:a");
  assert.equal(snapshots.at(-1).sources["local:a"].stale, true);
  collector.refresh(); const obsolete = child.requests.at(-1).id;
  t.mock.timers.tick(10000);
  assert.equal(children.length, 2); assert.match(errors.at(-1), /timeout/i);
  const delivered = snapshots.length;
  child.emit("message", { version: 1, id: obsolete, snapshot: good });
  assert.equal(snapshots.length, delivered);
  await collector.close(); t.mock.timers.tick(20000);
  assert.equal(children.length, 2); assert.equal(children[1].connected, false);
});
test("collector delivers a real observational snapshot and closes promptly", async t => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-collector-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  let collector;
  const snapshot = await new Promise((resolveSnapshot, reject) => {
    collector = client.startDashboardCollector({ cwd: root }, resolveSnapshot, message => reject(new Error(message)));
  });
  await collector.close();
  assert.equal(snapshot.repository.root, root); assert.equal(snapshot.version, 1);
});

function freshSnapshot() {
  return {
    version: 1, collectedAt: "2026-10-07T00:00:00Z", repository: { root: "/repo", common: "/repo/.git", stateDir: "/repo/.git/openspec-runner", currentWorktree: "/repo" },
    features: [{ id: "local:a", change: "a", origin: "local", completed: 0, total: 1, taskIds: ["local:a:task:1.1"], sessionIds: ["local:a:attempt:one"] }],
    tasks: [{ id: "local:a:task:1.1", featureId: "local:a", task: { id: "1.1", description: "Task", completed: false, line: 0 }, ready: true, reasons: [], attempts: [] }],
    sessions: [{ id: "local:a:attempt:one", featureId: "local:a", taskId: "local:a:task:1.1", role: "implementation", attempt: { id: "one", task: "1.1", description: "Task", fingerprint: "f", settings: { model: "a", reasoningEffort: "high" }, parallel: false, phase: "running", terminal: { pane: "pane" }, path: "/repo/worker", branch: "worker", base: "base", worker: { token: "token", pid: 42, processStart: "start", log: "/repo/log" } }, phase: "running", process: "running", terminal: "available" }],
    assignments: [{ id: "local:a:assignment:assigned", featureId: "local:a", componentId: "api", repository: "api", change: "a", owner: "alice", importedRevision: "a".repeat(40), stale: false }],
    attention: [], errors: [], sources: { "local:a": { collectedAt: "2026-10-07T00:00:00Z", stale: false } },
  };
}
function fakeCollector(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const children = [], snapshots = [], failures = [];
  t.mock.method(childProcess, "fork", () => {
    const child = new EventEmitter(); child.connected = true; child.requests = [];
    child.send = request => child.requests.push(request);
    child.kill = () => { child.connected = false; child.emit("exit", 0); };
    children.push(child); return child;
  });
  const collector = client.startDashboardCollector({ cwd: "/repo" }, s => snapshots.push(s), message => failures.push({ message, snapshot: snapshots.at(-1) }));
  t.after(() => collector.close());
  const respond = snapshot => { const child = children.at(-1); child.emit("message", { version: 1, id: child.requests.at(-1).id, snapshot }); };
  respond(freshSnapshot());
  return { collector, children, snapshots, failures, respond };
}
for (const failure of ["timeout", "exit", "transport", "error-response"]) {
  test(`collector publishes stale retained observations before reporting ${failure}`, async t => {
    const f = fakeCollector(t), child = f.children[0], first = f.snapshots[0];
    f.collector.refresh();
    if (failure === "timeout") t.mock.timers.tick(10000);
    else if (failure === "exit") child.emit("exit", 1);
    else if (failure === "transport") child.emit("error", new Error("connection lost"));
    else child.emit("message", { version: 1, id: child.requests.at(-1).id, error: "repository unavailable" });
    const stale = f.snapshots.at(-1);
    assert.notEqual(stale, first, "failure must publish a new stale snapshot");
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0].snapshot, stale, "stale data must be published before failure notification");
    assert.equal(stale.sources["local:a"].stale, true);
    assert.equal(stale.sources["local:a"].collectedAt, "2026-10-07T00:00:00Z");
    assert.equal(stale.collectedAt, "2026-10-07T00:00:00Z");
    assert.equal(stale.tasks[0].ready, false);
    assert.deepEqual(stale.tasks[0].reasons, ["Source data is stale"]);
    assert.equal(stale.sessions[0].phase, "running"); assert.equal(stale.sessions[0].process, "unknown"); assert.equal(stale.sessions[0].terminal, "unknown");
    assert.equal(stale.assignments[0].stale, true);
    assert.equal(stale.errors[0].source, "local:a"); assert.equal(stale.errors[0].stale, true);
    assert.equal(first.tasks[0].ready, true); assert.equal(first.sources["local:a"].stale, false);
  });
}
test("collector keeps stale reasons bounded across repeated source failures", t => {
  const f = fakeCollector(t);
  for (let index = 0; index < 3; index++) {
    f.collector.refresh();
    f.respond({ ...freshSnapshot(), collectedAt: `failure-${index}`, features: [], tasks: [], sessions: [], assignments: [], errors: [{ source: "local:a", message: "broken", stale: false }] });
  }
  assert.deepEqual(f.snapshots.at(-1).tasks[0].reasons, ["Source data is stale"]);
  assert.equal(f.snapshots.at(-1).sources["local:a"].collectedAt, "2026-10-07T00:00:00Z");
});
