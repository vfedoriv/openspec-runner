import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../dist/system.js";
import { resolveContext } from "../../dist/openspec-context.js";

const root = mkdtempSync(join(tmpdir(), "openspec-store-211-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
const store = join(root, "store"), code = join(root, "code");
mkdirSync(code);
const call = args => run("openspec", args, code, 30000);
const evidence = { root, version: call(["--version"]), checks: [] };
function check(name, fn) {
  try { fn(); evidence.checks.push({ name, status: "PASS" }); }
  catch (error) { evidence.checks.push({ name, status: "FAIL", error: error.message.slice(0, 1500) }); process.exitCode = 1; }
}
check("project-scope Copilot skills install", () => {
  const skillsProject = join(root, "skills-project"); mkdirSync(skillsProject);
  run("git", ["init", "-b", "main"], skillsProject);
  run("openspec", ["init", "--tools", "github-copilot", "--scope", "project", "--no-copilot-cloud", "--no-animation"], skillsProject, 30000);
  assert.ok(existsSync(join(skillsProject, ".agents/skills/openspec-propose/SKILL.md")));
});
call(["store", "setup", "runner-live", "--path", store, "--no-init-git", "--json"]);
for (const directory of [store, code]) run("git", ["init", "-b", "main"], directory);
call(["new", "change", "verify-store", "--store", "runner-live", "--json"]);
const change = join(store, "openspec/changes/verify-store");
mkdirSync(join(change, "specs/greeting"), { recursive: true });
writeFileSync(join(change, "proposal.md"), "# Store verification\n\n## Why\nVerify registered Store behavior using a disposable fixture.\n\n## What Changes\n- Add deterministic greeting capability.\n\n## Capabilities\n### New Capabilities\n- `greeting`: Emit deterministic greeting output.\n\n### Modified Capabilities\nNone.\n\n## Impact\nOnly the disposable fixture is changed.\n");
writeFileSync(join(change, "design.md"), "# Design\n\nUse a deterministic greeting in the disposable fixture.\n");
writeFileSync(join(change, "tasks.md"), "# Tasks\n\n- [x] 1.1 Verify greeting output\n");
writeFileSync(join(change, "specs/greeting/spec.md"), "## ADDED Requirements\n\n### Requirement: Deterministic greeting\nThe system SHALL emit the exact greeting `Hello Store` when the greeting command is invoked.\n\n#### Scenario: Greeting succeeds\n- **WHEN** the greeting command is invoked\n- **THEN** the output is exactly `Hello Store`\n");
check("explicit registered Store structured context", () => {
  const context = resolveContext({ cwd: code, change: "verify-store", store: "runner-live" });
  assert.equal(context.storeId, "runner-live"); assert.equal(context.planningRoot.toLowerCase(), store.toLowerCase());
});
check("missing planning root rejects without creating local planning", () => {
  assert.throws(() => call(["status", "--change", "verify-store", "--json"]));
  assert.equal(existsSync(join(code, "openspec")), false);
});
check("project Store pointer", () => {
  mkdirSync(join(code, "openspec")); writeFileSync(join(code, "openspec/config.yaml"), "store: runner-live\n");
  const status = JSON.parse(call(["status", "--change", "verify-store", "--json"]));
  assert.equal(status.root.store_id, "runner-live");
});
check("stale Store selector rejects without local fallback", () => assert.throws(() => call(["status", "--change", "verify-store", "--store", "missing-store", "--json"])));
check("strict Store validation", () => call(["validate", "verify-store", "--store", "runner-live", "--strict", "--json"]));
check("real Store archive and strict archived validation", () => {
  call(["archive", "verify-store", "--store", "runner-live", "--yes", "--json"]);
  assert.equal(existsSync(change), false);
  assert.match(readFileSync(join(store, "openspec/specs/greeting/spec.md"), "utf8"), /Deterministic greeting/);
  call(["validate", "--archived", "--store", "runner-live", "--strict", "--json"]);
});
check("archive collision preserves canonical specs", () => {
  assert.ok(readdirSync(join(store, "openspec/changes/archive")).some(name => name.endsWith("verify-store")));
  const mainSpec = join(store, "openspec/specs/greeting/spec.md"), before = readFileSync(mainSpec, "utf8");
  call(["new", "change", "verify-store", "--store", "runner-live", "--json"]);
  writeFileSync(join(change, "tasks.md"), "- [x] 1.1 Completed fixture\n");
  writeFileSync(join(change, "proposal.md"), "## Why\nVerify archive collision preflight.\n\n## What Changes\n- Modify greeting output.\n\n## Capabilities\n### Modified Capabilities\n- `greeting`: Change output.\n\n## Impact\nDisposable fixture only.\n");
  mkdirSync(join(change, "specs/greeting"), { recursive: true });
  writeFileSync(join(change, "specs/greeting/spec.md"), "## MODIFIED Requirements\n\n### Requirement: Deterministic greeting\nThe system SHALL emit the exact greeting `Hello Changed Store` when the greeting command is invoked.\n\n#### Scenario: Greeting succeeds\n- **WHEN** the greeting command is invoked\n- **THEN** the output is exactly `Hello Changed Store`\n");
  call(["validate", "verify-store", "--store", "runner-live", "--strict", "--json"]);
  assert.throws(() => call(["archive", "verify-store", "--store", "runner-live", "--yes", "--json"]), /already exists|already archived/i);
  assert.equal(readFileSync(mainSpec, "utf8"), before);
  assert.equal(existsSync(change), true);
});
writeFileSync(join(root, "result.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
