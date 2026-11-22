import type { TaskAttempt } from "../runner.js";
import type { FeatureJob } from "../feature-state.js";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { linuxStopIsGone, finishPreparedLinuxStop, prepareLinuxStop, validLinuxProvenance, validLinuxMembers, validLinuxStop } from "../platform-process.js";
import type { WorkerReceipt } from "./types.js";
import { readHookLease } from "./copilot-hooks.js";
import { resolve } from "node:path";
import { processIsGone, windowsTreeIsGone } from "../platform-process.js";

type Attempt = TaskAttempt | FeatureJob;

export function recoverCopilotLauncher(a: Attempt, proof = {
  platform: process.platform,
  processIsGone,
  treeIsGone: windowsTreeIsGone,
}, common?: string): void {
  if (proof.platform === "linux") {
    const worker = a.worker;
    try { validateLinuxWorker(worker); } catch { return; }
    if (worker?.linuxStop && linuxStopIsGone(worker.linuxStop.receipt) && !!common && linuxBinding(a, common) === worker.linuxStop.binding &&
        worker.exitedAt && worker.exitCode === null) {
      worker.launcher!.exitedAt ??= new Date().toISOString(); worker.launcher!.exitCode = null;
      delete worker.terminationUncertain;
    }
    return;
  }
  const worker = a.worker, launcher = worker?.launcher;
  // A model turn can outlive its launcher. Require its matching root stop as
  // well as both absent process trees; null exits never prove successful work.
  if (a.agent !== "copilot" || proof.platform !== "win32" || worker?.processPlatform !== "win32" ||
      !a.session || !a.identityConfirmed || a.observedSession !== a.session || a.terminalEvidence?.type !== "agent-stop" ||
      !worker.exitedAt || worker.exitCode !== null || !worker.pid || !launcher?.pid ||
      !worker.processStart || !launcher.processStart ||
      !Number.isFinite(Date.parse(worker.processStart)) || !Number.isFinite(Date.parse(launcher.processStart))) return;
  if (!proof.processIsGone(worker.pid) || !proof.processIsGone(launcher.pid) ||
      !proof.treeIsGone(worker.pid, worker.processStart) || !proof.treeIsGone(launcher.pid, launcher.processStart)) return;
  if (!launcher.exitedAt) {
    launcher.exitedAt = new Date().toISOString();
    launcher.exitCode = null;
  }
  delete worker.terminationUncertain;
}

export function refreshCopilotEvidence(a: Attempt, common: string): void {
  if (a.agent !== "copilot" && a.agent !== "copilot-vscode") return;
  const lease = readHookLease(resolve(common, "openspec-runner"), a.id);
  if (!lease || lease.generation !== a.worker?.token || !lease.session) return;
  if (a.expectedSession && a.expectedSession !== lease.session) throw new Error("Copilot reserved session mismatch");
  a.observedSession = lease.session; a.identityConfirmed = true;
  if (lease.stoppedAt) a.terminalEvidence = { type: "agent-stop", metadata: { is_error: !!lease.error || !lease.reportAccepted } };
  recoverCopilotLauncher(a, undefined, common);
}

export function completionProblem(a: Attempt): string | undefined {
  if (a.worker?.terminationUncertain) return "Worker termination is uncertain; retain its resources";
  if (a.worker && !a.worker.exitedAt) return "supervised worker has not exited yet";
  if (a.worker?.exitCode !== undefined && a.worker.exitCode !== 0)
    return `Supervised worker exited with code ${a.worker.exitCode}; successful completion is required before integrating`;
  if (a.agent === "claude") {
    if (!a.identityConfirmed || !a.terminalEvidence)
      return "Worker lacks confirmed Claude stream identity";
    if (a.terminalEvidence.metadata?.is_error === true || a.terminalEvidence.subtype?.startsWith("error"))
      return "Worker has a failed Claude terminal result";
    if (!a.worker?.exitedAt) return "Worker requires a supervised Claude exit receipt";
  }
  if (a.agent === "copilot" || a.agent === "copilot-vscode") {
    if (!a.report || !a.session || !a.identityConfirmed || a.observedSession !== a.session)
      return "Worker lacks an accepted report and confirmed Copilot identity";
    if (a.terminalEvidence?.type !== "agent-stop" || a.terminalEvidence.metadata?.is_error)
      return "Worker lacks successful root stop evidence";
    const receipt = a.worker?.completion;
    if (!a.worker?.exitedAt || a.worker.exitCode !== 0 || receipt?.session !== a.session ||
        receipt.source !== (a.agent === "copilot-vscode" ? "agent-stop" : "process-exit"))
      return "Worker lacks a matching supervised completion source";
  }
  return undefined;
}

export function agentMayBeActive(a: Attempt): boolean {
  if (a.worker?.terminationUncertain) return true;
  if (a.agent === "copilot" && a.worker?.launcher?.pid && !a.worker.launcher.exitedAt) return true;
  if (a.agent === "copilot-vscode" && a.worker)
    return !a.identityConfirmed || a.terminalEvidence?.type !== "agent-stop";
  return !!a.worker && !a.worker.exitedAt;
}

const hashRecovery = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Revalidate disk report + complete terminal lease, not merely flattened hook evidence. */
function linuxBinding(a: Attempt, common: string): string | undefined {
  try {
    const w = a.worker, l = readHookLease(resolve(common, "openspec-runner"), a.id);
    if (a.agent !== "copilot" || w?.processPlatform !== "linux" || !w.pid || !w.processStart || !w.launcher?.pid || !w.launcher.processStart ||
        !validLinuxProvenance(w.linuxIdentity) || !a.session || !a.identityConfirmed || a.observedSession !== a.session ||
        !a.report || a.report.attempt !== a.id || a.report.session !== a.session || a.terminalEvidence?.type !== "agent-stop" || a.terminalEvidence.metadata?.is_error ||
        l?.version !== 1 || l.attempt !== a.id || l.harness !== a.agent || l.generation !== w.token || !l.nonce || l.nonce !== w.linuxNonce || l.session !== a.session ||
        l.worktree !== realpathSync(a.path) || l.status !== "stopped" || !l.stoppedAt || l.error || l.reportAccepted !== true) return undefined;
    const times = [l.armedAt, l.boundAt, l.reportAt, l.stoppedAt].map(value => Date.parse(value ?? ""));
    if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]))) return undefined;
    if ("task" in a.report ? a.report.task !== ("task" in a ? a.task : undefined) : a.report.head !== a.base || a.report.fingerprint !== a.fingerprint) return undefined;
    const disk = JSON.parse(readFileSync(resolve(common, "openspec-runner", "reports", `${a.id}.json`), "utf8"));
    if (hashRecovery(disk) !== hashRecovery(a.report)) return undefined;
    return hashRecovery({ attempt: a.id, task: "task" in a ? a.task : undefined, fingerprint: a.fingerprint, base: a.base, path: realpathSync(a.path),
      token: w.token, session: a.session, provenance: w.linuxIdentity, roots: [[w.pid,w.processStart],[w.launcher.pid,w.launcher.processStart]], report: a.report, lease: l });
  } catch { return undefined; }
}
export function validateLinuxWorker(worker: WorkerReceipt | undefined): void {
  if (!worker) return;
  if ((worker.linuxNonce !== undefined && (typeof worker.linuxNonce !== "string" || !/^[a-f0-9-]{36}$/.test(worker.linuxNonce))) ||
      (worker.linuxIdentity !== undefined && !validLinuxProvenance(worker.linuxIdentity)) ||
      (worker.linuxObserved !== undefined && !validLinuxMembers(worker.linuxObserved)) ||
      (worker.linuxStop !== undefined && (worker.linuxStop.version !== 1 || !/^[a-f0-9]{64}$/.test(worker.linuxStop.binding) || !validLinuxStop(worker.linuxStop.receipt))))
    throw new Error("Invalid Linux worker recovery evidence");
  if (worker.linuxStop) {
    const r = worker.linuxStop.receipt;
    if (worker.processPlatform !== "linux" || hashRecovery(worker.linuxIdentity) !== hashRecovery(r.provenance) ||
        r.roots[0].pid !== worker.pid || r.roots[0].createdAt !== worker.processStart ||
        r.roots[1].pid !== worker.launcher?.pid || r.roots[1].createdAt !== worker.launcher?.processStart ||
        worker.linuxObserved?.some(member => !r.members.some(row => row.pid === member.pid && row.createdAt === member.createdAt)))
      throw new Error("Linux recovery roots do not match worker");
  }
}
/** Explicit cancellation API; caller holds its normal state lock through durable publication. */
export function prepareCopilotStop(a: Attempt, common: string, save: () => void, timeoutMs = 3000): void {
  const binding = linuxBinding(a, common), w = a.worker;
  if (!binding || !w || w.completion || a.phase === "integrated") throw new Error("Copilot cancellation lacks exact session/report/root-stop binding");
  if (w.linuxStop) {
    if (w.linuxStop.binding !== binding) throw new Error("Prepared Linux binding changed");
    // This explicit cancellation API can finish an interrupted frozen receipt.
    // Ordinary reconciliation above only observes absence.
    if (!linuxStopIsGone(w.linuxStop.receipt)) finishPreparedLinuxStop(w.linuxStop.receipt, timeoutMs);
  } else {
    prepareLinuxStop({ provenance: w.linuxIdentity, roots: [{pid:w.pid!,createdAt:w.processStart!}, {pid:w.launcher!.pid!,createdAt:w.launcher!.processStart!}],
      retained: w.linuxObserved ?? [], timeoutMs, publish(receipt) {
        if (linuxBinding(a, common) !== binding) throw new Error("Copilot binding changed during freeze");
        w.linuxStop = {version:1,binding,receipt}; save();
      } });
  }
  w.exitedAt ??= new Date().toISOString(); w.exitCode = null; a.phase = "failed";
  recoverCopilotLauncher(a, undefined, common); save();
}
