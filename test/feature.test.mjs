import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Feature } from "../dist/feature.js";
import { Runner } from "../dist/runner.js";
import { featurePath, saveFeature } from "../dist/feature-state.js";
import { featureFixture, featureSettings, blocker, git } from "./helpers/feature-fixture.mjs";

// These integration tests exercise POSIX processes/worktrees; run with pnpm test on Linux/WSL.
test("managed state starts before artifacts and legacy adoption never invents approval", t => {
  const { f, r } = featureFixture(t);
  assert.equal(f.start("future").phase, "planning");
  assert.equal(new Feature(f.repo.root).status("future").phase, "planning");
  assert.equal(r.status("future").feature.phase, "planning");
  f.start("demo", true);
  assert.equal(f.read("demo").approval, undefined);
  assert.throws(() => r.preview("demo", ["1.1"]), /requires approval/);
});

test("approval previews are read-only and bind concrete settings, fingerprint and base", t => {
  const { f, r, root } = featureFixture(t, { unchecked: true });
  f.start("demo");
  const path = featurePath(f.repo.stateDir, "demo"), before = readFileSync(path, "utf8");
  const preview = f.planPreview("demo", featureSettings);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(r.read("demo"), undefined);
  assert.throws(() => f.approve("demo", featureSettings, "bad-token"), /stale/);
  f.approve("demo", featureSettings, preview.token);
  assert.equal(r.preview("demo", ["1.1"]).tasks[0].settings.reasoningEffort, "high");
  assert.throws(() => r.preview("demo", ["1.1"], { model: "different", reasoningEffort: "high" }), /settings differ/);
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Revised scope\n");
  assert.throws(() => r.launch("demo", ["1.1"]), /requires approval/);
  git(root, "add", "."); git(root, "commit", "-m", "Revise plan");
  r.reconcile("demo");
  assert.equal(f.read("demo").phase, "awaiting-plan-approval");
  assert.throws(() => r.preview("demo", ["1.1"]), /requires approval/);
  f.approve("demo", featureSettings, f.planPreview("demo", featureSettings).token);
  assert.equal(f.read("demo").approvalHistory.length, 2);
});

test("managed task integration retains normal checkbox behavior and approval", t => {
  const { f, r, approve } = featureFixture(t, { unchecked: true });
  approve();
  const a = r.launch("demo", ["1.1"])[0], worker = new Runner(a.path);
  worker.begin("demo", a.task, a.id, "test-task");
  writeFileSync(join(a.path, "output.txt"), "implemented\n"); git(a.path, "add", "."); git(a.path, "commit", "-m", "Implement");
  worker.report("demo", a.task, a.id, { attempt: a.id, task: a.task, session: "test-task", outcome: "completed",
    commit: git(a.path, "rev-parse", "HEAD"), summary: "Implemented", verification: ["Checked output"] });
  assert.throws(() => r.integrate("demo", ["1.1"]), /supervised exit receipt/);
  const state = r.read("demo");
  state.attempts[0].worker = { token: "test", exitedAt: "now", exitCode: 0, log: "test.log" };
  r.save(state);
  const token = f.read("demo").approval.token;
  r.integrate("demo", ["1.1"]);
  assert.equal(f.read("demo").approval.token, token);
  assert.equal(f.jobPreview("demo", "review").head, r.read("demo").head);
});

test("review preview creates no worktree and clean supervised review requires final consent", async t => {
  const { f, r, approve, review } = featureFixture(t);
  approve();
  const before = git(f.repo.root, "worktree", "list", "--porcelain");
  f.jobPreview("demo", "review");
  assert.equal(git(f.repo.root, "worktree", "list", "--porcelain"), before);
  const job = await review();
  assert.equal(f.status("demo").phase, "awaiting-final-approval");
  assert.ok(f.read("demo").jobs[0].worker.exitedAt);
  assert.throws(() => f.archive("demo"), /Final user approval/);
  const preview = f.finalPreview("demo");
  assert.equal(preview.head, r.read("demo").head);
  assert.equal(preview.review, job.id);
  assert.throws(() => f.approveFinal("demo", "old"), /stale/);
});

test("advisory findings permit final approval while blockers require repair and fresh whole-feature review", async t => {
  const { f, approve, review, control, r } = featureFixture(t);
  approve(); control({ findings: [blocker] }); await review();
  assert.throws(() => f.finalPreview("demo"), /Blocking/);
  const repair = f.launch("demo", "repair");
  await f.worker("demo", repair.id);
  const before = readFileSync(join(r.read("demo").integration.path, "openspec/changes/demo/tasks.md"), "utf8");
  f.integrate("demo", repair.id);
  assert.equal(readFileSync(join(r.read("demo").integration.path, "openspec/changes/demo/tasks.md"), "utf8"), before);
  assert.throws(() => f.finalPreview("demo"), /fresh review/);
  control({ findings: [{ ...blocker, category: "style" }] }); await review();
  assert.equal(f.finalPreview("demo").findings.length, 1);
  assert.equal(f.read("demo").fixRounds, 1);
});

test("two repair rounds stop persistent blockers and increasing the limit requires new approval", async t => {
  const { f, approve, review, control } = featureFixture(t);
  approve(); control({ findings: [blocker] }); await review();
  for (let i = 0; i < 2; i++) {
    const repair = f.launch("demo", "repair"); await f.worker("demo", repair.id); f.integrate("demo", repair.id); await review();
  }
  assert.throws(() => f.jobPreview("demo", "repair"), /Repair limit/);
  assert.match(f.status("demo").blocker, /Repair limit/);
  const extended = { ...featureSettings, maxFixRounds: 3 };
  assert.throws(() => f.approve("demo", extended, f.read("demo").approval.token), /stale/);
  f.approve("demo", extended, f.planPreview("demo", extended).token);
  assert.equal(f.jobPreview("demo", "repair").round, 3);
});

test("failed/out-of-scope repairs pause with evidence and cannot be integrated", async t => {
  const { f, approve, review, control } = featureFixture(t);
  approve(); control({ findings: [blocker] }); await review();
  control({ outcome: "blocked" });
  const repair = f.launch("demo", "repair"); await f.worker("demo", repair.id);
  assert.equal(f.read("demo").jobs.at(-1).phase, "blocked");
  assert.throws(() => f.integrate("demo", repair.id), /accepted report/);
  assert.throws(() => f.launch("demo", "repair"), /--retry/);
});

for (const scenario of ["wrongSession", "reviewerEdit", "skipReport", "exitCode"]) {
  test(`review rejects ${scenario} and preserves session evidence`, async t => {
    const { f, approve, review, control } = featureFixture(t);
    approve(); control({ [scenario]: scenario === "exitCode" ? 1 : true }); await review();
    assert.throws(() => f.finalPreview("demo"), /accepted report|successful/);
    assert.ok(f.read("demo").jobs[0].worker.exitedAt);
  });
}

test("missing exit receipts and post-review changes cannot reach archival", async t => {
  const { f, approve, review, r } = featureFixture(t);
  approve(); await review();
  const s = f.read("demo"), receipt = s.jobs[0].worker.exitedAt;
  delete s.jobs[0].worker.exitedAt; saveFeature(f.repo.stateDir, s);
  assert.throws(() => f.finalPreview("demo"), /active or unacknowledged/);
  s.jobs[0].worker.exitedAt = receipt; saveFeature(f.repo.stateDir, s);
  writeFileSync(join(r.read("demo").integration.path, "output.txt"), "unreviewed\n");
  assert.throws(() => f.finalPreview("demo"), /clean at its recorded head/);
});

test("a fresh Claude reviewer uses independent saved identity and successful stream evidence", async t => {
  const { f, approve, review } = featureFixture(t);
  approve({ ...featureSettings, review: { harness: "claude", model: "sonnet" } });
  await review();
  const j = f.read("demo").jobs[0];
  assert.equal(j.session, j.expectedSession);
  assert.equal(j.observedSession, j.expectedSession);
  assert.equal(j.identityConfirmed, true);
  assert.ok(f.finalPreview("demo").token);
});

test("archive recovers a lost OpenSpec response, commits once and supports status in archived worktree", async t => {
  const { f, r, approve, review, control, getControl } = featureFixture(t);
  approve(); await review(); f.approveFinal("demo", f.finalPreview("demo").token);
  control({ archiveCrash: true }); assert.throws(() => f.archive("demo"));
  assert.equal(f.read("demo").phase, "archiving");
  assert.equal(f.read("demo").completedAt, undefined);
  control({ archiveCrash: false });
  const result = f.archive("demo");
  assert.equal(result.completed, true); assert.equal(getControl().archiveCalls, 1);
  assert.equal(existsSync(join(r.read("demo").integration.path, "openspec/changes/demo")), false);
  assert.equal(new Feature(r.read("demo").integration.path).status("demo").phase, "completed");
  assert.equal(f.archive("demo").archive.commit, result.head);
  assert.equal(getControl().archiveCalls, 1);
});

test("archive commit/state crash recovery does not duplicate the commit", async t => {
  const { f, r, approve, review } = featureFixture(t);
  approve(); await review(); f.approveFinal("demo", f.finalPreview("demo").token);
  const save = f.runner.save.bind(f.runner);
  f.runner.save = () => { throw new Error("Injected state write failure"); };
  assert.throws(() => f.archive("demo"), /Injected/);
  const head = git(r.read("demo").integration.path, "rev-parse", "HEAD");
  f.runner.save = save;
  assert.equal(f.archive("demo").head, head);
});

test("archive validation failures and unexpected changes never mark completion", async t => {
  const { f, approve, review, control } = featureFixture(t);
  approve(); await review(); f.approveFinal("demo", f.finalPreview("demo").token);
  control({ failValidation: true }); assert.throws(() => f.archive("demo"));
  assert.notEqual(f.read("demo").phase, "completed");
  control({ failValidation: false, archiveExtraFile: true });
  assert.throws(() => f.archive("demo"), /outside the change/);
  assert.equal(f.read("demo").phase, "archiving");
});

test("repair checks fail recoverably and continuation commits once without touching tasks", async t => {
  const previous = process.env.FEATURE_CHECK_BLOCKED;
  t.after(() => { if (previous === undefined) delete process.env.FEATURE_CHECK_BLOCKED; else process.env.FEATURE_CHECK_BLOCKED = previous; });
  const { f, r, approve, review, control } = featureFixture(t, {
    checks: [[process.execPath, "-e", "if (process.env.FEATURE_CHECK_BLOCKED === '1') process.exit(1)"]],
  });
  approve(); control({ findings: [blocker] }); await review();
  const repair = f.launch("demo", "repair"); await f.worker("demo", repair.id);
  process.env.FEATURE_CHECK_BLOCKED = "1";
  assert.throws(() => f.integrate("demo", repair.id));
  assert.equal(f.read("demo").transaction.phase, "checking");
  process.env.FEATURE_CHECK_BLOCKED = "0";
  const result = f.integrate("demo", undefined, "continue");
  assert.equal(f.read("demo").transaction, undefined);
  assert.equal(f.integrate("demo", repair.id).head, result.head);
  assert.match(readFileSync(join(r.read("demo").integration.path, "openspec/changes/demo/tasks.md"), "utf8"), /\[x\] 1\.1/);
});

test("repair commit/state interruption is recognized by its marker on continuation", async t => {
  const { f, r, approve, review, control } = featureFixture(t);
  approve(); control({ findings: [blocker] }); await review();
  const repair = f.launch("demo", "repair"); await f.worker("demo", repair.id);
  const save = f.runner.save.bind(f.runner);
  f.runner.save = () => { throw new Error("Injected repair state failure"); };
  assert.throws(() => f.integrate("demo", repair.id), /Injected/);
  const head = git(r.read("demo").integration.path, "rev-parse", "HEAD");
  f.runner.save = save;
  assert.equal(f.integrate("demo", undefined, "continue").head, head);
});

test("a repair that edits planning artifacts is rejected rather than changing approved scope", async t => {
  const { f, approve, review, control } = featureFixture(t);
  approve(); control({ findings: [blocker] }); await review();
  control({ editPlan: true });
  const repair = f.launch("demo", "repair"); await f.worker("demo", repair.id);
  assert.equal(f.read("demo").jobs.at(-1).phase, "failed");
  assert.equal(f.read("demo").jobs.at(-1).report, undefined);
});

test("lost supervisors require explicit recovery and a fresh attempt, never duplicate dispatch", t => {
  const { f, approve } = featureFixture(t);
  approve(); const job = f.launch("demo", "review");
  const s = f.read("demo");
  s.jobs[0].worker = { token: "lost", pid: 999999999, processStart: "old", log: "retained.log" };
  saveFeature(f.repo.stateDir, s);
  assert.throws(() => f.launch("demo", "review", true), /active or unacknowledged/);
  f.recover("demo", job.id);
  assert.equal(f.read("demo").jobs[0].worker.exitCode, null);
  assert.throws(() => f.launch("demo", "review"), /--retry/);
  assert.notEqual(f.launch("demo", "review", true).id, job.id);
});

test("CLI plan/review previews and JSON status leave state unchanged", t => {
  const { f, approve, root, dir } = featureFixture(t);
  approve();
  const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
  const call = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args, "--json"], { cwd: root, encoding: "utf8" }));
  const path = featurePath(f.repo.stateDir, "demo"), before = readFileSync(path, "utf8");
  const input = join(dir, "settings.json"); writeFileSync(input, JSON.stringify(featureSettings));
  assert.ok(call("feature", "approve", "demo", "--file", input, "--dry-run").token);
  assert.equal(call("feature", "review", "demo", "--dry-run").role, "review");
  assert.equal(call("status", "demo").change, "demo");
  assert.equal(readFileSync(path, "utf8"), before);
});
