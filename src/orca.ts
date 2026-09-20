import { atomic, quote, run, shellCommand } from "./system.js";
import type { Terminal } from "./adapters.js";
import type { TaskAttempt } from "./runner.js";
import type { TerminalInspection } from "./terminal-cleanup.js";

export interface OrcaContext {
  socket: string;
  server: string;
  session: string;
  created: string;
}

function tmux(root: string, socket: string, args: string[]) {
  return run("tmux", ["-S", socket, ...args], root, 10000);
}

export function orcaContext(root: string): OrcaContext {
  const match = process.env.TMUX?.match(/^(.+),\d+,\d+$/);
  if (process.env.ORCA !== "1" || !process.env.ORCA_SESSION || !match)
    throw new Error("Orca launching requires an existing fmfsaisai/orca session (ORCA=1, ORCA_SESSION, and TMUX)");
  const socket = match[1];
  const fields = tmux(root, socket, ["list-sessions", "-F",
    "#{pid}|#{session_id}|#{session_created}|#{session_name}"]).split("\n")
    .map(row => row.split("|"))
    .find(row => row.slice(3).join("|") === process.env.ORCA_SESSION);
  if (!fields || !/^\d+$/.test(fields[0]) || !/^\$\d+$/.test(fields[1]) || !/^\d+$/.test(fields[2]))
    throw new Error("Unsupported Orca tmux session response");
  return { socket, server: fields[0], session: fields[1], created: fields[2] };
}

function savedContext(root: string, terminal: Terminal): OrcaContext {
  const current = orcaContext(root), saved = terminal.orca;
  if (!saved || Object.keys(current).some(key => current[key as keyof OrcaContext] !== saved[key as keyof OrcaContext]))
    throw new Error("Saved Orca session differs from caller; reconnect to the original session first");
  return saved;
}

export function startOrcaTerminal(root: string, path: string, label: string, terminal: Terminal,
  save: () => void, command: string) {
  if (terminal.phase) throw new Error("Launch already attempted; inspect saved Orca identifiers with attach; do not resubmit");
  const context = orcaContext(root);
  terminal.backend = "orca";
  terminal.orca = context;
  terminal.phase = "creating";
  save();
  // Set retention from inside the new pane before running even a fast worker.
  // Disable Orca's interactive agent hooks: the runner owns worker supervision.
  const launch = `${shellCommand(["tmux", "-S", context.socket, "set-option", "-p", "-t"])} "$TMUX_PANE" remain-on-exit on && exec env ORCA=0 sh -c ${quote(command)}`;
  const fields = tmux(root, context.socket, ["new-window", "-d", "-P", "-F",
    "#{session_id}|#{window_id}|#{pane_id}", "-t", `${context.session}:`,
    "-n", `osr-${label}`, "-c", path, "sh", "-c", launch]).split("|");
  if (fields.length !== 3 || fields[0] !== context.session || !/^@\d+$/.test(fields[1]) || !/^%\d+$/.test(fields[2]))
    throw new Error("Unsupported Orca window creation response; inspect the session before recovery");
  terminal.workspace = fields[0];
  terminal.terminal = fields[1];
  terminal.pane = fields[2];
  terminal.owned = true;
  terminal.phase = "submitted";
  save();
}

function paneInfo(root: string, terminal: Terminal) {
  const context = savedContext(root, terminal);
  if (!terminal.pane || !terminal.terminal || terminal.workspace !== context.session)
    throw new Error("Partial Orca terminal creation requires ownership inspection");
  const rows = tmux(root, context.socket, ["list-panes", "-s", "-t", context.session, "-F",
    "#{pane_id}|#{window_id}|#{pane_dead}"]).split("\n").filter(Boolean).map(row => row.split("|"));
  if (rows.some(row => row.length !== 3 || !/^%\d+$/.test(row[0]) || !/^@\d+$/.test(row[1]) || !/^[01]$/.test(row[2])))
    throw new Error("Unsupported Orca pane list response");
  const pane = rows.find(row => row[0] === terminal.pane);
  if (pane && (pane[1] !== terminal.terminal || terminal.closed))
    throw new Error("Orca pane identity changed; inspect ownership first");
  return { context, pane };
}

export function attachOrcaTerminal(root: string, terminal: Terminal) {
  const { context, pane } = paneInfo(root, terminal);
  if (!pane) throw new Error("Saved Orca pane is closed; inspect the worker log");
  tmux(root, context.socket, ["select-window", "-t", terminal.terminal!]);
  tmux(root, context.socket, ["select-pane", "-t", terminal.pane!]);
  return { backend: "orca", pane: terminal.pane, window: terminal.terminal };
}

export function inspectOrcaTerminal(root: string, a: TaskAttempt): TerminalInspection {
  try {
    if (a.worker && !a.worker.exitedAt) throw new Error("Worker exit is not acknowledged; inspect the saved process/session first");
    const { pane } = paneInfo(root, a.terminal);
    if (!pane) return { kind: "orca", pane: a.terminal.pane, closed: true };
    if (a.terminal.pane === process.env.TMUX_PANE) throw new Error("Invoking pane is protected");
    if (!a.terminal.owned) throw new Error("Orca pane ownership is not confirmed");
    // Live panes may have been respawned or repurposed. Never kill their processes.
    if (pane[2] !== "1" || !a.worker?.exitedAt)
      throw new Error("Orca pane is still live or worker exit is unconfirmed; inspect and close it manually");
    return { kind: "orca", pane: pane[0], identity: { window: pane[1], context: a.terminal.orca } };
  } catch (error: any) {
    return { kind: "orca", blocked: true, reason: error.message };
  }
}

export function closeOrcaTerminal(root: string, a: TaskAttempt, log: string) {
  const inspected = inspectOrcaTerminal(root, a);
  if (inspected.blocked) throw new Error(inspected.reason);
  if (inspected.closed) return;
  const context = savedContext(root, a.terminal);
  atomic(log, tmux(root, context.socket, ["capture-pane", "-p", "-t", a.terminal.pane!, "-S", "-2000"]));
  tmux(root, context.socket, ["kill-pane", "-t", a.terminal.pane!]);
  if (!inspectOrcaTerminal(root, a).closed) throw new Error("Orca pane closure was not acknowledged; worktree retained");
}
