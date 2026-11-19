import { test } from "node:test";
import assert from "node:assert/strict";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";
import { pinStorePlan } from "../dist/planning-source.js";
import { resolveExecutionContext } from "../dist/execution-context.js";
import { assertStoreOwnership, releaseStoreOwnership, withStoreOwnership } from "../dist/store-ownership.js";

test("Store code-clone ownership survives reflog maintenance and releases idle leases", t => {
  const f = storePlanningFixture(t), source = pinStorePlan(f.input());
  const context = resolveExecutionContext({ implementationRoot: f.code, change: "demo",
    store: { storeRoot: f.storeRoot, featureId: "feature", componentId: "api", assignmentId: "assignment", source } });
  withStoreOwnership(context, git(f.code, "rev-parse", "HEAD"), () => {});
  assertStoreOwnership(context);
  git(f.code, "reflog", "expire", "--expire=now", "--all");
  assertStoreOwnership(context);
  releaseStoreOwnership(context);
  assert.throws(() => assertStoreOwnership(context), /ownership/i);
});
