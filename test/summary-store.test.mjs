import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryBundle } from "../dist/summary-evidence.js";
import { saveSummary, readSummary, publishNarrative, exportSummary } from "../dist/summary-store.js";

test("summary persistence is idempotent and publication validates evidence and edits", t => {
  const stateDir = mkdtempSync(join(tmpdir(), "summary-store-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const bundle = summaryBundle({ version: 1, subject: { kind: "task", change: "demo", task: "1.1" }, lifecycle: "task-integrated",
    source: { repository: "implementation", result: "a".repeat(40) }, references: [], gaps: [],
    facts: [{ id: "work", category: "work", authority: "worker-report", text: "Inspect output", references: [] }] });
  const first = saveSummary({ stateDir, bundle });
  assert.equal(first.basic, "ready");
  assert.deepEqual(saveSummary({ stateDir, bundle }), first);
  const sections = Object.fromEntries(["problem", "behavior", "implementation", "verification", "limitations", "delivery"].map(k => [k, []]));
  sections.implementation = [{ text: "Inspect output", evidenceIds: ["unknown"] }];
  const narrative = { version: 1, sourceDigest: bundle.digest, sections };
  assert.throws(() => publishNarrative({ stateDir, bundle, narrative }), /evidence/i);
  sections.implementation[0].evidenceIds = ["work"];
  assert.throws(() => publishNarrative({ stateDir, bundle, narrative, currentSource: () => "stale" }), /stale/i);
  const published = publishNarrative({ stateDir, bundle, narrative, currentSource: () => bundle.digest });
  assert.equal(published.narrative, "ready");
  let observations = 0;
  const revision = published.paths.narrative.match(/narrative-([a-f0-9]+)\.md$/)[1];
  assert.throws(() => publishNarrative({ stateDir, bundle, narrative, expectedRevision: revision,
    currentSource: () => ++observations === 1 ? bundle.digest : "changed-during-publication" }), /stale/i);
  assert.equal(readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest }).paths.narrative, published.paths.narrative);
  assert.throws(() => publishNarrative({ stateDir, bundle, narrative, currentSource: () => bundle.digest }), /revision/i);
  const exported = exportSummary({ stateDir, bundle, directory: join(stateDir, "export") });
  assert.ok(exported.files.includes("basic.md"));
  assert.throws(() => exportSummary({ stateDir, bundle, directory: exported.directory }), /exist/i);
  assert.equal(readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest }).narrative, "ready");
  assert.match(readFileSync(first.paths.basic, "utf8"), /Inspect output/);
  const statusPath = join(first.paths.evidence, "..", "status.json");
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  status.paths.basic = join(stateDir, "outside.md");
  writeFileSync(statusPath, JSON.stringify(status));
  assert.throws(() => readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest }), /path|identity/i);
});

test("competing summary writers leave one coherent ready artifact and interrupted output is recoverable", async t => {
  const stateDir = mkdtempSync(join(tmpdir(), "summary-race-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const bundle = summaryBundle({ version: 1, subject: { kind: "change", change: "race" }, lifecycle: "batch-satisfied",
    source: { repository: "implementation", result: "a".repeat(40) }, facts: [], references: [], gaps: [] });
  const dir = join(stateDir, "summaries", (await import("../dist/summary-evidence.js")).summarySubjectKey(bundle.evidence.subject), bundle.digest);
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "evidence.json"), "interrupted bytes");
  assert.equal(readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest }), undefined);
  const module = new URL("../dist/summary-store.js", import.meta.url).href;
  const program = `import { saveSummary } from ${JSON.stringify(module)}; try { saveSummary(${JSON.stringify({ stateDir, bundle })}); } catch(e) { if (!e.message.includes('Repository is locked')) throw e; process.exitCode = 2; }`;
  const results = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: "pipe" });
    let error = ""; child.stderr.on("data", data => { error += data; }); child.on("error", reject);
    child.on("exit", code => resolve({ code, error }));
  })));
  assert.ok(results.some(r => r.code === 0), JSON.stringify(results));
  assert.ok(results.every(r => [0, 2].includes(r.code)), JSON.stringify(results));
  assert.equal(saveSummary({ stateDir, bundle }).basic, "ready");
  assert.equal(readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest }).sourceDigest, bundle.digest);
});
