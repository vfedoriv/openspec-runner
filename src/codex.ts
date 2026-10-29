import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run } from "./system.js";
import type { Assignment } from "./plan.js";
export interface Settings {
  model: string;
  reasoningEffort?: string;
}
export async function sessionSettings(
  thread = process.env.CODEX_THREAD_ID,
  home = process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
): Promise<Settings> {
  const fallback =
    "Cannot read calling-session model. Pass --default-model MODEL (and optionally --default-effort EFFORT).";
  if (!thread) throw new Error(fallback);
  const version = run("codex", ["--version"], process.cwd());
  if (!/^codex-cli 0\.153\.\d+(?:\s|$)/.test(version))
    throw new Error(`${fallback} Unsupported Codex version: ${version}`);
  const file = resolve(home, "state_5.sqlite");
  if (!existsSync(file)) throw new Error(fallback);
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // Read only the current thread's settings. Never load titles, messages, auth, or other threads.
      const row = db
        .prepare("SELECT model, reasoning_effort FROM threads WHERE id = ?")
        .get(thread);
      if (!row || typeof row.model !== "string" || !row.model)
        throw new Error(fallback);
      return {
        model: row.model,
        ...(typeof row.reasoning_effort === "string"
          ? { reasoningEffort: row.reasoning_effort }
          : {}),
      };
    } finally {
      db.close();
    }
  } catch {
    throw new Error(fallback);
  }
}
export function resolveSettings(a: Assignment, inherited?: Settings): Settings {
  const model = a.model && a.model !== "session" ? a.model : inherited?.model;
  if (!model)
    throw new Error(
      "Missing calling-session metadata; pass --default-model MODEL",
    );
  const reasoningEffort =
    a.reasoningEffort ??
    (!a.model || a.model === "session" || a.model === inherited?.model
      ? inherited?.reasoningEffort
      : undefined);
  return { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
export function codexArgs(
  settings: Settings,
  cwd: string,
  session?: string,
  commonGitDir?: string,
): string[] {
  return [
    ...(session ? ["resume", session] : []),
    "-C",
    cwd,
    ...(commonGitDir ? ["--add-dir", commonGitDir] : []),
    "-m",
    settings.model,
    ...(settings.reasoningEffort
      ? [
          "-c",
          `model_reasoning_effort=${JSON.stringify(settings.reasoningEffort)}`,
        ]
      : []),
  ];
}
export async function models(): Promise<unknown[]> {
  const { resolveCommand } = await import("./platform-command.js");
  const { observeProcess, stopOwnedProcess } = await import("./platform-process.js");
  return new Promise((resolvePromise, reject) => {
    const command = resolveCommand({ executable: "codex", args: ["app-server", "--stdio"], cwd: process.cwd() });
    const child = spawn(command.executable, command.args, {
      env: command.env, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let identity: string | undefined;
    child.once("spawn", () => { identity = observeProcess(child.pid!)?.createdAt; });
    const entries: unknown[] = [];
    let request = 1;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      void (async () => {
        if (child.pid && identity) {
          const stopping = stopOwnedProcess({ pid: child.pid, createdAt: identity, timeoutMs: 3000 });
          child.stdin.end();
          const result = await stopping;
          if (result.uncertain) error ??= new Error("Codex app-server termination is uncertain; inspect the discovery process");
        } else if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.stdin.end();
          error ??= new Error("Codex app-server process identity could not be confirmed");
        }
        error ? reject(error) : resolvePromise(entries);
      })().catch(reject);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Codex model/list timed out; check codex login and app-server compatibility",
          ),
        ),
      20000,
    );
    const send = (method: string, params: unknown) =>
      child.stdin.write(JSON.stringify({ id: request, method, params }) + "\n");
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.stderr.resume();
    child.on("exit", () => {
      if (!done)
        finish(
          new Error("Codex app-server exited before model/list completed"),
        );
    });
    lines.on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.id !== request) return;
        if (m.error) return finish(new Error(JSON.stringify(m.error)));
        if (request === 1) {
          child.stdin.write(
            JSON.stringify({ method: "initialized", params: {} }) + "\n",
          );
          request++;
          send("model/list", { includeHidden: true });
        } else {
          if (!Array.isArray(m.result?.data))
            return finish(new Error("Unsupported Codex model/list response"));
          entries.push(
            ...m.result.data.map((x: any) => ({
              model: x.model,
              id: x.id,
              supportedReasoningEfforts: x.supportedReasoningEfforts,
              defaultReasoningEffort: x.defaultReasoningEffort,
            })),
          );
          if (m.result.nextCursor) {
            request++;
            send("model/list", {
              includeHidden: true,
              cursor: m.result.nextCursor,
            });
          } else finish();
        }
      } catch (e) {
        finish(e as Error);
      }
    });
    send("initialize", {
      clientInfo: { name: "openspec-runner", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
  });
}
