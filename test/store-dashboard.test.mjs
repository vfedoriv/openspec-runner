import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./helpers/store-planning-fixture.mjs";
import { executable } from "./helpers/feature-fixture.mjs";
import { runDashboardAction } from "../dist/dashboard-action-runner.js";
import { collectDashboard } from "../dist/dashboard-reader.js";
import { actionsFor, previewCommand } from "../dist/dashboard-actions.js";
import { storeFeatureFixture } from "./helpers/store-feature-fixture.mjs";

if (process.platform === "win32" && !process.env.OPENSPEC_TEST_STANDARD_CHILD) {
  test("Store dashboard in a standard Windows session", () => {
    let output;
    try { output = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./helpers/standard-windows-child.ps1", import.meta.url))], {
      input: JSON.stringify({ node: process.execPath, args: ["--test", fileURLToPath(import.meta.url)] }), encoding: "utf8", windowsHide: true, timeout: 120000,
    }); } catch (error) { throw new Error(error.stdout || error.stderr || error.message); }
    assert.match(output, /dashboard reads pinned Store/);
  });
} else {
  test("dashboard reads pinned Store tasks and emits scoped execution actions", async t => {
    const f = await storeFeatureFixture(t); await f.component.import({ ...f.selection, token: f.preview.token });
    const snapshot = collectDashboard({ cwd: f.code, change: "demo", execution: f.execution });
    assert.equal(snapshot.setup.configuration, "ready"); assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.features[0].executionScope.component, "api");
    assert.ok(snapshot.features[0].nextAction.launch.includes("--store"));
    const launch = actionsFor(snapshot, snapshot.tasks[0].id).find(action => action.id.endsWith(":launch-command"));
    assert.ok(launch?.argv.includes("--store"));
    const preview = actionsFor(snapshot, snapshot.tasks[0].id).find(action => action.id.endsWith(":launch-preview"));
    assert.ok(previewCommand(snapshot, preview, { taskIds: ["1.1"] }).includes("--store"));
    const action = actionsFor(snapshot, snapshot.tasks[0].id).find(action => action.id.endsWith(":launch-run"));
    const prepared = await runDashboardAction({ snapshot, action, input: { taskIds: ["1.1"] }, signal: new AbortController().signal });
    assert.ok(prepared.confirmation); assert.match(prepared.text, /--store/);
    const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const status = JSON.parse(execFileSync(process.execPath, [cli, "component", "status", "product", "--store", f.storeRoot, "--repository", "api", "--component", "api", "--change", "demo", "--json"], { cwd: f.code, encoding: "utf8" }));
    assert.equal(status.imported, true);
    const map = join(f.dir, "map.json"); writeFileSync(map, JSON.stringify({ contracts: f.storeRoot, api: f.code }));
    const mapped = collectDashboard({ cwd: f.code, store: f.storeRoot, map });
    assert.equal(mapped.tasks.length, 1); assert.equal(mapped.setup.configuration, "ready");
    f.write("components/api/openspec/changes/demo/tasks.md", "- [ ] 1.1 Changed requirement\n");
    git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Change selected component plan");
    const drifted = collectDashboard({ cwd: f.code, change: "demo", execution: f.execution });
    assert.ok(drifted.tasks[0].reasons.some(reason => /Store planning drift/i.test(reason)));
    executable(join(f.bin, "openspec"), "console.log('test-openspec');");
    let diagnostic;
    try { diagnostic = execFileSync(process.execPath, [cli, "doctor", "--store", f.storeRoot, "--feature", "product", "--component", "api", "--assignment", "assignment", "--change", "demo", "--json"], { cwd: f.code, encoding: "utf8" }); }
    catch (error) { diagnostic = error.stdout; }
    assert.equal(JSON.parse(diagnostic).checks.find(check => check.id === "assignment")?.status, "blocked");
  });
}
