import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { componentBindingPath, readComponentBinding } from "./component-state.js";
import { stableDigest, validateId } from "./coordination-state.js";
import { readFeature, featurePath } from "./feature-state.js";
import { agentMayBeActive } from "./harnesses/lifecycle.js";
import { publishExclusive } from "./platform-files.js";
import { unredirectedPath } from "./platform-paths.js";
import { Runner, type TaskAttempt } from "./runner.js";
import { atomic, git, repository } from "./system.js";
import { inspectTerminal } from "./terminal-cleanup.js";

export interface RetirementInput { change: string; assignmentId: string; owner: string; reason: string }
export interface RetirementSnapshot {
  binding: string;
  feature: string | null;
  runner: string | null;
  head: string;
  repository: string;
  stateDir: string;
}
interface RetirementEvidence { version: 1; input: RetirementInput; token: string; snapshot: RetirementSnapshot }
const digest = (value: unknown) => stableDigest({ value });
export function retirementPath(stateDir: string, featureId: string, assignmentId: string) {
  validateId({ value: featureId }); validateId({ value: assignmentId });
  return resolve(stateDir, "component-retirements", featureId, `${assignmentId}.json`);
}
function bytes(path: string): string | null {
  if (!unredirectedPath(path)) throw new Error("Retirement evidence path is redirected");
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error("Retirement requires regular runtime files");
  return readFileSync(path, "utf8");
}
function selected(root: string, repositoryId: string, input: RetirementInput) {
  const repo = repository(root), binding = readComponentBinding({ stateDir: repo.stateDir, change: input.change });
  if (!binding || binding.repository !== repositoryId || binding.assignmentId !== input.assignmentId)
    throw new Error("Retirement assignment identity differs from local binding");
  if (binding.assignment.owner !== input.owner || !input.reason?.trim()) throw new Error("Retirement requires matching owner and concrete reason");
  return { repo, binding, evidencePath: retirementPath(repo.stateDir, binding.featureId, binding.assignmentId) };
}
function savedEvidence(path: string, input: RetirementInput, token: string): RetirementEvidence {
  const evidence = JSON.parse(bytes(path) ?? "null") as RetirementEvidence;
  if (!evidence || evidence.version !== 1 || digest(evidence.input) !== digest(input) || evidence.token !== token ||
      digest({ input: evidence.input, snapshot: evidence.snapshot }) !== token)
    throw new Error("Retirement evidence or confirmation token changed");
  return evidence;
}
export function retirementPreview(root: string, repositoryId: string, input: RetirementInput) {
  const { repo, binding, evidencePath } = selected(root, repositoryId, input);
  if (binding.phase === "retiring" || binding.phase === "retired") {
    const evidence = savedEvidence(evidencePath, input, binding.retirement!.token);
    return { ...evidence, evidencePath, phase: binding.phase };
  }
  if (binding.phase !== "ready") throw new Error("Incomplete assignment import blocks retirement; recover the reserved import first");
  const feature = readFeature(repo.stateDir, input.change), runner = new Runner(root), state = runner.read(input.change);
  if (state?.transaction || state?.cleanupBatch || feature?.transaction || feature?.phase === "archiving" || feature?.archive)
    throw new Error("Pending integration, cleanup, or archive transaction blocks retirement");
  const attempts = [...(state?.attempts ?? []), ...(feature?.jobs ?? [])];
  for (const attempt of attempts) {
    if (["preparing", "manual", "launching", "running"].includes(attempt.phase) || agentMayBeActive(attempt) ||
        (attempt.session && !attempt.worker?.exitedAt)) throw new Error("Active or uncertain owned worker blocks retirement");
    const terminal = inspectTerminal(root, attempt as TaskAttempt);
    if (terminal.blocked || (terminal.pane && !terminal.closed && terminal.reason)) throw new Error("Uncertain or active terminal blocks retirement");
  }
  const snapshot: RetirementSnapshot = { binding: bytes(componentBindingPath({ stateDir: repo.stateDir, change: input.change }))!,
    feature: bytes(featurePath(repo.stateDir, input.change)), runner: bytes(runner.path(input.change)),
    head: git(root, "rev-parse", "HEAD"), repository: repositoryId, stateDir: repo.stateDir };
  return { version: 1 as const, input, snapshot, token: digest({ input, snapshot }), evidencePath, phase: binding.phase };
}
export function retireComponent(root: string, repositoryId: string, input: RetirementInput, token: string) {
  return new Runner(root).lock(() => {
    const { repo, binding, evidencePath } = selected(root, repositoryId, input);
    if (!token) throw new Error("Retirement confirmation token required");
    if (binding.phase !== "retiring" && binding.phase !== "retired") {
      const preview = retirementPreview(root, repositoryId, input);
      if (preview.token !== token) throw new Error("Retirement token is stale; preview again");
      const evidence: RetirementEvidence = { version: 1, input, token, snapshot: preview.snapshot };
      if (existsSync(evidencePath)) {
        if (digest(savedEvidence(evidencePath, input, token)) !== digest(evidence)) throw new Error("Retirement evidence differs");
      } else {
        if (!unredirectedPath(evidencePath)) throw new Error("Retirement evidence path is redirected");
        publishExclusive(evidencePath, Buffer.from(JSON.stringify(evidence, null, 2) + "\n"));
      }
      binding.phase = "retiring"; binding.retirement = { token, reason: input.reason };
      atomic(componentBindingPath({ stateDir: repo.stateDir, change: input.change }), binding);
    }
    const evidence = savedEvidence(evidencePath, input, token);
    if (binding.retirement?.token !== token || evidence.snapshot.stateDir !== repo.stateDir || evidence.snapshot.repository !== repositoryId)
      throw new Error("Retirement intent identity differs");
    const original = JSON.parse(evidence.snapshot.binding), { retirement, ...currentBinding } = binding;
    if (digest({ ...currentBinding, phase: original.phase }) !== digest(original)) throw new Error("Retirement binding changed since intent");
    // After intent, dispatch is blocked. Never remove bytes that changed since it.
    const paths = [[featurePath(repo.stateDir, input.change), evidence.snapshot.feature], [new Runner(root).path(input.change), evidence.snapshot.runner]] as const;
    for (const [path, expected] of paths) {
      const current = bytes(path);
      if (current !== null && current !== expected) throw new Error("Active state changed since retirement intent; retain evidence and reconcile");
    }
    for (const [path] of paths) if (existsSync(path)) unlinkSync(path);
    binding.phase = "retired";
    atomic(componentBindingPath({ stateDir: repo.stateDir, change: input.change }), binding);
    return { phase: "retired" as const, change: input.change, assignmentId: input.assignmentId, evidencePath,
      nextAction: "Import a different approved assignment; retained resources and evidence require explicit inspection" };
  });
}
