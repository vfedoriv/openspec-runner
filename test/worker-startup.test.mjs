import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { getHarness } from "../dist/harnesses/registry.js";
import { superviseWorker } from "../dist/worker.js";
import { locked } from "../dist/system.js";
import { processIsGone } from "../dist/platform-process.js";

function fixture(t, agent, mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "worker-startup-"));
  const boot = join(root, "boot"), consumed = join(root, "consumed"), registered = join(root, "registered");
  const script = join(root, "backend.cjs"), harness = getHarness(agent);
  const initial = harness.initialInvocation, capabilities = harness.capabilities;
  writeFileSync(script, `const fs=require('node:fs');
    if(${JSON.stringify(mode)}==='exit') {fs.writeFileSync(${JSON.stringify(boot)},'ready');process.exit(23);}
    const consume=text=>{if(!text)return;fs.writeFileSync(${JSON.stringify(consumed)},text);fs.writeFileSync(${JSON.stringify(boot)},'ready');if(${JSON.stringify(agent)}==='claude')console.log(JSON.stringify({type:'result',subtype:'success',session_id:'00000000-0000-4000-8000-000000000001'}));process.exit(fs.existsSync(${JSON.stringify(registered)})?0:17);};
    if(${JSON.stringify(agent)}==='codex' && process.argv.at(-1)!=='-')consume(process.argv.at(-1));
    else {fs.writeFileSync(${JSON.stringify(boot)},'ready');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>consume(text));}
  `);
  harness.capabilities = async () => ({ supported: true, features: {} });
  harness.initialInvocation = (...args) => {
    const invocation = initial(...args);
    return { ...invocation, executable: process.execPath, args: [script, ...invocation.args] };
  };
  t.after(() => { harness.initialInvocation = initial; harness.capabilities = capabilities; rmSync(root, { recursive: true, force: true }); });
  const waitBoot = () => {
    const deadline = Date.now() + 10000;
    while (!existsSync(boot)) assert.ok(Date.now() < deadline, "backend did not reach startup barrier");
  };
  const session = { agent, path: root, settings: { model: "model" }, expectedSession: "00000000-0000-4000-8000-000000000001", worker: { log: join(root, "worker.log") } };
  return { root, boot, consumed, registered, waitBoot, session };
}

for (const agent of ["codex", "claude"]) {
  test(`${agent} fast child receives its prompt only after registration returns`, { timeout: 30000 }, async t => {
    const f = fixture(t, agent);
    const code = await superviseWorker(f.session, f.root, "task prompt", pid => {
      f.waitBoot();
      assert.equal(existsSync(f.consumed), false, "prompt dispatched before registration finished");
      writeFileSync(f.registered, String(pid));
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(f.consumed, "utf8"), "task prompt");
  });

  test(`${agent} failed registration never dispatches a worker prompt`, { timeout: 30000 }, async t => {
    const f = fixture(t, agent);
    await assert.rejects(superviseWorker(f.session, f.root, "forbidden prompt", () => {
      f.waitBoot(); throw new Error("registration refused");
    }), /registration refused/);
    assert.equal(existsSync(f.consumed), false);
  });
}

test("lock deadline expiry during registration leaves the fast child without a prompt", { timeout: 30000 }, async t => {
  const f = fixture(t, "codex"), module = new URL("../dist/system.js", import.meta.url).href;
  const locker = spawn(process.execPath, ["--input-type=module", "-e", `import {locked} from ${JSON.stringify(module)};locked(${JSON.stringify(f.root)},()=>{process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)});`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { const closed = once(locker, "close"); locker.kill(); await closed; });
  await once(locker.stdout, "data");
  await assert.rejects(superviseWorker(f.session, f.root, "forbidden prompt", () => locked(f.root, () => writeFileSync(f.registered, "registered"))), /Repository is locked/);
  assert.equal(existsSync(f.consumed), false);
});

test("child exit during registration cannot produce a successful supervised turn", { timeout: 30000 }, async t => {
  const f = fixture(t, "codex", "exit");
  let code;
  try {
    code = await superviseWorker(f.session, f.root, "forbidden prompt", pid => {
      f.waitBoot(); const deadline = Date.now() + 10000;
      while (!processIsGone(pid)) assert.ok(Date.now() < deadline, "backend did not exit at startup barrier");
      writeFileSync(f.registered, String(pid));
    });
  } catch (error) { assert.match(String(error), /pipe|EPIPE|closed|destroyed/i); }
  assert.notEqual(code, 0);
  assert.equal(existsSync(f.consumed), false);
});
