import {test} from "node:test";import assert from "node:assert/strict";
import * as lifecycle from "../dist/harnesses/lifecycle.js";
const attempt=()=>({agent:"copilot",phase:"failed",session:"root",observedSession:"root",identityConfirmed:true,terminalEvidence:{type:"agent-stop"},worker:{pid:101,processStart:"2026-11-04T00:00:00Z",processPlatform:"win32",exitedAt:"2026-11-04T00:01:00Z",exitCode:null,terminationUncertain:true,launcher:{pid:102,processStart:"2026-11-04T00:00:01Z"}}});
const proof={platform:"win32",processIsGone:()=>true,treeIsGone:()=>true};
test("provably stopped interrupted Copilot launcher permits retry without successful completion",()=>{
 const a=attempt();assert.equal(typeof lifecycle.recoverCopilotLauncher,"function");lifecycle.recoverCopilotLauncher(a,proof);
 assert.equal(lifecycle.agentMayBeActive(a),false);assert.ok(a.worker.launcher.exitedAt);assert.equal(a.worker.launcher.exitCode,null);assert.equal(a.worker.exitCode,null);assert.equal(a.worker.completion,undefined);assert.match(lifecycle.completionProblem(a),/successful completion|code null/);
});
test("Copilot recovery retains live, uncertain, reused and foreign-platform process evidence",()=>{
 for(const [edit,probe] of [[()=>{}, {...proof,processIsGone:()=>false}],[()=>{}, {...proof,treeIsGone:()=>false}],[a=>{delete a.worker.launcher.processStart},proof],[a=>{a.worker.processPlatform="linux"},proof],[a=>{delete a.worker.exitedAt},proof],[a=>{delete a.terminalEvidence},proof],[a=>{a.observedSession="other"},proof],[a=>{a.agent="copilot-vscode"},proof]]){
  const a=attempt();edit(a);const before=structuredClone(a);assert.equal(typeof lifecycle.recoverCopilotLauncher,"function");lifecycle.recoverCopilotLauncher(a,probe);assert.deepEqual(a,before);assert.equal(lifecycle.agentMayBeActive(a),true);
 }
});

import { recoveryFixture, copilotSettings } from "./helpers/copilot-recovery-fixture.mjs";
import { existsSync, readFileSync } from "node:fs";
import { Runner, decodeState } from "../dist/runner.js";
test("public Linux attempt cancellation retains failed evidence and permits a fresh exact retry", { skip: process.platform !== "linux", timeout: 30000 }, async t => {
 const x = await recoveryFixture(t);
 assert.throws(x.preview, /active|worker|running|attempt/i);
 x.prepare();
 await x.reconcile(); await x.reconcile();
 const a = x.current();
 assert.equal(a.phase, "failed"); assert.equal(a.worker.exitCode, null); assert.equal(a.worker.launcher.exitCode, null);
 assert.ok(a.worker.launcher.exitedAt); assert.equal(a.worker.completion, undefined); assert.ok(a.worker.linuxStop);
 assert.equal(a.session, 'session-'+a.id); assert.ok(existsSync(a.path)); assert.ok(existsSync(a.worker.log));
 x.preview(); assert.throws(() => x.r.integrate('demo',['1.1']), /completed|report|failed|exit/i);
 const replacement = x.r.launch('demo',['1.1'],copilotSettings,undefined,true,undefined,"copilot")[0];
 assert.notEqual(replacement.id,a.id);
 const before = readFileSync(x.r.path('demo'),'utf8');
 const old = new Runner(a.path);
 assert.throws(() => old.report('demo','1.1',a.id,a.report), /register|attempt/i);
 await assert.rejects(old.worker('demo','1.1',a.id), /attempt|current|latest/i);
 assert.throws(() => x.prepare(), /current exact/i);
 assert.equal(readFileSync(x.r.path('demo'),'utf8'),before);
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { linuxStopIsGone } from "../dist/platform-process.js";

for (const managed of [false,true]) test(`public Linux ${managed ? "job" : "attempt"} preparation rejects stale bindings without changing state bytes`, { skip: process.platform !== "linux", timeout: 30000 }, async t => {
 for (const mutation of ["generation", "nonce", "session", "worktree", "report", "identity", "stoppedAt"]) await t.test(mutation, async t => {
  const x = await recoveryFixture(t, managed);
  if (mutation === "report") {
   const file = join(x.r.repo.stateDir,"reports",`${x.a.id}.json`), report = JSON.parse(readFileSync(file));
   report.summary = "different accepted report"; writeFileSync(file,JSON.stringify(report));
  } else if (mutation === "identity") {
   const state = JSON.parse(readFileSync(x.statePath));
   delete (managed ? state.jobs : state.attempts)[0].worker.linuxIdentity;
   writeFileSync(x.statePath,JSON.stringify(state));
  } else {
   const file = join(x.r.repo.stateDir,"hooks",`${x.a.id}.json`), lease = JSON.parse(readFileSync(file));
   lease[mutation] = "stale"; writeFileSync(file,JSON.stringify(lease));
  }
  const before=readFileSync(x.statePath,'utf8');
  assert.throws(x.prepare,/binding|mismatch|generation/);
  assert.equal(readFileSync(x.statePath,'utf8'),before);
  assert.equal(x.current().worker.linuxStop,undefined); assert.throws(x.preview,/active|worker|running|attempt/i);
 });
});

for (const managed of [false,true]) test(`public Linux ${managed ? "job" : "attempt"} interrupted acknowledgement recovers from durable receipt`, { skip: process.platform !== "linux", timeout: 30000 }, async t => {
 const x = await recoveryFixture(t,managed), owner=managed?x.f:x.r, save=owner.save.bind(owner);
 let calls=0;
 owner.save = state => { if(++calls===2) throw new Error('injected acknowledgement save failure'); return save(state); };
 assert.throws(x.prepare,/injected/); owner.save=save;
 assert.ok(x.current().worker.linuxStop); assert.equal(x.current().worker.exitedAt,undefined);
 await new Promise(resolve=>setTimeout(resolve,50));
 await x.reconcile(); await x.reconcile(); x.preview();
 assert.equal(x.current().worker.exitCode,null); assert.equal(x.current().worker.launcher.exitCode,null);
 assert.equal(x.current().worker.completion,undefined); assert.equal(x.current().phase,'failed');
});

for (const managed of [false,true]) test(`public Linux ${managed ? "job" : "attempt"} failed publication never sends terminal signals`, { skip: process.platform !== "linux", timeout: 30000 }, async t => {
 const x = await recoveryFixture(t,managed), owner=managed?x.f:x.r, save=owner.save.bind(owner);
 const before=JSON.stringify(managed?x.f.read('demo'):x.r.read('demo'));
 owner.save=()=>{throw new Error('injected receipt failure')};
 assert.throws(x.prepare,/injected/); owner.save=save;
 assert.equal(JSON.stringify(managed?x.f.read('demo'):x.r.read('demo')),before);
 assert.equal(x.current().worker.linuxStop,undefined);
 assert.throws(x.preview,/active|worker|running|attempt/i);
});

test("Linux generated receipt truth table rejects uncertainty and truncated retained identities", { skip: process.platform !== "linux", timeout: 30000 }, async t => {
 const x=await recoveryFixture(t); x.prepare(); const a=x.current(), original=a.worker.linuxStop.receipt;
 assert.equal(linuxStopIsGone(original),true); lifecycle.validateLinuxWorker(a.worker);
 for(const mutate of [
  r=>r.provenance.platform='win32',r=>r.provenance.machine='0'.repeat(32),r=>r.provenance.boot='0'.repeat(36),
  r=>r.provenance.namespace='pid:[0]',r=>r.members.push({...r.members[0]}),r=>r.roots[0].createdAt='2026-11-04T00:00:00Z',
  r=>r.version=2,r=>r.members=[],r=>r.roots=[]
 ]) {const r=structuredClone(original);mutate(r);assert.equal(linuxStopIsGone(r),false);}
 const worker=structuredClone(a.worker);
 worker.linuxObserved=[...worker.linuxObserved??[],{pid:2147483646,createdAt:'1'}];
 assert.throws(()=>lifecycle.validateLinuxWorker(worker),/roots|recovery/i);
 const malformed=x.r.read("demo");malformed.attempts[0].worker=worker;
 assert.throws(()=>decodeState(JSON.parse(JSON.stringify(malformed))),/roots|recovery/i);
 const live=structuredClone(original);
 const self=(await import('../dist/platform-process.js')).observeProcess(process.pid);
 live.members.push(self);assert.equal(linuxStopIsGone(live),false);
 live.members.at(-1).createdAt='0';assert.equal(linuxStopIsGone(live),false);
 for(const edit of [a=>a.worker.linuxStop.binding='f'.repeat(64),a=>a.session='other',a=>a.worker.token='old',a=>a.report.summary='changed',a=>delete a.worker.linuxStop]){
  const clone=structuredClone(a);edit(clone);delete clone.worker.launcher.exitedAt;
  const before=structuredClone(clone);lifecycle.recoverCopilotLauncher(clone,undefined,x.r.repo.common);assert.deepEqual(clone,before);
 }
});

for (const managed of [false,true]) test(`public Linux ${managed?"job":"attempt"} resumes explicit cancellation after durable publication interruption`, { skip: process.platform !== "linux", timeout: 30000 }, async t => {
 const x=await recoveryFixture(t,managed),owner=managed?x.f:x.r,save=owner.save.bind(owner);
 owner.save=state=>{save(state);throw new Error('interrupted after durable receipt')};
 assert.throws(x.prepare,/interrupted/);owner.save=save;
 const receipt=x.current().worker.linuxStop;
 assert.ok(receipt);assert.equal(linuxStopIsGone(receipt.receipt),false);
 const before=JSON.stringify(managed?x.f.read('demo'):x.r.read('demo'));
 if(managed)assert.throws(x.reconcile,/running|uncertain/);else await assert.rejects(x.reconcile(),/running|uncertain/);
 assert.equal(JSON.stringify(managed?x.f.read('demo'):x.r.read('demo')),before);
 x.prepare();await x.reconcile();x.preview();
 assert.equal(x.current().phase,'failed');assert.equal(x.current().worker.exitCode,null);
 assert.equal(x.current().worker.completion,undefined);
});

test("unprepared historical Linux roots remain blocked after disappearing", { skip: process.platform !== "linux", timeout: 30000 }, async t=>{
 const x=await recoveryFixture(t),a=x.current();
 process.kill(a.worker.launcher.pid,'SIGKILL');process.kill(a.worker.pid,'SIGKILL');
 await new Promise(resolve=>setTimeout(resolve,100));
 await x.reconcile();assert.throws(x.preview,/stopped|active|worker|attempt/i);
 assert.equal(x.current().worker.linuxStop,undefined);assert.equal(x.current().worker.completion,undefined);
 assert.equal(x.current().worker.launcher.exitedAt,undefined);
 const before=readFileSync(x.r.path('demo'),'utf8');assert.throws(x.prepare,/roots disappeared/i);
 assert.equal(readFileSync(x.r.path('demo'),'utf8'),before);
});

test("public Linux cancellation finishes partial exact termination through explicit continuation", { skip: process.platform !== "linux", timeout: 30000 }, async t=>{
 const x=await recoveryFixture(t),kill=process.kill;let signals=0;
 process.kill=function(pid,signal){if(signal==='SIGKILL'&&++signals===2)throw new Error('interrupted second termination');return kill.call(this,pid,signal)};
 try{assert.throws(x.prepare,/interrupted/)}finally{process.kill=kill}
 const saved=x.current(),before=readFileSync(x.r.path('demo'),'utf8');
 assert.ok(saved.worker.linuxStop);assert.equal(saved.worker.exitedAt,undefined);
 assert.equal(linuxStopIsGone(saved.worker.linuxStop.receipt),false);
 await assert.rejects(x.reconcile(),/running|uncertain/);
 assert.equal(readFileSync(x.r.path('demo'),'utf8'),before);
 x.prepare();await x.reconcile();x.preview();assert.equal(x.current().worker.exitCode,null);
});

test("public Linux explicit continuation rejects externally resumed prepared members", { skip: process.platform !== "linux", timeout: 30000 }, async t=>{
 const x=await recoveryFixture(t),save=x.r.save.bind(x.r);
 x.r.save=state=>{save(state);throw new Error('interrupted after durable receipt')};
 assert.throws(x.prepare,/interrupted/);x.r.save=save;
 const a=x.current(),before=readFileSync(x.r.path('demo'),'utf8');
 // External SIGCONT is deliberately outside the supported cancellation protocol.
 process.kill(a.worker.launcher.pid,'SIGCONT');await new Promise(resolve=>setTimeout(resolve,30));
 assert.throws(x.prepare,/resumed|uncertain/);
 assert.equal(readFileSync(x.r.path('demo'),'utf8'),before);
 assert.throws(x.preview,/stopped|active|worker|attempt/i);
});
