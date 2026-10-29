import { test } from "node:test";
import assert from "node:assert/strict";
import { getHarness, harnessIds } from "../dist/harnesses/registry.js";
import { configFrom } from "../dist/plan.js";
import { init } from "../dist/cli.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
test("Copilot init requires a real model, shares skills, and preserves existing configuration", t => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", dir], { stdio: "ignore" });
  assert.throws(() => init(dir, "copilot"), /model/i);
  const result = init(dir, "copilot", undefined, "cli-model");
  assert.equal(result.agents[0], "copilot");
  assert.equal(result.skills.length, 8);
  assert.ok(existsSync(join(dir, ".github/hooks/openspec-runner.json")));
  assert.ok(JSON.parse(readFileSync(join(dir, ".github/hooks/openspec-runner.json"), "utf8")).hooks.ErrorOccurred);
  const saved = readFileSync(join(dir, "openspec/runner.yaml"), "utf8");
  assert.equal(configFrom((awaitYaml(saved))).defaultAgent, "copilot");
  const all = init(dir, "all");
  assert.equal(all.skills.length, 24);
  assert.equal(readFileSync(join(dir, "openspec/runner.yaml"), "utf8"), saved);
});
import { parse as awaitYaml } from "yaml";
test("Copilot adapters preserve surface model selectors and reject session inheritance and effort", () => {
  assert.ok(harnessIds().includes("copilot"));
  assert.ok(harnessIds().includes("copilot-vscode"));
  for (const id of ["copilot", "copilot-vscode"]) {
    const a = getHarness(id), assignment = { parallel: false, dependsOn: [] };
    const settings = a.resolveSettings(assignment, undefined, { defaultModel: "Editor model (Provider)", options: { startupTimeoutMs: 1000 } });
    assert.equal(settings.model, "Editor model (Provider)");
    assert.equal(settings.options.startupTimeoutMs, 1000);
    assert.throws(() => a.resolveSettings({ ...assignment, model: "session" }), /session|model/i);
    assert.throws(() => a.resolveSettings({ ...assignment, model: "model", effort: "high" }), /effort/i);
    assert.throws(() => a.resolveSettings(assignment, undefined, { defaultModel: "model", options: { arbitrary: true } }), /option/i);
    assert.equal(configFrom({ version: 2, defaultAgent: id, agents: { [id]: { defaultModel: "model", options: { startupTimeoutMs: 1000 } } } }).agents[id].options.startupTimeoutMs, 1000);
  }
});
test("CLI invocation uses exact UUID and editor never offers fictional chat resume", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const cli = getHarness("copilot"), editor = getHarness("copilot-vscode");
  const invocation = cli.initialInvocation({ model: "model" }, "/work with spaces", "/git common", "Unicode ✓ prompt", uuid);
  assert.equal(invocation.cwd, "/work with spaces");
  assert.equal(invocation.args[invocation.args.indexOf("--session-id") + 1], uuid);
  assert.equal(invocation.args.includes("--allow-all"), false);
  assert.equal(invocation.stdin, "Unicode ✓ prompt");
  assert.ok(invocation.args.some(arg => arg.replaceAll("\\", "/").endsWith("/reports")));
  assert.throws(() => editor.resumeInvocation({ model: "model" }, "/work", "/common", uuid), /exact.*resume|resume.*unsupported/i);
});
