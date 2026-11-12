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
  const source = `import { collectDashboard } from ${JSON.stringify(new URL("./dashboard-reader.js", import.meta.url).href)}; console.log(JSON.stringify(collectDashboard({cwd: process.argv[1]})));`;
  const result = await dashboardChild(process.execPath, ["--input-type=module", "-e", source, snapshot.repository.root], snapshot.repository.root, signal);
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
  if (trusted.kind === "check" || trusted.kind === "change") {
    if (!trusted.available) throw new Error(trusted.reason ?? "Action unavailable");
    const command = trusted.argv![0] === "summary" ? [...trusted.argv!] : [...trusted.argv!, "--json"];
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
