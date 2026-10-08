import { parse } from "yaml";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repository } from "./system.js";
import { Runner, type TaskAttempt } from "./runner.js";
import { blocking, featureActive, implementationGate, readFeature, type FeatureJob } from "./feature-state.js";
import { readComponentBinding } from "./component-state.js";
import { configFrom, loadPlan, tasksFrom } from "./plan.js";
import { processStart } from "./processes.js";
import type { DashboardOptions, DashboardSnapshot, SessionSummary } from "./dashboard-types.js";
import { collectCoordination } from "./dashboard-coordination.js";

function session(featureId: string, attempt: TaskAttempt | FeatureJob): SessionSummary {
  let observation: SessionSummary["process"] = "unknown";
  if (attempt.worker?.exitedAt) observation = "exited";
  else if (attempt.worker?.pid && attempt.worker.processStart) {
    try {
      if (processStart(attempt.worker.pid) === attempt.worker.processStart) observation = "running";
    } catch { /* Unavailable identity observation is not lifecycle evidence. */ }
  }
  const terminal = attempt.terminal;
  return {
    id: `${featureId}:attempt:${attempt.id}`, featureId,
    taskId: "task" in attempt ? `${featureId}:task:${attempt.task}` : undefined,
    role: "role" in attempt ? attempt.role : "implementation",
    attempt, phase: attempt.phase, reportOutcome: attempt.report?.outcome,
    process: observation,
    terminal: terminal?.closed || (!terminal?.pane && !terminal?.orca) ? "unavailable" : "unknown",
    log: attempt.worker?.log, worktreeAvailable: existsSync(attempt.path),
  };
}

/** Read only: no locks, migration, recovery, harness calls or verification commands. */
export function collectDashboard(options: DashboardOptions): DashboardSnapshot {
  const repo = repository(options.cwd), runner = new Runner(options.cwd), collectedAt = new Date().toISOString();
  const snapshot: DashboardSnapshot = {
    version: 1, collectedAt, repository: { ...repo, currentWorktree: repo.root },
    features: [], tasks: [], sessions: [], assignments: [], attention: [], errors: [], sources: {},
  };
  const configPath = resolve(repo.root, "openspec/runner.yaml");
  if (existsSync(configPath)) {
    try { snapshot.repository.maxParallel = configFrom(parse(readFileSync(configPath, "utf8"))).maxParallel; }
    catch (error) { snapshot.errors.push({ source: "configuration", message: error instanceof Error ? error.message : String(error), stale: false }); }
  }
  const changes = new Set<string>();
  const discover = (directory: string, directories = false) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directories ? entry.isDirectory() && entry.name !== "archive" : entry.isFile() && entry.name.endsWith(".json") && !["lock.json", "repository.json"].includes(entry.name))
        changes.add(directories ? entry.name : entry.name.slice(0, -5));
    }
  };
  discover(resolve(repo.root, "openspec/changes"), true);
  discover(repo.stateDir); discover(resolve(repo.stateDir, "features")); discover(resolve(repo.stateDir, "components"));
  for (const change of [...changes].sort()) {
    if (options.change && change !== options.change) continue;
    const source = `local:${change}`;
    snapshot.sources[source] = { collectedAt, stale: false };
    const attention = (key: string, message: string, priority = 2, targetId = source) => {
      snapshot.attention.push({ id: `${source}:${key}`, source, targetId, priority, message });
    };
    try {
      const state = runner.read(change), feature = readFeature(repo.stateDir, change);
      const binding = readComponentBinding({ stateDir: repo.stateDir, change });
      const directory = resolve(repo.root, "openspec/changes", change);
      let plan: ReturnType<typeof loadPlan> | undefined;
      if (existsSync(resolve(directory, "tasks.md")) && existsSync(resolve(directory, "execution.yaml"))) plan = loadPlan(repo.root, change);
      else if (!state && !feature && !binding) throw new Error("Planning artifacts are missing tasks.md or execution.yaml");
      if (plan) snapshot.repository.maxParallel = plan.config.maxParallel;
      const globalReasons: string[] = [];
      if (plan && state && state.fingerprint !== plan.fingerprint) globalReasons.push("Planning drift: artifacts changed; reconcile required");
      if (state?.transaction || feature?.transaction) globalReasons.push("Interrupted integration transaction requires recovery");
      if (feature) {
        if (feature.invalidated) globalReasons.push(`Plan approval invalidated: ${feature.invalidated}`);
        if (!feature.approval || (plan && feature.approval.fingerprint !== plan.fingerprint)) globalReasons.push("Current plan approval is required");
        if (feature.phase !== "implementing") globalReasons.push(`Feature phase ${feature.phase} blocks implementation`);
        if (feature.jobs.some(featureActive)) globalReasons.push("Exclusive feature job is active");
        if (feature.phase === "awaiting-final-approval") attention("final-approval", "Final approval pending");
        if (feature.phase === "awaiting-plan-approval" || feature.phase === "planning") attention("plan-approval", "Plan approval pending");
        if (feature.error) attention("feature-error", feature.error, 1);
        if (feature.approval && feature.fixRounds >= feature.approval.maxFixRounds) attention("repair-limit", "Repair round limit reached");
        if (feature.archive) attention("archive", `Archive evidence: ${feature.archive.phase}${feature.archive.commit ? ` (${feature.archive.commit})` : ""}`, 3);
        for (const job of feature.jobs) for (const finding of job.findings ?? []) attention(`finding:${job.id}:${finding.id}`, `${blocking(finding) ? "Blocking" : "Advisory"} ${finding.category} finding: ${finding.impact}`, blocking(finding) ? 1 : 3, `${source}:attempt:${job.id}`);
      }
      if (plan && (binding || feature?.phase === "implementing")) {
        try { implementationGate(repo.stateDir, plan); }
        catch (error) { globalReasons.push(error instanceof Error ? error.message : String(error)); }
      }
      globalReasons.forEach((reason, index) => attention(`gate:${index}`, reason));
      const tasks = plan?.tasks ?? (existsSync(resolve(directory, "tasks.md")) ? tasksFrom(readFileSync(resolve(directory, "tasks.md"), "utf8")) : (state?.planTasks ?? [...new Set([...(state?.completion?.tasks ?? []), ...(state?.baseline ?? []), ...(state?.attempts.map(a => a.task) ?? [])])]).map(id => ({ id, description: state?.attempts.find(a => a.task === id)?.description ?? id, completed: !!state && runner.satisfied(state, id), line: -1 })));
      const status = plan ? runner.status(change) : undefined;
      const summaries = tasks.map(task => {
        const attempts = state?.attempts.filter(a => a.task === task.id) ?? [], assignment = plan?.assignments[task.id];
        const reasons = [...globalReasons];
        const satisfied = state ? runner.satisfied(state, task.id) : task.completed;
        if (satisfied) reasons.push("Task is already satisfied");
        else if (attempts.length) reasons.push(`Existing attempt is ${attempts.at(-1)!.phase}; select explicit retry when eligible`);
        for (const dependency of assignment?.dependsOn ?? []) if (!(state ? runner.satisfied(state, dependency) : tasks.find(t => t.id === dependency)?.completed)) reasons.push(`Dependency ${dependency} is not integrated or satisfied`);
        const authoritative = status && "tasks" in status ? status.tasks?.find(t => t.id === task.id)?.ready : false;
        return { id: `${source}:task:${task.id}`, featureId: source, harness: plan?.agent, task, assignment, ready: !!authoritative && !reasons.length, reasons, attempts };
      });
      const sessions = [...(state?.attempts ?? []), ...(feature?.jobs ?? [])].map(a => session(source, a));
      for (const current of sessions) {
        if (["failed", "blocked", "stale"].includes(current.phase)) attention(`attempt:${current.attempt.id}`, `Attempt ${current.attempt.id} is ${current.phase}${current.attempt.error ? `: ${current.attempt.error}` : ""}`, 1, current.id);
        if (["completed", "failed", "blocked"].includes(current.phase) && !current.attempt.report) attention(`report:${current.attempt.id}`, `Missing report for ${current.attempt.id}`, 1, current.id);
      }
      snapshot.features.push({ id: source, change, origin: "local", phase: feature?.phase, state: feature, completed: summaries.filter(t => state ? runner.satisfied(state, t.task.id) : t.task.completed).length, total: summaries.length, taskIds: summaries.map(t => t.id), sessionIds: sessions.map(s => s.id) });
      snapshot.tasks.push(...summaries); snapshot.sessions.push(...sessions);
      if (binding) {
        const a = binding.assignment;
        snapshot.assignments.push({ id: `${source}:assignment:${a.id}`, featureId: source, componentId: a.componentId, repository: a.repository, change: a.change, owner: a.owner, importedRevision: binding.historyRevision, binding, stale: false });
        if (binding.phase !== "ready") attention("binding", "Component import reservation is not ready", 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshot.errors.push({ source, message, stale: false }); attention("error", message, 1);
    }
  }
  return { ...snapshot, ...collectCoordination(options, snapshot) };
}
