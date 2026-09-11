# Repository Guidelines

## Project Availability

`openspec-runner` is a local-only project. Do not search the internet for project-specific documentation, source code, behavior, or architecture; inspect this repository and its local knowledge graph instead. Internet or external documentation lookup is appropriate only for third-party dependencies and tools used by the project.

## Project Structure & Module Organization

`src/` contains the TypeScript implementation. `cli.ts` parses commands, `runner.ts` coordinates task attempts and integration, `plan.ts` reads OpenSpec artifacts, and `system.ts`, `adapters.ts`, and `codex.ts` isolate external tooling. `bin/openspec-runner.js` is the executable entry point. TypeScript builds into `dist/`; treat it as generated output. Tests live in `test/*.test.mjs` and exercise the compiled modules. Reusable agent workflows are under `skills/`, while `README.md` and `OPENSPEC_PLANNER.md` describe user-facing operation and design.

## Build, Test, and Development Commands

- `npm ci` installs the exact locked dependency set. Node.js 22.13 or newer is required.
- `npm run build` runs `tsc`, emitting JavaScript and declarations into `dist/`.
- `npm test` builds first, then runs all tests with Node's built-in test runner.
- `npm pack --dry-run` verifies the package contents without publishing.
- `npm link` exposes the local `openspec-runner` command for manual testing.

Run `npm test` before submitting changes. For CLI work, also exercise the affected command with `--json` or `--dry-run` where supported.

## Coding Style & Naming Conventions

Follow the existing strict TypeScript and ESM style: two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Use `camelCase` for functions and variables, `PascalCase` for classes and interfaces, and descriptive lowercase filenames. Keep platform and process interactions in the adapter/system modules rather than scattering shell calls through coordination logic. There is no separate lint command; `npm run build` is the required static check.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `*.test.mjs` and write behavior-focused test names such as `test("manifest validates coverage...", ...)`. Prefer temporary repositories and fake executables for Git, Codex, Worktrunk, or Herdr scenarios. Cover success, recovery, and failure paths when changing persisted state or integration logic.

## Commit & Pull Request Guidelines

History currently contains only `create openspec-runner`; use short, imperative commit subjects that describe one coherent change. Pull requests should explain the triggering problem, resulting CLI behavior, and verification performed. Link relevant issues or OpenSpec changes. Include sample command/output for user-visible CLI changes and call out compatibility or state-migration effects.
