import { codexDiagnostics } from "./helpers/codex-diagnostics.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { stringify } from "yaml";
import { harnessIds } from "../dist/harnesses/registry.js";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Runner } from "../dist/runner.js";
import { init } from "../dist/cli.js";
import { Feature } from "../dist/feature.js";

const supported = ["codex", "claude", "copilot", "copilot-vscode"];
test("native lifecycle matrix includes every registered harness", () => assert.deepEqual([...harnessIds()].sort(), [...supported].sort()));
for (const id of supported) test(`${id} supervises implementation, review, repair and integration`, { timeout: 240000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-e2e-")), root = join(dir, "repo spaces"), bin = join(dir, "bin");
  mkdirSync(root); mkdirSync(bin);
  const old = process.env.PATH; process.env.PATH = `${bin}${delimiter}${old}`;
  t.after(() => { process.env.PATH = old; rmSync(dir, { recursive: true, force: true }); });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const executable = (name, body) => { const path = join(bin, name); writeFileSync(path, `#!/usr/bin/env node\n${codexDiagnostics}\n${body}`); chmodSync(path, 0o755); };
  executable("openspec", "console.log(JSON.stringify(process.argv[2] === 'status' ? {artifacts:[]} : {state:'ready'}));");
  git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Runner Test");
  init(root, id, undefined, "model");
  const config = join(root, "openspec/runner.yaml");
  writeFileSync(config, stringify({ version: 2, defaultAgent: id, agents: { [id]: { defaultModel: "model", ...(id === "claude" ? { permissionMode: "dontAsk", allowedTools: [] } : {}), ...(id.startsWith("copilot") ? { options: { startupTimeoutMs: 30000, completionTimeoutMs: 60000 } } : {}) } }, worktrees: "git", terminal: "manual", cleanup: "manual" }));
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Implement result\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), stringify({ version: 2, agent: id, tasks: { "1.1": id === "codex" ? { effort: "high" } : {} } }));
  writeFileSync(join(root, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  const runnerModule = new URL("../dist/runner.js", import.meta.url).href;
  const featureModule = new URL("../dist/feature.js", import.meta.url).href;
  const runnerBin = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
  const helper = join(bin, "worker.mjs");
  const findings = join(bin, "findings.json"); writeFileSync(findings, "[]");
  writeFileSync(helper, `import { Runner } from ${JSON.stringify(runnerModule)}; import {Feature} from ${JSON.stringify(featureModule)};
    import { execFileSync } from 'node:child_process'; import {writeFileSync,readFileSync} from 'node:fs';
    import { randomUUID } from 'node:crypto';
    const prompt=process.argv[2], session=process.argv[3]||randomUUID(), harness=${JSON.stringify(id)};
    const attempt=prompt.match(/Attempt: ([a-zA-Z0-9_-]+)/)[1];
    const hook=(event,extra={})=>execFileSync(process.execPath,[${JSON.stringify(runnerBin)},'hook',event],{input:JSON.stringify({session_id:session,cwd:process.cwd(),timestamp:new Date().toISOString(),...extra}),encoding:'utf8'});
    if(harness.startsWith('copilot')) hook('UserPromptSubmit',{prompt});
    if(harness==='codex') process.env.CODEX_THREAD_ID=session;
    if(harness==='claude') { if(process.env.CODEX_THREAD_ID) throw new Error('Codex identity leaked'); console.log(JSON.stringify({type:'system',session_id:session})); }
    const r=new Runner(process.cwd()), role=prompt.match(/Role: (review|repair)/)?.[1], f=new Feature(process.cwd());
    if(role) f.begin('demo',attempt,harness==='claude'?session:undefined); else r.begin('demo','1.1',attempt,harness==='claude'?session:undefined);
    if(role!=='review') { const path=role==='repair'?'repair.txt':'result.txt';writeFileSync(path,'done'); execFileSync('git',['add',path]); execFileSync('git',['commit','-m','worker result']); }
    const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    if(role) {const j=f.read('demo').jobs.find(j=>j.id===attempt);f.report('demo',attempt,{attempt,session,outcome:'completed',head:j.base,fingerprint:j.fingerprint,summary:role,verification:['checked'],...(role==='review'?{findings:JSON.parse(readFileSync(${JSON.stringify(findings)},'utf8'))}:{commit})});}
    else r.report('demo','1.1',attempt,{attempt,task:'1.1',session,outcome:'completed',commit,summary:'implemented',verification:['result checked']});
    await new Promise(r=>setTimeout(r,150));
    if(harness.startsWith('copilot')) hook('Stop');
    if(harness==='claude') console.log(JSON.stringify({type:'result',session_id:session,subtype:'success'}));
  `);
  const script = `const args=process.argv.slice(2);
    if(args.includes('--version')) console.log('1.0');
    else if(args.includes('--help')) console.log('--mode --new-window --model --session-id --add-dir --allow-tool --cd --json -p --output-format stream-json --verbose --resume --permission-mode --allowedTools --effort');
    else if(args.includes('--list-extensions')) console.log('GitHub.copilot-chat');
    else if(args[0]==='app-server') {require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id) console.log(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{model:'model',id:'model',defaultReasoningEffort:'high'}],nextCursor:null}:{}}));});}
    else if(args[0]==='exec') {const c=require('node:child_process').spawn(process.execPath,[${JSON.stringify(helper)},args.at(-1)],{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));}
    else if(${JSON.stringify(id)}==='copilot-vscode' && (args[0]!=='chat'||args.length===3)) process.exit(0);
    else if(args[0]==='chat') { const {spawn}=require('node:child_process'),{openSync}=require('node:fs');const fd=openSync(${JSON.stringify(join(bin, "editor.log"))},'a'); const c=spawn(process.execPath,[${JSON.stringify(helper)},args.at(-1)],{cwd:process.cwd(),stdio:['ignore',fd,fd],detached:true,windowsHide:true}); c.unref(); }
    else { let text=''; process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{ const {spawn}=require('node:child_process');const c=spawn(process.execPath,[${JSON.stringify(helper)},text,args[args.indexOf('--session-id')+1]],{stdio:'inherit'});c.on('exit',code=>process.exit(code??1)); }); }
  `;
  for (const name of ["copilot", "code", "codex", "claude"]) executable(name, script);
  const runner = new Runner(root), feature = new Feature(root);
  feature.start("demo");
  const role = { harness: id, model: "model", ...(id === "codex" ? { effort: "high" } : {}) };
  const settings = { implementation: role, review: role, repair: role };
  feature.approve("demo", settings, feature.planPreview("demo", settings).token);
  const beforePreview = git("worktree", "list", "--porcelain");
  const preview = JSON.parse(execFileSync(process.execPath, [runnerBin, "launch", "demo", "--tasks", "1.1", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
  assert.equal(preview.agent, id);
  assert.equal(git("worktree", "list", "--porcelain"), beforePreview);
  const runJob = async job => { try { return await feature.worker("demo", job.id); } catch (error) {
    const saved=feature.read("demo").jobs.find(j=>j.id===job.id);
    throw new Error(String(error)+"\n"+readFileSync(saved.worker.log,"utf8")+"\n"+(id==='copilot-vscode'?readFileSync(join(bin,'editor.log'),'utf8'):''));
  } };
  const attempt = runner.launch("demo", ["1.1"])[0];
  const result = await runner.worker("demo", "1.1", attempt.id);
  assert.equal(result.exitCode, 0, readFileSync(result.log, "utf8"));
  const saved = runner.read("demo").attempts[0];
  if (id !== "codex") { assert.equal(saved.identityConfirmed, true); assert.equal(saved.report.session, saved.observedSession); }
  if (id.startsWith("copilot")) assert.equal(saved.worker.completion.source, id === "copilot" ? "process-exit" : "agent-stop");
  assert.equal(saved.report.session, saved.session);
  if (id === "copilot-vscode") {
    const successfulState = runner.read("demo"), interrupted = structuredClone(successfulState);
    const interruptedWorker = interrupted.attempts[0].worker;
    delete interruptedWorker.exitedAt; delete interruptedWorker.completion;
    interruptedWorker.pid = 2147483647; interruptedWorker.processStart = "dead-supervisor";
    runner.save(interrupted);
    await runner.worker("demo", "1.1", attempt.id);
    assert.equal(runner.read("demo").attempts[0].phase, "failed");
    assert.equal(runner.read("demo").attempts[0].report.outcome, "completed");
    assert.doesNotThrow(() => runner.preview("demo", ["1.1"], undefined, undefined, true));
    runner.save(successfulState);
  }
  const models = JSON.parse(execFileSync(process.execPath, [runnerBin, "models", "--agent", id, "--json"], { cwd: root, encoding: "utf8" }));
  assert.equal(models.exhaustive, id === "codex");
  const rules = JSON.parse(execFileSync(process.execPath, [runnerBin, "planning-rules", "--agent", id, "--json"], { cwd: root, encoding: "utf8" }));
  assert.equal(rules.harness, id);
  runner.integrate("demo", ["1.1"]);
  assert.equal(runner.read("demo").attempts[0].phase, "integrated");
  writeFileSync(findings, JSON.stringify([{ id: "bug", category: "correctness", location: "result.txt", impact: "fixture defect", correction: "add repair" }]));
  const review = feature.launch("demo", "review");
  assert.equal((await runJob(review)).exitCode, 0);
  assert.equal(feature.read("demo").phase, "fixing");
  const repair = feature.launch("demo", "repair");
  assert.equal((await runJob(repair)).exitCode, 0);
  feature.integrate("demo", repair.id);
  writeFileSync(findings, "[]");
  const final = feature.launch("demo", "review");
  assert.equal((await runJob(final)).exitCode, 0);
  assert.equal(feature.read("demo").phase, "awaiting-final-approval");
});
