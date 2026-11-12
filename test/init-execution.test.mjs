import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assignmentsFrom, initExecution, tasksFrom } from "../dist/plan.js";

const bin = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
const markdown = "- [x] 1.10 Done\r\n```\r\n- [ ] 9.9 Example\r\n```\r\n- [ ] 1.1 Next\r\n";

function fixture(t, config = "version: 1\n") {
  const root = mkdtempSync(join(tmpdir(), "starter-execution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "openspec", "changes", "demo");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "openspec", "runner.yaml"), config);
  writeFileSync(join(directory, "tasks.md"), markdown);
  return { root, directory };
}

test("starter uses the project default and covers every real checkbox in order", t => {
  for (const [config, agent] of [
    ["version: 1", "codex"],
    ["version: 2\ndefaultAgent: claude\nagents:\n  claude:\n    defaultModel: sonnet", "claude"],
  ]) {
    const { root, directory } = fixture(t, config);
    const result = initExecution(root, "demo", { dryRun: true });
    assert.equal(result.agent, agent);
    assert.deepEqual(result.taskIds, ["1.10", "1.1"]);
    const document = parse(result.yaml);
    assert.equal(document.version, 2);
    assert.equal(document.agent, agent);
    assert.deepEqual(Object.keys(document.tasks), result.taskIds);
    assert.deepEqual(assignmentsFrom(document, tasksFrom(markdown))["1.10"], { dependsOn: [], parallel: false });
    assert.deepEqual(readdirSync(directory), ["tasks.md"]);
    assert.deepEqual(initExecution(root, "demo", { dryRun: true }), result);
  }
});

test("invalid inputs leave the destination untouched", t => {
  const { root, directory } = fixture(t);
  const create = change => initExecution(root, change, { dryRun: false });
  assert.throws(() => create("../demo"), /repository-local change/);
  assert.throws(() => create("missing"), /Missing tasks.md/);
  for (const [input, error] of [
    ["- [ ] Bad", /numbered identifier/],
    ["- [ ] 1.1 First\n- [x] 1.1 Duplicate", /Duplicate/],
    ["# Empty", /No numbered/],
  ]) {
    writeFileSync(join(directory, "tasks.md"), input);
    assert.throws(() => create("demo"), error);
    assert.deepEqual(readdirSync(directory), ["tasks.md"]);
  }
  rmSync(join(root, "openspec", "runner.yaml"));
  assert.throws(() => create("demo"), /openspec-runner init/);
});

test("CLI previews from a nested directory and competing creates preserve one complete file", async t => {
  const { root, directory } = fixture(t);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  const options = { cwd: directory, encoding: "utf8" };
  const cli = (...args) => spawnSync(process.execPath, [bin, "init-execution", ...args], options);
  const preview = cli("demo", "--dry-run", "--json");
  assert.equal(preview.status, 0, preview.stderr);
  const { yaml, created, path } = JSON.parse(preview.stdout);
  assert.equal(created, false);
  assert.equal(path, "openspec/changes/demo/execution.yaml");
  assert.equal(cli("demo", "--dry-run").stdout.replaceAll("\r\n", "\n"), yaml);
  assert.deepEqual(readdirSync(directory), ["tasks.md"]);
  const create = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "init-execution", "demo", "--json"], options);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
  const results = await Promise.all([create(), create()]);
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1]);
  assert.equal(JSON.parse(results.find(result => result.status === 0).stdout).created, true);
  assert.match(results.find(result => result.status === 1).stderr, /already exists/);
  assert.equal(readFileSync(join(directory, "execution.yaml"), "utf8"), yaml);
  assert.deepEqual(readdirSync(directory).sort(), ["execution.yaml", "tasks.md"]);
  assert.equal(cli("demo", "--dry-run", "--json").status, 0);
  assert.match(cli("--help").stdout, /init-execution <change>/);
  for (const args of [[], ["demo", "extra"], ["demo", "--agent", "codex"]])
    assert.equal(cli(...args).status, 1);
});
