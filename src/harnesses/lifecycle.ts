import type { TaskAttempt } from "../runner.js";
import type { FeatureJob } from "../feature-state.js";
import { readHookLease } from "./copilot-hooks.js";
import { resolve } from "node:path";

type Attempt = TaskAttempt | FeatureJob;

export function refreshCopilotEvidence(a: Attempt, common: string): void {
  if (a.agent !== "copilot" && a.agent !== "copilot-vscode") return;
  const lease = readHookLease(resolve(common, "openspec-runner"), a.id);
  if (!lease || lease.generation !== a.worker?.token || !lease.session) return;
  if (a.expectedSession && a.expectedSession !== lease.session) throw new Error("Copilot reserved session mismatch");
  a.observedSession = lease.session; a.identityConfirmed = true;
  if (lease.stoppedAt) a.terminalEvidence = { type: "agent-stop", metadata: { is_error: !!lease.error || !lease.reportAccepted } };
}

export function completionProblem(a: Attempt): string | undefined {
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
  if (a.agent === "copilot" && a.worker?.launcher?.pid && !a.worker.launcher.exitedAt) return true;
  if (a.agent === "copilot-vscode" && a.worker)
    return !a.identityConfirmed || a.terminalEvidence?.type !== "agent-stop";
  return !!a.worker && !a.worker.exitedAt;
}
