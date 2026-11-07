# Repeatable Codex acceptance

Run these checks from a runner source checkout after `pnpm run build`. They use
the installed Codex and OpenSpec CLIs, Git, and a fresh repository under the
system temporary directory for each invocation. Use an explicit model your
Codex account can access. The archive and resume scenarios make authenticated
model requests. Each invocation prints the fixture path before work starts and
keeps the checkout and evidence for inspection.

```sh
node test/live/codex-acceptance.mjs credentials --model MODEL
node test/live/codex-acceptance.mjs resume --model MODEL
node test/live/codex-acceptance.mjs archive --model MODEL
```

| Scenario | Evidence required to pass |
| --- | --- |
| `credentials` | The supervised worker exits nonzero with an authentication error using a fresh Codex home and no inherited API keys. The attempt has no accepted report, integration is rejected, and the integration head stays at its base. |
| `resume` | An initial Codex turn supplies a real session ID. Runner attachment resolves that exact session and prints its interactive command. A non-interactive `codex exec resume` reports the same ID and recalls a unique token without seeing it again in the prompt. Both event streams are retained under the fixture's Git directory. |
| `archive` | Real implementation and review complete, the driver approves the exact disposable fixture snapshot, and OpenSpec synchronizes the specification and archives the change. The archive commit descends directly from the reviewed head, and a second archive call returns the same commit. |

For an interactive resume check, run the emitted `interactiveCommand` from the
fixture's `worktree` in a real terminal using the same authenticated Codex home.
Ask Codex to repeat the token from the first turn and compare it to the emitted
`expectedToken`. Record this observation separately from the automated resume
result.

Rerun the scenarios after changing a supported Codex or OpenSpec version.
Record the tool versions, scenario result, and retained fixture path. Use the
[historical acceptance record](LIVE_ACCEPTANCE_2026-11-04.md) for other harness
and backend combinations.

## Native Windows run on 2026-11-07

Codex 0.167.0, OpenSpec 1.15.0, and Git 2.51.1. The requested model was
`gpt-6-luna`. Fixture directories are relative to the Windows temporary directory.

| Scenario | Fixture | Result |
| --- | --- | --- |
| `credentials` | `runner-live-credentials-2zHcUP` | Codex reported HTTP 401 on the inference turn and exited 1. The runner rejected integration. |
| `resume` | `runner-live-resume-3Xwwye` | The same session ID and recalled token passed the automated check. The interactive command reached the folder-trust prompt. Interactive token recall remains unverified. |
| `archive` | `runner-live-archive-27sptG` | Implementation, review, final approval, specification synchronization, and strict post-archive validation passed. A second call reused archive commit `99f3b36e08a78240176e93d820210eedb527e341`. |
