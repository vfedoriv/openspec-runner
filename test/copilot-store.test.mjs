import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getHarness } from "../dist/harnesses/registry.js";
import { prepareStoreCopilotHooks } from "../dist/harnesses/copilot-store-hooks.js";
import { armHookLease, recordHook } from "../dist/harnesses/copilot-hooks.js";
import { refreshCopilotEvidence } from "../dist/harnesses/lifecycle.js";
import { prepareEditorAgent } from "../dist/harnesses/copilot-editor.js";

test("Store hooks are disposable, preserve user files and bind only scoped root evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "copilot-hooks-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = join(root, "code"), worktree = join(root, "worker"), runtime = join(root, "store-runtime");
  mkdirSync(code);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(code, "init"); git(code, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
  git(code, "worktree", "add", "-b", "worker", worktree);
  const scope = { root: join(root, "store"), common: join(root, "store/.git"), runtimeDir: join(root, "store/.openspec-runner/owner/runtime"), contextPaths: [join(root, "store/.openspec-runner/owner/runtime/context")], selection: { storeRoot: join(root, "store"), featureId: "feature", componentId: "api", assignmentId: "assignment", change: "demo" } };
  const { path } = prepareStoreCopilotHooks({ worktree, attempt: "attempt", scope });
  assert.throws(() => prepareStoreCopilotHooks({ worktree: code, attempt: "attempt", scope }), /linked worktree/);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  const content = readFileSync(path, "utf8"), hook = JSON.parse(content).hooks.UserPromptSubmit[0];
  assert.ok(hook.command.includes("--store-scope"));
  assert.ok(hook.powershell.includes("--store-scope"));
  assert.equal(prepareStoreCopilotHooks({ worktree, attempt: "attempt", scope }).path, path);
  writeFileSync(path, "user hooks");
  assert.throws(() => prepareStoreCopilotHooks({ worktree, attempt: "attempt", scope }), /Conflicting/);
  assert.equal(readFileSync(path, "utf8"), "user hooks");
  const common = join(code, ".git");
  armHookLease({ stateDir: runtime, attempt: "attempt", harness: "copilot", worktree, generation: "generation", nonce: "nonce" });
  recordHook({ stateDir: runtime, event: { kind: "prompt", session: "actual", cwd: worktree, at: new Date().toISOString(), prompt: "[openspec-runner:attempt:nonce]" } });
  const attempt = { id: "attempt", agent: "copilot", path: worktree, worker: { token: "generation" } };
  refreshCopilotEvidence(attempt, common);
  assert.equal(attempt.observedSession, undefined);
  refreshCopilotEvidence(attempt, common, runtime);
  assert.equal(attempt.observedSession, "actual");
  assert.equal(attempt.identityConfirmed, true);
  const editor = prepareEditorAgent({ worktree, attempt: "editor-attempt", model: "opaque-selector", hookFormat: "vscode", store: scope });
  assert.match(readFileSync(editor.path, "utf8"), /model: opaque-selector/);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  git(worktree, "add", "-f", ".github/agents/openspec-runner-editor-attempt.agent.md");
  assert.throws(() => prepareEditorAgent({ worktree, attempt: "editor-attempt", model: "different", hookFormat: "vscode", store: scope }), /tracked/);
  assert.match(readFileSync(editor.path, "utf8"), /model: opaque-selector/);
});

test("Copilot CLI grants the selected Store runtime on launch and resume", () => {
  const scope = { root: resolve("store"), common: resolve("store/.git"), runtimeDir: resolve("store/.openspec-runner/owner/runtime"), contextPaths: [resolve("store/.openspec-runner/owner/runtime/context")] };
  const harness = getHarness("copilot"), settings = { model: "auto" };
  for (const invocation of [harness.initialInvocation(settings, resolve("worker"), resolve("code/.git"), "prompt", "", scope), harness.resumeInvocation(settings, resolve("worker"), resolve("code/.git"), "session", scope)]) {
    assert.ok(invocation.args.includes(scope.runtimeDir));
    assert.ok(!invocation.args.includes(scope.root));
    for (const role of ["implement", "review", "repair"]) {
      const directory = fileURLToPath(new URL(`../skills/openspec-runner-${role}/`, import.meta.url)).replace(/[\\/]$/, "");
      assert.ok(invocation.args.includes(directory), `missing ${role} skill directory`);
      assert.ok(invocation.args.includes(`read(${join(directory, "SKILL.md")})`));
      assert.ok(invocation.args.includes(`write(${join(directory, "**")})`));
      assert.equal(invocation.args[invocation.args.indexOf(`read(${join(directory, "SKILL.md")})`) - 1], "--allow-tool");
      assert.equal(invocation.args[invocation.args.indexOf(`write(${join(directory, "**")})`) - 1], "--deny-tool");
    }
  }
});

test("Copilot runtime preserves local reports and isolates Store reports", async t => {
  const { resolveCopilotRuntime } = await import("../dist/harnesses/copilot-runtime.js");
  const root = mkdtempSync(join(tmpdir(), "copilot-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const common = join(root, "code", ".git"), worktree = join(root, "workers", "one");
  const runtimeDir = join(root, "store", ".openspec-runner", "owner", "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const scope = { root: join(root, "store"), common: join(root, "store", ".git"), runtimeDir, contextPaths: [join(runtimeDir, "context")] };
  assert.deepEqual(resolveCopilotRuntime({ common, worktree }), { stateDir: join(common, "openspec-runner"), reportsDir: resolve(worktree, "..", "reports") });
  assert.deepEqual(resolveCopilotRuntime({ common, worktree, store: scope }), { stateDir: runtimeDir, reportsDir: join(runtimeDir, "reports") });
  assert.throws(() => resolveCopilotRuntime({ common, worktree, store: { ...scope, runtimeDir: root } }), /Store/);
  assert.throws(() => resolveCopilotRuntime({ common, worktree, store: { ...scope, common } }), /Store/);
  assert.throws(() => resolveCopilotRuntime({ common, worktree, store: { ...scope, contextPaths: [root] } }), /Store/);
});
