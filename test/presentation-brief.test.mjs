import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresentationBrief, readPresentationProvider } from "../dist/presentation-brief.js";
import { summaryBundle } from "../dist/summary-evidence.js";
import { init } from "../dist/cli.js";
import { git } from "./helpers/feature-fixture.mjs";
test("brief preserves limits and source, provider config is explicit and skills install", t => {
  const dir = mkdtempSync(join(tmpdir(), "presentation-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = summaryBundle({ version: 1, subject: { kind: "change", change: "demo" }, lifecycle: "batch-satisfied",
    source: { repository: "implementation", result: "a".repeat(40) }, facts: [], references: [], gaps: ["Delivery not established"] });
  const brief = createPresentationBrief({ bundle, audience: "Product colleagues" });
  assert.equal(brief.sourceDigest, bundle.digest); assert.match(brief.markdown, /Delivery not established/); assert.match(brief.markdown, /5.?7/);
  assert.throws(() => readPresentationProvider({ file: join(dir, "missing.json") }));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: fixture\ndescription: Fixture\n---\n");
  writeFileSync(join(dir, "provider.json"), JSON.stringify({ skillPath: "SKILL.md", version: "fixture" }));
  assert.equal(readPresentationProvider({ file: join(dir, "provider.json") }).skillPath, join(dir, "SKILL.md"));
  git(dir, "init"); init(dir, "all");
  for (const root of [".agents", ".claude"]) for (const skill of ["summarize", "present"]) assert.ok(existsSync(join(dir, root, "skills", `openspec-runner-${skill}`, "SKILL.md")));
});

function providerFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "provider.json");
  writeFileSync(join(dir, "SKILL.md"), "Fixture skill; never execute.\n");
  return { dir, file };
}

for (const [name, value] of Object.entries({ null: null, array: [], scalar: "skill", missing: {}, numericPath: { skillPath: 7 }, blankPath: { skillPath: "  " }, unknown: { skillPath: "SKILL.md", command: "run" }, numericVersion: { skillPath: "SKILL.md", version: 1 }, nullVersion: { skillPath: "SKILL.md", version: null } })) {
  test(`provider rejects invalid configuration: ${name}`, t => {
    const { file } = providerFixture(t);
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readPresentationProvider({ file }), /Invalid provider configuration/);
  });
}

test("provider rejects malformed JSON and missing provider file", t => {
  const { file } = providerFixture(t);
  writeFileSync(file, "{");
  assert.throws(() => readPresentationProvider({ file }), SyntaxError);
  writeFileSync(file, JSON.stringify({ skillPath: "absent.md" }));
  assert.throws(() => readPresentationProvider({ file }), /ENOENT/);
});

test("provider resolves from nested configuration directory and preserves optional version", async t => {
  const { dir } = providerFixture(t);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "config", "nested"), { recursive: true });
  const file = join(dir, "config", "nested", "provider.json");
  for (const version of [undefined, "", "revision-7"]) {
    writeFileSync(file, JSON.stringify({ skillPath: "../../SKILL.md", version }));
    assert.deepEqual(readPresentationProvider({ file }), { skillPath: join(dir, "SKILL.md"), ...(version ? { version } : {}) });
  }
});

test("provider rejects directory and symbolic link targets", async t => {
  const { dir, file } = providerFixture(t);
  const { symlinkSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify({ skillPath: "." }));
  assert.throws(() => readPresentationProvider({ file }), /regular readable file/);
  symlinkSync(join(dir, "SKILL.md"), join(dir, "linked.md"));
  writeFileSync(file, JSON.stringify({ skillPath: "linked.md" }));
  assert.throws(() => readPresentationProvider({ file }), /regular readable file/);
});

test("brief validates audience and narrative source while preserving evidence cautions and asset references", () => {
  const bundle = summaryBundle({ version: 1, subject: { kind: "change", change: "demo" }, lifecycle: "batch-satisfied", source: { repository: "implementation", result: "b".repeat(40) }, facts: [], references: [], gaps: ["Deployment has not been verified", "No measured benefit evidence"] });
  assert.throws(() => createPresentationBrief({ bundle, audience: " \n" }), /audience required/);
  const sections = Object.fromEntries(["problem", "behavior", "implementation", "verification", "limitations", "delivery"].map(key => [key, []]));
  sections.problem = [{ text: "Reviewed narrative", evidenceIds: [] }];
  const narrative = { version: 1, sourceDigest: bundle.digest, sections };
  assert.throws(() => createPresentationBrief({ bundle, audience: "Reviewers", narrative: { ...narrative, sourceDigest: "stale" } }), /Narrative source mismatch/);
  const assets = ["figures/not-created.png", "https://example.invalid/reference.svg"];
  const brief = createPresentationBrief({ bundle, narrative, audience: "Reviewers", assets });
  assert.equal(brief.sourceDigest, bundle.digest);
  for (const text of [bundle.digest, "Reviewed narrative", ...bundle.evidence.gaps, ...assets, "Expected benefits are not measured outcomes", "Do not imply deployment or delivery beyond the evidence"]) assert.ok(brief.markdown.includes(text), text);
  assert.doesNotMatch(brief.markdown, /Narrative enrichment is pending/);
});
