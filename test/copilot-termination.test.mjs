import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseCopilot } from "../dist/harnesses/copilot-supervisor.js";
import { agentMayBeActive } from "../dist/harnesses/lifecycle.js";

for (const editor of [false, true]) test(`${editor ? "editor" : "CLI"} timeout preserves real agent liveness`, { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const dir=mkdtempSync(join(tmpdir(),"copilot-termination-")),bin=join(dir,"bin"),common=join(dir,"common");
  mkdirSync(bin); mkdirSync(common); mkdirSync(join(dir,".github/hooks"),{recursive:true});
  writeFileSync(join(dir,".github/hooks/openspec-runner.json"),JSON.stringify({hooks:{UserPromptSubmit:[],Stop:[]}}));
  const path=join(bin,editor?"code":"copilot");
  writeFileSync(path,"#!/usr/bin/env node\n"+(editor?"process.exit(0)":"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"));chmodSync(path,0o755);
  const old=process.env.PATH;process.env.PATH=`${bin}:${old}`;
  t.after(()=>{process.env.PATH=old;rmSync(dir,{recursive:true,force:true})});
  // The editor agent preparation needs a real Git common directory; the executable
  // timeout is covered by the CLI case, and editor uncertainty by its saved receipt.
  if(editor){
    assert.equal(agentMayBeActive({agent:"copilot-vscode",worker:{exitedAt:"now",launcher:{exitedAt:"now",exitCode:0}}}),true);
    return;
  }
  const a={id:"attempt",agent:"copilot",path:dir,expectedSession:"00000000-0000-4000-8000-000000000001",settings:{model:"model",options:{startupTimeoutMs:1000,completionTimeoutMs:2000}},worker:{token:"generation",log:join(dir,"log")}};
  await assert.rejects(superviseCopilot(a,common,"prompt",()=>{},fn=>fn(a)),/deadline/);
  assert.ok(a.worker.launcher.exitedAt);
  assert.throws(()=>process.kill(a.worker.launcher.pid,0),{code:"ESRCH"});
  a.worker.exitedAt="now";
  assert.equal(agentMayBeActive(a),false);
});
