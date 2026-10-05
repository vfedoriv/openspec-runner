import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, readdirSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { coordinationFixture } from "./helpers/coordination-fixture.mjs";
import { git, executable } from "./helpers/feature-fixture.mjs";

import { linkedFeatureInputs } from "../docs/examples/linked-feature-inputs.mjs";

const cli = new URL("../bin/openspec-runner.js", import.meta.url).pathname;
function run(cwd, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args, "--json"], { cwd, encoding: "utf8", env: process.env });
  if (process.env.TASK6_EXAMPLE_LOG) appendFileSync(process.env.TASK6_EXAMPLE_LOG, JSON.stringify({ cwd, args: [...args, "--json"], status: result.status, stdout: result.stdout, stderr: result.stderr }) + "\n");
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(expected ? result.stderr : result.stdout);
}
function tree(root) {
  const rows = [];
  function visit(path, name) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
    else if (!stat.isSymbolicLink()) rows.push([name, stat.mode, createHash("sha256").update(readFileSync(path)).digest("hex")]);
  }
  visit(root, ""); return rows;
}
function fixture(t) {
  const f = coordinationFixture(t, { unchecked: false });
  const original = readFileSync(join(f.bin, "openspec"), "utf8").split("\n").slice(1).join("\n");
  executable(join(f.bin, "openspec"), `
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === 'doctor') { console.log(JSON.stringify({ references: [] })); process.exit(0); }
if (cliArgs[0] === 'status' && cliArgs[cliArgs.indexOf('--change') + 1] === 'shared') {
  console.log(JSON.stringify({ root: { path: process.cwd(), source: 'store', store_id: 'team' }, planningHome: { root: process.cwd() }, changeRoot: 'openspec/changes/shared', artifactPaths: {} })); process.exit(0);
}
${original}`);
  const map = join(f.dir, "machine-map.json"), manifestFile = join(f.dir, "manifest.json");
  const checkedInputs = linkedFeatureInputs({ storeRoot: f.storeRoot, apiRoot: f.root, model: "test-model", featureId: "cli-feature", sharedChange: "shared", change: "demo", deliveryBranch: f.manifest.components.api.deliveryBranch, coordinationBranch: f.manifest.coordinationBranch });
  const manifest = checkedInputs.manifest;
  writeFileSync(map, JSON.stringify({ contracts: f.storeRoot, api: f.root })); writeFileSync(manifestFile, JSON.stringify(manifest));
  const args = action => ["coordination", action, "cli-feature", "--store", f.storeRoot, "--map", map];
  const preview = (action, extra = []) => {
    const before = tree(f.dir), result = run(f.root, [...args(action), ...extra, "--dry-run"]);
    assert.deepEqual(tree(f.dir), before, `${action} preview changed local files`); return result;
  };
  const mutate = (action, p, extra = [], id = action) => run(f.root, [...args(action), ...extra, "--id", id, "--operation", `op-${id}`, "--expected-head", p.head, "--confirm", p.token]);
  return { ...f, map, manifest, manifestFile, args, preview, mutate };
}

test("coordination CLI checks options and consent before mutation and init installs delegated skill", t => {
  const f = fixture(t);
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /coordination <action> <feature>/); assert.match(help, /component <action> <feature>/);
  assert.match(help, /Workflow guide: /);
  assert.equal(readFileSync(help.match(/Workflow guide: ([^\n]+)/)[1], "utf8"), readFileSync(new URL("../docs/team-workflow.md", import.meta.url), "utf8"));
  assert.ok(readFileSync(help.match(/Input builder: ([^\n]+)/)[1], "utf8").includes("export function linkedFeatureInputs"));
  const initialized = run(f.root, ["init", "--agent", "all"]);
  for (const prefix of [".agents", ".claude"]) {
    const installed = join(f.root, prefix, "skills/openspec-runner-component");
    assert.ok(initialized.skills.includes(installed));
    const skill = readFileSync(join(installed, "SKILL.md"), "utf8");
    assert.match(skill, /package path.*--help/);
  }
  // Installation is reversible but must be committed before Store mutations inspect the component plan.
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Install workflows");
  for (const [action, invalid] of [["status", ["--confirm", "bad"]], ["status", ["--file", f.manifestFile]], ["approve", ["--owner", "alice"]]]) {
    assert.match(run(f.root, [...f.args(action), ...invalid], 1).error, /not supported|not allowed/i);
  }
  assert.match(run(f.root, [...f.args("init"), "--file", f.manifestFile, "--operation", "init"], 1).error, /expected-head/);
  const p = f.preview("init", ["--file", f.manifestFile]);
  run(f.root, [...f.args("init"), "--file", f.manifestFile, "--operation", "init-cli", "--expected-head", p.head]);
  const approval = f.preview("approve");
  assert.match(run(f.root, [...f.args("approve"), "--id", "approval", "--operation", "approve", "--expected-head", approval.head, "--confirm", approval.token], 1).error, /approved-by/);
  assert.equal(run(f.root, f.args("status")).phase, "awaiting-approval");
});

test("coordination CLI independent clones hand off receipts through acceptance merged completion and archive delivery offline", async t => {
  const f = fixture(t);
  let p = f.preview("init", ["--file", f.manifestFile]);
  run(f.root, [...f.args("init"), "--file", f.manifestFile, "--operation", "init-cli", "--expected-head", p.head]);
  p = f.preview("approve"); f.mutate("approve", p, ["--approved-by", "user"], "approval");
  p = f.preview("assign", ["--component", "api", "--owner", "alice"]); f.mutate("assign", p, ["--component", "api", "--owner", "alice"], "assignment");
  const clone = join(f.dir, "teammate api"), storeClone = join(f.dir, "teammate store");
  execFileSync("git", ["clone", "--quiet", f.root, clone]); execFileSync("git", ["clone", "--quiet", f.storeRoot, storeClone]);
  for (const [root, identity] of [[clone, "api"], [storeClone, "contracts"]]) { git(root, "config", "openspec-runner.repository", identity); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test"); }
  const ca = action => ["component", action, "cli-feature", "--store", storeClone, "--repository", "api"];
  const importArgs = ["--assignment", "assignment", "--owner", "alice"];
  p = run(clone, [...ca("inspect"), ...importArgs]);
  assert.equal(p.planningRoot, storeClone); assert.equal(p.implementationRoot, clone);
  const before = tree(f.dir);
  const ip = run(clone, [...ca("import"), ...importArgs, "--dry-run"]); assert.deepEqual(tree(f.dir), before);
  run(clone, [...ca("import"), ...importArgs, "--expected-head", ip.historyRevision, "--confirm", ip.token]);
  const delegatedStatus = run(clone, [...ca("status"), "--change", "demo"]);
  assert.equal(delegatedStatus.imported, true); assert.equal(delegatedStatus.acceptance.phase, "assigned");
  assert.equal(delegatedStatus.delivery.commit, null); assert.equal(delegatedStatus.archive, "pending");
  const job = run(clone, ["feature", "review", "demo"]); run(clone, ["feature", "worker", "demo", "--attempt", job.id]);
  const exportArgs = ["--change", "demo", "--outcome", "completed"];
  const receiptFile = join(f.dir, "receipt.json"), beforeExport = tree(f.dir);
  p = run(clone, [...ca("export"), ...exportArgs, "--output", receiptFile, "--dry-run"]);
  assert.deepEqual(tree(f.dir), beforeExport, "component export preview wrote local files");
  const exported = run(clone, [...ca("export"), ...exportArgs, "--id", "receipt", "--operation", "op-receipt", "--expected-head", ip.historyRevision, "--confirm", p.token, "--output", receiptFile]);
  assert.equal(run(clone, [...ca("export"), ...exportArgs, "--id", "receipt", "--operation", "op-receipt", "--expected-head", ip.historyRevision, "--confirm", p.token, "--output", receiptFile]).bytes, exported.bytes);
  assert.equal(exported.record.assignmentId, "assignment"); assert.equal(readFileSync(receiptFile, "utf8"), exported.bytes);
  // The result already exists in the coordinator repository; this fixture starts from a checked task.
  p = f.preview("import", ["--file", receiptFile]);
  run(f.root, [...f.args("import"), "--file", receiptFile, "--expected-head", p.head]);
  p = f.preview("accept", ["--submission", "receipt"]); f.mutate("accept", p, ["--submission", "receipt"]);
  const reviewFile = join(f.dir, "review.json");
  function review(stage) {
    const q = f.preview("review", ["--stage", stage]);
    writeFileSync(reviewFile, JSON.stringify({ tuple: q.tuple, token: q.token, reviewedBy: "reviewer", summary: "Inspected exact tuple", findings: [] }));
    f.mutate("review", q, ["--stage", stage, "--file", reviewFile], `${stage}-review`);
  }
  review("combined");
  let status = run(f.root, f.args("status")); assert.equal(status.phase, "ready-for-delivery"); assert.equal(status.delivery.api.commit, null);
  const merge = ["--component", "api", "--delivery-commit", exported.record.result.commit, "--merge-style", "merge", "--pr-url", "https://example.test/pr/1", "--attested-by", "operator"];
  p = f.preview("accept-delivery", merge);
  const deliveredReview = join(f.dir, "delivered-review.json"); writeFileSync(deliveredReview, JSON.stringify({ commit: exported.record.result.commit, reviewedBy: "reviewer", summary: "Inspected exact delivery", findings: [] }));
  f.mutate("accept-delivery", p, [...merge, "--file", deliveredReview]);
  p = f.preview("merge", merge); f.mutate("merge", p, merge); review("final");
  p = f.preview("complete"); f.mutate("complete", p, ["--approved-by", "user"]);
  status = run(f.root, f.args("status")); assert.equal(status.phase, "completed"); assert.equal(status.archive, "pending");
  const scope = join(f.dir, "archive-scope.json"); writeFileSync(scope, JSON.stringify({ componentIds: ["api"], includeStore: false }));
  p = f.preview("archive-approve", ["--file", scope]); f.mutate("archive-approve", p, ["--file", scope, "--approved-by", "user"]);
  p = f.preview("archive-prepare", ["--file", scope]); f.control({ archiveCrash: true });
  const prepareArgs = [...f.args("archive-prepare"), "--file", scope, "--id", "archive-prepare", "--operation", "op-archive-prepare", "--expected-head", p.head, "--confirm", p.token];
  assert.match(run(f.root, prepareArgs, 1).error, /archive/i);
  const recoveryArgs = ["--operation", "op-archive-prepare", "--target", "api", "--attested-by", "operator"];
  const recovery = f.preview("archive-recover", recoveryArgs); assert.equal(recovery.receipt.targets.api.stage, "failed");
  run(f.root, [...f.args("archive-recover"), ...recoveryArgs, "--expected-head", git(f.storeRoot, "rev-parse", "HEAD")]);
  const results = run(f.root, prepareArgs); assert.equal(f.getControl().archiveCalls, 1);
  const receipt = run(f.root, [...f.args("archive-inspect"), "--operation", "op-archive-prepare"]); assert.equal(receipt.targets.api.stage, "prepared");
  assert.equal(run(f.root, f.args("status")).archive, "prepared");
  const prepared = JSON.parse(readFileSync(join(f.storeRoot, results.records[0].path), "utf8"));
  git(f.root, "checkout", "--detach"); git(f.root, "branch", "-f", f.manifest.components.api.deliveryBranch, prepared.commit);
  const delivery = ["--prepared", prepared.id, "--delivery-commit", prepared.commit];
  p = f.preview("archive-deliver", delivery); f.mutate("archive-deliver", p, delivery);
  // Rebuild from only published Git history, with no coordinator journal directory.
  const freshStore = join(f.dir, "offline store"); execFileSync("git", ["clone", "--quiet", f.storeRoot, freshStore]); git(freshStore, "config", "openspec-runner.repository", "contracts");
  const freshMap = join(f.dir, "offline-map.json"); writeFileSync(freshMap, JSON.stringify({ contracts: freshStore, api: f.root }));
  status = run(f.root, ["coordination", "status", "cli-feature", "--store", freshStore, "--map", freshMap]);
  assert.equal(status.phase, "completed"); assert.equal(status.archive, "archived"); assert.equal(status.acceptance.api.commit, exported.record.result.commit);
  assert.equal(status.planningRoot, freshStore); assert.equal(status.implementationRoots.api, f.root); assert.equal(status.blocker, null); assert.ok(status.nextAction);
});

test("coordination and component previews leave every file unchanged and expose revocation recovery", t => {
  const f = fixture(t); let p = f.preview("init", ["--file", f.manifestFile]);
  run(f.root, [...f.args("init"), "--file", f.manifestFile, "--operation", "init-cli", "--expected-head", p.head]);
  p = f.preview("approve"); f.mutate("approve", p, ["--approved-by", "user"]);
  const before = tree(f.dir); p = f.preview("assign", ["--component", "api", "--owner", "alice"]); assert.deepEqual(tree(f.dir), before);
  f.mutate("assign", p, ["--component", "api", "--owner", "alice"], "assignment");
  const prior = tree(f.dir); p = f.preview("revoke", ["--assignment", "assignment", "--reason", "Owner changed"]); assert.deepEqual(tree(f.dir), prior);
  run(f.root, [...f.args("revoke"), "--assignment", "assignment", "--reason", "Owner changed", "--id", "revoke", "--operation", "op-revoke", "--expected-head", p.head]);
  assert.equal(run(f.root, f.args("status")).components.api.phase, "planned");
});

test("coordination CLI read-only record inspection preserves immutable handoff bytes", t => {
  const f = fixture(t); f.approve(); f.assign();
  const args = ["coordination", "inspect", "feature", "--store", f.storeRoot, "--map", f.map, "--kind", "assignment", "--record", "assignment"];
  const before = tree(f.dir), inspected = run(f.root, args);
  assert.equal(inspected.record.id, "assignment"); assert.equal(inspected.record.owner, "alice"); assert.deepEqual(tree(f.dir), before);
  assert.match(run(f.root, [...args, "--confirm", "bad"], 1).error, /not supported/);
});
