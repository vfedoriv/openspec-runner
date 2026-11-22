import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { probeLinuxSignals, signalLinuxIdentity } from "./linux-signal.js";
import { join } from "node:path";

export interface ProcessIdentity { pid: number; createdAt: string; parentPid?: number; state?: string }
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
        if (!/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+$/.test(fields[19] ?? "")) return undefined;
        rows.push({ pid: Number(name), parentPid: Number(fields[1]), createdAt: fields[19], state: fields[0] });
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

/** Linux identities are start ticks in the recorded PID view, never timestamps. */
export interface LinuxProvenance { version: 1; platform: "linux"; machine: string; boot: string; namespace: string }
export interface LinuxStopReceipt { version: 1; provenance: LinuxProvenance; roots: ProcessIdentity[]; members: ProcessIdentity[] }
export function linuxProvenance(): LinuxProvenance | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const machine = readFileSync("/etc/machine-id", "utf8").trim();
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const namespace = readlinkSync("/proc/self/ns/pid");
    if (readlinkSync("/proc/self") !== String(process.pid)) return undefined;
    const status = readFileSync("/proc/self/status", "utf8").split("\n");
    for (const name of ["Pid", "Tgid", "NSpid", "NStgid"]) {
      const rows = status.filter(line => line.startsWith(`${name}:`));
      if (rows.length !== 1 || new RegExp(`^${name}:[ \t]+${process.pid}[ \t]*$`).test(rows[0]) === false) return undefined;
    }
    if (!/^[a-f0-9]{32}$/.test(machine) || !/^[a-f0-9-]{36}$/.test(boot) || !/^pid:\[\d+\]$/.test(namespace)) return undefined;
    return { version: 1, platform: "linux", machine, boot, namespace };
  } catch { return undefined; }
}
export function validLinuxProvenance(p: any): p is LinuxProvenance {
  return p?.version === 1 && p.platform === "linux" && /^[a-f0-9]{32}$/.test(p.machine) &&
    /^[a-f0-9-]{36}$/.test(p.boot) && /^pid:\[\d+\]$/.test(p.namespace);
}
export function validLinuxMembers(rows: any): rows is ProcessIdentity[] {
  return Array.isArray(rows) && rows.length > 0 && new Set(rows.map(r => r?.pid)).size === rows.length &&
    rows.every(r => validPid(r?.pid) && typeof r.createdAt === "string" && /^\d+$/.test(r.createdAt));
}
export function validLinuxStop(r: any): r is LinuxStopReceipt {
  return r?.version === 1 && validLinuxProvenance(r.provenance) && validLinuxMembers(r.roots) && r.roots.length === 2 &&
    validLinuxMembers(r.members) && r.roots.every((root: ProcessIdentity) => r.members.some((m: ProcessIdentity) => m.pid === root.pid && m.createdAt === root.createdAt));
}
const sameProvenance = (a: unknown, b: unknown) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
/** Reject PID reuse, even when the recorded identity itself has disappeared. */
export function linuxStopIsGone(receipt: LinuxStopReceipt): boolean {
  if (!validLinuxStop(receipt) || !sameProvenance(receipt.provenance, linuxProvenance())) return false;
  const rows = snapshot();
  return !!rows && receipt.members.every(m => {
    const current = rows.find(r => r.pid === m.pid);
    return !current || (current.createdAt === m.createdAt && linuxGroupState(m)?.state === "dead");
  });
}
const pauseLinux = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
/** Independent controller only. Bounded observed ownership; excludes previously unobserved daemonization.
 * Publication happens under the caller's production lock. Once published, never resume the tree.
 */
export function prepareLinuxStop(input: {
  provenance: LinuxProvenance | undefined; roots: ProcessIdentity[]; retained: ProcessIdentity[];
  timeoutMs: number; validate?: () => void; publish: (receipt: LinuxStopReceipt) => void;
}): LinuxStopReceipt {
  if (!validLinuxProvenance(input.provenance) || !sameProvenance(input.provenance, linuxProvenance()) ||
      !validLinuxMembers(input.roots) || input.roots.length !== 2 || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 10000)
    throw new Error("Linux cancellation lacks creation provenance or exact roots");
  const deadline = Date.now() + input.timeoutMs;
  probeLinuxSignals(input.provenance, deadline - Date.now());
  const ledger = new Map<number, ProcessIdentity>();
  for (const row of [...input.roots, ...input.retained]) {
    if (!validLinuxMembers([row]) || (ledger.has(row.pid) && ledger.get(row.pid)!.createdAt !== row.createdAt)) throw new Error("Conflicting Linux member identity");
    ledger.set(row.pid, row);
  }
  const introduced = new Map<number, ProcessIdentity>();
  let published = false;
  try {
    const initial = snapshot();
    if (!initial || input.roots.some(r => !initial.some(c => c.pid === r.pid && c.createdAt === r.createdAt)))
      throw new Error("Linux roots disappeared before preparation");
    retainLinuxDescendants(initial, ledger);
    let previous = "";
    while (Date.now() < deadline) {
      const rows = snapshot();
      if (!rows) throw new Error("Incomplete Linux process observation");
      if (input.roots.some(root => !rows.some(row => row.pid === root.pid && row.createdAt === root.createdAt)))
        throw new Error("Linux roots disappeared before barrier publication");
      for (const member of ledger.values()) {
        if (Date.now() >= deadline) throw new Error("Linux freeze deadline expired");
        const current = rows.find(r => r.pid === member.pid);
        if (current && current.createdAt !== member.createdAt) throw new Error("Linux PID reused");
      }
      retainLinuxDescendants(rows, ledger);
      if (ledger.has(process.pid)) throw new Error("Cancellation controller is inside the owned tree");
      let allStopped = true;
      const groupKeys: string[] = [];
      for (const member of ledger.values()) {
        if (Date.now() >= deadline) throw new Error("Linux freeze deadline expired");
        const current = rows.find(r => r.pid === member.pid);
        if (!current) continue;
        const group = linuxGroupState(member);
        if (!group) throw new Error("Incomplete Linux thread-group observation");
        groupKeys.push(group.key);
        if (group.state === "dead") {
          if (input.roots.some(root => root.pid === member.pid)) throw new Error("Linux root died before barrier publication");
          continue;
        }
        if (group.state === "stopped") continue;
        allStopped = false;
        if (observeProcess(member.pid)?.createdAt !== member.createdAt) throw new Error("Identity changed before freeze");
        signalLinuxIdentity(member, input.provenance, "SIGSTOP", deadline - Date.now());
        introduced.set(member.pid, member);
      }
      const key = JSON.stringify({ members: [...ledger.values()].map(r => [r.pid,r.createdAt]).sort((a,b) => Number(a[0])-Number(b[0])), groups: groupKeys.sort() });
      if (allStopped && key === previous) {
        const receipt: LinuxStopReceipt = { version: 1, provenance: input.provenance, roots: input.roots, members: [...ledger.values()] };
        input.validate?.();
        published = true; input.publish(receipt);
        finishPreparedLinuxStop(receipt, Math.max(100, deadline - Date.now()));
        return receipt;
      }
      previous = allStopped ? key : "";
      pauseLinux();
    }
    throw new Error("Linux freeze deadline expired");
  } finally {
    // A publication exception is ambiguous (write may have succeeded): never resume.
    // Caller marks publication as committed before entering its atomic write callback.
    const rollbackDeadline = Date.now() + input.timeoutMs;
    if (!published) for (const member of introduced.values()) {
      if (Date.now() >= rollbackDeadline) break;
      try { signalLinuxIdentity(member, input.provenance, "SIGCONT", rollbackDeadline - Date.now()); } catch { /* Retain uncertainty. */ }
    }
  }
}

/** Explicit cancellation continuation only: never signal a resumed or reused member. */
export function finishPreparedLinuxStop(receipt: LinuxStopReceipt, timeoutMs = 3000): void {
  if (!validLinuxStop(receipt) || !sameProvenance(receipt.provenance, linuxProvenance()) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    throw new Error("Invalid prepared Linux cancellation");
  const deadline = Date.now() + timeoutMs;
  probeLinuxSignals(receipt.provenance, deadline - Date.now());
  const rows = snapshot();
  if (!rows) throw new Error("Incomplete Linux termination observation; prepared receipt retained");
  for (const member of receipt.members) {
    if (Date.now() >= deadline) throw new Error("Linux termination deadline expired; prepared receipt retained");
    const current = rows.find(row => row.pid === member.pid);
    if (member.pid === process.pid || (current && (current.createdAt !== member.createdAt || !["stopped", "dead"].includes(linuxGroupState(member)?.state ?? ""))))
      throw new Error("Prepared Linux member reused or resumed; cancellation uncertain");
  }
  for (const member of [...receipt.members].reverse()) {
    if (Date.now() >= deadline) throw new Error("Linux termination deadline expired; prepared receipt retained");
    const observation = snapshot(member.pid);
    if (!observation) throw new Error("Incomplete Linux termination observation; prepared receipt retained");
    const current = observation.find(row => row.pid === member.pid);
    if (current && (current.createdAt !== member.createdAt || !["stopped", "dead"].includes(linuxGroupState(member)?.state ?? "")))
      throw new Error("Prepared Linux identity changed or resumed before termination");
    if (current && linuxGroupState(member)?.state !== "dead") signalLinuxIdentity(member, receipt.provenance, "SIGKILL", deadline - Date.now());
  }
  while (Date.now() < deadline) { if (linuxStopIsGone(receipt)) return; pauseLinux(); }
  throw new Error("Linux termination remains uncertain; prepared receipt retained");
}

/** Retain the first census too: a later PPID change must not erase ownership. */
function retainLinuxDescendants(rows: ProcessIdentity[], ledger: Map<number, ProcessIdentity>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = ledger.get(row.parentPid!);
      if (parent && rows.some(current => current.pid === parent.pid && current.createdAt === parent.createdAt) &&
          !ledger.has(row.pid) && BigInt(row.createdAt) >= BigInt(parent.createdAt)) {
        ledger.set(row.pid, row);
        changed = true;
      }
    }
  }
}

/** Leader state alone never establishes group stop or death. Tracing stops reject. */
function linuxGroupState(identity: ProcessIdentity): { state: "running" | "stopped" | "dead"; key: string } | undefined {
  try {
    const path = `/proc/${identity.pid}/task`;
    const names = readdirSync(path).sort();
    if (!names.length || names.some(name => !/^\d+$/.test(name))) return undefined;
    const tasks = names.map(name => {
      const text = readFileSync(`${path}/${name}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (!/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19] ?? "") || fields[0] === "t") throw new Error("Uncertain thread observation");
      return { pid: Number(name), createdAt: fields[19], state: fields[0] };
    });
    if (JSON.stringify(names) !== JSON.stringify(readdirSync(path).sort()) ||
        tasks.find(task => task.pid === identity.pid)?.createdAt !== identity.createdAt ||
        observeProcess(identity.pid)?.createdAt !== identity.createdAt) return undefined;
    const state = tasks.every(task => task.state === "Z") ? "dead"
      : tasks.every(task => task.state === "T" || task.state === "Z") ? "stopped" : "running";
    return { state, key: JSON.stringify(tasks.map(task => [task.pid, task.createdAt])) };
  } catch { return undefined; }
}
