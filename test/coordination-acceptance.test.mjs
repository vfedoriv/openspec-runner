import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { coordinationFixture } from "./helpers/coordination-fixture.mjs";
import { git, blocker, executable } from "./helpers/feature-fixture.mjs";
import { Coordination } from "../dist/coordination.js";
import { Feature } from "../dist/feature.js";

async function prepared(t, options = {}) {
  const f = coordinationFixture(t, { unchecked: false, ...options });
  const { component, input } = f.imported(), p = await component.inspect(input);
  await component.import({ ...input, token: p.token });
  return { ...f, component };
}
function exportArgs(f, extra = {}) {
  const p = f.component.submissionPreview({ change: "demo", outcome: "completed", ...extra });
  return { change: "demo", outcome: "completed", id: "receipt", operationId: "op-receipt", token: p.token, ...extra };
}
async function completed(t, options = {}) {
  const f = await prepared(t, options); await f.review();
  const args = exportArgs(f), exported = f.component.exportSubmission(args);
  return { ...f, args, exported };
}
function imported(f, bytes = f.exported.bytes) {
  return f.c.importSubmission({ bytes, expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
}
function acceptArgs(f, coordinator = f.c) {
  const p = coordinator.acceptancePreview({ submissionId: "receipt" });
  return { submissionId: "receipt", id: "accept", operationId: "op-accept", expectedHead: p.head, token: p.token };
}

// Persist the pre-normalization acceptance representation through the real Store API.
function legacyAcceptance(f, args, interruption) {
  const path = join(f.storeRoot, ".git/openspec-runner/acceptance/op-accept.json"), original = f.c.store.writeRecord.bind(f.c.store);
  f.c.store.writeRecord = options => {
    if (options.record.type !== "accepted") return original(options);
    const journal = JSON.parse(readFileSync(path, "utf8"));
    const record = { ...options.record, verification: journal.evidence };
    journal.pendingEvent = record; writeFileSync(path, JSON.stringify(journal));
    if (interruption === "before") throw new Error("Legacy interruption before commit");
    const result = original({ ...options, record });
    if (interruption === "after") throw new Error("Legacy interruption after commit");
    return result;
  };
  try {
    if (interruption) assert.throws(() => f.c.accept(args), /Legacy interruption/);
    else f.c.accept(args);
  } finally { f.c.store.writeRecord = original; }
  return path;
}

test("legacy committed acceptance retries preserve raw immutable evidence and reject changed intent without repeated checks", async t => {
  const check = ["node", "-e", "console.log(process.cwd()); console.log('useful legacy evidence'); if(process.env.LEGACY_ACCEPT_COUNTER) require('node:fs').appendFileSync(process.env.LEGACY_ACCEPT_COUNTER,'check\\n')"];
  const f = await completed(t, { checks: [check] }); imported(f);
  const args = { ...acceptArgs(f), createdAt: "2026-10-05T12:00:00Z" }, counter = join(f.dir, "legacy-checks");
  process.env.LEGACY_ACCEPT_COUNTER = counter; t.after(() => delete process.env.LEGACY_ACCEPT_COUNTER);
  legacyAcceptance(f, args);
  const path = join(f.storeRoot, "runner/features/feature/events/accept.json"), bytes = readFileSync(path, "utf8"), head = f.c.snapshot().head;
  assert.ok(bytes.includes(join(f.root, ".git/openspec-runner/acceptance-checkouts/op-accept")));
  for (const changed of [{ id: "different" }, { operationId: "different" }, { submissionId: "different" }, { token: "different" }, { expectedHead: "a".repeat(40) }, { createdAt: "2026-10-06T12:00:00Z" }])
    assert.throws(() => f.c.accept({ ...args, ...changed }), /identity|token|head/i);
  git(f.storeRoot, "switch", "-c", "other"); assert.throws(() => f.c.accept(args), /branch/i); git(f.storeRoot, "switch", "coordination");
  assert.equal(f.c.accept(args).head, head); assert.equal(f.c.accept(args).head, head);
  assert.equal(readFileSync(path, "utf8"), bytes); assert.equal(readFileSync(counter, "utf8"), "check\n");
  assert.equal(f.c.snapshot().records.filter(r => r.type === "accepted").length, 1);
  assert.deepEqual(f.c.status().pendingOperations, []);
  git(f.storeRoot, "commit", "--allow-empty", "-m", "Later history"); assert.throws(() => f.c.accept(args), /head/i);
});

for (const interruption of ["before", "after"]) test(`legacy pending acceptance recovers ${interruption} commit with exact bytes and validated journal evidence`, async t => {
  const check = ["node", "-e", "console.log(process.cwd()); console.log('useful legacy evidence'); if(process.env.LEGACY_ACCEPT_COUNTER) require('node:fs').appendFileSync(process.env.LEGACY_ACCEPT_COUNTER,'check\\n')"];
  const f = await completed(t, { checks: [check] }); imported(f); const args = acceptArgs(f), counter = join(f.dir, "legacy-checks");
  process.env.LEGACY_ACCEPT_COUNTER = counter; t.after(() => delete process.env.LEGACY_ACCEPT_COUNTER);
  const journalPath = legacyAcceptance(f, args, interruption), journal = JSON.parse(readFileSync(journalPath, "utf8")), head = f.c.snapshot().head;
  assert.ok(journal.pendingEvent.verification[0].evidence.includes(f.root));
  if (interruption === "before") {
    for (const changed of [{ verification: [{ ...journal.evidence[0], evidence: "Invented successful evidence" }] }, { type: "revoked" }, { id: "other" }, { operationId: "other" }, { componentId: "other" }, { assignmentId: "other" }, { submissionId: "other" }, { commit: "a".repeat(40) }, { createdAt: "2026-10-06T12:00:00Z" },
      { verification: [{ ...journal.evidence[0], command: ["node", "different"] }] }, { verification: [{ ...journal.evidence[0], exitCode: 1 }] }, { verification: [{ ...journal.evidence[0], evidence: "Invented successful evidence" }] }]) {
      writeFileSync(journalPath, JSON.stringify({ ...journal, pendingEvent: { ...journal.pendingEvent, ...changed } }));
      assert.throws(() => f.c.accept(args), /identity|evidence|verification|contract/i);
      assert.equal(f.c.snapshot().head, head);
      assert.equal(existsSync(join(f.storeRoot, "runner/features/feature/events/accept.json")), false);
    }
    writeFileSync(journalPath, JSON.stringify(journal));
  }
  const beforeBytes = interruption === "after" ? readFileSync(join(f.storeRoot, "runner/features/feature/events/accept.json"), "utf8") : undefined;
  f.c.accept(args); const bytes = readFileSync(join(f.storeRoot, "runner/features/feature/events/accept.json"), "utf8"); f.c.accept(args);
  assert.deepEqual(JSON.parse(bytes), journal.pendingEvent);
  if (beforeBytes) assert.equal(bytes, beforeBytes);
  assert.equal(readFileSync(join(f.storeRoot, "runner/features/feature/events/accept.json"), "utf8"), bytes);
  assert.equal(readFileSync(counter, "utf8"), "check\n");
  assert.equal(f.c.snapshot().records.filter(r => r.type === "accepted").length, 1);
  assert.deepEqual(f.c.status().pendingOperations, []);
});

test("export requires integrated tasks, clean exact head, canonical completion and fresh supervised review", async t => {
  const f = await prepared(t, { unchecked: true });
  assert.throws(() => f.component.submissionPreview({ change: "demo", outcome: "completed" }), /integrat.*task/i);
  const g = await prepared(t);
  assert.throws(() => exportArgs(g), /fresh review/i);
  await g.review();
  const r = g.r.read("demo"); writeFileSync(join(r.integration.path, "output.txt"), "dirty\n");
  assert.throws(() => exportArgs(g), /clean|head/i);
  git(r.integration.path, "restore", "output.txt");
  writeFileSync(join(r.integration.path, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Produce output\n");
  git(r.integration.path, "add", "."); git(r.integration.path, "commit", "-m", "Uncheck task"); r.head = git(r.integration.path, "rev-parse", "HEAD"); g.r.save(r);
  assert.throws(() => exportArgs(g), /canonical|completion/i);
});

test("receipts export only portable evidence and immutable retry identities", async t => {
  const f = await completed(t), { record, bytes } = f.exported;
  assert.equal(record.result.commit, f.r.read("demo").head); assert.equal(record.review.commit, record.result.commit);
  assert.equal(record.owner, "alice"); assert.deepEqual(record.tasks, [{ id: "1.1", completed: true }]);
  for (const privateText of [f.dir, '"session"', '"pid"', '"worktree"']) assert.ok(!bytes.includes(privateText));
  assert.equal(f.component.exportSubmission(f.args).bytes, bytes);
  assert.throws(() => f.component.exportSubmission({ ...f.args, operationId: "changed" }), /immutable|identity/i);
});

for (const boundary of ["export", "acceptance"]) test(`approved stdout stays portable at ${boundary} with independent acceptance and exact retry bytes`, async t => {
  const check = ["node", "-e", "console.log(process.cwd()); console.log(JSON.stringify({cwd:process.cwd(),roots:JSON.parse(process.env.PORTABLE_ROOTS)})); for(const path of JSON.parse(process.env.PORTABLE_ROOTS)) console.log(path); require('node:fs').appendFileSync(process.env.PORTABLE_COUNTER,'check\\n'); console.log(process.cwd()+'/src/example.ts'); console.log('useful trailing verification: 42 assertions passed')"];
  const f = coordinationFixture(t, { unchecked: false, checks: [check] });
  const external = join(f.dir, 'private delegated "checkouts"');
  mkdirSync(external);
  const { component, input } = f.imported(); input.resources = { worktreeRoot: external };
  const inspection = await component.inspect(input); await component.import({ ...input, token: inspection.token }); await f.review();
  f.component = component;
  const binding = component.readBinding({ change: "demo" }), integration = f.r.read("demo").integration.path, counter = join(f.dir, "check-count");
  const ownerRoots = [integration, realpathSync(integration), f.root, join(f.root, ".git"), join(f.root, ".git/openspec-runner"), external, ...binding.contextPaths];
  process.env.PORTABLE_ROOTS = JSON.stringify(ownerRoots); process.env.PORTABLE_COUNTER = counter;
  t.after(() => { delete process.env.PORTABLE_ROOTS; delete process.env.PORTABLE_COUNTER; });
  const args = exportArgs(f); f.exported = component.exportSubmission(args);
  const assertEvidence = evidence => {
    assert.deepEqual(evidence.command, check); assert.equal(evidence.exitCode, 0);
    assert.match(evidence.evidence, /component:api\/src\/example\.ts/);
    assert.match(evidence.evidence, /useful trailing verification: 42 assertions passed$/);
    const serialized = JSON.parse(evidence.evidence.split("\n")[1]);
    assert.equal(serialized.cwd, "component:api");
    assert.ok(serialized.roots.every(path => !path.startsWith("/")));
  };
  if (boundary === "export") {
    assertEvidence(f.exported.record.verification[0]);
    for (const path of ownerRoots) assert.ok(!f.exported.bytes.includes(path), `Receipt leaked ${path}`);
  }
  assert.equal(component.exportSubmission(args).bytes, f.exported.bytes);
  const clone = join(f.dir, "independent coordinator api"), store = join(f.dir, "independent coordinator store");
  execFileSync("git", ["clone", "--quiet", f.root, clone]); execFileSync("git", ["clone", "--quiet", f.storeRoot, store]);
  git(clone, "config", "openspec-runner.repository", "api"); git(store, "config", "openspec-runner.repository", "contracts");
  git(store, "config", "user.email", "test@example.test"); git(store, "config", "user.name", "Test");
  const c = new Coordination({ root: store, featureId: "feature", repositories: { api: clone, contracts: store } });
  c.importSubmission({ bytes: f.exported.bytes, expectedHead: git(store, "rev-parse", "HEAD") });
  const checkout = join(clone, ".git/openspec-runner/acceptance-checkouts/op-accept");
  const coordinatorRoots = [checkout, clone, join(clone, ".git"), join(clone, ".git/openspec-runner"), store, join(store, ".git/openspec-runner")];
  process.env.PORTABLE_ROOTS = JSON.stringify(coordinatorRoots);
  const accept = acceptArgs(f, c), original = c.store.writeRecord.bind(c.store); let interrupted = false;
  c.store.writeRecord = options => { const result = original(options); if (!interrupted && options.record.type === "accepted") { interrupted = true; throw new Error("Simulated interruption after portable commit"); } return result; };
  assert.throws(() => c.accept(accept), /Simulated interruption/);
  const eventPath = "runner/features/feature/events/accept.json", eventBytes = readFileSync(join(store, eventPath), "utf8");
  c.store.writeRecord = original; c.accept(accept); c.accept(accept);
  assert.equal(readFileSync(join(store, eventPath), "utf8"), eventBytes);
  assertEvidence(c.snapshot().records.find(record => record.type === "accepted").verification[0]);
  for (const path of [...ownerRoots, ...coordinatorRoots]) assert.ok(!eventBytes.includes(path), `Acceptance leaked ${path}`);
  const committedBytes = git(store, "show", `HEAD:${eventPath}`); assert.equal(committedBytes, eventBytes.trim());
  assert.ok(!committedBytes.includes(f.dir));
  assert.equal(readFileSync(counter, "utf8"), "check\ncheck\n");
  assert.equal(c.snapshot().records.filter(record => record.type === "accepted").length, 1);
  assert.deepEqual(c.status().pendingOperations, []);
  // Local diagnostic evidence remains available for recovery and inspection.
  assert.ok(readFileSync(join(store, ".git/openspec-runner/acceptance/op-accept.json"), "utf8").includes(checkout));
});

test("portable verification matches longest known aliases including removed checkouts and JSON escapes", async t => {
  const f = coordinationFixture(t), actual = join(f.dir, 'owned "runtime"\\path'), alias = join(f.dir, "runtime alias");
  mkdirSync(actual); symlinkSync(actual, alias);
  const checkout = join(alias, "removed-checkout"), canonical = join(actual, "removed-checkout");
  const unowned = actual + "-unowned";
  const command = ["node", "-e", "console.log('/unowned/keep-this')"], outputs = [checkout, canonical, alias, actual, "/unowned/keep-this", unowned];
  const evidence = { command, exitCode: 7, evidence: outputs.join("\n") + "\n" + JSON.stringify(outputs) + "\nUseful final failure detail" };
  const { portableVerificationEvidence } = await import("../dist/submission.js");
  const result = portableVerificationEvidence({ evidence, roots: [{ path: alias, identity: "component:api:runtime" }, { path: checkout, identity: "component:api" }] });
  assert.deepEqual(result.command, command); assert.equal(result.exitCode, 7);
  const expected = ["component:api", "component:api", "component:api:runtime", "component:api:runtime", "/unowned/keep-this", unowned];
  assert.equal(result.evidence, expected.join("\n") + "\n" + JSON.stringify(expected) + "\nUseful final failure detail");
  assert.deepEqual(evidence.command, command); assert.ok(evidence.evidence.includes(canonical));
});

test("blocked and failed export require concrete reasons without a result SHA", async t => {
  const f = await prepared(t, { unchecked: true });
  for (const outcome of ["blocked", "failed"]) {
    assert.throws(() => f.component.submissionPreview({ change: "demo", outcome }), /reason/i);
    const p = f.component.submissionPreview({ change: "demo", outcome, reason: "Missing dependency" });
    const result = f.component.exportSubmission({ change: "demo", outcome, reason: "Missing dependency", token: p.token, id: outcome, operationId: `op-${outcome}` });
    assert.equal(result.record.result, undefined); assert.equal(result.record.reason, "Missing dependency");
  }
});

test("independent coordinator clone accepts available exact commit in its own checkout without worker runtime", async t => {
  const check = ["node", "-e", "if(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() !== process.env.EXPECTED_RESULT) process.exit(2); console.log('independent exact checkout')"];
  const f = await prepared(t, { checks: [check] }); await f.review(); process.env.EXPECTED_RESULT = f.r.read("demo").head; t.after(() => delete process.env.EXPECTED_RESULT);
  f.exported = f.component.exportSubmission(exportArgs(f));
  const clone = join(f.dir, "coordinator-api"), store = join(f.dir, "coordinator-store");
  execFileSync("git", ["clone", "--quiet", f.root, clone]); execFileSync("git", ["clone", "--quiet", f.storeRoot, store]);
  git(clone, "config", "openspec-runner.repository", "api"); git(store, "config", "openspec-runner.repository", "contracts"); git(store, "config", "user.email", "test@example.test"); git(store, "config", "user.name", "Test");
  const c = new Coordination({ root: store, featureId: "feature", repositories: { api: clone, contracts: store } });
  c.importSubmission({ bytes: f.exported.bytes, expectedHead: git(store, "rev-parse", "HEAD") });
  const before = git(clone, "worktree", "list", "--porcelain"), p = c.acceptancePreview({ submissionId: "receipt" });
  assert.equal(git(clone, "worktree", "list", "--porcelain"), before); assert.equal(p.commit, f.exported.record.result.commit);
  assert.deepEqual(p.verification, [check]); assert.deepEqual(p.changedPaths, []);
  c.accept({ ...acceptArgs(f, c) });
  assert.equal(c.status().components.api.phase, "accepted"); assert.equal(c.status().components.api.deliveryCommit, undefined);
  assert.equal(existsSync(join(clone, ".git/openspec-runner/features/demo.json")), false);
  assert.match(c.snapshot().records.find(r => r.type === "accepted").verification[0].evidence, /independent exact checkout/);
  assert.equal(git(clone, "worktree", "list", "--porcelain"), before);
});

test("import preserves exact bytes and changed immutable identity fails", async t => {
  const f = await completed(t), bytes = JSON.stringify(f.exported.record, null, 4) + "\n\n";
  const first = imported(f, bytes); assert.equal(imported(f, bytes).created, false);
  assert.equal(readFileSync(join(f.storeRoot, first.path), "utf8"), bytes);
  assert.throws(() => imported(f, JSON.stringify({ ...f.exported.record, owner: "bob" })), /immutable|bytes/i);
});

test("acceptance rejects forged review, missing object, stale approval, revocation and changed contract", async t => {
  const f = await completed(t), forged = structuredClone(f.exported.record); forged.review.commit = "a".repeat(40); imported(f, JSON.stringify(forged));
  assert.throws(() => acceptArgs(f), /review|commit/i);
  const g = await completed(t); imported(g); g.c.revoke({ assignmentId: "assignment", reason: "cancelled", id: "revoke", operationId: "op-revoke", expectedHead: git(g.storeRoot, "rev-parse", "HEAD") });
  assert.throws(() => acceptArgs(g), /active|revoked/i);
  const h = await completed(t); imported(h); writeFileSync(join(h.storeRoot, "AGENTS.md"), "new contract guidance\n"); git(h.storeRoot, "add", "."); git(h.storeRoot, "commit", "-m", "Context drift");
  assert.throws(() => acceptArgs(h), /context|contract|drift/i);
});

test("blocking or unsuccessful supervised review prevents completed export", async t => {
  const f = await prepared(t); f.control({ findings: [blocker] }); await f.review(); assert.throws(() => exportArgs(f), /blocking/i);
  const g = await prepared(t); g.control({ exitCode: 1 }); await g.review(); assert.throws(() => exportArgs(g), /supervised|successful/i);
});

test("blocking review export gate receives accepted evidence after delayed supervised registration", async t => {
  const f = await prepared(t); f.control({ findings: [blocker] });
  const original = f.f.runner.lock.bind(f.f.runner); let delayed = false;
  f.f.runner.lock = fn => original(() => {
    const result = fn(), job = f.f.read("demo").jobs.at(-1);
    if (!delayed && job?.worker?.pid && !job.session && !job.worker.exitedAt) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    }
    return result;
  });
  await f.review();
  const job = f.f.read("demo").jobs.at(-1);
  assert.equal(delayed, true);
  assert.equal(job.worker.exitCode, 0);
  assert.equal(job.phase, "completed");
  assert.deepEqual(job.report.findings, [blocker]);
  assert.throws(() => exportArgs(f), /blocking/i);
});

test("acceptance requires token and expected branch/head then recovers exact recorded operation without repeated checks", async t => {
  const f = await completed(t); imported(f); const args = acceptArgs(f);
  assert.throws(() => f.c.accept({ ...args, token: "bad" }), /token/i);
  git(f.storeRoot, "switch", "-c", "other"); assert.throws(() => f.c.accept(args), /branch/i); git(f.storeRoot, "switch", "coordination");
  assert.throws(() => f.c.accept({ ...args, expectedHead: "a".repeat(40) }), /head/i);
  const result = f.c.accept(args); assert.equal(f.c.accept(args).head, result.head);
  assert.equal(f.c.snapshot().records.filter(r => r.type === "accepted").length, 1);
  assert.deepEqual(f.c.status().pendingOperations, []);
});

test("acceptance recovers interruption after started or accepted commit without duplicate checks", async t => {
  for (const interruptedType of ["operation-started", "accepted", "operation-finished"]) {
    const counter = join(process.env.TMPDIR || "/tmp", `accept-count-${process.pid}-${interruptedType}`);
    t.after(async () => { const { rmSync } = await import("node:fs"); rmSync(counter, { force: true }); });
    const check = ["node", "-e", "const fs=require('node:fs'); if(process.env.ACCEPT_COUNTER) fs.appendFileSync(process.env.ACCEPT_COUNTER,'check\\n'); console.log('passed')"];
    const f = await completed(t, { checks: [check] }); imported(f); const args = acceptArgs(f);
    process.env.ACCEPT_COUNTER = counter; t.after(() => delete process.env.ACCEPT_COUNTER);
    const original = f.c.store.writeRecord.bind(f.c.store); let interrupted = false;
    f.c.store.writeRecord = options => { const result = original(options); if (!interrupted && options.record.type === interruptedType) { interrupted = true; throw new Error("Simulated interruption after commit"); } return result; };
    assert.throws(() => f.c.accept(args), /Simulated interruption/);
    f.c.store.writeRecord = original;
    f.c.accept(args); f.c.accept(args);
    assert.equal(readFileSync(counter, "utf8"), "check\n");
    assert.equal(f.c.snapshot().records.filter(record => record.type === "accepted").length, 1);
    assert.deepEqual(f.c.status().pendingOperations, []); delete process.env.ACCEPT_COUNTER;
  }
});

test("coordinator executes required checks independently and never accepts failed or ambiguous checks", async t => {
  const check = ["node", "-e", "console.log('required check'); process.exit(process.env.FAIL_ACCEPTANCE ? 3 : 0)"];
  const f = await completed(t, { checks: [check] }); imported(f); const args = acceptArgs(f);
  process.env.FAIL_ACCEPTANCE = "1"; t.after(() => delete process.env.FAIL_ACCEPTANCE);
  assert.throws(() => f.c.accept(args), /acceptance.*failed/i); delete process.env.FAIL_ACCEPTANCE;
  assert.equal(f.c.status().components.api.acceptedCommit, undefined);
  assert.throws(() => f.c.accept(args), /failed/i);
  const journalPath = join(f.c.store.root, ".git/openspec-runner/acceptance/op-accept.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")); journal.stage = "checking"; journal.running = 0; writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(() => f.c.accept(args), /ambiguous|interrupted/i);
});

test("typed completed claims cannot substitute for available Git objects, base ancestry or exact approved planning", async t => {
  const f = await completed(t); const receipt = structuredClone(f.exported.record); receipt.result.commit = "a".repeat(40); receipt.review.commit = receipt.result.commit;
  imported(f, JSON.stringify(receipt)); assert.throws(() => acceptArgs(f), /unavailable|retrieve/i);
  const g = await completed(t); const r = g.r.read("demo"); writeFileSync(join(r.integration.path, "openspec/changes/demo/tasks.md"), "- [x] 1.1 Changed scope\n"); git(r.integration.path, "add", "."); git(r.integration.path, "commit", "-m", "Alter planning");
  const forged = structuredClone(g.exported.record); forged.result.commit = git(r.integration.path, "rev-parse", "HEAD"); forged.review.commit = forged.result.commit;
  imported(g, JSON.stringify(forged)); assert.throws(() => acceptArgs(g), /planning.*drift/i);
  const h = await completed(t); imported(h); h.approve("new-approval"); assert.throws(() => acceptArgs(h), /approval.*stale/i);
});

test("corrupt verified journal cannot replace independent required check evidence", async t => {
  const check = ["node", "-e", "process.exit(process.env.FAIL_ACCEPTANCE ? 3 : 0)"];
  const f = await completed(t, { checks: [check] }); imported(f); const args = acceptArgs(f);
  process.env.FAIL_ACCEPTANCE = "1"; t.after(() => delete process.env.FAIL_ACCEPTANCE);
  assert.throws(() => f.c.accept(args), /failed/i); delete process.env.FAIL_ACCEPTANCE;
  const path = join(f.storeRoot, ".git/openspec-runner/acceptance/op-accept.json"), journal = JSON.parse(readFileSync(path, "utf8"));
  journal.stage = "verified"; journal.evidence = []; writeFileSync(path, JSON.stringify(journal));
  assert.throws(() => f.c.accept(args), /evidence|verification/i);
  assert.equal(f.c.status().components.api.acceptedCommit, undefined);
});


test("real supervised task integration exports canonical completed tasks and changed scope", async t => {
  const f = await prepared(t, { unchecked: true }), codex = join(f.bin, "codex"), original = readFileSync(codex, "utf8");
  executable(codex, `
if(process.argv.includes('--help')) { console.log('--cd --add-dir --model'); process.exit(0); }
if(process.argv.includes('--version')) { console.log('test-cli'); process.exit(0); }
(async()=>{
const fs=require('node:fs'), cp=require('node:child_process');
const {Runner}=await import(${JSON.stringify(new URL("../dist/runner.js", import.meta.url).href)});
const r=new Runner(), a=r.read('demo').attempts.at(-1), session='task-'+a.id;
process.env.CODEX_THREAD_ID=session; r.begin('demo',a.task,a.id,session);
fs.writeFileSync('output.txt','implemented\\n'); cp.execFileSync('git',['add','.']); cp.execFileSync('git',['commit','-m','Implement']);
r.report('demo',a.task,a.id,{attempt:a.id,task:a.task,session,outcome:'completed',commit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),summary:'Implemented',verification:['Checked output']});
})().catch(error=>{console.error(error);process.exitCode=1;});`);
  const task = f.r.launch("demo", ["1.1"])[0]; await f.r.worker("demo", task.task, task.id);
  assert.equal(f.r.read("demo").attempts[0].worker.exitCode, 0);
  f.r.integrate("demo", ["1.1"]); writeFileSync(codex, original); await f.review();
  f.exported = f.component.exportSubmission(exportArgs(f)); imported(f);
  const preview = f.c.acceptancePreview({ submissionId: "receipt" });
  assert.deepEqual(preview.changedPaths, ["openspec/changes/demo/tasks.md", "output.txt"]);
  f.c.accept(acceptArgs(f)); assert.equal(f.c.status().components.api.acceptedCommit, f.exported.record.result.commit);
});

test("independent acceptance rejects non-descendant, archived and unchecked commits", async t => {
  for (const alteration of ["non-descendant", "archived", "unchecked"]) {
    const f = await completed(t), r = f.r.read("demo"), receipt = structuredClone(f.exported.record); let commit;
    if (alteration === "non-descendant") commit = git(f.root, "commit-tree", git(f.root, "rev-parse", "HEAD^{tree}"), "-m", "Independent root");
    else {
      if (alteration === "archived") git(r.integration.path, "mv", "openspec/changes/demo", "openspec/changes/archived-demo");
      else writeFileSync(join(r.integration.path, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Produce output\n");
      git(r.integration.path, "add", "."); git(r.integration.path, "commit", "-m", alteration); commit = git(r.integration.path, "rev-parse", "HEAD");
    }
    receipt.result.commit = commit; receipt.review.commit = commit; imported(f, JSON.stringify(receipt));
    assert.throws(() => acceptArgs(f), /ancestor|archived|completion/i);
  }
});

test("malformed export identity fails before verification side effects and failed checks do not export completed receipts", async t => {
  const marker = join("/tmp", `export-check-${process.pid}`), check = ["node", "-e", "if(process.env.EXPORT_MARKER) require('node:fs').writeFileSync(process.env.EXPORT_MARKER,'checked'); process.exit(process.env.FAIL_EXPORT ? 2 : 0)"];
  t.after(async () => { const { rmSync } = await import("node:fs"); rmSync(marker, { force: true }); delete process.env.EXPORT_MARKER; delete process.env.FAIL_EXPORT; });
  const f = await prepared(t, { checks: [check] }); await f.review(); const args = exportArgs(f);
  assert.throws(() => f.component.exportSubmission({ ...args, token: "wrong" }), /token/i);
  process.env.EXPORT_MARKER = marker;
  assert.throws(() => f.component.exportSubmission({ ...args, createdAt: "not-a-date" }), /timestamp|createdAt/i);
  assert.equal(existsSync(marker), false);
  process.env.FAIL_EXPORT = "1"; assert.throws(() => f.component.exportSubmission(args), /verification failed/i);
  assert.equal(existsSync(join(f.root, ".git/openspec-runner/submissions/receipt.json")), false);
});

test("explicit acceptance inputs cannot pin obsolete contract revision to bypass current drift", async t => {
  const f = await completed(t); imported(f);
  const revision = git(f.storeRoot, "rev-parse", "HEAD");
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Changed current contract\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Contract drift");
  assert.throws(() => f.c.acceptancePreview({ submissionId: "receipt", inputs: { contract: { ...f.contract, revision } } }), /current|drift|revision/i);
});

test("committed plan acceptance preserves contained relative planning-rule supplement paths", async t => {
  for (const planningRules of ["./policy.md", "nested/../policy.md", "nested/./policy.md"]) {
    const f = coordinationFixture(t, { unchecked: false });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(f.root, "nested"));
    writeFileSync(join(f.root, "policy.md"), "Approved project planning policy\n");
    writeFileSync(join(f.root, "nested/policy.md"), "Approved nested planning policy\n");
    writeFileSync(join(f.root, "openspec/runner.yaml"), JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "test-model", planningRules } }, worktrees: "git", terminal: "manual", cleanup: "manual", verifyIntegration: [] }));
    git(f.root, "add", "."); git(f.root, "commit", "-m", "Declare relative planning rules");
    const { loadPlan } = await import("../dist/plan.js"), { committedPlan } = await import("../dist/submission.js");
    const local = loadPlan(f.root, "demo"), commit = git(f.root, "rev-parse", "HEAD");
    assert.equal(committedPlan({ root: f.root, change: "demo", commit }).fingerprint, local.fingerprint);
    const { component, input } = f.imported(), preview = await component.inspect(input);
    await component.import({ ...input, token: preview.token }); await f.review();
    f.component = component; f.exported = component.exportSubmission(exportArgs(f)); imported(f);
    f.c.accept(acceptArgs(f)); assert.equal(f.c.status().components.api.acceptedCommit, commit);
  }
});

test("normalized planning-rule selection retains repository containment and committed symlink rejection", async t => {
  const { committedPlan } = await import("../dist/submission.js"), { symlinkSync } = await import("node:fs");
  for (const unsafe of ["outside", "symlink"]) {
    const f = coordinationFixture(t, { unchecked: false });
    const planningRules = unsafe === "outside" ? "../policy.md" : "./policy.md";
    if (unsafe === "symlink") symlinkSync("output.txt", join(f.root, "policy.md"));
    writeFileSync(join(f.root, "openspec/runner.yaml"), JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "test-model", planningRules } }, worktrees: "git", terminal: "manual", verifyIntegration: [] }));
    git(f.root, "add", "."); git(f.root, "commit", "-m", "Unsafe supplement");
    assert.throws(() => committedPlan({ root: f.root, change: "demo", commit: git(f.root, "rev-parse", "HEAD") }), /inside the repository|symlinks|non-files/i);
  }
});

async function scopeCompleted(t, relevantPaths) {
  const f = coordinationFixture(t, { unchecked: false }), { mkdirSync } = await import("node:fs");
  mkdirSync(join(f.storeRoot, "openspec/specs/selected"), { recursive: true });
  mkdirSync(join(f.storeRoot, "openspec/specs/unselected"), { recursive: true });
  writeFileSync(join(f.storeRoot, "openspec/specs/selected/spec.md"), "Selected specification\n");
  writeFileSync(join(f.storeRoot, "openspec/specs/unselected/spec.md"), "Unselected specification\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Specification scope");
  if (relevantPaths) f.contract.relevantPaths = relevantPaths;
  const { component, input } = f.imported(), preview = await component.inspect(input);
  await component.import({ ...input, token: preview.token }); await f.review();
  f.component = component; f.exported = component.exportSubmission(exportArgs(f)); imported(f);
  return f;
}

test("acceptance cannot narrow approved default selectors to hide newly selected specifications", async t => {
  const f = await scopeCompleted(t), { mkdirSync } = await import("node:fs");
  const assignment = f.c.store.readRecord({ kind: "assignment", id: "assignment" });
  mkdirSync(join(f.storeRoot, "openspec/specs/new"), { recursive: true }); writeFileSync(join(f.storeRoot, "openspec/specs/new/spec.md"), "New selected spec\n");
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Add selected spec");
  assert.throws(() => f.c.acceptancePreview({ submissionId: "receipt" }), /drift|scope|selection/i);
  assert.throws(() => f.c.acceptancePreview({ submissionId: "receipt", inputs: { contract: { ...f.contract, relevantPaths: assignment.contract.files.map(file => file.path) } } }), /drift|scope|selection/i);
});

test("approved custom directory selectors detect additions while unrelated specs preserve acceptance", async t => {
  const f = await scopeCompleted(t, ["openspec/specs/selected"]);
  f.c.acceptancePreview({ submissionId: "receipt" });
  writeFileSync(join(f.storeRoot, "openspec/specs/unselected/spec.md"), "Unrelated edit\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Unselected spec edit");
  const preview = f.c.acceptancePreview({ submissionId: "receipt", inputs: { contract: f.contract } });
  assert.equal(preview.contractFingerprint, f.exported.record.contractFingerprint);
  f.c.acceptancePreview({ submissionId: "receipt" });
  writeFileSync(join(f.storeRoot, "openspec/specs/selected/new.md"), "New selected specification\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Add custom-selected spec");
  assert.throws(() => f.c.acceptancePreview({ submissionId: "receipt" }), /drift|scope|selection/i);
  assert.throws(() => f.c.acceptancePreview({ submissionId: "receipt", inputs: { contract: f.contract } }), /drift|scope|selection/i);
});
