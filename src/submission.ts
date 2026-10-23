import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { configFrom, loadPlan } from "./plan.js";
import { committedBlob, safeContextPath } from "./openspec-context.js";
import { clean, git, gitRaw } from "./system.js";
import type { VerificationEvidence } from "./coordination-state.js";

/** Read committed planning bytes without moving refs, creating Git worktrees or trusting checkout files. */
export function committedPlan(options: { root: string; change: string; commit: string }) {
  const entries = gitRaw(options.root, "ls-tree", "-r", "-z", options.commit).split("\0").filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Malformed Git tree entry");
    return { mode: match[1], type: match[2], object: match[3], path: match[4] };
  });
  const runner = entries.find(entry => entry.path === "openspec/runner.yaml");
  if (!runner || !["100644", "100755"].includes(runner.mode)) throw new Error("Missing or unsafe committed runner configuration");
  const config = configFrom(parse(committedBlob({ root: options.root, object: runner.object }).toString("utf8")));
  const supplements = Object.values(config.agents).flatMap(agent => {
    if (!agent.planningRules) return [];
    const supplement = resolve(options.root, agent.planningRules);
    if (!supplement.startsWith(resolve(options.root) + sep)) throw new Error("Planning rules supplement must remain inside the repository");
    return [relative(options.root, supplement).split(sep).join("/")];
  });
  const selected = entries.filter(entry => entry.path.startsWith(`openspec/changes/${options.change}/`) ||
    ["openspec/runner.yaml", "openspec/config.yaml", ...supplements].includes(entry.path));
  if (!selected.some(entry => entry.path === `openspec/changes/${options.change}/tasks.md`)) throw new Error("Component change is missing or archived at submitted commit");
  const root = mkdtempSync(resolve(tmpdir(), "runner-plan-"));
  try {
    for (const entry of selected) {
      safeContextPath(entry.path);
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("Committed planning artifacts cannot contain symlinks or non-files");
      const path = resolve(root, entry.path); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, committedBlob({ root: options.root, object: entry.object }));
    }
    const plan = loadPlan(root, options.change);
    return { fingerprint: plan.fingerprint, tasks: plan.tasks.map(task => ({ id: task.id, completed: task.completed })),
      setup: plan.config.setup, verification: plan.config.verifyIntegration, files: plan.files };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function verificationCommand(options: { root: string; commit: string; command: string[]; env?: Record<string, string> }): VerificationEvidence {
  if (!clean(options.root) || git(options.root, "rev-parse", "HEAD") !== options.commit) throw new Error("Verification requires clean exact-commit checkout");
  let exitCode = 0, evidence: string;
  try {
    evidence = execFileSync(options.command[0], options.command.slice(1), { cwd: options.root, env: { ...process.env, ...options.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error: any) {
    exitCode = Number.isInteger(error.status) && error.status !== 0 ? error.status : 1;
    evidence = [error.stdout?.toString(), error.stderr?.toString(), error.message].filter(Boolean).join("\n");
  }
  if (!clean(options.root) || git(options.root, "rev-parse", "HEAD") !== options.commit) {
    exitCode ||= 1; evidence += "\nVerification changed its exact-commit checkout";
  }
  return { command: [...options.command], exitCode, evidence: evidence.trim() || `Command exited ${exitCode}` };
}

/** Normalize only known local roots in portable output, retaining exact approved argv and status. */
export function portableVerificationEvidence(options: { evidence: VerificationEvidence; roots: { path: string; identity: string }[] }): VerificationEvidence {
  const replacements = new Map<string, string>();
  for (const root of options.roots) {
    const path = resolve(root.path);
    // Resolve the nearest existing ancestor so removed exact checkouts retain their aliases on retry.
    let ancestor = path;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    const canonical = resolve(realpathSync(ancestor), relative(ancestor, path));
    for (const alias of new Set([path, canonical])) {
      replacements.set(alias, root.identity);
      replacements.set(JSON.stringify(alias).slice(1, -1), JSON.stringify(root.identity).slice(1, -1));
    }
  }
  const aliases = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = aliases.length ? new RegExp(`(?:${aliases.map(escape).join("|")})(?=$|[\\/\\\\\\s\"'\x60,;:)}\\]])`, "g") : undefined;
  return { ...options.evidence, command: [...options.evidence.command],
    evidence: pattern ? options.evidence.evidence.replace(pattern, match => replacements.get(match)!) : options.evidence.evidence };
}

/** Coordinator-owned detached checkout, recoverable by explicit local operation path. */
export function exactCheckout(options: { root: string; commit: string; path: string }) {
  if (!existsSync(options.path)) {
    mkdirSync(dirname(options.path), { recursive: true });
    git(options.root, "worktree", "add", "--detach", options.path, options.commit);
  }
  if (git(options.path, "rev-parse", "--show-toplevel") !== options.path ||
      git(options.path, "rev-parse", "HEAD") !== options.commit || !clean(options.path))
    throw new Error("Coordinator checkout reservation must be clean at the exact commit");
  return options.path;
}
export function removeExactCheckout(options: { root: string; path: string }) {
  if (existsSync(options.path)) git(options.root, "worktree", "remove", "--force", options.path);
}
