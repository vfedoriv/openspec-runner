import { readFileSync, readdirSync } from "node:fs";

// Inspect only process identity/parentage, not unrelated command lines or env.
// A pane's foreground job alone cannot rule out background children.
export function shellProcesses(pid: number) {
  if (process.platform !== "linux") return undefined;
  const entries: { pid: number; parent: number; start: string }[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      entries.push({ pid: Number(name), parent: Number(fields[1]), start: fields[19] });
    } catch (error: any) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) return undefined;
    }
  }
  const shell = entries.find(entry => entry.pid === pid);
  if (!shell) return undefined;
  const ids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of entries) {
      if (ids.has(entry.parent) && !ids.has(entry.pid)) { ids.add(entry.pid); changed = true; }
    }
  }
  return entries.filter(entry => ids.has(entry.pid)).sort((a, b) => a.pid - b.pid);
}

export function processStart(pid: number) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error: any) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return undefined;
    throw error;
  }
}
