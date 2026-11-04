import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const platform = await import("../dist/platform-command.js").catch(() => ({}));
const literals = ["a b", "x&y", "$HOME", "%PATH%", "a!b", "quote'\"", "✓", "first\nsecond"];

test("Windows rejects wrappers whose environment or fixed arguments would be lost", { skip: process.platform !== "win32" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-custom-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "entry.js"), "console.log('wrong semantics')");
  for (const text of ['set REQUIRED=1\nnode "%~dp0entry.js" --fixed %*', 'rem "%~dp0entry.js"\nother.exe %*']) {
    writeFileSync(join(dir, "custom.cmd"), text);
    assert.throws(() => platform.resolveCommand({ executable: join(dir, "custom.cmd"), args: [], cwd: dir }), /Unsupported Windows command wrapper/);
  }
});

test("Windows installed hooks pin the invoking runner and Node entry points", { skip: process.platform !== "win32" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-hook-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", dir], { stdio: "ignore" });
  const { init } = await import("../dist/cli.js");
  init(dir, "copilot", undefined, "model");
  const config = JSON.parse(readFileSync(join(dir, ".github/hooks/openspec-runner.json"), "utf8"));
  const command = config.hooks.UserPromptSubmit[0].powershell;
  assert.ok(command.includes(process.execPath));
  assert.ok(command.includes("openspec-runner.js"));
  assert.equal(command.includes("GetEnvironmentVariable"), false);
});

test("Windows recognizes Copilot bundled with the selected VS Code installation", { skip: process.platform !== "win32" }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "runner editor "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "version/resources/app/out"), { recursive: true });
  mkdirSync(join(dir, "version/resources/app/extensions/copilot"), { recursive: true });
  copyFileSync(process.execPath, join(dir, "Code.exe"));
  writeFileSync(join(dir, "bin/code.cmd"), '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\version\\resources\\app\\out\\cli.js" %*\r\n');
  writeFileSync(join(dir, "version/resources/app/out/cli.js"), "console.log(process.argv.includes('--list-extensions') ? '' : '--mode --new-window 1.144.0');");
  writeFileSync(join(dir, "version/resources/app/extensions/copilot/package.json"), JSON.stringify({ publisher: "GitHub", name: "copilot-chat" }));
  const { copilotVscodeHarness } = await import("../dist/harnesses/copilot-vscode.js");
  const capability = await copilotVscodeHarness.capabilities(dir, { options: { executable: join(dir, "bin/code.cmd") } });
  assert.equal(capability.supported, true, capability.reasons.join("; "));
});

test("PowerShell 7 rendered commands round trip literal argv", { skip: process.platform !== "win32" }, () => {
  const source = platform.renderCommand([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...literals], "powershell");
  const result = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(result), literals);
});

test("native command resolution preserves literal argv without a shell", () => {
  assert.equal(typeof platform.resolveCommand, "function");
  const command = platform.resolveCommand({ executable: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...literals], cwd: process.cwd() });
  const output = execFileSync(command.executable, command.args, { cwd: process.cwd(), env: command.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), literals);
});

test("Windows resolves a Node CLI shim to its script instead of interpreting cmd syntax", { skip: process.platform !== "win32" }, t => {
  assert.equal(typeof platform.resolveCommand, "function");
  const dir = mkdtempSync(join(tmpdir(), "runner-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "entry.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(dir, "tool.cmd"), '@echo off\r\nnode "%~dp0entry.js" %*\r\n');
  const command = platform.resolveCommand({ executable: "tool", args: literals, cwd: dir, env: { ...process.env, PATH: dir + ";" + process.env.PATH } });
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(JSON.parse(execFileSync(command.executable, command.args, { env: command.env, encoding: "utf8" })), literals);
});

test("PowerShell command rendering preserves quoted arguments and uses a call operator", () => {
  assert.equal(typeof platform.renderCommand, "function");
  assert.equal(platform.renderCommand(["C:\\Program Files\\tool.exe", "a'b", "$HOME"], "powershell"), "& 'C:\\Program Files\\tool.exe' 'a''b' '$HOME'");
});
