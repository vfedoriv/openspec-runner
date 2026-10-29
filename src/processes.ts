import { observeDescendants, observeProcess } from "./platform-process.js";

export function shellProcesses(pid: number) {
  return observeDescendants(pid)?.map(row => ({ pid: row.pid, parent: row.parentPid ?? 0, start: row.createdAt }));
}
export function processStart(pid: number) { return observeProcess(pid)?.createdAt; }
