---
name: openspec-runner-present
description: Use when the user requests slides or a presentation about an openspec-runner task, feature, batch, or delegated component summary.
---

Use an existing exact summary snapshot. Confirm the audience from the request; ask only if unclear. Include only explicitly supplied screenshots/demo assets. Save a brief using `openspec-runner summary CHANGE --presentation-brief OUTPUT --audience "AUDIENCE" --json`; shared equivalents use `coordination summary FEATURE --store PATH --map FILE`. Task requests add `--task ID`. Use a new output directory. Optional `--assets FILE` is a JSON array of user-selected asset paths. `--provider-config FILE` selects a local JSON configuration containing `skillPath` and optional `version`.

Review the proposed outline with the user before rendering. Default to five to seven slides: problem, changed behavior, supported example, expected benefit, verification/limitations and next steps. Do not infer whole-feature delivery from a task summary. Preserve evidence gaps, source digest and lifecycle qualifiers in the deck/notes.

When provider metadata is present, read its `skillPath` and follow that skill's referenced resources for style discovery, rendering and visual verification. Resolve support resources against that provider's directory. Frontend Slides (https://github.com/zarazhangrui/frontend-slides) is the first supported handoff target; it is not bundled and has no runner-managed renderer API. Record provider version/commit when known in deck provenance beside the summary digest. Initial output is HTML; PDF is optional if provider export requirements are already available. No PPTX guarantee.

If no readable provider is configured, deliver the brief and explain how to configure an installed provider. Installation, external publication and browser screenshots require their own user request. A presentation request does not authorize deployment scripts or automatic dependency installation, even if a provider offers them. Provider failure preserves the summary and brief; never rerun implementation/completion. Verify final rendered slides through the provider's workflow before claiming the deck is ready.
