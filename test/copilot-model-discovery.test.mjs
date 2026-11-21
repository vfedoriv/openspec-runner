import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const dist = fileURLToPath(new URL("../dist", import.meta.url));

async function discover(t, { kind = "file", sdk = true, windows = false, discover = true, spaces = false, control = false, uncertain = false, interruptSignal = "SIGINT", selector = "fixture-exact-selector", catalog = false, invalidUtf8 = false, failure } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "unrelated checkout"), bin = join(root, spaces ? "PATH bin $literal & spaces" : "isolated-bin");
  mkdirSync(cwd); mkdirSync(bin);
  cpSync(dist, join(root, "dist"), { recursive: true });
  if (uncertain) writeFileSync(join(root,"dist/dashboard-action-runner.js"), `export async function dashboardChild(){${uncertain === "interrupt" ? `process.emit(${JSON.stringify(interruptSignal)});` : ""}throw new Error("Action cancelled; process termination is uncertain; secret-provider-detail");}`);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const executable = join(bin, windows ? "copilot.cmd" : "copilot");
  const worker = join(root, "worker-launched"), calls = join(root, "sdk-calls");
  if (kind !== "missing") {
    const target = kind === "symlink" ? join(bin, "real CLI") : executable;
    writeFileSync(target, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(worker)}, 'launched');\n`, { mode: 0o755 });
    if (kind === "symlink") symlinkSync(target, executable);
    if (windows) writeFileSync(executable, '@echo off\nset REQUIRED=1\nother.exe %*\n');
  }
  const module = join(root, "node_modules/@microsoft/copilot-sdk");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "package.json"), JSON.stringify({ type: "module", exports: sdk ? "./index.js" : "./absent.js" }));
  writeFileSync(join(module, "index.js"), `
    import { appendFileSync, existsSync, statSync } from 'node:fs';
    import { isAbsolute } from 'node:path';
    function record(value) { appendFileSync(${JSON.stringify(calls)}, JSON.stringify(value) + '\\n'); }
    export const RuntimeConnection = { forSpawnedStdio({ path, workingDirectory }) {
      record({ path });
      if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) throw Error('SDK requires an existing absolute executable path');
      return { path, workingDirectory };
    }};
    export class CopilotClient {
      constructor(options) { if(options.mode !== "coding-agent" || options.connection || options.runtime.workingDirectory !== process.cwd() || options.runtime.baseDirectory !== undefined) throw Error("v2 explicit runtime/cwd/config contract"); record({ constructor: options }); }
      async start() { record('start'); if (${JSON.stringify(failure)} && !['list','stop'].includes(${JSON.stringify(failure)})) throw Error(${JSON.stringify(failure)} + ' secret-provider-detail'); }
      async listModels() { record('listModels'); if (${JSON.stringify(failure)} === 'list') throw Error('authentication required secret-provider-detail'); return [{ id: ${JSON.stringify(selector)}, name: 'Fixture model' }]; }
      async createSession() { record('INFERENCE'); throw Error('No inference permitted'); }
      async stop() { record('stop'); if (${JSON.stringify(failure)} === 'stop') return [Error('secret-provider-detail')]; return []; }
    }
  `);
  if (catalog) {
    for (const name of ["yaml", "ink", "react", "string-width"]) symlinkSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), join(root, "node_modules", name));
  }
  // Malformed transport bytes cannot originate from JSON.stringify of an SDK object.
  // Replace only the isolated probe so the real child-process decoder receives them.
  if (invalidUtf8) writeFileSync(join(root, "dist/harnesses/copilot-model-probe.js"), `process.stdout.write(Buffer.concat([Buffer.from('[{"id":"fixture'), Buffer.from([255]), Buffer.from('-selector"}]')]));`);
  const script = join(root, "discover.mjs");
  writeFileSync(script, `${windows ? 'Object.defineProperty(process, "platform", { value: "win32" });' : ''}
    const { copilotHarness } = await import('./dist/harnesses/copilot.js');
    ${catalog ? "const { modelCatalog } = await import('./dist/model-catalog.js');" : ""}
    console.log(JSON.stringify(await ${catalog ? `modelCatalog('copilot', ${JSON.stringify(cwd)})` : `copilotHarness.models({ discover: ${discover}, cwd: ${JSON.stringify(cwd)} })`}));
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = bin;
  if (control) {
    await execute(process.execPath, [executable], { cwd, env });
    assert.equal(readFileSync(worker, "utf8"), "launched", "control must prove the worker marker is functional");
    rmSync(worker);
    assert.equal(existsSync(worker), false, "reset the marker before discovery");
  }
  if (uncertain === "interrupt") {
    for (const name of ["yaml", "ink", "react", "string-width"]) symlinkSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), join(root,"node_modules",name));
    writeFileSync(script, `const {main}=await import('./dist/cli.js');await main(['models','--agent','copilot','--catalog','--json']);`);
    await assert.rejects(execute(process.execPath,[script],{cwd,env}), error => {
      assert.equal(error.code, interruptSignal === "SIGINT" ? 130 : 143); assert.equal(error.stdout,"");
      assert.match(error.stderr,/process termination is uncertain/);
      assert.doesNotMatch(error.stderr,/secret-provider-detail/);
      return true;
    });
    return {};
  }
  const { stdout } = await execute(process.execPath, [script], { cwd, env });
  assert.deepEqual(readdirSync(cwd), [], "discovery must leave cwd unchanged");
  assert.equal(existsSync(worker), false, "must not launch an inference worker");
  const records = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [];
  assert.equal(records.includes("INFERENCE"), false);
  return { result: JSON.parse(stdout), records, executable };
}

test("Copilot worker launch marker detects an executed fixture before discovery", { skip: process.platform === "win32" }, async t => {
  const { result } = await discover(t, { control: true });
  assert.equal(result.status, "available");
});

for (const [name, options] of [
  ["Copilot discovery resolves a PATH-only executable outside cwd", {}],
  ["Copilot discovery preserves an absolute executable path with spaces and shell characters", { spaces: true }],
  ["Copilot discovery resolves an executable symlink", { kind: "symlink" }],
]) test(name, { skip: process.platform === "win32" }, async t => {
  const { result, records, executable } = await discover(t, options);
  assert.equal(result.status, "available", JSON.stringify({ result, records }));
  assert.deepEqual(result.models, [{ id: "fixture-exact-selector", name: "Fixture model" }]);
  assert.deepEqual(records[0], { path: executable });
  assert.deepEqual(records.slice(2), ["start", "listModels", "stop"]);
});

for (const [name, options] of [
  ["missing executable", { kind: "missing" }],
  ["absent SDK", { sdk: false }],
  ["unsupported Windows wrapper", { windows: true }],
  ["discovery disabled", { discover: false }],
]) test(`Copilot discovery returns actionable fallback for ${name}`, async t => {
  const { result, records } = await discover(t, options);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /\/model.*authenticated Copilot CLI/);
  assert.equal(result.exhaustive, false);
  assert.deepEqual(records, [], "unavailable paths must not start the SDK transport");
});

// Reverting raw protocol decoding must expose DEL rewriting and invalid UTF-8 acceptance.
for (const selector of ["fixture-exact-selector", "fixture\x7f-selector", "fixture\x1b[31m-selector"]) {
  test(`Copilot protocol preserves SDK selector bytes before catalog validation: ${JSON.stringify(selector)}`, async t => {
    const { result } = await discover(t, { selector });
    assert.equal(result.status, "available");
    assert.deepEqual(result.models, [{ id: selector, name: "Fixture model" }]);
    const { result: catalog } = await discover(t, { selector, catalog: true });
    assert.equal(catalog.status, "available");
    assert.deepEqual(catalog.entries.map(entry => entry.selector), selector === "fixture-exact-selector" ? ["fixture-exact-selector"] : []);
  });
}

test("Copilot protocol rejects invalid UTF-8 instead of inventing a selector", async t => {
  const { result } = await discover(t, { invalidUtf8: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.models, undefined);
  const { result: catalog } = await discover(t, { invalidUtf8: true, catalog: true });
  assert.equal(catalog.status, "unavailable");
  assert.deepEqual(catalog.entries, []);
});

// Lifecycle fixtures run only the real catalog boundary and a prompt-free fake SDK.
import { spawn } from "node:child_process";
import { observeProcess, processIsGone } from "../dist/platform-process.js";
const waitFor = async (check, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw Error("Fixture readiness/cleanup deadline exceeded");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function lifecycle(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "copilot-tree-"));
  const owned = [];
  t.after(() => {
    for (const identity of owned) if (observeProcess(identity.pid)?.createdAt === identity.createdAt) {
      try { process.kill(identity.pid, "SIGKILL"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(dist, join(root, "dist"), { recursive: true });
  cpSync(fileURLToPath(new URL("../bin", import.meta.url)), join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  mkdirSync(join(root, "node_modules/@microsoft/copilot-sdk"), { recursive: true });
  for (const name of ["yaml", "ink", "react", "string-width"]) symlinkSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)), join(root, "node_modules", name));
  const ready = join(root, "ready"), stopped = join(root, "stopped"), release = join(root, "release");
  const executable = join(root, "copilot");
  writeFileSync(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,probe:process.ppid})); setInterval(()=>{},1000);`, { mode: 0o755 });
  const sdk = join(root, "node_modules/@microsoft/copilot-sdk");
  writeFileSync(join(sdk, "package.json"), '{"type":"module","exports":"./index.js"}');
  writeFileSync(join(sdk, "index.js"), `
    import {spawn} from 'node:child_process'; import {existsSync,writeFileSync} from 'node:fs';
    export const RuntimeConnection={forSpawnedStdio: x=>x};
    export class CopilotClient {
      constructor(o){this.path=o.runtime.path;}
      async start(){this.child=spawn(this.path,[],{stdio:'ignore'}); while(!existsSync(${JSON.stringify(ready)})) await new Promise(r=>setTimeout(r,10)); if(${JSON.stringify(mode)}==='start-error') {while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10)); throw Error('start failed');}}
      async listModels(){while(${JSON.stringify(mode)}==='dashboard-abort'||!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,10)); if(${JSON.stringify(mode)}==='list-error') throw Error('list failed'); if(${JSON.stringify(mode)}==='malformed') console.log('malformed'); return [{id:'fixture'}];}
      async stop(){writeFileSync(${JSON.stringify(stopped)},'yes'); if(${JSON.stringify(mode)}.includes('stop-hang')) {setInterval(()=>{},1000); return new Promise(()=>{});} if(${JSON.stringify(mode)}==='stop-orphan-error'){this.child.unref();return [Error('secret-provider-detail')];} this.child.kill(); await new Promise(r=>this.child.once('exit',r)); if(${JSON.stringify(mode)}==='stop-error') return [Error('stop failed')]; return [];}
    }
  `);
  const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise(resolve => sentinel.once("spawn", resolve));
  owned.push(observeProcess(sentinel.pid));
  const catalogArgs = [join(root,"bin/openspec-runner.js"),"models","--agent","copilot","--catalog","--json"];
  if (mode === "dashboard-abort") {
    writeFileSync(join(root,"dashboard.mjs"), `import {dashboardChild} from './dist/dashboard-action-runner.js'; import {existsSync} from 'node:fs'; const c=new AbortController(); const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);c.abort();}},10); try{console.log((await dashboardChild(process.execPath,${JSON.stringify(catalogArgs)},process.cwd(),c.signal)).stdout);}catch(e){console.error(e.message);process.exitCode=1;}finally{clearInterval(timer);}`);
  }
  const child = spawn(process.execPath, mode === "dashboard-abort" ? [join(root,"dashboard.mjs")] : catalogArgs, { cwd:root, env:{...process.env,PATH:root}, stdio:["ignore","pipe","pipe"] });
  owned.push(observeProcess(child.pid));
  let stdout="", stderr=""; child.stdout.on("data",b=>stdout+=b); child.stderr.on("data",b=>stderr+=b);
  const exit = new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
  await waitFor(()=>existsSync(ready));
  const ids=JSON.parse(readFileSync(ready,"utf8"));
  const tree=[observeProcess(ids.pid),observeProcess(ids.probe)]; owned.push(...tree.filter(Boolean));
  assert.ok(tree.every(Boolean),"record live probe and CLI creation identities before interruption");
  if(mode.startsWith("SIG")) child.kill(mode.split("-")[0]); else if (mode !== "timeout") writeFileSync(release,"go");
  const result=await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('catalog exit deadline')),19000); timer.unref();})]);
  await waitFor(()=>tree.every(identity=>processIsGone(identity.pid)||observeProcess(identity.pid)?.createdAt!==identity.createdAt));
  assert.equal(processIsGone(sentinel.pid),false,"unrelated sentinel remains live");
  if(mode.startsWith("SIG")) { assert.equal(result.code,mode.startsWith('SIGINT')?130:143,stderr); assert.equal(stdout.trim(),""); }
  if(mode==='normal') { assert.equal(result.code,0,stderr); assert.match(stdout,/fixture/); }
  if(mode.endsWith('error') || ['malformed','timeout','stop-hang','dashboard-abort'].includes(mode)) assert.doesNotMatch(stdout,/fixture/);
  if(mode==='stop-orphan-error') { assert.match(stdout,/unavailable/); assert.doesNotMatch(stdout + stderr,/secret-provider-detail/); }
  if(mode==='dashboard-abort') assert.equal(result.code,1,stderr);
  assert.equal(existsSync(stopped),true,"cooperative SDK stop must run");
}
for(const mode of ['SIGINT','SIGTERM','normal','start-error','list-error','stop-error','stop-orphan-error','malformed','timeout','dashboard-abort','stop-hang','SIGINT-stop-hang','SIGTERM-stop-hang']) test(`Copilot catalog cleans owned descendants: ${mode}`,{skip:process.platform!=='linux'},t=>lifecycle(t,mode));

// Inject only the boundary result; no Windows termination is claimed on Linux.
test("Copilot discovery preserves safe process termination uncertainty", async t => {
  const {result} = await discover(t,{uncertain:true});
  assert.equal(result.status,"unavailable");
  assert.match(result.reason,/Process termination is uncertain/);
  assert.doesNotMatch(result.reason,/secret-provider-detail/);
});

for (const interruptSignal of ["SIGINT", "SIGTERM"]) {
  test(`${interruptSignal} CLI catalog preserves safe termination uncertainty`, t => discover(t, { uncertain: "interrupt", interruptSignal }));
}

for (const [failure, reason] of [["SDK protocol version mismatch", "compatibility"], ["runtime artifact not found", "runtime"], ["Exec format error", "runtime"], ["list", "authentication"], ["start", "unavailable"], ["stop", "unavailable"]]) {
  test(`Copilot discovery safely classifies ${failure}`, async t => {
    const { result } = await discover(t, { failure });
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, new RegExp(reason, "i"));
    assert.doesNotMatch(result.reason, /secret-provider-detail/);
  });
}
