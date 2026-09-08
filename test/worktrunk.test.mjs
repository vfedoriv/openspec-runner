import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorktree } from '../dist/adapters.js';
import { quote } from '../dist/system.js';
let wt;try{wt=execFileSync('which',['wt'],{encoding:'utf8'}).trim();}catch{}
test('installed Worktrunk creates from explicit base with isolated configuration',{skip:!wt},t=>{
  const root=mkdtempSync(join(tmpdir(),'runner real wt ')),repo=join(root,'repo'),bin=join(root,'bin');mkdirSync(repo);mkdirSync(bin);
  const oldPath=process.env.PATH;t.after(()=>{process.env.PATH=oldPath;rmSync(root,{recursive:true,force:true});});
  const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');writeFileSync(join(repo,'base.txt'),'base');git('add','.');git('commit','-m','base');
  const config=join(root,'wt.toml');writeFileSync(config,'');writeFileSync(join(bin,'wt'),`#!/bin/sh\nexec ${quote(wt)} --config ${quote(config)} "$@"\n`);chmodSync(join(bin,'wt'),0o755);process.env.PATH=bin+':'+oldPath;
  const base=git('rev-parse','HEAD');const result=createWorktree(repo,{branch:'runner-real-test',path:join(root,'fallback'),base},'worktrunk');
  assert.equal(result.base,base);assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:result.path,encoding:'utf8'}).trim(),base);
  assert.equal(createWorktree(repo,result,'worktrunk').path,result.path);
});
