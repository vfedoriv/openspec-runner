import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

test("installed git-wt acceptance always uses its isolated config and pinned executable", t => {
  const bin = mkdtempSync(join(tmpdir(), "runner-wt-isolation-")), tool = join(bin, "git-wt");
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(tool, `#!/usr/bin/env node
const cp=require('node:child_process'),a=process.argv.slice(2);
if(a.includes('--version')) console.log('wt v0.78.0');
else if(a.includes('--help')) console.log('--no-hooks --format --base --create --path');
else {
 if(!a.includes('--config')) {console.error('isolated config was bypassed');process.exit(21);}
 cp.execFileSync('git',['worktree','add','-b',a[a.indexOf('--create')+1],a[a.indexOf('--path')+1],a[a.indexOf('--base')+1]],{stdio:'ignore'});
 console.log('{}');
}`);
  chmodSync(tool, 0o755);
  const result = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("./worktrunk.test.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, PATH: bin + delimiter + process.env.PATH },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pass 1\b/);
});
