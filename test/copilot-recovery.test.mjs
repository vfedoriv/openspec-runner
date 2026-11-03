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
