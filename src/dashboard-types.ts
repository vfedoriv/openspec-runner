import type { Assignment, Task } from "./plan.js";
import type { Report, TaskAttempt } from "./runner.js";
import type { FeatureJob, FeatureState } from "./feature-state.js";
import type { ComponentBinding } from "./component-state.js";
import type { ComponentStatus, CoordinationStatus } from "./coordination-state.js";
export type DashboardOptions = { cwd: string; change?: string; store?: string; map?: string };
export type SourceError = { source: string; message: string; stale: boolean };
export type AttentionItem = { id: string; source: string; targetId?: string; priority: number; message: string };
export type FeatureSummary = {
  id: string; change?: string; origin: "local" | "shared"; phase?: FeatureState["phase"];
  completed: number; total: number; state?: FeatureState; taskIds: string[]; sessionIds: string[];
  coordination?: CoordinationStatus;
};
export type TaskSummary = {
  id: string; featureId: string; task: Task; assignment?: Assignment;
  ready: boolean; reasons: string[]; attempts: TaskAttempt[];
};
export type SessionSummary = {
  id: string; featureId: string; taskId?: string; role: "implementation" | "review" | "repair";
  attempt: TaskAttempt | FeatureJob; phase: TaskAttempt["phase"]; reportOutcome?: Report["outcome"];
  process: "running" | "exited" | "unknown"; terminal: "available" | "unavailable" | "unknown";
  log?: string; activityPath?: string;
};
export type AssignmentSummary = {
  id: string; featureId: string; componentId: string; repository: string; change: string; owner: string;
  importedRevision?: string; inspectedRevision?: string; binding?: ComponentBinding;
  status?: ComponentStatus; stale: boolean;
};
export type DashboardSnapshot = {
  version: 1; collectedAt: string;
  repository: { root: string; common: string; stateDir: string; identity?: string; currentWorktree: string };
  features: FeatureSummary[]; tasks: TaskSummary[]; sessions: SessionSummary[];
  assignments: AssignmentSummary[]; attention: AttentionItem[]; errors: SourceError[];
  sources: Record<string, { collectedAt: string; stale: boolean }>;
};
export type CollectorRequest = { version: 1; id: string; options: DashboardOptions };
export type CollectorResponse = { version: 1; id: string; snapshot?: DashboardSnapshot; error?: string };
