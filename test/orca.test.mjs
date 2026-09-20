import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, startTerminal, attachTerminal, terminalAdapter, worktrees } from "../dist/adapters.js";
import { inspectTerminal, closeInspectedTerminal } from "../dist/terminal-cleanup.js";
import { configFrom } from "../dist/plan.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "osr-orca-"));
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "base");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const bin = join(root, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  return { root, bin, git, base };
}

function helper(bin, mode = "success") {
  const file = join(bin, "orca-worktree");
  writeFileSync(file, `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const slug=process.argv[3];
if(process.argv[2]!=='create') process.exit(2);
const target=path.join(process.env.ORCA_ROOT,'.orca','worktree',slug);
fs.appendFileSync('.gitignore','\\n.orca/\\n');
fs.mkdirSync(path.dirname(target),{recursive:true});
execFileSync('git',['worktree','add',target,'-b','orca-'+slug${mode === "wrong-base" ? ",'main'" : ""}],{stdio:'pipe'});
${mode === "partial" ? "process.exit(1);" : "console.log(target);"}
`);
  chmodSync(file, 0o755);
}

test("Orca config is accepted in both schema versions; explicit sessions fail closed", () => {
  for (const version of [1, 2]) {
    const config = configFrom({ version, worktrees: "orca", terminal: "orca", ...(version === 2 ? { defaultAgent: "codex", agents: { codex: { defaultModel: "session" } } } : {}) });
    assert.equal(config.worktrees, "orca");
    assert.equal(config.terminal, "orca");
  }
  const old = process.env.ORCA;
  delete process.env.ORCA;
  try { assert.throws(() => terminalAdapter(process.cwd(), "orca"), /existing.*orca session/); }
  finally { if (old !== undefined) process.env.ORCA = old; }
});

for (const mode of ["success", "partial"]) test(`Orca worktrees preserve the requested base and recover ${mode} creation`, t => {
  const { root, bin, git, base } = fixture(t);
  helper(bin, mode);
  writeFileSync(join(root, "tracked.txt"), "new HEAD");
  git("add", "tracked.txt"); git("commit", "-m", "advance");
  const spec = { branch: "openspec-runner/demo/task-1", path: join(root, ".openspec-runner", "worktrees", "task with spaces"), base };
  const result = createWorktree(root, spec, "orca");
  assert.deepEqual(result, spec);
  assert.equal(git("rev-parse", spec.branch), base);
  assert.equal(readFileSync(join(spec.path, "tracked.txt"), "utf8"), "base");
  assert.equal(existsSync(join(root, ".gitignore")), false);
  assert.equal(existsSync(join(spec.path, ".gitignore")), false);
  assert.deepEqual(createWorktree(root, spec, "orca"), spec);
  assert.equal(worktrees(root).length, 2);
  assert.equal(git("branch", "--list", "orca-*"), "");
});

test("Orca refuses a helper-created wrong base without adopting or deleting it", t => {
  const { root, bin, git, base } = fixture(t);
  helper(bin, "wrong-base");
  writeFileSync(join(root, "tracked.txt"), "new HEAD");
  git("add", "tracked.txt"); git("commit", "-m", "advance");
  assert.throws(() => createWorktree(root, { branch: "task", path: join(root, "task"), base }, "orca"), /unexpected.*base/);
  assert.equal(worktrees(root).length, 2);
  assert.equal(existsSync(join(root, "task")), false);
});

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch {}

test("Orca launches once in a real tmux session, attaches, and cleans only its exited pane", { skip: !hasTmux }, async t => {
  let tmux;
  t.after(() => { try { tmux("kill-server"); } catch {} });
  const { root } = fixture(t);
  const socket = join(root, "tmux.sock");
  tmux = (...args) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "orca-test", "sleep", "300");
  process.env.ORCA = "1";
  process.env.ORCA_SESSION = "orca-test";
  process.env.TMUX = `${socket},${tmux("display-message", "-p", "-t", "orca-test", "#{pid}")},0`;
  process.env.TMUX_PANE = tmux("display-message", "-p", "-t", "orca-test", "#{pane_id}");
  assert.equal(terminalAdapter(root, "auto"), "orca");
  const terminal = {}, saves = [];
  startTerminal(root, root, root, "test", { model: "test" }, "", terminal,
    () => saves.push(structuredClone(terminal)), "printf '%s' \"$ORCA\" > hook-env; sleep 0.3; echo finished", "codex", "orca");
  assert.equal(saves[0].phase, "creating");
  assert.equal(terminal.backend, "orca");
  assert.equal(terminal.phase, "submitted");
  assert.throws(() => startTerminal(root, root, root, "test", {}, "", terminal, () => {}, "true", "codex", "orca"), /already attempted/);
  assert.equal(attachTerminal(root, terminal).pane, terminal.pane);
  const a = { terminal, path: root, worker: { exitedAt: "now" } };
  assert.equal(inspectTerminal(root, { ...a, worker: {} }).blocked, true);
  for (let i = 0; i < 100 && tmux("display-message", "-p", "-t", terminal.pane, "#{pane_dead}") !== "1"; i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(readFileSync(join(root, "hook-env"), "utf8"), "0");
  const inspected = inspectTerminal(root, a);
  assert.equal(inspected.blocked, undefined);
  const context = terminal.orca;
  terminal.orca = { ...context, server: "0" };
  assert.equal(inspectTerminal(root, a).blocked, true);
  assert.throws(() => attachTerminal(root, terminal), /differs/);
  terminal.orca = context;
  const log = join(root, "terminal.json");
  closeInspectedTerminal(root, a, inspected, log);
  assert.match(readFileSync(log, "utf8"), /finished/);
  assert.equal(inspectTerminal(root, a).closed, true);
  assert.equal(tmux("list-panes", "-s", "-t", "orca-test", "-F", "#{pane_id}"), process.env.TMUX_PANE);
});
