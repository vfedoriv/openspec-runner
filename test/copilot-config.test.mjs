import { test } from "node:test";
import assert from "node:assert/strict";
import { getHarness, harnessIds } from "../dist/harnesses/registry.js";
import { configFrom } from "../dist/plan.js";
import { init } from "../dist/cli.js";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
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
test("CLI starts a trusted prompt session and resumes only its observed identity", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const cli = getHarness("copilot"), editor = getHarness("copilot-vscode");
  const invocation = cli.initialInvocation({ model: "model" }, "/work with spaces", "/git common", "Unicode ✓ prompt", uuid);
  assert.equal(invocation.cwd, "/work with spaces");
  assert.equal(invocation.args.includes("--session-id"), false);
  assert.equal(cli.lifecycle.reservedSession, false);
  assert.ok(invocation.args.includes("--trust-folder"));
  assert.equal(invocation.args[invocation.args.indexOf("-p") + 1], "Unicode \u2713 prompt");
  assert.deepEqual(cli.resumeInvocation({ model: "model" }, "/work", "/common", uuid).args, ["--resume", uuid, "--model", "model"]);
  assert.equal(invocation.args.includes("--allow-all"), false);
  assert.equal(invocation.stdin, undefined);
  assert.ok(invocation.args.some(arg => arg.replaceAll("\\", "/").endsWith("/reports")));
  assert.throws(() => editor.resumeInvocation({ model: "model" }, "/work", "/common", uuid), /exact.*resume|resume.*unsupported/i);
});

test("editor task submission targets cwd without empty-window or last-window routing", () => {
  const editor = getHarness("copilot-vscode");
  const invocation = editor.initialInvocation({ model: "model", options: { profile: "Workers" } }, "/assigned worktree", "/common", "task prompt", "worker-agent");
  assert.equal(invocation.cwd, "/assigned worktree");
  assert.deepEqual(invocation.args, ["chat", "--mode", "worker-agent", "task prompt"]);
});

test("editor preparation clears inherited Ask mode before selecting the worker without inference", async () => {
  const editor = await import("../dist/harnesses/copilot-editor.js");
  assert.equal(typeof editor.editorPreparationCommands, "function");
  const commands = editor.editorPreparationCommands({ model: "model", options: { profile: "Workers" } }, "/assigned worktree", "worker-agent");
  assert.deepEqual(commands.map(command => command.args), [
    ["/assigned worktree", "--profile", "Workers"],
    ["chat", "--mode", "agent"],
    ["chat", "--mode", "worker-agent"],
  ]);
  assert.ok(commands.every(command => command.cwd === "/assigned worktree" && command.stdin === undefined));
});


test("CLI capability checks require prompt trust but not a reserved session flag", async t => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-capabilities-"));
  const old = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${old}`;
  t.after(() => { process.env.PATH = old; rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "copilot");
  const install = help => { writeFileSync(path, `#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? '1.0.105' : ${JSON.stringify(help)});`); chmodSync(path, 0o755); };
  install("--model --trust-folder --prompt --add-dir --allow-tool --resume");
  assert.equal((await getHarness("copilot").capabilities(dir)).supported, true);
  assert.equal((await getHarness("copilot").capabilities(dir)).features.exactResume, true);
  install("--model --trust-folder --prompt --add-dir --allow-tool");
  assert.equal((await getHarness("copilot").capabilities(dir)).supported, true);
  assert.equal((await getHarness("copilot").capabilities(dir)).features.exactResume, false);
  install("--model --session-id --add-dir --allow-tool");
  const missing = await getHarness("copilot").capabilities(dir);
  assert.equal(missing.supported, false);
  assert.ok(missing.reasons.some(reason => reason.includes("--trust-folder")));
});
