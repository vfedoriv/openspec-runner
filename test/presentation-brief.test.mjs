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
