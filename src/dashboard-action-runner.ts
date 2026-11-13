import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { actionsFor, focusReason, previewCommand, projectTarget, type DashboardAction, type PreviewInput } from "./dashboard-actions.js";
import type { DashboardSnapshot } from "./dashboard-types.js";
import { shellCommand } from "./system.js";
import { resolveCommand } from "./platform-command.js";
import { observeProcess, stopOwnedProcess } from "./platform-process.js";

const sanitize = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const bounded = (value: unknown) => sanitize(JSON.stringify(value, null, 2).slice(0, 1024 * 1024));

/** Async child boundary: no shell, independent streams, bounded bytes and complete cleanup. */
export function dashboardChild(command: string, argv: string[], cwd: string, signal: AbortSignal, mutation = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Action cancelled")); return; }
    const grouped = process.platform !== "win32";
    const invocation = resolveCommand({ executable: command, args: argv, cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const child = spawn(invocation.executable, invocation.args, { cwd, shell: false, windowsHide: true, detached: grouped, env: invocation.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined, identity: string | undefined;
    let stopping: Promise<void> | undefined;
    child.once("spawn", () => { if (!grouped) identity = observeProcess(child.pid!)?.createdAt; });
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      if (!grouped) {
        stopping ??= (async () => {
          const stopped = child.pid && identity ? await stopOwnedProcess({ pid: child.pid, createdAt: identity, timeoutMs: 3000 }) : { stopped: false, uncertain: true };
          if (stopped.uncertain) {
            failure = new Error(`${reason}; process termination is uncertain`);
            child.stdout.destroy(); child.stderr.destroy();
            cleanup(); reject(failure);
          }
        })();
        return;
      }
      try { if (grouped && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const abort = () => stop("Action cancelled");
    const timer = mutation ? undefined : setTimeout(() => stop("Action timed out after 30 seconds"), 30_000);
    if (!mutation) signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { if (!mutation) stop("Action output exceeded 1 MiB"); }
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", async code => {
      await stopping;
      cleanup();
      const out = sanitize(Buffer.concat(stdout).toString("utf8")), err = sanitize(Buffer.concat(stderr).toString("utf8"));
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Action failed (${code}): ${err || out}`));
      else resolve({ stdout: out, stderr: err + (bytes > 1024 * 1024 ? "\nOutput truncated" : "") });
    });
  });
}

async function currentSnapshot(snapshot: DashboardSnapshot, signal: AbortSignal): Promise<DashboardSnapshot> {
  const source = `import { collectDashboard } from ${JSON.stringify(new URL("./dashboard-reader.js", import.meta.url).href)}; console.log(JSON.stringify(collectDashboard({cwd: process.argv[1], ...JSON.parse(process.argv[2])})));`;
  const result = await dashboardChild(process.execPath, ["--input-type=module", "-e", source, snapshot.repository.root, JSON.stringify(snapshot.storeContext ?? {})], snapshot.repository.root, signal);
  return JSON.parse(result.stdout) as DashboardSnapshot;
}

export async function runDashboardAction(options: {
  snapshot: DashboardSnapshot; action: DashboardAction; input?: PreviewInput; signal: AbortSignal; confirmation?: string;
}): Promise<{ text: string; command?: string[]; confirmation?: string }> {
  const { snapshot, action, input, signal } = options;
  if (signal.aborted) throw new Error("Action cancelled");
  const targets = [{ id: projectTarget }, ...snapshot.features, ...snapshot.tasks, ...snapshot.sessions, ...snapshot.assignments];
  const target = targets.find(t => actionsFor(snapshot, t.id).some(a => a.id === action.id));
  if (!target) throw new Error("Unknown action target");
  const trusted = actionsFor(snapshot, target.id).find(a => a.id === action.id)!;
  if (trusted.kind !== action.kind) throw new Error("Action kind differs from allowlist");
  const suffix = trusted.id.slice(target.id.length + 1);
  if (suffix.startsWith("handoff-")) {
    if (!trusted.available) throw new Error(trusted.reason ?? "Action unavailable");
    const root = snapshot.repository.root;
    const fresh = await currentSnapshot(snapshot, signal);
    const action = actionsFor(fresh, target.id).find(candidate => candidate.id === trusted.id);
    if (!action?.available || !action.argv) throw new Error(action?.reason ?? "Action is no longer eligible");
    const argv = [...action.argv];
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const cli = (args: string[], write = false) =>
      dashboardChild(process.execPath, [entry, ...args, "--json"], root, signal, write);
    const required = (field: keyof PreviewInput) => {
      const value = input?.[field];
      if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))
        throw new Error(`Enter a value for ${field}`);
      return value;
    };
    const flag = (name: string, value: string) => argv.push(`--${name}=${value}`);
    const file = (name: string, field: keyof PreviewInput) => {
      const path = resolve(root, required(field));
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Select a regular input file up to 1 MiB");
      flag(name, path);
      return path;
    };
    const files: string[] = [];
    let outputDirectory: string | undefined;
    if (suffix === "handoff-store-record") {
      flag("kind", required("recordKind")); flag("record", required("recordId"));
    }
    if (suffix === "handoff-receipt-accept") flag("submission", required("recordId"));
    if (suffix === "handoff-receipt-import" || suffix === "handoff-summary-publish" ||
        suffix === "handoff-component-import" && input?.inputFile) files.push(file("file", "inputFile"));
    if (suffix === "handoff-component-export") {
      flag("outcome", required("outcome"));
      if (input?.reason) flag("reason", required("reason"));
      flag("output", resolve(root, required("destination")));
    }
    if (suffix === "handoff-component-retire") flag("reason", required("reason"));
    if (suffix === "handoff-summary-export") flag("export", outputDirectory = resolve(root, required("destination")));
    if (suffix === "handoff-summary-brief") {
      flag("presentation-brief", outputDirectory = resolve(root, required("destination")));
      flag("audience", required("audience"));
      if (input?.providerFile) files.push(file("provider-config", "providerFile"));
      if (input?.assetsFile) files.push(file("assets", "assetsFile"));
    }
    if (action.kind === "check") return { text: (await cli(argv)).stdout, command: argv };
    if (outputDirectory && existsSync(outputDirectory)) throw new Error("Export destination already exists");
    if (fresh.storeContext && argv[0] === "coordination") files.push(fresh.storeContext.map);
    const digests = () => files.map(path => createHash("sha256").update(readFileSync(path)).digest("hex"));
    const hashes = digests();
    const assignment = fresh.assignments.find(row => row.id === target.id);
    const feature = fresh.features.find(row => row.id === (assignment?.featureId ??
      fresh.tasks.find(row => row.id === target.id)?.featureId ?? target.id));
    const saved = options.confirmation === undefined ? undefined : JSON.parse(options.confirmation) as { id?: string; operation?: string; review: string };
    const ids = ["handoff-component-export", "handoff-receipt-accept"].includes(suffix)
      ? { id: saved?.id ?? randomUUID(), operation: saved?.operation ?? randomUUID() } : {};
    let details: unknown;
    if (suffix.startsWith("handoff-summary-")) {
      const base = feature?.summaryCommand;
      if (!base) throw new Error("Summary subject is unavailable");
      const task = fresh.tasks.find(row => row.id === target.id);
      const evidence = JSON.parse((await cli([...base, ...(task ? ["--task", task.task.id] : [])])).stdout);
      if (suffix === "handoff-summary-publish") {
        flag("source", evidence.sourceDigest);
        const narrative = evidence.summary?.paths?.narrative;
        if (narrative) flag("expected-revision", basename(narrative, ".md").replace(/^narrative-/, ""));
      }
      details = evidence;
    } else {
      const head = feature?.coordination?.head;
      if (!head) throw new Error("Store revision unavailable");
      if (suffix === "handoff-component-export")
        await cli(["component", "status", argv[2], ...argv.slice(3, 9), "--revision", head]);
      const preview = JSON.parse((await cli([...argv, "--dry-run"])).stdout);
      if ((preview.historyRevision ?? preview.head ?? head) !== head)
        throw new Error("Store revision changed; refresh and review again");
      if (suffix !== "handoff-component-retire") flag("expected-head", head);
      if (suffix !== "handoff-receipt-import") {
        if (typeof preview.token !== "string") throw new Error("Preview did not supply a confirmation token");
        flag("confirm", preview.token);
      }
      if (ids.id && ids.operation) { flag("id", ids.id); flag("operation", ids.operation); }
      details = { storeRevision: head, assignment, preview };
    }
    if (JSON.stringify(hashes) !== JSON.stringify(digests())) throw new Error("Input file changed during preview");
    const review = JSON.stringify({ action: action.id, root, argv, hashes, details });
    if (!saved) return {
      text: [action.label, root, shellCommand(["openspec-runner", ...argv]), bounded(details)].join("\n"),
      confirmation: JSON.stringify({ ...ids, review }),
    };
    if (saved.review !== review) throw new Error("Inputs or evidence changed; refresh and review again");
    if (suffix === "handoff-receipt-import" || suffix === "handoff-summary-publish") flag("input-digest", hashes[0]);
    try {
      const result = await cli(argv, true);
      return { text: result.stdout + (result.stderr ? `\nDiagnostics:\n${result.stderr}` : ""), command: argv };
    } catch (error) {
      if (outputDirectory && existsSync(outputDirectory))
        throw new Error(`${String(error)}\nOutput directory: ${outputDirectory}\nFiles present: ${readdirSync(outputDirectory).join(", ")}`);
      throw error;
    }
  }
  if (suffix.startsWith("managed-")) {
    if (!trusted.available) throw new Error(trusted.reason ?? "Action unavailable");
    const root = snapshot.repository.root;
    const current = await currentSnapshot(snapshot, signal);
    const selected = actionsFor(current, target.id).find(candidate => candidate.id === trusted.id);
    if (!selected?.available || !selected.argv) throw new Error(selected?.reason ?? "Action is no longer eligible");
    const command = [...selected.argv];
    const [, operation, change] = command;
    const feature = current.features.find(row => row.origin === "local" && row.change === change);
    const job = current.sessions.find(row => row.id === target.id)?.attempt;
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const cli = (args: string[], writes = false) =>
      dashboardChild(process.execPath, [entry, ...args, "--json"], root, signal, writes);
    const identity = async () => {
      const source = `import { Runner } from ${JSON.stringify(new URL("./runner.js", import.meta.url).href)}; console.log(new Runner().actionIdentity(process.argv[1]));`;
      return (await dashboardChild(process.execPath, ["--input-type=module", "-e", source, change], root, signal)).stdout.trim();
    };
    const settingsFile = suffix === "managed-plan" && input?.settingsFile
      ? resolve(root, input.settingsFile) : undefined;
    if (suffix === "managed-plan" && !settingsFile) throw new Error("Select an existing settings JSON file");
    if (settingsFile) command.push("--file", settingsFile);
    const settingsDigest = () => {
      if (!settingsFile) return undefined;
      const stat = statSync(settingsFile);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Select a settings JSON file up to 1 MiB");
      return createHash("sha256").update(readFileSync(settingsFile)).digest("hex");
    };
    const reviewed = { action: trusted.id, root, command, identity: await identity(), settings: settingsDigest() };
    if (options.confirmation !== undefined) {
      const saved = JSON.parse(options.confirmation) as { reviewed: typeof reviewed; token?: string };
      if (JSON.stringify(saved.reviewed) !== JSON.stringify(reviewed))
        throw new Error("Feature state or settings changed; run the check and review again");
      if (operation === "approve") {
        if (!saved.token || !/^[a-f0-9]{64}$/.test(saved.token)) throw new Error("A checked approval token is required");
        command.push("--confirm", saved.token);
      }
      try {
        const output = await cli([...command, "--expected-state", reviewed.identity], true);
        return { text: output.stdout + (output.stderr ? `\nDiagnostics:\n${output.stderr}` : ""), command };
      } catch (error) {
        if (operation === "integrate" && feature?.execution)
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nIntegration worktree: ${feature.execution.path}`);
        throw error;
      }
    }
    let details: unknown = { integration: feature?.execution, phase: feature?.phase, job };
    let token: string | undefined;
    if (["approve", "review", "fix", "archive"].includes(operation)) {
      const checked = await cli([...command, "--dry-run"], operation === "approve" || operation === "archive");
      const result = JSON.parse(checked.stdout);
      if (operation === "archive" && !result.approved && !result.recovery)
        throw new Error("Current final approval is required; run final checks and approve again");
      details = result;
      token = operation === "approve" ? result.token : undefined;
    }
    if (reviewed.identity !== await identity() || reviewed.settings !== settingsDigest())
      throw new Error("Feature state or settings changed during the check; review again");
    const effects = operation === "approve" ? "Confirmation reruns the checks before recording approval." :
      operation === "archive" ? "Archives the change and synchronizes specs. Checks may run again and write to the integration worktree." :
      operation === "recover" ? "Records verified termination evidence without dispatching another job." :
      command.includes("--abort") ? "Discards pending merge and conflict edits in the integration worktree." : undefined;
    return {
      text: [selected.label, root, shellCommand(["openspec-runner", ...command]), effects, bounded(details)].filter(Boolean).join("\n"),
      confirmation: JSON.stringify({ reviewed, token }),
    };
  }
  const localOperations = ["launch-run", "retry-run", "recover-run", "integrate-run", "integrate-continue",
    "integrate-abort", "reconcile-run", "cleanup-attempt", "cleanup-all-scope", "resume"];
  if (localOperations.includes(suffix)) {
    if (!trusted.available) throw new Error(trusted.reason ?? "Action unavailable");
    const root = snapshot.repository.root;
    const current = await currentSnapshot(snapshot, signal);
    const selected = actionsFor(current, target.id).find(candidate => candidate.id === trusted.id);
    if (!selected?.available) throw new Error(selected?.reason ?? "Action is no longer eligible");
    const session = current.sessions.find(row => row.id === target.id);
    const task = current.tasks.find(row => row.id === target.id);
    const feature = current.features.find(row => row.id === (session?.featureId ?? task?.featureId ?? target.id));
    if (!feature?.change || feature.origin !== "local") throw new Error("A local change is required");
    const change = feature.change;
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const cli = (args: string[], mutation = false) => dashboardChild(process.execPath, [entry, ...args, "--json"], root, signal, mutation);
    const runnerModule = JSON.stringify(new URL("./runner.js", import.meta.url).href);
    const runner = (source: string, args: string[]) => dashboardChild(process.execPath,
      ["--input-type=module", "-e", `import { Runner } from ${runnerModule}; const runner = new Runner(); ${source}`, ...args], root, signal);
    if (suffix === "resume") {
      const attempt = session!.attempt;
      if (attempt.cleaned || attempt.worker?.exitedAt || attempt.terminal.closed || attempt.report || session!.worktreeAvailable !== true)
        return { text: "Use the retained session evidence. The saved worker cannot be resumed." };
      if (!attempt.session && attempt.phase !== "manual")
        return { text: "Startup is ambiguous. Inspect the saved terminal or recover preparation from the task row." };
      if (attempt.agent === "copilot-vscode")
        return { text: `Open ${attempt.path} in VS Code and locate the saved chat. Exact chat resume is unavailable.` };
      const output = await runner("console.log(runner.command(process.argv[1], JSON.parse(process.argv[2])) ?? 'No saved resume command is available');", [change, JSON.stringify(attempt)]);
      return { text: output.stdout };
    }
    let command = selected.argv;
    let details: unknown = {
      integration: feature.execution,
      attempt: task?.attempts.at(-1)?.id,
      ...(suffix === "integrate-abort" ? { effect: "Discards pending merge and conflict edits in the integration worktree." } : {}),
      ...(suffix === "reconcile-run" ? { effect: "Adopts committed planning edits and may invalidate previous attempts or approval." } : {}),
    };
    const cleanup = suffix.startsWith("cleanup-");
    const identity = cleanup ? undefined : (await runner("console.log(runner.actionIdentity(process.argv[1]));", [change])).stdout.trim();
    if (suffix === "launch-run" || suffix === "retry-run") {
      const preview = actionsFor(current, target.id).find(a => a.id === trusted.id.replace(/-run$/, "-preview"))!;
      const args = previewCommand(current, preview, input);
      command = args.slice(0, -2);
      const previewResult = JSON.parse((await cli([...command, "--dry-run"])).stdout);
      command.push("--expected-launch", previewResult.executionIdentity);
      details = previewResult;
    } else if (suffix === "integrate-run") {
      const ids = input?.taskIds ?? [];
      const rows = ids.map(id => current.tasks.find(row => row.featureId === feature.id && row.task.id === id));
      if (!ids.length || new Set(ids).size !== ids.length || rows.some(row => !row || row.attempts.at(-1)?.phase !== "completed" || task && row.id !== task.id))
        throw new Error("Select exact tasks with completed attempts");
      command = ["integrate", change, "--tasks", ids.join(",")];
      details = { integration: feature.execution, attempts: rows.map(row => row!.attempts.at(-1)!.id) };
    } else if (cleanup) {
      if (!session || !("task" in session.attempt)) throw new Error("Select an implementation attempt");
      const scope = suffix === "cleanup-all-scope" ? ["--all"] : ["--tasks", session.attempt.task];
      const args = ["cleanup", change, ...scope, "--attempt", session.attempt.id];
      const inspected = JSON.parse((await cli([...args, "--dry-run"])).stdout).results[0];
      if (!inspected?.token || !["eligible", "confirmation-required"].includes(inspected.status))
        return { text: bounded(inspected ?? { status: "No eligible attempt" }) };
      command = [...args, "--confirm", inspected.token];
      details = { ...inspected, effect: "Removes this worktree, including ignored files, and closes its terminal. The branch and reports are retained." };
    }
    if (!command) throw new Error("No executable operation");
    const review = [selected.label, root, shellCommand(["openspec-runner", ...command]), bounded(details), ...(identity ? [`Reviewed state: ${identity}`] : [])].join("\n");
    if (options.confirmation === undefined) return { text: review, confirmation: review };
    if (options.confirmation !== review) throw new Error("Action changed; refresh and review it again");
    try {
      const output = await cli(identity ? [...command, "--expected-state", identity] : command, true);
      return { text: output.stdout + (output.stderr ? `\nDiagnostics:\n${output.stderr}` : ""), command };
    } catch (error) {
      if (command[0] === "integrate" && feature.execution)
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nIntegration worktree: ${feature.execution.path}`);
      throw error;
    }
  }
  if (trusted.kind === "check" || trusted.kind === "change") {
    if (!trusted.available) throw new Error(trusted.reason ?? "Action unavailable");
    const command = suffix === "summary-read" ? [...trusted.argv!] : [...trusted.argv!, "--json"];
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    if (trusted.kind === "change") {
      const setup = command[0] === "init";
      if (setup && command[2].startsWith("copilot") && input?.modelForSetup) {
        if (/[\0\r\n]/.test(input.modelForSetup)) throw new Error("Enter a single model identifier");
        command.push(`--default-model=${input.modelForSetup}`);
      }
      const starter = setup ? undefined : await dashboardChild(process.execPath,
        [entry, ...command, "--dry-run"], snapshot.repository.root, signal);
      const review = [
        trusted.label,
        snapshot.repository.root,
        shellCommand(["openspec-runner", ...command]),
        setup ? "Creates runner.yaml if missing and installs or refreshes project skills." :
          `Creates openspec/changes/${command[1]}/execution.yaml using the current task list and project defaults. Existing files are preserved.`,
        ...(starter ? [JSON.parse(starter.stdout).yaml as string] : []),
      ].join("\n");
      if (options.confirmation === undefined) return { text: review, confirmation: review };
      if (options.confirmation !== review) throw new Error("Action changed; review it again");
      if (!setup) {
        const fresh = await currentSnapshot(snapshot, signal);
        if (!actionsFor(fresh, target.id).some(action => action.id === trusted.id && action.available))
          throw new Error("Change is no longer eligible; refresh and review again");
      }
    }
    const output = await dashboardChild(process.execPath, [entry, ...command], snapshot.repository.root, signal, trusted.kind === "change");
    return { text: output.stdout + (output.stderr ? `\nDiagnostics:\n${output.stderr}` : ""), command };
  }
  if (trusted.kind === "command") return { text: shellCommand(["openspec-runner", ...(trusted.argv ?? [])]), command: trusted.argv };
  if (trusted.kind === "inspect") return { text: bounded(target) };
  if (trusted.kind === "focus") {
    const selected = snapshot.sessions.find(s => s.id === target.id)!;
    const current = (await currentSnapshot(snapshot, signal)).sessions.find(s => s.id === selected.id);
    if (!current || current.role !== selected.role || JSON.stringify({ session: current.attempt.session, terminal: current.attempt.terminal, path: current.attempt.path }) !== JSON.stringify({ session: selected.attempt.session, terminal: selected.attempt.terminal, path: selected.attempt.path })) return { text: "Saved attempt changed or disappeared; refresh and inspect details" };
    const reason = focusReason(current);
    if (reason) return { text: `${reason}\n${bounded(current)}` };
    try {
      const source = `import { attachTerminal } from ${JSON.stringify(new URL("./adapters.js", import.meta.url).href)}; console.log(JSON.stringify(attachTerminal(process.argv[1], JSON.parse(process.argv[2]))));`;
      const result = await dashboardChild(process.execPath, ["--input-type=module", "-e", source, snapshot.repository.root, JSON.stringify(current.attempt.terminal)], snapshot.repository.root, signal);
      return { text: result.stdout + (result.stderr ? `\nDiagnostics:\n${result.stderr}` : "") };
    }
    catch (error) {
      if (signal.aborted || error instanceof Error && /timed out|exceeded 1 MiB/.test(error.message)) throw error;
      return { text: sanitize(error instanceof Error ? error.message : String(error)) };
    }
  }
  if (!trusted.available) throw new Error(trusted.reason ?? "Action unavailable");
  if (trusted.kind === "diff") {
    const session = snapshot.sessions.find(s => s.id === target.id)!;
    const current = (await currentSnapshot(snapshot, signal)).sessions.find(s => s.id === session.id);
    if (!current || current.attempt.path !== session.attempt.path || current.attempt.base !== session.attempt.base) throw new Error("Saved attempt changed; refresh first");
    const output = await dashboardChild("git", ["diff", "--no-ext-diff", "--no-textconv", `${current.attempt.base}...HEAD`, "--"], current.attempt.path, signal);
    return { text: output.stdout + (output.stderr ? `\nDiagnostics:\n${output.stderr}` : "") };
  }
  const command = previewCommand(snapshot, trusted, input);
  const output = await dashboardChild(process.execPath, [fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url)), ...command], snapshot.repository.root, signal);
  return { text: output.stdout + (output.stderr ? `\nDiagnostics:\n${output.stderr}` : ""), command };
}
