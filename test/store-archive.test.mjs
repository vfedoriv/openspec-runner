import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { deliveredStoreFixture } from "./helpers/store-coordination-fixture.mjs";
import { executable } from "./helpers/feature-fixture.mjs";
import { git } from "./helpers/store-planning-fixture.mjs";
import { replayStatus } from "../dist/coordination-state.js";

test("Store archives three component projects and shared planning in one recoverable cumulative chain", t => {
  const f = deliveredStoreFixture(t);
  const scope = { componentIds: ["api", "web", "worker"], includeStore: true, storeDeliveryBranch: "main" };
  const preview = f.c.archivePreview({ scope });
  assert.throws(() => f.c.archivePreview({ scope: { ...scope, storeDeliveryBranch: "other" } }), /declared coordination branch/);
  const componentOnly = f.c.archivePreview({ scope: { componentIds: ["api"], includeStore: false, storeDeliveryBranch: "main" } });
  assert.deepEqual(Object.keys(componentOnly.targets), ["api"]);
  assert.deepEqual(new Set(Object.values(preview.targets).map(target => target.repository)), new Set(["contracts"]));
  assert.equal(new Set(Object.values(preview.targets).map(target => target.base)).size, 1);
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const control = join(f.dir, "archive-control.json"); writeFileSync(control, JSON.stringify({ fail: true }));
  executable(join(bin, "openspec"), `
const fs=require('node:fs'),path=require('node:path');
const state=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
const change=process.argv[3],root=path.join(process.cwd(),'openspec');
const destination=path.join(root,'changes','archive','2026-11-19-'+change);
fs.mkdirSync(path.dirname(destination),{recursive:true});fs.renameSync(path.join(root,'changes',change),destination);
const spec=path.join(root,'specs','demo','spec.md');fs.mkdirSync(path.dirname(spec),{recursive:true});fs.writeFileSync(spec,'Archived canonical specification\\n');
if(path.basename(process.cwd())==='web'&&state.fail){fs.writeFileSync(${JSON.stringify(control)},'{}');console.error('Interrupted archive result');process.exit(1);}
console.log('Archived '+process.cwd());
`);
  const previousPath = process.env.PATH; process.env.PATH = `${bin}${delimiter}${previousPath}`; t.after(() => { process.env.PATH = previousPath; });
  f.c.approveArchive({ scope, id: "archive-consent", operationId: "archive-consent", expectedHead: f.head(), token: preview.token, approvedBy: "user" });
  f.write("components/api/openspec/changes/demo/tasks.md", "- [x] 1.1 Altered approved task\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Alter archive scope");
  assert.throws(() => f.c.archivePreview({ scope }), /drift/i);
  git(f.storeRoot, "revert", "--no-edit", "HEAD");
  f.write("unrelated-notes.md", "Preserve this independent Store edit\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Unrelated Store documentation");
  assert.equal(f.c.archivePreview({ scope }).token, preview.token);
  const input = { scope, id: "archive", operationId: "archive", expectedHead: f.head(), token: preview.token };
  assert.throws(() => f.c.prepareArchive(input), /Interrupted archive result/);
  const interrupted = f.c.inspectArchivePreparation({ operationId: "archive" });
  assert.equal(interrupted.targets.api.stage, "prepared"); assert.equal(interrupted.targets.web.stage, "failed");
  f.c.recoverArchivePreparation({ operationId: "archive", targetId: "web", attestedBy: "user" });
  f.c.prepareArchive(input);
  const receipt = f.c.inspectArchivePreparation({ operationId: "archive" });
  const snapshot = f.c.snapshot();
  const prepared = snapshot.records.find(record => record.type === "archive-prepared" && record.componentId === "api");
  for (const [change, pattern] of [[{ base: f.commits.api }, /base/], [{ paths: ["openspec/changes/demo/tasks.md"] }, /scope/], [{ componentId: "web" }, /ordered/]]) {
    const records = snapshot.records.map(record => record === prepared ? { ...record, ...change } : record);
    assert.throws(() => replayStatus({ snapshot: { ...snapshot, records } }), pattern);
  }
  const ordered = Object.values(receipt.targets);
  for (let index = 1; index < ordered.length; index++) git(f.storeRoot, "merge-base", "--is-ancestor", ordered[index - 1].commit, ordered[index].commit);
  const last = ordered.at(-1); git(f.storeRoot, "merge", "--no-ff", last.branch, "-m", "Deliver Store archive");
  const deliveryCommit = f.head();
  for (const id of Object.keys(receipt.targets)) {
    const preparedEventId = `archive-${id}`, delivery = f.c.archiveDeliveryPreview({ preparedEventId, deliveryCommit });
    f.c.recordArchiveDelivery({ id: `delivered-${id}`, operationId: `delivered-${id}`, expectedHead: f.head(), preparedEventId, deliveryCommit, token: delivery.token });
  }
  assert.equal(f.c.status().archive, "archived");
  assert.equal(existsSync(join(f.storeRoot, "unrelated-notes.md")), true);
  for (const [id, root] of Object.entries(f.roots)) {
    assert.equal(git(root, "rev-parse", "HEAD"), f.commits[id]);
    assert.equal(existsSync(join(root, "openspec")), false);
    assert.equal(existsSync(join(root, ".openspec-runner")), false);
    assert.equal(existsSync(join(f.storeRoot, "components", id, "openspec/changes/demo")), false);
    assert.equal(existsSync(join(f.storeRoot, "components", id, "openspec/changes/archive/2026-11-19-demo/tasks.md")), true);
  }
  assert.equal(existsSync(join(f.storeRoot, "openspec/changes/shared")), false);
});
