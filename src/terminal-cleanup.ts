import { atomic } from "./system.js";
import type { TaskAttempt } from "./runner.js";
import { shellProcesses } from "./processes.js";
import { closeOrcaTerminal, inspectOrcaTerminal } from "./orca.js";
import { samePath } from "./platform-paths.js";
import { herdrCall as herdr, herdrProcessInfo, herdrScrollback } from "./herdr.js";

export interface TerminalInspection {
  kind: "none" | "manual" | "herdr" | "orca";
  closed?: boolean;
  blocked?: boolean;
  reason?: string;
  pane?: string;
  identity?: unknown;
  processInfo?: unknown;
}
export function inspectTerminal(root: string, a: TaskAttempt): TerminalInspection {
  if (a.terminal.backend === "orca") return inspectOrcaTerminal(root, a);
  const t = a.terminal;
  if (a.worker && !a.worker.exitedAt)
    return { kind: t.pane ? "herdr" : "manual", blocked: true, reason: "Worker exit is not acknowledged; inspect the saved process/session first" };
  if (!t.pane) {
    if (t.phase) return { kind: "herdr", blocked: true, reason: "Partial terminal creation requires ownership inspection" };
    if (!a.session && !a.worker) return { kind: "none", closed: true };
    return { kind: "manual", reason: "Confirm the worker has exited and all manually opened terminals/processes using this worktree have been closed" };
  }
  try {
    if (!t.sessionContext || t.sessionContext !== (process.env.HERDR_SESSION ?? process.env.HERDR_SOCKET_PATH))
      throw new Error("Saved Herdr session identity is missing or differs; resolve ownership first");
    if (t.pane === process.env.HERDR_PANE_ID) throw new Error("Invoking pane is protected");
    const panes = herdr(root, ["pane", "list"]).panes;
    if (!Array.isArray(panes)) throw new Error("Unsupported Herdr pane list response");
    const pane = panes.find((p: any) => p.pane_id === t.pane);
    if (!pane) return { kind: "herdr", pane: t.pane, closed: true };
    if (!t.terminal || pane.terminal_id !== t.terminal || pane.workspace_id !== t.workspace)
      throw new Error("Pane identity changed; resolve ownership before closing it");
    if (t.closed) throw new Error("A previously closed pane reappeared; inspect its owner");
    const info = herdrProcessInfo(root, t.pane);
    if (!info || info.pane_id !== t.pane || !Number.isInteger(info.shell_pid) || !Array.isArray(info.foreground_processes))
      throw new Error("Unsupported Herdr process information; inspect and close the terminal manually");
    const processes = shellProcesses(info.shell_pid);
    const busy = !processes || processes.length !== 1 || info.foreground_processes.some((p: any) => p.pid !== info.shell_pid);
    const changed = !samePath(pane.foreground_cwd ?? pane.cwd, a.path);
    return { kind: "herdr", pane: t.pane,
      identity: { terminal: pane.terminal_id, workspace: pane.workspace_id, cwd: pane.foreground_cwd ?? pane.cwd },
      processInfo: { ...info, descendants: processes },
      reason: busy || changed || !t.owned || !a.worker?.exitedAt
        ? "Confirm closing this verified pane: activity, location, ownership, or worker exit needs review; closing it may terminate its processes"
        : undefined };
  } catch (error: any) {
    return { kind: "herdr", blocked: true, reason: error.message };
  }
}
export function closeInspectedTerminal(root: string, a: TaskAttempt, inspected: TerminalInspection, log: string) {
  if (inspected.blocked) throw new Error(inspected.reason);
  if (inspected.kind === "orca") return closeOrcaTerminal(root, a, log);
  if (inspected.closed || inspected.kind !== "herdr") return;
  // Save scrollback before the terminal disappears. Codex rollouts remain in Codex storage.
  atomic(log, herdrScrollback(root, inspected.pane!));
  herdr(root, ["pane", "close", inspected.pane!]);
  const after = inspectTerminal(root, { ...a, terminal: { ...a.terminal, closed: false } });
  if (!after.closed) throw new Error("Terminal closure was not acknowledged; worktree retained");
}
