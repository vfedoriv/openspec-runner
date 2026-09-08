import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
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
import { codexArgs, resolveSettings, type Settings } from "./codex.js";
import {
  createWorktree,
  startTerminal,
  attachTerminal,
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
  settings: Settings;
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
}
interface Transaction {
  tasks: string[];
  current: string;
  before: string;
  phase: "merging" | "checking" | "committing";
  marker: string;
}
export interface State {
  version: 1;
  change: string;
  fingerprint: string;
  integration: Workspace;
  head: string;
  baseline: string[];
  attempts: TaskAttempt[];
  transaction?: Transaction;
}
const active = (a: TaskAttempt) =>
  ["preparing", "manual", "launching", "running"].includes(a.phase);
export class Runner {
  repo: ReturnType<typeof repository>;
  constructor(cwd = process.cwd()) {
    this.repo = repository(cwd);
  }
  path(change: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change))
      throw new Error("Invalid change name");
    return join(this.repo.stateDir, `${change}.json`);
  }
  read(change: string): State | undefined {
    const p = this.path(change);
    return existsSync(p) ? json<State>(p) : undefined;
  }
  save(s: State) {
    atomic(this.path(s.change), s);
  }
  lock<T>(fn: () => T) {
    return locked(this.repo.stateDir, fn);
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
      drift: !!s && s.fingerprint !== p.fingerprint,
      integration: s?.integration,
      head: s?.head,
      transaction: s?.transaction,
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
  preview(
    change: string,
    ids: string[],
    settings?: Settings,
    base = "HEAD",
    retry = false,
  ) {
    const p = loadPlan(this.repo.root, change);
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
          .map((n) => json<State>(join(this.repo.stateDir, n)))
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
      if (
        !p.assignments[id].dependsOn.every((d) =>
          s ? this.satisfied(s, d) : p.tasks.find((t) => t.id === d)?.completed,
        )
      )
        throw new Error(`Dependencies are not integrated: ${id}`);
    }
    const selected = ids.map((id) => ({
      task: id,
      settings: resolveSettings(p.assignments[id], settings),
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
    if (p.config.terminal === "herdr" && process.env.HERDR_ENV !== "1")
      throw new Error(
        "Herdr launching requires HERDR_ENV=1 inside a Herdr session",
      );
    return {
      change,
      base: head,
      terminal:
        p.config.terminal === "manual" || process.env.HERDR_ENV !== "1"
          ? "manual"
          : "herdr",
      tasks: selected,
    };
  }
  launch(
    change: string,
    ids: string[],
    settings?: Settings,
    base = "HEAD",
    retry = false,
    defaults = new Map<string, string>(),
  ) {
    return this.lock(() => {
      const preview = this.preview(change, ids, settings, base, retry),
        p = loadPlan(this.repo.root, change);
      let s = this.read(change);
      if (!s) {
        const token = randomUUID().slice(0, 8),
          branch = `openspec-runner/${change}/${token}/integration`;
        s = {
          version: 1,
          change,
          fingerprint: p.fingerprint,
          integration: {
            branch,
            path: resolve(
              this.repo.stateDir,
              "worktrees",
              `${change}-${token}-integration`,
            ),
            base: preview.base,
          },
          head: preview.base,
          baseline: p.tasks.filter((t) => t.completed).map((t) => t.id),
          attempts: [],
        };
        this.save(s);
      }
      const state = s;
      // Reconcile an interrupted initial integration-worktree creation before spawning tasks.
      state.integration = createWorktree(
        this.repo.root,
        { ...state.integration, base: state.head },
        "git",
      );
      this.save(state);
      if (
        !clean(state.integration.path) ||
        git(state.integration.path, "rev-parse", "HEAD") !== state.head
      )
        throw new Error("Integration worktree differs from recorded head");
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
          parallel: item.parallel,
          branch,
          path: resolve(this.repo.stateDir, "worktrees", id),
          base: state.head,
          phase: "preparing",
          terminal: {},
        };
      });
      state.attempts.push(...batch);
      this.save(state);
      for (const a of batch) {
        try {
          Object.assign(
            a,
            createWorktree(this.repo.root, a, p.config.worktrees),
          );
          this.save(state);
          for (const command of p.config.setup)
            run(command[0], command.slice(1), a.path);
          a.setupDone = true;
          this.save(state);
          if (preview.terminal === "manual") a.phase = "manual";
          else {
            a.phase = "launching";
            this.save(state);
            startTerminal(
              this.repo.root,
              a.path,
              a.id,
              a.settings,
              this.prompt(change, a),
              a.terminal,
              () => this.save(state),
            );
          }
          this.save(state);
        } catch (e: any) {
          a.error = e.message;
          if (!a.terminal.phase) a.phase = "failed";
          this.save(state);
        }
      }
      return batch.map((a) => ({
        ...a,
        command: this.command(change, a),
        prompt: this.prompt(change, a),
      }));
    });
  }
  recover(change: string, task: string) {
    return this.lock(() => {
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
      Object.assign(a, createWorktree(this.repo.root, a, p.config.worktrees));
      this.save(s);
      if (!a.setupDone) {
        // Explicit recovery may rerun setup; setup commands should be idempotent.
        for (const command of p.config.setup)
          run(command[0], command.slice(1), a.path);
        a.setupDone = true;
        this.save(s);
      }
      if (p.config.terminal === "manual" || process.env.HERDR_ENV !== "1")
        a.phase = "manual";
      else {
        a.phase = "launching";
        this.save(s);
        startTerminal(
          this.repo.root,
          a.path,
          a.id,
          a.settings,
          this.prompt(change, a),
          a.terminal,
          () => this.save(s),
        );
      }
      this.save(s);
      return { ...a, command: this.command(change, a) };
    });
  }
  prompt(change: string, a: TaskAttempt) {
    return `Use $openspec-runner-implement. Implement ONLY task ${a.task}: ${a.description}\nChange: ${change}\nAttempt: ${a.id}\nFirst run: openspec-runner begin ${change} ${a.task} --attempt ${a.id}\nRead the change artifacts. Do not modify planning artifacts, checkboxes, execution.yaml, or runner.yaml. Verify and commit task changes. Then run openspec-runner report ${change} ${a.task} --attempt ${a.id} --file <report.json>. The report JSON must contain attempt, task, session (CODEX_THREAD_ID), outcome (completed/failed/blocked), commit (full HEAD SHA for completed), summary, and verification (nonempty evidence strings). Write report.json outside the worktree. Stop after reporting.`;
  }
  command(change: string, a: TaskAttempt) {
    return shellCommand([
      "codex",
      ...codexArgs(a.settings, a.path, a.session),
      ...(a.session ? [] : [this.prompt(change, a)]),
    ]);
  }
  begin(
    change: string,
    task: string,
    id: string,
    session = process.env.CODEX_THREAD_ID,
  ) {
    return this.lock(() => {
      const s = this.requireState(change),
        a = this.latest(s, task);
      if (!a || a.id !== id || !active(a) || !a.setupDone)
        throw new Error("Attempt is not ready to begin");
      if (!session || !/^[a-zA-Z0-9_-]+$/.test(session))
        throw new Error("begin requires CODEX_THREAD_ID or --session");
      if (this.repo.root !== a.path)
        throw new Error("begin must run inside the assigned task worktree");
      if (a.session && a.session !== session)
        throw new Error("Another Codex session already owns this attempt");
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
        !["running", "blocked", "completed"].includes(a.phase)
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
    if (a.terminal.pane && process.env.HERDR_ENV === "1") {
      const result = attempt(() => attachTerminal(this.repo.root, a.terminal));
      if (result) return { result, attempt: a.id };
    }
    if (!a.session && a.phase !== "manual")
      throw new Error(
        "Ambiguous startup without a registered session. Inspect saved Herdr identifiers; do not create another session automatically.",
      );
    return {
      attempt: a.id,
      terminal: a.terminal,
      command: this.command(change, a),
      recovery: a.session
        ? "Explicitly run this command to resume the saved Codex session."
        : "Run this initial command once; the worker must register with begin.",
    };
  }
  integrate(change: string, ids: string[], mode?: "continue" | "abort") {
    return this.lock(() => {
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
        this.save(s);
        return { aborted: true, head: s.head };
      }
      const p = loadPlan(this.repo.root, change);
      this.drift(p, s);
      if (mode === "continue") {
        if (!s.transaction) throw new Error("No interrupted integration");
        ids = s.transaction.tasks;
      } else {
        if (s.transaction)
          throw new Error("Integration pending; use --continue or --abort");
        this.selection(p, ids);
      }
      for (const task of ids) {
        const a = this.latest(s, task);
        if (a?.phase === "integrated") continue;
        if (!a || a.phase !== "completed" || !a.report)
          throw new Error(`Task ${task} needs a completed report`);
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
  }
  cleanup(change: string, ids: string[]) {
    return this.lock(() => {
      const s = this.requireState(change);
      if (!ids.length || new Set(ids).size !== ids.length)
        throw new Error("Select task IDs explicitly");
      const selected = ids.map((id) => {
        const a = this.latest(s, id);
        if (!a || a.phase !== "integrated")
          throw new Error(`Only integrated tasks can be cleaned: ${id}`);
        return a;
      });
      for (const a of selected) {
        if (!a.cleaned && existsSync(a.path)) {
          this.verifyResult(a, a.report!, change);
          git(this.repo.root, "worktree", "remove", a.path);
        }
        a.cleaned = true;
        this.save(s);
      }
      return { cleaned: ids, branchesRetained: true };
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
