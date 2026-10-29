import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, dirname, parse, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomic, json, locked } from "./system.js";
import { summaryDigest, summarySubjectKey } from "./summary-evidence.js";
import { renderBasicSummary, renderNarrative } from "./summary-render.js";
import type { SummaryBundle, SummaryHandle, SummaryNarrative, SummarySubject } from "./summary-types.js";
import { portableVerificationEvidence } from "./submission.js";
import { replaceBytes } from "./platform-files.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function safe(path: string): string {
  let current = resolve(path);
  while (current !== parse(current).root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Summary path cannot contain symlinks");
    current = dirname(current);
  }
  return resolve(path);
}
function location(stateDir: string, subject: SummarySubject, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid source digest");
  return safe(resolve(stateDir, "summaries", summarySubjectKey(subject), digest));
}
function textFile(path: string, text: string) {
  safe(path); mkdirSync(dirname(path), { recursive: true });
  replaceBytes(path, Buffer.from(text));
}
export function readSummary(options: { stateDir: string; subject: SummarySubject; sourceDigest: string }): SummaryHandle | undefined {
  const dir = location(options.stateDir, options.subject, options.sourceDigest);
  if (!existsSync(resolve(dir, "status.json"))) return undefined;
  const status = json<SummaryHandle>(safe(resolve(dir, "status.json")));
  const bundle = json<SummaryBundle>(safe(resolve(dir, "evidence.json")));
  if (summaryDigest(bundle.evidence) !== options.sourceDigest || status.sourceDigest !== options.sourceDigest ||
    summarySubjectKey(bundle.evidence.subject) !== summarySubjectKey(options.subject) || status.subjectKey !== summarySubjectKey(options.subject)) throw new Error("Corrupt summary identity");
  if (!status.paths || status.paths.basic !== resolve(dir, "basic.md") || status.paths.evidence !== resolve(dir, "evidence.json") ||
    (status.paths.narrative && (dirname(status.paths.narrative) !== dir || !/^narrative-[a-f0-9]{64}\.md$/.test(basename(status.paths.narrative))))) throw new Error("Corrupt summary paths");
  readFileSync(safe(resolve(dir, "basic.md")), "utf8");
  if (status.paths?.narrative) {
    const text = readFileSync(safe(status.paths.narrative), "utf8");
    if (!status.paths.narrative.endsWith(`${hash(text)}.md`)) throw new Error("Narrative edits conflict with stored revision");
  }
  return status;
}
export function saveSummary(options: { stateDir: string; bundle: SummaryBundle }): SummaryHandle {
  const { bundle } = options;
  if (summaryDigest(bundle.evidence) !== bundle.digest) throw new Error("Invalid summary digest");
  const dir = location(options.stateDir, bundle.evidence.subject, bundle.digest);
  mkdirSync(dir, { recursive: true });
  return locked(dir, () => {
    const existing = readSummary({ ...options, subject: bundle.evidence.subject, sourceDigest: bundle.digest });
    if (existing) return existing;
    atomic(resolve(dir, "evidence.json"), bundle);
    textFile(resolve(dir, "basic.md"), renderBasicSummary(bundle));
    const status: SummaryHandle = { subjectKey: summarySubjectKey(bundle.evidence.subject), sourceDigest: bundle.digest,
      basic: bundle.evidence.gaps.length ? "incomplete" : "ready", narrative: bundle.evidence.subject.kind === "task" ? "not-applicable" : "pending",
      freshness: "current", synopsis: bundle.evidence.facts.find(f => f.category === "work")?.text.slice(0, 500) ?? bundle.evidence.lifecycle,
      paths: { evidence: resolve(dir, "evidence.json"), basic: resolve(dir, "basic.md") } };
    atomic(resolve(dir, "status.json"), status); return status;
  });
}
export function publishNarrative(options: { stateDir: string; bundle: SummaryBundle; narrative: SummaryNarrative; expectedRevision?: string; currentSource?: () => string }): SummaryHandle {
  const { bundle, narrative } = options;
  if (JSON.stringify(narrative).length > 1024 * 1024 || narrative.version !== 1 || narrative.sourceDigest !== bundle.digest) throw new Error("Invalid narrative source or size");
  const names = ["problem", "behavior", "implementation", "verification", "limitations", "delivery"];
  if (!narrative.sections || Object.keys(narrative.sections).some(name => !names.includes(name))) throw new Error("Invalid narrative sections");
  for (const name of names) {
    const claims = narrative.sections?.[name as keyof SummaryNarrative["sections"]];
    if (!Array.isArray(claims)) throw new Error("Narrative sections required");
    for (const c of claims) if (!c || typeof c.text !== "string" || !c.text.trim() || !Array.isArray(c.evidenceIds) || (c.expectedBenefit !== undefined && typeof c.expectedBenefit !== "boolean") ||
      (["implementation", "verification", "delivery"].includes(name) && !c.evidenceIds.length) ||
      c.evidenceIds.some((id: string) => !bundle.evidence.facts.some(f => f.id === id))) throw new Error("Invalid narrative evidence");
  }
  const dir = location(options.stateDir, bundle.evidence.subject, bundle.digest);
  return locked(dir, () => {
    if (!options.currentSource || options.currentSource() !== bundle.digest) throw new Error("Summary source is stale; current authority required");
    const status = readSummary({ ...options, subject: bundle.evidence.subject, sourceDigest: bundle.digest });
    if (!status?.paths) throw new Error("Existing summary required");
    if (status.paths.narrative && !status.paths.narrative.endsWith(`${options.expectedRevision}.md`)) throw new Error("Expected narrative revision required");
    const text = renderNarrative(narrative), path = resolve(dir, `narrative-${hash(text)}.md`);
    textFile(path, text);
    if (options.currentSource() !== bundle.digest) throw new Error("Summary source became stale before selection");
    status.paths.narrative = path; status.narrative = "ready";
    atomic(resolve(dir, "status.json"), status); return status;
  });
}
export function exportSummary(options: { stateDir: string; bundle: SummaryBundle; directory: string }): { directory: string; files: string[] } {
  const dir = safe(options.directory), status = readSummary({ ...options, subject: options.bundle.evidence.subject, sourceDigest: options.bundle.digest });
  if (!status?.paths) throw new Error("Existing summary required");
  if (existsSync(dir)) throw new Error("Export destination exists");
  mkdirSync(dirname(dir), { recursive: true }); mkdirSync(dir);
  const files = ["basic.md", "evidence.json", "provenance.json"];
  const roots = [{ path: options.stateDir, identity: "runner-runtime" }];
  if (basename(dirname(options.stateDir)) === ".git") roots.push({ path: dirname(dirname(options.stateDir)), identity: "implementation" });
  const portable = (text: string) => portableVerificationEvidence({ evidence: { command: [], exitCode: 0, evidence: text }, roots }).evidence;
  textFile(resolve(dir, "basic.md"), portable(readFileSync(status.paths.basic, "utf8")));
  const exportedBundle = JSON.parse(portable(JSON.stringify(options.bundle))) as SummaryBundle;
  exportedBundle.digest = summaryDigest(exportedBundle.evidence);
  atomic(resolve(dir, "evidence.json"), exportedBundle);
  if (status.paths.narrative) { textFile(resolve(dir, "narrative.md"), portable(readFileSync(status.paths.narrative, "utf8"))); files.push("narrative.md"); }
  atomic(resolve(dir, "provenance.json"), { version: 1, sourceDigest: options.bundle.digest, exportedDigest: exportedBundle.digest });
  return { directory: dir, files };
}
