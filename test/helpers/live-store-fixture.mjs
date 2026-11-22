import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, chmodSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { storePlanningFixture, git } from "./store-planning-fixture.mjs";
import { Coordination } from "../../dist/coordination.js";
import { Component } from "../../dist/component.js";
import { readComponentBinding } from "../../dist/component-state.js";
import { restoreWindowsContext, windowsContextRequest } from "../../dist/windows-context.js";

export async function storeFeatureFixture(t, harness = "codex") {
  const model = process.env.STORE_LIVE_MODEL ?? "auto";
  let cleanup;
  const f = storePlanningFixture({ after(fn) { cleanup = fn; } }, { prefix: "live-" });
  const bin = join(f.dir, "bin"); mkdirSync(bin);
  const controlPath = join(f.dir, "control.json"); writeFileSync(controlPath, "{}");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  let execution;
  const executions = [];
  t.after(() => {
    process.env.PATH = previousPath;
    for (const scope of executions) {
      const binding = readComponentBinding({ stateDir: scope.runtimeDir, change: "demo" });
      if (binding && process.platform === "win32") restoreWindowsContext(windowsContextRequest(scope.runtimeDir, binding));
      if (binding && process.platform !== "win32") {
        const unlock = path => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.isDirectory() ? 0o755 : 0o644); if (s.isDirectory()) for (const name of readdirSync(path)) unlock(join(path, name)); };
        for (const path of binding.contextPaths) if (existsSync(path)) unlock(path);
      }
    }
    cleanup();
  });
  // Real installed Copilot; deliberately no executable shim.
  git(f.code, "config", "openspec-runner.repository", "api");
  const config = JSON.parse(readFileSync(join(f.storeRoot, "components/api/openspec/runner.yaml"), "utf8"));
  f.write("components/api/openspec/runner.yaml", JSON.stringify({ ...config, defaultAgent: harness, agents: { [harness]: { defaultModel: model, ...(harness.startsWith("copilot") ? { options: { allowedTools: ["shell", "write"], startupTimeoutMs: 120000, completionTimeoutMs: 240000 } } : {}) } }, worktrees: "git", terminal: "manual", cleanup: "manual" }));
  if (harness !== "codex") f.write("components/api/openspec/changes/demo/execution.yaml", JSON.stringify({ version: 2, agent: harness, tasks: { "1.1": {} } }));
  f.write("components/api/openspec/changes/demo/tasks.md", "- [ ] 1.1 Create result.txt containing exactly HELLO followed by LF. Verify bytes with Node, commit code, and use the supplied public begin and report commands.\n");
  f.write("openspec/changes/shared/tasks.md", "- [ ] 1.1 Deliver the API component's disposable greeting: result.txt containing exactly HELLO followed by LF. No HTTP API behavior is required by this verification fixture.\n");
  const specification = "## Purpose\nVerify a deterministic Store component implementation.\n\n## ADDED Requirements\n### Requirement: Deterministic greeting\nThe component SHALL track result.txt containing exactly HELLO followed by a single LF byte. No HTTP API is required.\n\n#### Scenario: Read the greeting\n- **WHEN** Node reads result.txt as bytes\n- **THEN** the bytes are 48454c4c4f0a\n";
  f.write("components/api/openspec/specs/contract/spec.md", specification);
  f.write("components/api/openspec/changes/demo/specs/contract/spec.md", specification);
  f.write("openspec/changes/shared/specs/contract/spec.md", specification);
  git(f.storeRoot, "add", "."); git(f.storeRoot, "commit", "-m", "Shared feature");
  const role = { harness, model, ...(harness === "codex" ? { effort: "low" } : {}) };
  const contract = { repository: "contracts", context: { implementationRoot: f.code, planningRoot: f.storeRoot,
    changeRoot: join(f.storeRoot, "openspec/changes/shared"), change: "shared", source: "store", storeId: "team", artifactPaths: [], references: [] } };
  const coordinator = new Coordination({ root: f.storeRoot, featureId: "product", repositories: { contracts: f.storeRoot, api: f.code }, execute: f.input().execute });
  const manifest = { version: 2, featureId: "product", storeId: "team", sharedChange: "shared", coordinationBranch: "main",
    components: { api: { repository: "api", change: "demo", deliveryBranch: "main", dependencies: [],
      planning: { repository: "contracts", openspecRoot: "components/api/openspec" },
      settings: { implementation: role, tasks: {}, review: role, repair: role, maxFixRounds: 2, setup: [], verifyIntegration: [] } } },
    taskMapping: { "1.1": [{ type: "merged", componentId: "api" }] }, verification: [], completion: { requireAllMerged: true } };
  const head = () => git(f.storeRoot, "rev-parse", "HEAD");
  coordinator.init({ contract, manifest, expectedHead: head(), operationId: "init" });
  coordinator.approve({ contract, id: "approval", operationId: "approve", expectedHead: head(),
    token: coordinator.approvalPreview({ contract }).token, approvedBy: "user" });
  const request = { contract, componentId: "api", owner: "owner" };
  coordinator.assign({ ...request, id: "assignment", operationId: "assign", expectedHead: head(), token: coordinator.assignmentPreview(request).token });
  const component = new Component({ root: f.code, repository: "api", execute: f.input().execute });
  const selection = { storeRoot: f.storeRoot, featureId: "product", assignmentId: "assignment", owner: "owner" };
  execution = component.assignmentContext(selection).execution;
  executions.push(execution);
  const preview = await component.inspect(selection);
  return { ...f, coordinator, contract, component, selection, preview, execution, bin, head,
    control(value) { writeFileSync(controlPath, JSON.stringify(value)); }, trackExecution(scope) { executions.push(scope); } };
}
