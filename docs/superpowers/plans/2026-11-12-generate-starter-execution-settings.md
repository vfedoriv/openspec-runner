# Generate starter execution settings

**Goal** Let a user with a numbered OpenSpec task list generate an editable `execution.yaml` with one command.

## Proposed behavior

```text
openspec-runner init-execution user-auth --dry-run
openspec-runner init-execution user-auth
openspec-runner validate user-auth --json
```

Run from anywhere inside the Git worktree after `openspec-runner init`. Read `openspec/runner.yaml` and `openspec/changes/<change>/tasks.md` from the worktree root. Generate version 2 YAML with the configured default agent, including Codex for a version 1 runner configuration. Include all numbered checkboxes in source order, including completed ones. Each task starts with an empty assignment, which inherits model and effort through the existing resolution rules, declares no dependencies, and leaves parallel execution off.

For a change with tasks `1.1` and `1.2` and a Codex default, the preview is:

```yaml
version: 2
agent: codex
tasks:
  "1.1": {}
  "1.2": {}
```

`--dry-run` prints the YAML to stdout without touching the worktree or runner state. The write command creates the file alongside `tasks.md`, prints its path and the next validation command, and fails with an actionable error if the destination already exists. A dry run can still show the template when an execution file exists. With `--json`, both modes return `{ change, path, agent, taskIds, yaml, created }`, with a repository-relative forward-slash path, task IDs as strings, and `created: false` in preview mode. Errors follow the CLI's existing stderr and exit-code conventions.

Use an explicit CLI command so the same workflow works for terminal users and planning sessions. Automatic creation during validation would make that command write files. A dashboard action would need a new write path in the dashboard. Keep the generated artifact limited to per-task execution settings. Managed role settings still come from the existing feature approval workflow.

## 1. Build and publish the starter YAML

**Files** `src/plan.ts`, `test/init-execution.test.mjs`

- [ ] Add fixture tests for version 1 Codex and version 2 with a different configured default agent. Include checked and unchecked tasks, CRLF, a fenced checkbox, and IDs such as `1.1` and `1.10`. Parse the output with `assignmentsFrom` and `executionAgentFrom`. Assert the exact ID strings and source order, default agent, empty assignments, and repeatable YAML.
- [ ] Extract the existing change-name and change-directory checks from `loadPlan` into a shared local helper. Add `initExecution(root: string, change: string, options: { dryRun: boolean }): StarterExecutionResult` with the fields defined above. Read and validate the inputs with `configFrom` and `tasksFrom`. Require regular, unredirected input files inside the repository. Give a missing `runner.yaml` diagnostic that points to `openspec-runner init`.
- [ ] Serialize the version 2 mapping using the existing YAML library. Generate and validate the full document before publication. Use `publishExclusive` from `src/platform-files.ts` for a complete, create-only write. Report a destination collision as an existing file to edit. Preview returns before publication. Both modes leave the source files, Git index, and runner state untouched.
- [ ] Test invalid change names, missing inputs, malformed or duplicate task IDs, a directory with no numbered checkboxes, redirected inputs, and an existing execution file. Verify each failure leaves existing content intact. Exercise competing creates against the same destination and assert exactly one success, valid final YAML, and no temporary files.
- [ ] Run `pnpm run build` and `node --test test/init-execution.test.mjs`.

## 2. Expose the command and document the workflow

**Files** `src/cli.ts`, `test/init-execution.test.mjs`, `README.md`

- [ ] Add CLI tests using the packaged entry point in a temporary Git repository. From a nested working directory, assert that the preview prints YAML, preview JSON includes `created: false`, creation JSON reports `created: true`, and the written bytes match the preview. Assert repeat creation exits nonzero with a readable error and preserves the file. Test help, missing or extra positional arguments, and unsupported flags.
- [ ] Register `init-execution <change> [--dry-run] [--json]` in help. Parse only the command's supported flags, find the root with `repository()`, and call `initExecution` before constructing a runner. Use the standard CLI JSON error handling. Render text preview as raw YAML and text creation as the path plus `openspec-runner validate <change> --json`. Generation requires no OpenSpec or harness subprocess.
- [ ] Add the command to the README command reference and the `execution.yaml` walkthrough. Show preview, create, edit, and validate. Explain how empty assignments resolve, that dependencies and parallelism are chosen during planning, and that managed approvals still require explicit role settings.
- [ ] Run `pnpm test`. In a disposable initialized project, compare `init-execution --dry-run --json` with the created file, edit a dependency, and verify `validate <change> --json` reports the resulting task assignments. Check that the write added only `execution.yaml`.
