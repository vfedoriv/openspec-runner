import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { storeProjectRoot } from "./store-setup.js";
import { assertStoreBindingAuthority, resolveBoundExecutionContext } from "./execution-context.js";
import { readStorePlanRevision } from "./planning-source.js";
import { CoordinationStore } from "./coordination-state.js";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { selectTerminal, worktrees, worktrunkCommand } from "./adapters.js";
import { copilotHookPath, validateCopilotHooks } from "./harnesses/copilot-hooks.js";
import { getHarness } from "./harnesses/registry.js";
import type { HarnessCapabilities, HarnessSettings } from "./harnesses/types.js";
import { herdrCall } from "./herdr.js";
import { orcaContext, type OrcaContext } from "./orca.js";
import { orcaWorktreeInventory, orcaWorktreeRepository } from "./orca-worktrees.js";
import { assertCommitted, configFrom, projectPlanFiles } from "./plan.js";
import { resolveCommand } from "./platform-command.js";
import { attempt, git, repository, run } from "./system.js";

type Check = {
  id: string;
  status: "ready" | "blocked" | "unchecked";
  message: string;
  backend?: string;
  capabilities?: HarnessCapabilities;
};

async function diagnose(cwd: string, selected?: string, planningProject?: string, scope?: { storeRoot: string; feature: string; component: string; assignment?: string; change?: string }) {
  const checks: Check[] = [];
  const inspect = <T>(id: string, probe: () => T, describe: (value: T) => string, backend?: (value: T) => string) => {
    try {
      const value = probe();
      checks.push({ id, status: "ready", message: describe(value), backend: backend?.(value) });
      return value;
    } catch (error) {
      checks.push({ id, status: "blocked", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const repo = inspect("project", () => repository(cwd), value => `Git checkout at ${value.root}`);
  const root = repo?.root ?? cwd;
  const base = repo && inspect("base", () => git(root, "rev-parse", "--verify", "HEAD^{commit}"), head => `Current base ${head}`);
  const configPath = "openspec/runner.yaml";
  const config = repo ? inspect("config", () => {
    const path = resolve(planningProject ?? root, configPath);
    if (!existsSync(path)) throw new Error(`Missing ${configPath}. Run openspec-runner init in this checkout.`);
    return configFrom(parse(readFileSync(path, "utf8")));
  }, value => `runner.yaml version ${value.version}, default harness ${value.defaultAgent}`) : undefined;
  if (!repo) checks.push({ id: "config", status: "unchecked", message: "Open a Git checkout to inspect project settings." });
  if (config && base) inspect("config-commit", () => {
    const planningRoot = planningProject ?? root, planningRepo = repository(planningRoot);
    const files = projectPlanFiles(planningRoot, config).map(file => relative(planningRepo.root, resolve(planningRoot, file)).split(sep).join("/"));
    return assertCommitted(planningRepo.root, { files }, planningProject ? git(planningRepo.root, "rev-parse", "HEAD") : base);
  },
    () => "Project planning inputs match the current base");
  if (scope && repo) inspect("assignment", () => {
    const store = new CoordinationStore({ root: scope.storeRoot, featureId: scope.feature });
    const change = scope.change ?? store.readManifest().components[scope.component]?.change;
    if (!change) throw new Error("Store component is missing from the selected manifest");
    const execution = resolveBoundExecutionContext({ implementationRoot: root, storeRoot: scope.storeRoot, featureId: scope.feature,
      componentId: scope.component, assignmentId: scope.assignment, change });
    const binding = assertStoreBindingAuthority(execution, change);
    const branch = store.readManifest({ revision: binding.historyRevision }).coordinationBranch;
    if (execution.planningSource.kind !== "store") throw new Error("Expected Store planning source");
    const current = readStorePlanRevision({ storeRoot: store.root, source: execution.planningSource, revision: git(store.root, "rev-parse", `refs/heads/${branch}`) });
    if (current.fingerprint !== execution.planningSource.fingerprint) throw new Error("Store planning drift; obtain renewed coordinator approval");
    return binding.assignmentId;
  }, assignment => `Current Store assignment ${assignment}`);

  inspect("openspec", () => run("openspec", ["--version"], planningProject ?? root, 10000), version => `OpenSpec ${version || "CLI responded"}`);
  const harness = getHarness(selected ?? config?.defaultAgent);
  const configured = config?.agents[harness.id];
  const model = configured?.defaultModel ?? config?.defaultModel;
  const explicitModel = model && model !== "session" ? model : undefined;
  let settings: HarnessSettings | undefined;
  if (config) {
    // Adapter validation may require a model even when it will be supplied at launch.
    // Only the resulting options are used by the local CLI capability probes.
    settings = inspect("harness-settings", () => harness.resolveSettings({ dependsOn: [], parallel: false }, { model: explicitModel ?? "doctor-placeholder" }, configured),
      value => explicitModel ? `Configured model ${value.model}` : "Harness options accepted");
    if (settings && !explicitModel) {
      checks.push({ id: "model-selection", status: "unchecked", message: "Model selection depends on the task, a launch override, or a supported calling session." });
    }
  }
  if (base && (harness.id === "copilot" || harness.id === "copilot-vscode")) inspect("copilot-hooks", () => {
    const hooks = attempt(() => git(root, "show", `${base}:${copilotHookPath}`));
    if (!hooks) throw new Error(`Missing ${copilotHookPath} at the current base. Run openspec-runner init --agent ${harness.id} and commit the hooks.`);
    validateCopilotHooks(hooks);
  }, () => "Required Copilot hook events are committed at the current base");
  // If settings are invalid, the binary's default probe can give a misleading result.
  if (config && !settings) {
    checks.push({ id: "harness", status: "unchecked", message: "Correct the selected harness settings before probing it." });
  } else {
    try {
      const capabilities = await harness.capabilities(root, settings);
      checks.push({ id: "harness", status: capabilities.supported ? "ready" : "blocked", capabilities,
        message: capabilities.supported ? `${harness.displayName} supports the required CLI capabilities` : capabilities.reasons.join(". ") || `${harness.displayName} is not ready` });
    } catch (error) {
      checks.push({ id: "harness", status: "blocked", message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (config) {
    let context: OrcaContext | undefined;
    let orcaRepoId: string | undefined;
    const orca = () => context ??= orcaContext(root);
    const orcaRepository = () => orcaRepoId ??= orcaWorktreeRepository(root, orca());
    inspect("worktrees", () => {
      if (config.worktrees === "orca") {
        orcaWorktreeInventory(root, orca(), orcaRepository());
        return "orca";
      }
      worktrees(root);
      return worktrunkCommand(root, config.worktrees) ? "worktrunk" : "git";
    }, backend => `${backend} worktrees available for ${config.worktrees} configuration`, backend => backend);
    inspect("terminal", () => {
      const backend = selectTerminal(config.terminal);
      if (process.platform === "win32" && backend !== "manual") resolveCommand({ executable: "pwsh.exe", args: [], cwd: root });
      if (backend === "orca") orcaRepository();
      if (backend === "herdr") herdrCall(root, ["workspace", "list"]);
      return backend;
    }, backend => backend === "manual" ? "Manual worker commands will be printed" : `${backend} terminal session responded`, backend => backend);
  } else {
    for (const id of ["worktrees", "terminal"]) checks.push({ id, status: "unchecked", message: "Load a valid runner.yaml to select a backend." });
  }

  checks.push({ id: "live", status: "unchecked", message: "Worker authentication, model access, permissions, and task setup or verification require a live run." });
  return { version: 1, ok: checks.every(check => check.status !== "blocked"), root: repo?.root, ...(planningProject ? { planningRoot: planningProject, implementationRoot: repo?.root } : {}), agent: harness.id, checks };
}

export async function doctorCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    agent: { type: "string", multiple: true },
    store: { type: "string" }, component: { type: "string" }, feature: { type: "string" }, assignment: { type: "string" }, change: { type: "string" },
  } });
  if (values.help) {
    console.log("doctor [--agent ID] [--json]   Check project configuration and local execution tools");
    return;
  }
  if ((values.agent?.length ?? 0) > 1) throw new Error("Specify --agent at most once");
  if (values.agent?.[0] !== undefined) getHarness(values.agent[0]);
  if ((values.component || values.feature || values.assignment) && !values.store) throw new Error("Store scope identifiers require --store");
  if (values.assignment && (!values.feature || !values.component)) throw new Error("--assignment requires --feature and --component");
  const scope = values.store && values.feature && values.component ? { storeRoot: values.store, feature: values.feature, component: values.component, assignment: values.assignment, change: values.change } : undefined;
  const result = await diagnose(process.cwd(), values.agent?.[0], values.store ? storeProjectRoot(values.store, values.component) : undefined, scope);
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.id} — ${check.message}`);
  if (!result.ok) process.exitCode = 1;
}
