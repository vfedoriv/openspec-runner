import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskAttempt } from "./runner.js";
import { getHarness } from "./harnesses/registry.js";
import { createActivityWriter, type ActivityWriter } from "./activity-writer.js";
import { ClaudeStreamDecoder } from "./harnesses/claude-stream.js";
import { superviseCopilot } from "./harnesses/copilot-supervisor.js";
import { resolveCommand } from "./platform-command.js";
import { observeProcess, stopOwnedProcess, windowsTreeIsGone } from "./platform-process.js";

// Exec exits after its turn and preserves session rollouts by default. The parent
// observes close only after the child and its report command have returned.
export type SupervisedSession = Pick<TaskAttempt, "agent" | "path" | "settings" | "expectedSession" |
  "session" | "worker" | "identityConfirmed" | "observedSession" | "terminalEvidence"> & { id?: string };

export async function superviseWorker(
  a: SupervisedSession,
  common: string,
  prompt: string,
  started: (pid: number) => void,
  evidence?: (update: (current: SupervisedSession) => void) => void,
): Promise<number | null> {
  const harness = getHarness(a.agent ?? "codex");
  const capabilities = await harness.capabilities(a.path, a.settings);
  if (!capabilities.supported)
    throw new Error(`${harness.displayName} is not ready: ${capabilities.reasons.join("; ")}`);
  if (harness.lifecycle?.ownership === "hook") {
    if (!a.id || !evidence) throw new Error("Copilot supervision requires durable attempt evidence");
    return superviseCopilot({ ...a, id: a.id }, common, prompt, started, evidence);
  }
  if (a.agent === "claude" && a.settings.effort && !capabilities.features.effort)
    throw new Error("Claude CLI does not advertise --effort; omit effort or install a compatible CLI");
  if (a.agent === "claude" && a.settings.effort && capabilities.supportedEfforts?.length && !capabilities.supportedEfforts.includes(a.settings.effort))
    throw new Error(`Claude CLI does not support effort ${a.settings.effort}; supported values: ${capabilities.supportedEfforts.join(", ")}`);
  const session = a.expectedSession ?? a.session ?? "";
  if (a.agent === "claude" && !session)
    throw new Error("Claude worker is missing its reserved session UUID");
  let invocation = harness.initialInvocation(
    a.settings,
    a.path,
    common,
    prompt,
    session,
  );
  if (a.id && capabilities.features.structuredActivity && harness.activityInvocation) {
    try { invocation = harness.activityInvocation(invocation, capabilities); } catch { /* Optional capture hook. */ }
  }
  mkdirSync(dirname(a.worker!.log), { recursive: true });
  const fd = openSync(a.worker!.log, "ax", 0o600);
  let activity: ActivityWriter | undefined;
  try {
    if (a.id) activity = createActivityWriter(a.worker!.log, { attemptId: a.id, harness: a.agent ?? "codex" });
  } catch { /* Capture cannot prevent worker execution. */ }
  try {
    return await new Promise((resolvePromise, reject) => {
      let failure: unknown;
      let createdAt: string | undefined;
      let stopping: Promise<void> | undefined;
      const environment = { ...process.env, ...(invocation.env ?? {}) };
      if (a.agent === "claude") delete environment.CODEX_THREAD_ID;
      const command = resolveCommand({ executable: invocation.executable, args: invocation.args, cwd: invocation.cwd, env: environment });
      const child = spawn(command.executable, command.args, {
        cwd: invocation.cwd,
        env: command.env,
        windowsHide: true,
        stdio: [invocation.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stop = () => {
        stopping ??= (async () => {
          const result = child.pid && createdAt
            ? await stopOwnedProcess({ pid: child.pid, createdAt, timeoutMs: 3000 })
            : { stopped: false, uncertain: true };
          if (result.uncertain) evidence?.(current => { current.worker!.terminationUncertain = true; });
        })();
      };
      const decoder = a.agent === "claude"
        ? new ClaudeStreamDecoder((event) => {
            if (!event.sessionId) return;
            try {
              // Stream identity is evidence, not the begin/report registration gate.
              const update = (current: SupervisedSession) => {
                if (current.expectedSession && current.expectedSession !== event.sessionId)
                  throw new Error("Claude stream identity does not match the reserved session");
                current.identityConfirmed = true;
                current.observedSession = event.sessionId;
                if (typeof event.raw.model === "string") current.settings.observedModel = event.raw.model;
                if (event.terminal) {
                  current.terminalEvidence = {
                    type: event.type,
                    subtype: event.subtype,
                    metadata: {
                      ...(typeof event.raw.is_error === "boolean" ? { is_error: event.raw.is_error } : {}),
                      ...(typeof event.raw.duration_ms === "number" ? { duration_ms: event.raw.duration_ms } : {}),
                    },
                  };
                }
              };
              // The callback runs synchronously from stdout's data event. The worker
              // command's lock is short-lived and serializes this durable evidence.
              evidence?.(update);
            } catch (error) {
              failure = error;
            }
          })
        : undefined;
      child.once("spawn", () => {
        try { createdAt = observeProcess(child.pid!)?.createdAt; started(child.pid!); } catch (error) { failure = error; stop(); }
        if (invocation.stdin !== undefined) {
          child.stdin!.write(invocation.stdin);
          child.stdin!.end();
        }
      });
      child.stdout!.on("data", chunk => {
        try { activity?.feed(chunk, "stdout"); } catch { /* Observational only. */ }
        try {
          writeSync(fd, chunk);
          process.stdout.write(chunk);
          decoder?.feed(chunk);
        } catch (error) {
          failure = error;
          stop();
        }
      });
      child.stderr!.on("data", chunk => {
        try { activity?.feed(chunk, "stderr"); } catch { /* Observational only. */ }
        writeSync(fd, chunk); process.stderr.write(chunk);
      });
      child.once("error", error => { failure = error; });
      child.stdin?.on("error", error => { failure ??= error; stop(); });
      child.once("close", async code => {
        try { await stopping; } catch (error) { failure ??= error; }
        if (process.platform === "win32" && child.pid && (!createdAt || !windowsTreeIsGone(child.pid, createdAt)))
          evidence?.(current => { current.worker!.terminationUncertain = true; });
        try {
          decoder?.end();
        } catch (error) {
          failure ??= error;
        }
        failure ? reject(failure) : resolvePromise(code);
      });
    });
  } finally {
    try { await activity?.close(); } catch { /* Capture failures do not alter the result. */ }
    fsyncSync(fd);
    closeSync(fd);
  }
}
