import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
const processes = await import("../dist/platform-process.js").catch(() => ({}));

test("Windows retains uncertainty for a vanished parent with a detached child", { skip: process.platform !== "win32", timeout: 30000 }, async t => {
  const source = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);process.stdin.once('data',()=>process.exit(0));`;
  const parent = spawn(process.execPath, ["-e", source], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const [bytes] = await once(parent.stdout, "data"), pid = Number(bytes.toString());
  t.after(() => { try { process.kill(pid); } catch {} try { parent.kill(); } catch {} });
  const identity = processes.observeProcess(parent.pid);
  const closed = once(parent, "close"); parent.stdin.end("exit"); await closed;
  assert.equal(processes.windowsTreeIsGone(parent.pid, identity.createdAt), false);
  assert.equal((await processes.stopOwnedProcess({ pid: parent.pid, createdAt: identity.createdAt, timeoutMs: 100 })).uncertain, true);
});

test("native process identity rejects a reused identity and confirms owned termination", { timeout: 60000 }, async t => {
  assert.equal(typeof processes.observeProcess, "function");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await once(child, "spawn");
  const identity = processes.observeProcess(child.pid);
  assert.ok(identity?.createdAt);
  const mismatch = await processes.stopOwnedProcess({ pid: child.pid, createdAt: "wrong-creation", timeoutMs: 3000 });
  assert.equal(mismatch.uncertain, true);
  assert.ok(processes.observeProcess(child.pid));
  const result = await processes.stopOwnedProcess({ pid: child.pid, createdAt: identity.createdAt, timeoutMs: 10000 });
  assert.equal(result.stopped, true);
  assert.equal(result.uncertain, false);
});
