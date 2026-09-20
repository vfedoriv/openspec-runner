import { writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

// CLI contract from stablyai/orca fa0010e8d6b2a7ad946fe1f1b005c6a8497c6c17.
export function installFakeOrca(dir, root, bin) {
  const stateFile = join(dir, "orca-state.json"), log = join(dir, "orca-calls.jsonl");
  writeFileSync(stateFile, JSON.stringify({ runtimeId: "runtime-1", worktrees: [], terminals: [] }));
  const executable = join(bin, "orca");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = ${JSON.stringify(root)}, stateFile = ${JSON.stringify(stateFile)};
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (!args.includes('--json') || args[args.indexOf('--host') + 1] !== 'local') process.exit(2);
const flag = name => args[args.indexOf(name)+1];
const git = (...args) => cp.execFileSync('git', args, {cwd:root, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
const scope = s.missingScope ? {} : {hostScope:{hostIds:s.omitLocal?[]:['local'],omittedHostIds:s.omitLocal?['local']:[]}};
const terminal = () => s.terminals.find(t => t.handle === flag('--terminal'));
let result;
switch (args.slice(0,2).join(' ')) {
case 'status --host': result={target:{kind:s.remote?'environment':'local'},runtime:{runtimeId:s.runtimeId,reachable:!s.unreachable,state:s.unreachable?'not_running':'ready'}}; break;
case 'repo list': result={repos:[{id:'repo-1',path:root,executionHostId:'local'}]}; break;
case 'worktree list': result={worktrees:s.worktrees,totalCount:s.worktrees.length,truncated:!!s.truncated,...scope}; break;
case 'worktree show': {
 const selector=flag('--worktree');
 let w=s.worktrees.find(w=>selector==='id:'+w.id||selector==='path:'+w.path);
 if (!w && selector.startsWith('path:')) {
  const p=selector.slice(5);
  if(fs.existsSync(p)) w={id:'repo-1::'+p,repoId:'repo-1',path:p,hostId:'local',isMainWorktree:false,branch:cp.execFileSync('git',['branch','--show-current'],{cwd:p,encoding:'utf8'}).trim()};
 }
 result={worktree:w}; break;
}
case 'worktree create': {
 const name=flag('--name'), branch='orca-prefix/'+name, p=path.join(${JSON.stringify(dir)},'orca workspaces',name);
 fs.mkdirSync(path.dirname(p),{recursive:true});
 git('worktree','add','-b',branch,p,s.wrongBase?'main':flag('--base-branch'));
 const w={id:'repo-1::'+p,repoId:'repo-1',path:p,branch,head:git('rev-parse',branch),hostId:'local',isMainWorktree:false,comment:flag('--comment')};
 s.worktrees.push(w); save();
 if(s.failWorktreeAfterCreate) process.exit(1);
 result={worktree:w}; break;
}
case 'terminal create': {
 const worktreeId=flag('--worktree').slice(3), worktreePath=worktreeId.slice('repo-1::'.length);
 const t={handle:'term-'+(s.terminals.length+1),worktreeId,worktreePath,ptyId:'pty-1',incarnationId:'inc-1',tabId:'tab-1',leafId:'leaf-1',executionHostId:'local',hostPlatform:process.platform,title:flag('--title'),connected:true,writable:true};
 s.terminals.push(t); save();
 if(s.failTerminalAfterCreate) process.exit(1);
 result={terminal:s.malformedTerminal?{handle:t.handle}:t}; break;
}
case 'terminal list': result={terminals:s.terminals.filter(t=>t.worktreeId===flag('--worktree').slice(3)),totalCount:s.terminals.length,truncated:!!s.truncated,...scope}; break;
case 'terminal switch': result={focus:{handle:terminal()?.handle,worktreeId:terminal()?.worktreeId}}; break;
case 'terminal read': result={terminal:{handle:terminal()?.handle,status:s.live?'running':'exited',tail:['worker finished'],nextCursor:null,truncated:false}}; break;
case 'terminal close': {
 const handle=flag('--terminal');
 if(!s.closeFailure) s.terminals=s.terminals.filter(t=>t.handle!==handle);
 save(); result={close:{handle,tabId:'tab-1',ptyKilled:false,...(s.closeFailure?{ptyStopVerdict:'unverifiable'}:{})}}; break;
}
default: console.error('Unexpected Orca command',args); process.exit(2);
}
console.log(JSON.stringify(s.errorEnvelope?{ok:false,error:{code:'failed'}}:{ok:true,result,_meta:{runtimeId:s.runtimeId}}));
`);
  chmodSync(executable, 0o755);
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  return {
    state,
    set: values => writeFileSync(stateFile, JSON.stringify({ ...state(), ...values })),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
  };
}
