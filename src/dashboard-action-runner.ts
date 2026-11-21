import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { actionsFor, focusReason, previewCommand, projectTarget, type DashboardAction, type PreviewInput } from "./dashboard-actions.js";
import type { DashboardSnapshot, FeatureSummary } from "./dashboard-types.js";
import { shellCommand } from "./system.js";
import { resolveCommand } from "./platform-command.js";
import { observeProcess, stopOwnedProcess } from "./platform-process.js";
import { desktopClipboardCommand, desktopPathCommand, savedDashboardPath, validateDashboardPath, type DashboardPathKind } from "./dashboard-paths.js";

const sanitize = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const bounded = (value: unknown) => sanitize(JSON.stringify(value, null, 2).slice(0, 1024 * 1024));
const scopeArgs = (scope?: FeatureSummary["executionScope"]) => scope ? ["--store", scope.store, "--feature", scope.feature, "--component", scope.component, "--assignment", scope.assignment] : [];
function runnerPrelude(scope: FeatureSummary["executionScope"], change: string) {
  const imported = `import { Runner } from ${JSON.stringify(new URL("./runner.js", import.meta.url).href)};`;
  if (!scope) return `${imported} const runner = new Runner();`;
  const selection = { storeRoot: scope.store, featureId: scope.feature, componentId: scope.component, assignmentId: scope.assignment, change };
  return `${imported} import { resolveBoundExecutionContext } from ${JSON.stringify(new URL("./execution-context.js", import.meta.url).href)}; const runner = new Runner(process.cwd(), undefined, resolveBoundExecutionContext({implementationRoot: process.cwd(), ...${JSON.stringify(selection)}}));`;
}

export async function readDashboardCatalog(root: string, harness: string, signal: AbortSignal) {
  const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
  const output = await dashboardChild(process.execPath, [entry, "models", "--agent", harness, "--catalog", "--json"], root, signal);
  return JSON.parse(output.stdout) as Awaited<ReturnType<typeof import("./model-catalog.js").modelCatalog>>;
}

export async function copyDashboardSettings(json: string, root: string, signal: AbortSignal) {
  const helper = desktopClipboardCommand(json);
  if (!helper) throw new Error("Clipboard unavailable. Select the settings JSON in the preview.");
  await dashboardChild(helper.command, helper.args, root, signal, false, helper.stdin);
}

/** Async child boundary: no shell, independent streams, bounded bytes and complete cleanup. */
export function dashboardChild(command: string, argv: string[], cwd: string, signal: AbortSignal, mutation = false, stdin?: Buffer, rawStdout = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Action cancelled")); return; }
    const grouped = process.platform !== "win32";
    const invocation = resolveCommand({ executable: command, args: argv, cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const child = spawn(invocation.executable, invocation.args, { cwd, shell: false, windowsHide: true, detached: grouped, env: invocation.env, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    if (stdin && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
    const childStdout = child.stdout!, childStderr = child.stderr!;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: Error | undefined, identity: string | undefined;
    let stopping: Promise<void> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    child.once("spawn", () => { if (!grouped) identity = observeProcess(child.pid!)?.createdAt; });
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      if (!grouped) {
        stopping ??= (async () => {
          const stopped = child.pid && identity ? await stopOwnedProcess({ pid: child.pid, createdAt: identity, timeoutMs: 3000 }) : { stopped: false, uncertain: true };
          if (stopped.uncertain) {
            failure = new Error(`${reason}; process termination is uncertain`);
            childStdout.destroy(); childStderr.destroy();
            cleanup(); reject(failure);
          }
        })();
        return;
      }
      if (forceTimer) return;
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); }
      catch { child.kill("SIGTERM"); }
      forceTimer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 1000);
    };
    const abort = () => stop("Action cancelled");
    const timer = mutation ? undefined : setTimeout(() => stop("Action timed out after 30 seconds"), 30_000);
    if (!mutation) signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(forceTimer); clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { if (!mutation) stop("Action output exceeded 1 MiB"); }
      else chunks.push(chunk);
    };
    childStdout.on("data", collect(stdout)); childStderr.on("data", collect(stderr));
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", async code => {
      await stopping;
      // A failed root can exit while a transport descendant is still alive.
      // Successful helpers may intentionally retain descendants (clipboard owners).
      if (!mutation && (failure || code !== 0) && grouped && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Owned group already gone. */ }
      }
      cleanup();
      // Protocol consumers must validate exact bytes before displaying parsed fields.
      let text: string;
      try {
        const bytes = Buffer.concat(stdout);
        text = rawStdout ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("utf8");
      } catch {
        reject(failure ?? new Error("Action stdout is not valid UTF-8"));
        return;
      }
      const out = rawStdout ? text : sanitize(text), err = sanitize(Buffer.concat(stderr).toString("utf8"));
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Action failed (${code}): ${err || sanitize(out)}`));
      else resolve({ stdout: out, stderr: err + (bytes > 1024 * 1024 ? "\nOutput truncated" : "") });
    });
  });
}

async function currentSnapshot(snapshot: DashboardSnapshot, signal: AbortSignal): Promise<DashboardSnapshot> {
  const source = `import { collectDashboard } from ${JSON.stringify(new URL("./dashboard-reader.js", import.meta.url).href)}; import { resolveBoundExecutionContext } from ${JSON.stringify(new URL("./execution-context.js", import.meta.url).href)}; const {executionSelection, ...options} = JSON.parse(process.argv[2]); if(executionSelection) options.execution=resolveBoundExecutionContext({implementationRoot: process.argv[1],storeRoot:executionSelection.store,featureId:executionSelection.feature,componentId:executionSelection.component,assignmentId:executionSelection.assignment,change:executionSelection.change}); console.log(JSON.stringify(collectDashboard({cwd: process.argv[1], ...options})));`;
  const result = await dashboardChild(process.execPath, ["--input-type=module", "-e", source, snapshot.repository.root, JSON.stringify({ ...snapshot.storeContext, executionSelection: snapshot.executionSelection, change: snapshot.setup?.scopedChange })], snapshot.repository.root, signal);
  return JSON.parse(result.stdout) as DashboardSnapshot;
}

export async function runDashboardAction(options: {
  snapshot: DashboardSnapshot; action: DashboardAction; input?: PreviewInput; signal: AbortSignal; confirmation?: string;
}): Promise<{ text: string; command?: string[]; confirmation?: string; settingsJson?: string }> {
  const { snapshot, action, input, signal } = options;
  if (signal.aborted) throw new Error("Action cancelled");
  const targets = [{ id: projectTarget }, ...snapshot.features, ...snapshot.tasks, ...snapshot.sessions, ...snapshot.assignments];
  const target = targets.find(t => actionsFor(snapshot, t.id).some(a => a.id === action.id));
  if (!target) throw new Error("Unknown action target");
  const trusted = actionsFor(snapshot, target.id).find(a => a.id === action.id)!;
  if (trusted.kind !== action.kind) throw new Error("Action kind differs from allowlist");
  const suffix = trusted.id.slice(target.id.length + 1);
  if (suffix === "edit-models") {
    if (!trusted.available || !trusted.argv) throw new Error(trusted.reason ?? "Assignment editing is unavailable");
    const ids = input?.taskIds ?? [];
    const task = snapshot.tasks.find(row => row.id === target.id);
    if (task && (ids.length !== 1 || ids[0] !== task.task.id))
      throw new Error("Task selection differs from selected target");
    const field = (value?: string) => value === ":inherit" ? null : value;
    const patch = { tasks: ids.map(id => ({ id, model: field(input?.model), effort: field(input?.effort) })) };
    const command = [...trusted.argv, "--json", ...(options.confirmation ? ["--confirm", options.confirmation] : ["--dry-run"])];
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const output = await dashboardChild(process.execPath, [entry, ...command], snapshot.repository.root,
      signal, !!options.confirmation, Buffer.from(JSON.stringify(patch)));
    const result = JSON.parse(output.stdout);
    const { diff, message, ...details } = result;
    return { text: [message, diff && diff.split("\n").map(sanitize).join("\n"), bounded(details)].filter(Boolean).join("\n"), command,
      confirmation: !options.confirmation && result.changes.length ? result.token : undefined };
  }
  if (trusted.kind === "path") {
    const [, operation, type] = suffix.split("-");
    const kind = type as DashboardPathKind;
    const saved = savedDashboardPath(snapshot, target.id, kind);
    if (!saved) throw new Error("No saved path is available");
    const fallback = (message: string) => ({ text: `${message}\n${sanitize(saved.path)}` });
    if (!trusted.available) return fallback(trusted.reason ?? "Path unavailable");
    const fresh = await currentSnapshot(snapshot, signal);
    const current = savedDashboardPath(fresh, target.id, kind);
    if (!current || current.stale ||
        current.identity !== saved.identity)
      return fallback("Saved path changed or is unavailable. Refresh and inspect again.");
    try { validateDashboardPath(current.path, current.root, kind); }
    catch (error) { return fallback(error instanceof Error ? error.message : String(error)); }
    const copy = operation === "copy";
    const helper = desktopPathCommand(current.path, kind, copy);
    if (!helper) return fallback("Desktop helper unavailable. Select the path below.");
    try {
      if (copy) await dashboardChild(helper.command, helper.args, fresh.repository.root, signal, false, helper.stdin);
      else {
        if (signal.aborted) throw new Error("Action cancelled");
        const invocation = resolveCommand({ executable: helper.command, args: helper.args, cwd: fresh.repository.root });
        await new Promise<void>((resolve, reject) => {
          const child = spawn(invocation.executable, invocation.args, {
            cwd: fresh.repository.root, env: invocation.env, detached: true, windowsHide: true, stdio: "ignore", shell: false,
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            const timer = setTimeout(resolve, 400);
            child.once("exit", code => {
              clearTimeout(timer);
              if (code === 0 || helper.command === "explorer.exe" && code === 1) resolve();
              else reject(new Error("Desktop opener failed"));
            });
          });
        });
      }
      return fallback(copy ? "Path copied." : "Open requested.");
    } catch {
      return fallback("Desktop helper could not complete the request. Select the path below.");
    }
  }
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
    const targetFeatureId = current.sessions.find(row => row.id === target.id)?.featureId ?? current.tasks.find(row => row.id === target.id)?.featureId ?? target.id;
    const feature = current.features.find(row => row.id === targetFeatureId);
    const job = current.sessions.find(row => row.id === target.id)?.attempt;
    const entry = fileURLToPath(new URL("../bin/openspec-runner.js", import.meta.url));
    const cli = (args: string[], writes = false) =>
      dashboardChild(process.execPath, [entry, ...args, "--json"], root, signal, writes);
    const identity = async () => {
      const source = `${runnerPrelude(feature?.executionScope, change)} console.log(runner.actionIdentity(process.argv[1]));`;
      return (await dashboardChild(process.execPath, ["--input-type=module", "-e", source, change], root, signal)).stdout.trim();
    };
    const settingsFile = suffix === "managed-plan" && input?.settingsFile
      ? resolve(root, input.settingsFile) : undefined;
    const settingsInput = suffix === "managed-plan-settings" && input?.roleSettings
      ? Buffer.from(JSON.stringify(input.roleSettings)) : undefined;
    if (suffix === "managed-plan-settings" && !settingsInput) throw new Error("Choose the role settings first");
    if (suffix === "managed-plan" && !settingsFile) throw new Error("Select an existing settings JSON file");
    if (settingsFile) command.push("--file", settingsFile);
    if (settingsInput) command.push("--file", "-");
    const settingsDigest = () => {
      if (settingsInput) return createHash("sha256").update(settingsInput).digest("hex");
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
        const args = [...command, "--expected-state", reviewed.identity];
        const output = settingsInput
          ? await dashboardChild(process.execPath, [entry, ...args, "--json"], root, signal, true, settingsInput)
          : await cli(args, true);
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
      const checked = settingsInput
        ? await dashboardChild(process.execPath, [entry, ...command, "--dry-run", "--json"], root, signal, true, settingsInput)
        : await cli([...command, "--dry-run"], operation === "approve" || operation === "archive");
      const result = JSON.parse(checked.stdout);
      if (operation === "archive" && !result.approved && !result.recovery)
        throw new Error("Current final approval is required; run final checks and approve again");
      details = result;
      token = operation === "approve" ? result.token : undefined;
      if (settingsInput) {
        const before = feature?.state?.approval?.tasks;
        const assigned = new Map(current.tasks.filter(row => row.featureId === feature?.id)
          .map(row => [row.task.id, row.assignment]));
        const taskSettings = Object.entries(result.tasks as Record<string, import("./harnesses/types.js").HarnessSettings>)
          .map(([task, settings]) => ({
            task,
            previous: before?.[task] && {
              model: before[task].model, effort: before[task].effort ?? before[task].reasoningEffort,
            },
            model: settings.model,
            effort: settings.effort ?? settings.reasoningEffort ?? "Harness default",
            modelSource: assigned.get(task)?.model && assigned.get(task)?.model !== "session"
              ? "Explicit task model" : "Implementation default model",
            effortSource: assigned.get(task)?.effort ?? assigned.get(task)?.reasoningEffort
              ? "Explicit task effort" : settings.effort ?? settings.reasoningEffort
                ? "Implementation default effort" : "Harness default",
          }));
        details = { taskSettings, ...result };
      }
    }
    if (reviewed.identity !== await identity() || reviewed.settings !== settingsDigest())
      throw new Error("Feature state or settings changed during the check; review again");
    const effects = operation === "approve" ? "Confirmation reruns the checks before recording approval." :
      operation === "archive" ? "Archives the change and synchronizes specs. Checks may run again and write to the integration worktree." :
      operation === "recover" ? "Records verified termination evidence without dispatching another job." :
      command.includes("--abort") ? "Discards pending merge and conflict edits in the integration worktree." : undefined;
    return {
      text: [selected.label, root, shellCommand(["openspec-runner", ...command]), effects,
        bounded(details), settingsInput && "Settings JSON for CLI reuse (save as a file and pass --file)",
        settingsInput && bounded(input?.roleSettings)].filter(Boolean).join("\n"),
      confirmation: JSON.stringify({ reviewed, token }),
      settingsJson: settingsInput?.toString("utf8"),
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
    const cli = (args: string[], mutation = false) => dashboardChild(process.execPath, [entry, ...args, ...(args.includes("--store") ? [] : scopeArgs(feature.executionScope)), "--json"], root, signal, mutation);
    const runner = (source: string, args: string[]) => dashboardChild(process.execPath,
      ["--input-type=module", "-e", `${runnerPrelude(feature.executionScope, change)} ${source}`, ...args], root, signal);
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
    if (!command.includes("--store")) command = [...command, ...scopeArgs(feature.executionScope)];
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
    if (trusted.id === "project:models" || trusted.id.startsWith("project:catalog:")) {
      const catalog = JSON.parse(output.stdout) as Awaited<ReturnType<typeof import("./model-catalog.js").modelCatalog>>;
      const entries = catalog.entries.map(entry => [
        entry.selector,
        entry.label && entry.label !== entry.selector ? entry.label : undefined,
        entry.source === "example" ? "Example selector" : undefined,
        entry.efforts?.length ? `Effort ${entry.efforts.join(", ")}` : undefined,
        entry.effortSupport === "unsupported" ? "Effort unavailable" : undefined,
        entry.defaultEffort ? `Default ${entry.defaultEffort}` : undefined,
      ].filter(Boolean).join(" · "));
      return { text: [catalog.harness, catalog.reason, ...entries].filter(Boolean).join("\n"), command };
    }
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
