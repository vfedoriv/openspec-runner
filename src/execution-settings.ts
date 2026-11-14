import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { readComponentBinding } from "./component-state.js";
import { featureActive, readFeature } from "./feature-state.js";
import { agentMayBeActive } from "./harnesses/lifecycle.js";
import { getHarness } from "./harnesses/registry.js";
import { assignmentsFrom, initExecution, loadPlan } from "./plan.js";
import { publishExclusive, replaceBytes } from "./platform-files.js";
import { unredirectedPath } from "./platform-paths.js";
import { Runner } from "./runner.js";

export function editExecutionSettings(change: string, input: unknown, confirm?: string, cwd = process.cwd()) {
  const runner = new Runner(cwd);
  const { root, stateDir } = runner.repo;
  const edit = () => {
    const feature = readFeature(stateDir, change);
    const state = runner.read(change);
    if (feature?.delegated || readComponentBinding({ stateDir, change }))
      throw new Error("Obtain revised settings from the coordinator for delegated work");
    if (feature && feature.planningRoot !== root)
      throw new Error("Open the recorded planning checkout to edit assignments");
    if (state?.completion || state?.transaction || feature?.archive || feature?.transaction || feature?.phase === "completed" ||
        state?.attempts.some(attempt => ["preparing", "manual", "launching", "running"].includes(attempt.phase) || agentMayBeActive(attempt)) ||
        feature?.jobs.some(job => featureActive(job) || job.role === "repair" && job.phase === "completed" && job.report?.outcome === "completed"))
      throw new Error("Finish active work and pending integration before editing assignments");
    const starter = initExecution(root, change, { dryRun: true });
    const path = resolve(root, starter.path);
    if (!unredirectedPath(path)) throw new Error("Expected an ordinary planning file");
    const readExisting = () => {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) return undefined;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected an ordinary planning file");
      if (stat.size > 1024 * 1024) throw new Error("execution.yaml exceeds 1 MiB");
      return readFileSync(path);
    };
    const bytes = readExisting();
    const original = bytes?.toString("utf8") ?? starter.yaml;
    if (bytes && !Buffer.from(original).equals(bytes)) throw new Error("execution.yaml must be valid UTF-8");
    const document = parseDocument(original);
    if (document.errors.length) throw document.errors[0];
    visit(document, (_, node) => { if (isAlias(node)) throw new Error("Resolve YAML aliases before editing assignments"); });
    const plan = loadPlan(root, change, original);
    if (state && plan.tasks.some(task => !task.completed && !runner.satisfied(state, task.id) &&
        runner.latest(state, task.id)?.phase === "completed"))
      throw new Error("Integrate completed task work before editing assignments");
    const tasks = (input as { tasks?: unknown } | null)?.tasks;
    if (!Array.isArray(tasks) || !tasks.length) throw new Error("Select at least one task");
    const effortKey = document.get("version") === 1 ? "reasoningEffort" : "effort";
    const mappings = document.get("tasks", true);
    if (!isMap(mappings)) throw new Error("Expected task mappings");
    const seen = new Set<string>();
    for (const row of tasks) {
      if (!row || typeof row !== "object" || Object.keys(row).some(key => !["id", "model", "effort"].includes(key)))
        throw new Error("Invalid task settings patch");
      const task = plan.tasks.find(task => task.id === row.id);
      if (!task || seen.has(task.id)) throw new Error(`Unknown or duplicate task: ${row.id}`);
      if (task.completed || state && runner.satisfied(state, task.id)) throw new Error(`Task is already satisfied: ${task.id}`);
      seen.add(task.id);
      const node = mappings.items.find(pair => isScalar(pair.key) && String(pair.key.value) === task.id)?.value;
      if (!isMap(node)) throw new Error(`Expected a task mapping: ${task.id}`);
      for (const [field, key] of [["model", "model"], ["effort", effortKey]]) {
        const value: unknown = row[field];
        if (value === undefined) continue;
        if (value === null) node.delete(key);
        else {
          if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${field}`);
          node.set(key, value);
        }
      }
    }
    const assignments = assignmentsFrom(document.toJS(), plan.tasks);
    const adapter = getHarness(plan.agent);
    const config = plan.config.agents[plan.agent];
    const configuredModel = config?.defaultModel ?? plan.config.defaultModel;
    const inherited = feature?.approval?.implementation ??
      (configuredModel && configuredModel !== "session" ? { model: configuredModel } : undefined);
    const changes = [...seen].filter(task => JSON.stringify(assignments[task]) !== JSON.stringify(plan.assignments[task])).map(task => {
      const after = assignments[task];
      const canResolve = inherited || after.model && after.model !== "session";
      const effective = canResolve || plan.agent.startsWith("copilot")
        ? adapter.resolveSettings(after, inherited, config) : undefined;
      const effort = after.effort ?? after.reasoningEffort;
      const modelSource = after.model && after.model !== "session" ? "Task setting"
        : !effective ? "Unresolved" : feature?.approval ? "Approved implementation default" : "Project default";
      const effortSource = effort ? "Task setting"
        : !effective ? "Unresolved" : effective.effort ?? effective.reasoningEffort
          ? "Approved implementation default" : "Harness default";
      const validation = !effective && effort ? "Validate effort after the model resolves at launch or approval" : undefined;
      return { task, before: plan.assignments[task], after, effective, modelSource, effortSource, validation };
    });
    const next = original.includes("\r\n") ? document.toString().replace(/\n/g, "\r\n") : document.toString();
    const diff = changes.map(({ task, before, after }) => {
      const fields = [["model", before.model, after.model], [effortKey, before.effort ?? before.reasoningEffort, after.effort ?? after.reasoningEffort]];
      return [`Task ${task}`, ...fields.filter(([, oldValue, newValue]) => oldValue !== newValue)
        .flatMap(([field, oldValue, newValue]) => [`- ${field}: ${oldValue ?? "inherit"}`, `+ ${field}: ${newValue ?? "inherit"}`])].join("\n");
    }).join("\n");
    const token = createHash("sha256").update(JSON.stringify([
      runner.actionIdentity(change, original), path, bytes?.toString("base64") ?? null,
      plan.tasks.map(task => [task.id, task.completed]), next, input,
    ])).digest("hex");
    if (confirm !== undefined) {
      const current = readExisting();
      if (token !== confirm || !unredirectedPath(path) || (bytes ? !current?.equals(bytes) : current !== undefined))
        throw new Error("Assignment preview is stale; review it again");
      if (changes.length) (bytes ? replaceBytes : publishExclusive)(path, Buffer.from(next));
    }
    const nextSteps = changes.length ? [
      "Review and commit execution.yaml",
      ...(state ? ["Reconcile the committed plan. All unintegrated attempts become stale."] : []),
      ...(feature ? ["Approve the updated managed plan"] : []),
    ] : [];
    return { path, token, changes, diff, createsFile: !bytes && changes.length > 0,
      message: changes.length ? undefined : "No assignment changes", applied: confirm !== undefined && changes.length > 0, nextSteps };
  };
  return confirm === undefined ? edit() : runner.lock(edit);
}
