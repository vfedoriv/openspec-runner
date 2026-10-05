import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, realpathSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { Coordination, assertRepositoryIdentity, type ApprovalInputs, type MutationIdentity, type ReferenceInput } from "./coordination.js";
import { Component, type ComponentResources } from "./component.js";
import { CoordinationStore, decodeManifest, decodeRecord, type ArchiveScope, type FeatureManifest } from "./coordination-state.js";
import { resolveContext } from "./openspec-context.js";
import { git, json, repository } from "./system.js";
import type { MergeInput } from "./coordination-delivery.js";

export const linkedHelp = `coordination <action> <feature> --store CHECKOUT --map MAP [--json]
  init --file MANIFEST | status [--revision SHA]
  inspect --kind approval|assignment|submission|event --record ID [--revision SHA]
  approve [--references FILE] [--contract-revision SHA] --approved-by LABEL
  assign --component ID --owner LABEL [--references FILE]
  revoke --assignment ID --reason TEXT
  import --file RECEIPT | accept --submission ID
  review --stage combined|final --file REVIEW
  merge | accept-delivery --component ID --delivery-commit SHA
    --merge-style merge|squash|rebase --pr-url URL --attested-by LABEL
    accept-delivery additionally requires --file DELIVERED_REVIEW
  complete [--file ARCHIVE_SCOPE] --approved-by LABEL
  archive-approve --file ARCHIVE_SCOPE --approved-by LABEL
  archive-prepare --file ARCHIVE_SCOPE
  archive-inspect --operation ID
  archive-recover --operation ID --target ID --attested-by LABEL
  archive-deliver --prepared EVENT --delivery-commit SHA
  Mutations require --expected-head SHA; new records require --id ID --operation ID.
  init requires --operation ID; imported receipts keep their own IDs.
  Snapshot mutations require --confirm TOKEN from the matching --dry-run preview.
  --dry-run never writes records, runs checks, or creates checkouts.
component <action> <feature> --store CHECKOUT --repository ID [--json]
  inspect | import --assignment ID --owner LABEL [--file RESOURCES]
  status --change CHANGE [--revision SHA]
  export --change CHANGE --outcome completed|blocked|failed [--reason TEXT]
    --id ID --operation ID --output RECEIPT
  import/export accept --dry-run; real import/export require --expected-head SHA
  and --confirm TOKEN. --root CHECKOUT selects the local implementation checkout.
Store checkout paths and machine maps are local; manifest storeId selects OpenSpec.
Workflow guide: ${fileURLToPath(new URL("../docs/team-workflow.md", import.meta.url))}
Input builder: ${fileURLToPath(new URL("../docs/examples/linked-feature-inputs.mjs", import.meta.url))}
`;

type Values = Record<string, string | boolean | undefined>;
const stringOptions = ["store", "map", "file", "expected-head", "confirm", "id", "operation", "created-at", "approved-by", "component", "owner", "assignment", "reason", "submission", "stage", "delivery-commit", "merge-style", "pr-url", "attested-by", "prepared", "target", "revision", "references", "contract-revision", "root", "repository", "change", "outcome", "output", "kind", "record"];
const identityOptions = ["expected-head", "id", "operation", "created-at"];
const snapshotOptions = [...identityOptions, "confirm"];
const contextOptions = ["references", "contract-revision"];
const mergeOptions = ["component", "delivery-commit", "merge-style", "pr-url", "attested-by"];
const actions: Record<string, Record<string, string[]>> = {
  coordination: {
    init: ["file", "expected-head", "operation", ...contextOptions],
    status: ["revision"],
    inspect: ["kind", "record", "revision"],
    approve: [...snapshotOptions, ...contextOptions, "approved-by"],
    assign: [...snapshotOptions, ...contextOptions, "component", "owner"],
    revoke: [...identityOptions, "assignment", "reason"],
    import: ["expected-head", "file"],
    accept: [...snapshotOptions, "submission"],
    review: [...snapshotOptions, "stage", "file"],
    merge: [...snapshotOptions, ...mergeOptions],
    "accept-delivery": [...snapshotOptions, ...mergeOptions, "file"],
    complete: [...snapshotOptions, "approved-by", "file"],
    "archive-approve": [...snapshotOptions, "file", "approved-by"],
    "archive-prepare": [...snapshotOptions, "file"],
    "archive-inspect": ["operation"],
    "archive-recover": ["operation", "target", "attested-by", "expected-head"],
    "archive-deliver": [...snapshotOptions, "prepared", "delivery-commit"],
  },
  component: {
    inspect: ["assignment", "owner", "file", "revision"],
    import: ["assignment", "owner", "file", "expected-head", "confirm"],
    status: ["change", "revision"],
    export: [...snapshotOptions, "change", "outcome", "reason", "output"],
  },
};
function value(v: Values, key: string): string {
  const result = v[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`--${key} is required`);
  return result;
}
function optional(v: Values, key: string): string | undefined {
  return typeof v[key] === "string" ? v[key] as string : undefined;
}
function head(v: Values): string {
  const result = value(v, "expected-head");
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error("--expected-head requires a full 40-character Git SHA");
  return result;
}
function identity(v: Values): MutationIdentity {
  return { id: value(v, "id"), operationId: value(v, "operation"), expectedHead: head(v), ...(v["created-at"] ? { createdAt: value(v, "created-at") } : {}) };
}
function file<T>(v: Values): T { return json<T>(resolve(value(v, "file"))); }
function machineMap(path: string): Record<string, string> {
  const input = json<unknown>(resolve(path));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("--map must contain a repository identity to checkout path object");
  const result: Record<string, string> = {};
  for (const [id, root] of Object.entries(input)) {
    if (!id.trim() || typeof root !== "string" || !root.trim()) throw new Error("--map entries require repository identities and checkout paths");
    result[id] = repository(resolve(dirname(resolve(path)), root)).root;
    assertRepositoryIdentity({ root: result[id], repository: id });
  }
  return result;
}
function inputs(c: Coordination, manifest: FeatureManifest, v: Values): ApprovalInputs {
  const identities = Object.entries(c.repositories).filter(([, root]) => realpathSync(root) === realpathSync(c.store.root)).map(([id]) => id);
  if (identities.length !== 1) throw new Error("--map must identify the selected Store checkout with exactly one repository identity");
  const context = resolveContext({ cwd: c.store.root, change: manifest.sharedChange, store: manifest.storeId });
  if (realpathSync(context.planningRoot) !== realpathSync(c.store.root)) throw new Error("OpenSpec resolved a different Store checkout; repair the Store registration or select its explicit --store path");
  const references = v.references ? json<ReferenceInput[]>(resolve(value(v, "references"))) : undefined;
  if (references !== undefined && !Array.isArray(references)) throw new Error("--references must contain an array of explicit pinned reference inputs");
  return { contract: { repository: identities[0], context, ...(v["contract-revision"] ? { revision: value(v, "contract-revision") } : {}) }, ...(references ? { references } : {}) };
}
function mergeInput(v: Values): MergeInput {
  const mergeStyle = value(v, "merge-style");
  if (!["merge", "squash", "rebase"].includes(mergeStyle)) throw new Error("--merge-style must be merge, squash, or rebase");
  return { componentId: value(v, "component"), deliveryCommit: value(v, "delivery-commit"), mergeStyle: mergeStyle as MergeInput["mergeStyle"], prUrl: value(v, "pr-url"), attestedBy: value(v, "attested-by") };
}

/** Separate parsing preserves existing local command compatibility. */
export async function linkedCommand(args: string[]): Promise<unknown> {
  const options = Object.fromEntries(stringOptions.map(name => [name, { type: "string" as const }]));
  const parsed = parseArgs({ args, allowPositionals: true, tokens: true, options: { ...options, json: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  const v = parsed.values as Values, [family, action, featureId] = parsed.positionals;
  if (v.help) return { help: linkedHelp };
  if (parsed.positionals.length !== 3 || !actions[family]?.[action]) throw new Error(`Use ${family} <action> <feature>; see --help`);
  const common = ["store", "json", "dry-run", "help", ...(family === "coordination" ? ["map"] : ["repository", "root"])];
  const allowed = new Set([...common, ...actions[family][action]]), seen = new Set<string>();
  for (const token of parsed.tokens ?? []) if (token.kind === "option") {
    if (!allowed.has(token.name)) throw new Error(`--${token.name} is not supported for ${family} ${action}`);
    if (seen.has(token.name)) throw new Error(`Specify --${token.name} at most once`);
    seen.add(token.name);
  }
  const dryRun = Boolean(v["dry-run"]);
  if (dryRun && ["status", "inspect", "archive-inspect"].includes(action)) throw new Error(`--dry-run is not supported for ${family} ${action}; this action is already read-only`);
  if (dryRun && v.confirm) throw new Error("--confirm is not supported with --dry-run");
  const storeRoot = repository(resolve(value(v, "store"))).root;
  const envelope = { version: 1, command: family, action, featureId, dryRun, planningRoot: storeRoot };
  if (family === "component") {
    const component = new Component({ root: resolve(optional(v, "root") ?? process.cwd()), repository: value(v, "repository") });
    let result: any;
    if (action === "inspect" || action === "import") {
      const input = { storeRoot, featureId, assignmentId: value(v, "assignment"), owner: value(v, "owner"), ...(v.file ? { resources: file<Partial<ComponentResources>>(v) } : {}),
        ...(action === "import" && !dryRun ? { historyRevision: head(v) } : v.revision ? { historyRevision: value(v, "revision") } : {}) };
      result = action === "import" && !dryRun ? await component.import({ ...input, token: value(v, "confirm") }) : await component.inspect(input);
    } else {
      const change = value(v, "change"), binding = component.readBinding({ change });
      if (!binding || binding.featureId !== featureId) throw new Error("No imported assignment for this feature/change; inspect and import the explicit assignment first");
      if (action === "status") result = component.status({ change, storeRoot, historyRevision: optional(v, "revision") });
      else {
        const outcome = value(v, "outcome");
        if (!["completed", "blocked", "failed"].includes(outcome)) throw new Error("--outcome must be completed, blocked, or failed");
        const input = { change, outcome: outcome as "completed" | "blocked" | "failed", ...(v.reason ? { reason: value(v, "reason") } : {}) };
        if (dryRun) result = component.submissionPreview(input);
        else {
          // Inspect the declared local history without fetching or claiming remote freshness.
          component.status({ change, storeRoot, historyRevision: head(v) });
          const output = resolve(value(v, "output"));
          if (existsSync(output) && (!lstatSync(output).isFile() || lstatSync(output).isSymbolicLink())) throw new Error("--output must be a regular receipt file");
          result = component.exportSubmission({ ...input, id: value(v, "id"), operationId: value(v, "operation"), token: value(v, "confirm"), ...(v["created-at"] ? { createdAt: value(v, "created-at") } : {}) });
          if (existsSync(output)) {
            if (readFileSync(output, "utf8") !== result.bytes) throw new Error("--output contains different receipt bytes; inspect it and choose a new path; never overwrite a handoff");
          } else writeFileSync(output, result.bytes, { flag: "wx" });
          result.output = output;
        }
      }
    }
    let acceptance = null, delivery = null, archive = null;
    if (action === "status") {
      const store = new CoordinationStore({ root: storeRoot, featureId });
      const status = store.status({ revision: result.inspectedHistory }), definition = store.readManifest({ revision: status.head }).components[result.assignment.componentId];
      const current = status.components[result.assignment.componentId];
      acceptance = { phase: current.phase, commit: current.acceptedCommit ?? null };
      delivery = { branch: definition.deliveryBranch, commit: current.deliveryCommit ?? null };
      archive = status.archive;
      result.blocker = result.revoked ? "Assignment revoked in inspected history" : current.blocker ?? status.blocker ?? null;
    }
    return { ...result, ...envelope, implementationRoot: component.repo.root, acceptance, delivery, archive, blocker: result.blocker ?? null, nextAction: result.nextAction ?? (action === "export" && !dryRun ? "Publish result branch and receipt through explicit Git handoffs" : "Import the previewed assignment or resume delegated execution") };
  }
  const c = new Coordination({ root: storeRoot, featureId, repositories: machineMap(value(v, "map")) });
  const ensureRoots = (manifest: FeatureManifest) => {
    for (const definition of Object.values(manifest.components)) if (!c.repositories[definition.repository]) throw new Error(`Explicit repository map missing for ${definition.repository}`);
  };
  // Validate mandatory mutation arguments before any API can perform a side effect.
  if (!dryRun && !["status", "inspect", "archive-inspect"].includes(action)) {
    head(v);
    if (action === "init") value(v, "operation");
    else if (action !== "import" && action !== "archive-recover") identity(v);
    if (actions.coordination[action].includes("confirm")) value(v, "confirm");
    if (["approve", "complete", "archive-approve"].includes(action)) value(v, "approved-by");
  }
  let result: any, manifest: FeatureManifest;
  if (action === "init") {
    manifest = decodeManifest({ value: parse(readFileSync(resolve(value(v, "file")), "utf8")) });
    if (manifest.featureId !== featureId) throw new Error("Manifest featureId differs from explicit feature ID");
    ensureRoots(manifest);
    const input = { manifest, ...inputs(c, manifest, v) };
    result = dryRun ? c.initPreview(input) : c.init({ ...input, expectedHead: head(v), operationId: value(v, "operation") });
  } else {
    manifest = c.store.readManifest({ revision: ["status", "inspect"].includes(action) ? optional(v, "revision") : undefined });
    ensureRoots(manifest);
    switch (action) {
      case "status": result = c.status({ revision: optional(v, "revision") }); break;
      case "inspect": {
        const kind = value(v, "kind");
        if (!["approval", "assignment", "submission", "event"].includes(kind)) throw new Error("--kind must be approval, assignment, submission, or event");
        const revision = optional(v, "revision"), snapshot = c.snapshot({ revision });
        const record = c.store.readRecord({ kind: kind as "approval" | "assignment" | "submission" | "event", id: value(v, "record"), revision: snapshot.head });
        if (!record) throw new Error("Record missing from inspected coordination history");
        result = { record, head: snapshot.head }; break;
      }
      case "approve": {
        const input = inputs(c, manifest, v);
        result = dryRun ? c.approvalPreview(input) : c.approve({ ...input, ...identity(v), token: value(v, "confirm"), approvedBy: value(v, "approved-by") }); break;
      }
      case "assign": {
        const input = { ...inputs(c, manifest, v), componentId: value(v, "component"), owner: value(v, "owner") };
        result = dryRun ? c.assignmentPreview(input) : c.assign({ ...input, ...identity(v), token: value(v, "confirm") }); break;
      }
      case "revoke": {
        const input = { assignmentId: value(v, "assignment"), reason: value(v, "reason") };
        result = dryRun ? { ...input, head: c.snapshot().head, assignment: c.store.readRecord({ kind: "assignment", id: input.assignmentId }) } : c.revoke({ ...input, ...identity(v) }); break;
      }
      case "import": {
        const bytes = readFileSync(resolve(value(v, "file"))), record = decodeRecord({ value: bytes.toString("utf8") });
        if (record.kind !== "submission" || record.featureId !== featureId) throw new Error("Import requires a submission receipt for the explicit feature");
        result = dryRun ? { record, bytes: bytes.toString("utf8"), head: c.snapshot().head } : c.importSubmission({ bytes, expectedHead: head(v) }); break;
      }
      case "accept": {
        const input = { submissionId: value(v, "submission") };
        result = dryRun ? c.acceptancePreview(input) : c.accept({ ...input, ...identity(v), token: value(v, "confirm") }); break;
      }
      case "review": {
        const stage = value(v, "stage");
        if (stage !== "combined" && stage !== "final") throw new Error("--stage must be combined or final");
        result = dryRun ? c.reviewPreview({ stage }) : c.recordReview({ stage, ...identity(v), token: value(v, "confirm"), review: file(v) }); break;
      }
      case "merge": case "accept-delivery": {
        const input = mergeInput(v);
        result = dryRun ? action === "merge" ? c.mergePreview(input) : c.deliveryAcceptancePreview(input) : action === "merge" ? c.recordMerge({ ...input, ...identity(v), token: value(v, "confirm") }) : c.acceptDelivery({ ...input, ...identity(v), token: value(v, "confirm"), review: file(v) }); break;
      }
      case "complete": {
        const input = v.file ? { archive: file<ArchiveScope>(v) } : {};
        result = dryRun ? c.completionPreview(input) : c.complete({ ...input, ...identity(v), token: value(v, "confirm"), approvedBy: value(v, "approved-by") }); break;
      }
      case "archive-approve": case "archive-prepare": {
        const input = { scope: file<ArchiveScope>(v) };
        if (dryRun) result = c.archivePreview(input);
        else if (action === "archive-approve") result = c.approveArchive({ ...input, ...identity(v), token: value(v, "confirm"), approvedBy: value(v, "approved-by") });
        else result = { records: c.prepareArchive({ ...input, ...identity(v), token: value(v, "confirm") }) };
        break;
      }
      case "archive-inspect": result = c.inspectArchivePreparation({ operationId: value(v, "operation") }); break;
      case "archive-recover": {
        const input = { operationId: value(v, "operation"), targetId: value(v, "target"), attestedBy: value(v, "attested-by") };
        if (dryRun) result = { ...input, receipt: c.inspectArchivePreparation(input), nextAction: "Inspect retained checkout and attest exact archive output before recovery; preview does not adopt output" };
        else {
          if (c.snapshot().head !== head(v)) throw new Error("Expected coordination head changed; inspect current status before local archive recovery");
          result = c.recoverArchivePreparation(input);
        }
        break;
      }
      case "archive-deliver": {
        const input = { preparedEventId: value(v, "prepared"), deliveryCommit: value(v, "delivery-commit") };
        result = dryRun ? c.archiveDeliveryPreview(input) : c.recordArchiveDelivery({ ...input, ...identity(v), token: value(v, "confirm") }); break;
      }
    }
  }
  const implementationRoots: Record<string, string> = {};
  for (const [id, definition] of Object.entries(manifest.components)) {
    const root = c.repositories[definition.repository];
    if (!root) throw new Error(`Explicit repository map missing for ${definition.repository}`);
    implementationRoots[id] = root;
  }
  return { ...result, ...envelope, implementationRoots, acceptance: action === "status" ? Object.fromEntries(Object.entries(result.components).map(([id, state]: [string, any]) => [id, { phase: state.phase, commit: state.acceptedCommit ?? null }])) : null,
    delivery: action === "status" ? Object.fromEntries(Object.entries(result.components).map(([id, state]: [string, any]) => [id, { branch: manifest.components[id].deliveryBranch, commit: state.deliveryCommit ?? null }])) : null,
    archive: result.archive ?? null, blocker: result.blocker ?? null, nextAction: result.nextAction ?? "Inspect coordination status for current blockers and next action" };
}
