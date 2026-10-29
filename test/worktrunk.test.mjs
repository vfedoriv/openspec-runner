import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { createWorktree } from "../dist/adapters.js";
import { resolveCommand } from "../dist/platform-command.js";
let tool;
for (const candidate of process.platform === "win32" ? ["git-wt"] : ["git-wt", "wt"]) {
  try {
    const command = resolveCommand({ executable: candidate, args: ["--version"], cwd: process.cwd() });
    if (/\bwt v/.test(execFileSync(command.executable, command.args, { env: command.env, encoding: "utf8", timeout: 5000 }))) {
      const executable = process.platform === "win32" ? command.executable : execFileSync("which", [candidate], { encoding: "utf8" }).trim();
      tool = { ...command, executable }; break;
    }
  } catch { /* Installed-tool acceptance is optional on other test hosts. */ }
}
test("installed Worktrunk creates from explicit base with isolated configuration", { skip: !tool }, t => {
  const root = mkdtempSync(join(tmpdir(), "runner real wt ")), repo = join(root, "repo"), bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(bin);
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  const config = join(root, "wt.toml"), wrapper = join(bin, "git-wt");
  writeFileSync(config, "");
  writeFileSync(wrapper, `#!/usr/bin/env node\nconst r=require('node:child_process').spawnSync(${JSON.stringify(tool.executable)},${JSON.stringify(tool.args.slice(0, -1))}.concat(['--config',${JSON.stringify(config)},...process.argv.slice(2)]),{stdio:'inherit'});process.exit(r.status??1);`);
  chmodSync(wrapper, 0o755); process.env.PATH = bin + delimiter + oldPath;
  const base = git("rev-parse", "HEAD");
  const result = createWorktree(repo, { branch: "runner-real-test", path: join(root, "assigned"), base }, "worktrunk");
  assert.equal(result.base, base);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: result.path, encoding: "utf8" }).trim(), base);
  assert.equal(createWorktree(repo, result, "worktrunk").path, result.path);
});
