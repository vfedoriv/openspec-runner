import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ProcessIdentity { pid: number; createdAt: string; parentPid?: number }
function validPid(pid: number): boolean { return Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647; }
function snapshot(pid?: number): ProcessIdentity[] | undefined {
  try {
    if (process.platform === "win32") {
      const script = `$ErrorActionPreference='Stop'; $rows=Get-CimInstance Win32_Process${pid ? ` -Filter 'ProcessId = ${pid}'` : ""} | ForEach-Object { if ($_.CreationDate -and $_.ProcessId -gt 0) { @{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; createdAt=$_.CreationDate.ToUniversalTime().ToString('o')} } }; ConvertTo-Json -Compress -InputObject @($rows)`;
      const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      const rows: ProcessIdentity[] = JSON.parse(output.replace(/^\uFEFF/, ""));
      if (!Array.isArray(rows) || rows.some(row => !validPid(row.pid) || typeof row.createdAt !== "string" || !row.createdAt)) return undefined;
      return rows;
    }
    if (process.platform !== "linux") return undefined;
    const rows: ProcessIdentity[] = [];
    for (const name of pid ? [String(pid)] : readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.push({ pid: Number(name), parentPid: Number(fields[1]), createdAt: fields[19] });
      } catch (error: any) { if (!["ENOENT", "ESRCH"].includes(error.code)) return undefined; }
    }
    return rows;
  } catch { return undefined; }
}

export function observeProcess(pid: number): ProcessIdentity | undefined {
  return validPid(pid) ? snapshot(pid)?.find(row => row.pid === pid) : undefined;
}
export function observeDescendants(pid: number, createdAt?: string): ProcessIdentity[] | undefined {
  if (!validPid(pid)) return undefined;
  const rows = snapshot();
  if (!rows) return undefined;
  const root = rows.find(row => row.pid === pid);
  if (root && createdAt && root.createdAt !== createdAt) return undefined;
  if (!root) {
    if (!createdAt) return undefined;
    rows.push({ pid, createdAt });
  }
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (row.parentPid && ids.has(row.parentPid) && !ids.has(row.pid)) {
      const parent = rows.find(p => p.pid === row.parentPid)!;
      const beforeParent = process.platform === "win32" ? Date.parse(row.createdAt) < Date.parse(parent.createdAt) : BigInt(row.createdAt) < BigInt(parent.createdAt);
      if (beforeParent) continue; // An orphan of a previous occupant of this PID.
      ids.add(row.pid); changed = true;
    }
  }
  return rows.filter(row => ids.has(row.pid));
}
/** A vanished Windows root retains parent IDs in its orphaned children. */
export function windowsTreeIsGone(pid: number, createdAt: string): boolean {
  const rows = observeDescendants(pid, createdAt);
  return !!rows && rows.every(row => processIsGone(row.pid));
}
export function processIsGone(pid: number): boolean {
  if (!validPid(pid)) return false;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] === "Z") return true;
    } catch { /* The existence probe below distinguishes absence from denied access. */ }
  }
  try { process.kill(pid, 0); return false; } catch (error: any) { return error.code === "ESRCH"; }
}
export async function stopOwnedProcess(input: { pid: number; createdAt: string; timeoutMs: number }): Promise<{ stopped: boolean; uncertain: boolean }> {
  if (!validPid(input.pid) || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 0) return { stopped: false, uncertain: true };
  if (processIsGone(input.pid)) return { stopped: false, uncertain: true };
  if (observeProcess(input.pid)?.createdAt !== input.createdAt) return { stopped: false, uncertain: true };
  const owned = observeDescendants(input.pid);
  if (!owned || owned.find(row => row.pid === input.pid)?.createdAt !== input.createdAt) return { stopped: false, uncertain: true };
  try {
    if (process.platform === "win32") {
      for (const identity of [...owned].reverse()) {
        if (observeProcess(identity.pid)?.createdAt !== identity.createdAt) continue;
        execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"), ["/PID", String(identity.pid), "/F"], { windowsHide: true, stdio: "ignore", timeout: Math.max(1000, input.timeoutMs) });
      }
    } else {
      for (const identity of [...owned].reverse()) {
        if (observeProcess(identity.pid)?.createdAt === identity.createdAt) process.kill(identity.pid, "SIGTERM");
      }
    }
  } catch { /* Re-observation, never a termination request, determines success. */ }
  const deadline = Date.now() + input.timeoutMs;
  const forceAt = Date.now() + Math.min(1000, input.timeoutMs / 2);
  let forced = process.platform === "win32";
  do {
    if (owned.every(identity => processIsGone(identity.pid))) return { stopped: true, uncertain: false };
    if (!forced && Date.now() >= forceAt) {
      forced = true;
      for (const identity of [...owned].reverse()) {
        if (observeProcess(identity.pid)?.createdAt === identity.createdAt) {
          try { process.kill(identity.pid, "SIGKILL"); } catch { /* Confirm below. */ }
        }
      }
    }
    await new Promise(r => setTimeout(r, 50));
  } while (Date.now() < deadline);
  return { stopped: false, uncertain: true };
}
