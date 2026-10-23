import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CoordinationStore, decodeRecord, stableDigest, validateId, type CommitTuple, type CoordinationEvent, type ReviewFinding, type VerificationCommand, type VerificationEvidence } from "./coordination-state.js";
import type { MutationIdentity } from "./coordination.js";
import { exactCheckout, removeExactCheckout, verificationCommand } from "./submission.js";
import { atomic, clean, git, json, locked, repository } from "./system.js";

export type ReviewStage = "combined" | "final";
export interface TupleReviewPreview {
  head: string;
  token: string;
  stage: ReviewStage;
  tuple: CommitTuple;
  approvalId: string;
  contractFingerprint: string;
  components: Record<string, { repository: string; change: string; assignmentId: string; owner: string; setup: string[][] }>;
  verification: VerificationCommand[];
}
export interface TupleReviewAttestation {
  tuple: CommitTuple;
  token: string;
  reviewedBy: string;
  summary: string;
  findings: ReviewFinding[];
}
export interface TupleReviewMutation extends MutationIdentity {
  stage: ReviewStage;
  token: string;
  review: TupleReviewAttestation;
}
const digest = (value: unknown) => stableDigest({ value });
type Reviewed = Extract<CoordinationEvent, { type: "reviewed" }>;
interface Journal {
  input: TupleReviewMutation;
  preview: TupleReviewPreview;
  createdAt: string;
  expectedHead: string;
  stage: "reserved" | "checking" | "verified" | "failed";
  checkIndex: number;
  running?: number;
  evidence: VerificationEvidence[];
  findings: ReviewFinding[];
  reason?: string;
  pendingEvent?: CoordinationEvent;
}

/** Execute tuple checks locally; only portable evidence and attestation enter the Store. */
export function recordTupleReview(options: {
  store: CoordinationStore;
  input: TupleReviewMutation;
  roots: Record<string, string>;
  preview: () => TupleReviewPreview;
}) {
  const { store, input } = options;
  validateId({ value: input.id }); validateId({ value: input.operationId });
  const runtime = repository(store.root).stateDir, journalPath = resolve(runtime, "review", `${input.operationId}.json`);
  return locked(runtime, () => {
    let journal = existsSync(journalPath) ? json<Journal>(journalPath) : undefined;
    if (journal && digest(journal.input) !== digest(input)) throw new Error("Immutable review operation identity differs");
    const snapshot = store.readSnapshot();
    if (git(store.root, "branch", "--show-current") !== snapshot.manifest.coordinationBranch) throw new Error("Review mutation requires declared coordination branch");
    if (!journal) {
      if (snapshot.head !== input.expectedHead || !clean(store.root)) throw new Error("Review requires expected head and clean Store checkout");
      if (snapshot.records.some(record => record.kind === "event" && record.id === input.id)) throw new Error("Review identity already exists without coordinator journal");
      const preview = options.preview();
      if (input.token !== preview.token || input.review.token !== preview.token || digest(input.review.tuple) !== digest(preview.tuple)) throw new Error("Review token or attested tuple is stale; preview again");
      const sample: Reviewed = { version: 1, kind: "event", featureId: store.featureId, id: input.id, operationId: input.operationId,
        sequence: 1, createdAt: input.createdAt ?? new Date().toISOString(), type: "reviewed", stage: input.stage, tuple: preview.tuple,
        approvalId: preview.approvalId, snapshotToken: preview.token, reviewedBy: input.review.reviewedBy, summary: input.review.summary,
        findings: input.review.findings, verification: [] };
      decodeRecord({ value: sample });
      for (const finding of input.review.findings) if (finding.componentId && !preview.components[finding.componentId]) throw new Error("Review finding references unknown component");
      journal = { input: structuredClone(input), preview, createdAt: sample.createdAt, expectedHead: input.expectedHead,
        stage: "reserved", checkIndex: 0, evidence: [], findings: structuredClone(input.review.findings) };
      atomic(journalPath, journal);
    }
    const save = () => atomic(journalPath, journal);
    if (journal.pendingEvent) {
      const recovered = store.writeRecord({ record: journal.pendingEvent, expectedHead: journal.expectedHead });
      journal.expectedHead = recovered.head; delete journal.pendingEvent; save();
    }
    if (store.readSnapshot().head !== journal.expectedHead) throw new Error("Coordination head changed since review intent; reconcile history");
    const event = (id: string, operationId: string, payload: object) => ({ version: 1, kind: "event", featureId: store.featureId,
      id, operationId, createdAt: journal!.createdAt, sequence: Math.max(0, ...store.readSnapshot().records.filter((record): record is CoordinationEvent => record.kind === "event").map(record => record.sequence)) + 1, ...payload }) as CoordinationEvent;
    const write = (record: CoordinationEvent) => {
      const existing = store.readRecord({ kind: "event", id: record.id });
      if (existing && digest({ ...existing, sequence: 0 }) !== digest({ ...record, sequence: 0 })) throw new Error("Immutable review event identity differs");
      if (existing) return { path: `${store.directory}/events/${record.id}.json`, created: false, head: journal!.expectedHead, operationId: record.operationId };
      journal!.pendingEvent = record; save();
      const result = store.writeRecord({ record, expectedHead: journal!.expectedHead });
      journal!.expectedHead = result.head; delete journal!.pendingEvent; save(); return result;
    };
    write(event(`${input.id}-started`, `${input.operationId}-started`, { type: "operation-started", targetOperationId: input.operationId, action: `${input.stage}-review`, snapshotToken: input.token }));
    const paths = Object.fromEntries(Object.keys(journal.preview.tuple).sort().map(id => [id, resolve(runtime, "review-checkouts", input.operationId, id)]));
    const commands = [
      ...Object.entries(journal.preview.components).flatMap(([componentId, component]) => component.setup.map(command => ({ componentId, command, setup: true }))),
      ...journal.preview.verification.map(command => ({ ...command, setup: false })),
    ];
    const sanitize = (value: string) => Object.entries(paths).reduce((text, [id, path]) => text.replaceAll(path, `component:${id}`), value);
    const tupleClean = () => Object.entries(paths).every(([id, path]) => clean(path) && git(path, "rev-parse", "HEAD") === journal!.preview.tuple[id]);
    const recorded = store.readRecord({ kind: "event", id: input.id });
    if (journal.running !== undefined) throw new Error("Interrupted tuple review check has ambiguous side effects; inspect exact checkouts and reconcile with a new operation");
    if (!recorded) {
      if (journal.stage !== "failed" && options.preview().token !== journal.preview.token) throw new Error("Tuple review inputs drifted since durable intent");
      if (!["verified", "failed"].includes(journal.stage)) {
        for (const [id, path] of Object.entries(paths)) exactCheckout({ root: options.roots[id], commit: journal.preview.tuple[id], path });
        journal.stage = "checking"; save();
        for (let index = journal.checkIndex; index < commands.length; index++) {
          const command = commands[index];
          if (!tupleClean()) throw new Error("Every tuple checkout must be clean at its exact commit before checks");
          journal.running = index; save();
          const evidence = verificationCommand({ root: paths[command.componentId], commit: journal.preview.tuple[command.componentId], command: command.command,
            env: { OPENSPEC_RUNNER_CHECKOUTS: JSON.stringify(paths) } });
          if (!tupleClean()) { evidence.exitCode ||= 1; evidence.evidence += "\nVerification changed a tuple checkout"; }
          evidence.evidence = sanitize(evidence.evidence);
          if (!command.setup || evidence.exitCode !== 0) journal.evidence.push(evidence);
          journal.checkIndex = index + 1; delete journal.running;
          if (evidence.exitCode !== 0) {
            journal.stage = "failed"; journal.reason = `Required ${input.stage} command failed for ${command.componentId}`;
            let findingId = `check-${index + 1}`; while (journal.findings.some(finding => finding.id === findingId)) findingId += "-failed";
            journal.findings.push({ id: findingId, category: "verification", componentId: command.componentId,
              owner: journal.preview.components[command.componentId].owner, location: `${command.componentId}: ${command.command.join(" ")}`,
              impact: journal.reason, correction: "Inspect the check evidence, correct the affected component, then verify and review the exact tuple with a new operation" });
            save(); break;
          }
          save();
        }
        if (journal.stage !== "failed") { journal.stage = "verified"; save(); }
      }
      if (options.preview().token !== journal.preview.token) throw new Error("Tuple review inputs drifted during checks");
      if (journal.stage === "verified") for (const [id, path] of Object.entries(paths)) removeExactCheckout({ root: options.roots[id], path });
    }
    if (journal.stage === "verified" && (journal.checkIndex !== commands.length || journal.evidence.some(check => check.exitCode !== 0 || !check.evidence?.trim()) || digest(journal.evidence.map(check => check.command)) !== digest(journal.preview.verification.map(check => check.command)))) throw new Error("Tuple coordinator verification evidence is incomplete or failed");
    if (!["verified", "failed"].includes(journal.stage)) throw new Error("Recorded review lacks completed coordinator check journal");
    const result = write(event(input.id, input.operationId, { type: "reviewed", stage: input.stage, tuple: journal.preview.tuple,
      approvalId: journal.preview.approvalId, snapshotToken: journal.preview.token, reviewedBy: input.review.reviewedBy, summary: input.review.summary,
      verification: journal.evidence, findings: journal.findings }));
    const finished = write(event(`${input.id}-finished`, `${input.operationId}-finished`, { type: "operation-finished", targetOperationId: input.operationId, action: `${input.stage}-review`, snapshotToken: input.token }));
    if (journal.stage === "failed") throw new Error(journal.reason ?? "Tuple review checks failed; inspect findings and use a new reviewed operation");
    return { ...result, head: finished.head };
  });
}
