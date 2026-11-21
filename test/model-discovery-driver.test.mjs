import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runDiscovery, boundedChild, sanitize, discoverySucceeded } from "./live/model-discovery.mjs";

test("driver validates before side effects and rejects inference switches", async () => {
  for (const args of [[], ["--agent", "copilot", "--cwd", "/tmp", "--model", "auto"], ["--agent", "claude", "--cwd", "/tmp", "--worker"]]) assert.throws(() => parseArgs(args));
  let called = false;
  await assert.rejects(runDiscovery({ agent: "other", cwd: "/tmp" }, { invoke() { called = true; } }));
  assert.equal(called, false);
});
test("driver forwards exact independent scopes and retains allowlisted evidence without inference", async t => {
  const root = await mkdtemp(join(tmpdir(), "discovery-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fake.mjs");
  await writeFile(script, 'import fs from "node:fs";if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["models","--agent","claude","--catalog","--json"])) {fs.writeFileSync("INFERENCE_MARKER","bad");process.exit(90)};console.log(JSON.stringify({harness:"claude",status:"available",scope:process.cwd(),entries:[{selector:"exact-alias",source:"discovered"}],secret:"NEVER_RETAIN"}));');
  const result = await runDiscovery({ agent: "claude", cwd: root, workerCwd: tmpdir() }, { evidenceRoot: root, runner: script });
  assert.deepEqual(result.scopes.map(x => x.cwd), [root, tmpdir()]);
  await assert.rejects(access(join(root,"INFERENCE_MARKER")));
  assert.ok(result.scopes.every(x => x.validCatalog)); assert.equal(result.inferenceStarted, false);
  const fast = await runDiscovery({agent:"claude",cwd:root,interrupt:true}, {evidenceRoot:root,runner:script});
  assert.equal(fast.scopes[0].validCatalog,true); assert.equal(discoverySucceeded(fast),false);
  const retained = await readFile(join(result.evidenceDir, "result.json"), "utf8");
  assert.ok(!retained.includes("NEVER_RETAIN")); assert.equal(result.observedModel, null);
});
test("bounded process observes nonzero, timeout, signal readiness and descendants", async () => {
  const failed = await boundedChild(process.execPath, ["-e", "process.exit(7)"], { timeoutMs: 500 });
  assert.equal(failed.evidence.exitCode, 7);
  const timeout = await boundedChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 });
  assert.equal(timeout.evidence.timedOut, true); assert.equal(timeout.evidence.signal, "SIGKILL");
  if (process.platform === "linux") {
    const interrupted = await boundedChild(process.execPath, ["-e", 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});setInterval(()=>{},1000)'], { interrupt: true, timeoutMs: 1000 });
    assert.equal(interrupted.evidence.readinessObserved, true); assert.equal(interrupted.evidence.signal, "SIGINT");
    assert.deepEqual(interrupted.evidence.remainingBeforeCleanup, []);
  }
});
test("driver retains failed catalog evidence and sanitizes secrets", async t => {
  const root = await mkdtemp(join(tmpdir(), "discovery-failure-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await runDiscovery({ agent: "codex", cwd: root }, { evidenceRoot: root, invoke: async () => { calls++; return { stdout: "token=secret ghp_abc sk-private", evidence: { exitCode: 8, remainingBeforeCleanup: [] } }; } });
  assert.equal(calls, 2); assert.equal(result.scopes[0].validCatalog, false);
  const retained = await readFile(join(result.evidenceDir, "result.json"), "utf8");
  assert.ok(!retained.includes("token=secret")); assert.ok(!retained.includes("ghp_abc"));
  assert.equal(sanitize("Bearer abc"), "[REDACTED]");
});

test("unready interruption times out without inventing readiness; output stays bounded", async () => {
  const unready = await boundedChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100, interrupt: true });
  assert.equal(unready.evidence.timedOut, true); assert.equal(unready.evidence.readinessObserved, false);
  const noisy = await boundedChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000))"], { timeoutMs: 1000 });
  assert.equal(noisy.evidence.overflow, true); assert.ok(noisy.stdout.length <= 262144);
});
test("malformed or forged catalog cannot pass discovery validation", async t => {
  const root = await mkdtemp(join(tmpdir(), "discovery-schema-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const stdout of ["{}", "not json", JSON.stringify({harness:"codex",status:"available",scope:root,entries:[null]}), JSON.stringify({harness:"claude",status:"available",scope:root,entries:[{selector:"auto",source:"discovered"}]})]) {
    const result = await runDiscovery({agent:"codex",cwd:root}, {evidenceRoot:root,invoke:async()=>({stdout,evidence:{exitCode:0,remainingBeforeCleanup:[]}})});
    assert.equal(result.scopes[0].validCatalog, false);
  }
});

test("requested interrupt requires readiness, exact interrupted exit and absolutely empty stdout", () => {
  const row = {processObservationSupported:true,remainingBeforeCleanup:[], timedOut:false, overflow:false, validCatalog:true, exitCode:0};
  assert.equal(discoverySucceeded({interruptionRequested:true,scopes:[row]}),false);
  const interrupted = {...row,validCatalog:false,exitCode:130,interrupted:true,readinessObserved:true,stdoutEmpty:true};
  assert.equal(discoverySucceeded({interruptionRequested:true,scopes:[interrupted]}),true);
  for(const patch of [{stdoutEmpty:false},{exitCode:0},{readinessObserved:false},{interrupted:false}]) assert.equal(discoverySucceeded({interruptionRequested:true,scopes:[{...interrupted,...patch}]}),false);
});
test("catalog rejects tainted metadata instead of retaining arbitrary JSON", async t => {
  const root = await mkdtemp(join(tmpdir(), "discovery-taint-")); t.after(() => rm(root, {recursive:true,force:true}));
  for(const patch of [{fetchedAt:{token:"NEVER_RETAIN"}},{fetchedAt:"secret=NEVER_RETAIN"},{entries:[{selector:"auto",source:"discovered",effortSupport:{token:"NEVER_RETAIN"}}]},{entries:[{selector:"auto",source:"discovered",efforts:[{token:"NEVER_RETAIN"}]}]}]) {
    const stdout=JSON.stringify({harness:"copilot",status:"available",scope:root,entries:[{selector:"auto",source:"discovered"}],...patch});
    const result=await runDiscovery({agent:"copilot",cwd:root},{evidenceRoot:root,invoke:async()=>({stdout,evidence:{exitCode:0,remainingBeforeCleanup:[]}})});
    assert.equal(result.scopes[0].validCatalog,false);
    assert.ok(!(await readFile(join(result.evidenceDir,"result.json"),"utf8")).includes("NEVER_RETAIN"));
  }
});

test("partial stdout before actual SIGINT cannot satisfy interrupted acceptance", async () => {
  const result = await boundedChild(process.execPath,["-e",'process.on("SIGINT",()=>process.exit(130));process.stdout.write("partial{");require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});setInterval(()=>{},1000)'],{interrupt:true,timeoutMs:1000});
  assert.equal(result.evidence.exitCode,130); assert.equal(result.evidence.stdoutEmpty,false);
  assert.equal(discoverySucceeded({interruptionRequested:true,scopes:[result.evidence]}),false);
});

test("stale owned identities cannot seed descendant adoption or signal an unrelated process", async t => {
  const { ownedProcessRows, signalOwnedIdentity } = await import("./live/model-discovery.mjs");
  const { spawn } = await import("node:child_process");
  const { observeProcess } = await import("../dist/platform-process.js");
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => sentinel.kill("SIGKILL"));
  const current = observeProcess(sentinel.pid);
  assert.ok(current);
  const stale = { pid: sentinel.pid, started: `${current.createdAt}-stale` };
  const owned = new Map([[stale.pid, stale]]);
  const rows = [{ pid: stale.pid, started: current.createdAt, ppid: 1, state: "S" }, { pid: 2147483646, started: String(BigInt(current.createdAt) + 1n), ppid: stale.pid, state: "S" }];
  assert.deepEqual(ownedProcessRows(rows, { pid: 2147483647, started: "old-root" }, owned), []);
  assert.equal(owned.has(2147483646), false);
  assert.deepEqual(ownedProcessRows(rows, stale, new Map()), []);
  const liveOwned = new Map();
  assert.deepEqual(ownedProcessRows(rows, { pid: stale.pid, started: current.createdAt }, liveOwned).map(row => row.pid), [2147483646]);
  assert.equal(signalOwnedIdentity(stale, "SIGKILL"), false);
  assert.equal(observeProcess(sentinel.pid)?.createdAt, current.createdAt);
});

test("discovery requires affirmative process observation even with a valid catalog", async t => {
  const root = await mkdtemp(join(tmpdir(), "discovery-observation-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const supported of [false, undefined, true]) {
    const result = await runDiscovery({ agent: "codex", cwd: root }, { evidenceRoot: root, invoke: async () => ({
      stdout: JSON.stringify({ harness: "codex", status: "available", scope: root, entries: [{ selector: "model", source: "discovered" }] }),
      evidence: { exitCode: 0, remainingBeforeCleanup: [], processObservationSupported: supported },
    }) });
    assert.equal(discoverySucceeded(result), supported === true);
    if (supported !== true) { assert.equal(result.scopes[0].status, "BLOCKED"); assert.match(result.scopes[0].reason, /process observation/i); }
  }
});

test("hard deadline prevents a SIGTERM handler from forking an unowned survivor", { skip: process.platform !== "linux" }, async t => {
  const { spawn } = await import("node:child_process");
  const { observeProcess, processIsGone } = await import("../dist/platform-process.js");
  const { signalOwnedIdentity } = await import("./live/model-discovery.mjs");
  const root = await mkdtemp(join(tmpdir(), "deadline-fork-"));
  const identities = [];
  t.after(async () => {
    for (const name of ["root.json", "initial.json", "late.json"]) {
      try { identities.push(JSON.parse(await readFile(join(root, name), "utf8"))); } catch {}
    }
    for (const identity of identities) signalOwnedIdentity(identity, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  identities.push({ pid: sentinel.pid, started: observeProcess(sentinel.pid)?.createdAt });
  const script = join(root, "root.cjs");
  await writeFile(script, `const fs = require("node:fs"), { spawn } = require("node:child_process"), path = require("node:path");
const save = (name, pid) => fs.writeFileSync(path.join(__dirname,name+".json"),JSON.stringify({pid,started:fs.readFileSync("/proc/"+pid+"/stat","utf8").split(") ")[1].split(" ")[19]}));
save("root",process.pid);
const initial = spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:"ignore"});save("initial",initial.pid);
process.on("SIGTERM",()=>{const late=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});save("late",late.pid);process.exit(0)});
setInterval(()=>{},1000);`);
  const result = await boundedChild(process.execPath, [script], { timeoutMs: 500 });
  assert.equal(result.evidence.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  const initial = JSON.parse(await readFile(join(root, "initial.json"), "utf8"));
  assert.ok(processIsGone(initial.pid), "initial test-owned child must be gone");
  let late;
  try { late = JSON.parse(await readFile(join(root, "late.json"), "utf8")); } catch {}
  assert.ok(!late || processIsGone(late.pid), "handler-created child must not survive deadline cleanup");
  assert.equal(result.evidence.signal, "SIGKILL", "hard deadline never invokes a cooperative termination handler");
  assert.equal(observeProcess(sentinel.pid)?.createdAt, identities[0].started);
});
