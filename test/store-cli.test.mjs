import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linkedCommand } from "../dist/linked-cli.js";
import { storePlanningFixture } from "./helpers/store-planning-fixture.mjs";
import { linkedFeatureInputs } from "../docs/examples/linked-feature-inputs.mjs";
import { decodeManifest } from "../dist/coordination-state.js";

test("checked input builder supports both local and Store-only planning layouts", () => {
  const input = { storeRoot: "S", apiRoot: "API", webRoot: "WEB", workerRoot: "WORKER", model: "model", deliveryBranch: "main", coordinationBranch: "main" };
  assert.equal(linkedFeatureInputs(input).manifest.version, 1);
  const store = linkedFeatureInputs({ ...input, planningMode: "store" });
  assert.equal(store.manifest.version, 2);
  assert.deepEqual(Object.keys(store.manifest.components), ["api", "web", "worker"]);
  assert.equal(decodeManifest({ value: store.manifest }).components.api.planning.openspecRoot, "components/api/openspec");
  assert.equal(store.resources.worktreeRoot, undefined);
});

test("component CLI routes explicit Store scope without creating code-local state", async t => {
  const f = storePlanningFixture(t);
  await assert.rejects(linkedCommand(["component", "status", "product", "--store", f.storeRoot, "--root", f.code,
    "--repository", "api", "--component", "api", "--change", "demo", "--json"]), /No matching imported Store assignment/);
  assert.equal(existsSync(join(f.code, "openspec")), false);
  assert.equal(existsSync(join(f.code, ".openspec-runner")), false);
  const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
  const callback = spawnSync(process.execPath, [cli, "feature", "begin", "demo", "--store", f.storeRoot, "--feature", "product", "--component", "api", "--attempt", "attempt", "--json"], { cwd: f.code, encoding: "utf8" });
  assert.match(JSON.parse(callback.stderr).error, /callbacks require --assignment/);
});
