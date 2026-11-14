import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { editExecutionSettings } from "../dist/execution-settings.js";

test("assignment preview preserves bytes and rejects stale settings before applying", t => {
  const root = mkdtempSync(join(tmpdir(), "runner-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  const directory = join(root, "openspec", "changes", "demo");
  mkdirSync(directory, { recursive: true });
  const execution = join(directory, "execution.yaml");
  const before = "version: 1\r\ntasks:\r\n  1.1:\r\n    # preserve this comment\r\n    parallel: true\r\n";
  writeFileSync(join(root, "openspec", "runner.yaml"), "version: 1\n");
  writeFileSync(join(directory, "tasks.md"), "- [ ] 1.1 Example\n");
  writeFileSync(execution, before);
  git("add", ".");
  git("-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "-m", "Plan");
  const patch = { tasks: [{ id: "1.1", model: "example-model", effort: "high" }] };
  const preview = editExecutionSettings("demo", patch, undefined, root);
  assert.equal(readFileSync(execution, "utf8"), before);
  assert.equal(preview.changes[0].effective.reasoningEffort, "high");
  writeFileSync(execution, before + "# concurrent edit\r\n");
  assert.throws(() => editExecutionSettings("demo", patch, preview.token, root), /stale/);
  const updated = editExecutionSettings("demo", patch, undefined, root);
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url)),
    "execution-settings", "demo", "--file", "-", "--json", ...args,
  ], { cwd: root, input: JSON.stringify(patch), encoding: "utf8" }));
  assert.equal(cli("--dry-run").token, updated.token);
  assert.equal(cli("--confirm", updated.token).applied, true);
  const saved = readFileSync(execution, "utf8");
  assert.match(saved, /# preserve this comment\r\n/);
  assert.match(saved, /parallel: true\r\n/);
  assert.match(saved, /reasoningEffort: high\r\n/);
  const clear = { tasks: [{ id: "1.1", model: null, effort: null }] };
  const reset = editExecutionSettings("demo", clear, undefined, root);
  assert.equal(reset.changes[0].after.model, undefined);
  assert.throws(() => editExecutionSettings("demo", { tasks: [{ id: "9.9", model: "other" }] }, undefined, root), /Unknown or duplicate task/);
  assert.throws(() => editExecutionSettings("demo", { tasks: [{ id: "1.1" }, { id: "1.1" }] }, undefined, root), /Unknown or duplicate task/);
  const next = editExecutionSettings("demo", clear, undefined, root);
  git("-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Advance HEAD");
  assert.throws(() => editExecutionSettings("demo", clear, next.token, root), /stale/);
  writeFileSync(join(directory, "tasks.md"), "- [x] 1.1 Example\n");
  assert.throws(() => editExecutionSettings("demo", clear, undefined, root), /already satisfied/);
});
