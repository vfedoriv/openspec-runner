import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { collectDashboard } from "../dist/dashboard-reader.js";
import { repository } from "../dist/system.js";
import { loadPlan } from "../dist/plan.js";
import { featureFixture, blocker, git } from "./helpers/feature-fixture.mjs";
const module = await import("../dist/dashboard-actions.js").catch(() => ({}));
const actionsFor = (...args) => { assert.equal(typeof module.actionsFor, "function", "action allowlist is implemented"); return module.actionsFor(...args); };
const previewCommand = (...args) => module.previewCommand(...args);
const runnerModule = await import("../dist/dashboard-action-runner.js").catch(() => ({}));

test("action runner rejects forged command execution", async () => {
  assert.equal(typeof runnerModule.runDashboardAction, "function", "safe action runner is implemented");
  const s = snapshot();
  await assert.rejects(runnerModule.runDashboardAction({ snapshot: s, action: { id: "local:change:inspect", kind: "command", available: true, argv: ["anything"] }, signal: new AbortController().signal }), /kind|command/i);
});

const snapshot = () => ({ version: 1, collectedAt: "now", repository: { root: "/tmp", common: "/tmp", stateDir: "/tmp", currentWorktree: "/tmp" }, features: [{ id: "local:change", change: "change", origin: "local", taskIds: ["local:change:task:1.1"], sessionIds: [], completed: 0, total: 1 }], tasks: [{ id: "local:change:task:1.1", featureId: "local:change", task: { id: "1.1", description: "work", completed: false, line: 0 }, ready: true, reasons: [], attempts: [] }], sessions: [], assignments: [], attention: [], errors: [], sources: {} });

test("launch previews require exact selected tasks and explicit unmanaged settings", () => {
  const s = snapshot(), a = actionsFor(s, s.features[0].id).find(a => a.id.endsWith(":launch-preview"));
  assert.throws(() => previewCommand(s, a, {}), /task/i);
  assert.throws(() => previewCommand(s, a, { taskIds: ["1.1"] }), /model.*effort/i);
  assert.throws(() => previewCommand(s, a, { taskIds: ["1.2"], model: "m", effort: "high" }), /task/i);
  assert.deepEqual(previewCommand(s, { ...a, argv: ["rm", "-rf", "/"] }, { taskIds: ["1.1"], model: "m", effort: "high" }), ["launch", "change", "--tasks", "1.1", "--default-model", "m", "--default-effort", "high", "--dry-run", "--json"]);
});

test("coordination authority blockers prevent previews even with explicit settings", () => {
  const s = snapshot(); s.tasks[0].ready = false; s.tasks[0].reasons = ["Coordination authority: Assignment revoked"];
  const a = actionsFor(s, s.tasks[0].id).find(a => a.id.endsWith(":launch-preview"));
  assert.equal(a.available, false);
  assert.throws(() => previewCommand(s, { ...a, available: true }, { taskIds: ["1.1"], model: "m", effort: "high" }), /authority/i);
  s.features[0].state = { approval: { token: "approved" } };
  const review = actionsFor(s, s.features[0].id).find(a => a.id.endsWith(":review-preview"));
  assert.equal(review.available, false);
  assert.throws(() => previewCommand(s, { ...review, available: true }), /authority/i);
});

test("fully explicit unmanaged assignments avoid calling-session overrides", () => {
  const s = snapshot(); s.tasks[0].assignment = { model: "explicit", reasoningEffort: "high", dependsOn: [], parallel: false };
  const a = actionsFor(s, s.tasks[0].id).find(a => a.id.endsWith(":launch-preview"));
  assert.deepEqual(previewCommand(s, a, { taskIds: ["1.1"] }), ["launch", "change", "--tasks", "1.1", "--dry-run", "--json"]);
});

test("mutation commands and unsafe final verification cannot execute as previews", () => {
  const s = snapshot(); s.features[0].state = { phase: "awaiting-final-approval" };
  const actions = actionsFor(s, s.features[0].id);
  assert.throws(() => previewCommand(s, { ...actions[0], kind: "command", argv: ["launch", "change"] }, {}), /preview/i);
  assert.equal(actions.find(a => a.id.endsWith(":final-preview")).available, false);
  assert.equal(actions.find(a => a.id.endsWith(":archive-preview")).available, false);
});

test("child cancellation stops promptly while streams remain separate and sanitized", async () => {
  const signal = new AbortController();
  const running = runnerModule.dashboardChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), signal.signal);
  setTimeout(() => signal.abort(), 40);
  await assert.rejects(running, /cancel/i);
  const result = await runnerModule.dashboardChild(process.execPath, ["-e", "process.stdout.write('\\x1b[31mout\\x1b[0m');process.stderr.write('err')"], process.cwd(), new AbortController().signal);
  assert.deepEqual(result, { stdout: "out", stderr: "err" });
  await assert.rejects(runnerModule.dashboardChild(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"], process.cwd(), new AbortController().signal), /1 MiB/);
  await assert.rejects(runnerModule.dashboardChild(process.execPath, ["-e", "process.stderr.write('failure');process.exit(9)"], process.cwd(), new AbortController().signal), /9.*failure/);
});

test("unresponsive action child times out without accepting partial output", async () => {
  await assert.rejects(runnerModule.dashboardChild(process.execPath, ["-e", "process.stdout.write('partial');setInterval(()=>{},1000)"], process.cwd(), new AbortController().signal), /timed out after 30 seconds/);
});

test("finished ambiguous manual missing and feature-role sessions cannot auto resume", () => {
  const s = snapshot();
  const a = { id: "one", phase: "running", path: process.cwd(), session: "saved", terminal: {} };
  for (const role of ["implementation", "review", "repair"]) {
    for (const change of [{ report: { outcome: "completed" } }, { worker: { exitedAt: "now" } }, { terminal: { closed: true } }, { path: "/missing-dashboard-path" }, { phase: "manual" }, { session: undefined }, { terminal: {} }]) {
      const session = { id: "local:change:attempt:one", featureId: "local:change", role, phase: "running", process: "unknown", terminal: "unknown", attempt: { ...a, ...change } };
      s.sessions = [session];
      assert.equal(actionsFor(s, session.id).find(a => a.kind === "focus").available, false);
    }
  }
});

test("diff rejects persisted revision text that could become a Git option", () => {
  const s = snapshot();
  s.sessions = [{ id: "local:change:attempt:bad", featureId: "local:change", role: "implementation", attempt: { path: process.cwd(), base: "--output=unexpected", terminal: {}, phase: "running" }, phase: "running", process: "unknown", terminal: "unknown" }];
  assert.equal(actionsFor(s, s.sessions[0].id).find(a => a.kind === "diff").available, false);
});

test("focus preserves the exact historical attempt and never creates or resumes a terminal", async t => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-actions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/runner.yaml"), "version: 1\n");
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 First\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), '{"version":1,"tasks":{"1.1":{}}}');
  const repo = repository(root); mkdirSync(repo.stateDir, { recursive: true });
  const old = { id: "old", task: "1.1", description: "First", fingerprint: "f", settings: { model: "m", reasoningEffort: "high" }, phase: "running", session: "old-session", terminal: {}, path: root, branch: "old", base: "base" };
  const state = { version: 1, change: "demo", fingerprint: loadPlan(root, "demo").fingerprint, head: "head", integration: { path: root, branch: "main", base: "base" }, baseline: [], attempts: [old, { ...old, id: "new", session: "new-session" }] };
  const path = join(repo.stateDir, "demo.json"); writeFileSync(path, JSON.stringify(state));
  const selected = collectDashboard({ cwd: root }), action = actionsFor(selected, "local:demo:attempt:old").find(a => a.kind === "focus");
  const before = readFileSync(path, "utf8"), refs = execFileSync("git", ["for-each-ref"], { cwd: root, encoding: "utf8" });
  const run = () => runnerModule.runDashboardAction({ snapshot: selected, action, signal: new AbortController().signal });
  assert.match((await run()).text, /old-session/);
  assert.doesNotMatch((await run()).text, /new-session/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(execFileSync("git", ["for-each-ref"], { cwd: root, encoding: "utf8" }), refs);
  assert.deepEqual(readdirSync(repo.stateDir), ["demo.json"]);
  state.attempts[0].session = "changed"; writeFileSync(path, JSON.stringify(state));
  assert.match((await run()).text, /changed|disappeared/);
  const oldPath = process.env.PATH, oldHerdr = process.env.HERDR_ENV;
  t.after(() => { process.env.PATH = oldPath; if (oldHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = oldHerdr; });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/herdr"), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('backend-started',String(process.pid));setInterval(()=>{},1000);\n"); chmodSync(join(root, "bin/herdr"), 0o755);
  process.env.PATH = `${join(root, "bin")}:${oldPath}`; process.env.HERDR_ENV = "1";
  state.attempts[0].terminal = { backend: "herdr", pane: "saved-pane" }; writeFileSync(path, JSON.stringify(state));
  const live = collectDashboard({ cwd: root }), focus = actionsFor(live, "local:demo:attempt:old").find(a => a.kind === "focus");
  const controller = new AbortController(), started = Date.now();
  const pending = runnerModule.runDashboardAction({ snapshot: live, action: focus, signal: controller.signal });
  assert.ok(Date.now() - started < 100, "slow backend must not block the caller");
  const deadline = Date.now() + 3000;
  while (!existsSync(join(root, "backend-started")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(join(root, "backend-started")), true);
  controller.abort();
  await assert.rejects(pending, /cancel/i);
  const pid = Number(readFileSync(join(root, "backend-started"), "utf8"));
  const alive = () => { try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
  const stopDeadline = Date.now() + 1000;
  while (alive() && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(alive(), false, "new focus backend descendant must terminate on cancellation");
});

function audit(root) {
  const files = {};
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[path] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return { files, refs: git(root, "for-each-ref"), worktrees: git(root, "worktree", "list", "--porcelain") };
}

test("launch retry review and repair CLI previews preserve repository and runtime bytes", async t => {
  const fixture = featureFixture(t, { unchecked: true });
  fixture.approve();
  const run = async suffix => {
    const s = collectDashboard({ cwd: fixture.root });
    const target = suffix === "retry" ? s.tasks[0].id : s.features[0].id;
    const a = actionsFor(s, target).find(a => a.id.endsWith(`:${suffix}-preview`));
    const before = audit(fixture.root);
    const result = await runnerModule.runDashboardAction({ snapshot: s, action: a, input: { taskIds: ["1.1"] }, signal: new AbortController().signal });
    assert.equal(result.command.includes("--dry-run"), true);
    assert.equal(result.command.includes("--json"), true);
    assert.deepEqual(audit(fixture.root), before);
    return JSON.parse(result.text);
  };
  assert.equal((await run("launch")).tasks[0].task, "1.1");
  const a = fixture.r.launch("demo", ["1.1"])[0];
  const state = fixture.r.read("demo"); state.attempts[0].phase = "failed"; fixture.r.save(state);
  assert.equal((await run("retry")).tasks[0].task, "1.1");
  state.baseline = ["1.1"]; state.attempts = []; state.batches = []; fixture.r.save(state);
  assert.equal((await run("review")).role, "review");
  fixture.control({ findings: [blocker] });
  await fixture.review();
  assert.equal((await run("fix")).role, "repair");
});
test("action menus project known worktree availability without consulting filesystem", () => {
  const s = snapshot();
  s.sessions = [{ id: "session", featureId: "local:change", worktreeAvailable: true, role: "implementation", phase: "running", process: "unknown", terminal: "unknown", attempt: { id: "saved", path: "/definitely-not-a-current-worktree", base: "a".repeat(40), phase: "running", session: "saved", terminal: { backend: "orca", pane: "saved-pane" } } }];
  const projected = actionsFor(s, "session");
  assert.equal(projected.find(a => a.kind === "diff").available, true);
  assert.equal(projected.find(a => a.kind === "focus").available, true);
  s.sessions[0].worktreeAvailable = false;
  assert.match(actionsFor(s, "session").find(a => a.kind === "diff").reason, /missing/);
  delete s.sessions[0].worktreeAvailable;
  assert.match(actionsFor(s, "session").find(a => a.kind === "diff").reason, /unknown/);
});
