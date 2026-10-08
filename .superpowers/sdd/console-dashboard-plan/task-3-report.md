# Task 3 report: activity normalization and bounded pages

Status: DONE

## RED

Added the four behavior-focused tests before production code, then ran:

\`wsl -d Ubuntu-22.04 -- bash -lc 'source /home/vfedoriv/.local/share/openspec-runner-runtime/env.sh; cd /mnt/c/Users/vital/.codex/worktrees/console-dashboard/openspec-runner; pnpm run build && node --test test/activity.test.mjs'\`

The build succeeded. All four tests failed on the expected missing activity decoder and page-reader exports.

## GREEN and full verification

The focused command above passed after implementation: 4 tests, 4 passed, 0 failed.

Final full verification used the repository mirror helper:

\`wsl -d Ubuntu-22.04 -- bash /mnt/c/Users/vital/.codex/worktrees/console-dashboard/openspec-runner/.superpowers/sdd/console-dashboard-plan/verify-linux-mirror.sh\`

It exited 0: 251 tests, 249 passed, 0 failed, 2 skipped; test-runner duration 71.294 seconds. The two skipped tests are the repository’s existing skips.

The Task 3 handoff recorded a 247-test baseline (245 passed, 0 failed, 2 skipped). The environment report also records its earlier 208-test pre-dashboard baseline (206 passed, 0 failed, 2 skipped).

## Implemented bounds and behavior

- Exported the exact named \`ActivityPageOptions\` contract and the activity entry, page, identity, and decoder types.
- Added tolerant Codex and Claude normalization. Complete Claude text and tool blocks are emitted with tool IDs; correlation retains at most the latest 1,000 outstanding IDs. Token delta events are omitted. Unknown or malformed records remain visible as raw or diagnostic activity.
- The decoder keeps independent stdout and stderr byte buffers, preserves split UTF-8 records, flushes a final unterminated record, strips terminal control sequences, and caps each buffered record at 64 KiB. Oversized records produce a diagnostic and are dropped through the next newline.
- The reader uses positional reads and caps each page at 200 entries and 256 KiB of file reads, including the small identity-prefix reads. It reads the supplied sidecar first, then the fixed \`.1\` and \`.2\` rotations, and falls back to the supplied legacy log when no sidecar exists.
- Sidecar entry IDs are preserved. Legacy IDs derive from file identity and byte offset; legacy entries do not receive invented timestamps.
- Opaque cursors carry file identity and offsets, preserve both page boundaries for older and newer navigation, bind to the supplied log/sidecar and activity identity, and restart when the source is replaced or truncated. Cursor contents never supply filesystem paths.

## Coverage and self-review

The tests cover Codex messages, commands, file changes and turn outcomes; malformed and unknown events; complete Claude tool correlation, eviction and omitted deltas; split Unicode, stream interleaving, hostile controls, final partial records and oversized recovery; legacy timestamp behavior; sidecar priority and rotations; older/newer paging without gaps or duplicate IDs; the 200-entry and 256 KiB limits; missing logs; truncation/replacement reset; and rejection of a cursor reused with another source.

Self-review confirmed the three new source files are isolated from the existing strict Claude identity decoder and do not write runner state or treat turn activity as lifecycle authority. Only the four assigned implementation/test files and this report are staged; the unrelated plan modification remains unstaged.
