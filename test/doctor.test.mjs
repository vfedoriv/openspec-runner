import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeOrca } from "./helpers/fake-orca.mjs";

const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "runner-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "project"), bin = join(dir, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base");
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH };
  delete env.HERDR_ENV;
  delete env.ORCA_TERMINAL_HANDLE;
  const tool = (name, source) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
    chmodSync(path, 0o755);
  };
  const config = (data, commit = true) => {
    mkdirSync(join(root, "openspec"), { recursive: true });
    writeFileSync(join(root, "openspec/runner.yaml"), JSON.stringify(data));
    if (commit) {
      git("add", "openspec/runner.yaml");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Configure runner");
    }
  };
  const invoke = (...args) => spawnSync(process.execPath, [cli, "doctor", ...args], { cwd: root, encoding: "utf8", env });
  tool("openspec", "if (process.argv[2] !== '--version') process.exit(9); console.log('1.2.3');");
  tool("codex", "if (process.argv.slice(2).join(' ') !== 'exec --help') process.exit(9); console.log('--add-dir --model --cd');");
  return { dir, root, bin, git, config, tool, invoke, env };
}

test("doctor reports project readiness without creating runner resources", t => {
  const f = fixture(t);
  f.config({ version: 1, defaultModel: "model-a", worktrees: "git", terminal: "manual", setup: [["must-not-run"]], verifyIntegration: [["must-not-run"]] });
  const before = f.git("status", "--porcelain");
  const response = f.invoke("--json");
  assert.equal(response.status, 0, response.stderr || response.stdout);
  const report = JSON.parse(response.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.agent, "codex");
  const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
  assert.equal(checks.openspec.status, "ready");
  assert.equal(checks.harness.capabilities.supported, true);
  assert.equal(checks["harness-settings"].status, "ready");
  assert.equal(checks.worktrees.backend, "git");
  assert.equal(checks.terminal.backend, "manual");
  assert.equal(checks.live.status, "unchecked");
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(f.git("worktree", "list").split(/\r?\n/).length, 1);
  assert.equal(existsSync(join(f.root, ".git/openspec-runner")), false);
  assert.equal(existsSync(join(f.root, ".openspec-runner")), false);
  assert.match(f.invoke().stdout, /UNCHECKED.*live/i);
});

test("doctor accumulates independent tool and backend blockers", t => {
  const f = fixture(t);
  f.config({ version: 1, worktrees: "worktrunk", terminal: "herdr" });
  f.tool("openspec", "process.exit(3);");
  f.tool("codex", "console.log('--model');");
  f.tool("git-wt", "console.log('old CLI');");
  f.tool("wt", "console.log('old CLI');");
  const response = f.invoke("--json");
  assert.equal(response.status, 1, response.stderr || response.stdout);
  const report = JSON.parse(response.stdout);
  assert.equal(report.ok, false);
  const blocked = Object.fromEntries(report.checks.filter(check => check.status === "blocked").map(check => [check.id, check.message]));
  assert.match(blocked.openspec, /openspec/i);
  assert.match(blocked.harness, /--add-dir/);
  assert.match(blocked.worktrees, /Worktrunk lacks/);
  assert.match(blocked.terminal, /HERDR_ENV/);
});

test("doctor explains a missing config and honors an explicit harness override", t => {
  const f = fixture(t);
  f.tool("claude", "console.log('unsupported Claude');");
  const response = f.invoke("--agent", "claude", "--json");
  assert.equal(response.status, 1, response.stderr || response.stdout);
  const report = JSON.parse(response.stdout);
  assert.equal(report.agent, "claude");
  assert.match(report.checks.find(check => check.id === "config").message, /openspec-runner init/);
  assert.equal(report.checks.find(check => check.id === "worktrees").status, "unchecked");
  assert.equal(report.checks.find(check => check.id === "harness").capabilities.harness, "claude");
});

test("doctor inspects Orca registration and the runtime without creating resources", t => {
  const f = fixture(t), orca = installFakeOrca(f.dir, f.root, f.bin);
  f.config({ version: 1, worktrees: "orca", terminal: "orca" });
  const response = f.invoke("--json");
  assert.equal(response.status, 0, response.stderr || response.stdout);
  const { checks } = JSON.parse(response.stdout);
  assert.equal(checks.find(check => check.id === "worktrees").backend, "orca");
  assert.equal(checks.find(check => check.id === "terminal").backend, "orca");
  assert.deepEqual(orca.calls(), [["status", "--json"], ["repo", "list", "--json"], ["worktree", "list", "--repo", "id:repo-1", "--json"]]);
  assert.deepEqual(orca.state().worktrees, []);
  assert.deepEqual(orca.state().terminals, []);
  orca.set({ truncated: true });
  const incomplete = f.invoke("--json");
  assert.equal(incomplete.status, 1, incomplete.stderr || incomplete.stdout);
  assert.match(JSON.parse(incomplete.stdout).checks.find(check => check.id === "worktrees").message, /incomplete/);
});

test("doctor checks that required Copilot hooks are committed at the base", t => {
  const f = fixture(t);
  f.config({ version: 2, defaultAgent: "copilot", agents: { copilot: { defaultModel: "session" } }, worktrees: "git", terminal: "manual" });
  f.tool("copilot", "console.log('--model --trust-folder --prompt --add-dir --allow-tool');");
  const hook = ".github/hooks/openspec-runner.json";
  mkdirSync(join(f.root, ".github/hooks"), { recursive: true });
  const commands = [{ type: "command", command: "openspec-runner hook" }];
  writeFileSync(join(f.root, hook), JSON.stringify({ hooks: { userPromptSubmitted: commands, agentStop: commands } }));
  const response = f.invoke("--json");
  assert.equal(response.status, 1, response.stderr || response.stdout);
  const check = JSON.parse(response.stdout).checks.find(item => item.id === "copilot-hooks");
  assert.equal(check.status, "blocked");
  assert.match(check.message, /commit/i);
  f.git("add", hook);
  f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Install hooks");
  const committed = f.invoke("--json");
  assert.equal(committed.status, 0, committed.stderr || committed.stdout);
  const { checks } = JSON.parse(committed.stdout);
  assert.equal(checks.find(item => item.id === "copilot-hooks").status, "ready");
  assert.equal(checks.find(item => item.id === "model-selection").status, "unchecked");
});

test("doctor reports an uncommitted runner config and still probes its backends", t => {
  const f = fixture(t);
  f.config({ version: 1, worktrees: "git", terminal: "manual" }, false);
  const response = f.invoke("--json");
  assert.equal(response.status, 1, response.stderr || response.stdout);
  const { checks } = JSON.parse(response.stdout);
  assert.equal(checks.find(item => item.id === "config-commit").status, "blocked");
  assert.equal(checks.find(item => item.id === "worktrees").status, "ready");
});
