import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectCleanup, removeInspectedWorktree, type CleanupResult, type CleanupOptions } from "./cleanup.js";
import { closeInspectedTerminal } from "./terminal-cleanup.js";
import { superviseWorker } from "./worker.js";
import { processStart } from "./processes.js";
import {
  atomic,
  json,
  git,
  run,
  clean,
  shellCommand,
  repository,
  locked,
  attempt,
} from "./system.js";
import {
  loadPlan,
  assertCommitted,
  readiness,
  tasksFrom,
  type Plan,
} from "./plan.js";
import type { HarnessSettings } from "./harnesses/types.js";
import { getHarness } from "./harnesses/registry.js";
import {
  createWorktree,
  startTerminal,
  attachTerminal,
  terminalAdapter,
  type Workspace,
  type Terminal,
} from "./adapters.js";
export interface Report {
  attempt: string;
  task: string;
  session: string;
  outcome: "completed" | "failed" | "blocked";
  commit?: string;
  summary: string;
  verification: string[];
}
export interface TaskAttempt extends Workspace {
  id: string;
  task: string;
  description: string;
  fingerprint: string;
  settings: HarnessSettings;
  /** Immutable harness selected for the batch containing this attempt. */
  agent?: string;
  harness?: string;
  batch?: string;
  expectedSession?: string;
  observedSession?: string;
  identityConfirmed?: boolean;
  terminalEvidence?: { type: string; subtype?: string; metadata?: Record<string, unknown> };
  parallel: boolean;
  phase:
    | "preparing"
    | "manual"
    | "launching"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "integrated"
    | "stale";
  terminal: Terminal;
  session?: string;
  report?: Report;
  error?: string;
  cleaned?: boolean;
  setupDone?: boolean;
  gitDir?: string;
  worker?: { token: string; pid?: number; processStart?: string; exitedAt?: string; exitCode?: number | null; log: string };
}
interface Transaction {
  tasks: string[];
  current: string;
  before: string;
  phase: "merging" | "checking" | "committing";
  marker: string;
}
export interface State {
  version: 1 | 2;
  change: string;
  fingerprint: string;
  integration: Workspace;
  head: string;
  baseline: string[];
  attempts: TaskAttempt[];
  batches?: Array<{ id: string; harness: string; attempts: string[] }>;
  transaction?: Transaction;
  cleanupBatch?: string[];
  planTasks?: string[];
  completion?: { tasks: string[]; fingerprint: string; head: string };
  cleanupResults?: CleanupResult[];
}
const active = (a: TaskAttempt) =>
  ["preparing", "manual", "launching", "running"].includes(a.phase);

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasKnownHarness(id: string): boolean {
  try {
    getHarness(id);
    return true;
  } catch {
    return false;
  }
}

/** Decode both persisted formats without writing during read-only commands. */
export function decodeState(raw: unknown): State {
  if (!record(raw) || (raw.version !== 1 && raw.version !== 2))
    throw new Error(
      `Unsupported runner state version: ${record(raw) ? String(raw.version) : "unknown"}`,
    );
  if (typeof raw.change !== "string" || !Array.isArray(raw.attempts))
    throw new Error("Invalid runner state: change and attempts are required");
  const attempts = raw.attempts.map((attempt: any) => {
    if (!record(attempt) || typeof attempt.id !== "string" || typeof attempt.task !== "string")
      throw new Error("Invalid runner state attempt identity");
    if (attempt.agent !== undefined && attempt.harness !== undefined && attempt.agent !== attempt.harness)
      throw new Error(`Attempt has conflicting harness identities: ${attempt.id}`);
    return {
      ...attempt,
      agent: attempt.agent ?? attempt.harness ?? "codex",
      harness: attempt.harness ?? attempt.agent ?? "codex",
    } as TaskAttempt;
  });
  if (new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length)
    throw new Error("Duplicate runner state attempt ID");
  const batches = raw.version === 1
    ? attempts.map((attempt) => ({
        id: `legacy-${attempt.id}`,
        harness: "codex",
        attempts: [attempt.id],
      }))
    : raw.batches;
  if (!Array.isArray(batches)) throw new Error("Version 2 runner state requires batches");
  const byId = new Map<string, { id: string; harness: string; attempts: string[] }>();
  for (const batch of batches) {
    if (!record(batch) || typeof batch.id !== "string" || typeof batch.harness !== "string" || !Array.isArray(batch.attempts))
      throw new Error("Invalid runner state batch");
    if (!hasKnownHarness(batch.harness)) throw new Error(`Unknown harness in runner state: ${batch.harness}`);
    if (byId.has(batch.id)) throw new Error(`Duplicate runner state batch: ${batch.id}`);
    byId.set(batch.id, batch as { id: string; harness: string; attempts: string[] });
  }
  const memberships = new Map<string, string>();
  for (const batch of byId.values()) {
    for (const id of batch.attempts) {
      if (memberships.has(id)) throw new Error(`Attempt belongs to multiple batches: ${id}`);
      memberships.set(id, batch.id);
    }
  }
  for (const current of attempts) {
    const batchId = current.batch ?? memberships.get(current.id);
    if (!batchId) throw new Error(`Attempt is not assigned to a batch: ${current.id}`);
    const batch = byId.get(batchId);
    if (!batch || batch.harness !== (current.agent ?? "codex"))
      throw new Error(`Attempt/batch harness mismatch: ${current.id}`);
    current.batch = batchId;
    if (!batch.attempts.includes(current.id)) batch.attempts.push(current.id);
  }
  const attemptIds = new Set(attempts.map((current) => current.id));
  for (const [id] of memberships)
    if (!attemptIds.has(id)) throw new Error(`Batch references unknown attempt: ${id}`);
  return { ...raw, version: 2, attempts, batches: [...byId.values()] } as State;
}
export class Runner {
  repo: ReturnType<typeof repository>;
  constructor(cwd = process.cwd()) {
    this.repo = repository(cwd);
  }
  private ensureRuntimeExcluded() {
    const exclude = resolve(this.repo.common, "info", "exclude"),
      marker = ".openspec-runner/",
      current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === marker)) return;
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(
      exclude,
      `${current}${prefix}# OpenSpec runner runtime worktrees\n${marker}\n`,
    );
  }
  private worktreePath(...parts: string[]) {
    // Claude Code protects .git paths from automatic edits. Keep durable
    // runner state in repo.common, but put agent workspaces and report inputs
    // in a sibling runtime directory inside the repository root.
    return resolve(this.repo.root, ".openspec-runner", "worktrees", ...parts);
  }
  path(change: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change))
      throw new Error("Invalid change name");
    return join(this.repo.stateDir, `${change}.json`);
  }
  read(change: string): State | undefined {
    const p = this.path(change);
    return existsSync(p) ? decodeState(json<unknown>(p)) : undefined;
  }
  save(s: State) {
    const path = this.path(s.change);
    if (existsSync(path)) {
      try {
        const previous = json<any>(path);
        const backup = `${path}.v1-backup`;
        if (previous.version === 1 && !existsSync(backup))
          writeFileSync(backup, JSON.stringify(previous, null, 2) + "\n", { mode: 0o600 });
      } catch {
        // The decoder remains the authority for reporting malformed state.
      }
    }
    const normalized = decodeState({ ...s, version: s.version });
    atomic(path, { ...normalized, version: 2 });
  }
  lock<T>(fn: () => T) {
    return locked(this.repo.stateDir, fn);
  }
  private updateAttempt(
    change: string,
    id: string,
    update: (attempt: TaskAttempt) => void,
  ) {
    return this.lock(() => {
      const state = this.requireState(change),
        current = state.attempts.find((attempt) => attempt.id === id);
      if (!current) throw new Error(`Attempt is no longer registered: ${id}`);
      update(current);
      this.save(state);
      return current;
    });
  }
  latest(s: State, id: string) {
    return s.attempts.filter((a) => a.task === id).at(-1);
  }
  requireState(change: string) {
    const s = this.read(change);
    if (!s) throw new Error("No execution state; launch a batch first");
    return s;
  }
  satisfied(s: State, id: string) {
    return (
      s.baseline.includes(id) || this.latest(s, id)?.phase === "integrated"
    );
  }
  drift(p: Plan, s: State) {
    if (p.fingerprint !== s.fingerprint)
      throw new Error(
        "Planning artifacts changed. Finish/report active sessions, then run reconcile before launching or integrating.",
      );
  }
  status(change: string) {
    const p = loadPlan(this.repo.root, change),
      s = this.read(change);
    return {
      change,
      agent: p.agent,
      harness: p.agent,
      batches: s?.batches,
      drift: !!s && s.fingerprint !== p.fingerprint,
      integration: s?.integration,
      head: s?.head,
      transaction: s?.transaction,
      cleanup: s?.cleanupResults,
      tasks: p.tasks.map((t) => ({
        ...t,
        assignment: p.assignments[t.id],
        ready:
          (!s || s.fingerprint === p.fingerprint) &&
          !s?.transaction &&
          !(s
            ? this.satisfied(s, t.id) || this.latest(s, t.id)
            : t.completed) &&
          p.assignments[t.id].dependsOn.every((d) =>
            s
              ? this.satisfied(s, d)
              : p.tasks.find((x) => x.id === d)?.completed,
          ),
        attempts: s?.attempts.filter((a) => a.task === t.id) ?? [],
      })),
    };
  }
  selection(p: Plan, ids: string[]) {
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !p.assignments[id])
    )
      throw new Error("Select unique existing task IDs with --tasks 2.1,2.2");
  }
  harness(p: Plan, selected?: string) {
    return getHarness(selected ?? p.agent ?? p.config.defaultAgent ?? "codex");
  }
  preview(
    change: string,
    ids: string[],
    settings?: HarnessSettings,
    base = "HEAD",
    retry = false,
    agent?: string,
  ) {
    const p = loadPlan(this.repo.root, change);
    const harness = this.harness(p, agent), selectedAgent = harness.id;
    this.selection(p, ids);
    const s = this.read(change);
    if (s) {
      this.drift(p, s);
      if (s.transaction)
        throw new Error("Finish or abort pending integration first");
    }
    const head =
      s?.head ??
      git(this.repo.root, "rev-parse", "--verify", `${base}^{commit}`);
    assertCommitted(this.repo.root, p);
    if (!s) assertCommitted(this.repo.root, p, head);
    readiness(this.repo.root, change);
    const allStates = existsSync(this.repo.stateDir)
      ? readdirSync(this.repo.stateDir)
          .filter((n) => n.endsWith(".json") && n !== "lock.json")
          .map((n) => decodeState(json<unknown>(join(this.repo.stateDir, n))))
      : [];
    const running = allStates.flatMap((s) => s.attempts.filter(active));
    for (const id of ids) {
      const old = s && this.latest(s, id);
      if (
        s ? this.satisfied(s, id) : p.tasks.find((t) => t.id === id)!.completed
      )
        throw new Error(`Task already satisfied: ${id}`);
      if (
        old &&
        (!retry || !["failed", "blocked", "stale"].includes(old.phase))
      )
        throw new Error(
          `Task ${id} already has an attempt; attach or explicitly retry a failed/blocked/stale attempt`,
        );
      if (retry && !old)
        throw new Error("retry requires an existing unsuccessful attempt");
      if (retry && old?.worker && !old.worker.exitedAt)
        throw new Error("Retry requires the previous supervised worker to have stopped");
      if (
        !p.assignments[id].dependsOn.every((d) =>
          s ? this.satisfied(s, d) : p.tasks.find((t) => t.id === d)?.completed,
        )
      )
        throw new Error(`Dependencies are not integrated: ${id}`);
    }
    const selected = ids.map((id) => ({
      task: id,
      settings: harness.resolveSettings(
        p.assignments[id],
        settings,
        p.config.agents[selectedAgent],
      ),
      parallel: p.assignments[id].parallel,
    }));
    if (running.length + ids.length > p.config.maxParallel)
      throw new Error("Repository concurrency limit exceeded");
    if (
      running.length + ids.length > 1 &&
      [...running, ...selected].some((a) => !a.parallel)
    )
      throw new Error(
        "Exclusive task must run alone; all overlapping tasks must permit parallel execution",
      );
    return {
      change,
      agent: selectedAgent,
      harness: selectedAgent,
      base: head,
      terminal: terminalAdapter(this.repo.root, p.config.terminal),
      tasks: selected,
    };
  }
  launch(
    change: string,
    ids: string[],
    settings?: HarnessSettings,
    base = "HEAD",
    retry = false,
    defaults = new Map<string, string>(),
    agent?: string,
  ) {
    const prepared = this.lock(() => {
      const preview = this.preview(change, ids, settings, base, retry, agent),
        p = loadPlan(this.repo.root, change);
      this.ensureRuntimeExcluded();
      let s = this.read(change);
      if (!s) {
        const token = randomUUID().slice(0, 8),
          branch = `openspec-runner/${change}/${token}/integration`;
        s = {
          version: 2,
          change,
          fingerprint: p.fingerprint,
          integration: {
            branch,
            path: this.worktreePath(`${change}-${token}-integration`),
            base: preview.base,
          },
          head: preview.base,
          baseline: p.tasks.filter((t) => t.completed).map((t) => t.id),
          attempts: [],
          batches: [],
        };
        this.save(s);
      }
      const state = s;
      delete state.completion;
      state.planTasks = p.tasks.map(t => t.id);
      const batchId = randomUUID();
      state.batches ??= [];
      state.batches.push({ id: batchId, harness: preview.agent, attempts: [] });
      const batch: TaskAttempt[] = preview.tasks.map((item) => {
        const id = randomUUID(),
          branch = `openspec-runner/${change}/${item.task}/${id}`;
        return {
          id,
          task: item.task,
          description: p.tasks.find((t) => t.id === item.task)!.description,
          fingerprint: p.fingerprint,
          settings: {
            ...item.settings,
            reasoningEffort:
              item.settings.reasoningEffort ??
              defaults.get(item.settings.model),
          },
          agent: preview.agent,
          harness: preview.agent,
          batch: batchId,
          ...(preview.agent === "claude" ? { expectedSession: randomUUID() } : {}),
          parallel: item.parallel,
          branch,
          path: this.worktreePath(id),
          base: state.head,
          phase: "preparing",
          terminal: {},
        };
      });
      state.attempts.push(...batch);
      state.batches.find((candidate) => candidate.id === batchId)!.attempts.push(...batch.map((a) => a.id));
      this.save(state);
      return {
        preview,
        plan: p,
        batch,
        integration: { ...state.integration, base: state.head },
      };
    });

    // Worktree and terminal commands can start processes that immediately acquire
    // the repository lock, so all external preparation happens outside it.
    const integration = createWorktree(
      this.repo.root,
      prepared.integration,
      "git",
    );
    this.lock(() => {
      const state = this.requireState(change);
      state.integration = integration;
      this.save(state);
      if (
        !clean(state.integration.path) ||
        git(state.integration.path, "rev-parse", "HEAD") !== state.head
      )
        throw new Error("Integration worktree differs from recorded head");
    });

    for (const registered of prepared.batch) {
      let attempt = registered;
      try {
        const workspace = createWorktree(
          this.repo.root,
          attempt,
          prepared.plan.config.worktrees,
        );
        attempt = this.updateAttempt(change, attempt.id, (current) =>
          Object.assign(current, workspace, { gitDir: git(workspace.path, "rev-parse", "--absolute-git-dir") }),
        );
        for (const command of prepared.plan.config.setup)
          run(command[0], command.slice(1), attempt.path);
        attempt = this.updateAttempt(change, attempt.id, (current) => {
          current.setupDone = true;
        });
        if (prepared.preview.terminal === "manual") {
          attempt = this.updateAttempt(change, attempt.id, (current) => {
            current.phase = "manual";
          });
        } else {
          attempt = this.updateAttempt(change, attempt.id, (current) => {
            current.phase = "launching";
          });
          const terminal = { ...attempt.terminal };
          startTerminal(
            this.repo.root,
            attempt.path,
            this.repo.common,
            attempt.id,
            attempt.settings,
            this.prompt(change, attempt),
            terminal,
            () => {
              attempt = this.updateAttempt(change, attempt.id, (current) => {
                current.terminal = { ...terminal };
              });
            },
            this.workerCommand(change, attempt),
            attempt.agent,
            prepared.preview.terminal,
          );
        }
      } catch (e: any) {
        attempt = this.updateAttempt(change, attempt.id, (current) => {
          current.error = e.message;
          if (!current.terminal.phase) current.phase = "failed";
        });
      }
    }
    const state = this.requireState(change);
    return prepared.batch.map(({ id }) => {
      const a = state.attempts.find((attempt) => attempt.id === id)!;
      return {
        ...a,
        command: this.command(change, a),
        prompt: this.prompt(change, a),
      };
    });
  }
  recover(change: string, task: string) {
    const prepared = this.lock(() => {
      const s = this.requireState(change),
        a = this.latest(s, task),
        p = loadPlan(this.repo.root, change);
      this.drift(p, s);
      if (
        !a ||
        !active(a) ||
        a.session ||
        a.terminal.phase ||
        !["preparing", "launching"].includes(a.phase)
      )
        throw new Error(
          "This attempt cannot safely replay preparation; use attach to inspect its existing session",
        );
      return { attempt: a, plan: p };
    });
    let attempt = prepared.attempt;
    const workspace = createWorktree(
      this.repo.root,
      attempt,
      prepared.plan.config.worktrees,
    );
    attempt = this.updateAttempt(change, attempt.id, (current) =>
      Object.assign(current, workspace, { gitDir: git(workspace.path, "rev-parse", "--absolute-git-dir") }),
    );
    if (!attempt.setupDone) {
      // Explicit recovery may rerun setup; setup commands should be idempotent.
      for (const command of prepared.plan.config.setup)
        run(command[0], command.slice(1), attempt.path);
      attempt = this.updateAttempt(change, attempt.id, (current) => {
        current.setupDone = true;
      });
    }
    const backend = terminalAdapter(this.repo.root, prepared.plan.config.terminal);
    if (backend === "manual") {
      attempt = this.updateAttempt(change, attempt.id, (current) => {
        current.phase = "manual";
      });
    } else {
      attempt = this.updateAttempt(change, attempt.id, (current) => {
        current.phase = "launching";
      });
      const terminal = { ...attempt.terminal };
      startTerminal(
        this.repo.root,
        attempt.path,
        this.repo.common,
        attempt.id,
        attempt.settings,
        this.prompt(change, attempt),
        terminal,
        () => {
          attempt = this.updateAttempt(change, attempt.id, (current) => {
            current.terminal = { ...terminal };
          });
        },
        this.workerCommand(change, attempt),
        attempt.agent,
        backend,
      );
    }
    return { ...attempt, command: this.command(change, attempt) };
  }
  prompt(change: string, a: TaskAttempt) {
    const claude = a.agent === "claude";
    const skillInvocation = claude
      ? "/openspec-runner-implement"
      : "Use $openspec-runner-implement.";
    const begin = claude
      ? `openspec-runner begin ${change} ${a.task} --attempt ${a.id} --session ${a.expectedSession}`
      : `openspec-runner begin ${change} ${a.task} --attempt ${a.id}`;
    const identity = claude ? "the exact Claude stream session_id" : "the actual CODEX_THREAD_ID";
    const reportPath = resolve(
        dirname(a.path),
        "reports",
        `${a.id}-input.json`,
      ),
      reportCommand = shellCommand([
        "openspec-runner",
        "report",
        change,
        a.task,
        "--attempt",
        a.id,
        "--file",
        reportPath,
      ]);
    return `${skillInvocation} Implement ONLY task ${a.task}: ${a.description}\nChange: ${change}\nAttempt: ${a.id}\nHarness: ${a.agent ?? "codex"}\nFirst run: ${begin}\nRead the change artifacts. Do not modify planning artifacts, checkboxes, execution.yaml, or runner.yaml. Verify and commit task changes. Then run ${reportCommand}. The report JSON must contain attempt, task, session (${identity}), outcome (completed/failed/blocked), commit (full HEAD SHA for completed), summary, and verification (nonempty evidence strings). Write the report input exactly at ${reportPath}, outside the task worktree and inside the runner-owned runtime directory. The reserved session is intent only; the runner must observe matching session evidence before a completed ${a.agent ?? "Codex"} result can be integrated. Stop after reporting.`;
  }
  command(change: string, a: TaskAttempt) {
    if (!a.session) return this.workerCommand(change, a);
    if (a.agent === "claude" && !a.identityConfirmed) return undefined;
    const invocation = getHarness(a.agent ?? "codex").resumeInvocation(
      a.settings,
      a.path,
      this.repo.common,
      a.session,
    );
    return shellCommand([invocation.executable, ...invocation.args]);
  }
  workerCommand(change: string, a: TaskAttempt) {
    return shellCommand([process.execPath, fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url)),
      "worker", change, a.task, "--attempt", a.id]);
  }
  async worker(change: string, task: string, id: string) {
    const prepared = this.lock(() => {
      const s = this.requireState(change), a = this.latest(s, task);
      if (!a || a.id !== id || !a.setupDone)
        throw new Error("Worker attempt is not ready; inspect before retrying");
      if (a.worker) {
        if (a.worker.exitedAt) throw new Error("Worker already exited; inspect its saved report and log");
        if (a.worker.pid && (!a.worker.processStart || processStart(a.worker.pid) === a.worker.processStart))
          throw new Error("Worker is still running or its process identity is uncertain");
        a.worker.exitedAt = new Date().toISOString();
        a.worker.exitCode = null;
        if (!a.report) {
          a.phase = "failed";
          a.error = "Worker supervisor disappeared without an accepted report; inspect the log and explicitly retry";
        }
        this.save(s);
        return { a, recovered: true };
      }
      if (!active(a) || a.session)
        throw new Error("Worker attempt is not ready; inspect before retrying");
      a.worker = { token: randomUUID(), log: resolve(this.repo.stateDir, "logs", `${a.id}.log`) };
      this.save(s);
      return { a, recovered: false };
    });
    const a = prepared.a;
    if (prepared.recovered)
      return { attempt: id, exited: true, recovered: true, exitCode: null, log: a.worker!.log };
    let exitCode: number | null = null;
    let failure: unknown;
    try {
      exitCode = await superviseWorker(
        a,
        this.repo.common,
        this.prompt(change, a),
        (pid) => {
          this.updateAttempt(change, id, (current) => {
            current.worker!.pid = pid;
            current.worker!.processStart = processStart(pid);
          });
        },
        (update) => this.updateAttempt(change, id, update),
      );
    } catch (error) { failure = error; }
    this.updateAttempt(change, id, current => {
      current.worker!.exitedAt = new Date().toISOString();
      current.worker!.exitCode = exitCode;
      if (!current.report) {
        current.phase = "failed";
        current.error = `${getHarness(current.agent ?? "codex").displayName} exited without an accepted final report; inspect the log and explicitly retry`;
      }
    });
    if (failure) throw failure;
    return { attempt: id, exited: true, exitCode, log: a.worker!.log };
  }
  begin(
    change: string,
    task: string,
    id: string,
    requestedSession?: string,
  ) {
    return this.lock(() => {
      const s = this.requireState(change),
        a = this.latest(s, task);
      if (!a || a.id !== id || !active(a) || !a.setupDone)
        throw new Error("Attempt is not ready to begin");
      const session = requestedSession ?? (a.agent === "codex" ? process.env.CODEX_THREAD_ID : undefined);
      if (!session || !/^[a-zA-Z0-9_-]+$/.test(session))
        throw new Error("begin requires a session identity or --session");
      if (this.repo.root !== a.path)
        throw new Error("begin must run inside the assigned task worktree");
      if (a.agent === "claude" && a.expectedSession !== session)
        throw new Error("Claude begin session does not match the reserved session UUID");
      if (a.session && a.session !== session)
        throw new Error("Another harness session already owns this attempt");
      a.session = session;
      a.phase = "running";
      this.save(s);
      return a;
    });
  }
  report(change: string, task: string, id: string, report: Report) {
    return this.lock(() => {
      const s = this.requireState(change),
        a = this.latest(s, task);
      if (
        !a ||
        a.id !== id ||
        !["running", "blocked", "completed", "failed"].includes(a.phase)
      )
        throw new Error("Attempt must register with begin before reporting");
      if (
        this.repo.root !== a.path ||
        report.attempt !== id ||
        report.task !== task ||
        report.session !== a.session
      )
        throw new Error(
          "Report identity does not match the assigned session/worktree",
        );
      if (
        !["completed", "failed", "blocked"].includes(report.outcome) ||
        typeof report.summary !== "string" ||
        !report.summary.trim() ||
        !Array.isArray(report.verification) ||
        !report.verification.length ||
        report.verification.some((x) => typeof x !== "string" || !x.trim())
      )
        throw new Error(
          "Report requires outcome, summary, and verification evidence",
        );
      if (a.report) {
        if (JSON.stringify(a.report) === JSON.stringify(report)) return a;
        throw new Error("Report already recorded; use retry for a new attempt");
      }
      if (report.outcome === "completed") this.verifyResult(a, report, change);
      atomic(resolve(this.repo.stateDir, "reports", `${id}.json`), report);
      a.report = report;
      a.phase = report.outcome;
      this.save(s);
      return a;
    });
  }
  verifyResult(a: TaskAttempt, report: Report, change: string) {
    if (
      !report.commit ||
      report.commit === a.base ||
      !/^[a-f0-9]{40,64}$/.test(report.commit) ||
      git(a.path, "rev-parse", "HEAD") !== report.commit ||
      !clean(a.path)
    )
      throw new Error(
        "Completed report requires a clean task worktree at the reported full commit",
      );
    git(a.path, "merge-base", "--is-ancestor", a.base, report.commit);
    if (git(a.path, "symbolic-ref", "--short", "HEAD") !== a.branch)
      throw new Error("Task worktree changed branches");
    if (
      loadPlan(a.path, change).fingerprint !== a.fingerprint ||
      git(
        a.path,
        "diff",
        "--name-only",
        a.base,
        report.commit,
        "--",
        "openspec",
      )
        .split("\n")
        .some(
          (p) =>
            p === "openspec/runner.yaml" ||
            p === "openspec/config.yaml" ||
            p.startsWith(`openspec/changes/${change}/`),
        )
    )
      throw new Error("Worker changed shared planning artifacts");
  }
  attach(change: string, task: string) {
    const s = this.requireState(change),
      a = this.latest(s, task);
    if (!a) throw new Error("No task attempt");
    if (a.cleaned || a.worker?.exitedAt || a.terminal.closed || a.report) {
      return { attempt: a.id, session: a.session, terminal: a.terminal, branch: a.branch,
        path: existsSync(a.path) ? a.path : undefined, log: a.worker?.log,
        recovery: "Worker finished. Inspect the retained Codex session/log and branch; use retry for further implementation. Do not resume in a removed worktree." };
    }
    if (a.terminal.backend === "orca") {
      return { result: attachTerminal(this.repo.root, a.terminal), attempt: a.id };
    }
    if (a.terminal.pane && process.env.HERDR_ENV === "1") {
      const result = attempt(() => attachTerminal(this.repo.root, a.terminal));
      if (result) return { result, attempt: a.id };
    }
    if (!a.session && a.phase !== "manual")
      throw new Error(
        "Ambiguous startup without a registered session. Inspect saved terminal identifiers; do not create another session automatically.",
      );
    return {
      attempt: a.id,
      terminal: a.terminal,
      command: this.command(change, a),
      recovery: a.session
        ? a.agent === "claude" && !a.identityConfirmed
          ? "No executable Claude resume command is available until the saved stream identity is confirmed; inspect the retained worker/log."
          : `Explicitly run this command to resume the saved ${getHarness(a.agent ?? "codex").displayName} session.`
        : "Run this initial worker command once; the worker must register with begin.",
    };
  }
  integrate(change: string, ids: string[], mode?: "continue" | "abort") {
    const result = this.lock(() => {
      const s = this.requireState(change),
        path = s.integration.path;
      if (mode === "abort") {
        if (!s.transaction) throw new Error("No integration to abort");
        if (git(path, "rev-parse", "HEAD") !== s.transaction.before)
          throw new Error(
            "Integration may already be committed; use --continue to reconcile",
          );
        if (attempt(() => git(path, "rev-parse", "--verify", "MERGE_HEAD")))
          git(path, "merge", "--abort");
        else git(path, "reset", "--hard", s.transaction.before);
        delete s.transaction;
        delete s.cleanupBatch;
        this.save(s);
        return { aborted: true, head: s.head };
      }
      const p = loadPlan(this.repo.root, change);
      this.drift(p, s);
      if (mode === "continue") {
        if (!s.transaction && !s.cleanupBatch) throw new Error("No interrupted integration");
        ids = s.cleanupBatch ?? s.transaction!.tasks;
      } else {
        if (s.transaction)
          throw new Error("Integration pending; use --continue or --abort");
        this.selection(p, ids);
      }
      s.cleanupBatch = [...new Set([...(s.cleanupBatch ?? []), ...ids])];
      this.save(s);
      for (const task of ids) {
        const a = this.latest(s, task);
        if (a?.phase === "integrated") continue;
        if (!a || a.phase !== "completed" || !a.report)
          throw new Error(`Task ${task} needs a completed report`);
        if (a.worker && !a.worker.exitedAt)
          throw new Error(
            `Task ${task} reported but its supervised worker has not exited yet`,
          );
        if (a.worker && a.worker.exitCode !== undefined && a.worker.exitCode !== 0)
          throw new Error(
            `Task ${task} worker exited with code ${a.worker.exitCode}; inspect diagnostics before integrating`,
          );
        if (a.agent === "claude" && (!a.identityConfirmed || !a.terminalEvidence))
          throw new Error(`Task ${task} lacks confirmed Claude stream evidence`);
        const evidence = a.terminalEvidence;
        if (
          a.agent === "claude" &&
          evidence &&
          (evidence.metadata?.is_error === true || evidence.subtype?.startsWith("error"))
        )
          throw new Error(`Task ${task} has a failed Claude terminal result; inspect diagnostics before integrating`);
        if (a.agent === "claude" && !a.worker?.exitedAt)
          throw new Error(`Task ${task} requires a supervised Claude exit receipt before integrating`);
        if (a.fingerprint !== s.fingerprint)
          throw new Error("Task plan is stale; reconcile and retry");
        this.verifyResult(a, a.report, change);
        if (!s.transaction) {
          if (!clean(path) || git(path, "rev-parse", "HEAD") !== s.head)
            throw new Error(
              "Integration worktree must be clean at its recorded head",
            );
          if (loadPlan(path, change).fingerprint !== s.fingerprint)
            throw new Error("Integration planning artifacts drifted");
          s.transaction = {
            tasks: ids,
            current: task,
            before: s.head,
            phase: "merging",
            marker: `openspec-runner:${a.id}`,
          };
          this.save(s);
        }
        const tx = s.transaction;
        if (tx.current !== task)
          throw new Error("Integration transaction task mismatch");
        const head = git(path, "rev-parse", "HEAD");
        if (head !== tx.before) {
          // A commit completed but the coordinator crashed before saving state.
          if (
            !git(path, "log", "-1", "--format=%B").includes(tx.marker) ||
            git(path, "rev-parse", "HEAD^1") !== tx.before ||
            !clean(path)
          )
            throw new Error(
              "Unexpected integration HEAD; inspect before continuing",
            );
          git(path, "merge-base", "--is-ancestor", a.report.commit!, head);
          if (
            !tasksFrom(
              readFileSync(resolve(path, p.relativeDir, "tasks.md"), "utf8"),
            ).find((t) => t.id === task)?.completed
          )
            throw new Error("Interrupted commit did not complete checkbox");
        } else {
          const merging = !!attempt(() =>
            git(path, "rev-parse", "--verify", "MERGE_HEAD"),
          );
          if (tx.phase === "merging" && !merging) {
            if (!clean(path))
              throw new Error("Unexpected worktree edits before merge");
            git(path, "merge", "--no-ff", "--no-commit", a.report.commit!);
          }
          if (git(path, "diff", "--name-only", "--diff-filter=U"))
            throw new Error(
              "Resolve and stage merge conflicts, then integrate --continue; or use --abort",
            );
          if (loadPlan(path, change).fingerprint !== s.fingerprint)
            throw new Error("Merge changed planning artifacts");
          tx.phase = "checking";
          this.save(s);
          for (const command of p.config.verifyIntegration)
            run(command[0], command.slice(1), path);
          if (loadPlan(path, change).fingerprint !== s.fingerprint)
            throw new Error("Integration checks changed planning artifacts");
          const file = resolve(path, p.relativeDir, "tasks.md"),
            text = readFileSync(file, "utf8"),
            tasks = tasksFrom(text),
            lines = text.split("\n");
          const target = tasks.find((t) => t.id === task)!;
          lines[target.line] = lines[target.line].replace(/\[[ xX]\]/, "[x]");
          writeFileSync(file, lines.join("\n"));
          git(path, "add", "--", `${p.relativeDir}/tasks.md`);
          // Checks may inspect the merged index, but must not leave unstaged or untracked output.
          if (
            git(path, "diff", "--name-only") ||
            git(path, "ls-files", "--others", "--exclude-standard")
          )
            throw new Error(
              "Integration checks left files to review; clean/stage them before --continue",
            );
          tx.phase = "committing";
          this.save(s);
          git(
            path,
            "commit",
            "-m",
            `Integrate OpenSpec task ${task}\n\n${tx.marker}`,
          );
        }
        s.head = git(path, "rev-parse", "HEAD");
        a.phase = "integrated";
        delete s.transaction;
        this.save(s);
      }
      return { branch: s.integration.branch, path, head: s.head };
    });
    if (mode === "abort") return result;
    try {
      const state = this.requireState(change), plan = loadPlan(this.repo.root, change);
      if (state.cleanupBatch?.some(id => !this.satisfied(state, id))) return result;
      if (plan.config.cleanup === "manual") {
        this.lock(() => {
          const saved = this.requireState(change);
          delete saved.cleanupBatch;
          this.save(saved);
        });
        return result;
      }
      const complete = plan.tasks.every(t => this.satisfied(state, t.id)) && !state.attempts.some(active);
      const cleanup = this.cleanup(change, complete ? [] : [...new Set(state.attempts.filter(a => a.phase === "integrated").map(a => a.task))], { all: complete });
      this.lock(() => { const s = this.requireState(change); delete s.cleanupBatch; this.save(s); });
      return { ...result, cleanup };
    } catch (error: any) {
      return { ...result, cleanup: { warning: error.message } };
    }
  }
  cleanup(change: string, ids: string[], options: CleanupOptions = {}) {
    return this.lock(() => {
      const s = this.requireState(change);
      if ((options.all && ids.length) || (options.confirm && (!options.attempt || options.dryRun)))
        throw new Error("Use --all or --tasks; confirmation requires --attempt and cannot be a dry-run");
      if (!options.all && (!ids.length || new Set(ids).size !== ids.length))
        throw new Error("Select task IDs explicitly");
      if (s.transaction) throw new Error("Finish or abort pending integration before cleanup");
      if (options.all) {
        let tasks: string[];
        if (s.completion?.head === s.head && s.completion.fingerprint === s.fingerprint) {
          git(this.repo.root, "cat-file", "-e", `${s.head}^{commit}`);
          tasks = s.completion.tasks;
        } else {
          const plan = loadPlan(s.integration.path, change);
          if (plan.fingerprint !== s.fingerprint || git(s.integration.path, "rev-parse", "HEAD") !== s.head || !clean(s.integration.path))
            throw new Error("Integration plan/head differs from recorded state; cannot prove completion");
          tasks = plan.tasks.map(t => t.id);
        }
        if (!tasks.length || !tasks.every(id => this.satisfied(s, id)) || s.attempts.some(active))
          throw new Error("All planned tasks must be satisfied with no active attempts before --all cleanup");
        if (!options.dryRun) s.completion = { tasks, fingerprint: s.fingerprint, head: s.head };
      }
      const selected = options.all ? s.attempts : ids.map((id) => {
        const a = this.latest(s, id);
        if (!a || a.phase !== "integrated")
          throw new Error(`Only integrated tasks can be cleaned: ${id}`);
        return a;
      });
      if (options.attempt && !selected.some(a => a.id === options.attempt)) throw new Error("Selected attempt is not eligible for this cleanup scope");
      const results: CleanupResult[] = [];
      for (const a of selected) {
        if (options.attempt && a.id !== options.attempt) continue;
        let inspected: CleanupResult;
        try {
          inspected = inspectCleanup(this.repo, s, a);
          if (options.confirm && options.confirm !== inspected.token) throw new Error("Cleanup approval is stale; inspect and confirm the current state again");
          if (!options.dryRun && (inspected.status === "eligible" || (inspected.status === "confirmation-required" && options.confirm))) {
            const again = inspectCleanup(this.repo, s, a);
            if (again.token !== inspected.token) throw new Error("Worktree or terminal changed during cleanup; inspect again");
            closeInspectedTerminal(this.repo.root, a, inspected.terminal!, resolve(this.repo.stateDir, "logs", `${a.id}-terminal.json`));
            a.terminal.closed = true;
            this.save(s);
            const after = inspectCleanup(this.repo, s, a);
            if (after.status === "skipped" || after.contentsToken !== inspected.contentsToken)
              throw new Error("Worktree changed while closing terminal; review again");
            removeInspectedWorktree(this.repo.root, a, inspected, !!options.confirm);
            inspected.status = "removed";
          }
          if (!options.dryRun && ["removed", "already-removed"].includes(inspected.status)) a.cleaned = true;
        } catch (error: any) {
          inspected = { attempt: a.id, task: a.task, path: a.path, status: "failed", reasons: [error.message] };
        }
        results.push(inspected);
        if (!options.dryRun) {
          s.cleanupResults = [...(s.cleanupResults ?? []).filter(r => r.attempt !== a.id), inspected];
          this.save(s);
        }
      }
      return { cleaned: results.filter(r => ["removed", "already-removed"].includes(r.status)).map(r => r.task), branchesRetained: true, scope: { all: !!options.all, tasks: ids }, results };
    });
  }
  reconcile(change: string) {
    return this.lock(() => {
      const s = this.requireState(change),
        p = loadPlan(this.repo.root, change);
      if (s.transaction || s.attempts.some(active))
        throw new Error(
          "Finish/report all active attempts and integration before reconciling",
        );
      assertCommitted(this.repo.root, p);
      if (
        !clean(s.integration.path) ||
        git(s.integration.path, "rev-parse", "HEAD") !== s.head
      )
        throw new Error("Integration worktree must be clean at recorded HEAD");
      if (p.fingerprint === s.fingerprint) return { unchanged: true };
      if (
        s.baseline.some((id) => !p.assignments[id]) ||
        s.attempts.some(
          (a) => a.phase === "integrated" && !p.assignments[a.task],
        )
      )
        throw new Error(
          "Cannot remove satisfied task IDs during reconciliation",
        );
      const old = loadPlan(s.integration.path, change);
      git(
        s.integration.path,
        "restore",
        "--source",
        git(this.repo.root, "rev-parse", "HEAD"),
        "--staged",
        "--worktree",
        "--",
        ...new Set([...old.files, ...p.files]),
      );
      const file = resolve(s.integration.path, p.relativeDir, "tasks.md"),
        lines = readFileSync(file, "utf8").split("\n");
      for (const t of tasksFrom(lines.join("\n")))
        lines[t.line] = lines[t.line].replace(
          /\[[ xX]\]/,
          this.satisfied(s, t.id) ? "[x]" : "[ ]",
        );
      writeFileSync(file, lines.join("\n"));
      git(s.integration.path, "add", "--", `${p.relativeDir}/tasks.md`);
      git(
        s.integration.path,
        "commit",
        "-m",
        `Reconcile runner plan for ${change}`,
      );
      for (const a of s.attempts)
        if (a.phase !== "integrated") a.phase = "stale";
      s.fingerprint = p.fingerprint;
      s.planTasks = p.tasks.map(t => t.id);
      delete s.completion;
      delete s.cleanupBatch;
      s.head = git(s.integration.path, "rev-parse", "HEAD");
      this.save(s);
      return {
        fingerprint: s.fingerprint,
        head: s.head,
        invalidated: "All unintegrated attempts; explicitly retry them.",
      };
    });
  }
}
