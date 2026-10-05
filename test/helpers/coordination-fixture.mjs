import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { featureFixture, featureSettings, git, executable, blocker } from "./feature-fixture.mjs";
import { execFileSync } from "node:child_process";
import { Coordination } from "../../dist/coordination.js";
import { Component } from "../../dist/component.js";
import { Feature } from "../../dist/feature.js";

export function coordinationFixture(t, options = {}) {
  let dir;
  const unlock = path => { const stat = lstatSync(path); if (stat.isSymbolicLink()) return; chmodSync(path, stat.isDirectory() ? 0o755 : 0o644); if (stat.isDirectory()) for (const child of readdirSync(path)) unlock(join(path, child)); };
  const f = featureFixture({ after(cleanup) { t.after(() => { if (dir) unlock(dir); cleanup(); }); } }, { unchecked: options.unchecked ?? true, checks: options.checks ?? [] });
  dir = f.dir;
  git(f.root, "config", "openspec-runner.repository", "api");
  const storeRoot = join(f.dir, "store"); mkdirSync(storeRoot);
  git(storeRoot, "init", "-b", "coordination"); git(storeRoot, "config", "user.name", "Test"); git(storeRoot, "config", "user.email", "test@example.test");
  git(storeRoot, "config", "openspec-runner.repository", "contracts");
  mkdirSync(join(storeRoot, "openspec/changes/shared"), { recursive: true });
  writeFileSync(join(storeRoot, "openspec/changes/shared/tasks.md"), "- [ ] 1.1 Deliver API\n");
  writeFileSync(join(storeRoot, "AGENTS.md"), "Shared guidance\n");
  git(storeRoot, "add", "."); git(storeRoot, "commit", "-m", "Contract");
  const repositories = { api: f.root, contracts: storeRoot };
  const c = new Coordination({ root: storeRoot, featureId: "feature", repositories });
  const context = { implementationRoot: f.root, planningRoot: storeRoot, changeRoot: join(storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] };
  const contract = { context, repository: "contracts" };
  const manifest = { version: 1, featureId: "feature", storeId: "team", sharedChange: "shared", coordinationBranch: "coordination", components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [], settings: { ...featureSettings, tasks: {}, verifyIntegration: options.checks ?? [], setup: [] } } }, taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  options.configureManifest?.(manifest);
  c.init({ manifest, contract, expectedHead: git(storeRoot, "rev-parse", "HEAD"), operationId: "init" });
  const approve = (id = "approval", extra = {}) => {
    const p = c.approvalPreview({ contract });
    c.approve({ contract, token: p.token, approvedBy: "user", id, operationId: `op-${id}`, expectedHead: git(storeRoot, "rev-parse", "HEAD"), ...extra }); return p;
  };
  const assign = () => { const p = c.assignmentPreview({ componentId: "api", owner: "alice", contract }); return c.assign({ componentId: "api", owner: "alice", contract, token: p.token, id: "assignment", operationId: "op-assignment", expectedHead: git(storeRoot, "rev-parse", "HEAD") }); };
  const imported = () => { approve(); assign(); const component = new Component({ root: f.root, repository: "api" }); const input = { storeRoot, featureId: "feature", assignmentId: "assignment", owner: "alice" }; return { component, input }; };
  return { ...f, c, storeRoot, contract, manifest, approve, assign, imported };
}
