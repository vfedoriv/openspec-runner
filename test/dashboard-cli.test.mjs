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
  child.emit("message", { version: 1, id: obsolete, snapshot: good });
  assert.equal(snapshots.length, 2);
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
