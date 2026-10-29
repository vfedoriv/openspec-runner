import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Component } from "../dist/component.js";
import { Runner } from "../dist/runner.js";
import { validateDelegatedBinding } from "../dist/feature-state.js";

test("Windows cannot reopen a delegated binding with Unix mode bits", { skip: process.platform !== "win32" }, () => {
  assert.throws(() => validateDelegatedBinding({}), /Windows delegated-context write protection/);
});

test("Windows rejects unverified backend/context combinations before resource mutation", { skip: process.platform !== "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "runner-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", root], { stdio: "ignore" });
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), "- [ ] 1.1 Task\n");
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), "version: 1\ntasks:\n  '1.1': {}\n");
  const runner = new Runner(root), component = new Component({ root, repository: "test" });
  for (const policy of [{ worktrees: "worktrunk", terminal: "manual" }, { worktrees: "orca", terminal: "manual" }, { worktrees: "git", terminal: "herdr" }]) {
    writeFileSync(join(root, "openspec/runner.yaml"), JSON.stringify({ version: 1, ...policy }));
    assert.throws(() => runner.preview("demo", ["1.1"]), /Windows requires verified/);
    assert.equal(existsSync(join(root, ".openspec-runner/worktrees")), false);
  }
  await assert.rejects(component.inspect({}), /Windows delegated-context write protection/);
  assert.equal(existsSync(join(root, ".git/openspec-runner")), false);
});
