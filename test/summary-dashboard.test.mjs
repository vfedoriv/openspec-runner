import test from "node:test";
import assert from "node:assert/strict";
import { featureFixture } from "./helpers/feature-fixture.mjs";
import { collectDashboard } from "../dist/dashboard-reader.js";
import { actionsFor } from "../dist/dashboard-actions.js";
test("dashboard exposes saved summary and display-only refresh command", async t => {
  const f = featureFixture(t); f.approve(); await f.review(); f.f.approveFinal("demo", f.f.finalPreview("demo").token); f.f.archive("demo");
  const snapshot = collectDashboard({ cwd: f.root });
  const feature = snapshot.features.find(x => x.change === "demo");
  assert.equal(feature.deliverySummary.narrative, "pending");
  const action = actionsFor(snapshot, feature.id).find(x => x.id.endsWith(":summary-refresh"));
  assert.equal(action.kind, "command");
  assert.deepEqual(action.argv, ["summary", "demo", "--refresh"]);
});
