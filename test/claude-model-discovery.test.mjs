import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const success = (models, id = "catalog") => JSON.stringify({ type: "control_response", response: { request_id: id, subtype: "success", response: { models } } });
async function fixture(t, stream, { hidden = false, configured, split = false, exitCode = 0, timeout = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "claude-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "checkout with spaces"), bin = join(root, "bin");
  mkdirSync(cwd); mkdirSync(bin);
  cpSync(fileURLToPath(new URL("../dist", import.meta.url)), join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const record = join(root, "request.json");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
let input='';for await(const chunk of process.stdin) input+=chunk;
writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),input}));
const bytes=Buffer.from(${JSON.stringify(Buffer.isBuffer(stream) ? [...stream] : stream)});
${timeout ? 'setInterval(()=>{},1000);' : split ? 'for (const byte of bytes) {process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}' : 'process.stdout.write(bytes);'}
process.exitCode=${exitCode};
`, { mode: 0o755 });
  writeFileSync(join(root, "probe.mjs"), `
${timeout ? 'const original=AbortSignal.timeout;AbortSignal.timeout=()=>original(250);' : ''}
const {modelCatalog}=await import('./dist/model-catalog.js');
console.log(JSON.stringify(await modelCatalog('claude',${JSON.stringify(cwd)},${JSON.stringify(configured)},${hidden})));
`);
  const { stdout } = await execute(process.execPath, [join(root, "probe.mjs")], { cwd, env: { ...process.env, PATH: bin }, timeout: 8000 });
  const request = JSON.parse(readFileSync(record, "utf8"));
  assert.ok(request.input, JSON.stringify({request,result:stdout}));
  assert.equal(request.cwd, cwd);
  assert.deepEqual(request.argv, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]);
  assert.deepEqual(request.input.trim().split("\n").map(JSON.parse), [{ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } }], "only initialization, no inference turn");
  const result = JSON.parse(stdout);
  assert.equal(result.scope, cwd);
  return result;
}
function fallback(result, configured) {
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.entries.map(row => row.selector), ["haiku", "sonnet", "opus", ...(configured ? [configured] : [])]);
}

test("Claude initialize preserves selectors, labels and effort knowledge without inference", async t => {
  const result = await fixture(t, success([
    { value: "default", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "haiku", supportsEffort: false }, { value: "unknown" },
  ]));
  assert.equal(result.status, "available");
  assert.deepEqual(result.entries.map(row => [row.selector, row.label, row.efforts, row.effortSupport]), [
    ["default", "Default", ["low", "high"], "supported"], ["haiku", undefined, [], "unsupported"], ["unknown", undefined, undefined, "unknown"],
  ]);
});

test("Claude ignores unrelated request IDs and accepts matching initialize", async t => {
  const result = await fixture(t, success([{ value: "wrong" }], "other") + "\n" + success([{ value: "right" }]));
  assert.deepEqual(result.entries.map(row => row.selector), ["right"]);
});
for (const [name, stream] of [
  ["unrelated IDs only", success([{ value: "wrong" }], "other")],
  ["matching error", JSON.stringify({type:"control_response",response:{request_id:"catalog",subtype:"error",error:"denied"}})],
  ["empty models", success([])], ["missing models", success(undefined)],
  ["invalid rows", success([null, 42, {}, {value: 42}])],
  ["malformed before success", "{bad\n" + success([{value:"valid"}])],
  ["malformed after success", success([{value:"valid"}]) + "\n{bad"],
  ["invalid selectors only", success([{value:""},{value:"  "},{value:"bad\nselector"},{value:"bad\u007fselector"}])],
]) test(`Claude safely falls back for ${name}`, async t => fallback(await fixture(t, stream, {configured:"saved-exact"}), "saved-exact"));

test("Claude hidden rows remain hidden unless explicitly included", async t => {
  const stream = success([{ value: "visible" }, { value: "private", hidden: true }]);
  assert.deepEqual((await fixture(t, stream)).entries.map(row=>row.selector), ["visible"]);
  const result = await fixture(t, stream, {hidden:true});
  assert.deepEqual(result.entries.map(row=>[row.selector,row.hidden]), [["visible",undefined],["private",true]]);
});

test("Claude drops invalid selectors and keeps final duplicate metadata", async t => {
  const result = await fixture(t, success([{value:"same",displayName:"first"},{value:""},{value:"  "},{value:"bad\u001b[31m"},{value:"bad\u007f"},{value:"same",displayName:"last",supportsEffort:false}]));
  assert.deepEqual(result.entries.map(row=>[row.selector,row.label,row.effortSupport]), [["same","last","unsupported"]]);
});

test("Claude split byte output preserves Unicode and recorded raw fable aliases", async t => {
  // Sanitized historical evidence: direct=claude-fable-5[1m, SDK=claude-fable-5-1[1m.
  // Current recon matched; historical cause is OPEN, so neither selector is rewritten.
  const values = ["claude-fable-5[1m", "claude-fable-5-1[1m", "model-雪"];
  const result = await fixture(t, success(values.map(value=>({value}))), {split:true});
  assert.deepEqual(result.entries.map(row=>row.selector), values);
});

for (const [name, raw] of [["NUL", "bad\u0000selector"], ["terminal escape", "bad\u001b[31mselector"]]) {
  test(`Claude rejects raw ${name} bytes rather than sanitizing a malformed selector into validity`, async t => {
    const stream = success([{value:"placeholder"}]).replace("placeholder", raw);
    fallback(await fixture(t, stream));
  });
}
test("Claude nonzero exit retains configured selector", async t => fallback(await fixture(t, success([{value:"discard"}]), {exitCode:1,configured:"retired"}), "retired"));
test("Claude timeout retains configured selector", async t => fallback(await fixture(t, "", {timeout:true,configured:"retired"}), "retired"));

test("raw protocol stdout is opt-in while stderr and failures stay safe", async () => {
  const { dashboardChild } = await import("../dist/dashboard-action-runner.js");
  const code = "process.stdout.write('\\x1b[31mout\\x1b[0m');process.stderr.write('\\x1b[31merr\\x1b[0m')";
  const invoke = (source, raw) => dashboardChild(process.execPath,["-e",source],process.cwd(),new AbortController().signal,false,undefined,raw);
  assert.deepEqual(await invoke(code,false),{stdout:"out",stderr:"err"});
  assert.deepEqual(await invoke(code,true),{stdout:"\u001b[31mout\u001b[0m",stderr:"err"});
  await assert.rejects(invoke("process.stdout.write('\\x1b[31mfailed\\x1b[0m');process.exitCode=1",true),error=>{
    assert.equal(error.message,"Action failed (1): failed");return true;
  });
});


test("Claude malformed UTF-8 selector falls back without replacing bytes or losing configured selector", async t => {
  const [prefix, suffix] = success([{value:"placeholder"}]).split("placeholder");
  const bytes = Buffer.concat([Buffer.from(prefix + "bad"), Buffer.from([0xff]), Buffer.from("selector" + suffix)]);
  fallback(await fixture(t, bytes, {configured:"saved-exact"}), "saved-exact");
});

test("raw protocol decoding rejects malformed UTF-8 through the child promise", {timeout:3000}, async () => {
  const { dashboardChild } = await import("../dist/dashboard-action-runner.js");
  const source = "process.stdout.write(Buffer.from([0xff]))";
  const invoke = raw => dashboardChild(process.execPath,["-e",source],process.cwd(),new AbortController().signal,false,undefined,raw);
  assert.deepEqual(await invoke(false),{stdout:"\ufffd",stderr:""},"default callers retain existing decoding");
  await assert.rejects(invoke(true), /UTF-8/i);
});
