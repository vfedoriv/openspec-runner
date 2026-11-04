import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomic } from "../dist/system.js";
const files = await import("../dist/platform-files.js").catch(() => ({}));

test("live reporting processes serialize short lock contention without replacing ownership", { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-lock-contention-")), marker = join(dir, "ready");
  const script = `import {locked} from ${JSON.stringify(new URL("../dist/system.js", import.meta.url).href)};import {writeFileSync} from 'node:fs';locked(${JSON.stringify(dir)},()=>{writeFileSync(${JSON.stringify(marker)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { windowsHide: true, stdio: "ignore" });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  const deadline = Date.now() + 10000;
  while (!readdirSync(dir).includes("ready") && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.equal(readFileSync(marker, "utf8"), "ready");
  const { locked } = await import("../dist/system.js");
  assert.equal(locked(dir, () => "serialized"), "serialized");
});

test("Windows replacement tolerates a bounded reader sharing lock without deleting old bytes", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-sharing-")), path = join(dir, "state.json");
  atomic(path, { revision: 1 });
  const script = `$f=[IO.File]::Open('${path.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 1500; $f.Dispose()`;
  const reader = spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { reader.kill(); rmSync(dir, { recursive: true, force: true }); });
  await once(reader.stdout, "data");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 1 });
  atomic(path, { revision: 2 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 2 });
});

test("native state replacement flushes data and can replace an existing state", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  atomic(path, { revision: 1 }); atomic(path, { revision: 2 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { revision: 2 });
  assert.equal(files.flushDirectory(dir), process.platform === "win32" ? "unsupported" : "flushed");
});

test("immutable publication cannot overwrite existing bytes and failed replacement cleans temporary files", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(typeof files.publishExclusive, "function");
  const path = join(dir, "record");
  files.publishExclusive(path, Buffer.from("original"));
  assert.throws(() => files.publishExclusive(path, Buffer.from("changed")), { code: "EEXIST" });
  assert.equal(readFileSync(path, "utf8"), "original");
  mkdirSync(join(dir, "blocked"));
  assert.throws(() => atomic(join(dir, "blocked"), { value: 1 }));
  assert.deepEqual(readdirSync(dir).sort(), ["blocked", "record"]);
});
