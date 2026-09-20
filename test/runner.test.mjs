import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Runner } from "../dist/runner.js";
import {
  tasksFrom,
  assignmentsFrom,
  loadPlan,
  readiness,
  configFrom,
} from "../dist/plan.js";
import {
  resolveSettings,
  sessionSettings,
  codexArgs,
  models,
} from "../dist/codex.js";
import { createWorktree } from "../dist/adapters.js";
import { init } from "../dist/cli.js";
import { locked } from "../dist/system.js";
import { installFakeOrca } from "./helpers/fake-orca.mjs";
const settings = { model: "model-a", reasoningEffort: "high" };
const basePath = process.env.PATH;
// Model an acknowledged worker exit with an already closed, known Herdr pane.
function exited(r, a, bin) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SESSION = "cleanup-tests";
  executable(join(bin, "herdr"), `console.log(JSON.stringify({result:{panes:[]}}));`);
  const s = r.read("demo"), current = s.attempts.find(x => x.id === a.id);
  current.worker = { token: "test", exitedAt: "2026-09-13T00:00:00Z", log: join(r.repo.stateDir, "logs", `${a.id}.log`) };
  current.terminal = { owned: true, pane: a.id, terminal: a.id, workspace: "tests", sessionContext: "cleanup-tests" };
  r.save(s);
}
function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function executable(path, body) {
  writeFileSync(path, "#!/usr/bin/env node\n" + body);
  chmodSync(path, 0o755);
}
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runner tests "));
  t.after(() => {
    process.env.PATH = basePath;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SESSION;
    delete process.env.FAKE_HERDR_FAIL;
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, "repo with spaces"),
    bin = join(dir, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  process.env.PATH = bin + ":" + basePath;
  executable(
    join(bin, "openspec"),
    `console.log(JSON.stringify(process.argv[2]==='status'?{artifacts:[{id:'tasks',status:'done'}]}:{state:'ready'}));`,
  );
  executable(
    join(bin, "wt"),
    `if(process.argv.includes('--help')) console.log('old unsupported version'); else process.exit(1);`,
  );
  executable(
    join(bin, "codex"),
    `if(process.argv.includes('--version')) console.log('codex-cli 0.153.4'); else {const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.id) console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{id:'model-a',model:'model-a',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null}}));});}`,
  );
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Runner Test");
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(
    join(root, "openspec/runner.yaml"),
    JSON.stringify({
      version: 1,
      worktrees: options.worktrees ?? "git",
      terminal: options.terminal ?? "manual",
      cleanup: options.cleanup ?? "automatic",
      setup: options.setup ?? [],
      verifyIntegration: options.checks ?? [],
      maxParallel: options.maxParallel ?? 4,
    }),
  );
  writeFileSync(
    join(root, "openspec/changes/demo/tasks.md"),
    "## Tasks\n- [ ] 1.1 First\n- [ ] 1.2 Second\n- [ ] 2.1 Dependent\n",
  );
  writeFileSync(
    join(root, "openspec/changes/demo/execution.yaml"),
    JSON.stringify({
      version: 1,
      tasks: {
        1.1: { parallel: true },
        1.2: { parallel: true },
        2.1: { dependsOn: ["1.1", "1.2"] },
      },
    }),
  );
  writeFileSync(join(root, "shared.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return { root, dir, bin, runner: new Runner(root) };
}
function complete(r, a, filename = `${a.task}.txt`, text = "done\n") {
  const worker = new Runner(a.path);
  worker.begin("demo", a.task, a.id, `session-${a.id}`);
  writeFileSync(join(a.path, filename), text);
  git(a.path, "add", filename);
  git(a.path, "commit", "-m", `Task ${a.task}`);
  const report = {
    attempt: a.id,
    task: a.task,
    session: `session-${a.id}`,
    outcome: "completed",
    commit: git(a.path, "rev-parse", "HEAD"),
    summary: "Implemented",
    verification: ["Checked fixture output"],
  };
  worker.report("demo", a.task, a.id, report);
  return report;
}
test("task parser ignores fences and rejects unnumbered/duplicate checkboxes", () => {
  assert.equal(
    tasksFrom("```\n- [ ] 1.1 fake\n```\n- [x] 2.1 Real")[0].id,
    "2.1",
  );
  assert.throws(() => tasksFrom("- [ ] nope"), /numbered/);
  assert.throws(() => tasksFrom("- [ ] 1.1 A\n- [ ] 1.1 B"), /Duplicate/);
});
test("OpenSpec readiness identifies empty and malformed JSON output", (t) => {
  const { root, bin } = fixture(t),
    openspec = join(bin, "openspec");
  executable(openspec, "");
  assert.throws(
    () => readiness(root, "demo"),
    /openspec status --change demo --json returned empty stdout/,
  );
  executable(openspec, "console.log('not-json');");
  assert.throws(
    () => readiness(root, "demo"),
    /openspec status --change demo --json returned invalid JSON/,
  );
  executable(
    openspec,
    `console.log(process.argv[2] === 'status' ? JSON.stringify({}) : 'not-json');`,
  );
  assert.throws(
    () => readiness(root, "demo"),
    /openspec instructions apply --change demo --json returned invalid JSON/,
  );
});
test("manifest validates coverage, dependencies, cycles and conservative parallel default", () => {
  const tasks = tasksFrom("- [ ] 1.1 A\n- [ ] 1.2 B");
  assert.throws(
    () => assignmentsFrom({ version: 1, tasks: { 1.1: {} } }, tasks),
    /Missing/,
  );
  assert.throws(
    () =>
      assignmentsFrom(
        { version: 1, tasks: { 1.1: { dependsOn: ["9.9"] }, 1.2: {} } },
        tasks,
      ),
    /dependencies/,
  );
  assert.throws(
    () =>
      assignmentsFrom(
        {
          version: 1,
          tasks: { 1.1: { dependsOn: ["1.2"] }, 1.2: { dependsOn: ["1.1"] } },
        },
        tasks,
      ),
    /cycle/,
  );
  assert.equal(
    assignmentsFrom({ version: 1, tasks: { 1.1: {}, 1.2: {} } }, tasks)["1.1"]
      .parallel,
    false,
  );
});
test("model overrides and inherited effort follow the captured model", () => {
  const a = { dependsOn: [], parallel: false };
  assert.deepEqual(resolveSettings(a, settings), settings);
  assert.deepEqual(resolveSettings({ ...a, model: "other" }, settings), {
    model: "other",
  });
  assert.deepEqual(
    resolveSettings({ ...a, model: "other", reasoningEffort: "low" }, settings),
    { model: "other", reasoningEffort: "low" },
  );
  assert.throws(() => resolveSettings(a), /default-model/);
  const args = codexArgs(settings, "/a b", "thread-1", "/git common");
  assert.ok(args.includes("thread-1"));
  assert.equal(args[args.indexOf("--add-dir") + 1], "/git common");
});
test("version-tested SQLite metadata reads current calling thread after model switch", async (t) => {
  const f = fixture(t);
  const home = join(f.dir, "codex");
  mkdirSync(home);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT, model TEXT, reasoning_effort TEXT)");
  db.prepare("INSERT INTO threads VALUES(?,?,?)").run(
    "caller",
    "model-a",
    "high",
  );
  assert.deepEqual(await sessionSettings("caller", home), settings);
  db.prepare("UPDATE threads SET model=?, reasoning_effort=? WHERE id=?").run(
    "model-b",
    "low",
    "caller",
  );
  assert.deepEqual(await sessionSettings("caller", home), {
    model: "model-b",
    reasoningEffort: "low",
  });
  db.close();
  await assert.rejects(sessionSettings("missing", home), /default-model/);
  executable(join(f.bin, "codex"), `console.log('codex-cli 9.0.0')`);
  await assert.rejects(sessionSettings("caller", home), /Unsupported/);
});
test("model/list reads advertised model defaults through app-server", async (t) => {
  fixture(t);
  assert.equal((await models())[0].defaultReasoningEffort, "medium");
});
test("parallel tasks integrate sequentially, update only integration checkboxes, unlock dependent and clean selected worktree", (t) => {
  const { runner: r, root } = fixture(t);
  const before = git(root, "rev-parse", "HEAD");
  const preview = r.preview("demo", ["1.1", "1.2"], settings);
  assert.equal(preview.tasks.length, 2);
  assert.equal(r.read("demo"), undefined);
  const batch = r.launch("demo", ["1.1", "1.2"], settings);
  assert.equal(batch.length, 2);
  assert.notEqual(batch[0].path, batch[1].path);
  assert.throws(() => r.launch("demo", ["1.1"], settings), /already has/);
  assert.throws(() => r.launch("demo", ["2.1"], settings), /Dependencies/);
  batch.forEach((a) => complete(r, a));
  assert.throws(() => r.launch("demo", ["2.1"], settings), /Dependencies/);
  r.integrate("demo", ["1.1", "1.2"]);
  const state = r.read("demo");
  assert.match(
    readFileSync(
      join(state.integration.path, "openspec/changes/demo/tasks.md"),
      "utf8",
    ),
    /\[x\] 1.1/,
  );
  assert.equal(git(root, "rev-parse", "HEAD"), before);
  assert.doesNotMatch(
    readFileSync(join(root, "openspec/changes/demo/tasks.md"), "utf8"),
    /\[x\]/,
  );
  const dependent = r.launch("demo", ["2.1"], settings)[0];
  assert.equal(dependent.base, state.head);
  const review = r.cleanup("demo", ["1.1"], { dryRun: true }).results[0];
  assert.equal(review.status, "confirmation-required");
  r.cleanup("demo", ["1.1"], { attempt: review.attempt, confirm: review.token });
  assert.equal(existsSync(batch[0].path), false);
  assert.equal(existsSync(batch[1].path), true);
});
test("exclusive execution and global concurrency include other change attempts", (t) => {
  const { runner: r, root } = fixture(t, { maxParallel: 1 });
  assert.throws(
    () => r.preview("demo", ["1.1", "1.2"], settings),
    /concurrency/,
  );
  r.launch("demo", ["1.1"], settings);
  assert.throws(() => r.launch("demo", ["1.2"], settings), /concurrency/);
});
test("exclusive task cannot overlap an independent task", (t) => {
  const { runner: r, root } = fixture(t);
  const p = join(root, "openspec/changes/demo/execution.yaml");
  const m = JSON.parse(readFileSync(p));
  m.tasks["1.1"].parallel = false;
  writeFileSync(p, JSON.stringify(m));
  git(root, "add", ".");
  git(root, "commit", "-m", "exclusive");
  assert.throws(() => r.launch("demo", ["1.1", "1.2"], settings), /Exclusive/);
});
test("setup failure persists failed attempt; retry is explicit and retains old worktree", (t) => {
  const { runner: r } = fixture(t, {
    setup: [[process.execPath, "-e", "process.exit(1)"]],
  });
  const a = r.launch("demo", ["1.1"], settings)[0];
  assert.equal(a.phase, "failed");
  assert.ok(existsSync(a.path));
  assert.throws(() => r.launch("demo", ["1.1"], settings), /already has/);
  const b = r.launch("demo", ["1.1"], settings, "HEAD", true)[0];
  assert.notEqual(a.id, b.id);
  assert.ok(existsSync(a.path));
});
test("report rejects wrong session, dirty/stale commits and shared planning changes", (t) => {
  const { runner: r } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0],
    w = new Runner(a.path);
  w.begin("demo", a.task, a.id, "session");
  const report = {
    attempt: a.id,
    task: a.task,
    session: "wrong",
    outcome: "completed",
    commit: git(a.path, "rev-parse", "HEAD"),
    summary: "x",
    verification: ["x"],
  };
  assert.throws(() => w.report("demo", a.task, a.id, report), /identity/);
  report.session = "session";
  writeFileSync(join(a.path, "untracked"), "x");
  assert.throws(() => w.report("demo", a.task, a.id, report), /clean/);
  rmSync(join(a.path, "untracked"));
  const p = join(a.path, "openspec/changes/demo/tasks.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("[ ]", "[x]"));
  git(a.path, "add", ".");
  git(a.path, "commit", "-m", "wrong");
  assert.throws(() => w.report("demo", a.task, a.id, report), /reported/);
  report.commit = git(a.path, "rev-parse", "HEAD");
  assert.throws(() => w.report("demo", a.task, a.id, report), /planning/);
});
test("artifact content drift blocks integration; checkbox-only edits do not change fingerprint", (t) => {
  const { runner: r, root } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0];
  complete(r, a);
  const p = join(root, "openspec/changes/demo/tasks.md"),
    original = readFileSync(p, "utf8"),
    fingerprint = loadPlan(root, "demo").fingerprint;
  writeFileSync(p, original.replace("[ ]", "[x]"));
  assert.equal(loadPlan(root, "demo").fingerprint, fingerprint);
  writeFileSync(p, original.replace("First", "Changed"));
  git(root, "add", ".");
  git(root, "commit", "-m", "planning change");
  assert.throws(() => r.integrate("demo", ["1.1"]), /changed/);
  r.reconcile("demo");
  assert.equal(r.read("demo").attempts[0].phase, "stale");
  assert.throws(() => r.integrate("demo", ["1.1"]), /completed report/);
});
test("conflicted integration blocks dependent tasks, supports abort then continue after resolution", (t) => {
  const { runner: r } = fixture(t);
  const [a, b] = r.launch("demo", ["1.1", "1.2"], settings);
  complete(r, a, "shared.txt", "one\n");
  complete(r, b, "shared.txt", "two\n");
  r.integrate("demo", ["1.1"]);
  assert.throws(() => r.integrate("demo", ["1.2"]), /CONFLICT|conflict/);
  assert.throws(() => r.launch("demo", ["2.1"], settings), /integration/);
  r.integrate("demo", [], "abort");
  assert.equal(r.read("demo").transaction, undefined);
  assert.throws(() => r.integrate("demo", ["1.2"]), /CONFLICT|conflict/);
  const path = r.read("demo").integration.path;
  writeFileSync(join(path, "shared.txt"), "both\n");
  git(path, "add", "shared.txt");
  r.integrate("demo", [], "continue");
  assert.equal(r.read("demo").attempts[1].phase, "integrated");
});
test("failed integration checks retain transaction and can continue after fixing external check", (t) => {
  const toggle = join(tmpdir(), `osr-check-${Date.now()}`);
  t.after(() => rmSync(toggle, { force: true }));
  const { runner: r } = fixture(t, {
    checks: [
      [
        process.execPath,
        "-e",
        `process.exit(require('fs').existsSync(${JSON.stringify(toggle)})?0:1)`,
      ],
    ],
  });
  const a = r.launch("demo", ["1.1"], settings)[0];
  complete(r, a);
  assert.throws(() => r.integrate("demo", ["1.1"]));
  assert.equal(r.read("demo").attempts[0].phase, "completed");
  writeFileSync(toggle, "ok");
  r.integrate("demo", [], "continue");
  assert.equal(r.read("demo").attempts[0].phase, "integrated");
});
test("repository lock prevents another coordinator from mutating state", (t) => {
  const { runner: r } = fixture(t);
  locked(r.repo.stateDir, () =>
    assert.throws(() => r.launch("demo", ["1.1"], settings), /locked/),
  );
});
test("repository lock distinguishes creation errors and preserves a replacement lock", (t) => {
  const { runner: r } = fixture(t),
    lockFile = join(r.repo.stateDir, "lock.json");
  mkdirSync(r.repo.stateDir, { recursive: true });
  chmodSync(r.repo.stateDir, 0o500);
  try {
    let error;
    try {
      locked(r.repo.stateDir, () => {});
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.match(error.message, /Cannot create runner lock/);
    assert.doesNotMatch(error.message, /Repository is locked/);
    assert.ok(["EACCES", "EPERM"].includes(error.cause?.code));
  } finally {
    chmodSync(r.repo.stateDir, 0o700);
  }
  const replacement = JSON.stringify({ token: "replacement-owner" });
  locked(r.repo.stateDir, () => writeFileSync(lockFile, replacement));
  assert.equal(readFileSync(lockFile, "utf8"), replacement);
  rmSync(lockFile);
});
test("Worktrunk uses explicit base and hooks disabled; partial creation reconciles before fallback", (t) => {
  const { root, bin, dir } = fixture(t);
  executable(
    join(bin, "wt"),
    `const {execFileSync}=require('child_process');const a=process.argv.slice(2);if(a.includes('--help')){console.log('--no-hooks --format --base --create');process.exit(0)}if(!a.includes('--no-hooks')||!a.includes('--yes')||!a.includes('--format'))process.exit(9);const branch=a[a.indexOf('--create')+1],base=a[a.indexOf('--base')+1];execFileSync('git',['worktree','add','-b',branch,${JSON.stringify(join(dir, "wt space"))},base]);process.exit(1);`,
  );
  const base = git(root, "rev-parse", "HEAD");
  const w = createWorktree(
    root,
    { branch: "wt-task", base, path: join(dir, "fallback") },
    "auto",
  );
  assert.equal(w.path, join(dir, "wt space"));
  assert.equal(existsSync(join(dir, "fallback")), false);
  assert.equal(git(w.path, "rev-parse", "HEAD"), base);
});
test("Herdr preserves focus, starts supervised worker and records returned identifiers", (t) => {
  const { runner: r, bin, dir } = fixture(t, { terminal: "auto" });
  process.env.HERDR_ENV = "1";
  const log = join(dir, "herdr-log");
  executable(
    join(bin, "herdr"),
    `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');console.log(JSON.stringify({result:a[0]==='workspace'?{workspace:{workspace_id:'w9'},root_pane:{pane_id:'w9:p7',terminal_id:'terminal-x'}}:{ok:true}}));`,
  );
  const a = r.launch("demo", ["1.1"], settings)[0];
  assert.equal(a.terminal.pane, "w9:p7");
  assert.equal(a.terminal.phase, "submitted");
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls[0].includes("--no-focus"));
  assert.deepEqual(calls[1].slice(0, 3), ["pane", "run", "w9:p7"]);
  assert.match(calls[1][3], /'worker' 'demo' '1.1'/);
  assert.ok(calls[1][3].includes(a.id));
  assert.equal(a.terminal.owned, true);
  assert.equal(a.settings.model, "model-a");
  r.attach("demo", "1.1");
  assert.match(readFileSync(log, "utf8"), /focus/);
});
test("blocked Herdr startup is ambiguous and cannot automatically relaunch or resubmit", (t) => {
  const { runner: r, bin, dir } = fixture(t, { terminal: "auto" });
  process.env.HERDR_ENV = "1";
  const log = join(dir, "log");
  executable(
    join(bin, "herdr"),
    `require('fs').appendFileSync(${JSON.stringify(log)},process.argv[3]+'\\n');if(process.argv[3]==='create')console.log(JSON.stringify({result:{workspace:{workspace_id:'w1'},root_pane:{pane_id:'w1:p1'}}}));else {console.error('agent_not_ready');process.exit(1)}`,
  );
  const a = r.launch("demo", ["1.1"], settings)[0];
  assert.equal(a.phase, "launching");
  assert.equal(a.terminal.phase, "starting");
  assert.throws(() => r.launch("demo", ["1.1"], settings), /already has/);
  assert.doesNotMatch(readFileSync(log, "utf8"), /prompt/);
});
test("Herdr worker can immediately begin without racing the coordinator lock", (t) => {
  const { runner: r, bin, dir } = fixture(t, { terminal: "auto" });
  process.env.HERDR_ENV = "1";
  const workspaceFile = join(dir, "worker-path"),
    cli = join(process.cwd(), "bin/openspec-runner.js");
  executable(
    join(bin, "herdr"),
    `const fs=require('fs'),{execFileSync}=require('child_process'),a=process.argv.slice(2);if(a[0]==='workspace'){fs.writeFileSync(${JSON.stringify(workspaceFile)},a[a.indexOf('--cwd')+1]);console.log(JSON.stringify({result:{workspace:{workspace_id:'w1'},root_pane:{pane_id:'w1:p1'}}}))}else if(a[1]==='run'){const m=a[3].match(/'worker' '([^']+)' '([^']+)' '--attempt' '([^']+)'/);execFileSync(process.execPath,[${JSON.stringify(cli)},'begin',m[1],m[2],'--attempt',m[3],'--session','immediate-session'],{cwd:fs.readFileSync(${JSON.stringify(workspaceFile)},'utf8'),stdio:'pipe'});console.log(JSON.stringify({result:{ok:true}}))}else console.log(JSON.stringify({result:{ok:true}}));`,
  );
  const a = r.launch("demo", ["1.1"], settings)[0],
    saved = r.read("demo").attempts[0];
  assert.equal(a.phase, "running");
  assert.equal(saved.phase, "running");
  assert.equal(saved.session, "immediate-session");
  assert.equal(saved.terminal.phase, "submitted");
});
test("Herdr persists partial creation and prompt-submission failures", (t) => {
  const partial = fixture(t, { terminal: "auto" });
  process.env.HERDR_ENV = "1";
  executable(
    join(partial.bin, "herdr"),
    `console.log(JSON.stringify({result:{workspace:{workspace_id:'partial-workspace'},root_pane:{}}}));`,
  );
  const created = partial.runner.launch("demo", ["1.1"], settings)[0];
  assert.equal(created.terminal.workspace, "partial-workspace");
  assert.equal(created.terminal.phase, "creating");
  assert.match(created.error, /Unsupported Herdr creation response/);

  const submission = fixture(t, { terminal: "auto" });
  process.env.HERDR_ENV = "1";
  executable(
    join(submission.bin, "herdr"),
    `const a=process.argv.slice(2);if(a[0]==='workspace')console.log(JSON.stringify({result:{workspace:{workspace_id:'w2'},root_pane:{pane_id:'w2:p2',terminal_id:'t2'}}}));else if(a[1]==='run')process.exit(9);else console.log(JSON.stringify({result:{ok:true}}));`,
  );
  const prompted = submission.runner.launch("demo", ["1.1"], settings)[0];
  assert.equal(prompted.terminal.workspace, "w2");
  assert.equal(prompted.terminal.pane, "w2:p2");
  assert.equal(prompted.terminal.phase, "starting");
  assert.match(prompted.error, /herdr pane/);
});
test("installer owns exactly three skills and preserves existing OpenSpec skills/config", (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, ".agents/skills/openspec-apply"), { recursive: true });
  writeFileSync(
    join(root, ".agents/skills/openspec-apply/SKILL.md"),
    "original",
  );
  const before = readFileSync(join(root, "openspec/runner.yaml"), "utf8");
  const result = init(root);
  assert.equal(result.skills.length, 3);
  assert.equal(
    readFileSync(join(root, ".agents/skills/openspec-apply/SKILL.md"), "utf8"),
    "original",
  );
  assert.equal(
    readFileSync(join(root, "openspec/runner.yaml"), "utf8"),
    before,
  );
  const all = init(root, "all");
  assert.equal(all.skills.length, 6);
  for (const name of [
    "openspec-runner-plan",
    "openspec-runner-coordinate",
    "openspec-runner-implement",
  ]) {
    const codex = readFileSync(join(root, ".agents/skills", name, "SKILL.md"), "utf8"),
      claude = readFileSync(join(root, ".claude/skills", name, "SKILL.md"), "utf8");
    assert.equal(claude, codex);
  }
  const implementation = readFileSync(
    join(root, ".claude/skills/openspec-runner-implement/SKILL.md"),
    "utf8",
  );
  assert.match(implementation, /Codex registers its actual `CODEX_THREAD_ID`/);
  assert.match(implementation, /Claude registers the reserved UUID/);
});
test("interruption after merge commit reconciles state without creating a duplicate commit", (t) => {
  const { runner: r } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0];
  complete(r, a);
  const old = r.read("demo"),
    before = old.head;
  r.integrate("demo", ["1.1"]);
  const committed = r.read("demo").head;
  old.transaction = {
    tasks: ["1.1"],
    current: "1.1",
    before,
    phase: "committing",
    marker: `openspec-runner:${a.id}`,
  };
  r.save(old);
  r.integrate("demo", [], "continue");
  assert.equal(r.read("demo").head, committed);
  assert.equal(r.read("demo").attempts[0].phase, "integrated");
});
test("explicit recovery reuses prepared worktree and attempt identity", (t) => {
  const { runner: r } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0],
    s = r.read("demo");
  s.attempts[0].phase = "preparing";
  r.save(s);
  const recovered = r.recover("demo", "1.1");
  assert.equal(recovered.id, a.id);
  assert.equal(recovered.path, a.path);
  assert.equal(r.read("demo").attempts.length, 1);
  assert.throws(() => r.recover("demo", "1.1"), /cannot safely/);
});
test("manual resume keeps resolved model and effort after caller switches models", (t) => {
  const { runner: r } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0];
  new Runner(a.path).begin("demo", "1.1", a.id, "saved-session");
  const attached = r.attach("demo", "1.1");
  assert.match(attached.command, /'resume' 'saved-session'/);
  assert.match(attached.command, /'model-a'/);
  assert.match(attached.command, /high/);
  assert.match(attached.command, /'--add-dir'/);
  assert.match(attached.command, new RegExp(r.repo.common.replaceAll("/", "\\/")));
});
test("uncommitted planning files and invalid selected base cannot launch", (t) => {
  const { runner: r, root } = fixture(t);
  writeFileSync(
    join(root, "openspec/changes/demo/proposal.md"),
    "new artifact",
  );
  assert.throws(() => r.launch("demo", ["1.1"], settings), /git|Commit/);
  assert.equal(r.read("demo"), undefined);
});
test("initial committed completed tasks satisfy dependencies", (t) => {
  const { runner: r, root } = fixture(t);
  const p = join(root, "openspec/changes/demo/tasks.md");
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("[ ] 1.", "[x] 1."));
  git(root, "add", ".");
  git(root, "commit", "-m", "existing completed baseline");
  assert.equal(r.launch("demo", ["2.1"], settings)[0].task, "2.1");
  assert.deepEqual(r.read("demo").baseline, ["1.1", "1.2"]);
});

test("cleanup policy defaults to automatic and validates manual opt-out", () => {
  assert.equal(configFrom({ version: 1 }).cleanup, "automatic");
  assert.equal(configFrom({ version: 1, cleanup: "manual" }).cleanup, "manual");
  assert.throws(() => configFrom({ version: 1, cleanup: "force" }), /cleanup policy/);
});

test("automatic batch cleanup retains history and final sweep removes obsolete retries", (t) => {
  const { runner: r, bin, root } = fixture(t);
  const old = r.launch("demo", ["1.1"], settings)[0];
  new Runner(old.path).begin("demo", "1.1", old.id, "blocked-session");
  writeFileSync(join(old.path, "old.txt"), "unique work");
  git(old.path, "add", "."); git(old.path, "commit", "-m", "partial work");
  const oldHead = git(old.path, "rev-parse", "HEAD");
  new Runner(old.path).report("demo", "1.1", old.id, { attempt: old.id, task: old.task, session: "blocked-session", outcome: "blocked", summary: "blocked", verification: ["checked"] });
  exited(r, old, bin);
  const a = r.launch("demo", ["1.1"], settings, "HEAD", true)[0];
  complete(r, a); exited(r, a, bin);
  const first = r.integrate("demo", ["1.1"]);
  assert.equal(first.cleanup.results[0].status, "removed");
  assert.equal(existsSync(a.path), false);
  assert.equal(existsSync(old.path), true);
  assert.throws(() => r.cleanup("demo", [], { all: true }), /All planned tasks/);
  const b = r.launch("demo", ["1.2"], settings)[0];
  complete(r, b); exited(r, b, bin); r.integrate("demo", ["1.2"]);
  const c = r.launch("demo", ["2.1"], settings)[0];
  complete(r, c); exited(r, c, bin);
  const final = r.integrate("demo", ["2.1"]);
  assert.equal(final.cleanup.scope.all, true);
  assert.equal(existsSync(old.path), false);
  assert.equal(git(root, "rev-parse", old.branch), oldHead);
  assert.equal(existsSync(r.read("demo").integration.path), true);
  assert.equal(r.read("demo").attempts.every(a => a.cleaned), true);
  assert.equal(r.attach("demo", "1.1").command, undefined);
  assert.ok(r.attach("demo", "1.1").session);
});

test("dirty and locked worktrees require approval bound to contents and retain commits", (t) => {
  const { runner: r, bin, root } = fixture(t, { cleanup: "manual" });
  const a = r.launch("demo", ["1.1"], settings)[0];
  complete(r, a); exited(r, a, bin); r.integrate("demo", ["1.1"]);
  writeFileSync(join(a.path, "untracked.txt"), "first");
  git(root, "worktree", "lock", "--reason", "review", a.path);
  const before = readFileSync(r.path("demo"), "utf8");
  const review = r.cleanup("demo", ["1.1"], { dryRun: true }).results[0];
  assert.equal(readFileSync(r.path("demo"), "utf8"), before);
  assert.equal(review.status, "confirmation-required");
  assert.match(review.changes, /untracked/);
  writeFileSync(join(a.path, "untracked.txt"), "second");
  assert.equal(r.cleanup("demo", ["1.1"], { attempt: a.id, confirm: review.token }).results[0].status, "failed");
  assert.equal(existsSync(a.path), true);
  const fresh = r.cleanup("demo", ["1.1"], { dryRun: true }).results[0];
  assert.notEqual(fresh.token, review.token);
  assert.equal(r.cleanup("demo", ["1.1"], { attempt: a.id, confirm: fresh.token }).results[0].status, "removed");
  assert.ok(git(root, "rev-parse", a.branch));
});

test("cleanup handles moved HEAD, preserves its commit and refuses protected worktrees", (t) => {
  const { runner: r, bin, root } = fixture(t, { cleanup: "manual" });
  const a = r.launch("demo", ["1.1"], settings)[0];
  complete(r, a); exited(r, a, bin); r.integrate("demo", ["1.1"]);
  git(a.path, "checkout", "--detach");
  writeFileSync(join(a.path, "extra.txt"), "extra"); git(a.path, "add", "."); git(a.path, "commit", "-m", "extra");
  const head = git(a.path, "rev-parse", "HEAD");
  const review = r.cleanup("demo", ["1.1"], { dryRun: true }).results[0];
  assert.equal(review.status, "confirmation-required");
  assert.equal(r.cleanup("demo", ["1.1"], { attempt: a.id, confirm: review.token }).results[0].status, "removed");
  assert.equal(git(root, "rev-parse", `openspec-runner/retained/${a.id}/${head}`), head);
  const s = r.read("demo"); s.attempts[0].path = root; r.save(s);
  assert.equal(r.cleanup("demo", ["1.1"]).results[0].status, "skipped");
});

test("partial batch retains worktrees until continuation completes", (t) => {
  const { runner: r, bin } = fixture(t);
  const batch = r.launch("demo", ["1.1", "1.2"], settings);
  batch.forEach((a, i) => { complete(r, a, "shared.txt", `value ${i}\n`); exited(r, a, bin); });
  assert.throws(() => r.integrate("demo", ["1.1", "1.2"]), /CONFLICT|conflict/);
  assert.ok(batch.every(a => existsSync(a.path)));
  const integration = r.read("demo").integration.path;
  writeFileSync(join(integration, "shared.txt"), "resolved\n"); git(integration, "add", "shared.txt");
  const continued = r.integrate("demo", [], "continue");
  assert.ok(continued.cleanup.results.every(x => x.status === "removed"));
  assert.ok(batch.every(a => !existsSync(a.path)));
});

test("archived changes can sweep leftovers using recorded completion and retry missing worktrees", (t) => {
  const { runner: r, bin, root } = fixture(t, { cleanup: "manual" });
  const batch = r.launch("demo", ["1.1", "1.2"], settings);
  batch.forEach(a => { complete(r, a); exited(r, a, bin); });
  r.integrate("demo", ["1.1", "1.2"]);
  const a = r.launch("demo", ["2.1"], settings)[0];
  complete(r, a); exited(r, a, bin); r.integrate("demo", ["2.1"]);
  mkdirSync(join(root, "openspec/changes/archive"));
  renameSync(join(root, "openspec/changes/demo"), join(root, "openspec/changes/archive/demo"));
  const swept = r.cleanup("demo", [], { all: true });
  assert.ok(swept.results.every(x => x.status === "removed"));
  const s = r.read("demo"); delete s.attempts[0].cleaned; r.save(s);
  assert.ok(r.cleanup("demo", [], { all: true }).results.every(x => x.status === "already-removed"));
});

test("cleanup failure cannot turn successful integration into failure", (t) => {
  const { runner: r } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0]; complete(r, a);
  const cleanup = r.cleanup;
  r.cleanup = () => { throw new Error("injected cleanup error"); };
  const result = r.integrate("demo", ["1.1"]);
  assert.match(result.cleanup.warning, /injected/);
  assert.equal(r.read("demo").attempts[0].phase, "integrated");
  const head = r.read("demo").head;
  r.cleanup = cleanup;
  r.integrate("demo", [], "continue");
  assert.equal(r.read("demo").head, head);
});

test("supervised exec records actual exit after report and prevents duplicate worker launch", async (t) => {
  const { runner: r, bin } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0];
  const module = new URL("../dist/runner.js", import.meta.url).href;
  executable(join(bin, "codex"), `
    if(process.argv.includes('--help')) { console.log('--add-dir --model --cd'); }
    else (async()=>{
      const {Runner}=await import(${JSON.stringify(module)});
      const r=new Runner(process.cwd());
      r.begin('demo','1.1',${JSON.stringify(a.id)},'exec-session');
      r.report('demo','1.1',${JSON.stringify(a.id)},{attempt:${JSON.stringify(a.id)},task:'1.1',session:'exec-session',outcome:'blocked',summary:'blocked fixture',verification:['checked']});
      if(r.read('demo').attempts[0].worker.exitedAt) process.exit(7);
      console.log('report returned before exit');
    })().catch(e=>{console.error(e);process.exit(8)});
  `);
  const result = await r.worker("demo", "1.1", a.id);
  assert.equal(result.exitCode, 0);
  const saved = r.read("demo").attempts[0];
  assert.equal(saved.phase, "blocked");
  assert.ok(saved.worker.exitedAt);
  assert.match(readFileSync(saved.worker.log, "utf8"), /report returned before exit/);
  assert.equal(saved.session, "exec-session");
  await assert.rejects(r.worker("demo", "1.1", a.id), /already exited/);
});

test("worker command recovers a lost supervisor exit receipt", async (t) => {
  const { runner: r } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0];
  const s = r.read("demo"), saved = s.attempts[0];
  saved.worker = { token: "lost-parent", pid: 999999999, processStart: "old", log: join(r.repo.stateDir, "logs", `${a.id}.log`) };
  saved.session = "saved-session";
  saved.phase = "blocked";
  saved.report = { attempt: a.id, task: a.task, session: saved.session, outcome: "blocked", summary: "reported", verification: ["checked"] };
  r.save(s);
  const recovered = await r.worker("demo", "1.1", a.id);
  assert.equal(recovered.recovered, true);
  assert.ok(r.read("demo").attempts[0].worker.exitedAt);
  assert.equal(r.read("demo").attempts[0].phase, "blocked");
});

function liveTerminal(r, a, bin, dir, mode = "close") {
  exited(r, a, bin);
  const state = join(dir, "pane-state.json");
  writeFileSync(state, JSON.stringify({ closed: false }));
  const pane = { pane_id: a.id, terminal_id: a.id, workspace_id: "tests", cwd: a.path };
  executable(join(bin, "herdr"), `
    const fs=require('fs'),args=process.argv.slice(2),file=${JSON.stringify(state)},s=JSON.parse(fs.readFileSync(file));
    let result;
    if(args[1]==='list') result={panes:s.closed?[]:[${JSON.stringify(pane)}]};
    else if(args[1]==='process-info') result={process_info:{pane_id:${JSON.stringify(a.id)},shell_pid:${process.pid},foreground_processes:[]}};
    else if(args[1]==='read') result={text:'saved terminal log'};
    else if(args[1]==='close') {
      if(!fs.existsSync(${JSON.stringify(a.path)})) throw new Error('worktree removed before pane');
      if(${JSON.stringify(mode)}==='fail') throw new Error('closure failed');
      s.closed=true;fs.writeFileSync(file,JSON.stringify(s));
      if(${JSON.stringify(mode)}==='edit') fs.writeFileSync(${JSON.stringify(join(a.path, "1.1.txt"))},'changed during closure');
      result={ok:true};
    } else throw new Error('unexpected '+args.join(' '));
    console.log(JSON.stringify({result}));
  `);
  return state;
}

test("owned terminal closes before worktree removal and its log survives", (t) => {
  const { runner: r, bin, dir } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0]; complete(r, a);
  const paneState = liveTerminal(r, a, bin, dir);
  const result = r.integrate("demo", ["1.1"]);
  assert.equal(result.cleanup.results[0].status, "removed", JSON.stringify(result));
  assert.equal(JSON.parse(readFileSync(paneState)).closed, true);
  assert.equal(existsSync(a.path), false);
  assert.match(readFileSync(join(r.repo.stateDir, "logs", `${a.id}-terminal.json`), "utf8"), /saved terminal log/);
});

test("terminal closure failure and edits during closure preserve the worktree", (t) => {
  for (const mode of ["fail", "edit"]) {
    const { runner: r, bin, dir } = fixture(t);
    const a = r.launch("demo", ["1.1"], settings)[0]; complete(r, a);
    liveTerminal(r, a, bin, dir, mode);
    const result = r.integrate("demo", ["1.1"]);
    assert.equal(result.cleanup.results[0].status, "failed");
    assert.equal(r.read("demo").attempts[0].phase, "integrated");
    assert.equal(existsSync(a.path), true);
  }
});

test("unacknowledged worker exit prevents integration, terminal closure and removal", (t) => {
  const { runner: r, bin, dir } = fixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0]; complete(r, a);
  const paneState = liveTerminal(r, a, bin, dir);
  const s = r.read("demo"); delete s.attempts[0].worker.exitedAt; r.save(s);
  assert.throws(
    () => r.integrate("demo", ["1.1"]),
    /supervised worker has not exited/,
  );
  assert.equal(r.read("demo").attempts[0].phase, "completed");
  assert.equal(JSON.parse(readFileSync(paneState)).closed, false);
  assert.equal(existsSync(a.path), true);
});

test("CLI dry-run and JSON confirmation expose exact candidates without terminal prompts", (t) => {
  const { runner: r, root } = fixture(t, { cleanup: "manual" });
  const a = r.launch("demo", ["1.1"], settings)[0]; complete(r, a); r.integrate("demo", ["1.1"]);
  const cli = new URL("../bin/openspec-runner.js", import.meta.url).pathname;
  const before = readFileSync(r.path("demo"), "utf8");
  const result = JSON.parse(execFileSync(process.execPath, [cli, "cleanup", "demo", "--tasks", "1.1", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
  assert.equal(result.results[0].status, "confirmation-required");
  assert.equal(readFileSync(r.path("demo"), "utf8"), before);
  assert.equal(existsSync(a.path), true);
  const confirmed = JSON.parse(execFileSync(process.execPath, [cli, "cleanup", "demo", "--tasks", "1.1", "--attempt", a.id, "--confirm", result.results[0].token, "--json"], { cwd: root, encoding: "utf8" }));
  assert.equal(confirmed.results[0].status, "removed");
});

function orcaFixture(t, fail = false) {
  const f = fixture(t, { terminal: "orca", worktrees: "orca" });
  const keys = ["ORCA_TERMINAL_HANDLE"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  process.env.ORCA_TERMINAL_HANDLE = "caller";
  const fake = installFakeOrca(f.dir, f.root, f.bin);
  fake.set({ failTerminalAfterCreate: fail });
  return { ...f, fake, calls: fake.calls };
}

test("Orca CLI preview is read-only and launch persists both adapters and focuses only its pane", t => {
  const { runner: r, root, calls } = orcaFixture(t);
  const cli = new URL("../bin/openspec-runner.js", import.meta.url).pathname;
  const preview = JSON.parse(execFileSync(process.execPath,
    [cli, "launch", "demo", "--tasks", "1.1", "--default-model", "model-a", "--dry-run", "--json"],
    { cwd: root, encoding: "utf8" }));
  assert.equal(preview.terminal, "orca");
  assert.equal(existsSync(r.path("demo")), false);
  assert.equal(calls().some(args => args[1] === "create"), false);
  const a = r.launch("demo", ["1.1"], settings)[0];
  assert.equal(a.error, undefined);
  assert.equal(a.terminal.backend, "orca");
  assert.equal(a.terminal.pane, "term-1");
  assert.equal(a.orcaWorktree.context.provider, "stablyai");
  assert.equal(git(a.path, "branch", "--show-current"), a.branch);
  const launch = calls().find(args => args[0] === "terminal" && args[1] === "create");
  assert.ok(!launch.includes("--focus"));
  assert.ok(launch.includes(`id:${a.orcaWorktree.id}`));
  assert.match(launch[launch.indexOf("--command") + 1], /worker/);
  assert.equal(r.attach("demo", "1.1").result.pane, "term-1");
  assert.throws(() => r.recover("demo", "1.1"), /cannot safely replay/);
});

test("ambiguous Orca terminal creation retains worktree and cannot automatically replay", t => {
  const { runner: r, calls } = orcaFixture(t, true);
  const a = r.launch("demo", ["1.1"], settings)[0];
  assert.equal(a.terminal.phase, "creating");
  assert.equal(a.terminal.backend, "orca");
  assert.equal(existsSync(a.path), true);
  assert.throws(() => r.recover("demo", "1.1"), /cannot safely replay/);
  assert.throws(() => r.attach("demo", "1.1"), /ownership inspection/);
  assert.equal(calls().filter(args => args[0] === "terminal" && args[1] === "create").length, 1);
});

test("Orca integration closes its exited terminal and removes the worktree while retaining its actual branch", t => {
  const { runner: r, fake } = orcaFixture(t);
  const a = r.launch("demo", ["1.1"], settings)[0];
  complete(r, a);
  const state = r.read("demo"), saved = state.attempts.find(item => item.id === a.id);
  saved.worker = { token: "test", exitedAt: "now", log: join(r.repo.stateDir, "worker.log") };
  r.save(state);
  r.integrate("demo", ["1.1"]);
  assert.equal(existsSync(a.path), false);
  assert.equal(fake.state().terminals.length, 0);
  assert.equal(git(r.repo.root, "rev-parse", a.branch), r.read("demo").attempts[0].report.commit);
  assert.equal(fake.calls().some(args => args[0] === "worktree" && args[1] === "rm"), false);
});
