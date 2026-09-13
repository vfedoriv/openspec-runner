import { parseArgs } from "node:util";
import { mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner } from "./runner.js";
import { loadPlan, readiness } from "./plan.js";
import { json, repository } from "./system.js";
import { models, sessionSettings, type Settings } from "./codex.js";
import { createInterface } from "node:readline/promises";
const help = `openspec-runner — explicit OpenSpec task batches in isolated Codex worktrees

init                           Create runner.yaml and install three project skills
models [--json]                Query Codex model identifiers and reasoning settings
validate <change> [--json]      Validate task metadata and OpenSpec readiness
status <change> [--json]        Inspect dependencies, attempts, and session locations
launch <change> --tasks IDS     Launch exactly these comma-separated task numbers
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
worker <change> <task> --attempt ID  Run the assigned supervised Codex worker once
reconcile <change>              Adopt committed planning edits; invalidate old results
begin <change> <task> --attempt ID [--session ID]
report <change> <task> --attempt ID --file PATH

Run coordination inside Herdr for persistent automatic sessions. Otherwise launch
prints commands to run once in your terminals. Delivery and archival are explicit.
`;
export function init(cwd = process.cwd()) {
  const { root } = repository(cwd),
    config = resolve(root, "openspec/runner.yaml");
  mkdirSync(dirname(config), { recursive: true });
  if (!existsSync(config))
    writeFileSync(
      config,
      "version: 1\ndefaultModel: session\nmaxParallel: 4\nworktrees: auto\nterminal: auto\ncleanup: automatic\nsetup: []\nverifyIntegration: []\n",
      { flag: "wx" },
    );
  const names = [
    "openspec-runner-plan",
    "openspec-runner-coordinate",
    "openspec-runner-implement",
  ];
  for (const name of names) {
    const target = resolve(root, ".agents/skills", name);
    mkdirSync(target, { recursive: true });
    copyFileSync(
      fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
      resolve(target, "SKILL.md"),
    );
  }
  return {
    config,
    skills: names.map((n) => resolve(root, ".agents/skills", n)),
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
    let result: unknown;
    if ((v.all || v.confirm) && command !== "cleanup") throw new Error("--all and --confirm require cleanup");
    if (v["dry-run"] && !["cleanup", "launch", "retry"].includes(command)) throw new Error("--dry-run is supported only for cleanup and launch/retry");
    if (command === "init") result = init();
    else if (command === "models") result = await models();
    else {
      if (!change) throw new Error("Specify a change name");
      const r = new Runner(),
        ids = v.tasks?.split(",").map((x) => x.trim()) ?? [];
      switch (command) {
        case "validate": {
          const plan = loadPlan(r.repo.root, change);
          result = {
            valid: true,
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
            selected = command === "retry" ? [task] : ids;
          if (selected.some((x) => !x))
            throw new Error("Specify a task for retry");
          let inherited: Settings | undefined;
          const configured = v["default-model"] ?? plan.config.defaultModel;
          if (configured !== "session")
            inherited = {
              model: configured,
              reasoningEffort: v["default-effort"],
            };
          else {
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
          }
          if (inherited && v["default-effort"])
            inherited.reasoningEffort = v["default-effort"];
          // Explicit different models must use their own advertised default, never global config effort.
          const defaults = new Map<string, string>();
          const preview = r.preview(
            change,
            selected,
            inherited,
            v.base,
            command === "retry",
          );
          if (preview.tasks.some((t) => !t.settings.reasoningEffort)) {
            for (const m of (await models()) as any[])
              if (typeof m.defaultReasoningEffort === "string")
                defaults.set(m.model, m.defaultReasoningEffort);
            for (const t of preview.tasks)
              if (
                !t.settings.reasoningEffort &&
                !defaults.has(t.settings.model)
              )
                throw new Error(
                  `No default effort advertised for ${t.settings.model}; set reasoningEffort in execution.yaml or --default-effort for inherited tasks`,
                );
          }
          if (v["dry-run"])
            result = {
              ...preview,
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
          else
            result = r.launch(
              change,
              selected,
              inherited,
              v.base,
              command === "retry",
              defaults,
            );
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
