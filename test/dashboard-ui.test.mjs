import test from "node:test";
import assert from "node:assert/strict";
const filters = { search: "", includeCompleted: false, includeOlderAttempts: false, sort: "name" };
const snapshot = { version: 1, collectedAt: "now", repository: { root: "/repo" }, features: [{ id: "local:a", origin: "local", change: "Alpha", completed: 0, total: 1, taskIds: ["t"], sessionIds: [] }, { id: "local:b", origin: "local", change: "Beta", phase: "completed", completed: 1, total: 1, taskIds: [], sessionIds: [] }], tasks: [{ id: "t", featureId: "local:a", harness: "claude", task: { id: "1.1", description: "Build", completed: false }, ready: true, reasons: [], assignment: { dependsOn: [], model: "model" }, attempts: [] }], sessions: [], assignments: [], attention: [{ id: "alert", source: "local:a", targetId: "t", priority: 1, message: "Blocked" }], errors: [], sources: {} };
test("first-run guidance advances with collected project evidence", async () => {
  const { firstRunRows } = await import("../dist/dashboard-view.js");
  const s = { ...structuredClone(snapshot), features: [], tasks: [], setup: { configuration: "missing" } };
  assert.equal(firstRunRows(s)[0].projectSetup, true);
  s.setup.configuration = "invalid";
  assert.equal(firstRunRows(s)[0].primary, "project:doctor");
  s.setup.configuration = "ready";
  assert.match(firstRunRows(s)[0].label, /numbered checkboxes/);
  s.setup.scopedChange = "Alpha";
  assert.match(firstRunRows(s)[0].label, /No local change named Alpha/);
  s.errors.push({ source: "local:Alpha", message: "Duplicate task number: 1.1" });
  assert.match(firstRunRows(s)[0].label, /Duplicate task/);
  s.errors = [];
  s.features = [{ ...snapshot.features[0], missingExecution: true }];
  assert.equal(firstRunRows(s)[0].primary, "local:a:starter-create");
  s.features[0].missingExecution = false;
  s.features[0].planFingerprint = "current";
  assert.equal(firstRunRows(s)[0].primary, "local:a:validate");
  assert.deepEqual(firstRunRows(s, new Set(["local:a:current"])), []);
  s.features[0].completed = 1;
  assert.deepEqual(firstRunRows(s), []);
});
test("filter choices keep exact owners with spaces and preserve a disappeared selection", async () => {
  const { dashboardFilterChoices } = await import("../dist/dashboard-view.js");
  const s = { ...snapshot, assignments: [
    { id: "a", owner: "Build Team", componentId: "api", featureId: "local:a", status: { phase: "assigned" } },
  ] };
  assert.deepEqual(dashboardFilterChoices(s, "Assignments", { ...filters, owner: "Former Owner" }, "owner"), [
    { value: undefined, label: "Any", count: 1 },
    { value: "Build Team", label: "Build Team", count: 1 },
    { value: "Former Owner", label: "Former Owner", count: 0 },
  ]);
});

test("views default to active work and filter the current view", async () => {
  const { selectDashboardRows } = await import("../dist/dashboard-view.js");
  assert.deepEqual(selectDashboardRows(snapshot, "Overview", filters).map(r => r.id), ["local:a"]);
  assert.equal(selectDashboardRows(snapshot, "Features", { ...filters, includeCompleted: true }).length, 3);
  assert.equal(selectDashboardRows(snapshot, "Features", { ...filters, harness: "claude" }).length, 2);
  assert.equal(selectDashboardRows(snapshot, "Attention", { ...filters, search: "blocked" })[0].targetId, "t");
  assert.deepEqual(selectDashboardRows(snapshot, "Sessions", filters), []);
  assert.deepEqual(selectDashboardRows(snapshot, "Assignments", filters), []);
});
test("refresh preserves stable selection and falls back when the row disappears", async () => {
  const { preserveSelection } = await import("../dist/dashboard-view.js");
  assert.equal(preserveSelection([{ id: "b" }, { id: "a" }], "a"), "a");
  assert.equal(preserveSelection([{ id: "b" }], "a"), "b");
});
test("activity pages bound retained entries and reset changed streams", async () => {
  const { mergeActivity } = await import("../dist/dashboard-view.js");
  const entries = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), text: String(i) }));
  assert.equal(mergeActivity(entries, { entries: [{ id: "1000" }], reset: false }, "newer").length, 1000);
  assert.deepEqual(mergeActivity(entries, { entries: [{ id: "new" }], reset: true }, "newer"), [{ id: "new" }]);
  assert.deepEqual(mergeActivity(entries, { entries: [{ id: "old" }], reset: false }, "older"), [{ id: "old" }]);
});
test("activity reads use collector IPC and page errors leave snapshots intact", async () => {
  const { startDashboardCollector } = await import("../dist/dashboard-client.js");
  const collector = startDashboardCollector({ cwd: process.cwd() }, () => {}, () => {});
  try {
    assert.equal(typeof collector.readActivity, "function");
    const page = await collector.readActivity({ log: "/missing-dashboard-log", identity: { attemptId: "a", harness: "codex" }, direction: "older", mode: "raw" });
    assert.ok(page.errors.length);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(collector.readActivity({ log: "/missing", identity: { attemptId: "a", harness: "codex" }, direction: "older" }, abort.signal), /cancel/i);
  } finally { await collector.close(); }
});
test("timeline links historical attempts and separates accepted reports from integration", async () => {
  const { featureTimeline } = await import("../dist/dashboard-view.js");
  const s = structuredClone(snapshot);
  const at = "2026-11-14T08:00:00.000Z";
  const approval = { token: "approved", at };
  s.features[0].state = { approval, approvalHistory: [approval], jobs: [] };
  s.sessions = [
    { id: "old", featureId: "local:a", role: "implementation", attempt: { id: "old", task: "1.1", phase: "failed", report: { outcome: "failed" } } },
    { id: "new", featureId: "local:a", role: "implementation", attempt: { id: "new", task: "1.1", phase: "completed", report: { outcome: "completed" }, worker: { exitedAt: at } } },
    { id: "repair", featureId: "local:a", role: "repair", attempt: { id: "repair", phase: "integrated", report: { outcome: "completed" } } },
  ];
  const events = featureTimeline(s, "local:a");
  assert.deepEqual(events.slice(0, 2).map(event => event.id), [`approval:approved:${at}`, "new:exit"]);
  assert.equal(events.find(event => event.id === "old:report").targetId, "old");
  assert.equal(events.find(event => event.id === "new:report").at, undefined);
  assert.ok(!events.some(event => event.id === "new:integrated"));
  assert.ok(events.some(event => event.id === "repair:integrated"));
  assert.deepEqual(featureTimeline(structuredClone(s), "local:a"), events);
});

test("Overview prioritizes recovery and keeps worker waits separate", async () => {
  const { selectDashboardRows } = await import("../dist/dashboard-view.js");
  const s = structuredClone(snapshot);
  const feature = s.features[0];
  feature.phase = "awaiting-final-approval";
  feature.state = { approval: {}, jobs: [] };
  feature.recovery = [
    { kind: "worker", attempt: "waiting", evidence: "Report accepted. Waiting for exit.", argv: [] },
    { kind: "integration", task: "1.1", evidence: "Git index contains unresolved conflicts.", argv: [] },
  ];
  feature.execution = { head: "head", path: "/integration", fingerprint: "plan" };
  feature.nextAction = { integrate: ["integrate", "Alpha", "--tasks", "1.1"] };
  s.tasks[0].attempts = [{ id: "original", phase: "completed" }];
  const filters = { search: "", includeCompleted: true, includeOlderAttempts: false, sort: "name" };
  const rows = selectDashboardRows(s, "Overview", filters);
  assert.match(rows[0].label, /Needs you.*Resolve conflict in task 1.1/);
  assert.ok(rows.find(row => row.primary?.endsWith(":managed-final")));
  assert.ok(rows.find(row => /In progress.*Waiting for exit/.test(row.label)));
  const integration = rows.find(row => row.primary?.endsWith(":integrate-run"));
  assert.equal(integration.targetId, feature.id);
  assert.equal(integration.tasks, "1.1");
  assert.equal(rows.filter(row => row.primary === integration.primary).length, 1);
  s.tasks[0].attempts.push({ id: "replacement", phase: "completed" });
  assert.notEqual(selectDashboardRows(s, "Overview", filters).find(row => row.primary === integration.primary).id, integration.id);
  s.sources[feature.id] = { stale: true };
  assert.ok(selectDashboardRows(s, "Overview", filters).every(row => row.targetId !== feature.id || !row.primary));
});

test("keys navigate details filters help and narrow terminals while collection is unresolved", async () => {
  const { PassThrough, Writable } = await import("node:stream");
  const React = await import("react"); const { render } = await import("ink");
  const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = ""; const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }); stdout.isTTY = true; stdout.columns = 40; stdout.rows = 12;
  const lifetime = new AbortController(); let quit = false;
  const collector = { refresh() {}, close: async () => {}, readActivity: async () => new Promise(() => {}) };
  const suggested = structuredClone(snapshot);
  suggested.features[0].nextAction = { launch: ["launch", "Alpha", "--tasks", "1.1", "--dry-run", "--json"] };
  const instance = render(React.createElement(DashboardUi, { snapshot: suggested, collector, lifetime: lifetime.signal, quit() { quit = true; } }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const key = async value => { stdin.write(value); await new Promise(resolve => setTimeout(resolve, 35)); await instance.waitUntilRenderFlush(); };
  try {
    await instance.waitUntilRenderFlush(); assert.match(output, /Overview/);
    await key("g"); assert.match(output, /Check project/);
    for (let i = 0; i < 3; i++) await key("\u001b[B");
    await key("\r"); assert.match(output, /Enter confirm/);
    await key("\u001b"); assert.match(output, /Cancelled/);
    await key("s"); await key("unman"); assert.match(output, /unmanaged \(1\)/);
    await key("\r"); assert.match(output, /s:unmanaged/);
    await key("\u001b[C"); assert.match(output, /Attention/);
    assert.match(output.split("\n").slice(-12).join("\n"), /s:all/);
    await key("\r"); assert.match(output, /details/);
    await key("?"); assert.match(output, /Esc back/);
    await key("\u001b"); await key("/"); await key("blocked"); await key("\r");
    assert.match(output, /blocked/);
    await key("\u001b"); await key("\u001b[D"); assert.match(output.split("\n").slice(-12).join("\n"), /s:unmanaged/);
    await key("0"); assert.match(output.split("\n").slice(-12).join("\n"), /s:all/);
    await key("a"); await key("\u001b[B"); await key("\u001b[B"); await key("\r"); assert.match(output, /openspec-runner.*launch/);
    await key("\u001b"); await key("a"); await key("\u001b[B"); await key("\r");
    assert.match(output, /tasks: 1\.1/);
    await key("\u0015"); await key("1.2");
    assert.match(output, /tasks: 1\.2/);
    await key("\u001b"); await key("q"); assert.equal(quit, true);
  } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
});
test("closing collector rejects queued and active activity without waiting for snapshots", async () => {
  const { startDashboardCollector } = await import("../dist/dashboard-client.js");
  const collector = startDashboardCollector({ cwd: process.cwd() }, () => {}, () => {});
  const options = { log: "/missing", identity: { attemptId: "a", harness: "codex" }, direction: "older" };
  const requests = Array.from({ length: 9 }, () => collector.readActivity(options));
  const settled = Promise.allSettled(requests);
  await collector.close();
  const results = await settled;
  assert.equal(results.filter(r => r.status === "rejected").length, 9);
  assert.match(results[8].reason.message, /queue is full/);
  await assert.rejects(collector.readActivity(options), /closed/);
});
test("managed features stay active after tasks finish until lifecycle completion", async () => {
  const { selectDashboardRows } = await import("../dist/dashboard-view.js");
  const managed = { ...snapshot, features: [{ ...snapshot.features[0], completed: 1, phase: "awaiting-final-approval" }] };
  assert.deepEqual(selectDashboardRows(managed, "Overview", filters).map(row => row.targetId), ["local:a", "local:a"]);
});
test("session activity ignores a late response after selection changes and exposes raw follow controls", async () => {
  const { PassThrough, Writable } = await import("node:stream");
  const React = await import("react"); const { render } = await import("ink"); const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = ""; const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }); stdout.isTTY = true; stdout.columns = 120; stdout.rows = 20;
  const lifetime = new AbortController(); const pending = [];
  const collector = { refresh() {}, close: async () => {}, readActivity(options, signal) { return new Promise(resolve => pending.push({ options, signal, resolve })); } };
  const make = id => ({ id, featureId: "local:a", taskId: id, role: "implementation", phase: "running", process: "unknown", terminal: "unknown", log: `/logs/${id}`, attempt: { id, agent: "codex", phase: "running", path: "/worktree", terminal: { backend: "manual" }, base: "a".repeat(40) } });
  const fixture = { ...snapshot, sessions: [make("one"), make("two")] };
  const instance = render(React.createElement(DashboardUi, { snapshot: fixture, collector, lifetime: lifetime.signal, quit() {} }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const key = async value => { stdin.write(value); await new Promise(resolve => setTimeout(resolve, 35)); await instance.waitUntilRenderFlush(); };
  const page = (id, text) => ({ entries: [{ version: 1, id, identity: { attemptId: id, harness: "codex" }, kind: "raw", stream: "stdout", text }], cursor: id, reset: false, errors: [] });
  try {
    await instance.waitUntilRenderFlush(); await key("\u001b[C"); await key("\u001b[C"); await key("\u001b[C");
    await key("\u001b[B");
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve(page("one", "obsolete session response"));
    pending.at(-1).resolve(page("two", "current activity"));
    await key("\r"); await key("\r"); assert.match(output, /current activity/); assert.doesNotMatch(output, /obsolete session response/);
    await key("\u001b[A"); assert.match(output, /PAUSED/);
    await key("f"); assert.match(output, /following/);
    await key("w"); assert.equal(pending.at(-1).options.mode, "raw"); assert.equal(pending.at(-1).options.cursor, undefined);
    pending.at(-1).resolve(page("two", "raw payload")); await key("x"); assert.match(output, /raw payload/);
  } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
});


test("collector metadata records missing worktree and valid capacity and harness", async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs"); const { join } = await import("node:path"); const { tmpdir } = await import("node:os"); const { execFileSync } = await import("node:child_process"); const { loadPlan } = await import("../dist/plan.js"); const { repository } = await import("../dist/system.js");
  const root = mkdtempSync(join(tmpdir(), "dashboard-ui-metadata-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" }); mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/runner.yaml"), "version: 1\n"); writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 First\n"); writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), "version: 1\ntasks:\n  1.1: {}\n");
  const repo = repository(root); mkdirSync(repo.stateDir, { recursive: true });
  writeFileSync(join(repo.stateDir, "demo.json"), JSON.stringify({ version: 1, change: "demo", fingerprint: loadPlan(root, "demo").fingerprint, integration: { path: root, branch: "main", base: "base" }, head: "head", baseline: [], attempts: [{ id: "missing", task: "1.1", description: "First", fingerprint: "f", settings: { model: "m", reasoningEffort: "high" }, phase: "running", terminal: {}, path: join(root, "missing"), branch: "a", base: "base" }] }));
  const { collectDashboard } = await import("../dist/dashboard-reader.js"); const result = collectDashboard({ cwd: root });
  assert.equal(result.sessions[0].worktreeAvailable, false);
  assert.equal(result.repository.maxParallel, 4); assert.equal(result.tasks[0].harness, "codex");
});
async function activityUiFixture(t, { height = 12, width = 100, dashboard, navigate = true } = {}) {
  const { PassThrough, Writable } = await import("node:stream");
  const React = await import("react"); const { render } = await import("ink"); const { DashboardUi } = await import("../dist/dashboard-ui.js");
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
  let output = ""; const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }); stdout.isTTY = true; stdout.columns = width; stdout.rows = height;
  const lifetime = new AbortController(), requests = [];
  const collector = { refresh() {}, close: async () => {}, readActivity(options, signal) { return new Promise(resolve => requests.push({ options, signal, resolve })); } };
  const session = { id: "stream", featureId: "local:a", taskId: "t", role: "implementation", phase: "running", process: "unknown", terminal: "unknown", log: "/log", attempt: { id: "stream", agent: "codex", phase: "running", path: "/worktree", terminal: {}, base: "a".repeat(40) } };
  const fixture = dashboard ?? { ...snapshot, sessions: [session] };
  const props = { snapshot: fixture, collector, lifetime: lifetime.signal, quit() {} };
  const instance = render(React.createElement(DashboardUi, props), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
  t.after(() => { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); });
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 40)); await instance.waitUntilRenderFlush(); };
  const key = async input => { output = ""; stdin.write(input); await flush(); };
  await flush();
  if (navigate) {
    await key("\u001b[C"); await key("\u001b[C"); await key("\u001b[C");
    await key("\r"); await key("\r");
  }
  return { requests, key, flush, get output() { return output; }, clone(next = fixture) { instance.rerender(React.createElement(DashboardUi, { ...props, snapshot: structuredClone(next) })); }, page(entries, cursor) { return { entries: entries.map((text, i) => ({ version: 1, id: text, identity: { attemptId: "stream", harness: "codex" }, kind: "message", stream: "stdout", text })), ...(cursor ? { cursor } : {}), reset: false, errors: [] }; } };
}

test("picker keeps its selection across refresh and Any clears only that filter", async t => {
  const dashboard = { ...snapshot, assignments: [{ id: "a", featureId: "local:a", owner: "Build Team" }] };
  const ui = await activityUiFixture(t, { dashboard, navigate: false, width: 48 });
  await ui.key("o"); await ui.key("build");
  assert.match(ui.output, /Build Team \(1\)/);
  ui.clone(dashboard); await ui.flush();
  await ui.key("\r");
  assert.match(ui.output, /o:Build Team/);
  await ui.key("o"); await ui.key("\u001b[A"); await ui.key("\r");
  assert.match(ui.output, /o:all/);
});

test("Overview rejects an integration form after its attempt is replaced", async t => {
  const dashboard = structuredClone(snapshot);
  const feature = dashboard.features[0];
  feature.execution = { head: "head", path: "/integration", fingerprint: "plan" };
  feature.nextAction = { integrate: ["integrate", "Alpha", "--tasks", "1.1"] };
  dashboard.tasks[0].attempts = [{ id: "first", phase: "completed" }];
  const ui = await activityUiFixture(t, { dashboard, navigate: false });
  await ui.key("\r"); assert.match(ui.output, /tasks: 1.1/);
  dashboard.tasks[0].attempts.push({ id: "second", phase: "completed" });
  ui.clone(dashboard); await ui.flush();
  await ui.key("\r"); assert.match(ui.output, /Selection changed/);
});

test("timeline keeps an older attempt selected when fresh evidence arrives", async t => {
  const dashboard = structuredClone(snapshot);
  const session = (id, exitedAt) => ({ id, featureId: "local:a", role: "implementation", phase: "failed",
    attempt: { id, task: "1.1", phase: "failed", terminal: {}, worker: { exitedAt } } });
  dashboard.sessions = [session("original-attempt", "2026-11-12T08:00:00Z")];
  const ui = await activityUiFixture(t, { dashboard, navigate: false });
  await ui.key("c"); await ui.key("\u001b[C"); await ui.key("\u001b[C");
  await ui.key("/");
  await ui.key("Alpha");
  await ui.key("\r");
  const { actionsFor } = await import("../dist/dashboard-actions.js");
  await ui.key("a");
  for (const action of actionsFor(dashboard, "local:a")) {
    if (action.kind === "timeline") break;
    await ui.key("\u001b[B");
  }
  await ui.key("\r"); assert.match(ui.output, /Timeline.*Alpha/);
  dashboard.sessions.push(session("new-attempt", "2026-11-14T08:00:00Z"));
  ui.clone(dashboard); await ui.flush();
  await ui.key("\r"); assert.match(ui.output, /Worker exit recorded.*original-attempt/);
  await ui.key("\u001b"); assert.match(ui.output, /▸.*original-attempt/);
});

test("guided validation leaves a failed check visible and offers it again", async t => {
  const { featureFixture } = await import("./helpers/feature-fixture.mjs");
  const { collectDashboard } = await import("../dist/dashboard-reader.js");
  const fixture = featureFixture(t, { unchecked: true });
  fixture.control({ notReady: true });
  const dashboard = collectDashboard({ cwd: fixture.root });
  const ui = await activityUiFixture(t, { dashboard, navigate: false });
  await ui.key("\r");
  const deadline = Date.now() + 8000;
  while (!/Action failed/.test(ui.output) && Date.now() < deadline) await ui.flush();
  assert.match(ui.output, /Action failed/);
  assert.match(ui.output, /Prepare missing artifacts/);
  ui.clone(collectDashboard({ cwd: fixture.root })); await ui.flush();
  await ui.key("\u001b"); assert.match(ui.output, /Validate the change/);
});
test("empty activity pages preserve newer and older continuation boundaries", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(["saved tail"], "tail-boundary")); await ui.flush();
  await ui.key("f"); ui.requests.at(-1).resolve(ui.page([])); await ui.flush();
  await ui.key("f"); assert.equal(ui.requests.at(-1).options.cursor, "tail-boundary");
  ui.requests.at(-1).resolve(ui.page([])); await ui.flush();
  await ui.key("b"); ui.requests.at(-1).resolve(ui.page(["oldest retained entry"], "history-start")); await ui.flush();
  await ui.key("b"); ui.requests.at(-1).resolve(ui.page([])); await ui.flush();
  await ui.key("b"); assert.equal(ui.requests.at(-1).options.cursor, "history-start");
});
test("fresh snapshot session clones cannot starve the activity polling clock", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(["start"], "tail")); await ui.flush();
  for (let i = 0; i < 7; i++) {
    await new Promise(resolve => setTimeout(resolve, 350)); ui.clone(); await ui.flush();
    if (ui.requests.length > 1) break;
  }
  assert.ok(ui.requests.length > 1, "poll must fire despite snapshots arriving more frequently than two seconds");
  assert.equal(ui.requests[1].options.direction, "newer"); assert.equal(ui.requests[1].options.cursor, "tail");
});
test("delayed follow page preserves the paused viewport anchor after scrolling", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(Array.from({ length: 12 }, (_, i) => `row-${i}`), "tail")); await ui.flush();
  await ui.key("f"); const pending = ui.requests.at(-1);
  await ui.key("\u001b[A"); await ui.key("\u001b[A");
  pending.resolve(ui.page(["newest-row"], "appended")); await ui.flush();
  assert.doesNotMatch(ui.output, /newest-row/, "late append must not move a paused reader to tail");
  await ui.key("\u001b[B"); assert.match(ui.output, /row-10/); assert.doesNotMatch(ui.output, /newest-row/);
});
test("expanded activity can scroll to lines beyond one terminal viewport", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page([Array.from({ length: 14 }, (_, i) => `expanded-line-${i}`).join("\n")], "tail")); await ui.flush();
  await ui.key("x");
  let inspected = "";
  // Borders leave fewer visible rows; scroll far enough to inspect the whole record.
  for (let i = 0; i < 14; i++) { await ui.key("\u001b[B"); inspected += ui.output; }
  assert.match(inspected, /expanded-line-13/);
});
test("empty older pages retain their boundary and currently inspected history", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(["tail"], "tail-boundary")); await ui.flush();
  await ui.key("b"); ui.requests.at(-1).resolve(ui.page(["history at start"], "history-start")); await ui.flush();
  await ui.key("b"); ui.requests.at(-1).resolve(ui.page([])); await ui.flush();
  assert.doesNotMatch(ui.output, /No activity available/);
  await ui.key("b"); assert.equal(ui.requests.at(-1).options.cursor, "history-start");
});
test("paused filtered activity keeps its exact visible anchor on invisible appends", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(["match first", "unrelated before", "match anchor", "unrelated tail"], "tail")); await ui.flush();
  await ui.key("/"); await ui.key("match"); await ui.key("\r");
  await ui.key("f"); const pending = ui.requests.at(-1); await ui.key("p");
  pending.resolve(ui.page(["invisible append one", "invisible append two"], "next")); await ui.flush();
  await ui.key("?"); await ui.key("?");
  assert.match(ui.output, /match first/); assert.match(ui.output, /match anchor/); assert.doesNotMatch(ui.output, /No activity available|invisible append/);
});
test("paused expanded filtered activity anchors matching lines across mixed appends", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(["unrelated before", "match anchor\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\nkeep-7"], "tail")); await ui.flush();
  await ui.key("/"); await ui.key("match"); await ui.key("\r"); await ui.key("x");
  await ui.key("f"); const pending = ui.requests.at(-1); await ui.key("p"); await ui.key("\u001b[A"); await ui.key("\u001b[A");
  pending.resolve(ui.page(["invisible expanded\nnoise-1\nnoise-2\nnoise-3\nnoise-4\nnoise-5", "match new\nnew matching line"], "next")); await ui.flush();
  await ui.key("?"); await ui.key("?");
  assert.match(ui.output, /keep-5/); assert.doesNotMatch(ui.output, /keep-6|new matching line|noise-|No activity available/);
  let inspected = ""; for (let i = 0; i < 4; i++) { await ui.key("\u001b[B"); inspected += ui.output; }
  assert.match(inspected, /new matching line/);
});
test("filtered activity clamps scrolling and anchors retained rows when the feed trims", async t => {
  const ui = await activityUiFixture(t);
  const retained = Array.from({ length: 1000 }, (_, i) => i === 900 ? "match retained" : i === 999 ? "match tail" : `unrelated-${i}`);
  ui.requests[0].resolve(ui.page(retained.slice(0, 200), "page-200")); await ui.flush();
  for (let start = 200; start < 1000; start += 200) {
    await ui.key("f"); ui.requests.at(-1).resolve(ui.page(retained.slice(start, start + 200), `page-${start + 200}`)); await ui.flush();
  }
  await ui.key("/"); await ui.key("match"); await ui.key("\r");
  await ui.key("f"); const pending = ui.requests.at(-1); await ui.key("p");
  for (let i = 0; i < 6; i++) await ui.key("\u001b[A");
  pending.resolve(ui.page(Array.from({ length: 100 }, (_, i) => `excluded-${i}`), "trimmed")); await ui.flush();
  await ui.key("?"); await ui.key("?");
  assert.match(ui.output, /match retained/); assert.doesNotMatch(ui.output, /No activity available|excluded-/);
  await ui.key("\u001b[B"); assert.match(ui.output, /match tail/);
});
test("a pending activity page preserves anchors under the current newly applied search", async t => {
  const ui = await activityUiFixture(t);
  ui.requests[0].resolve(ui.page(["match first", "unrelated before", "match anchor", "unrelated tail"], "tail")); await ui.flush();
  await ui.key("f"); const pending = ui.requests.at(-1);
  await ui.key("/"); await ui.key("MATCH"); await ui.key("\r"); await ui.key("p");
  pending.resolve(ui.page(["unrelated append one", "unrelated append two"], "next")); await ui.flush();
  await ui.key("?"); await ui.key("?");
  assert.match(ui.output, /match first/); assert.match(ui.output, /match anchor/); assert.doesNotMatch(ui.output, /No activity available/);
});
test("retention dropping the paused filtered anchor clamps to remaining matching history", async t => {
  const ui = await activityUiFixture(t);
  const entries = Array.from({ length: 1000 }, (_, i) => i === 0 ? "match removed" : i === 999 ? "match survivor" : `irrelevant-${i}`);
  ui.requests[0].resolve(ui.page(entries.slice(0, 200), "page-200")); await ui.flush();
  for (let start = 200; start < 1000; start += 200) {
    await ui.key("f"); ui.requests.at(-1).resolve(ui.page(entries.slice(start, start + 200), `page-${start + 200}`)); await ui.flush();
  }
  await ui.key("/"); await ui.key("match"); await ui.key("\r"); await ui.key("f");
  const pending = ui.requests.at(-1); await ui.key("p"); await ui.key("\u001b[A");
  pending.resolve(ui.page(Array.from({ length: 200 }, (_, i) => `unseen-${i}`), "trimmed")); await ui.flush();
  await ui.key("?"); await ui.key("?");
  assert.match(ui.output, /match survivor/); assert.doesNotMatch(ui.output, /match removed|No activity available|unseen-/);
});
test("feature rows label shared delivery separately from local task satisfaction", async () => {
  const { selectDashboardRows } = await import("../dist/dashboard-view.js");
  const local = { ...snapshot.features[0], completed: 1, total: 2 };
  const shared = { id: "shared:team", origin: "shared", completed: 1, total: 2, taskIds: [], sessionIds: [] };
  const fixture = { ...snapshot, features: [local, shared] };
  for (const view of ["Overview", "Features"]) {
    const rows = selectDashboardRows(fixture, view, { ...filters, includeCompleted: true });
    assert.match(rows.find(row => row.id === shared.id).label, /1\/2 components delivered/);
    assert.match(rows.find(row => row.id === local.id).label, /1\/2 tasks satisfied/);
  }
});
for (const [name, completed, total, expected] of [["shared-only", 0, 0, "0/0"], ["mixed local and shared", 1, 2, "1/2"]]) {
  test(`${name} headline counts local tasks without delivered shared components`, async () => {
    const { PassThrough, Writable } = await import("node:stream");
    const React = await import("react"); const { render } = await import("ink"); const { DashboardUi } = await import("../dist/dashboard-ui.js");
    const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => stdin;
    let output = ""; const stdout = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } }); stdout.isTTY = true; stdout.columns = 110; stdout.rows = 20;
    const lifetime = new AbortController();
    const shared = { id: "shared:team", origin: "shared", completed: 3, total: 3, taskIds: [], sessionIds: [] };
    const local = { ...snapshot.features[0], completed, total, taskIds: ["t", "second"] };
    const tasks = total ? [snapshot.tasks[0], { ...snapshot.tasks[0], id: "second", task: { ...snapshot.tasks[0].task, id: "1.2" } }] : [];
    const fixture = { ...snapshot, features: total ? [local, shared] : [shared], tasks, sessions: [], assignments: [], attention: [] };
    const collector = { refresh() {}, close: async () => {}, readActivity: async () => ({ entries: [], reset: false, errors: [] }) };
    const instance = render(React.createElement(DashboardUi, { snapshot: fixture, collector, lifetime: lifetime.signal, quit() {} }), { stdin, stdout, stderr: stdout, interactive: true, exitOnCtrlC: false, patchConsole: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 40)); await instance.waitUntilRenderFlush();
      assert.match(output, new RegExp(`Tasks ${expected}`));
      const count = output.match(/Tasks (\d+)\/(\d+)/); assert.ok(Number(count[1]) <= Number(count[2]));
    } finally { lifetime.abort(); instance.unmount(); instance.cleanup(); stdin.destroy(); }
  });
}
