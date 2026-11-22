import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommand } from "../platform-command.js";
import { git, repository } from "../system.js";
import { samePath, unredirectedPath } from "../platform-paths.js";
import { copilotHookPath } from "./copilot-hooks.js";
import type { StoreInvocationScope } from "./types.js";

/** Host discovery requires this disposable file in the owned worker worktree. */
export function prepareStoreCopilotHooks(input: { worktree: string; attempt: string; scope: StoreInvocationScope }): { path: string } {
  if (!input.scope.selection) throw new Error("Store Copilot hooks require explicit assignment selection");
  const repo = repository(input.worktree);
  const admin = git(input.worktree, "rev-parse", "--git-dir");
  if (samePath(resolve(input.worktree, admin), repo.common)) throw new Error("Store hooks require an assigned linked worktree");
  const path = resolve(input.worktree, copilotHookPath);
  if (!unredirectedPath(path)) throw new Error("Redirected Store hook path");
  if (git(input.worktree, "ls-files", "--", copilotHookPath)) throw new Error("Store hook path is tracked; preserve existing hook file");
  const descriptor = Buffer.from(JSON.stringify(input.scope.selection)).toString("base64url");
  const entry = fileURLToPath(new URL("../../bin/openspec-runner.js", import.meta.url));
  const hooks = Object.fromEntries(["UserPromptSubmit", "Stop", "SessionEnd", "PreToolUse", "ErrorOccurred"].map(event => {
    const args = [process.execPath, entry, "hook", event, "--store-scope", descriptor];
    return [event, [{ type: "command", command: renderCommand(args, "posix"), powershell: `${renderCommand(args, "powershell")}; exit $LASTEXITCODE`, timeoutSec: 10 }]];
  }));
  const content = JSON.stringify({ version: 1, hooks }, null, 2) + "\n";
  if (existsSync(path)) {
    if (readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== content) throw new Error("Conflicting runner hooks; preserve existing hook file");
    return { path };
  }
  const exclude = resolve(repo.common, "info/exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  const previous = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const pattern = `/${copilotHookPath}`;
  if (!previous.split(/\r?\n/).includes(pattern)) writeFileSync(exclude, `${previous}\n${pattern}\n`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: "wx" });
  return { path };
}
