# Delivery summaries and presentations

The runner automatically saves a basic summary after task integration, satisfaction
of an unmanaged batch, managed feature completion, completed component receipt
export, and shared feature completion. A coordinating agent then uses the installed
`openspec-runner-summarize` skill to add a narrative. Direct CLI use produces basic
output without starting an AI session. An unavailable narrative remains pending.

## Read, regenerate, and export

```sh
openspec-runner summary my-change
openspec-runner summary my-change --task 1.1 --json
openspec-runner summary my-change --refresh --json
openspec-runner summary my-change --export ./feature-summary --json
openspec-runner coordination summary my-feature --store ./contracts --map ./repositories.json --json
```

Reads and dashboard inspection do not generate artifacts or execute checks.
`--refresh` creates/reuses the basic artifact without calling a model. Export
requires an existing artifact and a new destination directory. Shared commands
support the same modes; narrative publication uses `--publish` on the shared
command instead of the local `summary publish CHANGE` spelling.

Summaries are stored under the Git common directory's
`openspec-runner/summaries/<subject-key>/<source-digest>/`. They survive ordinary
task cleanup and remain local unless explicitly exported. Export includes Markdown,
portable evidence and provenance; known repository/runtime path aliases are removed.
Review free text before external sharing: export is not a general secret detector.
If output writing fails partway, the destination can be incomplete; select a new
directory when retrying and inspect the previous output before deleting it.

Each snapshot identifies exact result revisions and evidence gaps. Worker-reported
checks remain distinguishable from runner/Store evidence. Missing history or check
logs do not become invented verification. New source evidence creates a new digest;
older snapshots remain saved. Shared summaries can be rebuilt from locally available
Store history in another clone, with missing per-task runtime details labeled.

Completion meanings remain distinct:

| Summary | Meaning |
|---|---|
| Task | Integrated into the integration branch |
| Unmanaged change | Planned batch satisfied; no managed final review implied |
| Managed feature | Reviewed, verified, archived on its integration branch; delivery separate |
| Component | Handoff ready; coordinator acceptance/delivery may be pending |
| Shared feature | Reviewed merged tuple completed with consent; archival can remain pending |

## Narrative enrichment

`init --agent codex`, `init --agent claude`, or `init --agent all` installs the
summarize/present skills alongside existing workflows. Rerun init in existing
projects to update installed skills; it preserves an existing runner configuration.
Coordinating agents enrich completed feature/batch/handoff summaries automatically.
Individual tasks reuse worker prose rather than requiring another writing session.

The narrative schema is version 1, with `sourceDigest` and six section arrays:
`problem`, `behavior`, `implementation`, `verification`, `limitations`, `delivery`.
Claims contain `text` and `evidenceIds` from the bundle's fact IDs. Expected benefits
can add `expectedBenefit: true`; measured impact must have supporting evidence.
Implementation, verification and delivery claims require evidence IDs.

```sh
openspec-runner summary publish my-change --source DIGEST --file narrative.json --json
```

Files are limited to 1 MiB. Stale digests and unknown evidence IDs are rejected.
Replacing a selected narrative requires inspection and `--expected-revision HASH`,
the content hash in its filename. Direct edits to selected narrative files are
detected as conflicts and preserved; regenerate into a new revision after review.
The basic artifact is retained independently of prose.

## Slides on request

Ask the coordinating agent to use `openspec-runner-present` with the summary and
audience. The skill prepares a brief, reviews the outline with you, then hands it
to an explicitly configured installed presentation skill. No provider is bundled.
[Frontend Slides](https://github.com/zarazhangrui/frontend-slides) is the first
documented target, using its core skill for supported coding agents.

```sh
openspec-runner summary my-change --presentation-brief ./demo-brief \
  --audience "Product stakeholders" --provider-config ./slides-provider.json --json
```

Provider configuration is local JSON:

```json
{ "skillPath": "./installed-frontend-slides/SKILL.md", "version": "your-installed-revision" }
```

Paths resolve relative to the configuration file. Optional `--assets FILE` reads a
JSON array of user-selected asset paths without copying them or taking screenshots.
With no readable provider, the command still saves a brief and setup information.
The command never invokes a provider itself; the requesting agent follows the
provider skill. Default outline length is five to seven slides. HTML is the initial
format; PDF depends on available provider export tools. Provider version and source
digest belong beside the deck. Installation, publication/hosting and screenshots
require separate requests; feature completion never performs them.

Summary/prose/provider failures do not roll back integration, completion or receipt
export. Inspect warnings and retry only the failed summary/presentation work.
