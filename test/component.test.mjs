import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { featureFixture, featureSettings, git, executable, blocker } from "./helpers/feature-fixture.mjs";
import { execFileSync } from "node:child_process";
import { Coordination } from "../dist/coordination.js";
import { Component } from "../dist/component.js";
import { Feature } from "../dist/feature.js";

function fixture(t, options = {}) {
  let dir;
  const unlock = path => { const stat = lstatSync(path); if (stat.isSymbolicLink()) return; chmodSync(path, stat.isDirectory() ? 0o755 : 0o644); if (stat.isDirectory()) for (const child of readdirSync(path)) unlock(join(path, child)); };
  const f = featureFixture({ after(cleanup) { t.after(() => { if (dir) unlock(dir); cleanup(); }); } }, { unchecked: options.unchecked ?? true });
  dir = f.dir;
  git(f.root, "config", "openspec-runner.repository", "api");
  const storeRoot = join(f.dir, "store"); mkdirSync(storeRoot);
  git(storeRoot, "init", "-b", "coordination"); git(storeRoot, "config", "user.name", "Test"); git(storeRoot, "config", "user.email", "test@example.test");
  git(storeRoot, "config", "openspec-runner.repository", "contracts");
  mkdirSync(join(storeRoot, "openspec/changes/shared"), { recursive: true });
  writeFileSync(join(storeRoot, "openspec/changes/shared/tasks.md"), "- [ ] 1.1 Deliver API\n");
  writeFileSync(join(storeRoot, "AGENTS.md"), "Shared guidance\n");
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Contract");
  const repositories = { api: f.root, contracts: storeRoot };
  const c = new Coordination({ root: storeRoot, featureId: "feature", repositories });
  const context = { implementationRoot: f.root, planningRoot: storeRoot, changeRoot: join(storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] };
  const contract = { context, repository: "contracts" };
  const manifest = { version: 1, featureId: "feature", storeId: "team", sharedChange: "shared", coordinationBranch: "coordination", components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [], settings: { ...featureSettings, tasks: {}, verifyIntegration: [], setup: [] } } }, taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  c.init({ manifest, contract, expectedHead: git(storeRoot, "rev-parse", "HEAD"), operationId: "init" });
  const approve = (id = "approval", extra = {}) => {
    const p = c.approvalPreview({ contract });
    c.approve({ contract, token: p.token, approvedBy: "user", id, operationId: `op-${id}`, expectedHead: git(storeRoot, "rev-parse", "HEAD"), ...extra }); return p;
  };
  const assign = () => { const p = c.assignmentPreview({ componentId: "api", owner: "alice", contract }); return c.assign({ componentId: "api", owner: "alice", contract, token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(storeRoot, "rev-parse", "HEAD") }); };
  const imported = () => { approve(); assign(); const component = new Component({ root: f.root, repository: "api" }); const input = { storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }; return { component, input }; };
  return { ...f, c, storeRoot, contract, manifest, approve, assign, imported };
}

test("approval previews bind committed context, base, full resolved settings and explicit consent", t => {
  const f = fixture(t), p = f.c.approvalPreview({ contract: f.contract });
  assert.equal(p.components.api.base, git(f.root, "rev-parse", "HEAD"));
  assert.equal(p.components.api.settings.tasks["1.1"].model, "test-model");
  assert.equal(p.components.api.settings.tasks["1.1"].reasoningEffort, "high");
  assert.equal(p.components.api.settings.maxFixRounds, 2);
  assert.deepEqual(p.components.api.settings.setup, []);
  assert.throws(() => f.c.approve({ contract: f.contract, token: p.token, approvedBy: "", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }), /consent|approvedBy/i);
  assert.throws(() => f.c.approve({ contract: f.contract, token: "bad", approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }), /token/i);
  f.approve();
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Changed guidance\n"); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Change guidance");
  assert.throws(() => f.c.assignmentPreview({ componentId: "api", owner: "alice", contract: f.contract }), /approval|drift/i);
});

test("assignments guard branch/head and retain one full-component owner", t => {
  const f = fixture(t); f.approve(); const p = f.c.assignmentPreview({ componentId: "api", owner: "alice", contract: f.contract });
  const args = { componentId: "api", owner: "alice", contract: f.contract, token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") };
  git(f.storeRoot, "switch", "-c", "other"); assert.throws(() => f.c.assign(args), /branch/i); git(f.storeRoot, "switch", "coordination");
  assert.throws(() => f.c.assign({ ...args, expectedHead: "a".repeat(40) }), /head/i);
  f.c.assign(args);
  assert.throws(() => f.c.assignmentPreview({ componentId: "api", owner: "bob", contract: f.contract }), /active assignment/i);
  assert.equal(f.c.status({}).components.api.assignmentId, "assignment");
});

test("import into independent clone freezes execution and read-only pinned prompts", async t => {
  const f = fixture(t); f.approve(); f.assign();
  const clone = join(f.dir, "independent api"), storeClone = join(f.dir, "independent store");
  execFileSync("git", ["clone", "--quiet", f.root, clone]); execFileSync("git", ["clone", "--quiet", f.storeRoot, storeClone]); git(clone, "config", "openspec-runner.repository", "api"); git(storeClone, "config", "openspec-runner.repository", "contracts");
  const component = new Component({ root: clone, repository: "api" }), input = { storeRoot: storeClone, featureId: "feature", assignmentId: "assignment", owner: "alice" };
  const preview = await component.inspect(input); assert.equal(preview.historyRevision, git(storeClone, "rev-parse", "HEAD"));
  const bound = await component.import({ ...input, token: preview.token });
  assert.equal(bound.assignmentId, "assignment"); assert.equal((await component.import({ ...input, token: preview.token })).assignmentId, "assignment");
  const feature = new Feature(clone), s = feature.read("demo");
  assert.equal(s.approval.tasks["1.1"].model, "test-model"); assert.equal(s.approval.maxFixRounds, 2);
  assert.equal(statSync(join(bound.contextPaths[0], "AGENTS.md")).mode & 0o222, 0);
  writeFileSync(join(f.storeRoot, "AGENTS.md"), "Replacement Store contents\n");
  const task = feature.runner.launch("demo", ["1.1"])[0];
  const prompt = feature.runner.prompt("demo", task); assert.ok(prompt.includes(bound.contextPaths[0])); assert.match(prompt, /pinned|Pinned/);
  assert.equal(readFileSync(join(bound.contextPaths[0], "AGENTS.md"), "utf8"), "Shared guidance\n");
  assert.throws(() => feature.planPreview("demo", featureSettings), /delegated|assignment/i);
  assert.throws(() => feature.finalPreview("demo"), /delegated|assignment/i);
  assert.throws(() => feature.archive("demo"), /delegated|assignment/i);
  assert.throws(() => feature.runner.preview("demo", ["1.1"], { model: "session" }), /overlay|settings|attempt/i);
  const review = { id: "test", agent: "codex", role: "review", path: join(clone, "fake"), base: s.approval.base, fingerprint: s.approval.fingerprint, settings: s.approval.review };
  assert.ok(feature.prompt("demo", review).includes(bound.contextPaths[0]));
  assert.ok(feature.prompt("demo", { ...review, role: "repair" }).includes(bound.contextPaths[0]));
});

test("imports reject identity, owner, base, plan, history and scope overlays", async t => {
  const f = fixture(t), { component, input } = f.imported();
  await assert.rejects(component.inspect({ ...input, owner: "bob" }), /owner/i);
  await assert.rejects(new Component({ root: f.root, repository: "wrong" }).inspect(input), /identity|repository/i);
  await assert.rejects(component.inspect({ ...input, historyRevision: "a".repeat(40) }), /history|git/i);
  const p = await component.inspect(input);
  await assert.rejects(component.import({ ...input, token: p.token, settings: {} }), /overlay|unknown/i);
  writeFileSync(join(f.root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Different scope\n");
  await assert.rejects(component.inspect(input), /committed|plan/i);
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Scope drift"); await assert.rejects(component.inspect(input), /base|plan/i);
});

test("revocation is reported against freshly inspected committed coordination history", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input); await component.import({ ...input, token: p.token });
  f.c.revoke({ assignmentId: "assignment", reason: "Owner changed", id: "revoke", operationId: "op-revoke", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  assert.equal(component.status({ change: "demo", storeRoot: f.storeRoot }).revoked, true);
  await assert.rejects(component.inspect(input), /revoked|active/i);
});

test("current approval authority follows committed introduction rather than timestamps", t => {
  const f = fixture(t); f.approve("first", { createdAt: "2099-01-01T00:00:00Z" }); f.approve("second", { createdAt: "2000-01-01T00:00:00Z" });
  assert.equal(f.c.status({}).approvalId, "second");
  f.assign(); assert.equal(f.c.store.readRecord({ kind: "assignment", id: "assignment" }).approvalId, "second");
});

test("every supplied referenced Store is pinned and relevant reference drift needs reapproval", async t => {
  const f = fixture(t), referenceRoot = join(f.dir, "reference"); mkdirSync(referenceRoot);
  git(referenceRoot, "init", "-b", "main"); git(referenceRoot, "config", "user.name", "Test"); git(referenceRoot, "config", "user.email", "test@example.test"); git(referenceRoot, "config", "openspec-runner.repository", "reference");
  mkdirSync(join(referenceRoot, "openspec/changes/ref"), { recursive: true }); writeFileSync(join(referenceRoot, "openspec/changes/ref/spec.md"), "Linked specification\n"); git(referenceRoot, "add", "."); git(referenceRoot, "commit", "-m", "Reference");
  f.c.repositories.reference = referenceRoot;
  f.contract.context.references = [{ storeId: "ref-store", root: referenceRoot, status: [] }];
  const reference = { repository: "reference", context: { ...f.contract.context, planningRoot: referenceRoot, changeRoot: join(referenceRoot, "openspec/changes/ref"), change: "ref", storeId: "ref-store", references: [] } };
  assert.throws(() => f.c.approvalPreview({ contract: f.contract }), /reference/i);
  const preview = f.c.approvalPreview({ contract: f.contract, references: [reference] }); assert.equal(preview.contract.references[0].files[0].content, "Linked specification\n");
  f.c.approve({ contract: f.contract, references: [reference], token: preview.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const p = f.c.assignmentPreview({ componentId: "api", owner: "alice", contract: f.contract, references: [reference] });
  f.c.assign({ componentId: "api", owner: "alice", contract: f.contract, references: [reference], token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const component = new Component({ root: f.root, repository: "api" }), input = { storeRoot: f.storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }, ip = await component.inspect(input), binding = await component.import({ ...input, token: ip.token });
  assert.equal(binding.contextPaths.length, 2);
  writeFileSync(join(referenceRoot, "openspec/changes/ref/spec.md"), "Changed specification\n"); git(referenceRoot, "add", "."); git(referenceRoot, "commit", "-m", "Change reference");
  assert.throws(() => f.c.assignmentPreview({ componentId: "api", owner: "bob", contract: f.contract, references: [reference] }), /approval|drift/i);
});

test("assignment and approval mutations retry exact identities without timestamp drift", t => {
  const f = fixture(t), p = f.approve(), head = git(f.storeRoot, "rev-parse", "HEAD");
  const repeated = f.c.approve({ contract: f.contract, token: p.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: head }); assert.equal(repeated.created, false);
  const ap = f.c.assignmentPreview({ contract: f.contract, componentId: "api", owner: "alice" }), expectedHead = git(f.storeRoot, "rev-parse", "HEAD");
  const args = { contract: f.contract, componentId: "api", owner: "alice", token: ap.token, id: "assignment", operationId: "op-assignment", expectedHead };
  const first = f.c.assign(args); assert.equal(f.c.assign(args).head, first.head);
});

test("shared approval reuses exact FeatureApproval adapter-owned role and task settings", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "openspec/runner.yaml"), JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "test-model" }, claude: { defaultModel: "claude-model", permissionMode: "acceptEdits", allowedTools: ["Read", "Bash(git *)"] } }, terminal: "manual", worktrees: "git", verifyIntegration: [], setup: [["node", "-e", "process.exit(0)"]] }));
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Role options and setup");
  const roles = { ...featureSettings, review: { harness: "claude", model: "claude-model", effort: "high" }, repair: { harness: "claude", model: "claude-model", effort: "medium" } };
  f.manifest.components.api.settings = { ...roles, tasks: {}, verifyIntegration: [], setup: [["node", "-e", "process.exit(0)"]] };
  writeFileSync(join(f.storeRoot, "runner/features/feature/manifest.yaml"), JSON.stringify(f.manifest)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Declare role options");
  f.f.start("demo"); const local = f.f.planPreview("demo", roles), shared = f.c.approvalPreview({ contract: f.contract }).components.api.settings;
  for (const role of ["implementation", "tasks", "review", "repair"]) assert.deepEqual(shared[role], local[role]);
  assert.deepEqual(shared.review.options, { permissionMode: "acceptEdits", allowedTools: ["Read", "Bash(git *)"] });
  assert.deepEqual(shared.setup, [["node", "-e", "process.exit(0)"]]);
});

test("import validates installed harness capabilities before reserving local execution", async t => {
  const f = fixture(t), { component, input } = f.imported();
  writeFileSync(join(f.bin, "codex"), "#!/usr/bin/env node\nconsole.log('unsupported CLI')\n");
  await assert.rejects(component.inspect(input), /Harness.*cannot execute|capabilit/i);
  assert.equal(component.status({ change: "demo" }).imported, false);
});

test("import rejects a forged approval token despite syntactically valid portable records", async t => {
  const f = fixture(t), { component, input } = f.imported();
  const path = join(f.storeRoot, "runner/features/feature/approvals/approval.json"), record = JSON.parse(readFileSync(path, "utf8"));
  record.consent.token = "a".repeat(64); writeFileSync(path, JSON.stringify(record)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Forge approval consent");
  await assert.rejects(component.inspect(input), /token|consent|immutable/i);
});

test("execution rejects local approval setting edits and writable pinned context", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input), binding = await component.import({ ...input, token: p.token });
  const feature = f.f, s = feature.read("demo"), file = join(feature.repo.stateDir, "features/demo.json");
  s.approval.tasks["1.1"].model = "edited-model"; writeFileSync(file, JSON.stringify(s));
  assert.throws(() => feature.runner.preview("demo", ["1.1"]), /approval|settings|binding/i);
  s.approval.tasks["1.1"].model = binding.assignment.settings.tasks["1.1"].model; writeFileSync(file, JSON.stringify(s));
  chmodSync(join(binding.contextPaths[0], "AGENTS.md"), 0o644);
  assert.throws(() => feature.runner.preview("demo", ["1.1"]), /pinned|writable/i);
});

test("import reservation recovers interrupted worktree creation without replacing approval", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input);
  const integration = join(f.root, ".openspec-runner/worktrees/demo-delegated-assignment-integration"); mkdirSync(integration, { recursive: true }); writeFileSync(join(integration, "obstruction"), "Not a Git worktree\n");
  await assert.rejects(component.import({ ...input, token: p.token }), /git|worktree|reservation/i);
  assert.equal(component.status({ change: "demo" }).phase, "reserved");
  const before = f.f.read("demo").approval;
  const { rmSync } = await import("node:fs"); rmSync(integration, { recursive: true, force: true });
  const recovered = await component.import({ ...input, token: p.token });
  assert.equal(recovered.phase, "ready"); assert.deepEqual(f.f.read("demo").approval, before);
});

test("committed record identities reject rewritten bytes even with recomputed consent", async t => {
  const f = fixture(t), { component, input } = f.imported();
  const approvalPath = join(f.storeRoot, "runner/features/feature/approvals/approval.json"), assignmentPath = join(f.storeRoot, "runner/features/feature/assignments/assignment.json");
  const approval = JSON.parse(readFileSync(approvalPath, "utf8")), assignment = JSON.parse(readFileSync(assignmentPath, "utf8"));
  approval.components.api.settings.maxFixRounds = 99; assignment.settings.maxFixRounds = 99;
  const { stableDigest } = await import("../dist/coordination-state.js");
  approval.consent.token = stableDigest({ value: { manifestFingerprint: approval.manifestFingerprint, contract: approval.contract, components: approval.components, verification: approval.verification } });
  writeFileSync(approvalPath, JSON.stringify(approval)); writeFileSync(assignmentPath, JSON.stringify(assignment)); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Rewrite approved identities");
  await assert.rejects(component.inspect(input), /immutable|introduced|record.*changed/i);
});

test("authoritative first-parent record bytes cover receipts/events/deletions and retain merge imports", async t => {
  for (const kind of ["submission", "event", "deletion"]) await t.test(kind, inner => {
    const f = fixture(inner); f.approve(); f.assign();
    const receipt = { version: 1, kind: "submission", id: "receipt", featureId: "feature", operationId: "op-receipt", createdAt: "2026-10-04T12:00:00Z", assignmentId: "assignment", owner: "alice", repository: "api", change: "demo", outcome: "blocked", reason: "Need credentials", base: git(f.root, "rev-parse", "HEAD"), planFingerprint: f.c.store.readRecord({ kind: "assignment", id: "assignment" }).planFingerprint, contractFingerprint: f.c.store.readRecord({ kind: "assignment", id: "assignment" }).contract.fingerprint, tasks: [{ id: "1.1", completed: false }], verification: [] };
    let path;
    if (kind === "event") {
      f.c.revoke({ assignmentId: "assignment", reason: "Owner changed", id: "revoke", operationId: "op-revoke", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") }); path = join(f.storeRoot, "runner/features/feature/events/revoke.json");
    } else {
      git(f.storeRoot, "switch", "-c", "handoff"); path = join(f.storeRoot, "runner/features/feature/submissions/receipt.json"); mkdirSync(join(path, ".."), { recursive: true });
      const bytes = JSON.stringify(receipt, null, 4) + "\n\n"; writeFileSync(path, bytes); git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Owner handoff"); git(f.storeRoot, "switch", "coordination"); git(f.storeRoot, "merge", "--no-ff", "handoff", "-m", "Import receipt");
      assert.equal(f.c.store.readSnapshot().records.find(record => record.id === "receipt").reason, "Need credentials"); assert.equal(readFileSync(path, "utf8"), bytes);
    }
    if (kind === "deletion") git(f.storeRoot, "rm", path);
    else { const record = JSON.parse(readFileSync(path, "utf8")); record.reason = "Rewritten reason"; writeFileSync(path, JSON.stringify(record)); git(f.storeRoot, "add", "."); }
    git(f.storeRoot, "commit", "-m", "Change immutable record"); assert.throws(() => f.c.store.readSnapshot(), /immutable|introduced|record.*changed|record.*deleted/i);
  });
});

test("separate component binding remains authoritative when feature delegation is removed", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input); await component.import({ ...input, token: p.token });
  const featurePath = join(f.f.repo.stateDir, "features/demo.json"), state = JSON.parse(readFileSync(featurePath, "utf8")); delete state.delegated; state.approval.tasks["1.1"].model = "edited-model"; writeFileSync(featurePath, JSON.stringify(state));
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|delegat/i);
  assert.throws(() => f.f.runner.prompt("demo", { id: "task", task: "1.1", path: join(f.root, "fake"), agent: "codex" }), /binding|delegat/i);
  assert.throws(() => f.f.finalPreview("demo"), /binding|delegat/i); assert.throws(() => f.f.archive("demo"), /binding|delegat/i);
});

test("component runtime binding rejects corrupt identity/token/path fields before execution", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input); await component.import({ ...input, token: p.token });
  const path = join(f.f.repo.stateDir, "components/demo.json"), original = JSON.parse(readFileSync(path, "utf8"));
  for (const patch of [{ token: "a".repeat(64) }, { assignmentId: "wrong" }, { contextPaths: [join(f.dir, "elsewhere")] }, { phase: "unknown" }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|identity|token|context/i);
    assert.throws(() => component.status({ change: "demo" }), /binding|identity|token|context/i);
  }
  writeFileSync(path, JSON.stringify(original));
});

test("local resource previews/imports bind adapters and locations without approved plan edits", async t => {
  const f = fixture(t), { component, input } = f.imported(), resources = { terminal: "auto", worktrees: "auto", worktreeRoot: join(f.dir, "local agent workspaces") };
  executable(join(f.bin, "wt"), `console.log('Worktrunk unavailable in this fixture');`);
  const ordinary = await component.inspect(input), preview = await component.inspect({ ...input, resources });
  assert.notEqual(preview.token, ordinary.token); assert.deepEqual(preview.resources, resources);
  const planBytes = readFileSync(join(f.root, "openspec/runner.yaml"));
  const binding = await component.import({ ...input, resources, token: preview.token }); assert.deepEqual(binding.resources, resources);
  const state = f.f.runner.read("demo"); assert.ok(state.integration.path.startsWith(resources.worktreeRoot + "/"));
  const taskPreview = f.f.runner.preview("demo", ["1.1"]); assert.equal(taskPreview.worktrees, "auto"); assert.equal(taskPreview.terminal, "manual");
  const task = f.f.runner.launch("demo", ["1.1"])[0]; assert.ok(task.path.startsWith(resources.worktreeRoot + "/"));
  assert.deepEqual(readFileSync(join(f.root, "openspec/runner.yaml")), planBytes);
  assert.equal((await component.import({ ...input, resources, token: preview.token })).assignmentId, binding.assignmentId);
  await assert.rejects(component.import({ ...input, resources: { ...resources, terminal: "manual" }, token: preview.token }), /token|resources|reservation/i);
});

test("local resources reject behavior overlays and preserve import recovery locations", async t => {
  const f = fixture(t), { component, input } = f.imported();
  for (const patch of [{ settings: {} }, { setup: [] }, { verifyIntegration: [] }, { tasks: [] }, { model: "other" }, { scope: [] }, { terminal: "invalid" }]) await assert.rejects(component.inspect({ ...input, resources: patch }), /overlay|resource|unknown|adapter/i);
  const resources = { terminal: "manual", worktrees: "git", worktreeRoot: join(f.dir, "recover workspaces") }, p = await component.inspect({ ...input, resources });
  const integration = join(resources.worktreeRoot, "demo-delegated-assignment-integration"); mkdirSync(integration, { recursive: true }); writeFileSync(join(integration, "obstruction"), "Not a Git worktree\n");
  await assert.rejects(component.import({ ...input, resources, token: p.token }), /git|reservation|worktree/i);
  const { rmSync } = await import("node:fs"); rmSync(integration, { recursive: true, force: true });
  const bound = await component.import({ ...input, resources, token: p.token }); assert.equal(bound.phase, "ready"); assert.ok(f.f.runner.read("demo").integration.path.startsWith(resources.worktreeRoot + "/"));
});

test("ready component reservation rejects missing feature state and writable context directories", async t => {
  const f = fixture(t), { component, input } = f.imported(), p = await component.inspect(input), binding = await component.import({ ...input, token: p.token });
  const path = join(f.f.repo.stateDir, "features/demo.json"), original = readFileSync(path);
  const { unlinkSync } = await import("node:fs"); unlinkSync(path);
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /binding|delegat|feature/i); assert.throws(() => f.f.runner.prompt("demo", { id: "task", task: "1.1", path: join(f.root, "fake"), agent: "codex" }), /binding|delegat|feature/i);
  writeFileSync(path, original); chmodSync(binding.contextPaths[0], 0o755);
  assert.throws(() => f.f.runner.preview("demo", ["1.1"]), /pinned|writable|directory/i);
});

test("canonical-only referenced Stores pin specs/config without inventing an active change", async t => {
  const f = fixture(t), upstream = join(f.dir, "canonical upstream"); mkdirSync(upstream); git(upstream, "init", "-b", "main"); git(upstream, "config", "user.name", "Test"); git(upstream, "config", "user.email", "test@example.test"); git(upstream, "config", "openspec-runner.repository", "upstream");
  mkdirSync(join(upstream, "openspec/specs/contracts"), { recursive: true }); writeFileSync(join(upstream, "openspec/specs/contracts/spec.md"), "Canonical linked specification\n"); writeFileSync(join(upstream, "openspec/config.yaml"), "schema: spec-driven\n"); git(upstream, "add", "."); git(upstream, "commit", "-m", "Canonical specs only");
  f.c.repositories.upstream = upstream; f.contract.context.references = [{ storeId: "upstream-store", root: upstream, status: [] }];
  const references = [{ repository: "upstream", root: upstream, storeId: "upstream-store" }], args = { contract: f.contract, references }, p = f.c.approvalPreview(args);
  assert.equal(p.contract.references[0].change, undefined); assert.ok(p.contract.references[0].files.some(file => file.path === "openspec/specs/contracts/spec.md"));
  f.c.approve({ ...args, token: p.token, approvedBy: "user", id: "approval", operationId: "op-approval", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const ap = f.c.assignmentPreview({ ...args, owner: "alice", componentId: "api" }); f.c.assign({ ...args, owner: "alice", componentId: "api", token: ap.token, id: "assignment", operationId: "op-assignment", expectedHead: git(f.storeRoot, "rev-parse", "HEAD") });
  const component = new Component({ root: f.root, repository: "api" }), input = { storeRoot: f.storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }, ip = await component.inspect(input), binding = await component.import({ ...input, token: ip.token });
  assert.equal(readFileSync(join(binding.contextPaths[1], "openspec/specs/contracts/spec.md"), "utf8"), "Canonical linked specification\n");
  writeFileSync(join(upstream, "openspec/specs/contracts/spec.md"), "Updated canonical scope\n"); git(upstream, "add", "."); git(upstream, "commit", "-m", "Changed reference scope");
  assert.throws(() => f.c.assignmentPreview({ ...args, owner: "bob", componentId: "api" }), /approval|drift/i);
});

test("resource overrides apply to delegated review and bounded repair without model changes", async t => {
  const f = fixture(t, { unchecked: false }), { component, input } = f.imported();
  executable(join(f.bin, "wt"), `console.log('Worktrunk unavailable in this fixture');`);
  const resources = { terminal: "auto", worktrees: "auto", worktreeRoot: join(f.dir, "feature job workspaces") }, p = await component.inspect({ ...input, resources });
  await component.import({ ...input, resources, token: p.token });
  process.env.HERDR_ENV = "1"; assert.equal(f.f.jobPreview("demo", "review").terminal, "herdr"); delete process.env.HERDR_ENV;
  f.control({ findings: [blocker] }); const review = await f.review(); assert.ok(review.path.startsWith(resources.worktreeRoot + "/"));
  const repairPreview = f.f.jobPreview("demo", "repair"); assert.equal(repairPreview.worktrees, "auto"); assert.equal(repairPreview.settings.model, "test-model");
  const repair = f.f.launch("demo", "repair"); assert.ok(repair.path.startsWith(resources.worktreeRoot + "/")); await f.f.worker("demo", repair.id);
  assert.equal(f.f.read("demo").fixRounds, 1); assert.equal(f.f.read("demo").approval.maxFixRounds, 2);
});
