import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stableDigest, validateId, type ArchiveScope, type CommitTuple, type CoordinationEvent, type CoordinationStore } from "./coordination-state.js";
import { atomic, attempt, clean, git, gitRaw, json, locked, repository, run } from "./system.js";
import { committedBlob } from "./openspec-context.js";
import { exactCheckout, removeExactCheckout } from "./submission.js";
import { changedPaths, pathState } from "./coordination-delivery.js";
import { coordinationOperation, type OperationJournal } from "./coordination-operation.js";
import type { MutationIdentity } from "./coordination.js";

const digest = (value: unknown) => stableDigest({ value });
export interface ArchiveTarget {
  repository: string;
  change: string;
  branch: string;
  base: string;
  componentId?: string;
  allowedPaths: string[];
  tasksContent?: string;
}
export interface ArchivePreview {
  head: string;
  token: string;
  scope: ArchiveScope;
  tuple: CommitTuple;
  reviewEventId: string;
  targets: Record<string, ArchiveTarget>;
}
export function normalizeArchiveScope(options: { scope: ArchiveScope; componentIds: string[] }): ArchiveScope {
  const { scope, componentIds } = options;
  if (!scope || Object.keys(scope).some(key => !["componentIds", "includeStore", "storeDeliveryBranch"].includes(key)) || !Array.isArray(scope.componentIds) || typeof scope.includeStore !== "boolean") throw new Error("Explicit archive scope is required");
  if (new Set(scope.componentIds).size !== scope.componentIds.length || scope.componentIds.some(id => !componentIds.includes(id)) || (!scope.componentIds.length && !scope.includeStore)) throw new Error("Archive scope requires unique known targets");
  if (scope.includeStore && (!scope.storeDeliveryBranch || attempt(() => git(process.cwd(), "check-ref-format", `refs/heads/${scope.storeDeliveryBranch}`)) === undefined)) throw new Error("Store archive scope requires explicit canonical delivery branch");
  if (!scope.includeStore && scope.storeDeliveryBranch !== undefined) throw new Error("Store canonical branch requires Store scope");
  return { componentIds: [...scope.componentIds].sort(), includeStore: scope.includeStore, ...(scope.includeStore ? { storeDeliveryBranch: scope.storeDeliveryBranch } : {}) };
}
export function archiveTarget(options: { root: string; repository: string; change: string; branch: string; componentId?: string; deliveredCommit?: string; tasksContent?: string; pinnedBase?: string }): ArchiveTarget {
  const branchHead = attempt(() => git(options.root, "rev-parse", `refs/heads/${options.branch}^{commit}`));
  if (!branchHead) throw new Error(`Retrieve explicit archive canonical branch ${options.branch} in ${options.repository}`);
  const base = options.pinnedBase ?? branchHead;
  if (attempt(() => git(options.root, "merge-base", "--is-ancestor", base, branchHead)) === undefined) throw new Error("Approved archive base no longer reachable on canonical branch");
  if (options.deliveredCommit && attempt(() => git(options.root, "merge-base", "--is-ancestor", options.deliveredCommit!, base)) === undefined) throw new Error("Archive base must follow recorded canonical delivery");
  if (!git(options.root, "ls-tree", "-r", "--name-only", base, "--", `openspec/changes/${options.change}/`)) throw new Error("Active archive change is missing on canonical branch");
  return { repository: options.repository, change: options.change, branch: options.branch, base, ...(options.componentId ? { componentId: options.componentId } : {}),
    allowedPaths: [`openspec/changes/${options.change}/`, `openspec/changes/archive/YYYY-MM-DD-${options.change}/`, "openspec/specs/"], ...(options.tasksContent === undefined ? {} : { tasksContent: options.tasksContent }) };
}
export interface TargetReceipt {
  stage: "reserved" | "running" | "produced" | "committing" | "prepared" | "failed";
  path: string;
  branch: string;
  evidence?: string;
  reason?: string;
  paths?: string[];
  commit?: string;
  tree?: string;
  recovery?: { attestedBy: string };
}
export interface ArchivePreparationReceipt { preview: ArchivePreview; completionEventId: string; targets: Record<string, TargetReceipt> }
export function archiveJournalPath(options: { store: CoordinationStore; operationId: string }) {
  validateId({ value: options.operationId });
  return resolve(repository(options.store.root).stateDir, "archive", `${options.operationId}.json`);
}
function archiveScopeEvidence(options: { target: ArchiveTarget; receipt: TargetReceipt }) {
  const { target, receipt } = options, path = receipt.path;
  if (git(path, "rev-parse", "HEAD") !== target.base) throw new Error("Archive checkout changed from approved base before commit");
  const paths = [...new Set([
    ...gitRaw(path, "diff", "--no-renames", "--name-only", "-z", "HEAD").split("\0").filter(Boolean),
    ...gitRaw(path, "diff", "--cached", "--no-renames", "--name-only", "-z").split("\0").filter(Boolean),
    ...gitRaw(path, "ls-files", "--others", "-z").split("\0").filter(Boolean),
  ])].sort();
  const active = `openspec/changes/${target.change}/`, archiveRoot = "openspec/changes/archive/";
  const archiveFolders = new Set<string>();
  for (const entry of paths) {
    const local = resolve(path, entry);
    if (existsSync(local) && !lstatSync(local).isFile()) throw new Error(`Unsafe archive scope non-file: ${entry}`);
    if (entry.startsWith(active) || entry.startsWith("openspec/specs/")) continue;
    if (entry.startsWith(archiveRoot)) {
      const folder = entry.slice(archiveRoot.length).split("/")[0];
      if (/^\d{4}-\d{2}-\d{2}-/.test(folder) && folder.slice(11) === target.change) { archiveFolders.add(folder); continue; }
    }
    throw new Error(`Unexpected archive scope path: ${entry}`);
  }
  if (existsSync(resolve(path, active)) || archiveFolders.size !== 1) throw new Error("OpenSpec archive must remove active change and produce one dated archive");
  const folder = [...archiveFolders][0];
  const source = gitRaw(path, "ls-tree", "-r", "-z", target.base, "--", active).split("\0").filter(Boolean);
  const expected = new Set<string>();
  for (const line of source) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Archive source contains unsafe non-file planning entries");
    const destination = `${archiveRoot}${folder}/${match[3].slice(active.length)}`;
    expected.add(destination);
    const sourceBytes = committedBlob({ root: path, object: match[2] }), targetBytes = readFileSync(resolve(path, destination));
    if (match[3] === `${active}tasks.md` && target.tasksContent !== undefined) {
      if (!targetBytes.equals(Buffer.from(target.tasksContent))) throw new Error("Archived shared tasks differ from approved milestones");
    } else if (!sourceBytes.equals(targetBytes)) throw new Error("Archived planning bytes differ from approved source");
  }
  if (paths.some(entry => entry.startsWith(`${archiveRoot}${folder}/`) && !expected.has(entry))) throw new Error("Unexpected archived planning file outside approved scope");
  if (!paths.length) throw new Error("Archive produced no scoped changes");
  return paths;
}
export function prepareApprovedArchive(options: { store: CoordinationStore; input: MutationIdentity & { scope: ArchiveScope; token: string }; roots: Record<string, string>; preview: () => ArchivePreview; completionEventId: string; authorized: (preview: ArchivePreview) => boolean }) {
  const { store, input } = options;
  return coordinationOperation<ArchivePreparationReceipt, ReturnType<CoordinationStore["writeRecord"]>[]>({ store, input, action: "archive", initialize: () => {
    const preview = options.preview();
    if (preview.token !== input.token) throw new Error("Archive scope/input token is stale");
    if (!options.authorized(preview)) throw new Error("Explicit archive scope approval/consent is required");
    const targets = Object.fromEntries(Object.keys(preview.targets).map(id => [id, { stage: "reserved" as const, path: resolve(repository(options.roots[id]).stateDir, "archive-checkouts", input.operationId, id), branch: `runner-archive/${store.featureId}/${input.operationId}/${id}` }]));
    return { preview, completionEventId: options.completionEventId, targets };
  }, execute: ({ journal, save, write }) => {
    const data = journal.data;
    if (Object.values(data.targets).every(target => target.stage === "prepared") && Object.keys(data.targets).every(id => store.readRecord({ kind: "event", id: `${input.id}-${id}` })) && store.readRecord({ kind: "event", id: `${input.id}-finished` })) return Object.keys(data.targets).map(id => {
      const record = store.readRecord({ kind: "event", id: `${input.id}-${id}` });
      if (!record) throw new Error("Archive receipt lacks committed prepared record");
      return { path: `${store.directory}/events/${record.id}.json`, created: false, head: journal.expectedHead, operationId: record.operationId };
    });
    if (options.preview().token !== data.preview.token || !options.authorized(data.preview)) throw new Error("Archive approved inputs drifted since durable intent");
    write({ id: `${input.id}-started`, operationId: `${input.operationId}-started`, payload: { type: "operation-started", targetOperationId: input.operationId, action: "archive", snapshotToken: input.token } });
    const results = [];
    for (const [id, target] of Object.entries(data.preview.targets)) {
      const receipt = data.targets[id], root = options.roots[id];
      if (receipt.stage === "running" || receipt.stage === "failed") throw new Error(receipt.reason ?? "Interrupted archive command has ambiguous side effects; inspect receipt and explicitly recover");
      if (receipt.stage === "reserved") {
        exactCheckout({ root, commit: target.base, path: receipt.path });
        if (target.tasksContent !== undefined) writeFileSync(resolve(receipt.path, `openspec/changes/${target.change}/tasks.md`), target.tasksContent);
        receipt.stage = "running"; save();
        try {
          receipt.evidence = run("openspec", ["archive", target.change, "--yes"], receipt.path).replaceAll(receipt.path, id);
          receipt.paths = archiveScopeEvidence({ target, receipt });
          // Scope validation includes ignored output too; preserve the complete produced tree.
          git(receipt.path, "add", "--all", "--force", "--", ".");
          receipt.tree = git(receipt.path, "write-tree");
          receipt.stage = "produced"; save();
        } catch (error: any) {
          receipt.stage = "failed"; receipt.reason = String(error.message).replaceAll(receipt.path, id); receipt.evidence ??= receipt.reason; save(); throw new Error(receipt.reason);
        }
      }
      if (receipt.stage === "produced") {
        if (!receipt.tree) throw new Error("Produced archive receipt lacks saved tree identity; inspect and reconcile without rerunning OpenSpec");
        if (digest(archiveScopeEvidence({ target, receipt })) !== digest(receipt.paths)) throw new Error("Produced archive scope changed since receipt");
        receipt.stage = "committing"; save();
      }
      if (receipt.stage === "committing") {
        if (!receipt.tree) throw new Error("Interrupted archive commit lacks saved tree identity; inspect and reconcile without rerunning OpenSpec");
        const head = git(receipt.path, "rev-parse", "HEAD"), marker = `Runner-Archive: ${input.operationId}/${id}`;
        if (head === target.base) {
          if (digest(archiveScopeEvidence({ target, receipt })) !== digest(receipt.paths)) throw new Error("Archive scope changed since produced receipt");
          // Every dirty/untracked path was validated immediately above in this private checkout.
          git(receipt.path, "add", "--all", "--force", "--", ".");
          if (git(receipt.path, "write-tree") !== receipt.tree) throw new Error("Produced archive blob tree changed since durable receipt");
          git(receipt.path, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", `Archive ${target.change}\n\n${marker}`);
        } else if (git(receipt.path, "rev-parse", `${head}^{tree}`) !== receipt.tree || !clean(receipt.path) || git(receipt.path, "show", "-s", "--format=%P", head) !== target.base || !git(receipt.path, "show", "-s", "--format=%B", head).includes(marker) || digest(changedPaths({ root, base: target.base, commit: head })) !== digest(receipt.paths)) throw new Error("Archive commit recovery requires exact operation identity and scope");
        receipt.commit = git(receipt.path, "rev-parse", "HEAD");
        const existing = attempt(() => git(root, "rev-parse", `refs/heads/${receipt.branch}`));
        if (existing && existing !== receipt.commit) throw new Error("Prepared archive branch identity conflicts");
        if (!existing) git(root, "update-ref", `refs/heads/${receipt.branch}`, receipt.commit, "");
        receipt.stage = "prepared"; save();
      }
      const result = write({ id: `${input.id}-${id}`, operationId: `${input.operationId}-${id}`, payload: { type: "archive-prepared", ...(target.componentId ? { componentId: target.componentId } : {}), commit: receipt.commit!, preparedBranch: receipt.branch, base: target.base, branch: target.branch, paths: receipt.paths!, completionEventId: data.completionEventId, snapshotToken: data.preview.token, evidence: receipt.evidence?.trim() || "OpenSpec archive scope verified" } });
      results.push(result);
      removeExactCheckout({ root, path: receipt.path });
    }
    const finished = write({ id: `${input.id}-finished`, operationId: `${input.operationId}-finished`, payload: { type: "operation-finished", targetOperationId: input.operationId, action: "archive", snapshotToken: input.token } });
    return results.map(result => ({ ...result, head: finished.head }));
  } });
}
export function inspectArchivePreparation(options: { store: CoordinationStore; operationId: string }) {
  const path = archiveJournalPath(options);
  if (!existsSync(path)) throw new Error("Archive preparation operation is unknown on this machine");
  return json<OperationJournal<ArchivePreparationReceipt>>(path).data;
}
export function recoverArchivePreparation(options: { store: CoordinationStore; operationId: string; targetId: string; attestedBy: string }) {
  if (!options.attestedBy?.trim()) throw new Error("Explicit operator attestation required for ambiguous archive recovery");
  const runtime = repository(options.store.root).stateDir;
  return locked(runtime, () => {
    const path = archiveJournalPath(options), journal = json<OperationJournal<ArchivePreparationReceipt>>(path), receipt = journal.data.targets[options.targetId], target = journal.data.preview.targets[options.targetId];
    if (!receipt || !target || !["running", "failed"].includes(receipt.stage)) throw new Error("Archive recovery requires an interrupted target receipt");
    if (options.store.readSnapshot().head !== journal.expectedHead) throw new Error("Coordination head changed since archive intent; reconcile history");
    receipt.paths = archiveScopeEvidence({ target, receipt });
    git(receipt.path, "add", "--all", "--force", "--", ".");
    receipt.tree = git(receipt.path, "write-tree");
    receipt.recovery = { attestedBy: options.attestedBy }; receipt.evidence = `${receipt.evidence ?? "Interrupted OpenSpec command"}\nScoped result explicitly inspected by ${options.attestedBy}`;
    receipt.stage = "produced"; delete receipt.reason; atomic(path, journal);
    return { operationId: options.operationId, targetId: options.targetId, paths: receipt.paths, nextAction: "Resume the original archive preparation identity; OpenSpec will not rerun" };
  });
}
export function archiveDeliveryEvidence(options: { store: CoordinationStore; root: string; preparedEventId: string; deliveryCommit: string }) {
  const snapshot = options.store.readSnapshot();
  const prepared = snapshot.records.find((r): r is Extract<CoordinationEvent, { type: "archive-prepared" | "archive-delivered" }> => r.kind === "event" && r.type === "archive-prepared" && r.id === options.preparedEventId);
  if (!prepared || !prepared.base || !prepared.completionEventId || !prepared.snapshotToken) throw new Error("Approved prepared archive record required");
  const branchHead = attempt(() => git(options.root, "rev-parse", `refs/heads/${prepared.branch}^{commit}`));
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(options.deliveryCommit) || !branchHead || attempt(() => git(options.root, "merge-base", "--is-ancestor", options.deliveryCommit, branchHead)) === undefined) throw new Error("Archive delivery commit must be available and reachable on approved canonical branch");
  const active = `openspec/changes/${prepared.componentId ? snapshot.manifest.components[prepared.componentId].change : snapshot.manifest.sharedChange}/`;
  if (git(options.root, "ls-tree", "-r", "--name-only", options.deliveryCommit, "--", active)) throw new Error("Canonical archive delivery still contains an active change");
  const mismatches = prepared.paths.filter(path => pathState({ root: options.root, commit: prepared.commit, path }) !== pathState({ root: options.root, commit: options.deliveryCommit, path }));
  if (mismatches.length) throw new Error(`Canonical archive content differs from prepared result: ${mismatches.join(", ")}`);
  const payload = { type: "archive-delivered" as const, ...(prepared.componentId ? { componentId: prepared.componentId } : {}), commit: options.deliveryCommit, branch: prepared.branch, paths: prepared.paths, preparedEventId: prepared.id, completionEventId: prepared.completionEventId, snapshotToken: prepared.snapshotToken, base: prepared.base };
  return { head: snapshot.head, token: digest(payload), payload };
}
