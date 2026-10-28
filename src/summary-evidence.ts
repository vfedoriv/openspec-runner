import { createHash } from "node:crypto";
import { Runner } from "./runner.js";
import { readFeature } from "./feature-state.js";
import { git } from "./system.js";
import { tasksFrom } from "./plan.js";
import type { SummaryBundle, SummaryEvidence, SummaryRequest, SummarySubject } from "./summary-types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function summarySubjectKey(subject: SummarySubject): string {
  for (const value of Object.values(subject)) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) || value.includes("..")) throw new Error("Unsafe summary subject");
  return hash(subject);
}
export function summaryDigest(evidence: SummaryEvidence): string {
  return hash({ generatorVersion: 1, evidence: { ...evidence,
    facts: [...evidence.facts].sort((a, b) => a.id.localeCompare(b.id)),
    references: [...evidence.references].sort((a, b) => a.id.localeCompare(b.id)), gaps: [...evidence.gaps].sort() } });
}
export function summaryBundle(evidence: SummaryEvidence): SummaryBundle {
  summarySubjectKey(evidence.subject);
  return { version: 1, generatorVersion: 1, digest: summaryDigest(evidence), collectedAt: new Date().toISOString(), evidence };
}
export function collectLocalSummary(request: Extract<SummaryRequest, { change: string }>, componentHandoff = false): SummaryBundle {
  const runner = new Runner(request.cwd), state = runner.requireState(request.change);
  const feature = readFeature(runner.repo.stateDir, request.change);
  const integrated = state.attempts.filter(a => a.phase === "integrated" && a.report?.outcome === "completed");
  const selected = request.task ? integrated.filter(a => a.task === request.task).slice(-1) : integrated;
  if (request.task && !selected.length) throw new Error("Task has no integrated result");
  if (!request.task) {
    if (feature && feature.phase !== "completed" && !(componentHandoff && feature.delegated)) throw new Error("Managed feature has not completed its lifecycle");
    if (!feature) {
      const tasks = tasksFrom(git(runner.repo.root, "show", `${state.head}:openspec/changes/${request.change}/tasks.md`));
      if (!tasks.length || !tasks.every(t => t.completed && runner.satisfied(state, t.id))) throw new Error("Batch has not completed its lifecycle");
    }
  }
  const subject: SummarySubject = request.task ? { kind: "task", change: request.change, task: request.task } :
    { kind: feature ? "feature" : "change", change: request.change };
  const evidence: SummaryEvidence = { version: 1, subject,
    lifecycle: request.task ? "task-integrated" : feature ? "feature-completed" : "batch-satisfied",
    source: { repository: "implementation", fingerprint: request.task ? selected[0].fingerprint : state.fingerprint, base: state.integration.base,
      result: (!request.task && feature?.archive?.commit) || state.head, ...(!request.task && feature?.archive?.commit ? { archive: feature.archive.commit } : {}) },
    facts: [], references: [], gaps: [] };
  const root = runner.repo.root;
  let history: string[] = [];
  try { history = git(root, "log", "--first-parent", "--format=%H%x00%B%x00", state.head).split("\0"); }
  catch { evidence.gaps.push("Recorded integration history is unavailable."); }
  for (const a of selected) {
    let integration: string | undefined;
    try {
      for (let i = 0; i + 1 < history.length; i += 2) if (history[i + 1].split("\n").includes(`openspec-runner:${a.id}`)) { integration = history[i].trim(); break; }
      if (integration) git(root, "merge-base", "--is-ancestor", a.report!.commit!, integration);
    } catch { integration = undefined; }
    if (!integration) evidence.gaps.push(`Integration commit evidence unavailable for task ${a.task}.`);
    if (request.task) evidence.source.result = integration ?? a.report!.commit!;
    const ref = `attempt:${a.id}`;
    evidence.references.push({ id: ref, repository: "implementation", commit: a.report!.commit });
    evidence.facts.push({ id: `work:${a.id}`, category: "work", authority: "worker-report", text: a.report!.summary, references: [ref] });
    a.report!.verification.forEach((text, i) => evidence.facts.push({ id: `check:${a.id}:${i}`, category: "verification", authority: "worker-report", text, references: [ref] }));
  }
  const result = evidence.source.result;
  let paths: string[] = [];
  try { paths = git(root, "ls-tree", "-r", "--name-only", result).split("\n"); }
  catch { evidence.gaps.push("Recorded result history is unavailable."); }
  const active = `openspec/changes/${request.change}/`;
  const archived = feature?.archive?.path ? `${feature.archive.path}/` : undefined;
  const prefix = archived && paths.some(p => p.startsWith(archived)) ? archived : active;
  const planning = paths.filter(p => p.startsWith(prefix) && /(?:proposal|tasks|spec)\.md$/.test(p));
  for (const path of planning) {
    const id = `plan:${path}`;
    evidence.references.push({ id, repository: "implementation", commit: result, path });
    if (path.endsWith("proposal.md")) evidence.facts.push({ id: "intent", category: "intent", authority: "planning", text: git(root, "show", `${result}:${path}`), references: [id] });
  }
  if (!evidence.facts.some(f => f.category === "intent")) evidence.gaps.push("Original feature intent was not available in committed proposal artifacts.");
  evidence.gaps.push("Worker verification statements are reported claims; full integration check logs are not retained in this bundle.");
  for (const job of request.task ? [] : feature?.jobs ?? []) {
    if (job.phase !== "integrated" && !(job.role === "review" && job.report?.outcome === "completed" && job.id === feature?.finalApproval?.review)) continue;
    const id = `job:${job.id}`;
    evidence.references.push({ id, repository: "implementation", commit: job.report?.commit ?? job.report?.head });
    evidence.facts.push({ id, category: job.role === "repair" ? "repair" : "review", authority: "worker-report", text: job.report!.summary, references: [id] });
    for (const finding of job.report?.findings ?? []) evidence.facts.push({ id: `${id}:${finding.id}`, category: "limitation", authority: "worker-report", text: finding.impact, references: [id] });
  }
  evidence.facts.push({ id: "delivery", category: "delivery", authority: "runner-record", references: [], text:
    request.task ? "Integrated into the runner integration branch; delivery is separate." : feature ?
      "Reviewed and archived on the integration branch; delivery is separate." : "Planned batch satisfied; managed final review and delivery are not implied." });
  return summaryBundle(evidence);
}
