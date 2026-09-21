import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "../dist/runner.js";
import { Feature } from "../dist/feature.js";
import { readiness } from "../dist/plan.js";
function run(cwd, cmd, args) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENSPEC_TELEMETRY: "0", DO_NOT_TRACK: "1" },
  }).trim();
}
let available = true;
try {
  run(tmpdir(), "openspec", ["--version"]);
} catch {
  available = false;
}
test(
  "real unmodified OpenSpec creation, managed review, validation and archival remain compatible",
  { skip: !available },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "runner real openspec "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...a) => run(root, "git", a),
      os = (...a) => run(root, "openspec", a);
    git("init", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    os("init", "--tools", "none");
    os("new", "change", "runner-acceptance");
    const dir = join(root, "openspec/changes/runner-acceptance");
    writeFileSync(
      join(dir, "proposal.md"),
      "## Why\nVerify companion interoperability.\n\n## What Changes\n- Add acceptance output.\n\n## Capabilities\n\n### New Capabilities\n- `runner-output`: Acceptance output.\n\n### Modified Capabilities\n\n## Impact\nTemporary test only.\n",
    );
    writeFileSync(
      join(dir, "design.md"),
      "## Context\nTemporary companion acceptance.\n\n## Goals / Non-Goals\nVerify integration.\n\n## Decisions\nUse one output file.\n\n## Risks / Trade-offs\nNone for the temporary fixture.\n",
    );
    mkdirSync(join(dir, "specs/runner-output"), { recursive: true });
    writeFileSync(
      join(dir, "specs/runner-output/spec.md"),
      "## ADDED Requirements\n\n### Requirement: Output\nThe system SHALL write an acceptance output.\n\n#### Scenario: Generate output\n- **WHEN** the task runs\n- **THEN** an output file exists\n",
    );
    writeFileSync(
      join(dir, "tasks.md"),
      "## 1. Implementation\n- [ ] 1.1 Write acceptance output\n",
    );
    writeFileSync(
      join(dir, "execution.yaml"),
      'version: 1\ntasks:\n  "1.1": {}\n',
    );
    writeFileSync(
      join(root, "openspec/runner.yaml"),
      "version: 1\nworktrees: git\nterminal: manual\n",
    );
    assert.equal(
      readiness(root, "runner-acceptance").instructions.state,
      "ready",
    );
    os("validate", "runner-acceptance", "--strict", "--json");
    git("add", ".");
    git("commit", "-m", "plan");
    const r = new Runner(root),
      a = r.launch("runner-acceptance", ["1.1"], {
        model: "test-model",
        reasoningEffort: "low",
      })[0],
      w = new Runner(a.path);
    w.begin("runner-acceptance", "1.1", a.id, "acceptance");
    writeFileSync(join(a.path, "output.txt"), "acceptance\n");
    run(a.path, "git", ["add", "output.txt"]);
    run(a.path, "git", ["commit", "-m", "output"]);
    w.report("runner-acceptance", "1.1", a.id, {
      attempt: a.id,
      task: "1.1",
      session: "acceptance",
      outcome: "completed",
      commit: run(a.path, "git", ["rev-parse", "HEAD"]),
      summary: "Wrote output",
      verification: ["Read output.txt: acceptance"],
    });
    const result = r.integrate("runner-acceptance", ["1.1"]);
    assert.match(
      readFileSync(
        join(result.path, "openspec/changes/runner-acceptance/tasks.md"),
        "utf8",
      ),
      /\[x\]/,
    );
    run(result.path, "openspec", [
      "validate",
      "runner-acceptance",
      "--strict",
      "--json",
    ]);
    const feature = new Feature(root);
    feature.start("runner-acceptance", true);
    const role = { harness: "codex", model: "test-model", effort: "high" };
    const settings = { implementation: role, review: role, repair: role };
    feature.approve("runner-acceptance", settings, feature.planPreview("runner-acceptance", settings).token);
    const fakeBin = mkdtempSync(join(tmpdir(), "openspec reviewer "));
    const previousPath = process.env.PATH;
    t.after(() => { process.env.PATH = previousPath; rmSync(fakeBin, { recursive: true, force: true }); });
    const codex = join(fakeBin, "codex");
    writeFileSync(codex, `#!/usr/bin/env node
if (process.argv.includes('--help')) { console.log('--add-dir --model --cd'); process.exit(0); }
(async () => {
  const { Feature } = await import(${JSON.stringify(new URL("../dist/feature.js", import.meta.url).href)});
  const f = new Feature(), change = 'runner-acceptance', j = f.read(change).jobs.at(-1);
  f.begin(change, j.id, 'acceptance-review');
  f.report(change, j.id, { attempt: j.id, session: 'acceptance-review', outcome: 'completed',
    head: j.base, fingerprint: j.fingerprint, summary: 'Acceptance review', findings: [], verification: ['Read acceptance output'] });
})().catch(e => { console.error(e); process.exitCode = 1; });
`);
    chmodSync(codex, 0o755);
    process.env.PATH = fakeBin + ":" + previousPath;
    const review = feature.launch("runner-acceptance", "review");
    assert.equal((await feature.worker("runner-acceptance", review.id)).exitCode, 0);
    feature.approveFinal("runner-acceptance", feature.finalPreview("runner-acceptance").token);
    const archived = feature.archive("runner-acceptance");
    assert.equal(archived.completed, true);
    assert.equal(new Feature(result.path).status("runner-acceptance").phase, "completed");
  },
);
