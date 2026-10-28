import test from "node:test";
import assert from "node:assert/strict";
import { featureFixture } from "./helpers/feature-fixture.mjs";
import { safeSummary, readCurrentSummary } from "../dist/summary-service.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("summary-only disk failure preserves completion and retry source identity", async t => {
  const f = featureFixture(t); f.approve(); await f.review(); f.f.approveFinal("demo", f.f.finalPreview("demo").token);
  writeFileSync(join(f.r.repo.stateDir, "summaries"), "blocked directory");
  const result = f.f.archive("demo");
  assert.equal(result.completed, true); assert.equal(result.summary.basic, "failed");
  assert.match(result.summary.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(result.summary.subjectKey, /^[a-f0-9]{64}$/);
});

test("successful local archival automatically saves a feature summary outside the runner lock", async t => {
  const f = featureFixture(t);
  f.approve(); await f.review();
  const p = f.f.finalPreview("demo"); f.f.approveFinal("demo", p.token);
  const result = f.f.archive("demo");
  assert.equal(result.completed, true);
  assert.equal(result.summary.basic, "incomplete");
  assert.ok(readCurrentSummary({ cwd: f.root, change: "demo" }));
  assert.equal(f.f.archive("demo").summary.sourceDigest, result.summary.sourceDigest);
});

test("summary failure does not manufacture completion or write from inspection", t => {
  const f = featureFixture(t);
  const request = { cwd: f.root, change: "demo" };
  assert.equal(readCurrentSummary(request), undefined);
  const result = safeSummary(request);
  assert.equal(result.basic, "failed");
  assert.equal(f.r.read("demo"), undefined);
});
