import type { AssignmentRecord, ComponentStatus, FeatureManifest } from "./coordination-state.js";

export function affectedDependents(options: { manifest: FeatureManifest; componentId: string }): string[] {
  const affected = new Set<string>();
  const visit = (upstream: string) => {
    for (const [id, component] of Object.entries(options.manifest.components)) {
      if (!affected.has(id) && component.dependencies.some(dependency => dependency.componentId === upstream)) {
        affected.add(id); visit(id);
      }
    }
  };
  visit(options.componentId);
  return [...affected].sort();
}

export function dependencyBlockers(options: { manifest: FeatureManifest; componentId: string; components: Record<string, ComponentStatus>; assignment?: AssignmentRecord; historical?: boolean }): string[] {
  const declared = options.historical && options.assignment ? options.assignment.dependencies : options.manifest.components[options.componentId].dependencies;
  const blockers: string[] = [];
  for (const dependency of declared) {
    const upstream = options.components[dependency.componentId];
    const commit = !options.historical && (upstream.requiresReapproval || upstream.dependencyStale) ? undefined : dependency.milestone === "merged" ? upstream.deliveryCommit : upstream.acceptedCommit;
    const evidence = options.assignment?.dependencies.find(record => record.componentId === dependency.componentId && record.milestone === dependency.milestone);
    if (!commit) blockers.push(`Dependency ${dependency.componentId} requires ${dependency.milestone}`);
    else if (options.assignment && evidence?.commit !== commit) blockers.push(`Dependency ${dependency.componentId} ${dependency.milestone} commit changed; revoke stale assignment and issue a new assignment`);
  }
  if (options.assignment && options.assignment.dependencies.length !== declared.length) blockers.push("Assignment dependency inventory differs from current plan; renew approval");
  return blockers;
}
