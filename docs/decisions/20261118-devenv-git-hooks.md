# Git runs no repository hook or config program in a run, and nothing from the run's home runs by itself

- Date: 2026-11-18
- Status: accepted
- Supersedes: none. Narrows the G-SRT-11 note of docs/research/srt-dev-env.md 0.6 ("srt's fixed denies hold in the
  starting folder")
- Branch: fix/devenv-git-hooks (QA TC-4939, P0)

- **Ask:** srt write-protects `.git/hooks` and `.git/config` only when `.git` exists as a run starts. In a project
  folder with no repository, member Erin's run could `git init` and plant `.git/hooks/pre-commit`; Alice's later
  `git commit` in her own run ran it with her access, and it wrote her persistent home. The tool text said "You cannot
  change .git/config or .git/hooks".
- **Rule, the environment of every run** (`server/src/devenv/srt/git-guard.ts` gitEnv, in `runEnv`): command-line git
  config (`GIT_CONFIG_COUNT`, which wins over a repository's own) sets `core.hooksPath=/dev/null` (no repository hook
  runs, at any depth, planted or not), `core.fsmonitor=false`, an empty `credential.helper` (a repository's helpers are
  dropped), no commit or tag signing and `protocol.ext.allow=never`; `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`
  and `GIT_ASKPASS` win over the same keys of a repository. Nothing is read from the run's home that would run by
  itself: `GIT_CONFIG_GLOBAL=/dev/null`, `NPM_CONFIG_USERCONFIG=/dev/null`, `PIP_CONFIG_FILE=/dev/null`,
  `PYTHONNOUSERSITE=1` (no usercustomize or `.pth` from the home). srt runs commands with `bash -c` (not a login or an
  interactive shell), so no `.bashrc` or `.profile` of the home is read either. So a file a run writes into its home
  is never run by a later run on its own.
- **Rule, a repository config that names a program** (`gitConfigProblems`, before every run, private and shared): a
  repository in the run's folder (to 8 levels, not in `node_modules` or a virtualenv, through a `.git` file's
  `gitdir:` and a worktree's `commondir`) or above it up to the team folder whose config has a filter, diff or merge
  driver, a `diff.external`, an include, `core.sshCommand`, `core.gitProxy`, a remote's `uploadpack` / `receivepack`, a
  `gpg` section or a "!" alias stops the run. The AI is told which repository and what (in a shared chat without the
  names); someone who can open the folder removes the lines in Files (a command cannot change `.git/config`). Fail
  closed: a member could make runs in that folder stop; the change window and the audit name who wrote it.
- **Checked, and decided:**
  - `.git/hooks`, `.git/config`, `core.hooksPath`, `core.fsmonitor`, credential helpers, pager/editor/askpass: fixed
    (environment).
  - `.gitattributes` and `.git/info/attributes` filters / diff / merge drivers, config includes: they run only with a
    driver defined in config: fixed (the run stops).
  - Global git config, `~/.npmrc`, pip config, Python user site in the run's home: fixed (not read).
  - Shell startup files in the home: not read (`bash -c`).
  - `package.json` lifecycle scripts, a project `.npmrc`, Makefiles (and their includes), Python files of the
    project, `.envrc` (no direnv here): out of scope, documented. A command that runs `npm install`, `make` or
    `python` runs the project's code by intent; the project folder is shared among the people who may write it, and
    the change window records who wrote what (G-SRT-11). The AI is the one who decides to run them.
  - `.vscode` tasks: no editor runs them here; out of scope.
- **Left as is:** a command can still pass its own `git -c core.hooksPath=…` (a prompt injection would have to tell
  the AI to); nested repositories past 8 levels or past 50,000 entries are not looked at.
- **Tests:** `tests/unit/dev-env-git-guard.test.ts` (a planted hook runs with plain git and not with a run's
  environment, a planted `~/.gitconfig` is not read, what counts as a program, where repositories are found),
  `tests/unit/dev-env-command-access.test.ts` (a planted filter stops a run, the run's git settings),
  `tests/linux/srt-attack.ts` G1-G4 on real srt (the tester's repro: Erin plants a hook, Alice commits, nothing runs or
  lands in her home; a planted filter stops Alice's run; a repository made in a sub-folder runs no hook).
- **Version impact:** patch.
