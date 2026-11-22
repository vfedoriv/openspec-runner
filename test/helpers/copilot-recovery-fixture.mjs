import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureFixture, executable, featureSettings, git } from "./feature-fixture.mjs";
import { observeProcess } from "../../dist/platform-process.js";

export const copilotSettings = { harness: "copilot", model: "auto" };
const moduleUrl = name => new URL(`../../dist/${name}.js`, import.meta.url).href;
export async function recoveryFixture(t, managed = false, options = {}) {
  const fixture = featureFixture(t, { unchecked: !managed });
  const { root, bin, dir, r, f } = fixture;
  mkdirSync(join(root, ".github/hooks"), { recursive: true });
  writeFileSync(join(root, ".github/hooks/openspec-runner.json"), JSON.stringify({ hooks: { UserPromptSubmit: [], Stop: [] } }));
  git(root, "add", "."); git(root, "commit", "-m", "Install fixture hooks");
  const ready = join(dir, "root-stopped");
  const reportGate = join(dir, "allow-report");
  executable(join(bin, "copilot"), `
if(process.argv.includes('--help')) { console.log('--model --trust-folder --prompt --add-dir --allow-tool'); process.exit(0); }
if(process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
(async()=>{
 const fs=require('node:fs');
 const {Runner}=await import(${JSON.stringify(moduleUrl("runner"))});
 const {Feature}=await import(${JSON.stringify(moduleUrl("feature"))});
 const {recordHook}=await import(${JSON.stringify(moduleUrl("harnesses/copilot-hooks"))});
 const r=new Runner(process.cwd()), f=new Feature(process.cwd());
 const a=${managed ? "f.read('demo').jobs.at(-1)" : "r.read('demo').attempts.at(-1)"};
 const prompt=process.argv[process.argv.indexOf('-p')+1],session='session-'+a.id;
 const event=kind=>({kind,session,cwd:process.cwd(),at:new Date().toISOString(),...(kind==='prompt'?{prompt}:{})});
 recordHook({stateDir:r.repo.stateDir,event:event('prompt')});
 ${managed ? "f.begin('demo',a.id,session)" : "r.begin('demo',a.task,a.id,session)"};
 ${options.driverControlled ? `while(!fs.existsSync(${JSON.stringify(reportGate)}))await new Promise(resolve=>setTimeout(resolve,10));` : ""}
 const report={attempt:a.id,session,outcome:'completed',summary:'Stopped fixture',verification:['Verified fixture'],
   ${managed ? "head:a.base,fingerprint:a.fingerprint" : "task:a.task"}};
 ${managed ? "report.findings=[];" : `fs.writeFileSync('result.txt','completed fixture\\n');
 const cp=require('node:child_process');cp.execFileSync('git',['add','result.txt']);cp.execFileSync('git',['commit','-m','Complete task']);
 report.commit=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();`}
 ${managed ? "f.report('demo',a.id,report)" : "r.report('demo',a.task,a.id,report)"};
 await new Promise(resolve=>setTimeout(resolve,${options.pauseBeforeStopMs ?? 0}));
 const {observeProcess}=await import(${JSON.stringify(moduleUrl("platform-process"))});
 const parent=observeProcess(process.ppid),lock=r.repo.stateDir+'/lock.json';
 const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
 const deadline=Date.now()+5000;
 while(true){
  if(Date.now()>deadline)throw new Error('Could not suspend supervisor outside lock');
  if(fs.existsSync(lock)){await pause();continue;}
  if(observeProcess(parent.pid)?.createdAt!==parent.createdAt)throw new Error('Supervisor identity changed');
  process.kill(parent.pid,'SIGSTOP');
  while(observeProcess(parent.pid)?.state!=='T')await pause();
  let owner;try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(owner?.pid===parent.pid){process.kill(parent.pid,'SIGCONT');await pause();continue;}
  break;
 }

 recordHook({stateDir:r.repo.stateDir,event:event('stop')});
 fs.writeFileSync(${JSON.stringify(ready)},'ready');
 setInterval(()=>{},1000);
})().catch(e=>{console.error(e);process.exit(1)});
`);
  let a;
  if (managed) {
    fixture.approve({ ...featureSettings, review: copilotSettings });
    a = f.launch("demo", "review");
  } else a = r.launch("demo", ["1.1"], copilotSettings, undefined, false, undefined, "copilot")[0];
  const saveLog = join(dir, "supervisor-saves.jsonl");
  const supervisor = spawn(process.execPath, ["--input-type=module", "-e", `
import {Runner} from ${JSON.stringify(moduleUrl("runner"))};
import {Feature} from ${JSON.stringify(moduleUrl("feature"))};
const owner = ${managed ? `new Feature(${JSON.stringify(root)})` : `new Runner(${JSON.stringify(root)})`};
${options.instrumentSaves ? `const fs = await import('node:fs'), save = owner.save.bind(owner);
owner.save = state => { fs.appendFileSync(${JSON.stringify(saveLog)},JSON.stringify(state)+'\\n'); return save(state); };` : ""}
await ${managed ? `owner.worker('demo',${JSON.stringify(a.id)})` : `owner.worker('demo','1.1',${JSON.stringify(a.id)})`};
`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", launcherPid;
  supervisor.stdout.on("data", bytes => { output += bytes; }); supervisor.stderr.on("data", bytes => { output += bytes; });
  const current = () => managed ? f.read("demo").jobs.find(j => j.id === a.id) : r.read("demo").attempts.find(j => j.id === a.id);
  t.after(() => {
    for (const pid of [launcherPid, supervisor.pid]) if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    try { supervisor.kill("SIGKILL"); } catch {}
  });
  const deadline = Date.now() + 15000;
  const fixtureReady = () => options.driverControlled ? !!current()?.session : existsSync(ready);
  while (!fixtureReady() && Date.now() < deadline && supervisor.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fixtureReady(), `fake Copilot did not reach readiness: ${output}; ${existsSync(current()?.worker?.log ?? '') ? readFileSync(current().worker.log,'utf8') : ''}`);
  launcherPid = current().worker.launcher.pid;
  if (!options.driverControlled) assert.equal(observeProcess(supervisor.pid)?.state, "T");
  const prepare = () => managed ? f.prepareCopilotStop("demo", a.id, { cancel: true }) : r.prepareCopilotStop("demo", "1.1", a.id, { cancel: true });
  const reconcile = () => managed ? f.recover("demo", a.id) : r.worker("demo", "1.1", a.id);
  const preview = () => managed ? f.jobPreview("demo", "review", true) : r.preview("demo", ["1.1"], copilotSettings, undefined, true, "copilot");
  return { ...fixture, a, supervisor, current, prepare, reconcile, preview, saveLog, reportGate, statePath: managed ? join(r.repo.stateDir, "features", "demo.json") : r.path("demo") };
}
