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

test("Linux frozen-tree receipt requires creation provenance and durably publishes before kill", { skip: process.platform !== "linux", timeout: 15000 }, async t => {
  assert.equal(typeof processes.linuxProvenance, "function");
  assert.equal(typeof processes.prepareLinuxStop, "function");
  const children = [0,1].map(() => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"}));
  t.after(() => { for(const c of children) try { c.kill("SIGKILL"); } catch {} });
  await Promise.all(children.map(c => once(c,"spawn")));
  const roots = children.map(c => processes.observeProcess(c.pid));
  let receipt;
  processes.prepareLinuxStop({ provenance: processes.linuxProvenance(), roots, retained: [], timeoutMs: 3000,
    publish(value) { assert.ok(roots.every(r => processes.observeProcess(r.pid))); receipt = value; } });
  assert.ok(receipt); assert.equal(processes.linuxStopIsGone(receipt), true);
});

// Exercise observation races without replacing the production cancellation API.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
test("Linux barrier rejects roots disappearing after initial census", { skip: process.platform !== "linux" }, async t => {
  const children = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }));
  await Promise.all(children.map(c => once(c, "spawn")));
  const roots = children.map(c => processes.observeProcess(c.pid));
  t.after(() => { for (const c of children) try { c.kill("SIGKILL"); } catch {} });
  const original = fs.readFileSync; let reads = 0, published = false;
  fs.readFileSync = function(path, ...args) {
    if (path === `/proc/${roots[0].pid}/stat` && ++reads > 1) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => processes.prepareLinuxStop({ provenance: processes.linuxProvenance(), roots, retained: [], timeoutMs: 500,
      publish() { published = true; } }), /roots disappeared|root.*barrier/i);
    assert.equal(published, false);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test("Linux termination rejects unreadable exact member observation after publication", { skip: process.platform !== "linux" }, async t => {
  const children = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }));
  await Promise.all(children.map(c => once(c, "spawn")));
  const roots = children.map(c => processes.observeProcess(c.pid));
  t.after(() => { for (const c of children) try { c.kill("SIGKILL"); } catch {} });
  const original = fs.readFileSync; let published = false;
  fs.readFileSync = function(path, ...args) {
    if (published && path === `/proc/${roots[1].pid}/stat`) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => processes.prepareLinuxStop({ provenance: processes.linuxProvenance(), roots, retained: [], timeoutMs: 500,
      publish() { published = true; } }), /observation|uncertain/i);
    assert.equal(published, true);
    assert.match(processes.observeProcess(roots[0].pid)?.state ?? "", /^[Tt]$/);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
});

test("Linux freeze rollback resumes only controller-stopped members on observation failure", { skip: process.platform !== "linux" }, async t => {
  const children=[0,1].map(()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}));
  await Promise.all(children.map(c=>once(c,'spawn')));
  t.after(()=>{for(const c of children)try{c.kill('SIGKILL')}catch{}});
  const roots=children.map(c=>processes.observeProcess(c.pid));
  process.kill(roots[0].pid,'SIGSTOP');
  while(processes.observeProcess(roots[0].pid)?.state!=='T')await new Promise(resolve=>setTimeout(resolve,10));
  const original=fs.readFileSync;let reads=0,published=false;
  fs.readFileSync=function(path,...args){
    if(path===`/proc/${roots[0].pid}/stat`&&++reads===3)throw Object.assign(new Error('denied'),{code:'EACCES'});
    return original.call(this,path,...args);
  };syncBuiltinESMExports();
  try{assert.throws(()=>processes.prepareLinuxStop({provenance:processes.linuxProvenance(),roots,retained:[],timeoutMs:1000,publish(){published=true}}),/observation/);}
  finally{fs.readFileSync=original;syncBuiltinESMExports();}
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(published,false);assert.equal(processes.observeProcess(roots[0].pid)?.state,'T');
  assert.ok(!['T','t'].includes(processes.observeProcess(roots[1].pid)?.state));
});

test("Linux barrier retains a previously observed child after it reparents", { skip: process.platform !== "linux", timeout: 15000 }, async t=>{
  const parent=spawn(process.execPath,['-e',`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);process.stdin.once('data',()=>process.exit(0));`],{stdio:['pipe','pipe','ignore']});
  const [bytes]=await once(parent.stdout,'data'),pid=Number(bytes.toString()),identity=processes.observeProcess(pid);
  t.after(()=>{try{process.kill(pid,'SIGKILL')}catch{}try{parent.kill('SIGKILL')}catch{}});
  const closed=once(parent,'close');parent.stdin.end('exit');await closed;
  assert.notEqual(processes.observeProcess(pid).parentPid,parent.pid);
  const rootsChildren=[0,1].map(()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}));
  await Promise.all(rootsChildren.map(c=>once(c,'spawn')));
  t.after(()=>{for(const c of rootsChildren)try{c.kill('SIGKILL')}catch{}});
  const roots=rootsChildren.map(c=>processes.observeProcess(c.pid));
  const receipt=processes.prepareLinuxStop({provenance:processes.linuxProvenance(),roots,retained:[identity],timeoutMs:3000,publish(r){assert.ok(r.members.some(m=>m.pid===pid&&m.createdAt===identity.createdAt));assert.equal(processes.observeProcess(pid).state,'T')}});
  assert.equal(processes.linuxStopIsGone(receipt),true);
});

test("Linux receipt reconciliation rejects unreadable proc rather than inferring absence", { skip: process.platform !== "linux" },()=>{
  const self=processes.observeProcess(process.pid),receipt={version:1,provenance:processes.linuxProvenance(),roots:[self,{pid:2147483647,createdAt:'1'}],members:[self,{pid:2147483647,createdAt:'1'}]};
  const original=fs.readdirSync;fs.readdirSync=function(path,...args){if(path==='/proc')throw Object.assign(new Error('denied'),{code:'EACCES'});return original.call(this,path,...args)};syncBuiltinESMExports();
  try{assert.equal(processes.linuxStopIsGone(receipt),false)}finally{fs.readdirSync=original;syncBuiltinESMExports()}
});
