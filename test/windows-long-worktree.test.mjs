import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree } from "../dist/adapters.js";

test("Windows creates a nested worktree whose absolute gitfile exceeds Git's explicit-dir limit", { skip: process.platform !== "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "runner-long-worktree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Runner Test"); git("config", "user.email", "test@example.invalid");
  git("config", "core.longpaths", "true");
  writeFileSync(join(root, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  const path = join(root, "x".repeat(224 - root.length));
  assert.ok((path + "/.git").length > 220);
  const workspace = createWorktree(root, { path, branch: "worker", base: git("rev-parse", "HEAD") }, "git");
  assert.equal(workspace.path, path);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim(), workspace.base);
});
