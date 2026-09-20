import { parseArgs } from "node:util";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner } from "./runner.js";
import { loadPlan, readiness, configFrom } from "./plan.js";
import { json, repository } from "./system.js";
import { sessionSettings } from "./codex.js";
import { getHarness, harnessIds, hasHarness, planningRules } from "./harnesses/registry.js";
import type { HarnessSettings } from "./harnesses/types.js";
import { createInterface } from "node:readline/promises";
import { parse } from "yaml";
const help = `openspec-runner — explicit OpenSpec task batches in isolated harness worktrees

init [--agent ID|all]          Create runner.yaml and install selected project skills
models [--agent ID] [--json]   Query the selected harness model capabilities
planning-rules --agent ID      Show versioned model/effort planning guidance
validate <change> [--json]      Validate task metadata and OpenSpec readiness
status <change> [--json]        Inspect dependencies, attempts, and session locations
launch <change> --tasks IDS     Launch exactly these comma-separated task numbers
  --agent ID                   Select one harness for this batch
  --dry-run --json             Preview without creating resources
  --default-model MODEL        Override captured calling-session default
  --default-effort EFFORT      Override inherited effort
  --base REF                   Initial committed base (default HEAD)
attach <change> <task>          Focus an existing pane or print a resume command
integrate <change> --tasks IDS  Sequentially merge completed results and check boxes
  --continue | --abort         Recover an interrupted integration
recover <change> <task>         Resume interrupted preparation before session creation
retry <change> <task>           Explicit new attempt after failed/blocked/stale result
cleanup <change> --tasks IDS    Remove selected integrated worktrees; retain branches
  --all                       Sweep every attempt after all planned tasks are satisfied
  --dry-run --json             Inspect cleanup without changing resources
  --attempt ID --confirm TOKEN Approve only the inspected attempt and contents
worker <change> <task> --attempt ID  Run the assigned supervised worker once
reconcile <change>              Adopt committed planning edits; invalidate old results
begin <change> <task> --attempt ID [--session ID]
report <change> <task> --attempt ID --file PATH

Run coordination inside Herdr or fmfsaisai/orca for persistent automatic sessions. Otherwise launch
prints commands to run once in your terminals. Delivery and archival are explicit.
`;
export function init(
  cwd = process.cwd(),
  selected: "codex" | "claude" | "all" = "codex",
  defaultAgent?: string,
) {
  if (!["codex", "claude", "all"].includes(selected))
    throw new Error("init --agent must be codex, claude, or all");
  if (defaultAgent && !hasHarness(defaultAgent))
    throw new Error(`Unknown default agent ${defaultAgent}; available: ${harnessIds().join(", ")}`);
  if (defaultAgent && selected !== "all")
    throw new Error("--default-agent is supported with init --agent all");
  const { root } = repository(cwd),
    config = resolve(root, "openspec/runner.yaml");
  mkdirSync(dirname(config), { recursive: true });
  if (!existsSync(config)) {
    const created = selected === "codex"
      ? "version: 1\ndefaultModel: session\nmaxParallel: 4\nworktrees: auto\nterminal: auto\ncleanup: automatic\nsetup: []\nverifyIntegration: []\n"
      : selected === "claude"
        ? "version: 2\ndefaultAgent: claude\nagents:\n  claude:\n    defaultModel: sonnet\n    permissionMode: dontAsk\n    allowedTools: []\nmaxParallel: 4\nworktrees: auto\nterminal: auto\ncleanup: automatic\nsetup: []\nverifyIntegration: []\n"
        : `version: 2\ndefaultAgent: ${defaultAgent ?? "codex"}\nagents:\n  codex:\n    defaultModel: session\n  claude:\n    defaultModel: sonnet\n    permissionMode: dontAsk\n    allowedTools: []\nmaxParallel: 4\nworktrees: auto\nterminal: auto\ncleanup: automatic\nsetup: []\nverifyIntegration: []\n`;
    writeFileSync(
      config,
      created,
      { flag: "wx" },
    );
  }
  const names = [
    "openspec-runner-plan",
    "openspec-runner-coordinate",
    "openspec-runner-implement",
  ];
  const targets = selected === "all" ? ["codex", "claude"] : [selected];
  const skills: string[] = [];
  for (const targetAgent of targets) for (const name of names) {
    const targetRoot = targetAgent === "claude" ? ".claude/skills" : ".agents/skills";
    const target = resolve(root, targetRoot, name);
    mkdirSync(target, { recursive: true });
    const source = fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
    writeFileSync(resolve(target, "SKILL.md"), readFileSync(source, "utf8"));
    skills.push(target);
  }
  return {
    config,
    agents: targets,
    skills,
  };
}
export async function main(args = process.argv.slice(2)) {
  let jsonOutput = args.includes("--json");
  try {
    const { values: v, positionals: p } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        tasks: { type: "string" },
        "dry-run": { type: "boolean" },
        "default-model": { type: "string" },
        "default-effort": { type: "string" },
        agent: { type: "string" },
        "default-agent": { type: "string" },
        base: { type: "string" },
        continue: { type: "boolean" },
        abort: { type: "boolean" },
        attempt: { type: "string" },
        session: { type: "string" },
        file: { type: "string" },
        all: { type: "boolean" },
        confirm: { type: "string" },
      },
    });
    const [command, change, task] = p;
    if (!command || v.help) {
      console.log(help);
      return;
    }
    if (process.platform === "win32")
      throw new Error("Native Windows is outside v1; use WSL");
    if (args.filter((arg) => arg === "--agent" || arg.startsWith("--agent=")).length > 1)
      throw new Error("Specify --agent at most once");
    if (v.agent !== undefined && !hasHarness(v.agent) && v.agent !== "all")
      throw new Error(`Unknown agent ${v.agent}; available: ${harnessIds().join(", ")}`);
    if (v.agent !== undefined && ["worker", "begin", "report"].includes(command))
      throw new Error("Worker lifecycle commands use the saved batch harness; do not pass --agent");
    let result: unknown;
    if ((v.all || v.confirm) && command !== "cleanup") throw new Error("--all and --confirm require cleanup");
    if (v["dry-run"] && !["cleanup", "launch", "retry"].includes(command)) throw new Error("--dry-run is supported only for cleanup and launch/retry");
    if (v["default-agent"] !== undefined && command !== "init")
      throw new Error("--default-agent is supported only by init");
    if (command === "init") result = init(process.cwd(), (v.agent as "codex" | "claude" | "all" | undefined) ?? "codex", v["default-agent"]);
    else if (command === "models") {
      let configuredVersion: 1 | 2 | undefined;
      let defaultAgent: string | undefined;
      if (!v.agent) {
        try {
          const root = repository(process.cwd()).root;
          const path = resolve(root, "openspec/runner.yaml");
          if (existsSync(path)) {
            const config = configFrom(parse(readFileSync(path, "utf8")));
            configuredVersion = config.version;
            defaultAgent = config.defaultAgent;
          }
        } catch {
          // Outside a configured project, preserve the unqualified Codex command.
        }
      }
      const adapter = getHarness(v.agent ?? defaultAgent ?? "codex");
      const discovered = await adapter.models();
      result = v.agent || configuredVersion === 2
        ? discovered
        : adapter.id === "codex"
          ? discovered.models
          : discovered;
    } else if (command === "planning-rules") {
      if (!v.agent || v.agent === "all") throw new Error("planning-rules requires --agent HARNESS");
      let root = process.cwd();
      try { root = repository(process.cwd()).root; } catch {
        // Bundled rules are useful while planning before a repository exists.
      }
      let agentConfig;
      const configPath = resolve(root, "openspec/runner.yaml");
      if (existsSync(configPath)) {
        const config = configFrom(parse(readFileSync(configPath, "utf8")));
        agentConfig = config.agents[v.agent];
      }
      result = planningRules(v.agent, root, agentConfig);
    }
    else {
      if (!change) throw new Error("Specify a change name");
      const r = new Runner(),
        ids = v.tasks?.split(",").map((x) => x.trim()) ?? [];
      switch (command) {
        case "validate": {
          const plan = loadPlan(r.repo.root, change);
          result = {
            valid: true,
            agent: plan.agent,
            harness: plan.agent,
            tasks: plan.tasks,
            assignments: plan.assignments,
            fingerprint: plan.fingerprint,
            openspec: readiness(r.repo.root, change),
          };
          break;
        }
        case "status":
          result = r.status(change);
          break;
        case "launch":
        case "retry": {
          const plan = loadPlan(r.repo.root, change),
            selected = command === "retry" ? [task] : ids,
            selectedAgent = v.agent ?? plan.agent ?? plan.config.defaultAgent ?? "codex",
            adapter = getHarness(selectedAgent),
            agentConfig = plan.config.agents[selectedAgent];
          if (selected.some((x) => !x))
            throw new Error("Specify a task for retry");
          let inherited: HarnessSettings | undefined;
          const configured = v["default-model"] ?? agentConfig?.defaultModel ?? plan.config.defaultModel;
          if (configured !== "session")
            inherited = {
              model: configured,
              ...(selectedAgent === "codex" && v["default-effort"] ? { reasoningEffort: v["default-effort"] } : {}),
              ...(selectedAgent !== "codex" && v["default-effort"] ? { effort: v["default-effort"] } : {}),
            };
          else {
            if (selectedAgent === "codex") {
              try {
                inherited = await sessionSettings();
              } catch (e) {
                if (
                  selected.some(
                    (id) =>
                      !plan.assignments[id]?.model ||
                      plan.assignments[id].model === "session",
                  )
                )
                  throw e;
              }
            } else if (selected.some((id) => !plan.assignments[id]?.model || plan.assignments[id].model === "session")) {
              throw new Error("Claude calling-session model inheritance is unsupported; pass --default-model or assign explicit models");
            }
          }
          if (inherited && v["default-effort"])
            if (selectedAgent === "codex") inherited.reasoningEffort = v["default-effort"];
            else inherited.effort = v["default-effort"];
          // Explicit different models must use their own advertised default, never global config effort.
          const defaults = new Map<string, string>();
          const preview = r.preview(
            change,
            selected,
            inherited,
            v.base,
            command === "retry",
            selectedAgent,
          );
          if (selectedAgent === "codex" && preview.tasks.some((t) => !t.settings.reasoningEffort)) {
            const discovered = await adapter.models();
            for (const m of (discovered.models ?? []) as any[])
              if (typeof m.defaultReasoningEffort === "string") defaults.set(m.model, m.defaultReasoningEffort);
            for (const t of preview.tasks)
              if (
                !t.settings.reasoningEffort &&
                !defaults.has(t.settings.model)
              )
                throw new Error(
                  `No default effort advertised for ${t.settings.model}; set reasoningEffort in execution.yaml or --default-effort for inherited tasks`,
                );
          }
          if (v["dry-run"]) {
            const capabilities = await adapter.capabilities(r.repo.root);
            result = {
              ...preview,
              capabilities,
              permissionPolicy: {
                permissionMode: agentConfig?.permissionMode ?? (selectedAgent === "claude" ? "dontAsk" : undefined),
                allowedTools: agentConfig?.allowedTools ?? [],
              },
              tasks: preview.tasks.map((t) => ({
                ...t,
                settings: {
                ...t.settings,
                  reasoningEffort:
                    t.settings.reasoningEffort ??
                    defaults.get(t.settings.model),
                },
              })),
            };
          } else {
            const capabilities = await adapter.capabilities(r.repo.root);
            if (!capabilities.supported)
              throw new Error(`${adapter.displayName} is not ready: ${capabilities.reasons.join("; ")}`);
            if (selectedAgent === "claude" && preview.tasks.some((entry) => entry.settings.effort) && !capabilities.features.effort)
              throw new Error("Claude CLI does not advertise --effort; omit effort or install a compatible CLI");
            if (selectedAgent === "claude" && capabilities.supportedEfforts?.length) {
              const supportedEfforts = capabilities.supportedEfforts;
              const unsupported = preview.tasks.map((entry) => entry.settings.effort).filter((effort) => effort && !supportedEfforts.includes(effort));
              if (unsupported.length)
                throw new Error(`Claude CLI does not support effort ${unsupported[0]}; supported values: ${supportedEfforts.join(", ")}`);
            }
            result = r.launch(
              change,
              selected,
              inherited,
              v.base,
              command === "retry",
              defaults,
              selectedAgent,
            );
          }
          break;
        }
        case "recover":
          if (!task) throw new Error("Specify a task");
          result = r.recover(change, task);
          break;
        case "attach":
          if (!task) throw new Error("Specify a task");
          result = r.attach(change, task);
          break;
        case "integrate":
          if (
            (v.continue && v.abort) ||
            ((v.continue || v.abort) && ids.length)
          )
            throw new Error("Use either --tasks, --continue, or --abort");
          result = r.integrate(
            change,
            ids,
            v.continue ? "continue" : v.abort ? "abort" : undefined,
          );
          break;
        case "cleanup":
          result = r.cleanup(change, ids, { all: v.all, dryRun: v["dry-run"], attempt: v.attempt, confirm: v.confirm });
          break;
        case "worker":
          if (!task || !v.attempt) throw new Error("Specify task and --attempt");
          result = await r.worker(change, task, v.attempt);
          break;
        case "reconcile":
          result = r.reconcile(change);
          break;
        case "begin":
          if (!task || !v.attempt)
            throw new Error("Specify task and --attempt");
          result = r.begin(change, task, v.attempt, v.session);
          break;
        case "report":
          if (!task || !v.attempt || !v.file)
            throw new Error("Specify task, --attempt, and --file");
          result = r.report(change, task, v.attempt, json(v.file));
          break;
        default:
          throw new Error(`Unknown command: ${command}`);
      }
      const cleanup = command === "cleanup" ? result as any : (result as any)?.cleanup;
      if (!jsonOutput && !v["dry-run"] && !v.confirm && process.stdin.isTTY && cleanup?.results) {
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try {
          for (const item of cleanup.results) {
            if (item.status !== "confirmation-required") continue;
            console.log(`${item.path}\n${item.reasons.join("\n")}\n${item.changes ?? ""}\nIgnored build/dependency files also disappear. Branches and reports remain.`);
            const answer = await input.question("Delete this worktree and close the reviewed terminal? Type delete to confirm; Enter keeps it: ");
            if (answer.trim() === "delete") {
              const approved = r.cleanup(change, cleanup.scope.tasks, { all: cleanup.scope.all, attempt: item.attempt, confirm: item.token });
              Object.assign(item, approved.results[0]);
            }
          }
        } finally { input.close(); }
      }
      if (command === "cleanup" && cleanup?.results?.some((x: any) => x.status === "failed")) process.exitCode = 1;
    }
    if (jsonOutput) console.log(JSON.stringify(result, null, 2));
    else if (Array.isArray(result) && result.some((x) => x.command))
      for (const entry of result)
        console.log(
          `${entry.task} (${entry.phase})\n${entry.error ? entry.error + "\n" : ""}${entry.command}\n`,
        );
    else console.log(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error(
      jsonOutput ? JSON.stringify({ error: e.message }) : `Error: ${e.message}`,
    );
    process.exitCode = 1;
  }
}
