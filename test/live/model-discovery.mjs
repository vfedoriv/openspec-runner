import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { observeProcess } from "../../dist/platform-process.js";

const runner = fileURLToPath(new URL("../../bin/openspec-runner.js", import.meta.url));
export function parseArgs(args) {
  const result = { timeoutMs: 25000, interrupt: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--interrupt") { if (result.interrupt) throw Error("Duplicate --interrupt"); result.interrupt = true; continue; }
    const field = { "--agent": "agent", "--cwd": "cwd", "--worker-cwd": "workerCwd", "--timeout-ms": "timeoutMs" }[key];
    if (!field || !args[i + 1] || args[i + 1].startsWith("--")) throw Error(`Invalid argument ${key}`);
    if (seen.has(field)) throw Error(`Duplicate ${key}`);
    seen.add(field);
    result[field] = args[++i];
  }
  if (!["codex", "claude", "copilot"].includes(result.agent) || !result.cwd) throw Error("Require --agent codex|claude|copilot --cwd PATH");
  result.timeoutMs = Number(result.timeoutMs);
  if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 100 || result.timeoutMs > 120000) throw Error("Invalid timeout");
  result.cwd = resolve(result.cwd);
  if (result.workerCwd) result.workerCwd = resolve(result.workerCwd);
  return result;
}
export function sanitize(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/(?:Bearer\s+|(?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, "[REDACTED]").slice(0, 2048);
}
async function processes() {
  if (process.platform !== "linux") return undefined;
  try {
  const rows = await Promise.all((await readdir("/proc")).filter(x => /^\d+$/.test(x)).map(async pid => {
    try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const argv = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return { probe: argv.includes("copilot-model-probe"), copilot: argv.includes("--headless") || argv.includes("--stdio"), pid: Number(pid), ppid: Number(fields[1]), started: fields[19], state: fields[0] }; } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; return undefined; }
  }));
  return rows.filter(Boolean);
  } catch { return undefined; }
}
// Historical PIDs are not ancestry roots unless their current creation identity matches.
export function ownedProcessRows(rows, root, owned) {
  const ids = new Set(rows.filter(row => row.state !== "Z" &&
    (row.pid === root.pid && row.started === root.started || owned.get(row.pid)?.started === row.started)).map(row => row.pid));
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (row.state !== "Z" && ids.has(row.ppid) && !ids.has(row.pid)) {
      const parent = rows.find(parent => parent.pid === row.ppid);
      if (BigInt(row.started) < BigInt(parent.started)) continue;
      ids.add(row.pid); owned.set(row.pid, row); changed = true;
    }
  }
  return rows.filter(row => row.pid !== root.pid && ids.has(row.pid));
}
export function signalOwnedIdentity(identity, signal) {
  if (!identity?.started || identity.pid === process.pid || observeProcess(identity.pid)?.createdAt !== identity.started) return false;
  try { process.kill(identity.pid, signal); return true; } catch { return false; }
}
const delay = ms => new Promise(r => setTimeout(r, ms));
export async function boundedChild(command, args, { cwd, timeoutMs = 25000, interrupt = false, interruptProbe = false } = {}) {
  const start = Date.now();
  const child = spawn(command, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", bytes = 0, overflow = false, error, done = false, code, signal;
  const collect = chunk => { bytes += chunk.length; if (bytes <= 262144) stdout += chunk; else overflow = true; };
  child.stdout.on("data", collect); child.stderr.on("data", chunk => { if (args.length === 1 && args[0] === "--version") collect(chunk); });
  child.on("error", e => { error = e.code ?? "spawn error"; });
  const closed = new Promise(r => child.on("close", (c, s) => { code = c; signal = s; done = true; r(); }));
  const owned = new Map(); const observations = [];
  let interrupted = false, timedOut = false, readiness;
  const rootStarted = observeProcess(child.pid)?.createdAt;
  let processObservationSupported = process.platform === "linux" && !!rootStarted;
  const root = { pid: child.pid, started: rootStarted };
  const kill = (sig, rootOnly = false) => {
    if (!rootOnly) for (const identity of [...owned.values()].reverse()) signalOwnedIdentity(identity, sig);
    if (root.started) signalOwnedIdentity(root, sig);
    else if (!done && child.exitCode === null && child.signalCode === null) { try { child.kill(sig); } catch {} }
  };
  const hardStop = async () => {
    // Stop verified parents before refreshing ancestry: no termination handler may
    // fork between the last observation and terminal per-identity signalling.
    if (process.platform === "linux" && root.started) {
      signalOwnedIdentity(root, "SIGSTOP");
      for (const identity of owned.values()) signalOwnedIdentity(identity, "SIGSTOP");
      const freezeDeadline = Date.now() + 1000;
      let frozen = false, stoppedSnapshot = false;
      do {
        const snapshot = await processes();
        if (!snapshot) { processObservationSupported = false; break; }
        const descendants = ownedProcessRows(snapshot, root, owned);
        const currentRoot = snapshot.find(row => row.pid === root.pid && row.started === root.started && row.state !== "Z");
        const live = [...(currentRoot ? [currentRoot] : []), ...descendants];
        for (const identity of live) signalOwnedIdentity(identity, "SIGSTOP");
        const allStopped = live.every(row => ["T", "t"].includes(row.state));
        // A second scan after observing stopped parents catches a fork that
        // raced the first /proc directory enumeration before SIGSTOP landed.
        if (allStopped && stoppedSnapshot) { frozen = true; break; }
        stoppedSnapshot = allStopped;
        await delay(10);
      } while (Date.now() < freezeDeadline);
      if (!frozen) processObservationSupported = false;
    }
    kill("SIGKILL");
  };
  while (!done) {
    const snapshot = await processes();
    if (!snapshot) processObservationSupported = false;
    const rows = snapshot ?? [];
    const descendants = ownedProcessRows(rows, root, owned);
    if (observations.length < 300) observations.push({ elapsedMs: Date.now() - start, descendants: descendants.map(({ pid, started, probe, copilot }) => ({ pid, started, kind: probe ? "probe" : copilot ? "cli" : "descendant" })) });
    const probe = descendants.find(row => row.probe);
    const ready = interruptProbe ? probe && descendants.some(row => row.ppid === probe.pid) : descendants.length;
    if (interrupt && !interrupted && ready) {
      interrupted = true;
      readiness = { elapsedMs: Date.now() - start, targetPid: child.pid, ...(probe ? { probePid: probe.pid, cliPids: descendants.filter(row => row.ppid === probe.pid).map(row => row.pid) } : {}) };
      kill("SIGINT", interruptProbe);
    }
    if (Date.now() - start >= timeoutMs) { timedOut = true; await hardStop(); break; }
    await Promise.race([closed, delay(20)]);
  }
  if (!done) { await Promise.race([closed, delay(1000)]); if (!done) kill("SIGKILL"); await Promise.race([closed, delay(1000)]); }
  // Wait independently for owned descendants, even after the immediate child exits.
  let remaining = [];
  const deadline = Date.now() + 3500;
  do { const snapshot = await processes(); if (!snapshot) processObservationSupported = false; const rows = snapshot ?? []; remaining = rows.filter(row => owned.get(row.pid)?.started === row.started && row.state !== "Z"); if (!remaining.length) break; await delay(25); } while (Date.now() < deadline);
  const remainingBeforeCleanup = remaining.map(({ pid, started }) => ({ pid, started }));
  if (remaining.length) {
    for (const row of remaining) signalOwnedIdentity(row, "SIGKILL");
  }
  return { stdout, evidence: { pid: child.pid, started: rootStarted, readiness, command: command === process.execPath ? "node" : command, exitCode: code ?? null, signal: signal ?? null,
    stdoutEmpty: stdout.length === 0, error, elapsedMs: Date.now() - start, timedOut, interrupted, readinessObserved: interrupted, overflow, processObservationSupported, ...(!processObservationSupported ? { processObservationReason: "Owned process observation unavailable or root creation identity unobserved" } : {}), observations, remainingBeforeCleanup } };
}
function catalogEvidence(raw, expectedHarness, expectedCwd) {
  try { const value = JSON.parse(raw);
    if (!value || value.harness !== expectedHarness || value.scope !== expectedCwd || !["codex", "claude", "copilot"].includes(value.harness) || !["available", "partial", "unavailable"].includes(value.status) || typeof value.scope !== "string" || !Array.isArray(value.entries) || value.entries.length > 4096 ||
      value.fetchedAt !== undefined && (typeof value.fetchedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.fetchedAt) || !Number.isFinite(Date.parse(value.fetchedAt))) ||
      value.entries.some(row => !row || typeof row.selector !== "string" || !row.selector.trim() || /[\x00-\x1f\x7f]/.test(row.selector) || !["discovered", "configured", "example", "saved"].includes(row.source) || row.effortSupport !== undefined && !["supported", "unsupported", "unknown"].includes(row.effortSupport) || row.efforts !== undefined && (!Array.isArray(row.efforts) || row.efforts.some(effort => typeof effort !== "string" || !/^[a-z][a-z0-9-]*$/.test(effort))))) return undefined;
    return { harness: value.harness, status: value.status, scope: value.scope, fetchedAt: value.fetchedAt,
    entries: (value.entries ?? []).map(row => ({ selector: sanitize(row.selector), source: row.source, effortSupport: row.effortSupport,
      ...(Array.isArray(row.efforts) ? { efforts: row.efforts.map(sanitize) } : {}) })) }; } catch { return undefined; }
}
export async function runDiscovery(options, dependencies = {}) {
  // Validate before creating evidence or spawning any process, including programmatic callers.
  const validated = parseArgs(["--agent", options.agent, "--cwd", options.cwd,
    ...(options.workerCwd ? ["--worker-cwd", options.workerCwd] : []), "--timeout-ms", String(options.timeoutMs ?? 25000), ...(options.interrupt ? ["--interrupt"] : [])]);
  const evidenceDir = await mkdtemp(join(dependencies.evidenceRoot ?? tmpdir(), "model-discovery-"));
  const invoke = dependencies.invoke ?? boundedChild;
  const version = await invoke(validated.agent, ["--version"], { cwd: validated.cwd, timeoutMs: Math.min(validated.timeoutMs, 10000) });
  const scopes = [];
  for (const cwd of [...new Set([validated.cwd, validated.workerCwd].filter(Boolean))]) {
    const result = await invoke(process.execPath, [dependencies.runner ?? runner, "models", "--agent", validated.agent, "--catalog", "--json"], { cwd, timeoutMs: validated.timeoutMs, interrupt: validated.interrupt, interruptProbe: validated.agent === "copilot" });
    const catalog = catalogEvidence(result.stdout, validated.agent, cwd);
    scopes.push({ cwd, ...result.evidence, ...(result.evidence.processObservationSupported !== true ? { status: "BLOCKED", reason: "Owned process observation unavailable or unconfirmed" } : {}), catalog, validCatalog: catalog?.harness === validated.agent && catalog.status === "available" && catalog.scope === cwd && catalog.entries.some(x => x.source === "discovered") });
  }
  const evidence = { evidenceDir, createdAt: new Date().toISOString(), agent: validated.agent, mode: "prompt-free-discovery", interruptionRequested: validated.interrupt, inferenceStarted: false,
    requestedModel: null, observedModel: null, requestedEffort: null, observedEffort: null,
    version: { value: version.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0] ?? "unobserved", ...version.evidence }, scopes };
  await writeFile(join(evidenceDir, "result.json"), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}
export function discoverySucceeded(result) {
  return result.scopes.length > 0 && result.scopes.every(row => row.processObservationSupported === true && row.remainingBeforeCleanup.length === 0 && !row.timedOut && !row.overflow &&
    (result.interruptionRequested ? row.interrupted && row.readinessObserved && row.exitCode === 130 && row.stdoutEmpty === true : row.validCatalog && row.exitCode === 0));
}
export async function main(args = process.argv.slice(2)) {
  const result = await runDiscovery(parseArgs(args));
  console.log(JSON.stringify(result));
  return discoverySucceeded(result) ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(sanitize(error.message)); process.exitCode = 1; });
}
