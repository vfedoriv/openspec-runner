import { chmodSync, writeFileSync } from "node:fs";

export function writeGitWrapper(path, realGit, before = "") {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2), realGit = ${JSON.stringify(realGit)};
${before}
const result = cp.spawnSync(realGit, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  chmodSync(path, 0o755);
}
