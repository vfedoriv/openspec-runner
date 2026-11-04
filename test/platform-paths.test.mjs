import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tasksFrom } from "../dist/plan.js";
const paths = await import("../dist/platform-paths.js").catch(() => ({}));

test("Windows Git hook suppression uses a real empty directory", { skip: process.platform !== "win32" }, async () => {
  assert.equal(typeof paths.gitHooksPath, "function");
  const directory = paths.gitHooksPath();
  assert.equal(statSync(directory).isDirectory(), true);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(paths.gitHooksPath(), directory);
});
test("Windows checkout line endings preserve numbered tasks", () => {
  assert.deepEqual(tasksFrom("- [ ] 1.1 Implement result\r\n"), [{ id: "1.1", description: "Implement result", completed: false, line: 0 }]);
});
test("canonical containment rejects prefix siblings and junction escapes", t => {
  assert.equal(typeof paths.containedPath, "function");
  const dir = mkdtempSync(join(tmpdir(), "runner-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); mkdirSync(join(dir, "repo-other"));
  assert.equal(paths.containedPath(root, join(root, "future")), true);
  assert.equal(paths.containedPath(root, join(dir, "repo-other")), false);
  if (process.platform === "win32") {
    assert.equal(paths.samePath(root, root.replaceAll("\\", "/")), true);
    assert.equal(paths.containedPath(root, join(root, "file:stream")), false);
    symlinkSync(join(dir, "repo-other"), join(root, "escape"), "junction");
    assert.equal(paths.containedPath(root, join(root, "escape", "file")), false);
  }
});
