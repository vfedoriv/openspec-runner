import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, startTerminal, attachTerminal, terminalAdapter, worktrees } from "../dist/adapters.js";
import { inspectTerminal, closeInspectedTerminal } from "../dist/terminal-cleanup.js";
import { configFrom } from "../dist/plan.js";
import { inspectOrcaWorktree } from "../dist/orca-worktrees.js";
import { installFakeOrca } from "./helpers/fake-orca.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "osr-orca-")), root = join(dir, "repo"), bin = join(dir, "bin");
  mkdirSync(root); mkdirSync(bin);
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "tracked.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  delete process.env.ORCA_TERMINAL_HANDLE;
  const fake = installFakeOrca(dir, root, bin);
  const spec = { branch: "openspec-runner/task", path: join(dir, "planned"), base };
  return { dir, root, git, base, fake, spec };
}

test("Orca config accepts both schema versions and auto-detection uses the desktop terminal handle", t => {
  const { root, fake } = fixture(t);
  for (const version of [1, 2]) {
    const config = configFrom({ version, worktrees: "orca", terminal: "orca", ...(version === 2 ? { defaultAgent: "codex", agents: { codex: { defaultModel: "session" } } } : {}) });
    assert.equal(config.worktrees, "orca"); assert.equal(config.terminal, "orca");
  }
  delete process.env.HERDR_ENV;
  process.env.ORCA = "1"; // The unrelated tmux project must not be detected.
  assert.equal(terminalAdapter(root, "auto"), "manual");
  process.env.ORCA_TERMINAL_HANDLE = "caller";
  assert.equal(terminalAdapter(root, "auto"), "orca");
  assert.equal(terminalAdapter(root, "manual"), "manual");
  fake.set({ remote: true });
  assert.throws(() => terminalAdapter(root, "orca"), /ready local/);
});

for (const partial of [false, true]) test(`Orca uses the exact base and reconciles creation (partial=${partial})`, t => {
  const { root, git, base, fake, spec } = fixture(t);
  fake.set({ failWorktreeAfterCreate: partial });
  writeFileSync(join(root, "tracked.txt"), "advanced"); git("add", "."); git("commit", "-m", "advance");
  const result = createWorktree(root, spec, "orca");
  assert.equal(result.base, base);
  assert.notEqual(result.path, spec.path);
  assert.match(result.branch, /^orca-prefix\//);
  assert.equal(readFileSync(join(result.path, "tracked.txt"), "utf8"), "base");
  assert.deepEqual(createWorktree(root, spec, "orca"), result);
  assert.deepEqual(createWorktree(root, result, "orca"), result);
  assert.equal(worktrees(root).length, 2);
  const calls = fake.calls().filter(a => a[0] === "worktree" && a[1] === "create");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf("--base-branch") + 1], base);
  assert.equal(calls[0][calls[0].indexOf("--setup") + 1], "skip");
  assert.ok(calls[0].includes("--no-parent"));
  assert.ok(!calls[0].includes("--activate"));
});

test("Orca rejects wrong bases and incomplete discovery without blindly creating another worktree", t => {
  const { root, git, fake, spec } = fixture(t);
  writeFileSync(join(root, "tracked.txt"), "advanced"); git("add", "."); git("commit", "-m", "advance");
  fake.set({ truncated: true });
  assert.throws(() => createWorktree(root, spec, "orca"), /incomplete/);
  assert.equal(worktrees(root).length, 1);
  fake.set({ truncated: false, wrongBase: true });
  assert.throws(() => createWorktree(root, spec, "orca"), /unexpected.*base/);
  assert.equal(worktrees(root).length, 2);
});

function launched(t) {
  const f = fixture(t), terminal = {}, saves = [];
  startTerminal(f.root, f.root, f.root, "test", { model: "test" }, "", terminal,
    () => saves.push(structuredClone(terminal)), "node worker.js", "codex", "orca");
  return { ...f, terminal, saves, a: { terminal, path: f.root, worker: { exitedAt: "now" } } };
}

test("Orca creates an unfocused supervised terminal once, attaches, saves output, and verifies closure", t => {
  const { root, dir, fake, terminal, saves, a } = launched(t);
  assert.equal(saves[0].phase, "creating"); assert.equal(terminal.phase, "submitted");
  assert.equal(terminal.orca.provider, "stablyai");
  const create = fake.calls().find(a => a[0] === "terminal" && a[1] === "create");
  assert.ok(!create.includes("--focus"));
  assert.match(create[create.indexOf("--command") + 1], /^exec sh -c /);
  assert.throws(() => startTerminal(root, root, root, "test", {}, "", terminal, () => {}, "true", "codex", "orca"), /already attempted/);
  assert.equal(attachTerminal(root, terminal).pane, terminal.pane);
  const inspected = inspectTerminal(root, a);
  assert.equal(inspected.blocked, undefined);
  const log = join(dir, "terminal.json");
  closeInspectedTerminal(root, a, inspected, log);
  assert.match(readFileSync(log, "utf8"), /worker finished/);
  assert.equal(inspectTerminal(root, a).closed, true);
});

test("Orca cleanup refuses live workers, other terminals, stale identities, and incomplete host coverage", t => {
  const { root, fake, terminal, a } = launched(t);
  assert.equal(inspectTerminal(root, { ...a, worker: {} }).blocked, true);
  for (const option of ["live", "missingScope", "omitLocal", "truncated"]) {
    fake.set({ [option]: true }); assert.equal(inspectTerminal(root, a).blocked, true); fake.set({ [option]: false });
  }
  const terminals = fake.state().terminals;
  fake.set({ terminals: [...terminals, { ...terminals[0], handle: "someone-else" }] });
  assert.match(inspectTerminal(root, a).reason, /Other Orca terminals/);
  fake.set({ terminals: [{ ...terminals[0], incarnationId: "replaced" }] });
  assert.match(inspectTerminal(root, a).reason, /identity changed/);
  fake.set({ terminals, runtimeId: "restarted" });
  assert.throws(() => attachTerminal(root, terminal), /runtime differs/);
  terminal.orca = { socket: "legacy-tmux" };
  assert.match(inspectTerminal(root, a).reason, /Legacy tmux/);
  assert.equal(fake.calls().some(a => a[1] === "close"), false);
});

test("Orca closure failure retains resources and worktree-only cleanup checks every terminal", t => {
  const { root, dir, fake, a, terminal } = launched(t);
  fake.set({ closeFailure: true });
  assert.throws(() => closeInspectedTerminal(root, a, inspectTerminal(root, a), join(dir, "log.json")), /not confirmed/);
  assert.equal(fake.state().terminals.length, 1);
  const workspace = { path: root, orcaWorktree: { context: terminal.orca, id: terminal.workspace } };
  assert.throws(() => inspectOrcaWorktree(root, workspace), /Other Orca terminals/);
});

test("Orca ambiguous terminal creation persists a guard against duplicate submission", t => {
  const { root, fake } = fixture(t), terminal = {};
  fake.set({ failTerminalAfterCreate: true });
  const start = () => startTerminal(root, root, root, "test", {}, "", terminal, () => {}, "true", "codex", "orca");
  assert.throws(start);
  assert.equal(terminal.phase, "creating");
  assert.throws(start, /already attempted/);
  assert.equal(fake.state().terminals.length, 1);
});
