import test from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

test("truncation keeps whole graphemes and pads to terminal columns", async () => {
  const { fitDashboardText } = await import("../dist/dashboard-layout.js");
  for (const [text, width, expected] of [
    ["登录abc", 3, "登…"],
    ["👩‍💻abc", 3, "👩‍💻…"],
    ["e\u0301abc", 2, "e\u0301…"],
    ["登录", 6, "登录  "],
    ["first\nsecond\tthird", 24, "first second third      "],
  ]) assert.equal(fitDashboardText(text, width), expected);
});

test("small terminals and errors never push a border outside the viewport", async () => {
  const { dashboardFrame } = await import("../dist/dashboard-layout.js");
  for (const columns of [2, 7, 40, 80, 96]) for (const rows of [2, 6, 10, 12, 18, 24]) {
    const frame = dashboardFrame({ columns, rows, table: true, title: "Features", status: "Tasks 1/4", filters: "s:all", error: "STALE source unavailable", lines: [["1.3", "登录 👩‍💻", "Ready"]], footer: ["q quit", "r refresh"] });
    assert.ok(frame.length <= rows, `${columns}x${rows}: frame is too tall`);
    assert.ok(frame.at(-1).startsWith("└"), "bottom border remains visible");
    for (const line of frame) assert.equal(stringWidth(line), columns);
  }
});

// Measuring code points instead of terminal columns would shift the right edge
// for these task names; byte slicing could also split the emoji or accent.
for (const columns of [96, 40]) {
  test(`dashboard borders remain aligned at ${columns} columns with Unicode and long content`, async () => {
    const React = await import("react");
    const { render } = await import("ink");
    const { DashboardUi } = await import("../dist/dashboard-ui.js");
    const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
    let output = "";
    const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    stdout.isTTY = true; stdout.columns = columns; stdout.rows = columns === 96 ? 24 : 12;
    const lifetime = new AbortController();
    const snapshot = {
      version: 1, collectedAt: "now", repository: { root: "/repo", maxParallel: 2 },
      features: [{ id: "local:demo", origin: "local", change: "demo", completed: 0, total: 1, taskIds: ["t"], sessionIds: [] }],
      tasks: [{ id: "t", featureId: "local:demo", task: { id: "1.1", description: "登录 👩‍💻 cafe\u0301 " + "long ".repeat(30), completed: false }, ready: true, reasons: [], attempts: [] }],
      sessions: [], assignments: [], attention: [], errors: [], sources: {},
    };
    const collector = { refresh() {}, close: async () => {}, readActivity: async () => ({ entries: [], errors: [], reset: false }) };
    const instance = render(React.createElement(DashboardUi, { snapshot, collector, lifetime: lifetime.signal, quit() {} }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
    try {
      await instance.waitUntilRenderFlush();
      for (let i = 0; i < 2; i++) {
        stdin.write("\u001b[C"); await new Promise(resolve => setTimeout(resolve, 40)); await instance.waitUntilRenderFlush();
      }
      // Ink moves the cursor between frames rather than printing a newline.
      const text = stripVTControlCharacters(output).replace(/┘(?=┌)/gu, "┘\n");
      const borders = text.split(/\r?\n/).filter(line => /^[┌│├└]/u.test(line));
      assert.ok(borders.length >= 12, "the UI must draw a complete bordered frame");
      for (const line of borders) assert.equal(stringWidth(line), columns, line);
      assert.match(text, /登录 👩‍💻 café/u);
      if (columns === 96) {
        assert.match(text, /│ Task\s+│ Description\s+│ State \/ reason/u);
        const task = borders.find(line => line.includes("登录"));
        const header = borders.find(line => line.includes("Description"));
        const positions = line => [...line.matchAll(/│/gu)].map(match => stringWidth(line.slice(0, match.index)));
        assert.deepEqual(positions(task), positions(header), "task cells must align with column headers");
        assert.ok(task.includes("…"), "long descriptions must truncate within their cell");
      }
    } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
  });
}

test("a short terminal keeps the selected row and active search prompt visible", async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = "";
  const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 6;
  const lifetime = new AbortController();
  const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, featureId: "f", task: { id: `1.${index + 1}`, description: `Task ${index + 1}`, completed: false }, ready: true, reasons: [], attempts: [] }));
  const snapshot = { version: 1, collectedAt: "now", repository: { root: "/repo" }, features: [{ id: "f", origin: "local", change: "demo", completed: 0, total: 4, taskIds: tasks.map(t => t.id), sessionIds: [] }], tasks, sessions: [], assignments: [], attention: [], errors: [], sources: {} };
  const collector = { refresh() {}, close: async () => {}, readActivity: async () => ({ entries: [], errors: [], reset: false }) };
  const instance = render(React.createElement(DashboardUi, { snapshot, collector, lifetime: lifetime.signal, quit() {} }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const key = async input => { output = ""; stdin.write(input); await new Promise(resolve => setTimeout(resolve, 40)); await instance.waitUntilRenderFlush(); };
  try {
    await instance.waitUntilRenderFlush();
    await key("\u001b[C"); await key("\u001b[C");
    await key("\u001b[B"); await key("\u001b[B"); await key("\u001b[B");
    assert.match(stripVTControlCharacters(output), /▸ 1\.4/, "selected row must not be hidden behind header chrome");
    await key("/"); assert.match(output, /search:/, "text entry must retain its prompt");
  } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
});

test("Ctrl+R refreshes the model picker and displays retained choices on failure", async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const { actionsFor, projectTarget } = await import("../dist/dashboard-actions.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = "";
  const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  stdout.isTTY = true; stdout.columns = 140; stdout.rows = 24;
  const lifetime = new AbortController();
  const snapshot = { version: 1, repository: { root: "/repo" }, features: [], tasks: [], sessions: [], assignments: [], attention: [], errors: [], sources: {} };
  const collector = { refresh() {}, close: async () => {} };
  let requests = 0;
  const readCatalog = async (_, harness) => {
    assert.equal(harness, "copilot");
    if (++requests > 1) throw new Error("offline");
    return { harness, status: "available", entries: [{ selector: "auto", source: "discovered" }] };
  };
  const instance = render(React.createElement(DashboardUi, { snapshot, collector, lifetime: lifetime.signal, quit() {}, readCatalog }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const key = async value => {
    stdin.write(value);
    await new Promise(resolve => setTimeout(resolve, 35));
    await instance.waitUntilRenderFlush();
  };
  try {
    await instance.waitUntilRenderFlush();
    await key("g");
    const index = actionsFor(snapshot, projectTarget).findIndex(action => action.id === "project:init:copilot");
    for (let i = 0; i < index; i++) await key("\u001b[B");
    await key("\r");
    assert.equal(requests, 1);
    assert.match(stripVTControlCharacters(output), /modelForSetup: .*auto/);
    output = "";
    await key("\u0012");
    assert.equal(requests, 2);
    assert.match(stripVTControlCharacters(output), /auto .*Cached catalog · refresh failed/);
  } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
});

test("Models panel searches labels and switches harnesses without running a worker", async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const { actionsFor, projectTarget } = await import("../dist/dashboard-actions.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = "";
  const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  stdout.isTTY = true; stdout.columns = 120; stdout.rows = 24;
  const lifetime = new AbortController();
  const snapshot = { version: 1, repository: { root: "/repo" }, features: [], tasks: [], sessions: [], assignments: [], attention: [], errors: [], sources: {} };
  const requests = [];
  const readCatalog = async (_, harness) => {
    requests.push(harness);
    if (requests.length === 2) throw new Error("offline");
    return { harness, status: "available", scope: "/repo", fetchedAt: "2026-11-14T00:00:00.000Z", entries: harness === "codex" ? [
      { selector: "sample-a", label: "Alpha", source: "discovered" },
      { selector: "sample-b", label: "Beta", source: "discovered", efforts: ["high"], defaultEffort: "high" },
    ] : [{ selector: "sonnet", source: "example" }] };
  };
  const instance = render(React.createElement(DashboardUi, { snapshot, collector: { refresh() {} }, lifetime: lifetime.signal, quit() {}, readCatalog }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const key = async value => {
    stdin.write(value);
    await new Promise(resolve => setTimeout(resolve, 35));
    await instance.waitUntilRenderFlush();
  };
  try {
    await instance.waitUntilRenderFlush();
    await key("g");
    const index = actionsFor(snapshot, projectTarget).findIndex(action => action.id === "project:models");
    for (let i = 0; i < index; i++) await key("\u001b[B");
    await key("\r");
    assert.match(output, /sample-a/);
    assert.match(output, /Fetched 2026-11-14T00:00:00.000Z · Scope \/repo/);
    output = "";
    await key("\u0012");
    assert.match(output, /Cached catalog · refresh failed/);
    assert.match(output, /Fetched 2026-11-14T00:00:00.000Z/);
    output = "";
    await key("Beta");
    assert.match(output, /sample-b · Beta · discovered · effort high · default high/);
    assert.doesNotMatch(output, /sample-a/);
    output = "";
    await key("\u001b[C");
    assert.match(output, /Models · claude/);
    assert.match(output, /sonnet · example/);
    assert.deepEqual(requests, ["codex", "codex", "claude"]);
  } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
});

test("catalog keyboard choices reach setup, launch, retry, task edit, and managed approval", async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const { actionsFor, projectTarget } = await import("../dist/dashboard-actions.js");
  const enter = "\r", down = "\u001b[B", right = "\u001b[C";
  for (const columns of [40, 80, 140]) for (const flow of ["setup", "launch-preview", "retry-preview", "edit-models", "managed-plan-settings", "seeded-settings"]) {
    const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
    let output = "";
    const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    stdout.isTTY = true; stdout.columns = columns; stdout.rows = 28;
    const lifetime = new AbortController();
    const seeded = flow === "seeded-settings";
    const managed = flow === "managed-plan-settings" || seeded;
    const saved = { harness: "claude", model: "sample-a", effort: "low" };
    const feature = { id: "local:demo", change: "demo", origin: "local", completed: 0, total: 1, taskIds: ["task"], sessionIds: [],
      ...(managed ? { state: { phase: "awaiting-plan-approval", jobs: [], ...(seeded ? { approval: { implementation: saved, review: saved, repair: saved, maxFixRounds: 2 } } : {}) } } : {}) };
    const task = { id: "task", featureId: feature.id, task: { id: "1.1", description: "Example" }, ready: true, reasons: [], harness: seeded ? "claude" : "codex",
      attempts: flow === "retry-preview" ? [{ phase: "failed" }] : [] };
    const snapshot = { version: 1, repository: { root: "/repo" }, features: [feature], tasks: [task], sessions: [], assignments: [], attention: [], errors: [], sources: {} };
    const calls = [];
    const readCatalog = async (_, harness) => ({ harness, status: "available", entries:
      harness === "copilot" ? [{ selector: "Model Name (vendor)" }] : [
        { selector: "sample-a", efforts: ["low"] }, { selector: "sample-b", efforts: ["high"] },
      ] });
    const copied = [];
    const runAction = async request => {
      calls.push(request);
      return managed && !request.confirmation
        ? { text: "Preview completed", confirmation: "reviewed", settingsJson: JSON.stringify(request.input.roleSettings) }
        : { text: "Preview completed" };
    };
    const instance = render(React.createElement(DashboardUi, {
      snapshot, collector: { refresh() {} }, lifetime: lifetime.signal, quit() {}, readCatalog, runAction,
      copySettings: async json => {
        copied.push(json);
        if (copied.length === 1) throw new Error("Clipboard failure");
      },
    }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
    const key = async value => {
      stdin.write(value);
      await new Promise(resolve => setTimeout(resolve, 30));
      await instance.waitUntilRenderFlush();
    };
    async function pickModelAndEffort() {
      await key(down); await key(down); await key(enter);
      assert.match(output, /effort: .*high/, flow);
      if (flow === "launch-preview") {
        output = "";
        await key("low"); await key(enter);
        assert.match(output, /Choose a supported ef/);
        for (let i = 0; i < 3; i++) await key("\x7f");
      }
      await key(down); await key(enter);
    }
    try {
      await instance.waitUntilRenderFlush();
      const target = flow === "setup" ? projectTarget : managed ? feature.id : task.id;
      if (flow === "setup") await key("g");
      else {
        const { selectDashboardRows, defaultDashboardFilters } = await import("../dist/dashboard-view.js");
        await key(right); await key(right);
        const rows = selectDashboardRows(snapshot, "Features", defaultDashboardFilters);
        const row = rows.findIndex(entry => entry.targetId === target);
        assert.ok(row >= 0, flow);
        for (let i = 0; i < row; i++) await key(down);
        await key("a");
      }
      const actions = actionsFor(snapshot, target);
      const suffix = flow === "setup" ? ":init:copilot" : managed ? ":managed-plan-settings" : ":" + flow;
      const index = actions.findIndex(action => action.id.endsWith(suffix));
      assert.ok(index >= 0, flow);
      for (let i = 0; i < index; i++) await key(down);
      await key(enter);
      if (flow === "setup") { await key(down); await key(enter); }
      else if (seeded) {
        assert.match(output, /model: sample-a/);
        for (let i = 0; i < "sample-a".length; i++) await key("\x7f");
        output = "";
        await key("sample-b"); await key(enter);
        assert.match(output, /implementation effort: +·/);
        await key("low"); await key(enter);
        assert.match(output, /Choose a supported ef/);
        assert.equal(calls.length, 0);
        for (let i = 0; i < 3; i++) await key("\x7f");
        await key(enter);
        for (let i = 0; i < 2; i++) {
          await key(enter); await key(enter); await key(enter);
        }
        await key(enter);
      } else if (managed) {
        for (let i = 0; i < 3; i++) {
          if (i > 0) await key(enter);
          await pickModelAndEffort();
        }
        await key(enter);
      } else {
        await key("\u0015"); await key("1.1");
        await key(enter);
        if (flow !== "edit-models") await key(enter);
        await pickModelAndEffort();
        if (flow !== "edit-models") await key(enter);
      }
      assert.equal(calls.length, 1, flow);
      const input = calls[0].input;
      if (flow === "setup") assert.equal(input.modelForSetup, "Model Name (vendor)");
      else if (seeded) {
        assert.equal(input.roleSettings.implementation.model, "sample-b");
        assert.equal(input.roleSettings.implementation.effort, undefined);
        assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(input.roleSettings)).implementation, "effort"), false);
        await key(enter);
        assert.equal(calls[1].confirmation, "reviewed");
        assert.deepEqual(calls[1].input, input);
      } else if (managed) {
        assert.deepEqual(input.roleSettings, {
          implementation: { harness: "codex", model: "sample-b", effort: "high" },
          review: { harness: "codex", model: "sample-b", effort: "high" },
          repair: { harness: "codex", model: "sample-b", effort: "high" },
          maxFixRounds: 2,
        });
        await key("y");
        assert.match(output, /Clipboard unavail/);
        await key("y");
        assert.match(output, /Settings JSON copi/);
        assert.deepEqual(copied, [JSON.stringify(input.roleSettings), JSON.stringify(input.roleSettings)]);
        assert.equal(calls.length, 1);
        await key(enter);
        assert.equal(calls[1].confirmation, "reviewed");
      } else {
        assert.deepEqual(input.taskIds, ["1.1"], flow);
        assert.equal(input.model, "sample-b", flow);
        assert.equal(input.effort, "high", flow);
      }
    } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
  }
});

test("bulk assignment review preserves bytes on Escape and saves only reviewed tasks", async t => {
  const React = await import("react");
  const { render } = await import("ink");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { actionsFor } = await import("../dist/dashboard-actions.js");
  const { runDashboardAction } = await import("../dist/dashboard-action-runner.js");
  const { collectDashboard } = await import("../dist/dashboard-reader.js");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const { selectDashboardRows, defaultDashboardFilters } = await import("../dist/dashboard-view.js");
  const { root } = featureFixture(t, { unchecked: true });
  const directory = join(root, "openspec/changes/demo");
  const path = join(directory, "execution.yaml");
  writeFileSync(join(directory, "tasks.md"), "- [ ] 1.1 First\n- [ ] 1.2 Second\n- [ ] 1.3 Untouched\n");
  writeFileSync(path, 'version: 1\ntasks:\n  "1.1": {}\n  "1.2": {}\n  "1.3": {model: keep}\n');
  const bytes = readFileSync(path);
  const snapshot = collectDashboard({ cwd: root });
  const target = snapshot.features[0].id;
  const row = selectDashboardRows(snapshot, "Features", defaultDashboardFilters).findIndex(entry => entry.targetId === target);
  const action = actionsFor(snapshot, target).findIndex(entry => entry.id.endsWith(":edit-models"));
  assert.ok(row >= 0 && action >= 0);

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  let output = "";
  const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
  stdout.isTTY = true;
  stdout.columns = 40;
  stdout.rows = 28;
  const lifetime = new AbortController();
  const calls = [];
  let pending;
  const instance = render(React.createElement(DashboardUi, {
    snapshot, collector: { refresh() {} }, lifetime: lifetime.signal, quit() {},
    readCatalog: async (_, harness) => ({ harness, status: "available", entries: [{ selector: "new-model" }] }),
    runAction(request) {
      const call = { request };
      calls.push(call);
      pending = runDashboardAction(request).then(result => { call.result = result; return result; });
      return pending;
    },
  }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const key = async value => {
    stdin.write(value);
    await new Promise(resolve => setTimeout(resolve, 40));
    await instance.waitUntilRenderFlush();
  };
  const down = "\u001b[B", right = "\u001b[C", enter = "\r";
  async function review() {
    output = "";
    pending = undefined;
    await key("a");
    for (let i = 0; i < action; i++) await key(down);
    await key(enter);
    await key("1.1,1.2"); await key(enter);
    await key("new-model"); await key(down); await key(enter);
    await key(enter);
    assert.ok(pending);
    const result = await pending;
    assert.match(result.text, /Task 1\.1[\s\S]*Task 1\.2/);
    await new Promise(resolve => setTimeout(resolve, 40));
    await instance.waitUntilRenderFlush();
    output = output.slice(-3000);
    assert.match(output, /Task 1\.1[\s\S]*\+ model: new-model[\s\S]*Task 1\.2[\s\S]*\+ model: new-model/);
    assert.match(output, /Enter confirm · Esc cancel/);
    assert.deepEqual(readFileSync(path), bytes);
  }
  try {
    await instance.waitUntilRenderFlush();
    await key(right); await key(right);
    for (let i = 0; i < row; i++) await key(down);
    await review();
    await key("\u001b");
    assert.equal(calls.length, 1);
    assert.deepEqual(readFileSync(path), bytes);
    await review();
    const reviewed = calls[1];
    assert.ok(reviewed.result.confirmation);
    assert.deepEqual(reviewed.request.input.taskIds, ["1.1", "1.2"]);
    await key(enter);
    await pending;
    assert.equal(calls.length, 3);
    assert.equal(calls[2].request.confirmation, reviewed.result.confirmation);
    assert.deepEqual(calls[2].request.input, reviewed.request.input);
    const reloaded = collectDashboard({ cwd: root });
    assert.deepEqual(reloaded.tasks.map(row => [row.task.id, row.assignment.model]), [
      ["1.1", "new-model"], ["1.2", "new-model"], ["1.3", "keep"],
    ]);
  } finally {
    lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy();
  }
});

for (const columns of [40,80]) for (const available of [true,false]) test(`Copilot keyboard confirmation at ${columns} columns with ${available ? "single Fusion choice" : "unavailable catalog"} clears Claude effort`, async () => {
  const React = await import("react");
  const { render } = await import("ink");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const { actionsFor } = await import("../dist/dashboard-actions.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = "";
  const stdout = new Writable({write(chunk,_,done){output += chunk.toString();done();}});
  stdout.isTTY = true; stdout.columns = columns; stdout.rows = 28;
  const lifetime = new AbortController(), calls = [];
  const saved = {harness:"claude",model:"sonnet",effort:"low"};
  const feature = {id:"local:demo",change:"demo",origin:"local",completed:0,total:1,taskIds:[],sessionIds:[],state:{phase:"awaiting-plan-approval",jobs:[],approval:{implementation:saved,review:saved,repair:saved,maxFixRounds:2}}};
  const snapshot = {version:1,repository:{root:"/repo"},features:[feature],tasks:[],sessions:[],assignments:[],attention:[],errors:[],sources:{}};
  const instance = render(React.createElement(DashboardUi,{snapshot,collector:{refresh(){}},lifetime:lifetime.signal,quit(){},
    readCatalog:async (_,harness)=>({harness,status:available?"available":"unavailable",entries:available?[{selector:"auto",label:"Copilot Fusion",source:"discovered",effortSupport:"unsupported",efforts:["low","high"]}]:[]}),
    runAction:async request=>{calls.push(request);return {text:"Review settings",...(!request.confirmation?{confirmation:"reviewed"}: {})};},
  }),{stdin,stdout,stderr:stdout,interactive:true,exitOnCtrlC:false,patchConsole:false});
  const key = async value=>{output="";stdin.write(value);await new Promise(r=>setTimeout(r,35));await instance.waitUntilRenderFlush();};
  try {
    await instance.waitUntilRenderFlush(); await key("\u001b[C");await key("\u001b[C");await key("a");
    const index = actionsFor(snapshot,feature.id).findIndex(a=>a.id.endsWith(":managed-plan-settings"));
    assert.ok(index>=0);for(let i=0;i<index;i++)await key("\u001b[B");await key("\r");
    await key("\r");await key("\r"); // preserve implementation Claude low
    for(let i=0;i<6;i++)await key("\x7f");await key("copilot");await key("\r");
    if(available) {
      assert.match(stripVTControlCharacters(output), columns === 80 ? /Only advertised choice: auto · Copilot Fusion/ : /Only adver/);
      assert.doesNotMatch(stripVTControlCharacters(output), /↑↓ auto/);
    }
    if(available){await key("\u001b[B");await key("\r");}else{await key("auto");await key("\r");}
    assert.match(stripVTControlCharacters(output),/Effort unavail/);
    await key("high");await key("\r");
    assert.match(stripVTControlCharacters(output),/Choose a supported ef/);
    assert.equal(calls.length,0);
    for(let i=0;i<4;i++)await key("\x7f");await key("\r"); // no effort
    await key("\r");await key("\r");await key("\r");await key("\r");
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].input.roleSettings.review,{harness:"copilot",model:"auto",effort:undefined});
    await key("\r");
    assert.equal(calls[1].confirmation,"reviewed");
    assert.deepEqual(calls[1].input,calls[0].input);
  }finally{lifetime.abort();instance.unmount();instance.cleanup();stdin.destroy();}
});
