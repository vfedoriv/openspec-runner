# Linux verification environment

Prepared in the existing WSL distribution `Ubuntu-22.04`, under Linux user `/home/vfedoriv`.

- Installed Linux Node.js **v22.23.3** from the official `nodejs.org` Linux x64 archive. Verified the archive against the release's official `SHASUMS256.txt` before extraction.
- Installed Linux pnpm **11.7.0** using that Node runtime.
- Upgraded system Linux Git to **2.55.0**, with `git-man`, using the signed `git-core` Ubuntu PPA recommended by [Git's official Linux installation guidance](https://git-scm.com/install/linux). No unrelated packages were installed or upgraded. Windows Git was unchanged.
- Existing Bash, curl, and `script` from util-linux **2.37.2** are available.

Node executable: `/home/vfedoriv/.local/share/openspec-runner-runtime/node-v22.23.3-linux-x64/bin/node`.

pnpm executable: `/home/vfedoriv/.local/share/openspec-runner-runtime/pnpm/bin/pnpm`.

For each noninteractive WSL command, source the saved environment first:

```powershell
wsl.exe -d Ubuntu-22.04 -- bash -lc 'source /home/vfedoriv/.local/share/openspec-runner-runtime/env.sh; cd /mnt/c/Users/vital/.codex/worktrees/console-dashboard/openspec-runner; pnpm test'
```

The primary checkout is `/mnt/e/workspace/openspec-runner`. The environment file prepends the Linux Node and pnpm directories to PATH; no shell profiles were changed. Git is selected from `/usr/bin/git`.

Verified `node --version`, Linux `process.platform` and executable path, `pnpm --version`, `git --version`, and `script --version`. The preexisting Windows pnpm wrapper executes `pnpm.exe`, so verification must use the user-local Linux pnpm above.

Claude/OpenSpec binaries and credentials have not been installed. Cross-platform package dependencies may require a separate Linux dependency installation before testing.

The dashboard worktree's `.git` points to Windows `E:/workspace/...` metadata. Use native Windows Git for that worktree's commits; do not rewrite `.git` or globally set `GIT_DIR`/`GIT_WORK_TREE`. Linux pnpm can run the source, and tests can create normal Linux temporary Git repositories.

## Baseline blocker resolved

The targeted component test `import into independent clone freezes execution` originally failed before any dashboard source change because Ubuntu's Git 2.34.1 rejected `git worktree list --porcelain -z`. The project calls this at `src/adapters.ts:40`; the stack continued through `createWorktree`, `Feature.bindAssignment`, and `Component.import`. Running that Git command independently reproduced `error: unknown switch 'z'`. Git 2.36 introduced the required option.

The reproduction selected the installed Linux Node and pnpm, `/usr/bin/git`, `/usr/bin/bash`, and `/usr/bin/script`. `TMPDIR`, `TMP`, and `TEMP` are unset; Node uses `/tmp`, whose permissions are the expected `1777`. `GIT_DIR` and `GIT_WORK_TREE` are also unset. No temporary-directory correction was required.

After the approved Git upgrade, an isolated `/tmp` Git repository successfully emitted NUL-delimited worktree output, and the previously failing component test passed (1 test, 0 failures). The full baseline `pnpm test` in the dashboard worktree then exited **0**: **208 tests, 206 passed, 0 failed, 2 skipped**, duration **112.842 seconds**. No product source changes were needed.

Complete baseline output is saved in ignored worktree scratch storage: `node_modules/.cache/console-dashboard/baseline.log`.

APT verified signed repository metadata and package hashes; the imported Git PPA signing-key fingerprint is `F911AB184317630C59970973E363C90F8F1B6217`. Installed package version: `1:2.55.0-0ppa1~ubuntu22.04.2`.

## Linux filesystem benchmark

Captured unchanged baseline source/config/tests in `/tmp/openspec-dashboard-verification-vKRYjJn5` before implementation began, excluding `.git`, `node_modules`, `dist`, and `.superpowers`. Installed the existing lock with `pnpm install --frozen-lockfile` (0.989 seconds), then ran `pnpm test`.

The Linux mirror exited **0** with the same **208 tests, 206 passed, 0 failed, 2 skipped**. Test-runner duration was **72.060 seconds**, compared with **112.842 seconds** on the mounted Windows worktree: approximately **36% less time** in this single comparison. Full build-and-test wall time in the mirror was **74 seconds**. Timing varies with system load.

The mirror's complete original baseline logs are `/tmp/openspec-dashboard-verification-vKRYjJn5/baseline.log` and `install.log`. A reusable controller helper lives in ignored worktree storage and refreshes all fixed source directories and root configuration before testing:

```powershell
wsl.exe -d Ubuntu-22.04 -- bash /mnt/c/Users/vital/.codex/worktrees/console-dashboard/openspec-runner/.superpowers/sdd/console-dashboard-plan/verify-linux-mirror.sh
```

Always invoke this helper for current worktree verification; do not run tests directly against a potentially stale mirror. It retains Linux `node_modules`, copies the current package manifest and lock, and runs `pnpm install --frozen-lockfile` every time, including after UI dependency changes. It validates the exact resolved disposable mirror path before replacing only six fixed source directories; it does not change the source worktree or its Git metadata. Subsequent full output is written to the mirror's `verification.log`, preserving the original baseline log. The helper's Bash syntax was checked; its next full run will verify the refreshed implementation. `/tmp` may be cleared after a reboot, in which case the mirror must be recreated before using the helper.
