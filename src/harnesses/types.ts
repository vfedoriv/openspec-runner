import type { Assignment } from "../plan.js";

export type HarnessId = string;

export interface WorkerReceipt {
  linuxNonce?: string;
  linuxIdentity?: import("../platform-process.js").LinuxProvenance;
  linuxObserved?: import("../platform-process.js").ProcessIdentity[];
  linuxStop?: { version: 1; binding: string; integrity: string; receipt: import("../platform-process.js").LinuxStopReceipt };
  token: string;
  pid?: number;
  processStart?: string;
  processPlatform?: NodeJS.Platform;
  terminationUncertain?: boolean;
  exitedAt?: string;
  exitCode?: number | null;
  log: string;
  completion?: { source: "process-exit" | "agent-stop"; at: string; session: string };
  launcher?: { pid?: number; processStart?: string; exitedAt?: string; exitCode?: number | null };
}

export interface HarnessSettings {
  /** Stable harness identity saved with the attempt. */
  harness?: HarnessId;
  /** Requested model or alias. This is intentionally not normalized by core. */
  model: string;
  requestedModel?: string;
  /** Common v2 effort name, when the harness supports one. */
  effort?: string;
  /** v1 compatibility spelling used by the Codex adapter. */
  reasoningEffort?: string;
  /** Adapter-owned, versioned options. Core treats this as opaque. */
  options?: Record<string, unknown>;
  observedModel?: string;
  /** Sources make preview output explainable without changing execution. */
  sources?: string[];
}

export interface AgentConfig {
  defaultModel: string;
  permissionMode?: string;
  allowedTools?: string[];
  planningRules?: string;
  options?: Record<string, unknown>;
}

export interface HarnessCapabilities {
  harness: HarnessId;
  installed: boolean;
  version?: string;
  supported: boolean;
  reasons: string[];
  supportedEfforts?: string[];
  features: {
    supervisedExecution: boolean;
    sessionOwnership: boolean;
    workerReports: boolean;
    inspection: boolean;
    callingSessionInheritance: boolean;
    modelDiscovery: boolean;
    exactResume: boolean;
    effort: boolean;
    structuredActivity?: boolean;
  };
}

export interface Invocation {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  /** Runtime directories created by the coordinator before a managed launch. */
  prepareDirectories?: string[];
}

export interface ManagedInvocationContext {
  common: string;
  gitDir: string;
  branch: string;
  store?: StoreInvocationScope;
}
export interface StoreInvocationScope {
  root: string;
  common: string;
  runtimeDir: string;
  contextPaths: string[];
}

export interface ModelDiscovery {
  harness: HarnessId;
  status: "available" | "unavailable" | "partial";
  models?: unknown[];
  examples?: string[];
  exhaustive: boolean;
  reason?: string;
}

export interface SessionEvidence {
  sessionId?: string;
  terminal?: boolean;
  subtype?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly planningRulesPath: string;
  readonly lifecycle?: {
    transport: "process" | "editor";
    ownership: "environment" | "stream" | "hook";
    reservedSession: boolean;
    skillPrefix: string;
  };
  resolveSettings(
    assignment: Assignment,
    inherited: HarnessSettings | undefined,
    config?: AgentConfig,
  ): HarnessSettings;
  capabilities(cwd?: string, settings?: HarnessSettings): Promise<HarnessCapabilities>;
  models(options?: { includeHidden?: boolean; discover?: boolean; cwd?: string }): Promise<ModelDiscovery>;
  initialInvocation(
    settings: HarnessSettings,
    cwd: string,
    commonGitDir: string,
    prompt: string,
    session: string,
    store?: StoreInvocationScope,
  ): Invocation;
  activityInvocation?(invocation: Invocation, capabilities: HarnessCapabilities): Invocation;
  managedInvocation?(invocation: Invocation, context: ManagedInvocationContext): Invocation;
  validateManagedInvocation?(invocation: Invocation, context: ManagedInvocationContext): void;
  resumeInvocation(
    settings: HarnessSettings,
    cwd: string,
    commonGitDir: string,
    session: string,
    store?: StoreInvocationScope,
  ): Invocation;
  planningRules(root?: string, config?: AgentConfig): PlanningRulesResult;
}

export interface PlanningRulesDocument {
  source: string;
  version: string;
  hash: string;
  content: string;
}

export interface PlanningRulesResult {
  harness: HarnessId;
  documents: PlanningRulesDocument[];
}
