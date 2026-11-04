import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CoordinationStore, decodeRecord, stableDigest, type CoordinationEvent, type SubmissionRecord } from "./coordination-state.js";
import { coordinationRevision, assertRepositoryIdentity } from "./coordination.js";
import { readMachineMap } from "./repository-map.js";
import { readComponentBinding } from "./component-state.js";
import { git, json, repository } from "./system.js";
import { summaryBundle, collectLocalSummary } from "./summary-evidence.js";
import { Runner } from "./runner.js";
import type { SummaryBundle, SummaryEvidence, SummaryRequest } from "./summary-types.js";

export function collectSharedSummary(request: { cwd: string; featureId: string; store: string; map?: string; repositories?: Record<string, string> }): SummaryBundle {
  if (request.map) readMachineMap(request.map);
  else if (request.repositories) for (const [id, root] of Object.entries(request.repositories)) assertRepositoryIdentity({ root, repository: id });
  else throw new Error("Explicit repository map required");
  const store = new CoordinationStore({ root: request.store, featureId: request.featureId });
  const revision = coordinationRevision({ store }), status = store.status({ revision });
  if (status.phase !== "completed") throw new Error("Shared feature is not completed under current authority");
  const snapshot = store.readSnapshot({ revision });
  const completed = snapshot.records.filter((r): r is Extract<CoordinationEvent, { type: "completed" }> =>
    r.kind === "event" && r.type === "completed").sort((a, b) => b.sequence - a.sequence)[0];
  if (!completed) throw new Error("Completed event unavailable");
  const recordPath = `${store.directory}/events/${completed.id}.json`;
  const introduced = git(store.root, "log", "--first-parent", "--diff-filter=A", "--format=%H", revision, "--", recordPath).split("\n")[0];
  if (!introduced) throw new Error("Completion history unavailable");
  const evidence: SummaryEvidence = { version: 1, subject: { kind: "shared-feature", featureId: request.featureId },
    lifecycle: "shared-completed", source: { repository: "store", result: introduced, storeRevision: revision,
      completionEventId: completed.id, approvalId: status.approvalId, tuple: completed.tuple },
    facts: [], references: [], gaps: ["Local worker runtime and per-task details are not required by portable Store records."] };
  const approval = snapshot.records.find(r => r.kind === "approval" && r.id === status.approvalId);
  if (approval?.kind === "approval") {
    for (const file of approval.contract.files.filter(f => /(?:proposal|spec)\.md$/.test(f.path))) {
      const id = `intent:${file.path}`;
      evidence.references.push({ id, repository: approval.contract.repository, commit: approval.contract.revision, path: file.path, recordId: approval.id });
      evidence.facts.push({ id, category: "intent", authority: "planning", text: file.content, references: [id] });
    }
  }
  if (!evidence.facts.some(f => f.category === "intent")) evidence.gaps.push("No committed proposal or specification content was available in approved context.");
  for (const record of snapshot.records) if (record.kind === "event" &&
    ["archive-prepared", "archive-delivered"].includes(record.type) && "completionEventId" in record && record.completionEventId === completed.id) {
    evidence.references.push({ id: `archive:${record.id}`, repository: "store", commit: revision, recordId: record.id });
  }
  for (const [component, commit] of Object.entries(completed.tuple)) {
    const id = `component:${component}`;
    evidence.references.push({ id, repository: snapshot.manifest.components[component].repository, commit });
    evidence.facts.push({ id, category: "work", authority: "store-record", text: `${component}: recorded delivery at ${commit}`, references: [id] });
  }
  const review = snapshot.records.find(r => r.kind === "event" && r.id === completed.reviewEventId);
  if (review?.kind === "event" && review.type === "reviewed") {
    const id = `review:${review.id}`;
    evidence.references.push({ id, repository: "store", recordId: review.id, commit: introduced });
    evidence.facts.push({ id, category: "review", authority: "store-record", text: review.summary ?? "Reviewed exact merged tuple", references: [id] });
    review.verification.forEach((check, i) => evidence.facts.push({ id: `${id}:${i}`, category: "verification", authority: "store-record", text: `${check.command.join(" ")}: exit ${check.exitCode}; ${check.evidence}`, references: [id] }));
    for (const finding of review.findings) evidence.facts.push({ id: `${id}:finding:${finding.id}`, category: "limitation", authority: "store-record", text: finding.impact, references: [id] });
  }
  evidence.facts.push({ id: "delivery", category: "delivery", authority: "store-record", text: `Reviewed merged tuple completed with consent; archive ${status.archive}.`, references: [] });
  return summaryBundle(evidence);
}

export function collectComponentSummary(options: { cwd: string; change: string; submissionId?: string }): SummaryBundle {
  const repo = repository(options.cwd), binding = readComponentBinding({ stateDir: repo.stateDir, change: options.change });
  if (!binding) throw new Error("Delegated component binding unavailable");
  const directory = resolve(repo.stateDir, "submissions");
  const records = readdirSync(directory).filter(name => name.endsWith(".json")).map(name => {
    const saved = json<{ record: SubmissionRecord; bytes: string }>(resolve(directory, name));
    if (saved.record?.assignmentId !== binding.assignmentId || (options.submissionId && saved.record?.id !== options.submissionId)) return undefined;
    const decoded = decodeRecord({ value: saved.bytes });
    if (decoded.kind !== "submission" || stableDigest({ value: decoded }) !== stableDigest({ value: saved.record })) throw new Error("Submission record identity or bytes mismatch");
    return decoded;
  })
    .filter((r): r is SubmissionRecord => !!r && r.outcome === "completed" && !!r.result);
  const head = new Runner(options.cwd).read(options.change)?.head;
  const candidates = options.submissionId ? records : records.filter(r => !head || r.result!.commit === head);
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (!candidates.length) throw new Error("No completed submission matches current component result");
  const record = candidates[0];
  let local: SummaryEvidence | undefined;
  try { const candidate = collectLocalSummary({ cwd: options.cwd, change: options.change }, true).evidence; if (candidate.source.result === record.result!.commit) local = candidate; } catch { /* Portable receipt evidence remains usable without local history. */ }
  const ref = { id: `receipt:${record.id}`, repository: record.repository, commit: record.result!.commit, recordId: record.id };
  return summaryBundle({ version: 1, subject: { kind: "component", featureId: binding.featureId, change: options.change, assignmentId: binding.assignmentId },
    lifecycle: "component-handoff", source: { repository: record.repository, result: record.result!.commit, base: record.base, fingerprint: record.planFingerprint },
    references: [ref, ...(local?.references ?? [])], gaps: ["Coordinator acceptance, delivery and shared completion are separate.", ...(local?.gaps ?? ["Local task/intent history is unavailable; receipt task identities and review are retained."])], facts: [
      ...(local?.facts.filter(f => f.category !== "delivery") ?? []),
      ...(local?.facts.some(f => f.category === "work") ? [] : record.tasks.map(task => ({ id: `task:${task.id}`, category: "work" as const, authority: "runner-record" as const, text: `Task ${task.id}: ${task.completed ? "completed" : "incomplete"}`, references: [ref.id] }))),
      ...(record.review ? [{ id: "receipt-review", category: "review" as const, authority: "runner-record" as const, text: `Reviewed component result ${record.review.commit}; ${record.review.findings.length} retained findings`, references: [ref.id] }] : []),
      ...(record.review?.findings ?? []).map(finding => ({ id: `receipt-finding:${finding.id}`, category: "limitation" as const, authority: "runner-record" as const, text: finding.impact, references: [ref.id] })),
      { id: "handoff", category: "delivery", authority: "runner-record", text: "Component handoff ready; coordinator acceptance and delivery may be pending.", references: [ref.id] },
      ...record.verification.map((check, i) => ({ id: `check:${i}`, category: "verification" as const, authority: "runner-record" as const,
        text: `${check.command.join(" ")}: exit ${check.exitCode}; ${check.evidence}`, references: [ref.id] })),
    ] });
}
