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
