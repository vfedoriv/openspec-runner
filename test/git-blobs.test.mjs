import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { committedBlobs } from "../dist/openspec-context.js";
import { storePlanningFixture, git } from "./helpers/store-planning-fixture.mjs";

test("batched Git blob reads preserve exact binary bytes and request ordering", t => {
  const f = storePlanningFixture(t), bytes = Buffer.from([0, 10, 13, 255, 239, 187, 191]);
  writeFileSync(join(f.code, "binary"), bytes); writeFileSync(join(f.code, "text"), "\ufeffText\r\n");
  git(f.code, "add", "."); git(f.code, "commit", "-m", "Blob fixtures");
  const binary = git(f.code, "rev-parse", "HEAD:binary"), text = git(f.code, "rev-parse", "HEAD:text");
  const result = committedBlobs({ root: f.code, objects: [text, binary, text] });
  assert.equal(result[0].toString(), "\ufeffText\r\n"); assert.deepEqual(result[1], bytes); assert.deepEqual(result[2], result[0]);
  assert.deepEqual(committedBlobs({ root: f.code, objects: [] }), []);
  assert.throws(() => committedBlobs({ root: f.code, objects: ["HEAD\nHEAD"] }), /object|hash/i);
  assert.throws(() => committedBlobs({ root: f.code, objects: [git(f.code, "rev-parse", "HEAD")] }), /blob/i);
});
