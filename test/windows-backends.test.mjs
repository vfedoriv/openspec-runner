import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { createWorktree, terminalAdapter, startTerminal, attachTerminal } from "../dist/adapters.js";
import { inspectTerminal, closeInspectedTerminal } from "../dist/terminal-cleanup.js";
import { shellCommand } from "../dist/system.js";

test("Herdr acknowledges a successful pane run with empty stdout", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-herdr-ack-")), bin = join(dir, "bin"); mkdirSync(bin);
  const original = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); rmSync(dir, { recursive: true, force: true }); });
  process.env.PATH = bin + delimiter + process.env.PATH; process.env.HERDR_ENV = "1"; process.env.HERDR_SESSION = "test";
  const tool = join(bin, "herdr");
  writeFileSync(tool, '#!/usr/bin/env node\nif(process.argv[2]==="workspace") console.log(JSON.stringify({result:{workspace:{workspace_id:"w"},root_pane:{pane_id:"w:p",terminal_id:"t"}}}));');
  chmodSync(tool, 0o755);
  const terminal = {};
  startTerminal(dir, dir, dir, "test", {}, "", terminal, () => {}, "echo test");
  assert.equal(terminal.phase, "submitted");
});

test("Herdr focuses an owned raw-worker tab without requiring a recognized agent", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-herdr-focus-")), bin = join(dir, "bin"); mkdirSync(bin);
  const original = { ...process.env }, calls = join(dir, "calls.jsonl"), count = join(dir, "count");
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); rmSync(dir, { recursive: true, force: true }); });
  process.env.PATH = bin + delimiter + process.env.PATH; process.env.HERDR_ENV = "1"; process.env.HERDR_SESSION = "test";
  writeFileSync(count, "1");
  const tool = join(bin, "herdr");
  writeFileSync(tool, `#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(a[0]==='agent')console.log(JSON.stringify({error:{code:'agent_not_found'}}));else console.log(JSON.stringify({result:a[1]==='get'?(a[0]==='pane'?{pane:{pane_id:'w:p',workspace_id:'w',tab_id:'w:t',terminal_id:'t'}}:{tab:{tab_id:'w:t',workspace_id:'w',pane_count:Number(fs.readFileSync(${JSON.stringify(count)},'utf8'))}}):{type:'ok'}}));`);
  chmodSync(tool, 0o755);
  const terminal = { pane: "w:p", workspace: "w", terminal: "t", owned: true, sessionContext: "test" };
  assert.equal(attachTerminal(dir, terminal).pane, "w:p");
  const operations = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(operations.some(a => a.join(" ") === "tab focus w:t"));
  assert.equal(operations.some(a => a[1] === "run"), false);
  writeFileSync(count, "2");
  assert.throws(() => attachTerminal(dir, terminal), /multiple|split|exact.*pane/i);
});

test("Herdr cleanup uses supported process-info options and preserves raw scrollback", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-herdr-cleanup-")), bin = join(dir, "bin"); mkdirSync(bin);
  const original = { ...process.env }, closed = join(dir, "closed");
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); rmSync(dir, { recursive: true, force: true }); });
  process.env.PATH = bin + delimiter + process.env.PATH; process.env.HERDR_ENV = "1"; process.env.HERDR_SESSION = "test";
  const tool = join(bin, "herdr");
  writeFileSync(tool, `#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2);if(a.includes('--help'))console.log('--pane ID');else if(a[1]==='read')console.log('raw scrollback ✓');else if(a[1]==='process-info'&&a[2]!=='--pane')process.exit(2);else{if(a[1]==='close')fs.writeFileSync(${JSON.stringify(closed)},'yes');console.log(JSON.stringify({result:a[1]==='list'?{panes:fs.existsSync(${JSON.stringify(closed)})?[]:[{pane_id:'w:p',terminal_id:'t',workspace_id:'w',cwd:${JSON.stringify(dir)}}]}:a[1]==='process-info'?{process_info:{pane_id:'w:p',shell_pid:${process.pid},foreground_processes:[]}}:{type:'ok'}}));}`);
  chmodSync(tool, 0o755);
  const attempt = { terminal: { pane: "w:p", workspace: "w", terminal: "t", owned: true, sessionContext: "test" }, path: dir, worker: { exitedAt: "now" } };
  const inspection = inspectTerminal(dir, attempt);
  assert.equal(inspection.blocked, undefined, inspection.reason);
  const log = join(dir, "scrollback.json"); closeInspectedTerminal(dir, attempt, inspection, log);
  assert.match(readFileSync(log, "utf8"), /raw scrollback ✓/);
  assert.equal(inspectTerminal(dir, attempt).closed, true);
});

test("Windows Worktrunk uses git-wt without invoking the Windows Terminal alias", { skip: process.platform !== "win32" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "runner native backends ")), root = join(dir, "repo"), bin = join(dir, "bin"), calls = join(dir, "calls.json");
  mkdirSync(root); mkdirSync(bin);
  const old = process.env.PATH; process.env.PATH = bin + delimiter + old;
  t.after(() => { process.env.PATH = old; rmSync(dir, { recursive: true, force: true }); });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "base.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  writeFileSync(join(bin, "wt"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, "wrong-tool"))},'wrong');process.exit(99);`);
  writeFileSync(join(bin, "git-wt"), `#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args.includes('--help')) console.log('--no-hooks --format --base --create --path');else{require('node:fs').writeFileSync(${JSON.stringify(calls)},JSON.stringify(args));require('node:child_process').execFileSync('git',['worktree','add','-b',args[args.indexOf('--create')+1],args[args.indexOf('--path')+1],args[args.indexOf('--base')+1]],{stdio:'ignore'});console.log('{}');}`);
  const spec = { branch: "runner-test", path: join(dir, "assigned worktree"), base: git("rev-parse", "HEAD") };
  const result = createWorktree(root, spec, "worktrunk");
  assert.equal(result.path, spec.path);
  assert.equal(existsSync(join(dir, "wrong-tool")), false);
  assert.ok(JSON.parse(readFileSync(calls, "utf8")).includes("--no-hooks"));
  assert.deepEqual(createWorktree(root, spec, "worktrunk"), result);
});

test("native terminal commands preserve literal arguments and worker exit status", { skip: process.platform !== "win32" }, async t => {
  const module = await import("../dist/backend-command.js").catch(() => ({}));
  assert.equal(typeof module.terminalCommand, "function");
  const dir = mkdtempSync(join(tmpdir(), "runner native argv "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const values = ["a b", "x&y", "$HOME", "%PATH%", "a!b", "quote'\"", "✓", "first\nsecond"];
  const command = shellCommand([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)));process.exitCode=7", ...values]);
  for (const backend of ["herdr", "orca"]) {
    const invocation = module.terminalCommand(command, backend);
    if (backend === "orca") assert.equal(invocation.shell, "pwsh.exe");
    const source = invocation.command + (backend === "herdr" ? "; exit $LASTEXITCODE" : "");
    try { execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { encoding: "utf8" }); assert.fail("worker must exit seven"); }
    catch (error) { assert.equal(error.status, 7); assert.deepEqual(JSON.parse(error.stdout), values); }
  }
});

test("Windows Herdr selection retains the actual caller-session precondition", { skip: process.platform !== "win32" }, () => {
  const prior = process.env.HERDR_ENV; delete process.env.HERDR_ENV;
  try { assert.throws(() => terminalAdapter(process.cwd(), "herdr"), /HERDR_ENV/); }
  finally { if (prior !== undefined) process.env.HERDR_ENV = prior; }
});
