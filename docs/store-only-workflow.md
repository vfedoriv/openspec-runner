# Store-only multi-repository workflow

Use ordinary `init` and repository-local `openspec/` when one code repository owns the feature. For a feature spanning code repositories, use a separate Store and a version-2 manifest. Existing version-1 linked features retain their original code-local component plans.

## Layout and ownership

```text
Store/
  openspec/runner.yaml
  openspec/changes/FEATURE/             shared proposal, design, tasks and specs
  components/api/openspec/runner.yaml
  components/api/openspec/changes/API_CHANGE/
  components/web/openspec/changes/WEB_CHANGE/
  components/worker/openspec/changes/WORKER_CHANGE/
  runner/features/FEATURE/              portable coordination records
  .openspec-runner/SCOPE/               excluded snapshots, reports and worktrees
API/, WEB/, WORKER/                     implementation and tests only
```

Each component project has its own `runner.yaml`, `execution.yaml`, changes and canonical specs. A manifest component's `repository` identifies its code repository; `planning.repository` identifies the Store, with `planning.openspecRoot: components/COMPONENT/openspec`. Git revisions for the Store plan and code base are independent.

Runtime is partitioned by feature, component and code-clone Git identity. Linked worktrees share that scope; independent clones do not. Code Git metadata contains worktree registrations and an opaque Store ownership ref, without planning files or runner configuration. Retire all active bindings before assigning the same code clone to another Store checkout.

## Prepare the Store

Register repository identities in Git config (or use their existing matching identities), for example `git -C STORE config openspec-runner.repository contracts` and `git -C API config openspec-runner.repository api`. Register `web` and `worker` similarly. Machine maps contain explicit identity-to-checkout paths and stay machine-local.

Generate checked starter inputs outside the repositories:

```sh
node docs/examples/linked-feature-inputs.mjs --planning-mode store \
  --store STORE --api API --web WEB --worker WORKER --model MODEL \
  --delivery-branch main --coordination-branch main --out INPUTS
openspec-runner init --store STORE --file INPUTS/manifest.json --json
```

This creates configuration only in the shared and declared component Store projects, preserving existing files. The example makes Web depend on accepted API work; Worker is independent. Select a model and effort supported by the chosen harness and replace the example's empty verification lists with real checks.

Author the shared OpenSpec change in the Store root and component changes in their respective Store projects. Generate component execution metadata from any code checkout:

```sh
openspec-runner init-execution API_CHANGE --store STORE --component api --dry-run --json
openspec-runner init-execution API_CHANGE --store STORE --component api --json
openspec-runner validate API_CHANGE --store STORE --component api --json
openspec-runner doctor --store STORE --component api --json
```

`planning-rules`, `models`, and `execution-settings` also accept `--store` and `--component`. Omit `--component` to select the shared Store project. Settings edits still require a matching preview token; commit changed planning inputs and obtain renewed coordinator approval. Do not edit a frozen assignment through worker commands.

## Approve, assign and execute

Initialize and approve with the existing coordination protocol, using the version-2 manifest:

```sh
openspec-runner coordination init FEATURE --store STORE --map INPUTS/map.json \
  --file INPUTS/manifest.json --expected-head STORE_SHA --operation init --json
openspec-runner coordination approve FEATURE --store STORE --map INPUTS/map.json --dry-run --json
```

Real snapshot mutations require the preview's `--confirm TOKEN`, current `--expected-head SHA`, fresh `--id` and `--operation`, and explicit consent where requested. Assign each component with `coordination assign ... --component api --owner OWNER`. A dependent assignment becomes available only at its declared accepted/merged upstream milestone.

The component owner inspects and imports the exact assignment:

```sh
openspec-runner component inspect FEATURE --store STORE --repository api \
  --component api --assignment ASSIGNMENT --owner OWNER --json
openspec-runner component import FEATURE --store STORE --repository api \
  --component api --assignment ASSIGNMENT --owner OWNER \
  --expected-head INSPECTED_HISTORY --confirm TOKEN --json
```

Run these from the API checkout or add `--root API`. Import seals pinned planning snapshots in the Store, creates a code integration worktree under the Store runtime, and binds the code clone to the assignment. No code-local `init` or skill installation is required. Workers receive absolute bundled skill paths and immutable context locations.

Execution commands use explicit scope:

```sh
openspec-runner status API_CHANGE --store STORE --feature FEATURE --component api --assignment ASSIGNMENT --json
openspec-runner launch API_CHANGE --tasks 1.1 --store STORE --feature FEATURE --component api --assignment ASSIGNMENT --dry-run --json
```

Retain these flags on launch, integration, recovery, cleanup, review and repair. Use the exact generated worker/begin/report commands. Callbacks require the assignment ID, so an old worker cannot report into its replacement. Implementers commit code and tests; integration records task evidence without editing `tasks.md` in code.

## Acceptance, delivery and archival

After integration and a successful supervised review without blocking findings, export with `component export FEATURE --store STORE --repository api --component api --change API_CHANGE --outcome completed ...`. Preview first with `--dry-run`; the real export requires the matching token, expected Store history, record IDs and a new receipt output path. Publish/retrieve code commits and receipt bytes explicitly.

Coordinator import preserves receipt bytes. Acceptance verifies the approved Store source, exact task coverage, baseline or worker/integration evidence, code ancestry and independent checks in a clean exact-code checkout. One Store commit records acceptance and updates that component's canonical task checkboxes. Local integration can be ahead of canonical acceptance. Checkbox-only progress and unrelated component edits do not invalidate approved fingerprints.

Execution checks current component inputs and the primary shared contract against approval before allowing work or callbacks. Custom artifact directory selections include newly committed files. Older v2 pins without selection roots retain their fingerprints, but additions anywhere in their component project require renewed approval. Task evidence requires distinct worker and integration commits with one attempt marker; planning and runtime artifacts are rejected throughout submitted and delivered code history, including files deleted before the final commit.

Use combined tuple review, component delivery evidence, final tuple review and explicit completion consent as in the [operator reference](team-workflow-reference.md). Normal, squash and rebase delivery retain the original accepted evidence; rewritten or changed delivered content still requires the existing exact-delivery review/check gates.

For v2 archive scope, `componentIds` selects component projects physically in the Store; `includeStore` selects the shared project. Always provide `storeDeliveryBranch` equal to the manifest's coordination branch, including component-only scopes. Archive consent binds Store bases separately from code delivery SHAs.

`archive-prepare` builds an ordered cumulative Store commit chain: sorted component IDs followed by the shared project. All receipts point to one prepared Store branch. Inspect the receipt and deliver its final commit/branch to the canonical Store branch once; that commit contains every earlier project's archive. Record archive delivery for each prepared event. Code branch heads stay unchanged. Interrupted commands retain their project checkouts for `archive-inspect` and explicit `archive-recover`; resume the original operation identity rather than rerunning an ambiguous command.

## Observe and migrate

`dashboard --store STORE --map INPUTS/map.json --once --json` discovers imported scopes for the mapped code clone. It reports Store planning and code execution separately, emits scoped actions and blocks visible planning drift. `summary API_CHANGE --store STORE --feature FEATURE --component api --assignment ASSIGNMENT --json` reads Store runtime evidence. Shared summaries reconstruct from synchronized Store records and retrieved code commits without worker runtime.

Keep version-1 active features on their original protocol. Migration requires idle execution, retirement of old bindings, moving planning/configuration into the chosen Store projects, a new v2 manifest/history and fresh approval/assignments. Do not rewrite historical records or reinterpret an active assignment in place.

## Coordinator runtime isolation and legacy journals

Version-2 coordinator journals and private checkouts live beneath the Store runtime at `coordination/features/<featureId>/<area>/<operationId>[/<componentId>]`. Journal names append `.json`. Acceptance, delivery checks, tuple reviews and archive preparation use this layout, including archive inspection and recovery. The Store-wide mutation lock still serializes canonical branch changes. Version-1 runtime paths remain unchanged.

A preexisting unscoped version-2 journal, such as `<Store runtime>/archive/<operationId>.json`, blocks a new scoped operation with a legacy-journal reconciliation diagnostic. This conservatively blocks even a different feature reusing that operation ID: an unscoped filename cannot prove ownership or whether an external command already ran. An existing scoped journal remains authoritative for its feature. Nothing is automatically adopted, moved, deleted or rerun.

To reconcile legacy state, stop the relevant coordinator operations and retain a backup of the journal and its recorded checkouts. Inspect the journal input, pinned preview, pending events, receipts and recorded checkout paths against the intended feature's committed Store records and Git objects. Establish ownership before explicitly relocating a journal into that feature's scoped area. Retain its recorded checkout paths and evidence consistently; archive receipts use those paths during inspection and recovery, while acceptance and review evidence must agree with the checkout paths selected by the coordinator. If checkout relocation is necessary, reconcile Git worktree registrations and all recorded paths explicitly before resuming. Preserve ambiguous command markers and use the existing inspection/attestation recovery procedure; relocating state does not authorize repeating an interrupted command. If ownership or command outcome cannot be established, retain the evidence and reconcile manually. Do not delete journals or rerun operations to clear the diagnostic.
