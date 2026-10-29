import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { stringify } from "yaml";
import { repository } from "../system.js";

export function prepareEditorAgent(input: { worktree: string; attempt: string; model: string; hookFormat: "copilot" | "vscode" }): { mode: string; path: string } {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.attempt)) throw new Error("Invalid editor attempt");
  const mode = `openspec-runner-${input.attempt}`, path = resolve(input.worktree, ".github/agents", `${mode}.agent.md`);
  const exclude = resolve(repository(input.worktree).common, "info/exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  const previous = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const pattern = `/.github/agents/${mode}.agent.md`;
  if (!previous.split(/\r?\n/).includes(pattern)) writeFileSync(exclude, `${previous}\n${pattern}\n`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${stringify({ name: mode, description: "Execute one assigned runner worker", model: input.model })}---\nFollow the runner prompt and report protocol. Stop after reporting.\n`, { flag: "wx" });
  return { mode, path };
}
