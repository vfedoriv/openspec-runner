import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveContext, pinContext, safeContextPath, contextFingerprint } from "../dist/openspec-context.js";

const git = (root, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" }).trim();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runner-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.test");
  for (const [path, content] of Object.entries({
    "planning/changes/shared/proposal.md": "Active contract\n",
    "planning/changes/shared/tasks.md": "- [ ] 1.1 Deliver API\n",
    "planning/specs/auth/spec.md": "Auth contract\n",
    "planning/config.yaml": "schema: spec-driven\n",
    "AGENTS.md": "Store guidance\n",
    "unrelated.md": "Unrelated\n",
  })) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "context");
  return root;
}
function adapter(root, options = {}) {
  return ({ args }) => {
    if (args[0] === "status") return JSON.stringify({
      root: { path: root, source: options.store ? "store" : "nearest", ...(options.store ? { store_id: options.store } : {}) },
      planningHome: { root }, changeRoot: join(root, "planning/changes/shared"),
      artifactPaths: {
        proposal: { outputPath: "proposal.md", resolvedOutputPath: join(root, "planning/changes/shared/proposal.md"), existingOutputPaths: [join(root, "planning/changes/shared/proposal.md")] },
        tasks: { outputPath: "tasks.md", resolvedOutputPath: join(root, "planning/changes/shared/tasks.md"), existingOutputPaths: [join(root, "planning/changes/shared/tasks.md")] },
      },
      actionContext: {},
    });
    if (args[0] === "doctor") return JSON.stringify({ root: { path: root, source: "nearest" }, references: [{ store_id: "upstream", root: "/upstream/store", status: [] }] });
    throw new Error("Unexpected command");
  };
}

test("documented root and doctor references preserve the explicit implementation repository", (t) => {
  const root = fixture(t);
  const context = resolveContext({ cwd: root, change: "shared", store: "team", execute: adapter(root, { store: "team" }) });
  assert.equal(context.implementationRoot, root);
  assert.equal(context.planningRoot, root);
  assert.equal(context.storeId, "team");
  assert.equal(context.changeRoot, join(root, "planning/changes/shared"));
  assert.deepEqual(context.references, [{ storeId: "upstream", root: "/upstream/store", status: [] }]);
});

test("Store selection resolves planning context without routing implementation to Store", (t) => {
  const root = fixture(t), store = fixture(t);
  const context = resolveContext({ cwd: root, change: "shared", store: "team", execute: adapter(store, { store: "team" }) });
  assert.equal(context.implementationRoot, root);
  assert.equal(context.planningRoot, store);
});

test("context members are the documented fallback when doctor lacks references", (t) => {
  const root = fixture(t), original = adapter(root);
  const context = resolveContext({ cwd: root, change: "shared", execute: (request) => {
    if (request.args[0] === "doctor") return JSON.stringify({ root: { path: root, source: "nearest" } });
    if (request.args[0] === "context") return JSON.stringify({ root: { path: root, source: "nearest" }, members: [{ role: "referenced_store", id: "team", path: "/team/store", fetch: "openspec show <spec-id> --type spec --store team", status: [] }] });
    return original(request);
  } });
  assert.equal(context.references[0].storeId, "team");
  assert.equal(context.references[0].root, "/team/store");
});

test("old OpenSpec JSON fails with a capability diagnostic instead of inferring directories", (t) => {
  const root = fixture(t);
  assert.throws(() => resolveContext({ cwd: root, change: "shared", execute: () => '{"artifacts":[]}' }), /OpenSpec.*root.*upgrade/i);
});

for (const field of ["changeRoot", "artifactPaths"]) {
  test(`missing documented ${field} produces an actionable capability diagnostic`, (t) => {
    const root = fixture(t), original = adapter(root);
    const execute = (request) => {
      const output = original(request);
      if (request.args[0] !== "status") return output;
      const status = JSON.parse(output); delete status[field];
      return JSON.stringify(status);
    };
    assert.throws(() => resolveContext({ cwd: root, change: "shared", execute }), (error) => {
      assert.match(error.message, new RegExp(`OpenSpec.*${field}.*upgrade`, "i"));
      assert.match(error.message, /openspec status.*--json/);
      return true;
    });
  });
}

test("empty artifactPaths and empty optional artifact outputs remain valid", (t) => {
  const root = fixture(t), original = adapter(root);
  for (const artifactPaths of [{}, { optional: { outputPath: "design.md", resolvedOutputPath: join(root, "planning/changes/shared/design.md"), existingOutputPaths: [] } }]) {
    const execute = (request) => {
      const output = original(request);
      if (request.args[0] !== "status") return output;
      const status = JSON.parse(output); status.artifactPaths = artifactPaths;
      return JSON.stringify(status);
    };
    assert.deepEqual(resolveContext({ cwd: root, change: "shared", execute }).artifactPaths, []);
  }
});

test("artifactPaths pins concrete existing outputs instead of glob patterns or missing artifacts", (t) => {
  const root = fixture(t), original = adapter(root);
  const context = resolveContext({ cwd: root, change: "shared", execute: (request) => {
    const output = original(request);
    if (request.args[0] !== "status") return output;
    const status = JSON.parse(output);
    status.artifactPaths.specs = { outputPath: "specs/**/*.md", resolvedOutputPath: join(root, "planning/changes/shared/specs/**/*.md"), existingOutputPaths: [join(root, "planning/specs/auth/spec.md")] };
    status.artifactPaths.design = { outputPath: "design.md", resolvedOutputPath: join(root, "planning/changes/shared/design.md"), existingOutputPaths: [] };
    return JSON.stringify(status);
  } });
  assert.deepEqual(context.artifactPaths, [join(root, "planning/changes/shared/proposal.md"), join(root, "planning/changes/shared/tasks.md"), join(root, "planning/specs/auth/spec.md")]);
  assert.equal(pinContext({ context, repository: "store", revision: git(root, "rev-parse", "HEAD") }).files.some(file => file.path === "planning/specs/auth/spec.md"), true);
});

test("portable context paths reject Windows absolute and drive-relative paths on Linux", () => {
  for (const path of ["C:/outside/file", "C:outside/file", "c:\\outside\\file", "//server/share/file", "/outside/file"]) {
    assert.throws(() => safeContextPath(path), /path/i);
  }
  assert.equal(safeContextPath("inside/file.md"), "inside/file.md");
});

test("fingerprints distinguish embedded NUL content from additional context files", () => {
  const one = [{ path: "a", content: "b\0c\0d" }];
  const two = [{ path: "a", content: "b" }, { path: "c", content: "d" }];
  assert.notEqual(contextFingerprint({ files: one }), contextFingerprint({ files: two }));
});

test("pinning preserves committed UTF-8 BOM bytes in portable file contents", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "planning/changes/shared/proposal.md"), Buffer.from("\ufeffActive contract\n", "utf8"));
  git(root, "add", "."); git(root, "commit", "-m", "BOM contract");
  const context = resolveContext({ cwd: root, change: "shared", execute: adapter(root) });
  const pinned = pinContext({ context, repository: "store", revision: git(root, "rev-parse", "HEAD") });
  assert.deepEqual(Buffer.from(pinned.files.find(file => file.path.endsWith("proposal.md")).content, "utf8"), Buffer.from("\ufeffActive contract\n", "utf8"));
});

test("ancestor context selections exclude expanded coordination records from fingerprints", (t) => {
  const root = fixture(t), context = resolveContext({ cwd: root, change: "shared", execute: adapter(root) });
  mkdirSync(join(root, "runner/features/feature"), { recursive: true });
  writeFileSync(join(root, "runner/guidance.md"), "Approved runner guidance\n");
  writeFileSync(join(root, "runner/features/feature/manifest.yaml"), "version: 1\n");
  git(root, "add", "."); git(root, "commit", "-m", "guidance and coordination record");
  const pin = () => pinContext({ context, repository: "store", revision: git(root, "rev-parse", "HEAD"), relevantPaths: ["runner"] });
  const before = pin();
  assert.equal(before.files.some(file => file.path.startsWith("runner/features/")), false);
  assert.equal(before.files.find(file => file.path === "runner/guidance.md").content, "Approved runner guidance\n");
  writeFileSync(join(root, "runner/features/feature/manifest.yaml"), "version: 1\nstatus: changed\n");
  git(root, "add", "."); git(root, "commit", "-m", "growing coordination history");
  assert.equal(pin().fingerprint, before.fingerprint);
});

test("pinning includes active contract and relevant specs/config/guidance from exact committed revision", (t) => {
  const root = fixture(t), revision = git(root, "rev-parse", "HEAD");
  const context = resolveContext({ cwd: root, change: "shared", execute: adapter(root) });
  writeFileSync(join(root, "planning/changes/shared/proposal.md"), "Uncommitted drift\n");
  const pinned = pinContext({ context, repository: "https://example.test/team/store.git", revision, relevantPaths: ["planning/specs/auth", "planning/config.yaml", "AGENTS.md"] });
  assert.equal(pinned.revision, revision);
  assert.match(pinned.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(pinned.files.find((f) => f.path.endsWith("proposal.md")).content, "Active contract\n");
  assert.deepEqual(pinned.files.map((f) => f.path), ["AGENTS.md", "planning/changes/shared/proposal.md", "planning/changes/shared/tasks.md", "planning/config.yaml", "planning/specs/auth/spec.md"]);
  assert.equal(JSON.stringify(pinned).includes(root), false);
});

test("fingerprints normalize task checkboxes and ignore unrelated Store commits", (t) => {
  const root = fixture(t), context = resolveContext({ cwd: root, change: "shared", execute: adapter(root) });
  const pin = () => pinContext({ context, repository: "store", revision: git(root, "rev-parse", "HEAD"), relevantPaths: ["planning/specs/auth", "planning/config.yaml", "AGENTS.md"] });
  const first = pin();
  writeFileSync(join(root, "unrelated.md"), "Later\n");
  writeFileSync(join(root, "planning/changes/shared/tasks.md"), "- [x] 1.1 Deliver API\n");
  git(root, "add", "."); git(root, "commit", "-m", "unrelated and completion");
  assert.equal(pin().fingerprint, first.fingerprint);
  writeFileSync(join(root, "planning/specs/auth/spec.md"), "Changed API contract\n");
  git(root, "add", "."); git(root, "commit", "-m", "relevant");
  assert.notEqual(pin().fingerprint, first.fingerprint);
});

test("pinning rejects shorthand revisions, outside paths and committed symlinks", (t) => {
  const root = fixture(t), context = resolveContext({ cwd: root, change: "shared", execute: adapter(root) });
  const args = { context, repository: "store", revision: git(root, "rev-parse", "HEAD") };
  assert.throws(() => pinContext({ ...args, revision: "HEAD" }), /full.*revision/i);
  assert.throws(() => pinContext({ ...args, relevantPaths: ["../escape"] }), /path/i);
  git(root, "update-index", "--add", "--cacheinfo", "120000", git(root, "hash-object", "-w", "AGENTS.md"), "planning/changes/shared/link");
  git(root, "commit", "-m", "symlink");
  assert.throws(() => pinContext({ ...args, revision: git(root, "rev-parse", "HEAD") }), /symlink/i);
});

test("pinned selections preserve portable directory scope and bind fingerprints independently of current files", async t => {
  const root = fixture(t), context = resolveContext({ cwd: root, change: "shared", execute: adapter(root) }), revision = git(root, "rev-parse", "HEAD");
  const directory = pinContext({ context, repository: "store", revision, relevantPaths: ["planning/specs/auth"] });
  const files = pinContext({ context, repository: "store", revision, relevantPaths: ["planning/specs/auth/spec.md"] });
  assert.deepEqual(directory.selections, ["planning/changes/shared", "planning/specs/auth"]);
  assert.deepEqual(directory.files, files.files); assert.notEqual(directory.fingerprint, files.fingerprint);
  const { decodePinnedContext } = await import("../dist/coordination-state.js");
  assert.deepEqual(decodePinnedContext({ value: directory }), directory);
  const unsafe = { ...directory, selections: ["../outside"] }; assert.throws(() => decodePinnedContext({ value: unsafe }), /unsafe|selection/i);
  const duplicate = { ...directory, selections: [...directory.selections, directory.selections[0]] }; assert.throws(() => decodePinnedContext({ value: duplicate }), /duplicate|selection/i);
  const tampered = { ...directory, selections: files.selections }; assert.throws(() => decodePinnedContext({ value: tampered }), /fingerprint/i);
  const { selections, ...legacy } = directory; legacy.fingerprint = contextFingerprint({ files: legacy.files });
  assert.deepEqual(decodePinnedContext({ value: legacy }), legacy);
});
