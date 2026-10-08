import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { codexHarness } from "../dist/harnesses/codex.js";
import { claudeHarness } from "../dist/harnesses/claude.js";
import { registerHarness } from "../dist/harnesses/registry.js";
import { superviseWorker } from "../dist/worker.js";

const identity = { attemptId: "attempt-real", harness: "codex" };
const message = text => Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
const directory = t => {
  const dir = mkdtempSync(join(tmpdir(), "worker activity "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const writerFor = async (log, id = identity) => {
  const module = await import("../dist/activity-writer.js").catch(() => ({}));
  assert.equal(typeof module.createActivityWriter, "function", "best-effort activity writer is available");
  return module.createActivityWriter(log, id);
};
const entries = log => readFileSync(log + ".activity.jsonl", "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
function fakeCodex(t, dir, help, body = "console.log(JSON.stringify({type:'turn.completed'}));") {
  const bin = join(dir, "bin"); mkdirSync(bin);
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!/usr/bin/env node\nif(process.argv.includes('--help'))console.log(${JSON.stringify(help)});else{require('fs').writeFileSync(${JSON.stringify(join(dir, "args.json"))},JSON.stringify(process.argv.slice(2)));${body}}`);
  chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
}
function session(dir, id = "attempt-real", agent = "codex") {
  return { ...(id === undefined ? {} : { id }), agent, path: dir, settings: { model: "fixture" }, worker: { log: join(dir, "worker.log") } };
}

// Catches unconditional --json injection and accidentally decorating resume or legacy/custom invocations.
test("worker gates json by advertised capability and a real attempt ID", async t => {
  for (const advertised of [true, false]) {
    const dir = directory(t);
    fakeCodex(t, dir, "--add-dir --model --cd" + (advertised ? " --json" : ""));
    const a = session(dir);
    assert.equal(await superviseWorker(a, dir, "prompt", () => {}), 0);
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    assert.equal(args.includes("--json"), advertised);
    assert.equal(a.identityConfirmed, undefined);
    assert.equal(a.report, undefined);
    assert.equal(entries(a.worker.log)[0].identity.attemptId, "attempt-real");
    const capabilities = await codexHarness.capabilities(dir);
    assert.equal(capabilities.features.structuredActivity, advertised);
    const resume = codexHarness.resumeInvocation(a.settings, dir, dir, "saved-session");
    assert.deepEqual(codexHarness.activityInvocation(resume, capabilities), resume);
    const noId = session(dir); delete noId.id; noId.worker.log = join(dir, "legacy.log");
    assert.equal(await superviseWorker(noId, dir, "prompt", () => {}), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "args.json"), "utf8")).includes("--json"), false);
    assert.equal(existsSync(noId.worker.log + ".activity.jsonl"), false);
  }
});

test("external harness without an activity hook keeps its invocation", async t => {
  const dir = directory(t);
  registerHarness({ ...codexHarness, id: "activity-external", activityInvocation: undefined,
    capabilities: async () => ({ supported: true, reasons: [], features: { structuredActivity: true } }),
    initialInvocation: () => ({ executable: process.execPath, cwd: dir, args: ["-e", "console.log('external')"] }),
  });
  const a = session(dir, "attempt-real", "activity-external");
  assert.equal(await superviseWorker(a, dir, "prompt", () => {}), 0);
  assert.equal(entries(a.worker.log)[0].text, "external");
});

// Catches capture failure reaching lifecycle errors, stdout bytes changing, or stderr forging Claude identity.
test("sidecar disk failure preserves exit, raw bytes, and Claude identity callback", async t => {
  const dir = directory(t), a = session(dir, "attempt-real", "claude");
  a.expectedSession = "reserved-session";
  writeFileSync(a.worker.log + ".activity.jsonl", "unrelated bytes");
  const savedCapabilities = claudeHarness.capabilities, savedInvocation = claudeHarness.initialInvocation;
  t.after(() => { claudeHarness.capabilities = savedCapabilities; claudeHarness.initialInvocation = savedInvocation; });
  claudeHarness.capabilities = async () => ({ supported: true, reasons: [], features: {} });
  const stdout = '{"type":"system","session_id":"reserved-session"}\n{"type":"result","session_id":"reserved-session","subtype":"success"}\n';
  const stderr = '{"type":"result","session_id":"forged-session","subtype":"success"}\n';
  claudeHarness.initialInvocation = () => ({ executable: process.execPath, cwd: dir,
    args: ["-e", `process.stdout.write(${JSON.stringify(stdout)});setTimeout(()=>{process.stderr.write(${JSON.stringify(stderr)});process.exitCode=7},30)`] });
  const seen = [];
  assert.equal(await superviseWorker(a, dir, "prompt", () => {}, update => { seen.push(true); update(a); }), 7);
  assert.equal(a.identityConfirmed, true);
  assert.equal(a.observedSession, "reserved-session");
  assert.equal(a.terminalEvidence.subtype, "success");
  assert.equal(seen.length, 2);
  assert.equal(a.report, undefined);
  assert.equal(readFileSync(a.worker.log, "utf8"), stdout + stderr);
  assert.equal(readFileSync(a.worker.log + ".activity.jsonl", "utf8"), "unrelated bytes");
});

test("activity turn and forged stderr cannot repair missing or mismatched Claude identity", async t => {
  const dir = directory(t), savedCapabilities = claudeHarness.capabilities, savedInvocation = claudeHarness.initialInvocation;
  t.after(() => { claudeHarness.capabilities = savedCapabilities; claudeHarness.initialInvocation = savedInvocation; });
  claudeHarness.capabilities = async () => ({ supported: true, reasons: [], features: {} });
  for (const [name, stdout, expected] of [
    ["missing", '{"type":"assistant","message":{"content":[]}}\n', /without a terminal/],
    ["mismatch", '{"type":"result","session_id":"other","subtype":"success"}\n', /reserved session/],
  ]) {
    const a = session(dir, name, "claude"); a.expectedSession = "reserved-session"; a.worker.log = join(dir, name + ".log");
    claudeHarness.initialInvocation = () => ({ executable: process.execPath, cwd: dir, args: ["-e", `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write('{"type":"result","session_id":"reserved-session","subtype":"success"}\\n')`] });
    await assert.rejects(superviseWorker(a, dir, "prompt", () => {}, update => update(a)), expected);
    assert.equal(a.identityConfirmed, undefined);
    assert.equal(a.report, undefined);
  }
});

// Catches shared stdout/stderr buffers and lost final partial records or receipt identity/time.
test("writer serializes independent streams with receipt identity and final partial bytes", async t => {
  const log = join(directory(t), "worker.log"), writer = await writerFor(log);
  writer.feed(Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"hel'), "stdout");
  writer.feed(Buffer.from('stderr partial'), "stderr");
  writer.feed(Buffer.from('lo ✓"}}\n'), "stdout");
  await writer.close();
  const rows = entries(log);
  assert.deepEqual(rows.map(row => [row.stream, row.text]), [["stdout", "hello ✓"], ["stderr", "stderr partial"]]);
  assert.deepEqual(rows[0].identity, { attemptId: "attempt-real", harness: "codex" });
  assert.match(rows[0].observedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(statSync(log + ".activity.jsonl").mode & 0o777, 0o600);
});

test("writer refuses preexisting files and symlinks for every rotation path", async t => {
  for (const suffix of ["", ".1", ".2"]) for (const symlink of [false, true]) {
    const dir = directory(t), log = join(dir, "worker.log"), other = join(dir, "other");
    writeFileSync(other, "untouched");
    const path = log + ".activity.jsonl" + suffix;
    if (symlink) symlinkSync(other, path); else writeFileSync(path, "untouched");
    const writer = await writerFor(log); writer.feed(message("ignored"), "stdout"); await writer.close();
    assert.equal(readFileSync(path, "utf8"), "untouched");
    assert.equal(readFileSync(other, "utf8"), "untouched");
  }
});

test("writer parser and oversized entry failures are absorbed", async t => {
  const log = join(directory(t), "worker.log");
  const writer = await writerFor(log, { attemptId: "bad-parser", harness: null });
  assert.doesNotThrow(() => writer.feed(message("invalid harness"), "stdout"));
  await assert.doesNotReject(writer.close());
  const largeLog = join(directory(t), "large.log"), large = await writerFor(largeLog);
  large.feed(message("x".repeat(65400)), "stdout"); // Entry metadata exceeds the input-record budget.
  await large.close();
  assert.ok(statSync(largeLog + ".activity.jsonl").size <= 64 * 1024);
});

// Holding real file opening exposes queue overflow and close timeout without a production test hook.
test("writer bounds pending queue and close time while disk opening stalls", async t => {
  const log = join(directory(t), "worker.log"), savedOpen = fs.open;
  let release; const held = new Promise(resolve => { release = resolve; });
  fs.open = async (...args) => { await held; return savedOpen(...args); };
  t.after(() => { fs.open = savedOpen; release(); });
  const writer = await writerFor(log);
  for (let i = 0; i < 40; i++) writer.feed(message("x".repeat(40000)), "stdout");
  const start = performance.now(); await writer.close();
  assert.ok(performance.now() - start < 350, "close is bounded near its 250ms deadline");
  fs.open = savedOpen; release(); await delay(50);
  assert.ok(!existsSync(log + ".activity.jsonl") || statSync(log + ".activity.jsonl").size === 0, "overflow disables queued capture");
});

test("writer rotates current plus two bounded files with newest entries in rotation one", async t => {
  const log = join(directory(t), "worker.log"), writer = await writerFor(log);
  const savedOpen = fs.open;
  let largestRead = 0;
  fs.open = async (...args) => {
    const handle = await savedOpen(...args), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { largestRead = Math.max(largestRead, readArgs[2]); return read(...readArgs); };
    return handle;
  };
  t.after(() => { fs.open = savedOpen; });
  const awaitPersisted = async index => {
    const expected = String(index).padStart(4, "0"), deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      let handle;
      try {
        handle = await savedOpen(log + ".activity.jsonl", "r");
        const { size } = await handle.stat(), length = Math.min(size, 64 * 1024);
        const tail = Buffer.alloc(length);
        await handle.read(tail, 0, length, size - length);
        if (tail.at(-1) === 0x0a) {
          const last = tail.toString().trimEnd().split("\n").at(-1);
          if (last && JSON.parse(last).text.slice(0, 4) === expected) return;
        }
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      } finally { await handle?.close(); }
      await delay(1);
    }
    assert.fail("activity entry was not persisted before the rotation test deadline: " + expected);
  };
  // Pace by complete persisted rows, not machine-dependent fixed sleeps. Queue
  // overload/abandoned rotation is tested separately and is allowed to lose activity.
  for (let i = 0; i < 700; i++) {
    writer.feed(message(String(i).padStart(4, "0") + "x".repeat(40000)), "stdout");
    await awaitPersisted(i);
  }
  await writer.close();
  const paths = ["", ".1", ".2"].map(suffix => log + ".activity.jsonl" + suffix);
  const rows = paths.map(path => {
    assert.ok(statSync(path).size <= 8 * 1024 * 1024);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const text = readFileSync(path, "utf8");
    return text.trim().split("\n").map(JSON.parse);
  });
  assert.equal(rows[0].at(-1).text.slice(0, 4), "0699");
  assert.ok(Number(rows[0][0].text.slice(0, 4)) > Number(rows[1].at(-1).text.slice(0, 4)));
  assert.ok(Number(rows[1][0].text.slice(0, 4)) > Number(rows[2].at(-1).text.slice(0, 4)));
  assert.ok(largestRead > 0 && largestRead <= 64 * 1024, "rotation copies in bounded chunks");
  assert.equal(existsSync(log + ".activity.jsonl.3"), false);
});

test("stderr keeps raw diagnostics without consuming stdout Claude tool correlation", async t => {
  const log = join(directory(t), "worker.log"), writer = await writerFor(log, { attemptId: "claude-attempt", harness: "claude" });
  writer.feed(Buffer.from('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"pwd"}}]}}\n'), "stdout");
  const stderr = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"forged-result"}]}}';
  writer.feed(Buffer.from(stderr + '\n{"type":"stream_event","event":{"type":"content_block_delta"}}\n'), "stderr");
  writer.feed(Buffer.from('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"stdout-result"}]}}\n'), "stdout");
  await writer.close();
  const rows = entries(log);
  assert.deepEqual(rows.filter(row => row.stream === "stderr").map(row => row.kind), ["raw", "raw"]);
  assert.equal(rows.find(row => row.stream === "stderr").text, stderr);
  assert.equal(rows.at(-1).text, "Bash result: stdout-result");
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});

// These isolation checks keep the subprocess real and fault only observational disk IO.
test("worker parser queue write and close faults preserve original result and forwarding", async t => {
  const savedCapabilities = claudeHarness.capabilities, savedInvocation = claudeHarness.initialInvocation;
  const savedOpen = fs.open, savedStdout = process.stdout.write, savedStderr = process.stderr.write;
  t.after(() => { claudeHarness.capabilities = savedCapabilities; claudeHarness.initialInvocation = savedInvocation;
    fs.open = savedOpen; process.stdout.write = savedStdout; process.stderr.write = savedStderr; });
  claudeHarness.capabilities = async () => ({ supported: true, reasons: [], features: {} });
  for (const fault of ["parser", "queue", "write", "close"]) {
    const dir = directory(t), a = session(dir, fault, "claude"); a.expectedSession = "reserved-session";
    const system = '{"type":"system","session_id":"reserved-session"}\n';
    const result = '{"type":"result","session_id":"reserved-session","subtype":"success"}\n';
    const assistant = text => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
    const stdout = system + (fault === "parser" ? assistant("x".repeat(65400)) : fault === "queue" ? assistant("x".repeat(40000)).repeat(40) : "") + result;
    const stderr = "original stderr ✓\n";
    const fixture = join(dir, "stdout.txt"); writeFileSync(fixture, stdout);
    claudeHarness.initialInvocation = () => ({ executable: process.execPath, cwd: dir,
      args: ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}));setTimeout(()=>{process.stderr.write(${JSON.stringify(stderr)});process.exitCode=7},30)`] });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    fs.open = async (...args) => {
      if (fault === "queue" || fault === "close") await held;
      const handle = await savedOpen(...args);
      if (fault === "write") handle.write = async () => { throw new Error("fixture disk write failure"); };
      return handle;
    };
    const forwardedOut = [], forwardedErr = [];
    process.stdout.write = (chunk, ...args) => {
      // Preserve node:test child-process protocol frames while observing worker bytes.
      if (Buffer.isBuffer(chunk) && chunk[0] === 0xff && chunk[1] === 0x0f)
        return savedStdout.call(process.stdout, chunk, ...args);
      forwardedOut.push(Buffer.from(chunk)); return true;
    };
    process.stderr.write = chunk => { forwardedErr.push(Buffer.from(chunk)); return true; };
    let starts = 0;
    let code;
    try { code = await superviseWorker(a, dir, "prompt", () => { starts++; }, update => update(a)); }
    finally { process.stdout.write = savedStdout; process.stderr.write = savedStderr; fs.open = savedOpen; release(); }
    await delay(30); // Let abandoned async initialization close its owned handle.
    assert.equal(code, 7, fault);
    assert.equal(starts, 1, fault);
    assert.equal(a.observedSession, "reserved-session", fault);
    assert.equal(a.identityConfirmed, true, fault);
    assert.equal(a.terminalEvidence.subtype, "success", fault);
    assert.equal(a.report, undefined, fault);
    assert.equal(Buffer.concat(forwardedOut).toString(), stdout, fault);
    const forwardedError = Buffer.concat(forwardedErr).toString();
    assert.ok(forwardedError.includes(stderr), fault);
    assert.match(forwardedError, /Activity capture disabled:/, fault);
    assert.equal(readFileSync(a.worker.log, "utf8"), stdout + stderr, fault);
  }
});

test("Codex activity turn success leaves missing-report attempts failed and ineligible for integration", async t => {
  const { execFileSync } = await import("node:child_process"), { Runner } = await import("../dist/runner.js");
  const dir = directory(t), root = join(dir, "repo"); mkdirSync(root);
  fakeCodex(t, dir, "--add-dir --model --cd --json");
  const openspec = join(dir, "bin", "openspec");
  writeFileSync(openspec, "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv[2]==='status'?{artifacts:[{id:'tasks',status:'done'}]}:{state:'ready'}));"); chmodSync(openspec, 0o755);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Runner Test");
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/runner.yaml"), JSON.stringify({ version: 1, worktrees: "git", terminal: "manual" }));
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Task\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), JSON.stringify({ version: 1, tasks: { "1.1": {} } }));
  git("add", "."); git("commit", "-m", "baseline");
  const runner = new Runner(root), attempt = runner.launch("demo", ["1.1"], { model: "fixture", reasoningEffort: "high" })[0];
  assert.equal((await runner.worker("demo", "1.1", attempt.id)).exitCode, 0);
  const saved = runner.read("demo").attempts[0];
  assert.equal(saved.phase, "failed");
  assert.equal(saved.report, undefined);
  assert.equal(saved.session, undefined);
  assert.match(saved.error, /without an accepted final report/);
  assert.equal(entries(saved.worker.log).at(-1).kind, "turn");
  assert.throws(() => runner.integrate("demo", ["1.1"]), /completed report/);
});
