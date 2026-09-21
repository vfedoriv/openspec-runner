import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Runner, decodeState } from "./runner.js";
import { loadPlan, assertCommitted, readiness } from "./plan.js";
import { atomic, clean, git, json, run, shellCommand, attempt } from "./system.js";
import { createWorktree, startTerminal, terminalAdapter } from "./adapters.js";
import { superviseWorker, type SupervisedSession } from "./worker.js";
import { processStart } from "./processes.js";
import { getHarness } from "./harnesses/registry.js";
import type { HarnessSettings } from "./harnesses/types.js";
import {
  readFeature, saveFeature, featurePath, featureActive, activeFeatureJobs, blocking, digest,
  approvedFeature, validateFeatureReport, settingsIdentity, type FeatureState, type FeatureJob, type FeatureReport, type FeatureApproval,
} from "./feature-state.js";

export interface FeatureSettings {
  implementation: { harness: string; model: string; effort?: string };
  review: { harness: string; model: string; effort?: string };
  repair: { harness: string; model: string; effort?: string };
  maxFixRounds?: number;
}
const now = () => new Date().toISOString();
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const taskActive = (s: ReturnType<Runner["read"]>) => s?.attempts.some(a =>
  ["preparing", "manual", "launching", "running"].includes(a.phase) || !!(a.worker && !a.worker.exitedAt));

export class Feature {
  runner: Runner;
  constructor(cwd = process.cwd()) { this.runner = new Runner(cwd); }
  get repo() { return this.runner.repo; }
  read(change: string) {
    const s = readFeature(this.repo.stateDir, change);
    if (!s) throw new Error("Feature is not managed; use feature start or adopt");
    return s;
  }
  private save(s: FeatureState) { saveFeature(this.repo.stateDir, s); }
  private update(change: string, fn: (s: FeatureState) => void) {
    return this.runner.lock(() => { const s = this.read(change); fn(s); this.save(s); return s; });
  }
  start(change: string, adopt = false) {
    featurePath(this.repo.stateDir, change);
    return this.runner.lock(() => {
      const existing = readFeature(this.repo.stateDir, change);
      if (existing) return existing;
      const execution = this.runner.read(change);
      if (execution && !adopt) throw new Error("Existing runner state requires feature adopt");
      if (adopt && !existsSync(resolve(this.repo.root, "openspec/changes", change)))
        throw new Error("Adoption requires an existing active OpenSpec change");
      if (taskActive(execution) || execution?.transaction)
        throw new Error("Finish active tasks and integration before adopting");
      const s: FeatureState = { version: 1, change, planningRoot: this.repo.root,
        phase: "planning", jobs: [], fixRounds: 0, approvalHistory: [] };
      this.save(s);
      return s;
    });
  }
  private execution(s: FeatureState) {
    const r = this.runner.read(s.change);
    if (!r) throw new Error("Approve the plan to prepare its integration branch");
    return r;
  }
  private assertIdle(s: FeatureState) {
    if (s.jobs.some(featureActive) || taskActive(this.runner.read(s.change)))
      throw new Error("Feature has an active or unacknowledged worker; inspect before continuing");
    if (s.transaction || this.runner.read(s.change)?.transaction)
      throw new Error("Finish or abort pending integration first");
    if (s.jobs.some(j => j.role === "repair" && j.phase === "completed" && j.report?.outcome === "completed"))
      throw new Error("Integrate the completed repair before proceeding");
  }
  private current(s: FeatureState) {
    const p = loadPlan(s.planningRoot, s.change);
    approvedFeature(this.repo.stateDir, p);
    const r = this.execution(s);
    if (r.fingerprint !== p.fingerprint) throw new Error("Reconcile the approved plan first");
    if (loadPlan(r.integration.path, s.change).fingerprint !== p.fingerprint)
      throw new Error("Integration planning artifacts drifted");
    if (!clean(r.integration.path) || git(r.integration.path, "rev-parse", "HEAD") !== r.head ||
        git(r.integration.path, "symbolic-ref", "--short", "HEAD") !== r.integration.branch)
      throw new Error("Integration worktree must be clean at its recorded head");
    return { p, r };
  }
  private allImplemented(s: FeatureState) {
    const { p, r } = this.current(s);
    this.assertIdle(s);
    if (!p.tasks.every(t => this.runner.satisfied(r, t.id)))
      throw new Error("Integrate all implementation tasks before review");
    return { p, r };
  }
  private successful(job: FeatureJob) {
    if (job.phase !== "completed" || job.report?.outcome !== "completed" ||
        !job.worker?.exitedAt || job.worker.exitCode !== 0)
      throw new Error("Job requires an accepted report and successful supervised exit");
    if (job.agent === "claude" && (!job.identityConfirmed || !job.terminalEvidence ||
        job.terminalEvidence.metadata?.is_error === true || job.terminalEvidence.subtype?.startsWith("error")))
      throw new Error("Job lacks successful confirmed Claude session evidence");
  }
  private review(s: FeatureState) {
    const r = this.execution(s);
    const job = s.jobs.filter(j => j.role === "review").at(-1);
    if (!job || job.base !== r.head || job.fingerprint !== s.approval?.fingerprint ||
        settingsIdentity(job.settings) !== settingsIdentity(s.approval.review))
      throw new Error("A fresh review of the current integration commit is required");
    this.successful(job);
    if (!clean(job.path) || git(job.path, "rev-parse", "HEAD") !== job.base)
      throw new Error("Reviewer changed its checkout; run a fresh review");
    return job;
  }
  status(change: string) {
    const saved = this.read(change), s = structuredClone(saved);
    const r = this.runner.read(change);
    let blocker = s.error;
    const failedTask = r?.attempts.find(a => ["failed", "blocked"].includes(a.phase) && this.runner.latest(r, a.task)?.id === a.id);
    if (failedTask) blocker ??= `Task ${failedTask.task}: ${failedTask.error ?? failedTask.report?.summary ?? failedTask.phase}; inspect before retrying`;
    let tasks: ReturnType<Runner["status"]>["tasks"];
    if (!s.archive) {
      try { tasks = new Runner(s.planningRoot).status(change).tasks; } catch { /* Planning may be incomplete. */ }
    }
    if (!s.archive && s.phase !== "completed") {
      try {
        const p = loadPlan(s.planningRoot, change);
        if (!s.approval || s.invalidated || p.fingerprint !== s.approval.fingerprint) {
          s.phase = "awaiting-plan-approval";
          blocker = "Review and approve the current committed planning artifacts and settings";
        } else if (!s.jobs.some(featureActive) && !s.transaction && r && p.tasks.every(t => this.runner.satisfied(r, t.id))) {
          this.current(s);
          try {
            const review = this.review(s);
            const blockers = review.report!.findings!.filter(blocking);
            s.phase = blockers.length ? "fixing" : "awaiting-final-approval";
            if (blockers.length && s.fixRounds >= s.approval.maxFixRounds)
              blocker = `Repair limit (${s.approval.maxFixRounds}) reached; user direction is required`;
          } catch (error: any) { s.phase = "reviewing"; blocker ??= error.message; }
        }
      } catch (error: any) { blocker = error.message; }
    }
    const next: Record<string, string> = { planning: "Prepare OpenSpec artifacts and execution.yaml",
      "awaiting-plan-approval": "feature approve --dry-run --file SETTINGS",
      implementing: "status; launch ready tasks and integrate their results",
      reviewing: "feature review --dry-run", fixing: s.transaction ? "feature integrate --continue" : "feature fix --dry-run",
      "awaiting-final-approval": s.finalApproval ? "feature archive --dry-run" : "feature approve --final --dry-run",
      archiving: "feature archive", completed: "Deliver the integration branch separately" };
    const pendingRepair = s.jobs.at(-1);
    if (s.phase === "fixing" && !s.transaction && s.approval && s.fixRounds >= s.approval.maxFixRounds)
      next.fixing = "Request user direction; a repair-limit increase requires new plan approval";
    if (pendingRepair?.role === "repair" && pendingRepair.phase === "completed")
      next.fixing = `feature integrate --attempt ${pendingRepair.id}`;
    return { ...s, blocker, tasks, next: s.jobs.some(featureActive) ? "Inspect the active job and its saved worker command" : next[s.phase], integration: r?.integration, head: r?.head,
      findings: s.jobs.filter(j => j.role === "review").at(-1)?.report?.findings ?? [], cleanup: r?.cleanupResults };
  }
  planPreview(change: string, input: FeatureSettings) {
    const s = this.read(change);
    if (s.archive || s.phase === "completed") throw new Error("Archived/completed feature cannot be replanned");
    this.assertIdle(s);
    const p = loadPlan(s.planningRoot, change);
    assertCommitted(s.planningRoot, p);
    readiness(s.planningRoot, change);
    run("openspec", ["validate", change, "--strict", "--json"], s.planningRoot);
    const r = this.runner.read(change);
    if (r && r.fingerprint !== p.fingerprint) throw new Error("Reconcile committed planning edits before approval");
    const maxFixRounds = input?.maxFixRounds ?? 2;
    if (!Number.isSafeInteger(maxFixRounds) || maxFixRounds < s.fixRounds || maxFixRounds < 0)
      throw new Error("maxFixRounds must be an integer no smaller than rounds already used");
    const resolveRole = (role: "implementation" | "review" | "repair") => {
      const spec = input?.[role];
      if (!spec || !nonempty(spec.harness) || !nonempty(spec.model) || spec.model === "session" ||
          (spec.effort !== undefined && !nonempty(spec.effort)))
        throw new Error(`${role} requires an explicit harness/model and optional effort`);
      const adapter = getHarness(spec.harness);
      const settings = adapter.resolveSettings({ model: spec.model, effort: spec.effort, dependsOn: [], parallel: false },
        undefined, p.config.agents[spec.harness]);
      if (spec.harness === "codex" && !(settings.effort ?? settings.reasoningEffort))
        throw new Error("Resolve an explicit Codex effort before plan approval");
      return { ...settings, harness: spec.harness,
        ...(spec.harness === "codex" ? { reasoningEffort: settings.effort ?? settings.reasoningEffort } : {}) };
    };
    const implementation = resolveRole("implementation"), review = resolveRole("review"), repair = resolveRole("repair");
    if (implementation.harness !== p.agent) throw new Error("Implementation harness must match execution.yaml/config");
    const tasks = Object.fromEntries(p.tasks.map(t => {
      const settings = getHarness(p.agent).resolveSettings(p.assignments[t.id], implementation, p.config.agents[p.agent]);
      if (p.agent === "codex" && !(settings.effort ?? settings.reasoningEffort))
        throw new Error(`Resolve explicit effort for task ${t.id} before approval`);
      return [t.id, { ...settings, ...(p.agent === "codex" ? { reasoningEffort: settings.effort ?? settings.reasoningEffort } : {}) }];
    }));
    const snapshot = { fingerprint: p.fingerprint, base: r?.integration.base ?? git(s.planningRoot, "rev-parse", "HEAD"),
      implementation, tasks, review, repair, maxFixRounds, verifyIntegration: p.config.verifyIntegration };
    return { ...snapshot, token: digest(snapshot) };
  }
  approve(change: string, input: FeatureSettings, token: string) {
    const approved = this.runner.lock(() => {
      const snapshot = this.planPreview(change, input);
      if (!token || token !== snapshot.token) throw new Error("Plan approval token is stale; preview and review again");
      const s = this.read(change);
      const approval: FeatureApproval = { ...snapshot, at: now() };
      s.approval = approval;
      s.approvalHistory.push(approval);
      s.phase = "implementing";
      delete s.invalidated; delete s.finalApproval; delete s.error;
      this.save(s);
      const existing = this.runner.read(change);
      if (existing) {
        for (const a of existing.attempts)
          if (a.phase !== "integrated" && (!snapshot.tasks[a.task] ||
              settingsIdentity(a.settings) !== settingsIdentity(snapshot.tasks[a.task]))) a.phase = "stale";
        this.runner.save(existing);
      } else {
        const p = loadPlan(s.planningRoot, change), id = randomUUID().slice(0, 8);
        this.runner.save({ version: 2, change, fingerprint: p.fingerprint, head: snapshot.base,
          integration: { branch: `openspec-runner/${change}/${id}/integration`,
            path: resolve(s.planningRoot, ".openspec-runner/worktrees", `${change}-${id}-integration`), base: snapshot.base },
          baseline: p.tasks.filter(t => t.completed).map(t => t.id), planTasks: p.tasks.map(t => t.id), attempts: [], batches: [] });
      }
      return s;
    });
    // Persist reservation first; a failed creation can be retried with the same approval.
    const r = this.execution(approved);
    const exclude = resolve(this.repo.common, "info/exclude");
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!text.split(/\r?\n/).includes(".openspec-runner/")) writeFileSync(exclude, `${text}\n.openspec-runner/\n`);
    if (!existsSync(r.integration.path)) createWorktree(this.repo.root, { ...r.integration, base: r.head }, "git");
    return this.status(change);
  }
  jobPreview(change: string, role: "review" | "repair", retry = false) {
    const s = this.read(change), { p, r } = this.allImplemented(s);
    if (s.archive || s.phase === "completed") throw new Error("Feature has entered archival");
    if (activeFeatureJobs(this.repo.stateDir).length) throw new Error("Another exclusive feature job is active");
    for (const name of readdirSync(this.repo.stateDir).filter(n => n.endsWith(".json") && n !== "lock.json"))
      if (taskActive(decodeState(json(resolve(this.repo.stateDir, name))))) throw new Error("Feature jobs require idle implementation workers");
    let findings = [] as FeatureJob["findings"];
    if (role === "repair") {
      findings = this.review(s).report!.findings!.filter(blocking);
      if (!findings.length) throw new Error("No blocking review findings to repair");
      if (s.fixRounds >= s.approval!.maxFixRounds) throw new Error("Repair limit reached; obtain user direction and a new plan approval to extend it");
    }
    const previous = s.jobs.at(-1);
    if (previous && previous.base === r.head && previous.role === role && previous.approvalToken === s.approval!.token) {
      if (!retry) throw new Error("Job already exists; inspect it and explicitly use --retry for an unsuccessful attempt");
      if (previous.phase === "integrated") throw new Error("Integrated repair cannot be retried");
      if (previous.report?.outcome === "completed" && previous.worker?.exitCode === 0 &&
          (previous.role !== "review" || clean(previous.path) && git(previous.path, "rev-parse", "HEAD") === previous.base))
        throw new Error("Successful job cannot be retried at the same commit");
    }
    return { role, head: r.head, base: s.approval!.base, fingerprint: p.fingerprint,
      settings: s.approval![role], findings, round: role === "repair" ? s.fixRounds + 1 : s.fixRounds,
      terminal: terminalAdapter(s.planningRoot, p.config.terminal), worktrees: p.config.worktrees };
  }
  launch(change: string, role: "review" | "repair", retry = false) {
    const reserved = this.runner.lock(() => {
      const preview = this.jobPreview(change, role, retry), s = this.read(change), id = randomUUID();
      const job: FeatureJob = { id, role, findings: preview.findings, round: preview.round,
        approvalToken: s.approval!.token,
        fingerprint: preview.fingerprint, settings: preview.settings, agent: preview.settings.harness,
        harness: preview.settings.harness, expectedSession: preview.settings.harness === "claude" ? randomUUID() : undefined,
        path: resolve(s.planningRoot, ".openspec-runner/worktrees", id), branch: `openspec-runner/${change}/${role}/${id}`,
        base: preview.head, parallel: false, phase: "preparing", terminal: {} };
      s.jobs.push(job); s.phase = role === "review" ? "reviewing" : "fixing";
      if (role === "repair") s.fixRounds++;
      delete s.finalApproval; delete s.error;
      this.save(s);
      return { job, preview };
    });
    let job = reserved.job;
    try {
      const workspace = createWorktree(this.repo.root, job, reserved.preview.worktrees);
      this.updateJob(change, job.id, j => Object.assign(j, workspace));
      const p = loadPlan(job.path, change);
      for (const cmd of p.config.setup) run(cmd[0], cmd.slice(1), job.path);
      if (!clean(job.path) || git(job.path, "rev-parse", "HEAD") !== job.base)
        throw new Error("Feature setup changed the checkout");
      job = this.updateJob(change, job.id, j => {
        j.gitDir = git(j.path, "rev-parse", "--absolute-git-dir"); j.setupDone = true;
        j.phase = reserved.preview.terminal === "manual" ? "manual" : "launching";
      });
      if (reserved.preview.terminal !== "manual") {
        const terminal = { ...job.terminal };
        startTerminal(this.repo.root, job.path, this.repo.common, job.id, job.settings, this.prompt(change, job), terminal,
          () => { this.updateJob(change, job.id, j => { j.terminal = { ...terminal }; }); },
          this.workerCommand(change, job), job.agent, reserved.preview.terminal);
      }
    } catch (error: any) {
      this.update(change, s => {
        s.error = error.message;
        const j = s.jobs.find(j => j.id === job.id)!;
        j.error = error.message;
        if (!j.terminal.phase && !j.worker) j.phase = "failed";
      });
      throw error;
    }
    return { ...this.read(change).jobs.find(j => j.id === job.id)!, command: this.workerCommand(change, job) };
  }
  private updateJob(change: string, id: string, fn: (j: FeatureJob) => void) {
    const s = this.update(change, s => {
      const j = s.jobs.find(j => j.id === id);
      if (!j) throw new Error("Unknown feature attempt");
      fn(j);
    });
    return s.jobs.find(j => j.id === id)!;
  }
  workerCommand(change: string, j: FeatureJob) {
    return shellCommand([process.execPath, fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url)),
      "feature", "worker", change, "--attempt", j.id]);
  }
  prompt(change: string, j: FeatureJob) {
    const s = this.read(change), skill = `openspec-runner-${j.role === "review" ? "review" : "repair"}`;
    const input = resolve(dirname(j.path), "reports", `${j.id}-input.json`);
    return `${j.agent === "claude" ? "/" : "Use $"}${skill}\nChange: ${change}\nAttempt: ${j.id}\n` +
      `First run: openspec-runner feature begin ${change} --attempt ${j.id}${j.expectedSession ? ` --session ${j.expectedSession}` : ""}\n` +
      `Review base: ${s.approval!.base}\nHead: ${j.base}\nFingerprint: ${j.fingerprint}\n` +
      `Role: ${j.role}. ${j.role === "review" ? "Review the entire feature; do not edit tracked files." : "Repair only the supplied blockers; do not change planning artifacts or checkboxes. Commit repairs."}\n` +
      `Findings/history: ${JSON.stringify(j.role === "repair" ? j.findings : s.jobs.filter(x => x.role === "review" && x.id !== j.id).at(-1)?.report?.findings ?? [])}\n` +
      `Report fields: attempt, session, outcome (completed/blocked/failed), head (${j.base}), fingerprint (${j.fingerprint}), summary, verification (nonempty strings), ` +
      `${j.role === "review" ? "findings (array of {id, category: correctness/security/spec/verification/style/improvement, location, impact, correction})" : "commit (full HEAD SHA for completed repairs)"}.\n` +
      `Write JSON at ${input}; submit: openspec-runner feature report ${change} --attempt ${j.id} --file ${shellCommand([input])}. End immediately after acceptance. Do not archive, integrate, or change runner state yourself.`;
  }
  begin(change: string, id: string, session?: string) {
    return this.updateJob(change, id, j => {
      const identity = session ?? (j.agent === "codex" ? process.env.CODEX_THREAD_ID : undefined);
      if (!j.setupDone || !j.worker || j.worker.exitedAt || !["manual", "launching", "running"].includes(j.phase))
        throw new Error("Feature worker must be supervised and ready before begin");
      if (this.repo.root !== j.path || !identity || !/^[a-zA-Z0-9_-]+$/.test(identity) ||
          (j.session && j.session !== identity) || (j.expectedSession && j.expectedSession !== identity))
        throw new Error("Feature session/worktree identity mismatch");
      j.session = identity; j.phase = "running";
    });
  }
  report(change: string, id: string, report: FeatureReport) {
    return this.updateJob(change, id, j => {
      validateFeatureReport(report, j.role);
      if ((!j.report && (j.phase !== "running" || j.worker?.exitedAt)) || !j.session || this.repo.root !== j.path ||
          report.attempt !== id || report.session !== j.session || report.head !== j.base || report.fingerprint !== j.fingerprint)
        throw new Error("Feature report identity or reviewed snapshot mismatch");
      if (j.report) {
        if (JSON.stringify(j.report) === JSON.stringify(report)) return;
        throw new Error("Feature report already accepted; use a new attempt");
      }
      if (report.outcome === "completed") {
        if (j.role === "review") {
          if (!clean(j.path) || git(j.path, "rev-parse", "HEAD") !== j.base ||
              git(j.path, "symbolic-ref", "--short", "HEAD") !== j.branch)
            throw new Error("Reviewer changed its checkout");
        } else this.runner.verifyResult(j, report, change);
      }
      atomic(resolve(this.repo.stateDir, "reports", `${id}.json`), report);
      j.report = report; j.phase = report.outcome;
    });
  }
  async worker(change: string, id: string) {
    const s = this.read(change);
    this.current(s);
    const j = this.updateJob(change, id, j => {
      if (!j.setupDone || !["manual", "launching"].includes(j.phase) || j.session || j.worker)
        throw new Error("Feature worker already started or is not ready; inspect saved evidence");
      j.worker = { token: randomUUID(), log: resolve(this.repo.stateDir, "logs", `${id}.log`) };
    });
    let exitCode: number | null = null, failure: unknown;
    try {
      exitCode = await superviseWorker(j, this.repo.common, this.prompt(change, j), pid => {
        this.updateJob(change, id, current => { current.worker!.pid = pid; current.worker!.processStart = processStart(pid); });
      }, (fn: (current: SupervisedSession) => void) => { this.updateJob(change, id, fn); });
    } catch (error) { failure = error; }
    this.update(change, s => {
      const current = s.jobs.find(j => j.id === id)!;
      current.worker!.exitedAt = now(); current.worker!.exitCode = exitCode;
      if (failure || exitCode !== 0 || !current.report || current.report.outcome !== "completed") {
        current.phase = current.report?.outcome === "blocked" ? "blocked" : "failed";
        s.error = current.error = String(failure ?? current.report?.summary ?? "Feature worker exited without an accepted report");
      } else if (current.role === "review") {
        s.phase = current.report!.findings!.some(blocking) ? "fixing" : "awaiting-final-approval";
        delete s.error;
      }
    });
    if (failure) throw failure;
    return { attempt: id, exitCode, log: j.worker!.log };
  }
  recover(change: string, id: string) {
    // This never replays dispatch. A fresh attempt requires an explicit --retry.
    return this.update(change, s => {
      const j = s.jobs.find(j => j.id === id);
      if (!j || j.phase === "integrated") throw new Error("No recoverable feature job");
      if (j.worker?.exitedAt) throw new Error("Job already exited; inspect and explicitly retry");
      if (j.worker?.pid) {
        if (!j.worker.processStart || process.platform !== "linux" || processStart(j.worker.pid) === j.worker.processStart)
          throw new Error("Worker is running or process identity is uncertain; retain its resources");
        j.worker.exitedAt = now(); j.worker.exitCode = null;
      } else if (j.worker || j.terminal.phase || j.session)
        throw new Error("Startup is ambiguous; inspect saved process/terminal evidence before recovery");
      j.phase = "failed";
      s.error = j.error = "Interrupted job; inspect retained resources and explicitly retry";
    });
  }
  integrate(change: string, id?: string, mode?: "continue" | "abort") {
    return this.runner.lock(() => {
      const s = this.read(change), r = this.execution(s), path = r.integration.path;
      const tx = s.transaction;
      if (mode && !tx) throw new Error("No interrupted feature integration");
      if (mode === "abort") {
        if (git(path, "rev-parse", "HEAD") !== tx!.before) throw new Error("Repair commit exists; use --continue");
        if (attempt(() => git(path, "rev-parse", "--verify", "MERGE_HEAD"))) git(path, "merge", "--abort");
        else git(path, "reset", "--hard", tx!.before);
        delete s.transaction; this.save(s); return { aborted: true };
      }
      const j = s.jobs.find(j => j.id === (mode === "continue" ? tx!.attempt : id));
      if (!j || j.role !== "repair") throw new Error("Specify a repair --attempt");
      if (j.phase === "integrated" && !tx) return { head: r.head, alreadyIntegrated: true };
      this.successful(j);
      this.runner.verifyResult(j, j.report!, change);
      const p = loadPlan(s.planningRoot, change);
      approvedFeature(this.repo.stateDir, p);
      if (s.jobs.some(featureActive) || taskActive(r) || r.transaction) throw new Error("Finish active jobs first");
      if (!tx) {
        this.current(s);
        if (j.base !== r.head || j.fingerprint !== s.approval!.fingerprint) throw new Error("Repair base or plan is stale");
        s.transaction = { attempt: j.id, before: r.head, marker: `openspec-runner-repair:${j.id}`, phase: "merging" };
        this.save(s);
      }
      const transaction = s.transaction!;
      try {
        const head = git(path, "rev-parse", "HEAD");
        if (head === transaction.before) {
          if (transaction.phase === "merging" && !attempt(() => git(path, "rev-parse", "--verify", "MERGE_HEAD"))) {
            if (!clean(path)) throw new Error("Unexpected integration edits before repair merge");
            git(path, "merge", "--no-ff", "--no-commit", j.report!.commit!);
          }
          if (git(path, "diff", "--name-only", "--diff-filter=U")) throw new Error("Resolve repair conflicts then feature integrate --continue");
          transaction.phase = "checking"; this.save(s);
          for (const cmd of p.config.verifyIntegration) run(cmd[0], cmd.slice(1), path);
          if (loadPlan(path, change).fingerprint !== p.fingerprint ||
              git(path, "diff", "HEAD", "--name-only", "--", `openspec/changes/${change}`, "openspec/runner.yaml", "openspec/config.yaml"))
            throw new Error("Repair integration changed planning artifacts");
          if (git(path, "diff", "--name-only") || git(path, "ls-files", "--others", "--exclude-standard"))
            throw new Error("Repair checks left changes to inspect before --continue");
          transaction.phase = "committing"; this.save(s);
          git(path, "commit", "-m", `Repair OpenSpec feature ${change}\n\n${transaction.marker}`);
        } else if (git(path, "log", "-1", "--format=%B").includes(transaction.marker) &&
            git(path, "rev-parse", "HEAD^1") === transaction.before && clean(path)) {
          git(path, "merge-base", "--is-ancestor", j.report!.commit!, head);
        } else throw new Error("Unexpected repair integration HEAD; inspect before recovery");
        r.head = git(path, "rev-parse", "HEAD"); delete r.completion;
        this.runner.save(r);
        j.phase = "integrated"; delete s.transaction; delete s.finalApproval; delete s.error;
        s.phase = "reviewing"; this.save(s);
        return { head: r.head, branch: r.integration.branch, next: "feature review" };
      } catch (error: any) { s.error = error.message; this.save(s); throw error; }
    });
  }
  finalPreview(change: string) {
    const s = this.read(change), { p, r } = this.allImplemented(s), review = this.review(s);
    if (s.archive || s.phase === "completed") throw new Error("Feature has entered archival");
    if (review.report!.findings!.some(blocking)) throw new Error("Blocking review findings remain");
    for (const cmd of p.config.verifyIntegration) run(cmd[0], cmd.slice(1), r.integration.path);
    this.current(s);
    run("openspec", ["validate", change, "--strict", "--json"], r.integration.path);
    const snapshot = { head: r.head, review: review.id, approval: s.approval!.token,
      summary: review.report!.summary, findings: review.report!.findings, verification: review.report!.verification };
    const specPrefix = `openspec/changes/${change}/specs/`;
    return { ...snapshot, token: digest(snapshot), branch: r.integration.branch,
      archive: { change, synchronizeSpecs: true, worktree: r.integration.path,
        source: `openspec/changes/${change}`, destinationRoot: "openspec/changes/archive",
        canonicalSpecs: p.files.map(file => file.replaceAll("\\", "/")).filter(file => file.startsWith(specPrefix))
          .map(file => `openspec/specs/${file.slice(specPrefix.length)}`) } };
  }
  approveFinal(change: string, token: string) {
    return this.runner.lock(() => {
      const preview = this.finalPreview(change);
      if (!token || token !== preview.token) throw new Error("Final approval token is stale; review the current result again");
      const s = this.read(change);
      s.finalApproval = { token, head: preview.head, review: preview.review, at: now() };
      s.phase = "awaiting-final-approval"; delete s.error; this.save(s);
      return s.finalApproval;
    });
  }
  archivePreview(change: string) {
    const s = this.read(change);
    if (s.archive || s.phase === "completed") return { archive: s.archive, phase: s.phase, recovery: s.phase !== "completed" };
    const preview = this.finalPreview(change);
    return { ...preview, approved: s.finalApproval?.token === preview.token };
  }
  archive(change: string) {
    return this.runner.lock(() => {
      const s = this.read(change), r = this.execution(s), path = r.integration.path;
      if (s.phase === "completed") return { completed: true, archive: s.archive, branch: r.integration.branch };
      if (git(path, "symbolic-ref", "--short", "HEAD") !== r.integration.branch)
        throw new Error("Integration worktree changed branches; inspect before archival");
      if (!s.archive) {
        const preview = this.finalPreview(change);
        if (s.finalApproval?.token !== preview.token) throw new Error("Final user approval is required before archival");
        const dir = resolve(path, "openspec/changes/archive");
        s.archive = { before: r.head, marker: `openspec-runner-archive:${randomUUID()}`, phase: "started",
          directories: existsSync(dir) ? readdirSync(dir) : [] };
        s.phase = "archiving"; this.save(s);
      }
      const tx = s.archive;
      try {
        let head = git(path, "rev-parse", "HEAD");
        if (head === tx.before) {
          if (tx.phase === "started" && existsSync(resolve(path, "openspec/changes", change))) {
            if (!clean(path)) throw new Error("Partial archival edits require inspection; finish OpenSpec archival before retrying");
            run("openspec", ["archive", change, "--yes", "--json"], path);
          }
          if (existsSync(resolve(path, "openspec/changes", change))) throw new Error("OpenSpec did not archive the active change");
          const archiveDir = resolve(path, "openspec/changes/archive");
          const candidates = readdirSync(archiveDir).filter(n => !tx.directories.includes(n) && (n === change || n.endsWith(`-${change}`)));
          if (candidates.length !== 1) throw new Error("Cannot identify unique archive output; inspect before recovery");
          tx.path = `openspec/changes/archive/${candidates[0]}`;
          const changed = [...git(path, "diff", "HEAD", "--name-only", "--no-renames").split("\n"),
            ...git(path, "ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean);
          if (changed.some(name => !name.startsWith(`openspec/changes/${change}/`) &&
              !name.startsWith(`${tx.path}/`) && !name.startsWith("openspec/specs/")))
            throw new Error("Archival changed files outside the change and canonical specs");
          run("openspec", ["validate", "--all", "--strict", "--json"], path);
          tx.phase = "produced"; this.save(s);
          git(path, "add", "--all", "--", "openspec/changes");
          if (existsSync(resolve(path, "openspec/specs"))) git(path, "add", "--", "openspec/specs");
          const tree = git(path, "write-tree");
          if (git(path, "rev-parse", `${tree}:${tx.path}`) !== git(path, "rev-parse", `${tx.before}:openspec/changes/${change}`))
            throw new Error("Archived artifacts differ from the approved artifacts");
          tx.tree = tree; tx.phase = "committing"; this.save(s);
          git(path, "commit", "-m", `Archive OpenSpec feature ${change}\n\n${tx.marker}`);
          head = git(path, "rev-parse", "HEAD");
        }
        if (!git(path, "log", "-1", "--format=%B").includes(tx.marker) ||
            git(path, "rev-parse", "HEAD^1") !== tx.before || git(path, "rev-parse", "HEAD^{tree}") !== tx.tree || !clean(path))
          throw new Error("Unexpected archive commit or worktree; inspect before recovery");
        tx.commit = head; tx.phase = "committed"; this.save(s);
        if (s.planningRoot !== path && loadPlan(s.planningRoot, change).fingerprint !== s.approval!.fingerprint)
          throw new Error("Planning artifacts changed during archival");
        for (const cmd of s.approval!.verifyIntegration) run(cmd[0], cmd.slice(1), path);
        run("openspec", ["validate", "--all", "--strict", "--json"], path);
        if (!clean(path) || git(path, "rev-parse", "HEAD") !== head) throw new Error("Post-archive checks changed the integration worktree");
        r.head = head;
        r.completion = { head, fingerprint: r.fingerprint, tasks: Object.keys(s.approval!.tasks) };
        this.runner.save(r);
        s.phase = "completed"; s.completedAt = now(); delete s.error; this.save(s);
        return { completed: true, branch: r.integration.branch, head, archive: tx, cleanup: r.cleanupResults };
      } catch (error: any) { s.error = error.message; this.save(s); throw error; }
    });
  }
}
