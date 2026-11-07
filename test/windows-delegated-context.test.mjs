import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const native = { skip: process.platform !== "win32" };
const helper = fileURLToPath(new URL("../bin/windows-context.ps1", import.meta.url));

function restoreEntries(journal, targets) {
  execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", helper], {
    input: JSON.stringify({ operation: "restore", sid: journal.sid, targets }), windowsHide: true,
  });
}

function fixtureAcl(target, inheritance) {
  const script = `
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$acl = Get-Acl -LiteralPath $request.path
if ($null -ne $request.inheritance) {
    $sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify',
        [Security.AccessControl.InheritanceFlags]$request.inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
    if ($request.directory) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($request.path), $acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($request.path), $acl)
    }
}
(Get-Acl -LiteralPath $request.path).GetSecurityDescriptorSddlForm('Access')`;
  return execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input: JSON.stringify({ ...target, inheritance }), encoding: "utf8", windowsHide: true,
  }).trim();
}

test("Windows context protection denies ordinary mutation and preserves unrelated runtime updates", native, async t => {
  const protection = await import("../dist/windows-context.js");
  const stateDir = mkdtempSync(join(tmpdir(), "runner-acl-"));
  const root = join(stateDir, "component-context", "feature", "assignment", "0");
  const journalPath = join(stateDir, "journal.json");
  const request = { stateDir, journalPath, roots: [{ path: root, files: [{ path: "nested folder/contract.txt", content: "approved\n" }] }] };
  t.after(() => {
    protection.restoreWindowsContext(request);
    rmSync(stateDir, { recursive: true, force: true });
  });
  protection.sealWindowsContext(request);
  protection.verifyWindowsContext(request);
  const file = join(root, "nested folder", "contract.txt");
  assert.equal(readFileSync(file, "utf8"), "approved\n");
  for (const mutate of [
    () => writeFileSync(file, "changed"),
    () => appendFileSync(file, "changed"),
    () => unlinkSync(file),
    () => renameSync(file, join(root, "renamed.txt")),
    () => renameSync(root, join(root, "..", "replacement")),
    () => writeFileSync(join(root, "injected.txt"), "changed"),
    () => mkdirSync(join(root, "injected-directory")),
  ]) assert.throws(mutate, { code: /EACCES|EPERM/ });
  const state = join(stateDir, "state.json");
  writeFileSync(state, "old");
  writeFileSync(`${state}.tmp`, "new");
  renameSync(`${state}.tmp`, state);
  assert.equal(readFileSync(state, "utf8"), "new");
  unlinkSync(state);
  protection.verifyWindowsContext(request);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const runtimeTarget = journal.targets[0];
  const fileTarget = journal.targets.find(target => target.path === file);
  const expandedRuntime = fixtureAcl(runtimeTarget, 3);
  try {
    protection.verifyWindowsContext(request);
    const inherited = fixtureAcl(fileTarget);
    const expandedFile = fixtureAcl(fileTarget, 0);
    try { assert.throws(() => protection.verifyWindowsContext(request), /Unexpected ACL/); }
    finally {
      restoreEntries(journal, [{ ...fileTarget, before: inherited, after: expandedFile }]);
    }
  } finally {
    restoreEntries(journal, [{ ...runtimeTarget, before: runtimeTarget.after, after: expandedRuntime }]);
  }
  protection.verifyWindowsContext(request);
});

test("Windows protection resumes known partial changes and preserves shared ancestor rules", native, async t => {
  const protection = await import("../dist/windows-context.js");
  const stateDir = mkdtempSync(join(tmpdir(), "runner-acl-é-"));
  const request = name => ({ stateDir, journalPath: join(stateDir, `${name}.json`),
    roots: [0, 1].map(index => ({ path: join(stateDir, "component-context", "feature", name, String(index)),
      files: [{ path: "nested/guide.md", content: `approved ${index}\n` }] })) });
  const first = request("first"), second = request("second");
  t.after(() => {
    if (existsSync(second.journalPath)) {
      const journal = JSON.parse(readFileSync(second.journalPath, "utf8"));
      restoreEntries(journal, [...journal.targets].reverse());
      rmSync(join(second.roots[0].path, ".."), { recursive: true, force: true });
    }
    protection.restoreWindowsContext(first);
    rmSync(stateDir, { recursive: true, force: true });
  });
  protection.sealWindowsContext(first);
  const journal = JSON.parse(readFileSync(first.journalPath, "utf8"));
  restoreEntries(journal, journal.targets.slice(-1));
  assert.throws(() => protection.verifyWindowsContext(first), /Unexpected ACL/);
  protection.sealWindowsContext(first);
  protection.sealWindowsContext(second);
  assert.throws(() => protection.restoreWindowsContext(first), /shared Windows context/);
  protection.verifyWindowsContext(first);
  protection.verifyWindowsContext(second);
});

test("Windows context rejects aliases and redirected ancestors before materialization", native, async t => {
  const { sealWindowsContext } = await import("../dist/windows-context.js");
  const stateDir = mkdtempSync(join(tmpdir(), "runner-acl-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const root = join(stateDir, "component-context", "feature", "assignment", "0");
  const journalPath = join(stateDir, "journal.json");
  const seal = paths => sealWindowsContext({ stateDir, journalPath, roots: [{ path: root, files: paths.map(path => ({ path, content: "approved" })) }] });
  for (const paths of [["A.txt", "a.txt"], ["file.txt:stream"], ["AUX.txt"], ["name. "], ["LONGFI~1.TXT"]])
    assert.throws(() => seal(paths), /alias|Unsafe Windows/);
  const redirect = join(stateDir, "redirect");
  mkdirSync(redirect);
  symlinkSync(redirect, join(stateDir, "component-context"), "junction");
  assert.throws(() => seal(["guide.md"]), /redirected/);
  assert.equal(existsSync(journalPath), false);
  assert.equal(existsSync(join(redirect, "feature")), false);
});

test("Windows context rejects a named stream on an assignment directory", native, async t => {
  const { sealWindowsContext } = await import("../dist/windows-context.js");
  const stateDir = mkdtempSync(join(tmpdir(), "runner-acl-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const root = join(stateDir, "component-context", "feature", "assignment", "0");
  const journalPath = join(stateDir, "journal.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}:injected`, "unexpected");
  assert.throws(() => sealWindowsContext({ stateDir, journalPath, roots: [{ path: root, files: [] }] }), /alternate data stream/);
  assert.equal(existsSync(journalPath), false);
});
