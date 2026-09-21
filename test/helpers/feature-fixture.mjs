import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Feature } from "../../dist/feature.js";
import { Runner } from "../../dist/runner.js";

export const featureSettings = { implementation: { harness: "codex", model: "test-model", effort: "high" },
  review: { harness: "codex", model: "test-model", effort: "high" },
  repair: { harness: "codex", model: "test-model", effort: "high" }, maxFixRounds: 2 };
export const blocker = { id: "F1", category: "correctness", location: "output.txt:1", impact: "Wrong output", correction: "Repair the output" };
export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export function executable(path, source) { writeFileSync(path, `#!/usr/bin/env node\n${source}`); chmodSync(path, 0o755); }

export function featureFixture(t, options = {}) {
  const previousPath = process.env.PATH;
  const dir = mkdtempSync(join(tmpdir(), "managed feature "));
  const root = join(dir, "repo with spaces"), bin = join(dir, "bin"), controlPath = join(dir, "control.json");
  mkdirSync(root); mkdirSync(bin); writeFileSync(controlPath, "{}");
  const savedEnv = Object.fromEntries(["HERDR_ENV", "ORCA_TERMINAL_HANDLE", "CODEX_THREAD_ID"].map(k => [k, process.env[k]]));
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Feature Test"); git(root, "config", "user.email", "feature@example.invalid");
  mkdirSync(join(root, "openspec/changes/demo"), { recursive: true });
  writeFileSync(join(root, "openspec/runner.yaml"), JSON.stringify({ version: 1, worktrees: "git", terminal: "manual", cleanup: "manual",
    verifyIntegration: options.checks ?? [] }));
  writeFileSync(join(root, "openspec/changes/demo/tasks.md"), `- [${options.unchecked ? " " : "x"}] 1.1 Produce output\n`);
  writeFileSync(join(root, "openspec/changes/demo/execution.yaml"), 'version: 1\ntasks:\n  "1.1": {}\n');
  writeFileSync(join(root, "output.txt"), "base\n");
  git(root, "add", "."); git(root, "commit", "-m", "Plan feature");
  executable(join(bin, "openspec"), `
const fs = require('node:fs'), path = require('node:path');
const file = ${JSON.stringify(controlPath)}, control = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'archive') {
  control.archiveCalls = (control.archiveCalls || 0) + 1; fs.writeFileSync(file, JSON.stringify(control));
  const target = path.join('openspec/changes/archive', '2026-09-20-' + args[1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join('openspec/changes', args[1]), target);
  fs.mkdirSync('openspec/specs/demo', { recursive: true }); fs.writeFileSync('openspec/specs/demo/spec.md', 'Synchronized specification\\n');
  if (control.archiveExtraFile) fs.writeFileSync('unexpected.txt', 'unexpected');
  if (control.archiveCrash) process.exit(1);
  console.log(JSON.stringify({ archived: target }));
} else if (args[0] === 'validate') {
  if (control.failValidation) process.exit(1);
  console.log(JSON.stringify({ valid: true }));
} else console.log(JSON.stringify(args[0] === 'status' ? { artifacts: [] } : { state: 'ready' }));
`);
  const worker = `
const fs = require('node:fs'), cp = require('node:child_process');
if (process.argv.includes('--help')) { console.log('-p --output-format stream-json --verbose --model --session-id --resume --permission-mode --add-dir --allowedTools --effort (low, medium, high) --cd'); process.exit(0); }
if (process.argv.includes('--version')) { console.log('test-cli'); process.exit(0); }
(async () => {
  const { Feature } = await import(${JSON.stringify(new URL("../../dist/feature.js", import.meta.url).href)});
  const f = new Feature();
  const state = f.read('demo'), job = state.jobs.at(-1);
  const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
  const session = job.expectedSession || 'test-' + job.id;
  process.env.CODEX_THREAD_ID = session;
  f.begin('demo', job.id, session);
  if (control.skipReport) return;
  const report = { attempt: job.id, session: control.wrongSession ? 'wrong-session' : session,
    outcome: control.outcome || 'completed', head: job.base, fingerprint: job.fingerprint,
    summary: 'Checked feature', verification: ['Verified fixture behavior'] };
  if (job.role === 'review') {
    report.findings = control.findings || [];
    if (control.reviewerEdit) fs.writeFileSync('output.txt', 'Reviewer edit\\n');
  } else if (report.outcome === 'completed') {
    fs.writeFileSync(control.editPlan ? 'openspec/changes/demo/tasks.md' : 'output.txt', 'repair ' + job.round + '\\n');
    cp.execFileSync('git', ['add', '.']); cp.execFileSync('git', ['commit', '-m', 'Repair']);
    report.commit = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  f.report('demo', job.id, report);
  if (job.agent === 'claude') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: session }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, is_error: false }));
  }
  process.exitCode = control.exitCode || 0;
})().catch(e => { console.error(e.message); process.exitCode = 1; });
`;
  executable(join(bin, "codex"), worker); executable(join(bin, "claude"), worker);
  const f = new Feature(root), r = new Runner(root);
  const getControl = () => JSON.parse(readFileSync(controlPath, "utf8"));
  const control = patch => writeFileSync(controlPath, JSON.stringify({ ...getControl(), ...patch }));
  const approve = (settings = featureSettings) => {
    f.start("demo"); const preview = f.planPreview("demo", settings); f.approve("demo", settings, preview.token); return preview;
  };
  const review = async () => { const job = f.launch("demo", "review"); await f.worker("demo", job.id); return job; };
  return { dir, root, bin, controlPath, f, r, control, getControl, approve, review };
}
