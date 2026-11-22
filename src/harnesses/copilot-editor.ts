import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { stringify } from "yaml";
import { repository, git } from "../system.js";
import { unredirectedPath } from "../platform-paths.js";
import { resolveCopilotRuntime } from "./copilot-runtime.js";
import type { HarnessSettings, Invocation, StoreInvocationScope } from "./types.js";

export function editorPreparationCommands(settings: HarnessSettings, cwd: string, mode: string): Invocation[] {
  const executable = String(settings.options?.executable ?? "code");
  return [
    { executable, cwd, args: [cwd, ...(typeof settings.options?.profile === "string" ? ["--profile", settings.options.profile] : [])] },
    // Clear a remembered Ask mode without sending a model request. Custom
    // modes are discovered asynchronously; an unresolved mode must not leave
    // the subsequent worker inheriting a read-only Ask session.
    { executable, cwd, args: ["chat", "--mode", "agent"] },
    { executable, cwd, args: ["chat", "--mode", mode] },
  ];
}

export function prepareEditorAgent(input: { worktree: string; attempt: string; model: string; hookFormat: "copilot" | "vscode"; store?: StoreInvocationScope }): { mode: string; path: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.attempt)) throw new Error("Invalid editor attempt");
  const mode = `openspec-runner-${input.attempt}`, path = resolve(input.worktree, ".github/agents", `${mode}.agent.md`);
  if (input.store) {
    resolveCopilotRuntime({ common: repository(input.worktree).common, worktree: input.worktree, store: input.store });
    if (!unredirectedPath(path) || git(input.worktree, "ls-files", "--", `.github/agents/${mode}.agent.md`))
      throw new Error("Store editor agent path is redirected or tracked; preserve existing files");
  }
  const exclude = resolve(repository(input.worktree).common, "info/exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  const previous = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const pattern = `/.github/agents/${mode}.agent.md`;
  if (!previous.split(/\r?\n/).includes(pattern)) writeFileSync(exclude, `${previous}\n${pattern}\n`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${stringify({ name: mode, description: "Execute one assigned runner worker", model: input.model })}---\nFollow the runner prompt and report protocol. Stop after reporting.\n`, { flag: "wx" });
  return { mode, path };
}
