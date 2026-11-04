import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Component } from "../dist/component.js";
import { terminalAdapter } from "../dist/adapters.js";
import { validateDelegatedBinding } from "../dist/feature-state.js";

test("Windows cannot reopen a delegated binding with Unix mode bits", { skip: process.platform !== "win32" }, () => {
  assert.throws(() => validateDelegatedBinding({}), /Windows delegated-context write protection/);
});

test("Windows rejects missing caller and protected-context capabilities before mutation", { skip: process.platform !== "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "runner-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", root], { stdio: "ignore" });
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Task\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), "version: 1\ntasks:\n  '1.1': {}\n");
  const component = new Component({ root, repository: "test" }), prior = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try { assert.throws(() => terminalAdapter(root, "herdr"), /HERDR_ENV/); }
  finally { if (prior !== undefined) process.env.HERDR_ENV = prior; }
  assert.equal(existsSync(join(root, ".openspec-runner/worktrees")), false);
  await assert.rejects(component.inspect({}), /Windows delegated-context write protection/);
  assert.equal(existsSync(join(root, ".git/openspec-runner")), false);
});
