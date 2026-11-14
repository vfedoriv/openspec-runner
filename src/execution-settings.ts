import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { readComponentBinding } from "./component-state.js";
import { featureActive, readFeature } from "./feature-state.js";
import { agentMayBeActive } from "./harnesses/lifecycle.js";
import { getHarness } from "./harnesses/registry.js";
import { assignmentsFrom, loadPlan } from "./plan.js";
import { replaceBytes } from "./platform-files.js";
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
    const plan = loadPlan(root, change);
    const path = resolve(plan.directory, "execution.yaml");
    if (!unredirectedPath(path)) throw new Error("Expected an ordinary planning file");
    const original = readFileSync(path, "utf8");
    if (Buffer.byteLength(original) > 1024 * 1024) throw new Error("execution.yaml exceeds 1 MiB");
    const document = parseDocument(original);
    if (document.errors.length) throw document.errors[0];
    visit(document, (_, node) => { if (isAlias(node)) throw new Error("Resolve YAML aliases before editing assignments"); });
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
    const inherited = feature?.approval?.implementation ??
      (config?.defaultModel && config.defaultModel !== "session" ? { model: config.defaultModel } : undefined);
    const changes = [...seen].filter(task => JSON.stringify(assignments[task]) !== JSON.stringify(plan.assignments[task])).map(task => {
      const after = assignments[task];
      const effective = inherited || after.model && after.model !== "session"
        ? adapter.resolveSettings(after, inherited, config) : undefined;
      return { task, before: plan.assignments[task], after, effective };
    });
    const next = original.includes("\r\n") ? document.toString().replace(/\n/g, "\r\n") : document.toString();
    const token = createHash("sha256").update(JSON.stringify([runner.actionIdentity(change), path, original, next, changes])).digest("hex");
    if (confirm !== undefined) {
      if (token !== confirm || readFileSync(path, "utf8") !== original) throw new Error("Assignment preview is stale; review it again");
      if (changes.length) replaceBytes(path, Buffer.from(next));
    }
    const nextSteps = changes.length ? [
      "Review and commit execution.yaml",
      ...(state ? ["Reconcile the committed plan. All unintegrated attempts become stale."] : []),
      ...(feature ? ["Approve the updated managed plan"] : []),
    ] : [];
    return { path, token, changes, applied: confirm !== undefined && changes.length > 0, nextSteps };
  };
  return confirm === undefined ? edit() : runner.lock(edit);
}
