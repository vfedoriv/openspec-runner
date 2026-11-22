import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Feature } from "../dist/feature.js";
import { storeFeatureFixture } from "./helpers/store-feature-fixture.mjs";

if (process.platform === "win32" && !process.env.OPENSPEC_TEST_STANDARD_CHILD) {
  test("Copilot Store lifecycle under a standard Windows token", () => {
    const output = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./helpers/standard-windows-child.ps1", import.meta.url))], {
      input: JSON.stringify({ node: process.execPath, args: ["--test", fileURLToPath(import.meta.url)] }), encoding: "utf8", windowsHide: true, timeout: 270000,
    });
    assert.match(output, /Store implementation review and repair/);
  });
} else for (const harness of ["copilot", "copilot-vscode"]) {
  test(`${harness} Store implementation review and repair need no code-local init`, async t => {
    const f = await storeFeatureFixture(t, harness);
    await f.component.import({ ...f.selection, token: f.preview.token });
    const feature = new Feature(f.code, undefined, f.execution), runner = feature.runner;
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const preview = JSON.parse(execFileSync(process.execPath, [entry, "launch", "demo", "--tasks", "1.1", ...runner.storeArgs(), "--dry-run", "--json"], { cwd: f.code, encoding: "utf8" }));
    assert.equal(preview.agent, harness);
    const attempt = runner.launch("demo", ["1.1"])[0];
    const forged = Buffer.from(JSON.stringify({ ...runner.invocationScope("demo").selection, assignmentId: "stale-assignment" })).toString("base64url");
    assert.throws(() => execFileSync(process.execPath, [entry, "hook", "UserPromptSubmit", "--store-scope", forged], { cwd: attempt.path, input: JSON.stringify({ session_id: "forged", cwd: attempt.path, timestamp: new Date().toISOString(), prompt: "forged" }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    const result = await runner.worker("demo", "1.1", attempt.id);
    assert.equal(result.exitCode, 0, readFileSync(result.log, "utf8"));
    assert.ok(runner.read("demo").attempts.at(-1).identityConfirmed);
    runner.integrate("demo", ["1.1"]);
    f.control({ findings: [{ id: "F1", category: "correctness", location: "result.txt:1", impact: "Repair required", correction: "Repair output" }] });
    const review = feature.launch("demo", "review");
    assert.equal((await feature.worker("demo", review.id)).exitCode, 0);
    const repair = feature.launch("demo", "repair");
    assert.equal((await feature.worker("demo", repair.id)).exitCode, 0);
    feature.integrate("demo", repair.id);
    f.control({});
    const finalReview = feature.launch("demo", "review");
    assert.equal((await feature.worker("demo", finalReview.id)).exitCode, 0);
    assert.equal(feature.submissionEvidence({ change: "demo" }).tasks[0].completed, true);
    assert.equal(existsSync(join(f.code, "openspec")), false);
    assert.equal(existsSync(join(f.code, ".github")), false);
    assert.equal(existsSync(join(f.code, ".openspec-runner")), false);
  });
}
