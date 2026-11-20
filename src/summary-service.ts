import { collectLocalSummary, summarySubjectKey } from "./summary-evidence.js";
import { collectComponentSummary, collectSharedSummary } from "./summary-shared.js";
import { readComponentBinding } from "./component-state.js";
import { repository } from "./system.js";
import { readSummary, saveSummary } from "./summary-store.js";
import type { SummaryBundle, SummaryHandle, SummaryRequest } from "./summary-types.js";
import { Runner } from "./runner.js";
import type { ExecutionContext } from "./execution-context.js";

export function resolveSummary(request: SummaryRequest): { stateDir: string; bundle: SummaryBundle } {
  if ("featureId" in request) return { stateDir: repository(request.store).stateDir, bundle: collectSharedSummary(request) };
  const repo = new Runner(request.cwd, undefined, request.execution).repo;
  const delegated = !request.task && readComponentBinding({ stateDir: repo.stateDir, change: request.change });
  return { stateDir: repo.stateDir, bundle: delegated ? collectComponentSummary(request) : collectLocalSummary(request) };
}
export function ensureSummary(request: SummaryRequest): SummaryHandle { return saveSummary(resolveSummary(request)); }
export function safeSummary(request: SummaryRequest): SummaryHandle {
  let selected: ReturnType<typeof resolveSummary> | undefined;
  try { selected = resolveSummary(request); return saveSummary(selected); }
  catch (error: any) { return { subjectKey: selected ? summarySubjectKey(selected.bundle.evidence.subject) : "",
    sourceDigest: selected?.bundle.digest ?? "", basic: "failed", narrative: "pending", freshness: "current",
    synopsis: `Summary unavailable for ${"change" in request ? request.change + (request.task ? ` task ${request.task}` : "") : request.featureId}`, warning: error.message }; }
}
export function readCurrentSummary(request: SummaryRequest): SummaryHandle | undefined {
  try {
    const { stateDir, bundle } = resolveSummary(request);
    return readSummary({ stateDir, subject: bundle.evidence.subject, sourceDigest: bundle.digest });
  } catch { return undefined; }
}
export function safeSharedSummary(root: string, featureId: string, repositories: Record<string, string>): SummaryHandle {
  let bundle: SummaryBundle | undefined;
  try { bundle = collectSharedSummary({ cwd: root, store: root, featureId, repositories }); return saveSummary({ stateDir: repository(root).stateDir, bundle }); }
  catch (error: any) { return { subjectKey: bundle ? summarySubjectKey(bundle.evidence.subject) : "", sourceDigest: bundle?.digest ?? "", basic: "failed", narrative: "pending", freshness: "current", synopsis: `Summary unavailable for ${featureId}`, warning: error.message }; }
}
export function safeComponentSummary(cwd: string, change: string, submissionId: string, execution?: ExecutionContext): SummaryHandle {
  let bundle: SummaryBundle | undefined;
  try { bundle = collectComponentSummary({ cwd, change, submissionId, execution }); return saveSummary({ stateDir: new Runner(cwd, undefined, execution).repo.stateDir, bundle }); }
  catch (error: any) { return { subjectKey: bundle ? summarySubjectKey(bundle.evidence.subject) : "", sourceDigest: bundle?.digest ?? "", basic: "failed", narrative: "pending", freshness: "current", synopsis: `Summary unavailable for ${change}/${submissionId}`, warning: error.message }; }
}
