# openspec-runner documentation

Start with the guide for the workflow you want to use.

| Guide | Audience | Availability |
|---|---|---|
| [User guide](user-guide.md) | People installing the runner and executing changes in one repository | Current CLI |
| [Team workflow](team-workflow.md) | Users, coordinators, and component owners | Roles, approval steps, process diagrams, and status explanations |
| [Team operator reference](team-workflow-reference.md) | Agents and operators running the CLI directly | Command sequences, checked schemas, Git handoffs, and detailed recovery |
| [Shared Store design](superpowers/specs/2026-10-04-store-linked-components-design.md) | People reviewing or implementing the team extension | Design for review |
| [Linked input builder](examples/linked-feature-inputs.mjs) | Coordinators preparing full manifest/settings/map/scope files | Checked by CLI integration tests |
| [Command reference](../README.md#cli-reference) | Users looking up current command syntax | Current CLI |
| [Configuration reference](../README.md#configuration) | Users configuring tasks, harnesses, checks, and local tooling | Current CLI |
| [Recovery reference](../README.md#recovery-and-plan-changes) | Users recovering an interrupted execution | Current CLI |

## Start here

1. Read the [workflow comparison](user-guide.md#choose-a-workflow).
2. [Install and initialize](user-guide.md#install-and-initialize) the runner in a target project.
3. Follow the [managed feature walkthrough](user-guide.md#run-a-managed-feature), or use
   [explicit unmanaged batches](user-guide.md#run-unmanaged-batches).
4. Read [reports and status](user-guide.md#read-status-and-results) before integrating results.
5. For shared Store mode, start with [roles and ownership](team-workflow.md#roles-and-ownership)
   and the [complete team walkthrough](team-workflow.md#complete-team-walkthrough).

## Diagram map

| What you want to understand | Diagram |
|---|---|
| Current managed feature SDLC | [User guide lifecycle](user-guide.md#managed-feature-sdlc) |
| Current task execution and integration | [Task loop](user-guide.md#task-execution-and-integration) |
| Where shared and local resources live | [Design repository and machine boundaries](superpowers/specs/2026-10-04-store-linked-components-design.md#repository-and-machine-boundaries) |
| Shared feature SDLC | [Team walkthrough](team-workflow.md#complete-team-walkthrough) |
| How people exchange assignments and results | [Team interaction](team-workflow.md#team-interaction) |
| Full team workflow, decisions, and repair loops | [Design detailed workflow](superpowers/specs/2026-10-04-store-linked-components-design.md#full-workflow-with-decision-and-recovery-points) |

## Terms that affect completion

| Term | Meaning |
|---|---|
| Task completed | A worker submitted an implementation result; integration may still be pending. |
| Task integrated | The local runner merged the result, passed checks, and updated its canonical checkbox. |
| Current managed feature completed | The runner reviewed and archived the feature on its retained integration branch. Delivery to the main branch is a separate action. |
| Component accepted | The coordinator accepted an exact component commit for the shared feature. |
| Component merged | The coordinator recorded the reviewed implementation on the declared delivery branch, with merge evidence. |
| Shared feature completed | Every required component PR merged, merged-component verification and review passed, and final approval was recorded. |
| Archive delivered | An archive result reached its canonical branch; a prepared archive branch is still pending delivery. |

For third-party behavior, consult the current [OpenSpec documentation](https://github.com/Fission-AI/OpenSpec/tree/main/docs).
Project-specific behavior is described in this repository's guides and design.
