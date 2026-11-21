import assert from "node:assert/strict";
import test from "node:test";
import { loadPickerCatalog } from "../dist/dashboard-catalog.js";

const codex = { harness: "codex", status: "available", entries: [{ selector: "example" }] };

test("the picker reuses a fresh catalog and keeps it when forced refresh fails", async () => {
  const cache = new Map();
  const { signal } = new AbortController();
  let reads = 0;
  const read = async () => { reads++; return codex; };
  const shown = [];
  const show = (...args) => shown.push(args);
  await loadPickerCatalog(cache, "codex", signal, read, show);
  await loadPickerCatalog(cache, "codex", signal, read, show);
  assert.equal(reads, 1);
  assert.deepEqual(shown.at(-1), [codex, ""]);
  cache.get("codex").fetchedAt = 0;
  await loadPickerCatalog(cache, "codex", signal, async () => { throw new Error("offline"); }, show);
  assert.deepEqual(shown.at(-1), [codex, "Cached catalog · refresh failed"]);
});

test("switching harnesses discards a pending picker response", async () => {
  const cache = new Map();
  const controller = new AbortController();
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const shown = [];
  const show = (...args) => shown.push(args);
  const previous = loadPickerCatalog(cache, "codex", controller.signal, () => response, show);
  controller.abort();
  const copilot = { harness: "copilot", status: "available", entries: [{ selector: "auto" }] };
  await loadPickerCatalog(cache, "copilot", new AbortController().signal, async () => copilot, show);
  finish(codex);
  await previous;
  assert.deepEqual(shown.at(-1), [copilot, ""]);
  assert.equal(cache.has("codex"), false);
});

test("normalized catalogs omit hidden and malformed entries and preserve model effort", async () => {
  const { registerHarness } = await import("../dist/harnesses/registry.js");
  const { modelCatalog } = await import("../dist/model-catalog.js");
  registerHarness({
    id: "catalog-fixture",
    async models(options) {
      assert.equal(options.includeHidden, false);
      return {
        status: "available",
        models: [
          { model: "visible", displayName: "Visible model", supportedReasoningEfforts: [{ reasoningEffort: "high" }, 42], defaultReasoningEffort: "high" },
          { model: "hidden", hidden: true },
          { model: "invalid\nselector" },
          null,
        ],
      };
    },
  });
  const catalog = await modelCatalog("catalog-fixture");
  assert.equal(catalog.status, "available");
  assert.deepEqual(catalog.entries, [{
    selector: "visible", label: "Visible model", source: "discovered", efforts: ["high"], defaultEffort: "high", effortSupport: "supported",
  }]);
});

test("concurrent readers share discovery and cancellation releases only the cancelled reader", async () => {
  const cache = new Map();
  const first = new AbortController(), second = new AbortController();
  let calls = 0, finish, sharedSignal;
  const response = new Promise(resolve => { finish = resolve; });
  const read = signal => { calls++; sharedSignal = signal; return response; };
  const displays = [];
  const a = loadPickerCatalog(cache, "codex", first.signal, read, () => {});
  const b = loadPickerCatalog(cache, "codex", second.signal, read, result => displays.push(result));
  await Promise.resolve();
  first.abort();
  assert.equal(calls, 1);
  assert.equal(sharedSignal.aborted, false);
  finish(codex);
  await Promise.all([a, b]);
  assert.equal(displays.at(-1), codex);
});

test("saved selectors remain visible for their harness", async () => {
  const { catalogEntries } = await import("../dist/dashboard-catalog.js");
  const snapshot = { tasks: [
    { harness: "codex", assignment: { model: "example" } },
    { harness: "codex", assignment: { model: "retired" } },
    { harness: "claude", assignment: { model: "sonnet" } },
  ] };
  assert.deepEqual(catalogEntries(codex, snapshot, "codex"), [
    { selector: "example" },
    { selector: "retired", source: "saved" },
  ]);
});

test("catalog loader distinguishes missing executables and timeout from available models", async () => {
  for (const error of [Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }), new Error("Action timed out")]) {
    const cache = new Map();
    const displays = [];
    await loadPickerCatalog(cache, "codex", new AbortController().signal, async () => { throw error; },
      (...args) => displays.push(args));
    assert.deepEqual(displays.at(-1), [undefined, "Catalog unavailable · enter a selector"]);
    assert.equal(cache.size, 0);
  }
});

for (const harness of ["codex", "claude", "copilot"]) test(`missing ${harness} executable returns an unavailable CLI catalog`, async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const cwd = mkdtempSync(join(tmpdir(), "missing-catalog-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = cwd;
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url)),
    "models", "--agent", harness, "--catalog", "--json",
  ], { cwd, env });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /not found|ENOENT|catalog unavailable/i);
  assert.deepEqual(result.entries.map(row => row.selector), harness === "claude" ? ["haiku", "sonnet", "opus"] : []);
});

test("unavailable and timed-out catalogs retain saved task, session and approval selectors", async () => {
  const { catalogEntries } = await import("../dist/dashboard-catalog.js");
  const snapshot = {
    tasks: [{ harness: "claude", assignment: { model: "saved-task" } }],
    sessions: [{ attempt: { agent: "claude", settings: { model: "saved-session" } } }],
    features: [{ state: { approval: { implementation: { harness: "claude", model: "saved-role" }, review: { harness: "codex", model: "other-harness" } } } }],
  };
  for (const read of [async () => { throw Error("Action timed out"); }, async () => ({ harness: "claude", status: "unavailable", entries: [{selector:"configured",source:"configured"}] })]) {
    const shown = [];
    await loadPickerCatalog(new Map(), "claude", new AbortController().signal, read, result => shown.push(result));
    assert.deepEqual(catalogEntries(shown.at(-1), snapshot, "claude").map(row => row.selector), [
      ...(shown.at(-1) ? ["configured"] : []), "saved-task", "saved-session", "saved-role",
    ]);
  }
});

test("picker UI scopes cached catalogs by both cwd and harness", async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { PassThrough, Writable } = await import("node:stream");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const { actionsFor, projectTarget } = await import("../dist/dashboard-actions.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  const stdout = new Writable({write(_chunk, _encoding, done) {done();}});
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 24;
  const lifetime = new AbortController(), requests = [];
  const snapshot = root => ({version:1,repository:{root},features:[],tasks:[],sessions:[],assignments:[],attention:[],errors:[],sources:{}});
  const readCatalog = async (cwd, harness) => {
    requests.push([cwd,harness]);
    return {harness,status:"available",scope:cwd,entries:[{selector:`${cwd}-${harness}`,source:"discovered"}]};
  };
  const element = root => React.createElement(DashboardUi, {snapshot:snapshot(root),collector:{refresh(){}},lifetime:lifetime.signal,quit(){},readCatalog});
  const instance = render(element("/first"), {stdin,stdout,stderr:stdout,interactive:true,exitOnCtrlC:false,patchConsole:false});
  const flush = async () => {await new Promise(resolve=>setTimeout(resolve,50));await instance.waitUntilRenderFlush();};
  const key = async value => {stdin.write(value);await flush();};
  try {
    await flush(); await key("g");
    const index = actionsFor(snapshot("/first"),projectTarget).findIndex(action=>action.id==="project:models");
    for(let i=0;i<index;i++) await key("\u001b[B");
    await key("\r");
    await key("\u001b[C");
    await key("\u001b[D");
    assert.deepEqual(requests, [["/first","codex"],["/first","claude"]]);
    instance.rerender(element("/second")); await flush();
    await key("\u001b[C");
    assert.deepEqual(requests, [["/first","codex"],["/first","claude"],["/second","codex"],["/second","claude"]]);
    instance.rerender(element("/first")); await flush();
    assert.equal(requests.length,4,"returning to a fresh cwd/harness cache does not read again");
  } finally {lifetime.abort();instance.unmount();instance.cleanup();stdin.destroy();}
});

test("single Fusion-labelled selector stays opaque, ignores Copilot effort metadata, and preserves stale saved choices", async () => {
  const { registerHarness, getHarness } = await import("../dist/harnesses/registry.js");
  const { modelCatalog } = await import("../dist/model-catalog.js");
  const { catalogEntries, searchCatalog } = await import("../dist/dashboard-catalog.js");
  const adapter = getHarness("copilot");
  const original = adapter.models;
  let label = "Copilot Fusion";
  adapter.models = async () => ({status:"available",models:[{id:"opaque:auto",name:label,supportedReasoningEfforts:["low","high"],defaultReasoningEffort:"high",tier:"premium"}]});
  try {
    const catalog = await modelCatalog("copilot");
    assert.equal(catalog.entries.length, 1);
    assert.deepEqual(catalog.entries[0], {selector:"opaque:auto",label:"Copilot Fusion",source:"discovered",efforts:undefined,defaultEffort:undefined,effortSupport:"unsupported"});
    assert.equal(searchCatalog(catalog.entries,"Fusion")[0].selector,"opaque:auto");
    const entries = catalogEntries(catalog,{tasks:[{harness:"copilot",assignment:{model:"stale-premium"}}]},"copilot");
    assert.deepEqual(entries.at(-1),{selector:"stale-premium",source:"saved"});
    label = "Auto";
    const renamed = await modelCatalog("copilot");
    assert.equal(renamed.entries[0].selector,"opaque:auto");
    assert.equal(renamed.entries[0].label,"Auto");
    adapter.models = async () => ({status:"unavailable",models:[]});
    assert.deepEqual((await modelCatalog("copilot")).entries,[]);
  } finally { adapter.models = original; }
});
