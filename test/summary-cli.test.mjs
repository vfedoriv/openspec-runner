import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { featureFixture, git } from "./helpers/feature-fixture.mjs";
const cli = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
test("summary CLI reads and exports archived evidence without starting an agent", async t => {
  const f = featureFixture(t);
  writeFileSync(join(f.root, "openspec/changes/demo/proposal.md"), `Explain results from ${f.root}`);
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Describe feature");
  f.approve(); await f.review(); f.f.approveFinal("demo", f.f.finalPreview("demo").token); f.f.archive("demo");
  const run = args => spawnSync(process.execPath, [cli, "summary", "demo", ...args, "--json"], { cwd: f.root, encoding: "utf8" });
  const read = run([]); assert.equal(read.status, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).available, true);
  const exported = run(["--export", `${f.dir}/export`]); assert.equal(exported.status, 0, exported.stderr);
  assert.ok(JSON.parse(exported.stdout).files.includes("basic.md"));
  const selected = JSON.parse(read.stdout).summary;
  const sections = Object.fromEntries(["problem", "behavior", "implementation", "verification", "limitations", "delivery"].map(k => [k, []]));
  sections.delivery = [{ text: "Selected narrative for stakeholders", evidenceIds: ["delivery"] }];
  const narrativeFile = join(f.dir, "narrative.json");
  writeFileSync(narrativeFile, JSON.stringify({ version: 1, sourceDigest: selected.sourceDigest, sections }));
  const published = spawnSync(process.execPath, [cli, "summary", "publish", "demo", "--source", selected.sourceDigest, "--file", narrativeFile, "--json"], { cwd: f.root, encoding: "utf8" });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(run(["--refresh", "--export", `${f.dir}/invalid`]).status, 1);
  const brief = run(["--presentation-brief", `${f.dir}/brief`, "--audience", "Stakeholders"]);
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(JSON.parse(brief.stdout).instruction, /provider/i);
  const markdown = readFileSync(join(f.dir, "brief", "brief.md"), "utf8");
  assert.equal(markdown.includes(f.root), false);
  assert.match(markdown, /Selected narrative for stakeholders/);
  assert.doesNotMatch(markdown, /Narrative enrichment is pending/);
  const readJson = file => JSON.parse(readFileSync(file, "utf8"));
  const fallback = readJson(join(f.dir, "brief", "provider.json"));
  assert.equal(fallback.sourceDigest, selected.sourceDigest);
  assert.equal(fallback.provider, undefined);
  assert.match(fallback.warning, /no provider was invoked/);
  assert.ok(markdown.includes(selected.sourceDigest));

  const providerDir = join(f.dir, "provider");
  mkdirSync(join(providerDir, "config"), { recursive: true });
  const marker = join(providerDir, "executed");
  const skill = join(providerDir, "SKILL.md");
  writeFileSync(skill, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const config = join(providerDir, "config", "provider.json");
  const assetsFile = join(f.dir, "assets.json");
  const assets = ["not-created/diagram.png", "https://example.invalid/chart.svg"];
  writeFileSync(assetsFile, JSON.stringify(assets));
  writeFileSync(config, JSON.stringify({ skillPath: "../SKILL.md", version: "fixture-revision" }));
  const handoffDir = join(f.dir, "handoff");
  const handoff = run(["--presentation-brief", handoffDir, "--audience", "Reviewers", "--provider-config", config, "--assets", assetsFile]);
  assert.equal(handoff.status, 0, handoff.stderr);
  const handoffResult = JSON.parse(handoff.stdout);
  assert.deepEqual(handoffResult.provider, { skillPath: skill, version: "fixture-revision" });
  assert.equal(handoffResult.sourceDigest, selected.sourceDigest);
  assert.deepEqual(readJson(join(handoffDir, "provider.json")), { sourceDigest: selected.sourceDigest, provider: handoffResult.provider });
  const handoffMarkdown = readFileSync(join(handoffDir, "brief.md"), "utf8");
  for (const text of [selected.sourceDigest, ...assets]) assert.ok(handoffMarkdown.includes(text), text);
  assert.equal(readdirSync(handoffDir).includes("diagram.png"), false);
  assert.equal(existsSync(marker), false);

  for (const [name, contents] of [["malformed", "{"], ["missing-provider", JSON.stringify({ skillPath: "absent.md" })], ["directory-provider", JSON.stringify({ skillPath: ".." })]]) {
    writeFileSync(config, contents);
    const outputDir = join(f.dir, name);
    const result = run(["--presentation-brief", outputDir, "--audience", "Reviewers", "--provider-config", config]);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout);
    assert.equal(metadata.provider, undefined);
    assert.equal(metadata.sourceDigest, selected.sourceDigest);
    assert.ok(metadata.warning);
    assert.match(metadata.instruction, /no provider was invoked/);
    assert.deepEqual(readJson(join(outputDir, "provider.json")), { sourceDigest: selected.sourceDigest, warning: metadata.warning });
    assert.ok(readFileSync(join(outputDir, "brief.md"), "utf8").includes(selected.sourceDigest));
    assert.equal(existsSync(marker), false);
  }
  const missingConfig = run(["--presentation-brief", join(f.dir, "missing-config"), "--audience", "Reviewers", "--provider-config", join(providerDir, "absent.json")]);
  assert.equal(missingConfig.status, 0, missingConfig.stderr);
  assert.match(JSON.parse(missingConfig.stdout).warning, /ENOENT/);

  for (const [index, contents] of ["{", "{}", '[1]', '[" "]', '[null]'].entries()) {
    writeFileSync(assetsFile, contents);
    const outputDir = join(f.dir, `invalid-assets-${index}`);
    const result = run(["--presentation-brief", outputDir, "--audience", "Reviewers", "--assets", assetsFile]);
    assert.equal(result.status, 1, contents);
    assert.equal(existsSync(outputDir), false);
  }
});
