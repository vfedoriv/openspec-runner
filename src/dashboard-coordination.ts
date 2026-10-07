import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { CoordinationStore, decodeManifest, stableDigest, type AssignmentRecord, type FeatureManifest } from "./coordination-state.js";
import { coordinationRevision } from "./coordination.js";
import { readMachineMap } from "./repository-map.js";
import { attempt, git, gitRaw, repository } from "./system.js";
import type { AssignmentSummary, DashboardOptions, DashboardSnapshot } from "./dashboard-types.js";

type Fields = Pick<DashboardSnapshot, "features" | "tasks" | "assignments" | "attention" | "errors" | "sources">;
type Candidate = { branches: Set<string>; manifests: FeatureManifest[]; errors: string[] };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const normalized = (path: string) => {
  const canonical = realpathSync(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
};

/** Observe local committed history only; checkout files and imported pins cannot grant authority. */
export function collectCoordination(options: DashboardOptions, local: DashboardSnapshot): Fields {
  const result: Fields = {
    features: [...local.features], tasks: [...local.tasks], assignments: [...local.assignments], attention: [...local.attention],
    errors: [...local.errors], sources: { ...local.sources },
  };
  const error = (source: string, reason: unknown) => {
    result.sources[source] = { collectedAt: local.collectedAt, stale: false };
    result.errors.push({ source, message: message(reason), stale: false });
    result.attention.push({ id: `${source}:error`, source, priority: 1, message: message(reason) });
  };
  const blockImportedTasks = (imported: AssignmentSummary | undefined, reason: string) => {
    if (!imported?.binding) return;
    const binding = imported.binding;
    result.tasks = result.tasks.map(task => {
      if (task.featureId !== imported.featureId || !Object.hasOwn(binding.assignment.settings.tasks, task.task.id)) return task;
      const explanation = `Coordination authority: ${reason}`;
      result.attention.push({ id: `${task.id}:authority:${binding.assignmentId}`, source: task.featureId, targetId: task.id, priority: 1, message: explanation });
      return { ...task, ready: false, reasons: [...new Set([...task.reasons, explanation])] };
    });
  };
  const finish = () => {
    for (const assignment of result.assignments) if (assignment.binding && !assignment.inspectedRevision)
      result.attention.push({ id: `${assignment.id}:authority-unknown`, source: assignment.featureId, targetId: assignment.id,
        priority: 3, message: "Imported pinned revision only; current Store authority and revocation are unknown" });
    return result;
  };
  const identity = attempt(() => git(local.repository.root, "config", "--get", "openspec-runner.repository")) ??
    attempt(() => git(local.repository.root, "remote", "get-url", "origin"));
  local.repository.identity = identity;
  if (!options.store && !options.map) return finish();
  let root: string, associated: string;
  const candidates = new Map<string, Candidate>();
  try {
    if (!options.store || !options.map) throw new Error("--store and --map must be supplied together");
    root = repository(resolve(options.store)).root;
    const mapped = readMachineMap(options.map);
    const aliases = Object.entries(mapped).filter(([, checkout]) => normalized(repository(checkout).common) === normalized(local.repository.common)).map(([id]) => id);
    if (!identity || aliases.length !== 1 || aliases[0] !== identity)
      throw new Error("Ambiguous or missing repository/map association for the current Git worktree");
    associated = identity;
    const ensure = (id: string) => {
      let candidate = candidates.get(id);
      if (!candidate) { candidate = { branches: new Set(), manifests: [], errors: [] }; candidates.set(id, candidate); }
      return candidate;
    };
    for (const assignment of local.assignments) if (assignment.binding) ensure(assignment.binding.featureId);
    const seen = new Set<string>();
    const revisions = git(root, "rev-list", "--branches", "HEAD").split("\n");
    for (const revision of revisions) {
      for (const entry of gitRaw(root, "ls-tree", "-r", "-z", revision, "--", "runner/features").split("\0").filter(Boolean)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\trunner\/features\/([^/]+)\/manifest\.yaml$/.exec(entry);
        if (!match || seen.has(`${match[4]}:${match[3]}`)) continue;
        seen.add(`${match[4]}:${match[3]}`);
        const candidate = ensure(match[4]);
        try {
          if (!["100644", "100755"].includes(match[1]) || match[2] !== "blob") throw new Error("Committed manifest must be a regular file");
          const manifest = decodeManifest({ value: gitRaw(root, "cat-file", "blob", match[3]) });
          if (manifest.featureId !== match[4]) throw new Error("Manifest feature identity differs from its committed path");
          candidate.branches.add(manifest.coordinationBranch); candidate.manifests.push(manifest);
        } catch (cause) { candidate.errors.push(message(cause)); }
      }
    }
    result.sources.coordination = { collectedAt: local.collectedAt, stale: false };
  } catch (cause) { error("coordination", cause); return finish(); }

  for (const [featureId, candidate] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const source = `shared:${featureId}`;
    const bindings = local.assignments.filter(a => a.binding?.featureId === featureId && a.repository === associated);
    const matches = (manifest: FeatureManifest) => Object.values(manifest.components).some(c => c.repository === associated && (!options.change || c.change === options.change));
    // A malformed candidate has no trustworthy association; report its data error individually.
    if (candidate.manifests.length && !candidate.manifests.some(matches) && !bindings.length) continue;
    try {
      if (candidate.errors.length) throw new Error(candidate.errors.join("; "));
      if (!candidate.branches.size) throw new Error("Missing committed feature manifest in locally available Store history");
      const store = new CoordinationStore({ root, featureId });
      const resolved = [...candidate.branches].map(branch => {
        const head = git(root, "rev-parse", `refs/heads/${branch}^{commit}`);
        const manifest = store.readManifest({ revision: head });
        if (manifest.featureId !== featureId || manifest.coordinationBranch !== branch) throw new Error("Conflicting authoritative feature/branch declaration");
        return { head, manifest };
      });
      if (resolved.length !== 1) throw new Error("Conflicting authoritative coordination branch declarations");
      const { head, manifest } = resolved[0];
      if (!matches(manifest) && !bindings.length) continue;
      const inspectedRevision = coordinationRevision({ store, revision: head });
      const snapshot = store.readSnapshot({ revision: inspectedRevision });
      const authority = store.authoritativeApproval({ snapshot });
      const status = store.status({ revision: inspectedRevision });
      const assignments = snapshot.records.filter((r): r is AssignmentRecord => r.kind === "assignment" && r.repository === associated && (!options.change || r.change === options.change));
      result.sources[source] = { collectedAt: local.collectedAt, stale: false };
      result.features.push({ id: source, origin: "shared", coordination: status, completed: Object.values(status.components).filter(c => !!c.deliveryCommit).length,
        total: Object.keys(manifest.components).length, taskIds: [], sessionIds: [] });
      for (const assignment of assignments) {
        const imported = bindings.find(a => a.binding?.assignmentId === assignment.id);
        const current = status.components[assignment.componentId];
        const importMismatch = !!imported?.binding && stableDigest({ value: imported.binding.assignment }) !== stableDigest({ value: assignment });
        const stale = importMismatch || current?.assignmentId !== assignment.id || assignment.approvalId !== authority?.id || authority?.manifestFingerprint !== stableDigest({ value: manifest }) || !!current?.dependencyStale || !!current?.requiresReapproval;
        result.assignments = result.assignments.filter(a => !(a.binding?.featureId === featureId && a.repository === assignment.repository && a.binding.assignmentId === assignment.id));
        const id = `${source}:assignment:${assignment.id}`;
        result.assignments.push({ id, featureId: source, componentId: assignment.componentId, repository: assignment.repository, change: assignment.change, owner: assignment.owner,
          binding: imported?.binding, importedRevision: imported?.importedRevision, inspectedRevision, status: current?.assignmentId === assignment.id ? current : undefined, stale });
        if (stale) {
          const reason = importMismatch ? "Imported assignment differs from authoritative Store history" : current?.assignmentId !== assignment.id ? "Assignment revoked or no longer active in inspected history" : "Assignment approval or dependency is stale in inspected history";
          result.attention.push({ id: `${id}:stale`, source, targetId: id, priority: 1, message: reason });
          blockImportedTasks(imported, reason);
        }
      }
      for (const imported of bindings) if (!assignments.some(a => a.id === imported.binding!.assignmentId)) {
        const id = `${source}:assignment:${imported.binding!.assignmentId}`;
        result.assignments = result.assignments.filter(a => a !== imported);
        result.assignments.push({ ...imported, id, featureId: source, inspectedRevision, stale: true });
        result.attention.push({ id: `${id}:missing`, source, targetId: id, priority: 1, message: "Imported assignment is missing from authoritative Store history" });
        blockImportedTasks(imported, "Imported assignment is missing from authoritative Store history");
      }
      if (status.blocker) result.attention.push({ id: `${source}:blocker`, source, targetId: source, priority: 1, message: status.blocker });
    } catch (cause) { error(source, cause); }
  }
  return finish();
}
