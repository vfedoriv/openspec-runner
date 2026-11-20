import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, delimiter } from "node:path";
import { executable } from "./helpers/feature-fixture.mjs";
import { initStore } from "../dist/store-setup.js";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";
import { editExecutionSettings } from "../dist/execution-settings.js";

test("Store setup creates configuration exclusively in declared Store projects", t => {
  const f = storePlanningFixture(t), role = { harness: "codex", model: "api", effort: "low" };
  rmSync(join(f.storeRoot, "components/api/openspec/runner.yaml"));
  const manifest = { version: 2, featureId: "product", storeId: "team", sharedChange: "shared", coordinationBranch: "main",
    components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [], planning: { repository: "contracts", openspecRoot: "components/api/openspec" },
      settings: { implementation: role, tasks: {}, review: { ...role, model: "review" }, repair: { ...role, model: "repair" }, maxFixRounds: 2, setup: [], verifyIntegration: [["node", "--version"]] } } },
    taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  const result = initStore({ storeRoot: f.storeRoot, manifest });
  assert.equal(result.projects.length, 2);
  assert.match(readFileSync(join(f.storeRoot, "components/api/openspec/runner.yaml"), "utf8"), /verifyIntegration/);
  assert.match(readFileSync(join(f.storeRoot, "components/api/openspec/runner.yaml"), "utf8"), /defaultModel: api/);
  assert.equal(existsSync(join(f.storeRoot, "openspec/runner.yaml")), true);
  assert.equal(existsSync(join(f.code, "openspec")), false);
  assert.equal(existsSync(join(f.code, ".agents")), false);
  assert.equal(initStore({ storeRoot: f.storeRoot, manifest }).projects.every(project => !project.created), true);
  assert.throws(() => initStore({ storeRoot: f.storeRoot, manifest: { ...manifest, version: 1 } }), /version|Store|planning/i);
  const input = join(f.dir, "manifest.json"); writeFileSync(input, JSON.stringify(manifest));
  const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "init", "--store", f.storeRoot, "--file", input, "--json"], { cwd: f.code, encoding: "utf8" });
  assert.equal(JSON.parse(output).projects.length, 2);
  const executionPath = join(f.storeRoot, "components/api/openspec/changes/demo/execution.yaml"); rmSync(executionPath);
  const starterArgs = [cli, "init-execution", "demo", "--store", f.storeRoot, "--component", "api", "--json"];
  const starter = JSON.parse(execFileSync(process.execPath, [...starterArgs, "--dry-run"], { cwd: f.code, encoding: "utf8" }));
  assert.deepEqual(starter.taskIds, ["1.1"]); assert.equal(existsSync(executionPath), false);
  execFileSync(process.execPath, starterArgs, { cwd: f.code, encoding: "utf8" }); assert.equal(existsSync(executionPath), true);
  const rules = execFileSync(process.execPath, [cli, "planning-rules", "--agent", "codex", "--store", f.storeRoot, "--component", "api", "--json"], { cwd: f.code, encoding: "utf8" });
  assert.match(rules, /codex/i);
  const patch = join(f.dir, "settings.json"); writeFileSync(patch, JSON.stringify({ tasks: [{ id: "1.1", model: "override", effort: "low" }] }));
  const settingsArgs = [cli, "execution-settings", "demo", "--store", f.storeRoot, "--component", "api", "--file", patch, "--json"];
  const settings = JSON.parse(execFileSync(process.execPath, [...settingsArgs, "--dry-run"], { cwd: f.code, encoding: "utf8" }));
  assert.equal(settings.applied, false); assert.doesNotMatch(readFileSync(executionPath, "utf8"), /override/);
  execFileSync(process.execPath, [...settingsArgs, "--confirm", settings.token], { cwd: f.code, encoding: "utf8" });
  assert.match(readFileSync(executionPath, "utf8"), /override/);
  const configPath = join(f.storeRoot, "components/api/openspec/runner.yaml");
  writeFileSync(configPath, JSON.stringify({ version: 2, defaultAgent: "codex", agents: { codex: { defaultModel: "api" } }, worktrees: "git", terminal: "manual" }));
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Configure Store project");
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  executable(join(bin, "openspec"), "console.log('1.2.3');");
  executable(join(bin, "codex"), "console.log('--add-dir --model --cd --json');");
  const doctor = spawnSync(process.execPath, [cli, "doctor", "--store", f.storeRoot, "--component", "api", "--json"], { cwd: f.code, encoding: "utf8", env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const diagnosis = JSON.parse(doctor.stdout);
  assert.equal(diagnosis.checks.find(check => check.id === "config").status, "ready");
  assert.equal(diagnosis.planningRoot, join(f.storeRoot, "components/api"));
  const outside = join(f.dir, "outside"); cpSync(join(f.storeRoot, "components/api"), outside, { recursive: true });
  assert.throws(() => editExecutionSettings("demo", { tasks: [{ id: "1.1", model: "other" }] }, undefined, f.storeRoot, outside), /Store.*root|planning.*root/i);
  assert.equal(existsSync(join(f.code, "openspec")), false);
});
