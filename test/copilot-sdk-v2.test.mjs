import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
test("Copilot probe requires explicit v2 spawned runtime, worker cwd and inherited config without sessions", async t => {
  const root = mkdtempSync(join(tmpdir(), "copilot-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = join(root, "node_modules/@microsoft/copilot-sdk"), marker = join(root, "session-marker");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(sdk, "package.json"), '{"type":"module","exports":"./index.js"}');
  writeFileSync(join(sdk, "index.js"), `
    import assert from 'node:assert/strict';
    import {writeFileSync} from 'node:fs';
    export const RuntimeConnection = {forSpawnedStdio(options) {
      assert.deepEqual(options, {path:'/absolute/copilot',workingDirectory:process.cwd()});
      return {...options,kind:'spawned-stdio'};
    }};
    export class CopilotClient {
      constructor(options) {
        assert.deepEqual(Object.keys(options).sort(), ['mode','runtime']);
        assert.equal(options.mode,'coding-agent');
        assert.equal(options.runtime.kind,'spawned-stdio');
        assert.equal(process.env.COPILOT_HOME, '/fixture/config');
      }
      async start() {}
      async listModels() {return [{id:'exact-selector',name:'Fixture'}];}
      async stop() {return [];}
      async createSession() {writeFileSync(${JSON.stringify(marker)},'session');throw Error('No sessions');}
    }
  `);
  const probe = join(root, "probe.js");
  copyFileSync(new URL("../dist/harnesses/copilot-model-probe.js", import.meta.url), probe);
  // Positive control proves the marker detects session creation.
  const { CopilotClient } = await import(pathToFileURL(join(sdk, "index.js")));
  await assert.rejects(CopilotClient.prototype.createSession(), /No sessions/);
  assert.equal(readFileSync(marker, "utf8"), "session");
  rmSync(marker);
  const {stdout,stderr} = await execute(process.execPath, [probe, "/absolute/copilot"], {cwd:root,env:{...process.env,COPILOT_HOME:'/fixture/config'}});
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), [{id:'exact-selector',name:'Fixture'}]);
  assert.throws(() => readFileSync(marker), {code:'ENOENT'});
});

test("Published SDK pin preserves optional installation and the existing Node floor", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(manifest.optionalDependencies["@microsoft/copilot-sdk"], "2.0.1");
  assert.equal(manifest.optionalDependencies["@github/copilot-sdk"], undefined);
  assert.equal(manifest.engines.node, ">=22.13");
});
