import { test } from "node:test";
import assert from "node:assert/strict";
import { archivePaths, storeArchiveRoot } from "../dist/archive-paths.js";

test("archive roots come from one exact approved shared tasks path", () => {
  const context = { change: "shared", files: [{ path: "planning/Команда space/openspec/changes/shared/tasks.md" }] };
  assert.equal(storeArchiveRoot(context, "shared"), "planning/Команда space/openspec");
  assert.deepEqual(archivePaths("openspec", "shared"), { active: "openspec/changes/shared/", archived: "openspec/changes/archive/", specs: "openspec/specs/", tasks: "openspec/changes/shared/tasks.md" });
  assert.throws(() => storeArchiveRoot({ ...context, change: "other" }, "shared"), /change/i);
  assert.throws(() => storeArchiveRoot({ ...context, files: [] }, "shared"), /unambiguous/i);
  assert.throws(() => storeArchiveRoot({ ...context, files: [...context.files, { path: "sibling/openspec/changes/shared/tasks.md" }] }, "shared"), /unambiguous/i);
  for (const root of ["../openspec", "/openspec", "plan\\openspec", ".git/openspec", "plan:stream/openspec", "openspec-sibling"])
    assert.throws(() => archivePaths(root, "shared"), /unsafe|unsupported/i);
  assert.throws(() => archivePaths("openspec", "../other"), /unsafe/i);
});
