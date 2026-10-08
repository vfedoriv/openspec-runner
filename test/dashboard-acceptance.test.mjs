import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";

// Removing runDashboardUi's finally abort/close/unmount must leave a live child
// or raw/alternate-screen terminal state after this actual React render fault.
test("render failure aborts an active preview and collector and restores terminal state", async t => {
  const { runDashboardUi } = await import("../dist/dashboard-ui.js");
  const actualSpawn = childProcess.spawn;
  const children = []; let armed = false;
  const fixture = { version: 1, collectedAt: "now", repository: { root: process.cwd() }, features: [{ id: "local:a", origin: "local", change: "a", completed: 0, total: 1, taskIds: ["t"], sessionIds: [] }], tasks: [{ id: "t", featureId: "local:a", task: { id: "1.1", description: "Implement", completed: false }, ready: true, reasons: [], attempts: [] }], sessions: [], assignments: [], attention: [], errors: [], sources: {} };
  t.mock.method(childProcess, "fork", () => {
    const child = actualSpawn(process.execPath, ["-e", "process.on('message',()=>{}); setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.send = request => { setTimeout(() => child.emit("message", { version: 1, id: request.id, snapshot: armed ? { ...fixture, attention: null } : fixture }), 10); return true; };
    children.push(child); return child;
  });
  t.mock.method(childProcess, "spawn", () => {
    const child = actualSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); return child;
  });
  syncBuiltinESMExports();
  const input = new PassThrough(); input.isTTY = true;
  const raw = []; input.setRawMode = value => { raw.push(value); return input; };
  let output = "";
  const terminal = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  terminal.isTTY = true; terminal.columns = 100; terminal.rows = 16;
  const descriptors = Object.fromEntries(["stdin", "stdout", "stderr"].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]));

  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  Object.defineProperty(process, "stdout", { configurable: true, value: terminal });
  Object.defineProperty(process, "stderr", { configurable: true, value: terminal });
  const wait = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), "fixture reached expected UI boundary: " + output.slice(-3000));
  };
  try {
    const result = runDashboardUi({ cwd: process.cwd() }).then(() => ({ error: undefined }), error => ({ error }));
    await wait(() => output.includes("a actions"));
    await wait(() => output.includes("0/1 tasks satisfied"));
    const key = async value => { input.write(value); await new Promise(resolve => setTimeout(resolve, 70)); };
    await key("a"); await key("\u001b[B"); await key("\r"); await key("1.1"); await key("\r"); await key("fixture-model"); await key("\r"); await key("high"); await key("\r");
    await wait(() => children.length === 2);
    armed = true; await key("r");
    const settled = await Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error("UI fault did not settle")), 4000))]);
    assert.ok(settled.error, "render fault must reject the UI operation");
    await wait(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(raw.at(-1), false); assert.ok(raw.includes(true));
    assert.match(output, /\u001b\[\?1049h/); assert.match(output, /\u001b\[\?1049l/);
    assert.match(output, /\u001b\[\?25h/);
    assert.equal(process.listeners("SIGINT").some(listener => listener.name === "interrupt"), false);
  } finally {
    if (process.listeners("SIGINT").some(listener => listener.name === "interrupt")) input.write("q"); await new Promise(resolve => setTimeout(resolve, 50));
    for (const key of ["stdin", "stdout", "stderr"]) Object.defineProperty(process, key, descriptors[key]);
    for (const child of children) { try { child.kill("SIGKILL"); } catch {} }
    input.destroy(); t.mock.restoreAll(); syncBuiltinESMExports();
  }
});






import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { repository } from "../dist/system.js";
import { loadPlan } from "../dist/plan.js";
import { superviseWorker } from "../dist/worker.js";
import { codexHarness } from "../dist/harnesses/codex.js";
import { claudeHarness } from "../dist/harnesses/claude.js";
import { collectDashboard } from "../dist/dashboard-reader.js";
import { readActivityPage } from "../dist/activity-reader.js";
import { actionsFor } from "../dist/dashboard-actions.js";
import { runDashboardAction } from "../dist/dashboard-action-runner.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function bytes(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? Object.entries(bytes(join(directory, entry.name))).map(([key, value]) => [entry.name + "/" + key, value]) : [[entry.name, readFileSync(join(directory, entry.name)).toString("base64")]]));
}
// Catches activity success promoting lifecycle, losing original raw bytes, or
// snapshot/activity/action browsing writing durable state or repository refs.
for (const [harness, version] of [[codexHarness, 1], [codexHarness, 2], [claudeHarness, 2]]) {
  test(`${harness.id} activity stays observational across v${version} state and CLI browsing`, async t => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-acceptance-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Acceptance"); git(root, "config", "user.email", "test@example.invalid");
    mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
    writeFileSync(join(root, "openspec/runner.yaml"), "version: 1\n");
    writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Implement\n");
    writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), "version: 1\ntasks:\n  '1.1': {}\n");
    git(root, "add", "."); git(root, "commit", "-m", "Fixture plan");
    const repo = repository(root); mkdirSync(repo.stateDir, { recursive: true });
    const log = join(repo.stateDir, "worker.log"), head = git(root, "rev-parse", "HEAD");
    const attempt = { id: "captured", agent: harness.id, task: "1.1", description: "Implement", fingerprint: loadPlan(root, "demo").fingerprint, settings: { model: "fixture", reasoningEffort: "high" }, phase: "running", terminal: {}, path: root, branch: "main", base: head, worker: { token: "token", log }, ...(harness.id === "claude" ? { expectedSession: "reserved" } : {}) };
    const raw = harness.id === "codex" ? '{"type":"item.completed","item":{"type":"agent_message","text":"captured activity"}}\n{"type":"turn.completed"}\n' : '{"type":"system","session_id":"reserved"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"captured activity"}]}}\n{"type":"result","session_id":"reserved","subtype":"success"}\n';
    const capabilities = harness.capabilities, invocation = harness.initialInvocation;
    harness.capabilities = async () => ({ supported: true, reasons: [], features: { structuredActivity: true } });
    harness.initialInvocation = () => ({ executable: process.execPath, cwd: root, args: ["-e", `process.stdout.write(${JSON.stringify(raw)})`] });
    try { assert.equal(await superviseWorker(attempt, root, "fixture", () => {}, update => update(attempt)), 0); }
    finally { harness.capabilities = capabilities; harness.initialInvocation = invocation; }
    assert.equal(attempt.report, undefined); assert.equal(attempt.phase, "running");
    assert.equal(readFileSync(log, "utf8"), raw);
    const state = { version, change: "demo", fingerprint: attempt.fingerprint, integration: { path: root, branch: "main", base: head }, head, baseline: [], attempts: [attempt], ...(version === 2 ? { batches: [{ id: "batch", harness: harness.id, attempts: [attempt.id] }] } : {}) };
    writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify(state));
    const before = bytes(repo.stateDir), refs = git(root, "show-ref"), status = git(root, "status", "--porcelain");
    const snapshot = collectDashboard({ cwd: root, change: "demo" });
    assert.equal(snapshot.sessions[0].phase, "running"); assert.equal(snapshot.sessions[0].reportOutcome, undefined);
    assert.equal(snapshot.features[0].completed, 0); assert.equal(snapshot.tasks[0].ready, false);
    const page = readActivityPage({ log, sidecar: log + ".activity.jsonl", identity: { attemptId: attempt.id, harness: harness.id }, direction: "older" });
    assert.ok(page.entries.some(entry => entry.text.includes("captured activity"))); assert.ok(page.entries.some(entry => entry.kind === "turn"));
    for (const target of [snapshot.features[0].id, snapshot.sessions[0].id]) {
      for (const action of actionsFor(snapshot, target).filter(action => ["inspect", "command"].includes(action.kind))) await runDashboardAction({ snapshot, action, signal: new AbortController().signal });
    }
    for (const args of [["--json"], ["--once", "--change", "demo"], []]) {
      const output = execFileSync(process.execPath, [resolve("bin/openspec-runner.js"), "dashboard", ...args], { cwd: root, encoding: "utf8" });
      if (args.includes("--json")) assert.equal(JSON.parse(output).sessions[0].phase, "running"); else assert.match(output, /report=missing/);
    }
    assert.deepEqual(bytes(repo.stateDir), before); assert.equal(git(root, "show-ref"), refs); assert.equal(git(root, "status", "--porcelain"), status);
  });
}



// A once listener disappears during OS signal dispatch, allowing Ink's signal
// exit handler to terminate before the dashboard's asynchronous finally runs.
test("OS SIGINT waits for dashboard cleanup before terminating", () => {
  const ui = new URL("../dist/dashboard-ui.js", import.meta.url).href;
  const source = `
    import { PassThrough, Writable } from 'node:stream';
    import { runDashboardUi } from ${JSON.stringify(ui)};
    const savedOutput=process.stdout;
    const input=new PassThrough(); input.isTTY=true;
    let raw=false, output='', signalled=false;
    input.setRawMode=value=>{raw=value;if(value&&!signalled){signalled=true;setTimeout(()=>process.kill(process.pid,'SIGINT'),200);}return input;};
    const terminal=new Writable({write(chunk,encoding,done){output+=chunk.toString();done();}});
    terminal.isTTY=true;terminal.columns=55;terminal.rows=12;
    for(const [key,value] of Object.entries({stdin:input,stdout:terminal,stderr:terminal})) Object.defineProperty(process,key,{configurable:true,value});
    await runDashboardUi({cwd:process.cwd()});
    savedOutput.write(JSON.stringify({raw,entered:output.includes('\\x1b[?1049h'),left:output.includes('\\x1b[?1049l'),cursor:output.includes('\\x1b[?25h')}));input.destroy();
  `;
  const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.signal, null, "SIGINT must complete dashboard cleanup without default signal termination");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { raw: false, entered: true, left: true, cursor: true });
});
