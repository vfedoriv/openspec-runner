export type SummarySubject =
  | { kind: "task"; change: string; task: string }
  | { kind: "change" | "feature"; change: string }
  | { kind: "component"; featureId: string; change: string; assignmentId: string }
  | { kind: "shared-feature"; featureId: string };
export type SummaryRequest = { cwd: string; change: string; task?: string } |
  { cwd: string; featureId: string; store: string; map: string };
export type SummaryLifecycle = "task-integrated" | "batch-satisfied" | "feature-completed" | "component-handoff" | "shared-completed";
export interface SummaryReference { id: string; repository: string; commit?: string; path?: string; recordId?: string }
export interface SummaryFact {
  id: string;
  category: "intent" | "work" | "repair" | "verification" | "review" | "limitation" | "delivery";
  authority: "planning" | "worker-report" | "runner-record" | "store-record";
  text: string; references: string[];
}
export interface SummaryEvidence {
  version: 1; subject: SummarySubject; lifecycle: SummaryLifecycle;
  source: { repository: string; fingerprint?: string; base?: string; result: string; archive?: string;
    storeRevision?: string; completionEventId?: string; approvalId?: string; tuple?: Record<string, string> };
  facts: SummaryFact[]; references: SummaryReference[]; gaps: string[];
}
export interface SummaryBundle { version: 1; generatorVersion: 1; digest: string; collectedAt: string; evidence: SummaryEvidence }
export interface NarrativeClaim { text: string; evidenceIds: string[]; expectedBenefit?: boolean }
export interface SummaryNarrative {
  version: 1; sourceDigest: string;
  sections: Record<"problem" | "behavior" | "implementation" | "verification" | "limitations" | "delivery", NarrativeClaim[]>;
}
export interface SummaryHandle {
  subjectKey: string; sourceDigest: string; basic: "ready" | "incomplete" | "failed";
  narrative: "pending" | "ready" | "failed" | "not-applicable";
  freshness: "current" | "superseded"; synopsis: string;
  paths?: { evidence: string; basic: string; narrative?: string }; warning?: string;
}
