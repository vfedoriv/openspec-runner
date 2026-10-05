import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CoordinationStore, decodeManifest, decodeRecord, stableDigest, decodePinnedContext } from "../dist/coordination-state.js";

const sha = "a".repeat(40), fp = "b".repeat(64);
const settings = { implementation: { harness: "codex", model: "model" }, tasks: {}, review: { harness: "codex", model: "model" }, repair: { harness: "codex", model: "model" }, maxFixRounds: 2, verifyIntegration: [["node", "--test"]] };
const component = { repository: "https://example.test/api.git", change: "api-change", deliveryBranch: "main", settings, dependencies: [] };
const manifest = () => ({ version: 1, featureId: "feature", storeId: "team", sharedChange: "shared", coordinationBranch: "coordination", components: { api: component }, taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [{ componentId: "api", command: ["node", "--test"] }], completion: { requireAllMerged: true } });
const metadata = (id) => ({ version: 1, id, featureId: "feature", operationId: `op-${id}`, createdAt: "2026-10-04T12:00:00Z" });
const contract = { version: 1, repository: "store", revision: sha, change: "shared", fingerprint: "d2fcd49c4c3bb931b1766f30b5e3afc7b34abadc1519e53b42b8f0864ea568a3", files: [{ path: "openspec/changes/shared/tasks.md", content: "- [ ] 1.1 Deliver API\n" }] };
const approval = () => ({ ...metadata("approval"), kind: "approval", manifestFingerprint: fp, contract, components: { api: { repository: component.repository, change: component.change, base: sha, planFingerprint: fp, settings } }, verification: [{ componentId: "api", command: ["node", "--test"] }], consent: { token: fp, approvedBy: "user" } });
const assignment = (id = "assignment") => ({ ...metadata(id), kind: "assignment", approvalId: "approval", componentId: "api", repository: component.repository, change: component.change, owner: "alice", base: sha, planFingerprint: fp, contract, settings, dependencies: [] });
const submission = () => ({ ...metadata("submission"), kind: "submission", assignmentId: "assignment", owner: "alice", outcome: "completed", repository: component.repository, change: component.change, base: sha, planFingerprint: fp, contractFingerprint: contract.fingerprint, result: { branch: "result/api", commit: sha }, tasks: [{ id: "1.1", completed: true }], review: { commit: sha, findings: [] }, verification: [{ command: ["node", "--test"], exitCode: 0, evidence: "pass" }] });
const event = (id, type, sequence, more = {}) => ({ ...metadata(id), kind: "event", type, sequence, ...more });
const git = (root, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" }).trim();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runner-records-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "coordination"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.test");
  mkdirSync(join(root, "openspec/changes/shared"), { recursive: true });
  writeFileSync(join(root, "openspec/changes/shared/tasks.md"), contract.files[0].content);
  writeFileSync(join(root, "README.md"), "Store\n"); git(root, "add", "."); git(root, "commit", "-m", "store");
  const store = new CoordinationStore({ root, featureId: "feature" });
  const write = (record, more = {}) => store.writeRecord({ record, expectedHead: git(root, "rev-parse", "HEAD"), ...more });
  store.writeManifest({ manifest: manifest(), sharedTasks: [{ id: "1.1", completed: false }], expectedHead: git(root, "rev-parse", "HEAD"), operationId: "init-feature" });
  return { root, store, write };
}

test("manifest validates unfinished shared task coverage and dependency graph", () => {
  assert.equal(decodeManifest({ value: manifest(), sharedTasks: [{ id: "1.1", completed: false }] }).featureId, "feature");
  assert.throws(() => decodeManifest({ value: manifest(), sharedTasks: [{ id: "1.2", completed: false }] }), /mapping.*1\.2/i);
  const unknown = manifest(); unknown.components.api = { ...component, dependencies: [{ componentId: "missing", milestone: "accepted" }] };
  assert.throws(() => decodeManifest({ value: unknown }), /unknown component/i);
  const cycle = manifest(); cycle.components.api = { ...component, dependencies: [{ componentId: "web", milestone: "merged" }] }; cycle.components.web = { ...component, dependencies: [{ componentId: "api", milestone: "accepted" }] };
  assert.throws(() => decodeManifest({ value: cycle }), /cycle/i);
});

test("strict contracts reject unsupported versions, unknown fields, unsafe IDs, paths and nonportable settings", () => {
  for (const value of [{ ...manifest(), version: 2 }, { ...manifest(), featureId: "../feature" }, { ...manifest(), cwd: "/machine" }]) assert.throws(() => decodeManifest({ value }), /version|id|field/i);
  assert.throws(() => decodeRecord({ value: { ...assignment(), id: "../../escape" } }), /id/i);
  assert.throws(() => decodeRecord({ value: { ...assignment(), version: 2 } }), /version/i);
  const bad = assignment(); bad.contract = { ...contract, files: [{ path: "../escape", content: "secret" }] };
  assert.throws(() => decodeRecord({ value: bad }), /path/i);
  const runtime = assignment(); runtime.settings = { ...settings, cwd: "/tmp/runtime" };
  assert.throws(() => decodeRecord({ value: runtime }), /field/i);
  assert.throws(() => decodeRecord({ value: { ...submission(), review: { commit: "short", findings: [] } } }), /commit/i);
  assert.throws(() => decodeRecord({ value: { ...approval(), consent: { token: fp } } }), /approvedBy/i);
});

test("failed receipts require concrete reasons and completed receipts require result and review", () => {
  const value = submission(); delete value.result; delete value.review; value.outcome = "blocked"; value.reason = "Missing API credentials";
  assert.equal(decodeRecord({ value }).outcome, "blocked");
  delete value.reason; assert.throws(() => decodeRecord({ value }), /reason/i);
  value.outcome = "completed"; assert.throws(() => decodeRecord({ value }), /result|review/i);
});

test("stable digests ignore object insertion order but retain array order", () => {
  assert.equal(stableDigest({ value: { a: 1, b: { x: 2, y: 3 } } }), stableDigest({ value: { b: { y: 3, x: 2 }, a: 1 } }));
  assert.notEqual(stableDigest({ value: [1, 2] }), stableDigest({ value: [2, 1] }));
});

test("portable pinned context validates its relevant content fingerprint", () => {
  const forged = { ...contract, files: [{ ...contract.files[0], content: "Forged contract\n" }] };
  assert.throws(() => decodePinnedContext({ value: forged }), /fingerprint/i);
  assert.equal(decodePinnedContext({ value: contract }).fingerprint, contract.fingerprint);
});

test("record import preserves exact bytes and retries immutable identities", (t) => {
  const { root, store, write } = fixture(t); write(approval()); write(assignment());
  const record = submission(), bytes = Buffer.from(JSON.stringify(record, null, 4) + "\n\n");
  const result = write(record, { bytes });
  assert.equal(result.created, true);
  assert.deepEqual(readFileSync(join(root, result.path)), bytes);
  assert.equal(write(record, { bytes }).created, false);
  const changed = { ...record, owner: "mallory" };
  assert.throws(() => write(changed), /immutable|identity/i);
  assert.throws(() => write(record, { bytes: Buffer.from(JSON.stringify(record)) }), /immutable|bytes/i);
  assert.equal(store.readRecord({ kind: "submission", id: "submission" }).owner, "alice");
});

test("writes guard declared branch and expected head before side effects", (t) => {
  const { root, write } = fixture(t), head = git(root, "rev-parse", "HEAD");
  assert.throws(() => write(approval(), { expectedHead: sha }), /head/i);
  git(root, "switch", "-c", "other");
  assert.throws(() => write(approval(), { expectedHead: head }), /branch/i);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("record commits recover exact operation identity and cannot commit unrelated staged files", (t) => {
  const { root, write } = fixture(t), before = git(root, "rev-parse", "HEAD");
  const result = write(approval());
  assert.match(git(root, "show", "-s", "--format=%B", result.head), /Runner-Operation: op-approval/);
  const recovered = write(approval(), { expectedHead: before });
  assert.equal(recovered.head, result.head);
  writeFileSync(join(root, "unrelated.txt"), "Unrelated\n"); git(root, "add", "unrelated.txt");
  assert.throws(() => write(assignment()), /staged|clean/i);
  assert.equal(git(root, "rev-parse", "HEAD"), result.head);
});

test("concurrent branch advancement cannot publish a record against an unexpected parent", (t) => {
  const { root, write } = fixture(t), before = git(root, "rev-parse", "HEAD");
  const other = git(root, "commit-tree", git(root, "rev-parse", "HEAD^{tree}"), "-p", before, "-m", "External concurrent commit");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = mkdtempSync(join(tmpdir(), "runner-fake-git-")); t.after(() => rmSync(wrapperDir, { recursive: true, force: true }));
  const wrapper = join(wrapperDir, "git");
  writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" update-ref "*|*" commit --only "*)\n    if [ ! -e '${wrapperDir}/race-fired' ]; then\n      touch '${wrapperDir}/race-fired'\n      '${realGit}' -C '${root}' update-ref refs/heads/coordination '${other}' '${before}'\n    fi\n    ;;\nesac\nexec '${realGit}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${wrapperDir}:${originalPath}`;
  try {
    assert.throws(() => write(approval()), /head|reference|lock|expected/i);
    assert.equal(git(root, "rev-parse", "HEAD"), other);
  } finally { process.env.PATH = originalPath; }
});

test("uncommitted record recovery validates bytes before making a record commit", (t) => {
  const { root, store, write } = fixture(t);
  const value = approval();
  const path = join(root, "runner/features/feature/approvals/approval.json"); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  assert.equal(store.status().approvalId, undefined);
  assert.equal(write(value).created, false);
  assert.equal(store.status().approvalId, "approval");
});

test("an independent Store clone reconstructs status from committed portable records", (t) => {
  const { root, write } = fixture(t); write(approval()); write(assignment()); write(submission());
  const cloneParent = mkdtempSync(join(tmpdir(), "runner-record-clone-")); t.after(() => rmSync(cloneParent, { recursive: true, force: true }));
  const clone = join(cloneParent, "store"); git(cloneParent, "clone", "--quiet", root, clone);
  const cloned = new CoordinationStore({ root: clone, featureId: "feature" });
  assert.equal(cloned.status().components.api.phase, "submitted");
  assert.equal(cloned.readRecord({ kind: "assignment", id: "assignment" }).owner, "alice");
  assert.equal(JSON.stringify(cloned.readSnapshot()).includes(root), false);
});

test("lost index refresh after record commit recovers the exact commit without dirty index state", (t) => {
  const { root, write } = fixture(t), before = git(root, "rev-parse", "HEAD");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = mkdtempSync(join(tmpdir(), "runner-fake-git-")); t.after(() => rmSync(wrapperDir, { recursive: true, force: true }));
  const wrapper = join(wrapperDir, "git");
  writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in\n  *" add -- runner/features/feature/approvals/approval.json "*) exit 1 ;;\nesac\nexec '${realGit}' "$@"\n`); chmodSync(wrapper, 0o755);
  const originalPath = process.env.PATH; process.env.PATH = `${wrapperDir}:${originalPath}`;
  try { assert.throws(() => write(approval()), /git/); } finally { process.env.PATH = originalPath; }
  const committed = git(root, "rev-parse", "HEAD"); assert.notEqual(committed, before);
  assert.equal(write(approval(), { expectedHead: before }).head, committed);
  assert.equal(git(root, "status", "--porcelain", "--", "runner"), "");
});

test("Store rejects symlink record directories and files", (t) => {
  const { root, write } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "runner-outside-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, "runner/features/feature/approvals"));
  assert.throws(() => write(approval()), /symlink/i);
});

test("replay derives active assignment, accepted and merged states and retains rejected receipts", (t) => {
  const { store, write } = fixture(t); write(approval()); write(assignment()); write(submission());
  assert.equal(store.status().components.api.phase, "submitted");
  write(event("reject", "rejected", 1, { assignmentId: "assignment", submissionId: "submission", componentId: "api", reason: "Checks failed" }));
  assert.equal(store.status().components.api.phase, "assigned");
  assert.equal(store.status().submissions.submission.disposition, "rejected");
  write(event("accept", "accepted", 2, { assignmentId: "assignment", submissionId: "submission", componentId: "api", commit: sha }));
  assert.equal(store.status().components.api.phase, "accepted");
  write(event("merge", "merged", 3, { componentId: "api", submissionId: "submission", commit: sha, deliveryBranch: "main", deliveryCommit: sha, mergeStyle: "merge", prUrl: "https://example.test/pr/1", attestedBy: "user" }));
  assert.equal(store.status().components.api.phase, "merged");
  assert.equal(store.status().phase, "final-verification");
  assert.equal(store.status().archive, "pending");
});

test("revoked assignment submissions remain inspectable without replacing active progress", (t) => {
  const { store, write } = fixture(t); write(approval()); write(assignment());
  write(event("revoke", "revoked", 1, { assignmentId: "assignment", componentId: "api", reason: "Reassigned" }));
  write(assignment("replacement")); write(submission());
  const status = store.status();
  assert.equal(status.components.api.assignmentId, "replacement");
  assert.equal(status.components.api.phase, "assigned");
  assert.equal(status.submissions.submission.disposition, "stale");
});

test("replay rejects simultaneous active assignments and event references to unknown records", (t) => {
  const { store, write } = fixture(t); write(approval()); write(assignment());
  assert.throws(() => write(assignment("duplicate")), /active assignment/i);
  assert.throws(() => write(event("bad", "accepted", 1, { assignmentId: "missing", submissionId: "missing", componentId: "api", commit: sha })), /unknown|missing/i);
  assert.equal(store.status().components.api.assignmentId, "assignment");
});
