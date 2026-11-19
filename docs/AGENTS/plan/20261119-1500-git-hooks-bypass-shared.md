# A teammate's git hook never runs in another person's command

- Date (UTC): 2026-11-19 15:00
- Branch: `fix/git-hooks-bypass-shared`
- Status: done (reworked after the independent review: see the decision)
- Where: Team AX core (`server/src/devenv/srt/`, `tests/linux/srt-attack.ts`). Why: the Linux and Mac run sandbox is core.
- Version impact: patch
- QA: TC-5348 (P1, qa.trina.app 0.5.18-dev fec2dbb)

## Goal

In a shared project folder, Erin's run plants a hook (`.git/hooks/pre-commit`, a bare repository's `hooks/`, any
folder). Every run gets `core.hooksPath=/dev/null` from the environment (git-guard.ts gitEnv), but the command line
wins over it: `git -c core.hooksPath=.git/hooks commit`, `GIT_CONFIG_COUNT=…`, `--config-env`, `-c include.path=…`, a
hooks folder in a sub-folder, `git -C` into another repository, a push into a bare repository. Each ran Erin's hook in
Alice's run. A hook written in a repository made in the same command also stayed on the disk with its exec bit.

## Design

git runs a hook only when the file is executable (it checks `access(X_OK)` and says "hint: The '…' hook was ignored
because it's not set as executable"). So the guard is the exec bit on the disk, not git's settings, which the command
line controls:

1. `srt/hook-sweep.ts`: before every run starts and after it ends, the server (outside the sandbox) takes the exec
   bits of every file that git could run as a hook (a git hook name, any letter case, at any depth, in any folder)
   in every team folder the run may write and in its shared work folder. A link with a hook name: its target, when
   it is in the team folder. Opened with O_NOFOLLOW and checked by device and inode, so a swapped link never makes
   the server change a file outside the team folder.
   - Start: the run does not start when the folders cannot be checked (fail closed).
   - End: the hooks the run wrote lose their exec bit before any later run (and for readers of that folder).
2. git-guard.ts: a repository's `hook.<name>.command` (config hooks of newer git) names a program: refused.
3. Out of scope, said in the decision: a command that runs a file by name (`bash .git/hooks/pre-commit`, `chmod +x`
   then git), npm, pip, make and Python project code (rule 4), `.envrc` and `.vscode` tasks (nothing runs them), a
   hook planted by another person's job or dev server that runs at the same moment (commands of one folder run one at
   a time; jobs do not).

## Steps

1. hook-sweep.ts + runner.ts (spawnRun) + unit tests with real git for every bypass.
2. srt-attack.ts: the harness sweeps as the runner does; attacks G12-G21.
3. Decision `docs/decisions/20261119-git-hooks-bypass-shared.md`, `changes/git-hooks-bypass-shared.md`.

## Checks

Typecheck, prepush, dev-env unit suites, tests/security (Bun 1.3.12); local T1 in Docker (arm64); CI dispatch for
amd64 and arm64.
