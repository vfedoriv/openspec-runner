import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { SupervisedSession } from "../worker.js";
import { getHarness } from "./registry.js";
import { armHookLease, readHookLease, type HookLease } from "./copilot-hooks.js";
import { prepareEditorAgent, editorPreparationCommands } from "./copilot-editor.js";
import { run } from "../system.js";
import { resolveCommand } from "../platform-command.js";
import { observeProcess, stopOwnedProcess, windowsTreeIsGone } from "../platform-process.js";

export function copilotDecision(lease: HookLease | undefined, exit: number | null | undefined, editor: boolean): number | undefined {
  if (!editor && exit === undefined) return undefined;
  if (exit !== undefined && exit !== 0) return exit ?? 1;
  if (!lease?.status) return editor ? undefined : 1;
  return lease.status === "stopped" && lease.session && lease.reportAccepted && !lease.error ? 0 : 1;
}

export async function superviseCopilot(
  a: SupervisedSession & { id: string }, common: string, prompt: string,
  started: (pid: number) => void,
  evidence: (update: (current: SupervisedSession) => void) => void,
): Promise<number | null> {
  const harness = getHarness(a.agent), editor = a.agent === "copilot-vscode", stateDir = resolve(common, "openspec-runner");
  const hook = resolve(a.path, ".github/hooks/openspec-runner.json");
  if (!existsSync(hook)) throw new Error("Copilot hooks are missing; run init --agent copilot or copilot-vscode and commit the installed hooks");
  const hookConfig = JSON.parse(readFileSync(hook, "utf8"));
  if (!hookConfig.hooks || !(hookConfig.hooks.UserPromptSubmit || hookConfig.hooks.userPromptSubmitted) || !(hookConfig.hooks.Stop || hookConfig.hooks.agentStop))
    throw new Error("Copilot hook installation lacks required ownership/stop events");
  const mode = editor ? prepareEditorAgent({ worktree: a.path, attempt: a.id, model: a.settings.model,
    hookFormat: a.settings.options?.hookFormat === "copilot" ? "copilot" : "vscode" }).mode : a.expectedSession!;
  if (editor) for (const command of editorPreparationCommands(a.settings, a.path, mode))
    run(command.executable, command.args, command.cwd, 10000);
  // Preparation never submits a prompt. Arm ownership only for the actual
  // task so empty bootstrap sessions cannot claim or terminate its lease.
  const nonce = randomUUID();
  const lease = armHookLease({ stateDir, attempt: a.id, harness: a.agent!, worktree: a.path, generation: a.worker!.token, nonce,
    ...(a.expectedSession ? { expectedSession: a.expectedSession } : {}) });
  mkdirSync(resolve(dirname(a.path), "reports"), { recursive: true });
  const invocation = harness.initialInvocation(a.settings, a.path, common, `${prompt}\n[openspec-runner:${a.id}:${nonce}]`, mode);
  mkdirSync(dirname(a.worker!.log), { recursive: true });
  const log = openSync(a.worker!.log, "ax", 0o600);
  let child: ReturnType<typeof spawn> | undefined;
  let exit: number | null | undefined, failure: Error | undefined;
  let childIdentity: string | undefined;
  try {
    started(process.pid);
    const environment = { ...process.env, ...invocation.env };
    delete environment.CODEX_THREAD_ID;
    const command = resolveCommand({ executable: invocation.executable, args: invocation.args, cwd: invocation.cwd, env: environment });
    child = spawn(command.executable, command.args, { cwd: invocation.cwd, env: command.env, windowsHide: true, stdio: [invocation.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    child.once("spawn", () => {
      try {
        if (!editor) childIdentity = observeProcess(child!.pid!)?.createdAt;
        evidence(current => { current.worker!.launcher = { pid: child!.pid, processStart: childIdentity }; });
        if (invocation.stdin !== undefined) child!.stdin!.end(invocation.stdin);
      } catch (error) { failure = error as Error; }
    });
    child.stdin?.on("error", error => { failure = error; });
    for (const output of [child.stdout, child.stderr]) output?.on("data", chunk => { writeSync(log, chunk); });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      exit = code;
      try { evidence(current => { current.worker!.launcher = { ...current.worker!.launcher, exitedAt: new Date().toISOString(), exitCode: code }; }); }
      catch (error) { failure = error as Error; }
    });
    const start = Date.now(), startup = Number(a.settings.options?.startupTimeoutMs ?? 60000), completion = Number(a.settings.options?.completionTimeoutMs ?? 1800000);
    while (true) {
      if (failure) throw failure;
      const current = readHookLease(stateDir, a.id);
      if (current?.generation !== lease.generation) throw new Error("Copilot supervisor generation changed");
      const decision = copilotDecision(current, exit, editor);
      if (decision !== undefined) {
        if (current.session) evidence(value => {
          value.identityConfirmed = true; value.observedSession = current.session;
          if (current.stoppedAt) value.terminalEvidence = { type: "agent-stop", metadata: { is_error: !!current.error || !current.reportAccepted } };
        });
        if (decision === 0) evidence(value => { value.worker!.completion = { source: editor ? "agent-stop" : "process-exit", at: new Date().toISOString(), session: current.session! }; });
        return decision;
      }
      if (Date.now() - start > completion || (!current.session && Date.now() - start > startup))
        throw new Error("Copilot hook deadline expired; editor activity may remain uncertain. Inspect saved chat/worktree before retrying");
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  } finally {
    if (!editor && process.platform === "win32" && child?.pid && exit !== undefined && (!childIdentity || !windowsTreeIsGone(child.pid, childIdentity)))
      evidence(current => { current.worker!.terminationUncertain = true; });
    // The editor can outlive its launcher: never kill unrelated GUI processes.
    if (!editor && child?.pid && exit === undefined) {
      const stopped = childIdentity ? await stopOwnedProcess({ pid: child.pid, createdAt: childIdentity, timeoutMs: 3000 }) : { stopped: false, uncertain: true };
      evidence(current => { current.worker!.terminationUncertain = stopped.uncertain; });
      const closeDeadline = Date.now() + 1000;
      while (exit === undefined && Date.now() < closeDeadline) await new Promise(r => setTimeout(r, 20));
      if (exit === undefined) evidence(current => { current.worker!.terminationUncertain = true; });
    }
    child?.stdout?.removeAllListeners("data");
    child?.stderr?.removeAllListeners("data");
    closeSync(log);
  }
}
