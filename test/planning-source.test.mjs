import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, symlinkSync, renameSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { git, storePlanningFixture } from "./helpers/store-planning-fixture.mjs";
import { loadPlan } from "../dist/plan.js";
import { loadSourcePlan, pinStorePlan } from "../dist/planning-source.js";
import * as planning from "../dist/planning-source.js";

test("local planning source preserves the complete existing plan", t => {
  const f = storePlanningFixture(t), root = join(f.storeRoot, "components/api");
  assert.deepEqual(loadSourcePlan({ kind: "local", root, change: "demo" }), loadPlan(root, "demo"));
});

test("Store sources load each component's approved configuration, tasks, specs and guidance from Git", t => {
  const f = storePlanningFixture(t);
  f.write("components/api/openspec/runner.yaml", "invalid: tree\n");
  f.write("components/api/guidance.md", "dirty checkout\n");
  for (const component of ["api", "web"]) {
    const source = pinStorePlan(f.input(component));
    const plan = loadSourcePlan(JSON.parse(JSON.stringify(source)));
    assert.equal(plan.config.defaultModel, component);
    assert.equal(plan.tasks[0].description, "Deliver change");
    assert.equal(plan.fingerprint, source.fingerprint);
    assert.ok(source.files.every(file => file.path.startsWith(`components/${component}/`)));
    assert.ok(source.files.some(file => file.path.endsWith("/specs/contract/spec.md")));
    assert.equal(source.files.find(file => file.path.endsWith("/guidance.md")).content, "\ufeffRules\r\n");
    assert.equal(JSON.stringify(source).includes(f.storeRoot.replaceAll("\\", "\\\\")), false);
    const tampered = structuredClone(source);
    tampered.files.find(file => file.path.endsWith("/runner.yaml")).content += "\n";
    assert.throws(() => loadSourcePlan(tampered), /fingerprint/i);
    assert.throws(() => loadSourcePlan({ ...source, checkout: f.code }), /field/i);
    const extendedFile = structuredClone(source);
    extendedFile.files[0].absolutePath = f.code;
    assert.throws(() => loadSourcePlan(extendedFile), /field/i);
  }
  assert.equal(existsSync(join(f.code, "openspec")), false);
});

test("only approved numbered task completion and unrelated Store commits are excluded from plan drift", t => {
  const f = storePlanningFixture(t);
  const pin = () => pinStorePlan({ ...f.input(), revision: git(f.storeRoot, "rev-parse", "HEAD") });
  const original = pin();
  f.write("components/web/guidance.md", "new web guidance\n");
  f.write("components/api/openspec/changes/demo/tasks.md", "- [x] 1.1 Deliver change\n");
  git(f.storeRoot, "commit", "-am", "Accept API progress");
  assert.equal(pin().fingerprint, original.fingerprint);
  assert.equal(loadSourcePlan(pin()).tasks[0].completed, true);
  f.write("components/api/guidance.md", "new api guidance\n");
  git(f.storeRoot, "commit", "-am", "Change API rules");
  assert.notEqual(pin().fingerprint, original.fingerprint);
});

test("readiness validates the component at its pinned revision and rejects dirty approval inputs", t => {
  const f = storePlanningFixture(t), input = f.input(), source = pinStorePlan(input);
  const validate = (execute = input.execute) => planning.validateStorePlanReadiness({ storeRoot: f.storeRoot, source, execute });
  assert.doesNotThrow(() => validate());
  assert.throws(() => validate(request => request.args[0] === "instructions" ? '{"state":"blocked"}' : input.execute(request)), /not ready/i);
  f.write("components/web/guidance.md", "unrelated dirty plan\n");
  assert.doesNotThrow(() => validate());
  f.write("components/api/openspec/changes/demo/untracked.md", "unapproved artifact\n");
  assert.throws(() => validate(), /committed|dirty|revision/i);
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Later plan");
  assert.throws(() => validate(), /committed|dirty|revision/i);
});

test("Store source rejects unsafe roots, mismatched identity, missing capabilities, and redirected planning projects", t => {
  const f = storePlanningFixture(t), input = f.input();
  for (const openspecRoot of ["../openspec", "components/api/../web/openspec", "openspec", "components/.git/openspec"])
    assert.throws(() => pinStorePlan({ ...input, openspecRoot }), /root|path/i);
  assert.throws(() => pinStorePlan({ ...input, repository: "other" }), /identity/i);
  assert.throws(() => pinStorePlan({ ...input, revision: "HEAD" }), /revision/i);
  assert.throws(() => pinStorePlan({ ...input, execute: () => "{}" }), /capability/i);
  assert.throws(() => pinStorePlan({ ...input, execute: request => {
    const result = JSON.parse(input.execute(request));
    if (request.args[0] === "status") result.root.path = f.code;
    return JSON.stringify(result);
  } }), /root/i);
  assert.throws(() => pinStorePlan({ ...input, execute: request => {
    const result = JSON.parse(input.execute(request));
    if (request.args[0] === "status") result.changeRoot = "openspec/changes/other";
    return JSON.stringify(result);
  } }), /root/i);
  const actual = join(f.storeRoot, "components/api"), moved = join(f.dir, "outside");
  renameSync(actual, moved); symlinkSync(moved, actual, "junction");
  assert.throws(() => pinStorePlan(input), /redirect|symlink/i);
});

test("Store configuration cannot reference escaping, missing or committed symlink supplements", t => {
  const f = storePlanningFixture(t);
  const root = "components/api";
  const pin = () => pinStorePlan({ ...f.input(), revision: git(f.storeRoot, "rev-parse", "HEAD") });
  for (const path of ["../web/guidance.md", "missing.md", "link.md"]) {
    f.write(`${root}/openspec/runner.yaml`, JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "session", planningRules: path } } }));
    git(f.storeRoot, "add", ".");
    if (path === "link.md") git(f.storeRoot, "update-index", "--add", "--cacheinfo", "120000", git(f.storeRoot, "hash-object", "-w", `${root}/guidance.md`), `${root}/link.md`);
    git(f.storeRoot, "commit", "-m", "Configure supplement");
    assert.throws(pin, /path|missing|symlink|supplement/i);
  }
});

test("discovery and validation read the approved component even during transient edits to the Store checkout", t => {
  const f = storePlanningFixture(t), input = f.input();
  const path = "openspec/changes/demo/tasks.md", live = "components/api/" + path;
  const original = readFileSync(join(f.storeRoot, live), "utf8");
  const observed = new Set();
  const execute = request => {
    f.write(live, "- [x] 1.1 Transient change\n");
    try {
      assert.equal(readFileSync(join(request.cwd, path), "utf8"), original);
      assert.equal(relative(f.storeRoot, request.cwd).split(sep)[0], ".openspec-runner");
      observed.add(request.args[0]);
      return input.execute(request);
    } finally { f.write(live, original); }
  };
  const source = pinStorePlan({ ...input, execute });
  assert.equal(existsSync(join(f.storeRoot, ".openspec-runner")), false);
  planning.validateStorePlanReadiness({ source, storeRoot: f.storeRoot, execute });
  assert.deepEqual([...observed].sort(), ["doctor", "instructions", "status", "validate"]);
  assert.equal(existsSync(join(f.storeRoot, ".openspec-runner")), false);
  assert.throws(() => pinStorePlan({ ...input, execute: () => "{}" }), /capability/i);
  assert.equal(existsSync(join(f.storeRoot, ".openspec-runner")), false);
  const blocked = request => request.args[0] === "instructions" ? '{"state":"blocked"}' : input.execute(request);
  assert.throws(() => planning.validateStorePlanReadiness({ source, storeRoot: f.storeRoot, execute: blocked }), /not ready/i);
  assert.equal(existsSync(join(f.storeRoot, ".openspec-runner")), false);
  f.write(".openspec-runner/keep", "existing state");
  pinStorePlan(input);
  assert.throws(() => planning.validateStorePlanReadiness({ source, storeRoot: f.storeRoot, execute: blocked }), /not ready/i);
  assert.deepEqual(readdirSync(join(f.storeRoot, ".openspec-runner")), ["keep"]);
  assert.equal(readFileSync(join(f.storeRoot, ".openspec-runner/keep"), "utf8"), "existing state");
});

test("portable plans reject case aliases and file/directory conflicts in Git and in received inventories", t => {
  const f = storePlanningFixture(t), input = f.input(), original = pinStorePlan(input);
  const prefix = "components/api/openspec/changes/demo/";
  const object = git(f.storeRoot, "hash-object", "-w", prefix + "tasks.md");
  for (const pair of [["Spec.md", "spec.md"], ["Rules", "rules/guide.md"]]) {
    const files = pair.map(name => ({ path: prefix + name, content: "guide\n" }));
    assert.throws(() => loadSourcePlan({ ...original, files: [...original.files, ...files] }), /conflict|case|collision/i);
    for (const file of files)
      git(f.storeRoot, "-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", "100644", object, file.path);
    git(f.storeRoot, "commit", "-m", "Add conflicting files");
    assert.throws(() => pinStorePlan({ ...input, revision: git(f.storeRoot, "rev-parse", "HEAD") }), /conflict|case|collision/i);
    for (const file of files)
      git(f.storeRoot, "-c", "core.ignorecase=false", "update-index", "--force-remove", "--", file.path);
  }
});

test("Store-only readiness rejects a local source before reading its supplied root", () => {
  const source = { kind: "local", root: "does-not-exist", change: "demo" };
  assert.throws(() => planning.validateStorePlanReadiness({ storeRoot: "absent", source,
    execute: () => assert.fail("unexpected OpenSpec invocation") }), /Store planning source/i);
});

test("a committed component can be pinned after its live directory has moved", t => {
  const f = storePlanningFixture(t);
  renameSync(join(f.storeRoot, "components/api"), join(f.storeRoot, "components/renamed"));
  const source = pinStorePlan(f.input());
  assert.equal(loadSourcePlan(source).config.defaultModel, "api");
  assert.equal(existsSync(join(f.storeRoot, "components/api")), false);
});
