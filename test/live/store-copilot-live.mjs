import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { storeFeatureFixture } from "../helpers/live-store-fixture.mjs";
import { Feature } from "../../dist/feature.js";
import { resolveBoundExecutionContext } from "../../dist/execution-context.js";

if (!process.argv.includes("--infer")) throw new Error("Live model usage requires --infer");
const evidenceRoot = resolve(process.env.STORE_LIVE_EVIDENCE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../../.live-verification"));
const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
process.env[`GIT_CONFIG_KEY_${count}`] = "safe.directory";
process.env[`GIT_CONFIG_VALUE_${count}`] = `${evidenceRoot.replaceAll("\\", "/")}/*`;
process.env.GIT_CONFIG_COUNT = String(count + 1);
mkdirSync(evidenceRoot, { recursive: true });
process.env.TEMP = process.env.TMP = evidenceRoot;
const reviewRootIndex = process.argv.indexOf("--review-root");
if (reviewRootIndex !== -1) {
  const suppliedRoot = process.argv[reviewRootIndex + 1];
  if (!suppliedRoot || suppliedRoot.startsWith("--")) throw new Error("--review-root requires the retained disposable fixture directory");
  const root = resolve(suppliedRoot);
  const receipt = { root, role: "review", status: "BLOCKED" };
  try {
    const execution = resolveBoundExecutionContext({ implementationRoot: join(root, "code"), storeRoot: join(root, "store"), featureId: "product", componentId: "api", assignmentId: "assignment", change: "demo" });
    const feature = new Feature(join(root, "code"), undefined, execution);
    feature.jobPreview("demo", "review");
    const review = feature.launch("demo", "review");
    const result = await feature.worker("demo", review.id);
    receipt.review = { id: review.id, exitCode: result.exitCode, log: result.log, job: feature.read("demo").jobs.at(-1) };
    assert.equal(result.exitCode, 0);
    assert.equal(receipt.review.job.report?.outcome, "completed");
    assert.equal(receipt.review.job.report?.findings?.length, 0);
    receipt.status = "PASS";
  } catch (error) { receipt.error = error.message; process.exitCode = 1; }
  writeFileSync(join(root, "live-review-recheck.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  process.exit(process.exitCode ?? 0);
}
const f = await storeFeatureFixture({ after() {} }, process.env.STORE_LIVE_HARNESS ?? "copilot");
const receipt = { root: f.dir, model: process.env.STORE_LIVE_MODEL ?? "auto", planningTransport: "fixture scaffold", workerTransport: "real installed Copilot", status: "RUNNING" };
const save = () => writeFileSync(join(f.dir, "live-receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ root: f.dir })); save();
try {
  await f.component.import({ ...f.selection, token: f.preview.token });
  const feature = new Feature(f.code, undefined, f.execution), runner = feature.runner;
  const attempt = runner.launch("demo", ["1.1"])[0];
  receipt.attempt = { id: attempt.id, path: attempt.path }; save();
  const result = await runner.worker("demo", "1.1", attempt.id);
  const current = runner.read("demo").attempts.at(-1);
  receipt.worker = { exitCode: result.exitCode, log: result.log, phase: current.phase, identityConfirmed: current.identityConfirmed, session: current.session, report: current.report, completion: current.worker?.completion }; save();
  assert.equal(result.exitCode, 0);
  assert.equal(current.report?.outcome, "completed");
  assert.equal(current.identityConfirmed, true);
  assert.equal(readFileSync(join(attempt.path, "result.txt"), "utf8"), "HELLO\n");
  runner.integrate("demo", ["1.1"]);
  receipt.integrated = runner.read("demo").head; save();
  const review = feature.launch("demo", "review");
  const reviewed = await feature.worker("demo", review.id);
  receipt.review = { id: review.id, exitCode: reviewed.exitCode, log: reviewed.log, job: feature.read("demo").jobs.at(-1) }; save();
  assert.equal(reviewed.exitCode, 0);
  if (receipt.review.job.report?.outcome !== "completed" || receipt.review.job.report?.findings?.length) {
    receipt.status = "BLOCKED";
    throw new Error(receipt.review.job.report?.summary ?? "Review did not produce a clean completed report");
  }
  assert.equal(feature.submissionEvidence({ change: "demo" }).tasks[0].completed, true);
  assert.equal(existsSync(join(f.code, "openspec")), false);
  assert.equal(existsSync(join(f.code, ".github")), false);
  receipt.status = "PASS";
} catch (error) { if (receipt.status !== "BLOCKED") receipt.status = "FAIL"; receipt.error = error.message; process.exitCode = 1; }
save(); console.log(JSON.stringify({ root: f.dir, status: receipt.status, error: receipt.error }));
