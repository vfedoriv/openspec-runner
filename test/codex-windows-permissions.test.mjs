import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getHarness } from "../dist/harnesses/registry.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runner-codex-permissions-")), worktree = join(root, "worker");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Runner Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  const branch = "openspec-runner/demo/1.1/worker";
  git("worktree", "add", "-b", branch, worktree);
  const common = join(root, ".git"), gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, encoding: "utf8" }).trim();
  return { root, worktree, branch, common, gitDir };
}

test("managed Windows Codex grants its Git admin and runtime paths without making common metadata writable", async t => {
  const f = fixture(t), module = await import("../dist/harnesses/codex-permissions.js").catch(() => ({}));
  assert.equal(typeof module.codexWorkerPermissions, "function");
  const policy = module.codexWorkerPermissions({ cwd: f.worktree, common: f.common, gitDir: f.gitDir, branch: f.branch });
  assert.equal(policy.profile.extends, ":workspace");
  assert.equal(policy.profile.filesystem[resolve(f.gitDir)], "write");
  assert.equal(policy.profile.filesystem[resolve(f.common)], "read");
  assert.equal(policy.profile.filesystem[join(f.common, "refs", "heads", f.branch)], "write");
  assert.equal(policy.profile.filesystem[join(f.common, "refs", "heads", f.branch) + ".lock"], "write");
  assert.equal(policy.profile.filesystem[join(f.common, "refs", "heads", "main")], undefined);
  assert.equal(policy.profile.filesystem[join(f.worktree, ".codex")], undefined);
  assert.equal(policy.profile.filesystem[join(f.worktree, ".git")], undefined);
  assert.equal(policy.configArgs.some(value => value.includes("danger-full-access")), false);
  assert.ok(policy.configArgs.includes(`default_permissions=${JSON.stringify(policy.name)}`));
  assert.ok(policy.configArgs.some(value => value.startsWith(`permissions.${policy.name}={`)));
  assert.throws(() => module.codexWorkerPermissions({ cwd: f.worktree, common: f.common, gitDir: f.gitDir, branch: "main" }), /branch|identity/i);
  assert.throws(() => module.codexWorkerPermissions({ cwd: f.worktree, common: f.common, gitDir: f.common, branch: f.branch }), /admin|worktree|identity/i);
});

test("Windows managed Codex invocation prepares reports and pins the runner executable", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t), harness = getHarness("codex");
  assert.equal(typeof harness.managedInvocation, "function");
  const invocation = harness.managedInvocation(harness.initialInvocation({ model: "gpt-6-luna" }, f.worktree, f.common, "prompt", ""), { common: f.common, gitDir: f.gitDir, branch: f.branch });
  assert.equal(invocation.args[0], "exec"); assert.equal(invocation.args.at(-1), "prompt");
  assert.equal(invocation.args.includes("--add-dir"), false);
  assert.ok(invocation.args.includes("--strict-config"));
  assert.ok(invocation.prepareDirectories.includes(join(f.root, "reports")));
  assert.equal(invocation.env.TEMP, invocation.env.TMP);
  const system = await import("../dist/system.js");
  assert.equal(typeof system.workerRunnerCommand, "function");
  const command = system.workerRunnerCommand(["begin", "demo", "1.1"], "codex");
  assert.ok(command.includes(process.execPath));
  assert.ok(command.includes(fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url))));
  const { Runner } = await import("../dist/runner.js");
  const validate = harness.validateManagedInvocation;
  let checked = false;
  harness.validateManagedInvocation = actual => { checked = true; assert.ok(actual.args.includes("--strict-config")); };
  try {
    const resume = Runner.prototype.command.call({ repo: { common: f.common } }, "demo", {
      agent: "codex", settings: { model: "gpt-6-luna" }, path: f.worktree,
      gitDir: f.gitDir, branch: f.branch, session: "owned-session",
    });
    assert.match(resume, /resume/); assert.match(resume, /default_permissions/);
    assert.equal(checked, true);
  } finally { harness.validateManagedInvocation = validate; }
});

test("effective Codex permissions reject legacy, unrestricted, or broader grants", async t => {
  const f = fixture(t), { codexWorkerPermissions, assertEffectiveCodexPermissions } = await import("../dist/harnesses/codex-permissions.js");
  const policy = codexWorkerPermissions({ cwd: f.worktree, common: f.common, gitDir: f.gitDir, branch: f.branch });
  const diagnostic = (entries, type = "restricted") => [{ role: "user", type: "message", content: [{ type: "input_text",
    text: `<environment_context><cwd>${f.worktree}</cwd><permission_profile type="managed"><file_system type="${type}">${entries}</file_system></permission_profile></environment_context>` }] }];
  const entries = [".git", ".codex", ".agents", ".aws"].map(name => `<entry access="read"><path>${join(f.worktree, name)}</path></entry>`).join("") + Object.entries(policy.profile.filesystem).map(([path, access]) => `<entry access="${access}"><path>${path}</path></entry>`).join("");
  assert.doesNotThrow(() => assertEffectiveCodexPermissions(diagnostic(entries), policy));
  assert.throws(() => assertEffectiveCodexPermissions(diagnostic(""), policy), /omit/);
  assert.throws(() => assertEffectiveCodexPermissions(diagnostic(entries, "unrestricted"), policy), /restricted/);
  assert.throws(() => assertEffectiveCodexPermissions(diagnostic(entries + `<entry access="write"><path>${f.root}</path></entry>`), policy), /unexpected/);
  assert.throws(() => assertEffectiveCodexPermissions([{ role: "developer", content: diagnostic(entries)[0].content }], policy), /unavailable/);
});

test("installed Codex sandbox permits only the intended Git writes", { skip: process.platform !== "win32" || process.env.OPENSPEC_RUNNER_LIVE_CODEX_SANDBOX !== "1" }, async t => {
  const f = fixture(t), { codexWorkerPermissions, assertEffectiveCodexPermissions, validateCodexInvocation } = await import("../dist/harnesses/codex-permissions.js");
  const policy = codexWorkerPermissions({ cwd: f.worktree, common: f.common, gitDir: f.gitDir, branch: f.branch });
  for (const path of policy.prepareDirectories) mkdirSync(path, { recursive: true });
  for (const name of [".codex", ".agents", ".aws"]) { mkdirSync(join(f.worktree, name)); writeFileSync(join(f.worktree, name, "guard.txt"), "guard"); }
  const script = join(f.root, "probe.mjs");
  writeFileSync(script, `import fs from 'node:fs';import assert from 'node:assert/strict';
    for(const path of ${JSON.stringify([join(f.gitDir, "probe"), join(f.common, "objects", "probe"), join(f.root, "reports", "probe"), join(f.common, "refs", "heads", f.branch) + ".lock"])}) {fs.writeFileSync(path,'probe',{flag:'wx'});fs.unlinkSync(path);}
    for(const path of ${JSON.stringify([join(f.common, "config"), join(f.common, "refs", "heads", "main"), join(f.worktree, ".git"), ...[".codex", ".agents", ".aws"].map(name => join(f.worktree, name, "guard.txt"))])}) {let denied=false;try{fs.closeSync(fs.openSync(path,'r+'));}catch(e){denied=['EACCES','EPERM'].includes(e.code);}assert.ok(denied,'unexpected write grant: '+path);}
    console.log('SCOPED_CODEX_PERMISSIONS_OK');`);
  const { run } = await import("../dist/system.js");
  assert.doesNotThrow(() => validateCodexInvocation({ executable: "codex", args: [], cwd: f.worktree }, { common: f.common, gitDir: f.gitDir, branch: f.branch }));
  const diagnostics = extra => JSON.parse(run("codex", ["debug", "prompt-input", ...policy.configArgs, ...extra], f.worktree, 30000));
  assert.doesNotThrow(() => assertEffectiveCodexPermissions(diagnostics([]), policy));
  // This CLI resolves named profiles ahead of these legacy CLI overrides.
  // Verify the resulting scope instead of assuming an override wins.
  assert.doesNotThrow(() => assertEffectiveCodexPermissions(diagnostics(["-c", 'sandbox_mode="workspace-write"']), policy));
  assert.doesNotThrow(() => assertEffectiveCodexPermissions(diagnostics(["-c", 'sandbox_mode="danger-full-access"']), policy));
  const output = run("codex", ["sandbox", "-P", policy.name, ...policy.configArgs, "-C", f.worktree, process.execPath, script], f.worktree, 30000);
  assert.match(output, /SCOPED_CODEX_PERMISSIONS_OK/);
  assert.equal(readFileSync(join(f.worktree, ".codex", "guard.txt"), "utf8"), "guard");
});
