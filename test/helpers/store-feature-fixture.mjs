import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, chmodSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { storePlanningFixture, git } from "./store-planning-fixture.mjs";
import { executable } from "./feature-fixture.mjs";
import { Coordination } from "../../dist/coordination.js";
import { Component } from "../../dist/component.js";
import { readComponentBinding } from "../../dist/component-state.js";
import { restoreWindowsContext, windowsContextRequest } from "../../dist/windows-context.js";

export async function storeFeatureFixture(t, harness = "codex") {
  let cleanup;
  const f = storePlanningFixture({ after(fn) { cleanup = fn; } });
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const controlPath = join(f.dir, "control.json"); writeFileSync(controlPath, "{}");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  let execution;
  const executions = [];
  t.after(() => {
    process.env.PATH = previousPath;
    for (const scope of executions) {
      const binding = readComponentBinding({ stateDir: scope.runtimeDir, change: "demo" });
      if (binding && process.platform === "win32") restoreWindowsContext(windowsContextRequest(scope.runtimeDir, binding));
      if (binding && process.platform !== "win32") {
        const unlock = path => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.isDirectory() ? 0o755 : 0o644); if (s.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name)); };
        for (const path of binding.contextPaths) if (existsSync(path)) unlock(path);
      }
    }
    cleanup();
  });
  executable(join(bin, harness === "copilot-vscode" ? "code" : harness), `
const args = process.argv.slice(2);
if(args.includes('--help')) { console.log('--add-dir --model --cd --json --trust-folder --prompt --allow-tool --mode --new-window'); process.exit(0); }
if(args.includes('--version')) { console.log('test-cli'); process.exit(0); }
if(args.includes('--list-extensions')) { console.log('github.copilot-chat'); process.exit(0); }
if(${JSON.stringify(harness)}==='copilot-vscode' && (args[0]!=='chat'||args.length===3)) process.exit(0);
if(args[0]==='app-server') {
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(m.id) console.log(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{model:'test-model',id:'test-model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}:{}}));
 });
} else (async () => {
 let prompt=${JSON.stringify(harness)}==='copilot'?args[args.indexOf('-p')+1]:${JSON.stringify(harness)}==='copilot-vscode'?args.at(-1):''; if(!prompt) for await (const part of process.stdin) prompt+=part;
 if(!prompt) throw Error('Missing registered prompt');
 const fs=require('node:fs'),cp=require('node:child_process');
 const {resolveBoundExecutionContext}=await import(${JSON.stringify(new URL("../../dist/execution-context.js", import.meta.url).href)});
 const {Runner}=await import(${JSON.stringify(new URL("../../dist/runner.js", import.meta.url).href)});
 const {Feature}=await import(${JSON.stringify(new URL("../../dist/feature.js", import.meta.url).href)});
 const context=resolveBoundExecutionContext({implementationRoot:process.cwd(),storeRoot:${JSON.stringify(f.storeRoot)},featureId:'product',componentId:'api',change:'demo'});
 const runner=new Runner(process.cwd(),undefined,context),feature=new Feature(process.cwd(),undefined,context);
 const role=prompt.includes('Role: review')?'review':prompt.includes('Role: repair')?'repair':undefined;
 const attempt=role?feature.read('demo').jobs.at(-1):runner.read('demo').attempts.at(-1);
 const session=attempt.expectedSession||'session-'+attempt.id; process.env.CODEX_THREAD_ID=session;
 const hook=(event,extra={})=>{const descriptor=JSON.parse(fs.readFileSync('.github/hooks/openspec-runner.json','utf8')).hooks[event][0].command.match(/--store-scope' '([^']+)'/)[1];cp.execFileSync(process.execPath,[${JSON.stringify(fileURLToPath(new URL("../../bin/openspec-runner.js", import.meta.url)))},'hook',event,'--store-scope',descriptor],{input:JSON.stringify({session_id:session,cwd:process.cwd(),timestamp:new Date().toISOString(),...extra}),encoding:'utf8'});};
 if(${JSON.stringify(harness)}.startsWith('copilot')) hook('UserPromptSubmit',{prompt});
 if(role) feature.begin('demo',attempt.id,session); else runner.begin('demo',attempt.task,attempt.id,session);
 const control=JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)},'utf8'));
 let commit;
 if(role!=='review') { fs.writeFileSync('result.txt',role==='repair'?'repaired\\n':'implemented\\n'); cp.execFileSync('git',['add','result.txt']); cp.execFileSync('git',['commit','-m',role||'Implement']); commit=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); }
 if(role) feature.report('demo',attempt.id,{attempt:attempt.id,session,outcome:'completed',head:attempt.base,fingerprint:attempt.fingerprint,summary:'Checked Store component',verification:['fixture verified'],...(role==='review'?{findings:control.findings||[]}:{commit})});
 else runner.report('demo',attempt.task,attempt.id,{attempt:attempt.id,task:attempt.task,session,outcome:'completed',commit,summary:'Implemented Store component',verification:['fixture verified']});
 if(${JSON.stringify(harness)}.startsWith('copilot')) hook('Stop');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
`);
  git(f.code, "config", "openspec-runner.repository", "api");
  const config = JSON.parse(readFileSync(join(f.storeRoot, "components/api/openspec/runner.yaml"), "utf8"));
  f.write("components/api/openspec/runner.yaml", JSON.stringify({ ...config, defaultAgent: harness, agents: { [harness]: { defaultModel: "test-model", ...(harness.startsWith("copilot") ? { options: { startupTimeoutMs: 20000, completionTimeoutMs: 60000 } } : {}) } }, worktrees: "git", terminal: "manual", cleanup: "manual" }));
  if (harness !== "codex") f.write("components/api/openspec/changes/demo/execution.yaml", JSON.stringify({ version: 2, agent: harness, tasks: { "1.1": {} } }));
  f.write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Deliver API\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Shared feature");
  const role = { harness, model: "test-model", ...(harness === "codex" ? { effort: "low" } : {}) };
  const contract = { repository: "contracts", context: { implementationRoot: f.code, planningRoot: f.storeRoot,
    changeRoot: join(f.storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] } };
  const coordinator = new Coordination({ root: f.storeRoot, featureId: "product", repositories: { contracts: f.storeRoot, api: f.code }, execute: f.input().execute });
  const manifest = { version: 2, featureId: "product", storeId: "team", sharedChange: "shared", coordinationBranch: "main",
    components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [],
      planning: { repository: "contracts", openspecRoot: "components/api/openspec" },
      settings: { implementation: role, tasks: {}, review: role, repair: role, maxFixRounds: 2, setup: [], verifyIntegration: [] } } },
    taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  const head = () => git(f.storeRoot, "rev-parse", "HEAD");
  coordinator.init({ contract, manifest, expectedHead: head(), operationId: "init" });
  coordinator.approve({ contract, id: "approval", operationId: "approve", expectedHead: head(),
    token: coordinator.approvalPreview({ contract }).token, approvedBy: "user" });
  const request = { contract, componentId: "api", owner: "owner" };
  coordinator.assign({ ...request, id: "assignment", operationId: "assign", expectedHead: head(), token: coordinator.assignmentPreview(request).token });
  const component = new Component({ root: f.code, repository: "api", execute: f.input().execute });
  const selection = { storeRoot: f.storeRoot, featureId: "product", assignmentId: "assignment", owner: "owner" };
  execution = component.assignmentContext(selection).execution;
  executions.push(execution);
  const preview = await component.inspect(selection);
  return { ...f, coordinator, contract, component, selection, preview, execution, bin, head,
    control(value) { writeFileSync(controlPath, JSON.stringify(value)); }, trackExecution(scope) { executions.push(scope); } };
}
