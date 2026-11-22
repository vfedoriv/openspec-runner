import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const p = await import(process.env.TASK4_PLATFORM_MODULE ?? new URL("../dist/platform-process.js", import.meta.url).href);
const { validateLinuxWorker } = await import(process.env.TASK4_LIFECYCLE_MODULE ?? new URL("../dist/harnesses/lifecycle.js", import.meta.url).href);
import { recoveryFixture } from "./helpers/copilot-recovery-fixture.mjs";
import { linuxPidfdOptions } from "./helpers/linux-pidfd-support.mjs";
const pidfd = { ...linuxPidfdOptions, timeout: 30000 };
const linux = { skip: process.platform !== "linux", timeout: 30000 };
async function children(t, count=2) {
  const result=Array.from({length:count},()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}));
  await Promise.all(result.map(c=>once(c,'spawn')));
  t.after(()=>{for(const c of result)try{c.kill('SIGKILL')}catch{}});
  return result.map(c=>p.observeProcess(c.pid));
}
function mockBuiltin(t, name, fn) {
  const original=fs[name];fs[name]=fn(original);syncBuiltinESMExports();
  t.after(()=>{fs[name]=original;syncBuiltinESMExports()});
}

test("initial Linux census retains a child visible only before reparenting",pidfd,async t=>{
  const [root,launcher,child]=await children(t,3);let reads=0;
  mockBuiltin(t,'readFileSync',original=>function(path,...args){
    const value=original.call(this,path,...args);
    if(path===`/proc/${child.pid}/stat`&&++reads===1){const at=value.lastIndexOf(')')+2,fields=value.slice(at).split(' ');fields[1]=String(root.pid);return value.slice(0,at)+fields.join(' ')}
    return value;
  });
  const receipt=p.prepareLinuxStop({provenance:p.linuxProvenance(),roots:[root,launcher],retained:[],timeoutMs:3000,publish(receipt){assert.ok(receipt.members.some(m=>m.pid===child.pid))}});
  assert.ok(receipt.members.some(m=>m.pid===child.pid));
});

test("Linux provenance rejects inherited multi-entry PID namespace views",linux,t=>{
  mockBuiltin(t,'readFileSync',original=>function(path,...args){
    const value=original.call(this,path,...args);
    return path==='/proc/self/status'?value.replace(/^NSpid:.*$/m,`NSpid:\t${process.pid} ${process.pid}`):value;
  });
  assert.equal(p.linuxProvenance(),undefined);
});

test("Linux proof rejects zombie leader with runnable sibling and per-thread tracing stop",linux,async t=>{
  const roots=await children(t);const receipt={version:1,provenance:p.linuxProvenance(),roots,members:roots};
  let state='R';
  mockBuiltin(t,'readFileSync',original=>function(path,...args){
    if(typeof path==='string'&&/^\/proc\/\d+\/stat$/.test(path)){
      const value=original.call(this,path,...args),at=value.lastIndexOf(')')+2,fields=value.slice(at).split(' ');
      if(roots.some(r=>path===`/proc/${r.pid}/stat`)){fields[0]='Z';return value.slice(0,at)+fields.join(' ')}return value;
    }
    if(path===`/proc/${roots[0].pid}/task/2147483646/stat`){
      const value=original.call(this,`/proc/${roots[0].pid}/stat`,...args),at=value.lastIndexOf(')')+2,fields=value.slice(at).split(' ');fields[0]=state;return value.slice(0,at)+fields.join(' ');
    }
    return original.call(this,path,...args);
  });
  mockBuiltin(t,'readdirSync',original=>function(path,...args){const rows=original.call(this,path,...args);return path===`/proc/${roots[0].pid}/task`?[...rows,'2147483646']:rows});
  assert.equal(p.linuxStopIsGone(receipt),false);state='t';assert.equal(p.linuxStopIsGone(receipt),false);
});

test("known prepublication validation failure rolls back introduced stops",pidfd,async t=>{
  const roots=await children(t);let published=false;
  assert.throws(()=>p.prepareLinuxStop({provenance:p.linuxProvenance(),roots,retained:[],timeoutMs:3000,
    validate(){throw new Error('binding changed before publication')},publish(){published=true}}),/binding changed/);
  assert.equal(published,false);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(roots.every(r=>p.observeProcess(r.pid)?.state!=='T'));
});

for(const managed of [false,true])test(`prepared ${managed?'feature':'runner'} partial reconciliation preserves exact saved bytes`,pidfd,async t=>{
  const x=await recoveryFixture(t,managed),owner=managed?x.f:x.r,save=owner.save.bind(owner);
  owner.save=s=>{save(s);throw new Error('after durable receipt')};assert.throws(x.prepare,/durable/);owner.save=save;
  process.kill(x.current().worker.pid,'SIGKILL');await new Promise(resolve=>setTimeout(resolve,60));
  const before=fs.readFileSync(x.statePath,'utf8');
  await assert.rejects(async()=>x.reconcile(),/prepared|uncertain|stopped/i);
  assert.equal(fs.readFileSync(x.statePath,'utf8'),before);
  x.prepare();await x.reconcile();x.preview();
});

test("canonical prepared integrity rejects truncating a barrier-only member",pidfd,async t=>{
  const x=await recoveryFixture(t),[child]=await children(t,1),original=fs.readFileSync;let seen=0;
  fs.readFileSync=function(path,...args){const value=original.call(this,path,...args);
    if(path===`/proc/${child.pid}/stat`&&seen++<2){const at=value.lastIndexOf(')')+2,fields=value.slice(at).split(' ');fields[1]=String(x.current().worker.launcher.pid);return value.slice(0,at)+fields.join(' ')}return value};syncBuiltinESMExports();
  try{x.prepare()}finally{fs.readFileSync=original;syncBuiltinESMExports()}
  const worker=x.current().worker;assert.ok(worker.linuxStop.receipt.members.some(m=>m.pid===child.pid));
  assert.ok(!worker.linuxObserved.some(m=>m.pid===child.pid));
  worker.linuxStop.receipt.members=worker.linuxStop.receipt.members.filter(m=>m.pid!==child.pid);
  assert.throws(()=>validateLinuxWorker(worker),/integrity|receipt/i);
});

test("Linux cancellation exposes identity-bound pidfd signaling",linux,async()=>{
  const signals=await import('../dist/linux-signal.js').catch(()=>({}));
  assert.equal(typeof signals.probeLinuxSignals,'function');assert.equal(typeof signals.signalLinuxIdentity,'function');
});

import cp from "node:child_process";
import { probeLinuxSignals, signalLinuxIdentity } from "../dist/linux-signal.js";

test("pidfd signals reject wrong identity, missing Python and unavailable pidfd without touching sentinel",linux,async t=>{
  const [sentinel]=await children(t,1),provenance=p.linuxProvenance();
  assert.throws(()=>signalLinuxIdentity({...sentinel,createdAt:'0'},provenance,'SIGKILL'),/identity|uncertain/);
  const path=process.env.PATH;
  process.env.PATH='';try{assert.throws(()=>probeLinuxSignals(provenance),/Python 3.*pidfd/)}finally{process.env.PATH=path}
  const execute=cp.execFileSync;
  cp.execFileSync=function(command,args,options){
    if(command==='python3')args=args.map((value,index)=>index===3?'import os; del os.pidfd_open\n'+value:value);
    return execute.call(this,command,args,options);
  };syncBuiltinESMExports();
  try{assert.throws(()=>probeLinuxSignals(provenance),/Python 3.*pidfd/);assert.throws(()=>signalLinuxIdentity(sentinel,provenance,'SIGKILL'),/pidfd/)}
  finally{cp.execFileSync=execute;syncBuiltinESMExports()}
  assert.ok(p.observeProcess(sentinel.pid));
});

test("exact Linux signals use pidfds without Node numeric signal fallback",pidfd,async t=>{
  const [sentinel]=await children(t,1),provenance=p.linuxProvenance(),kill=process.kill;
  process.kill=()=>{throw new Error('numeric signal forbidden')};
  try{
    probeLinuxSignals(provenance);signalLinuxIdentity(sentinel,provenance,'SIGSTOP');
    assert.equal(p.observeProcess(sentinel.pid).state,'T');
    signalLinuxIdentity(sentinel,provenance,'SIGCONT');
    signalLinuxIdentity(sentinel,provenance,'SIGSTOP');
    signalLinuxIdentity(sentinel,provenance,'SIGKILL');
  }finally{process.kill=kill}
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(p.processIsGone(sentinel.pid),true);
});

const { superviseCopilot } = await import(process.env.TASK4_SUPERVISOR_MODULE ?? new URL("../dist/harnesses/copilot-supervisor.js", import.meta.url).href);
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("supervisor Linux census happens inside the evidence lock callback",linux,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'linux-ledger-lock-')),bin=join(dir,'bin'),common=join(dir,'common');
  mkdirSync(bin);mkdirSync(common);mkdirSync(join(dir,'.github/hooks'),{recursive:true});
  writeFileSync(join(dir,'.github/hooks/openspec-runner.json'),JSON.stringify({hooks:{UserPromptSubmit:[],Stop:[]}}));
  const command=join(bin,'copilot');writeFileSync(command,'#!/usr/bin/env node\nsetInterval(()=>{},1000)');chmodSync(command,0o755);
  const path=process.env.PATH;process.env.PATH=bin+':'+path;
  t.after(()=>{process.env.PATH=path;rmSync(dir,{recursive:true,force:true})});
  let inEvidence=false,inside=0,outside=0;
  mockBuiltin(t,'readdirSync',original=>function(path,...args){if(path==='/proc'){if(inEvidence)inside++;else outside++}return original.call(this,path,...args)});
  const a={id:'attempt',agent:'copilot',path:dir,settings:{model:'auto',options:{startupTimeoutMs:250,completionTimeoutMs:1000}},worker:{token:'generation',log:join(dir,'log')}};
  await assert.rejects(superviseCopilot(a,common,'prompt',()=>{},fn=>{inEvidence=true;try{fn(a)}finally{inEvidence=false}}),/deadline/);
  // Cleanup's existing stopOwnedProcess has its own census outside evidence;
  // the supervisor's three periodic observations must all be inside the callback.
  assert.ok(inside>=2);assert.equal(outside,1);
});

test("pidfd cancellation kills an actual zombie leader's stopped live sibling threads",pidfd,async t=>{
  const source=`import ctypes, threading, time\ndef run():\n    while True: time.sleep(0.1)\nthreading.Thread(target=run).start()\nctypes.CDLL(None).pthread_exit(None)\n`;
  const threaded=spawn('python3',['-I','-S','-c',source],{stdio:'ignore'});
  await once(threaded,'spawn');t.after(()=>{try{threaded.kill('SIGKILL')}catch{}});
  const deadline=Date.now()+3000;let root;
  while(Date.now()<deadline){root=p.observeProcess(threaded.pid);if(root?.state==='Z')break;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(root?.state,'Z');
  const absent={pid:2147483647,createdAt:'1'};
  assert.equal(p.linuxStopIsGone({version:1,provenance:p.linuxProvenance(),roots:[root,absent],members:[root,absent]}),false);
  const [launcher]=await children(t,1);let published=false;
  const receipt=p.prepareLinuxStop({provenance:p.linuxProvenance(),roots:[root,launcher],retained:[],timeoutMs:3000,publish(){published=true}});
  assert.equal(published,true);assert.equal(p.linuxStopIsGone(receipt),true);
});

for(const managed of [false,true])test(`${managed?'Feature':'Runner'} supervisor skips unchanged ledger state saves`,linux,async t=>{
  const x=await recoveryFixture(t,managed,{pauseBeforeStopMs:600,instrumentSaves:true});
  const saves=fs.readFileSync(x.saveLog,'utf8').trim().split('\n');
  assert.ok(saves.length>=3);
  for(let index=1;index<saves.length;index++)assert.notEqual(saves[index],saves[index-1],'unchanged evidence must not fsync state again');
});

test("Node and pidfd helper reject malformed, missing and multi-entry namespace status",linux,async t=>{
  const provenance=p.linuxProvenance(),[sentinel]=await children(t,1);
  const original=fs.readFileSync;
  for(const mutate of [
    text=>text.replace(/^NSpid:.*$/m,`NSpid:\t${process.pid} ${process.pid}`),
    text=>text.replace(/^NStgid:.*$/m,`NStgid:\t${process.pid} ${process.pid}`),
    text=>text.replace(/^NSpid:.*$/m,''),
    text=>text.replace(/^Tgid:.*$/m,'Tgid:\t0'),
    text=>text.replace(/^Pid:.*$/m,'Pid:\t0'),
    text=>text.replace(/^NStgid:.*$/m,'NStgid:\tbad'),
  ]){
    fs.readFileSync=function(path,...args){const value=original.call(this,path,...args);return path==='/proc/self/status'?mutate(value):value};syncBuiltinESMExports();
    try{assert.equal(p.linuxProvenance(),undefined)}finally{fs.readFileSync=original;syncBuiltinESMExports()}
  }
  const execute=cp.execFileSync;
  cp.execFileSync=function(command,args,options){
    if(command==='python3')args=args.map((value,index)=>index===3?value.replace("status = stream.read().splitlines()","status = stream.read().replace('NSpid:\\t', 'NSpid:\\t0 ').splitlines()"):value);
    return execute.call(this,command,args,options);
  };syncBuiltinESMExports();
  try{assert.throws(()=>probeLinuxSignals(provenance),/coherent procfs/);assert.throws(()=>signalLinuxIdentity(sentinel,provenance,'SIGKILL'),/coherent procfs/)}
  finally{cp.execFileSync=execute;syncBuiltinESMExports()}
  assert.ok(p.observeProcess(sentinel.pid));
});

test("public binding recheck failure resumes launcher while preserving caller-stopped supervisor",pidfd,async t=>{
  const x=await recoveryFixture(t),a=x.current(),original=fs.readFileSync;let reads=0;
  const lease=join(x.r.repo.stateDir,'hooks',`${a.id}.json`),before=original(x.statePath,'utf8');
  fs.readFileSync=function(path,...args){const value=original.call(this,path,...args);
    if(path===lease&&++reads===3){const changed=JSON.parse(value);changed.nonce='changed-before-publication';return JSON.stringify(changed)}return value};syncBuiltinESMExports();
  try{assert.throws(x.prepare,/binding changed/)}finally{fs.readFileSync=original;syncBuiltinESMExports()}
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(original(x.statePath,'utf8'),before);assert.equal(x.current().worker.linuxStop,undefined);
  assert.equal(p.observeProcess(a.worker.pid).state,'T');assert.notEqual(p.observeProcess(a.worker.launcher.pid).state,'T');
});

for(const managed of [false,true])test(`prepared ${managed?'feature':'runner'} all-zombie supervisor acknowledges without generic PID guard`,pidfd,async t=>{
  const x=await recoveryFixture(t,managed),owner=managed?x.f:x.r,save=owner.save.bind(owner);let saves=0;
  owner.save=state=>{if(++saves===2)throw new Error('interrupted acknowledgement');return save(state)};
  assert.throws(x.prepare,/interrupted acknowledgement/);owner.save=save;
  const before=x.current();assert.equal(p.observeProcess(before.worker.pid)?.state,'Z');
  const execute=cp.execFileSync;let signals=0;
  cp.execFileSync=function(command,args,options){if(command==='python3'&&JSON.parse(options.input).operation!=='probe')signals++;return execute.call(this,command,args,options)};syncBuiltinESMExports();
  try{await x.reconcile()}finally{cp.execFileSync=execute;syncBuiltinESMExports()}
  const after=x.current();assert.equal(signals,0);assert.equal(after.phase,'failed');assert.equal(after.report.outcome,'completed');
  assert.equal(after.worker.exitCode,null);assert.equal(after.worker.launcher.exitCode,null);assert.ok(after.worker.launcher.exitedAt);
  assert.equal(after.worker.completion,undefined);assert.equal(after.session,before.session);x.preview();
});

test("termination sends no further signal after a late observed group failure",pidfd,async t=>{
  const roots=await children(t),provenance=p.linuxProvenance();let receipt;
  assert.throws(()=>p.prepareLinuxStop({provenance,roots,retained:[],timeoutMs:3000,publish(value){receipt=value;throw new Error('published interruption')}}),/published interruption/);
  const path=`/proc/${receipt.members.at(-1).pid}/task`,read=fs.readdirSync,execute=cp.execFileSync;
  let reads=0,failed=false,signalsAfterFailure=0;
  fs.readdirSync=function(target,...args){if(target===path&&++reads>=5){failed=true;throw Object.assign(new Error('denied'),{code:'EACCES'})}return read.call(this,target,...args)};
  cp.execFileSync=function(command,args,options){if(command==='python3'&&JSON.parse(options.input).operation==='SIGKILL'&&failed)signalsAfterFailure++;return execute.call(this,command,args,options)};syncBuiltinESMExports();
  try{assert.throws(()=>p.finishPreparedLinuxStop(receipt,1000),/uncertain|observation|deadline/)}
  finally{fs.readdirSync=read;cp.execFileSync=execute;syncBuiltinESMExports()}
  assert.equal(failed,true);assert.equal(signalsAfterFailure,0);
});
