import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { atomic, json, locked } from "../system.js";
import { samePath } from "../platform-paths.js";

export interface HookEvent {
  kind: "prompt" | "stop" | "end" | "error" | "tool";
  session: string;
  cwd: string;
  at: string;
  prompt?: string;
  subagent?: boolean;
  recoverable?: boolean;
  reason?: string;
}
export interface HookLease {
  version: 1;
  attempt: string;
  harness: string;
  worktree: string;
  generation: string;
  nonce: string;
  armedAt: string;
  expectedSession?: string;
  session?: string;
  boundAt?: string;
  reportAt?: string;
  stoppedAt?: string;
  error?: string;
  status?: "stopped" | "ended";
  reportAccepted?: boolean;
}
const events: Record<string, HookEvent["kind"]> = {
  userPromptSubmitted: "prompt", UserPromptSubmit: "prompt", agentStop: "stop", Stop: "stop",
  sessionEnd: "end", SessionEnd: "end", errorOccurred: "error", ErrorOccurred: "error",
  preToolUse: "tool", PreToolUse: "tool",
};
export function normalizeHook(eventName: string, value: unknown): HookEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hook payload");
  const raw = value as Record<string, unknown>, kind = events[eventName];
  const session = raw.sessionId ?? raw.session_id, cwd = raw.cwd;
  const timestamp = new Date(raw.timestamp as string | number);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid hook timestamp");
  const at = timestamp.toISOString();
  if (!kind || typeof session !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(session) ||
      typeof cwd !== "string" || !cwd || /[\0\r\n]/.test(cwd)) throw new Error("Invalid hook session or payload");
  return { kind, session, cwd, at,
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    ...((raw.agentId || raw.agent_id || raw.parentAgentId || raw.parent_agent_id) ? { subagent: true } : {}),
    ...(typeof raw.recoverable === "boolean" ? { recoverable: raw.recoverable } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  };
}
export function transitionHook(lease: HookLease, event: HookEvent): HookLease {
  if (!samePath(event.cwd, lease.worktree)) throw new Error("Hook worktree identity mismatch");
  if (event.subagent && event.kind !== "tool") throw new Error("Hook must describe the root session");
  if (!Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) < Date.parse(lease.armedAt))
    throw new Error("Stale hook event");
  if (lease.boundAt && Date.parse(event.at) < Date.parse(lease.boundAt)) throw new Error("Stale hook before ownership binding");
  if (event.kind === "stop" && lease.reportAt && Date.parse(event.at) < Date.parse(lease.reportAt)) throw new Error("Stale stop before report acceptance");
  if (lease.session && lease.session !== event.session) throw new Error("Hook session identity mismatch");
  if (lease.status) {
    if ((event.kind === "stop" || event.kind === "end") && lease.status === "stopped") return lease;
    throw new Error("Hook lease is terminal");
  }
  if (event.kind === "prompt") {
    if (!event.prompt?.includes(`[openspec-runner:${lease.attempt}:${lease.nonce}]`)) throw new Error("Hook nonce identity mismatch");
    if (lease.expectedSession && lease.expectedSession !== event.session) throw new Error("Reserved session mismatch");
    return { ...lease, session: event.session, boundAt: lease.boundAt ?? event.at };
  }
  if (!lease.session) throw new Error("Hook session ownership is not confirmed");
  if (event.kind === "stop") return { ...lease, status: "stopped", stoppedAt: event.at };
  if (event.kind === "end") return { ...lease, status: "ended", error: event.reason ?? "Session ended before root stop" };
  if (event.kind === "error" && !event.recoverable) return { ...lease, error: event.reason ?? "Unrecoverable Copilot lifecycle error" };
  return lease;
}
function leasePath(stateDir: string, attempt: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(attempt)) throw new Error("Invalid hook attempt ID");
  return resolve(stateDir, "hooks", `${attempt}.json`);
}
export function readHookLease(stateDir: string, attempt: string): HookLease | undefined {
  const path = leasePath(stateDir, attempt);
  return existsSync(path) ? json<HookLease>(path) : undefined;
}
export function armHookLease(input: { stateDir: string; attempt: string; harness: string; worktree: string; generation: string; nonce: string; expectedSession?: string }): HookLease {
  const { stateDir, ...fields } = input;
  return locked(resolve(stateDir, "hooks"), () => {
    if (readHookLease(stateDir, fields.attempt)) throw new Error("Hook attempt already armed; inspect before retrying");
    const lease: HookLease = { version: 1, ...fields, worktree: realpathSync(fields.worktree), armedAt: new Date().toISOString() };
    atomic(leasePath(stateDir, fields.attempt), lease);
    return lease;
  });
}
export function recordHook(input: { stateDir: string; event: HookEvent }): { output: Record<string, unknown>; exitCode: number } {
  return locked(resolve(input.stateDir, "hooks"), () => {
    const dir = resolve(input.stateDir, "hooks");
    if (!existsSync(dir)) return { output: {}, exitCode: 0 };
    const event = { ...input.event, cwd: realpathSync(input.event.cwd) };
    const leases = readdirSync(dir).filter(n => n.endsWith(".json") && n !== "lock.json").map(n => json<HookLease>(resolve(dir, n)))
      .filter(l => samePath(l.worktree, event.cwd));
    if (!leases.length) return { output: {}, exitCode: 0 };
    if (leases.length !== 1) throw new Error("Ambiguous hook worktree ownership");
    const previous = leases[0];
    if (Date.parse(event.at) > Date.now() + 60000) throw new Error("Future hook timestamp");
    if (event.subagent && event.kind !== "tool") return { output: {}, exitCode: 0 };
    try {
      const reportPath = resolve(input.stateDir, "reports", `${previous.attempt}.json`);
      if (event.kind === "stop" && !previous.status && existsSync(reportPath))
        previous.reportAt = new Date(Math.floor(statSync(reportPath).mtimeMs)).toISOString();
      const lease = transitionHook(previous, event);
      if (event.kind === "stop" && !previous.status) {
        const report = existsSync(reportPath) ? json<{ session: string }>(reportPath) : undefined;
        lease.reportAccepted = report?.session === lease.session;
      }
      if (event.kind !== "tool") atomic(leasePath(input.stateDir, lease.attempt), lease);
      return { output: {}, exitCode: 0 };
    } catch (error) {
      if (event.kind === "tool") return { output: { permissionDecision: "deny", permissionDecisionReason: String(error), hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: String(error) } }, exitCode: 2 };
      throw error;
    }
  });
}
