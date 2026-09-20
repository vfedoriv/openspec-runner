import { realpathSync } from "node:fs";
import { atomic, quote, repository, run } from "./system.js";
import type { Terminal } from "./adapters.js";
import type { TaskAttempt } from "./runner.js";
import type { TerminalInspection } from "./terminal-cleanup.js";

export interface OrcaContext {
  provider: "stablyai";
  runtimeId: string;
}

export function orcaCall(root: string, args: string[], context?: OrcaContext): any {
  if (context && (context.provider !== "stablyai" || !context.runtimeId))
    throw new Error("Legacy tmux Orca state is unsupported; inspect its original session manually");
  const response = JSON.parse(run("orca", [...args, "--host", "local", "--json"], root, 30000));
  if (response?.ok !== true || !response.result || typeof response.result !== "object" ||
      typeof response._meta?.runtimeId !== "string")
    throw new Error("Unsupported stablyai/orca JSON response; use its registered CLI and a running local runtime");
  if (context && response._meta.runtimeId !== context.runtimeId)
    throw new Error("Saved Orca runtime differs from caller; inspect the original runtime before recovery");
  return response;
}

export function orcaContext(root: string): OrcaContext {
  const response = orcaCall(root, ["status"]);
  const { target, runtime } = response.result;
  if (target?.kind !== "local" || runtime?.reachable !== true || runtime.state !== "ready" ||
      !runtime.runtimeId || runtime.runtimeId !== response._meta.runtimeId)
    throw new Error("Orca requires a ready local stablyai/orca runtime on the same host and filesystem as the runner");
  return { provider: "stablyai", runtimeId: runtime.runtimeId };
}

export function checkOrcaContext(root: string, saved: OrcaContext): void {
  if (saved?.provider !== "stablyai")
    throw new Error("Legacy tmux Orca state is unsupported; inspect its original session manually");
  if (orcaContext(root).runtimeId !== saved.runtimeId)
    throw new Error("Saved Orca runtime differs from caller; inspect the original runtime before recovery");
}

export function orcaWorktree(root: string, path: string, context: OrcaContext): any {
  const value = orcaCall(root, ["worktree", "show", "--worktree", `path:${path}`], context).result.worktree;
  if (!value || typeof value.id !== "string" || value.hostId !== "local" || typeof value.path !== "string" ||
      realpathSync(value.path) !== realpathSync(path) ||
      realpathSync(repository(path).common) !== realpathSync(repository(root).common))
    throw new Error("Orca worktree identity or local filesystem differs from the runner repository");
  return value;
}

export function orcaTerminals(root: string, worktree: string, context: OrcaContext): any[] {
  const value = orcaCall(root, ["terminal", "list", "--worktree", `id:${worktree}`], context).result;
  if (!Array.isArray(value.terminals) || value.truncated !== false ||
      !Array.isArray(value.hostScope?.hostIds) || !value.hostScope.hostIds.includes("local") ||
      !Array.isArray(value.hostScope?.omittedHostIds) || value.hostScope.omittedHostIds.includes("local") ||
      value.terminals.some((t: any) => typeof t.handle !== "string" || t.executionHostId !== "local" || t.worktreeId !== worktree))
    throw new Error("Orca terminal listing does not prove complete local-host coverage; retain the worktree");
  return value.terminals;
}

export function startOrcaTerminal(root: string, path: string, label: string, terminal: Terminal,
  save: () => void, command: string) {
  if (terminal.phase) throw new Error("Launch already attempted; inspect saved Orca identifiers with attach; do not resubmit");
  const context = orcaContext(root);
  const workspace = orcaWorktree(root, path, context);
  terminal.backend = "orca";
  terminal.orca = context;
  terminal.workspace = workspace.id;
  terminal.phase = "creating";
  save();
  const created = orcaCall(root, ["terminal", "create", "--worktree", `id:${workspace.id}`,
    "--title", `osr-${label}`, "--command", `exec sh -c ${quote(command)}`], context).result.terminal;
  if (!created || typeof created.handle !== "string" || !created.handle || created.worktreeId !== workspace.id ||
      created.executionHostId !== "local" || created.hostPlatform !== process.platform ||
      typeof created.ptyId !== "string" || typeof created.incarnationId !== "string" ||
      created.isReattach || created.agentSessionDisposition === "adopted")
    throw new Error("Unsupported Orca terminal creation response; inspect terminal list before recovery");
  terminal.pane = created.handle;
  terminal.terminal = created.ptyId;
  terminal.incarnation = created.incarnationId;
  terminal.owned = true;
  terminal.phase = "submitted";
  save();
}

function terminalInfo(root: string, terminal: Terminal) {
  if (!terminal.orca) throw new Error("Missing saved Orca runtime identity");
  checkOrcaContext(root, terminal.orca);
  if (!terminal.workspace || !terminal.pane || !terminal.terminal || !terminal.incarnation)
    throw new Error("Partial Orca terminal creation requires ownership inspection");
  const terminals = orcaTerminals(root, terminal.workspace, terminal.orca);
  const found = terminals.find(t => t.handle === terminal.pane);
  if (found && (found.ptyId !== terminal.terminal || found.incarnationId !== terminal.incarnation || terminal.closed))
    throw new Error("Orca terminal identity changed; inspect ownership first");
  return { context: terminal.orca, found, terminals };
}

export function attachOrcaTerminal(root: string, terminal: Terminal) {
  const { context, found } = terminalInfo(root, terminal);
  if (!found) throw new Error("Saved Orca terminal is closed; inspect the worker log");
  const focus = orcaCall(root, ["terminal", "switch", "--terminal", terminal.pane!], context).result.focus;
  if (focus?.handle !== terminal.pane || focus.worktreeId !== terminal.workspace)
    throw new Error("Orca did not acknowledge the requested terminal focus");
  return { backend: "orca", pane: terminal.pane, workspace: terminal.workspace };
}

export function inspectOrcaTerminal(root: string, a: TaskAttempt): TerminalInspection {
  try {
    if (a.worker && !a.worker.exitedAt) throw new Error("Worker exit is not acknowledged; inspect the saved process/session first");
    const { context, found, terminals } = terminalInfo(root, a.terminal);
    if (terminals.some(t => t.handle !== a.terminal.pane))
      throw new Error("Other Orca terminals remain in this worktree; inspect and close them before cleanup");
    if (!found) return { kind: "orca", pane: a.terminal.pane, closed: true };
    if (found.handle === process.env.ORCA_TERMINAL_HANDLE) throw new Error("Invoking terminal is protected");
    if (!a.terminal.owned || !a.worker?.exitedAt) throw new Error("Orca terminal ownership or worker exit is not confirmed");
    if (realpathSync(found.worktreePath) !== realpathSync(a.path)) throw new Error("Orca terminal worktree changed");
    const read = orcaCall(root, ["terminal", "read", "--terminal", found.handle, "--limit", "1"], context).result.terminal;
    if (read?.handle !== found.handle || read.status !== "exited")
      throw new Error("Orca terminal is still live or its exit is unknown; inspect before cleanup");
    return { kind: "orca", pane: found.handle, identity: { pty: found.ptyId, incarnation: found.incarnationId, context } };
  } catch (error: any) {
    return { kind: "orca", blocked: true, reason: error.message };
  }
}

export function closeOrcaTerminal(root: string, a: TaskAttempt, log: string) {
  const inspected = inspectOrcaTerminal(root, a);
  if (inspected.blocked) throw new Error(inspected.reason);
  if (inspected.closed) return;
  const context = a.terminal.orca!;
  atomic(log, orcaCall(root, ["terminal", "read", "--terminal", a.terminal.pane!, "--limit", "2000"], context).result);
  const close = orcaCall(root, ["terminal", "close", "--terminal", a.terminal.pane!], context).result.close;
  if (close?.handle !== a.terminal.pane || typeof close.ptyKilled !== "boolean" || close.ptyStopVerdict)
    throw new Error("Orca terminal closure was not confirmed; worktree retained");
  if (!inspectOrcaTerminal(root, a).closed) throw new Error("Orca terminal closure was not acknowledged; worktree retained");
}
