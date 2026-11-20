import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Feature } from "../dist/feature.js";
import { Component } from "../dist/component.js";
import { Coordination } from "../dist/coordination.js";
import { resolveBoundExecutionContext } from "../dist/execution-context.js";
import { readComponentBinding } from "../dist/component-state.js";
import { restoreWindowsContext, windowsContextRequest } from "../dist/windows-context.js";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";
import { executable } from "./helpers/feature-fixture.mjs";

const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
const trace = message => { if (process.env.OPENSPEC_TEST_TRACE) appendFileSync(process.env.OPENSPEC_TEST_TRACE, `${new Date().toISOString()} ${message}\n`); };
if (process.platform === "win32" && !process.env.OPENSPEC_TEST_STANDARD_CHILD) {
  test("four-repository Store CLI lifecycle in a standard Windows session", () => {
    let output;
    try { output = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./helpers/standard-windows-child.ps1", import.meta.url))], {
      input: JSON.stringify({ node: process.execPath, args: ["--test", fileURLToPath(import.meta.url)] }), encoding: "utf8", windowsHide: true, timeout: 590000,
    }); } catch (error) { throw new Error(error.stdout || error.stderr || error.message); }
    assert.match(output, /Store CLI delivers three/);
  });
} else {
test("Store CLI delivers three code repositories and archives only the Store", async t => {
  let cleanup;
  const f = storePlanningFixture({ after(fn) { cleanup = fn; } }), roots = { api: f.code }, executions = [];
  const previousPath = process.env.PATH, bin = join(f.dir, "bin"); mkdirSync(bin); process.env.PATH = `${bin}${delimiter}${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    const unlock = path => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.isDirectory() ? 0o755 : 0o644); if (s.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name)); };
    for (const execution of executions) {
      const binding = readComponentBinding({ stateDir: execution.runtimeDir, change: "demo" });
      if (binding && process.platform === "win32") restoreWindowsContext(windowsContextRequest(execution.runtimeDir, binding));
      else if (binding) for (const path of binding.contextPaths) if (existsSync(path)) unlock(path);
    }
    cleanup();
  });
  for (const id of ["web", "worker"]) {
    const root = roots[id] = join(f.dir, id); mkdirSync(root); git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Code owner"); git(root, "config", "user.email", "code@example.test"); git(root, "commit", "--allow-empty", "-m", "Code base");
  }
  cpSync(join(f.storeRoot, "components/api"), join(f.storeRoot, "components/worker"), { recursive: true });
  const role = { harness: "codex", model: "test-model", effort: "low" }, components = {};
  for (const [id, root] of Object.entries(roots)) {
    git(root, "config", "openspec-runner.repository", id);
    f.write(`components/${id}/openspec/runner.yaml`, JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "test-model" } }, worktrees: "git", terminal: "manual", cleanup: "manual", verifyIntegration: [["node", "-e", "if(!require('node:fs').existsSync('result.txt'))process.exit(1)"]] }));
    components[id] = { repository: id, change: "demo", deliveryBranch: "main", planning: { repository: "contracts", openspecRoot: `components/${id}/openspec` },
      dependencies: id === "web" ? [{ componentId: "api", milestone: "accepted" }] : [],
      settings: { implementation: role, tasks: {}, review: role, repair: role, maxFixRounds: 2, setup: [], verifyIntegration: [["node", "-e", "if(!require('node:fs').existsSync('result.txt'))process.exit(1)"]] } };
  }
  f.write("openspec/config.yaml", "schema: spec-driven\n"); f.write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Deliver feature\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Shared feature plans");
  executable(join(bin, "openspec"), `
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),cwd=process.cwd();
if(args[0]==='--version') console.log('test-openspec');
else if(args[0]==='status'){const change=args[args.indexOf('--change')+1];console.log(JSON.stringify({root:{path:cwd,source:'store',store_id:'team'},planningHome:{root:cwd},changeRoot:'openspec/changes/'+change,artifactPaths:{}}));}
else if(args[0]==='doctor') console.log('{"references":[]}');
else if(args[0]==='archive'){const change=args[1],root=path.join(cwd,'openspec'),out=path.join(root,'changes/archive/2026-11-20-'+change);fs.mkdirSync(path.dirname(out),{recursive:true});fs.renameSync(path.join(root,'changes',change),out);const spec=path.join(root,'specs/delivered/spec.md');fs.mkdirSync(path.dirname(spec),{recursive:true});fs.writeFileSync(spec,'Delivered specification\\n');console.log('Archived');}
else console.log('{"state":"ready","items":[]}');
`);
  const control = join(f.dir, "control.json"); writeFileSync(control, '{}');
  executable(join(bin, "codex"), `
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('--add-dir --model --cd --json');process.exit(0);}
if(args.includes('--version')){console.log('test-cli');process.exit(0);}
if(args[0]==='app-server'){require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[{id:'test-model',model:'test-model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:null}:{}}));});}
else (async()=>{
let prompt='';for await(const part of process.stdin)prompt+=part;const fs=require('node:fs'),cp=require('node:child_process');
const {resolveBoundExecutionContext}=await import(${JSON.stringify(new URL("../dist/execution-context.js", import.meta.url).href)}),{Feature}=await import(${JSON.stringify(new URL("../dist/feature.js", import.meta.url).href)});
const id=cp.execFileSync('git',['config','--get','openspec-runner.repository'],{encoding:'utf8'}).trim(),context=resolveBoundExecutionContext({implementationRoot:process.cwd(),storeRoot:${JSON.stringify(f.storeRoot)},featureId:'product',componentId:id,change:'demo'}),feature=new Feature(process.cwd(),undefined,context),runner=feature.runner;
const role=prompt.includes('Role: review')?'review':prompt.includes('Role: repair')?'repair':undefined,attempt=role?feature.read('demo').jobs.at(-1):runner.read('demo').attempts.at(-1),session='session-'+attempt.id;process.env.CODEX_THREAD_ID=session;
const scope=['--store',context.store.storeRoot,'--feature','product','--component',id,'--assignment',context.store.assignmentId],entry=${JSON.stringify(cli)};
cp.execFileSync(process.execPath,[entry,...(role?['feature','begin','demo','--attempt',attempt.id]:['begin','demo',attempt.task,'--attempt',attempt.id]),'--session',session,...scope,'--json']);
let commit;if(role!=='review'){fs.writeFileSync('result.txt',role==='repair'?'repaired\\n':'implemented\\n');cp.execFileSync('git',['add','result.txt']);cp.execFileSync('git',['commit','-m',role||'Implement']);commit=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}
const state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
const report=role?{attempt:attempt.id,session,outcome:'completed',head:attempt.base,fingerprint:attempt.fingerprint,summary:'Verified component',verification:['checked'],...(role==='review'?{findings:state[id]?[{id:'F1',category:'correctness',location:'result.txt:1',impact:'Needs repair',correction:'Repair output'}]:[]}:{commit})}:{attempt:attempt.id,task:attempt.task,session,outcome:'completed',commit,summary:'Implemented component',verification:['checked']};
const reportPath=require('node:path').join(context.runtimeDir,'reports','cli-'+attempt.id+'.json');fs.mkdirSync(require('node:path').dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report));
cp.execFileSync(process.execPath,[entry,...(role?['feature','report','demo','--attempt',attempt.id]:['report','demo',attempt.task,'--attempt',attempt.id]),'--file',reportPath,...scope,'--json']);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
`);
  const map = join(f.dir, "map.json"), manifestFile = join(f.dir, "manifest.json");
  writeFileSync(map, JSON.stringify({ contracts: f.storeRoot, ...roots }));
  writeFileSync(manifestFile, JSON.stringify({ version: 2, featureId: "product", storeId: "team", sharedChange: "shared", coordinationBranch: "main", components,
    taskMapping: { "1.1": Object.keys(roots).map(componentId => ({ type: "merged", componentId })) },
    verification: [{ componentId: "api", command: ["node", "-e", "const fs=require('node:fs'),p=require('node:path');for(const root of Object.values(JSON.parse(process.env.OPENSPEC_RUNNER_CHECKOUTS)))if(!fs.existsSync(p.join(root,'result.txt')))process.exit(1);console.log('Checked all three code checkouts')"] }], completion: { requireAllMerged: true } }));
  const run = (root, args) => { trace(`CLI ${args.slice(0, 3).join(" ")}`); return JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); };
  const head = () => git(f.storeRoot, "rev-parse", "HEAD");
  const command = action => ["coordination", action, "product", "--store", f.storeRoot, "--map", map];
  const coordinator = new Coordination({ root: f.storeRoot, featureId: "product", repositories: { contracts: f.storeRoot, ...roots } });
  const context = { contract: { repository: "contracts", context: { implementationRoot: f.storeRoot, planningRoot: f.storeRoot,
    changeRoot: join(f.storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] } } };
  const inputs = (action, extra) => {
    const value = name => extra[extra.indexOf(`--${name}`) + 1];
    if (action === "approve") return context;
    if (action === "assign") return { ...context, componentId: value("component"), owner: value("owner") };
    if (action === "accept") return { submissionId: value("submission") };
    if (action === "review") return { stage: value("stage") };
    if (action === "merge") return { componentId: value("component"), deliveryCommit: value("delivery-commit"), mergeStyle: value("merge-style"), prUrl: value("pr-url"), attestedBy: value("attested-by") };
    if (action.startsWith("archive-") && action !== "archive-deliver") return { scope: JSON.parse(readFileSync(value("file"), "utf8")) };
    if (action === "archive-deliver") return { preparedEventId: value("prepared"), deliveryCommit: value("delivery-commit") };
    return {};
  };
  const previewMethods = { approve: "approvalPreview", assign: "assignmentPreview", accept: "acceptancePreview", review: "reviewPreview", merge: "mergePreview", complete: "completionPreview", "archive-approve": "archivePreview", "archive-prepare": "archivePreview", "archive-deliver": "archiveDeliveryPreview" };
  const tree = () => {
    const result = []; const visit = root => { for (const entry of readdirSync(root, { withFileTypes: true })) { if (entry.name === ".git") continue; const path = join(root, entry.name); if (entry.isDirectory()) visit(path); else result.push([path, createHash('sha256').update(readFileSync(path)).digest('hex')]); } };
    for (const root of [f.storeRoot, ...Object.values(roots)]) visit(root); return result;
  };
  const preview = (action, extra = []) => { const before = tree(); const result = coordinator[previewMethods[action]](inputs(action, extra)); assert.deepEqual(tree(), before); return result; };
  const mutate = (action, extra = [], id = action) => {
    trace(`Start ${action} ${id}`);
    const p = preview(action, extra), input = { ...inputs(action, extra), id, operationId: id, expectedHead: head(), token: p.token };
    if (["approve", "complete", "archive-approve"].includes(action)) input.approvedBy = "user";
    if (action === "review") input.review = JSON.parse(readFileSync(extra[extra.indexOf("--file") + 1], "utf8"));
    const method = { review: "recordReview", merge: "recordMerge", "archive-approve": "approveArchive", "archive-prepare": "prepareArchive", "archive-deliver": "recordArchiveDelivery" }[action] ?? action;
    const result = coordinator[method](input); trace(`Finished ${action} ${id}`); return result;
  };
  run(f.code, [...command("init"), "--file", manifestFile, "--expected-head", head(), "--operation", "init"]);
  const beforeApprovalPreview = tree();
  assert.equal(run(f.code, [...command("approve"), "--dry-run"]).token, preview("approve").token);
  assert.deepEqual(tree(), beforeApprovalPreview);
  mutate("approve", ["--approved-by", "user"]);
  const imported = {};
  const assign = async id => {
    const assignment = mutate("assign", ["--component", id, "--owner", "owner"], `assign-${id}`);
    const selection = { storeRoot: f.storeRoot, featureId: "product", assignmentId: `assign-${id}`, owner: "owner" };
    const component = new Component({ root: roots[id], repository: id });
    const inspected = await component.inspect(selection); await component.import({ ...selection, token: inspected.token });
    const execution = resolveBoundExecutionContext({ implementationRoot: roots[id], storeRoot: f.storeRoot, featureId: "product", componentId: id, change: "demo" }); executions.push(execution);
    imported[id] = new Feature(roots[id], undefined, execution); return assignment;
  };
  await assign("api"); await assign("worker");
  assert.throws(() => preview("assign", ["--component", "web", "--owner", "owner"]), /./);
  const implement = async id => { const feature = imported[id]; feature.runner.launch("demo", ["1.1"]); const attempt = feature.runner.read("demo").attempts.at(-1); assert.equal((await feature.runner.worker("demo", "1.1", attempt.id)).exitCode, 0); feature.runner.integrate("demo", ["1.1"]); };
  await Promise.all([implement("api"), implement("worker")]);
  const submit = async id => {
    const feature = imported[id], review = feature.launch("demo", "review"); assert.equal((await feature.worker("demo", review.id)).exitCode, 0);
    const base = ["component", "export", "product", "--store", f.storeRoot, "--repository", id, "--component", id, "--change", "demo", "--outcome", "completed"];
    const p = run(roots[id], [...base, "--dry-run"]), file = join(f.dir, `${id}-receipt.json`);
    const receipt = run(roots[id], [...base, "--id", `receipt-${id}`, "--operation", `receipt-${id}`, "--expected-head", head(), "--confirm", p.token, "--output", file]);
    coordinator.importSubmission({ bytes: readFileSync(file), expectedHead: head() });
    assert.doesNotMatch(git(f.storeRoot, "show", `HEAD:components/${id}/openspec/changes/demo/tasks.md`), /\[x\]/);
    mutate("accept", ["--submission", receipt.record.id], `accept-${id}`);
    assert.match(git(f.storeRoot, "show", `HEAD:components/${id}/openspec/changes/demo/tasks.md`), /\[x\]/);
  };
  writeFileSync(control, '{"api":true}');
  const review = imported.api.launch("demo", "review"); await imported.api.worker("demo", review.id);
  const repair = imported.api.launch("demo", "repair"); await imported.api.worker("demo", repair.id); imported.api.integrate("demo", repair.id);
  writeFileSync(control, '{}'); await submit("api"); await submit("worker");
  await assign("web"); await implement("web"); await submit("web");
  const reviewTuple = stage => { const p = preview("review", ["--stage", stage]), file = join(f.dir, `${stage}.json`); writeFileSync(file, JSON.stringify({ tuple: p.tuple, token: p.token, reviewedBy: "user", summary: "Reviewed exact tuple", findings: [] })); mutate("review", ["--stage", stage, "--file", file], stage); };
  reviewTuple("combined");
  const delivered = {};
  for (const id of Object.keys(roots)) { delivered[id] = imported[id].runner.read("demo").head; git(roots[id], "merge", "--ff-only", delivered[id]); mutate("merge", ["--component", id, "--delivery-commit", delivered[id], "--merge-style", "merge", "--pr-url", `https://example.test/pr/${id}`, "--attested-by", "user"], `merged-${id}`); }
  reviewTuple("final"); mutate("complete", ["--approved-by", "user"]);
  const clone = join(f.dir, "cloned-store"); git(f.dir, "clone", "--quiet", f.storeRoot, clone); git(clone, "config", "openspec-runner.repository", "contracts");
  const cloneMap = { contracts: clone };
  for (const id of Object.keys(roots)) { const root = join(f.dir, `cloned-${id}`); git(f.dir, "clone", "--quiet", roots[id], root); git(root, "config", "openspec-runner.repository", id); cloneMap[id] = root; }
  const map2 = join(f.dir, "map2.json"); writeFileSync(map2, JSON.stringify(cloneMap));
  assert.equal(run(cloneMap.api, ["coordination", "status", "product", "--store", clone, "--map", map2]).phase, "completed");
  assert.ok(run(cloneMap.api, ["coordination", "summary", "product", "--store", clone, "--map", map2, "--refresh"]).available);
  const scope = join(f.dir, "scope.json"); writeFileSync(scope, JSON.stringify({ componentIds: ["api", "web", "worker"], includeStore: true, storeDeliveryBranch: "main" }));
  mutate("archive-approve", ["--file", scope, "--approved-by", "user"]); mutate("archive-prepare", ["--file", scope], "archive");
  const receipt = run(f.code, [...command("archive-inspect"), "--operation", "archive"]);
  git(f.storeRoot, "merge", "--no-ff", receipt.targets._store.branch, "-m", "Deliver Store archive"); const archiveCommit = head();
  for (const id of Object.keys(receipt.targets)) mutate("archive-deliver", ["--prepared", `archive-${id}`, "--delivery-commit", archiveCommit], `archived-${id}`);
  assert.equal(run(f.code, command("status")).archive, "archived");
  for (const [id, root] of Object.entries(roots)) { assert.equal(git(root, "rev-parse", "HEAD"), delivered[id]); assert.equal(existsSync(join(root, "openspec")), false); assert.equal(existsSync(join(root, ".openspec-runner")), false); }
});
}
