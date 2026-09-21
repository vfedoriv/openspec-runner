import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocking, featureActive, featurePath, readFeature, settingsIdentity, validateFeatureReport } from "../dist/feature-state.js";

const report = () => ({ attempt: "job", session: "session", outcome: "completed", head: "a".repeat(40),
  fingerprint: "fingerprint", summary: "Reviewed", verification: ["Checked acceptance criteria"], findings: [] });
const finding = category => ({ id: "F1", category, location: "src/example.ts:12", impact: "Concrete effect", correction: "Suggested correction" });

test("review category policy blocks behavior/safety failures but permits advisory findings", () => {
  for (const category of ["correctness", "security", "spec", "verification"]) assert.equal(blocking(finding(category)), true);
  for (const category of ["style", "improvement"]) assert.equal(blocking(finding(category)), false);
});

test("review reports require evidence and complete unique actionable findings", () => {
  validateFeatureReport(report(), "review");
  for (const bad of [null, {}, { ...report(), verification: [] }, { ...report(), findings: undefined },
    { ...report(), findings: [finding("unknown")] }, { ...report(), findings: [finding("spec"), finding("spec")] },
    { ...report(), findings: [{ ...finding("security"), impact: " " }] }]) {
    assert.throws(() => validateFeatureReport(bad, "review"));
  }
  validateFeatureReport({ ...report(), findings: [finding("spec")] }, "review");
});

test("repair reports cannot claim completion without a full commit; blocked reports retain evidence", () => {
  assert.throws(() => validateFeatureReport(report(), "repair"), /commit SHA/);
  validateFeatureReport({ ...report(), commit: "b".repeat(40) }, "repair");
  validateFeatureReport({ ...report(), outcome: "blocked", summary: "Needs a spec change", findings: undefined }, "repair");
});

test("execution identity normalizes effort aliases but binds model, harness and permission settings", () => {
  const a = { model: "model-a", reasoningEffort: "high" };
  assert.equal(settingsIdentity(a), settingsIdentity({ model: "model-a", harness: "codex", effort: "high", sources: ["different provenance"] }));
  for (const b of [{ ...a, model: "model-b" }, { ...a, harness: "claude" }, { ...a, effort: "low" },
    { ...a, options: { permissionMode: "default" } }]) assert.notEqual(settingsIdentity(a), settingsIdentity(b));
});

test("accepted reports do not free a feature job until its supervisor acknowledges exit", () => {
  assert.equal(featureActive({ phase: "completed", worker: { token: "x" } }), true);
  assert.equal(featureActive({ phase: "failed", worker: { exitedAt: "now" } }), false);
  assert.equal(featureActive({ phase: "preparing" }), true);
});

test("feature names cannot escape runtime storage and invalid state fails closed", t => {
  const dir = mkdtempSync(join(tmpdir(), "feature contract "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["../outside", "a/b", "", "a\\b"]) assert.throws(() => featurePath(dir, name));
  mkdirSync(join(dir, "features"));
  assert.equal(readFeature(dir, "demo"), undefined);
  writeFileSync(featurePath(dir, "demo"), JSON.stringify({ version: 999, change: "demo", jobs: [] }));
  assert.throws(() => readFeature(dir, "demo"), /Invalid or unsupported/);
});
