import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./helpers/run-tests.mjs", import.meta.url));

test("test watchdog fails and returns when synchronous work blocks a file", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-watchdog-")), file = join(dir, "blocking.test.mjs");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, `import test from "node:test";
test("blocking", () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000));
`);
  const result = spawnSync(process.execPath, [runner, file], {
    encoding: "utf8", timeout: 3000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, OPENSPEC_TEST_TIMEOUT_MS: "200" },
  });
  assert.equal(result.error, undefined, "Parent watchdog must return before the outer safety timeout");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Test file exceeded 200ms/);
  assert.match(result.stderr, /\[tests\] started/);
});

test("test runner preserves passing and failing test exit codes", t => {
  const dir = mkdtempSync(join(tmpdir(), "runner-exit-")), file = join(dir, "result.test.mjs");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const fail of [false, true]) {
    writeFileSync(file, `import test from "node:test"; test("result", () => { ${fail ? 'throw new Error("Expected failure");' : ""} });`);
    const result = spawnSync(process.execPath, [runner, file], {
      encoding: "utf8", timeout: 3000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, OPENSPEC_TEST_TIMEOUT_MS: "1000" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, fail ? 1 : 0);
    assert.match(result.stdout, fail ? /Expected failure/ : /pass 1/);
  }
});
