# Git runs no repository hook or config program in a run, and nothing from another home runs by itself

- Date: 2026-11-18
- Status: accepted
- Supersedes: none. Narrows the G-SRT-11 note of docs/research/srt-dev-env.md 0.6 ("srt's fixed denies hold in the
  starting folder")
- Branch: fix/devenv-git-hooks (QA TC-4939, P0; security review of the first version)

- **Ask:** srt write-protects `.git/hooks` and `.git/config` only when `.git` exists as a run starts. In a project
  folder with no repository, member Erin's run could `git init` and plant `.git/hooks/pre-commit`; Alice's later
  `git commit` in her own run ran it with her access, and it wrote her persistent home. The tool text said "You cannot
  change .git/config or .git/hooks".
- **Rule 1, the environment of every run** (`server/src/devenv/srt/git-guard.ts` gitEnv, in `runEnv`):
  - Command-line git config (`GIT_CONFIG_COUNT`), which wins over a repository's own config, sets:
    `core.hooksPath=/dev/null` (no repository hook runs, at any depth, planted or not), `core.fsmonitor=false`, an
    empty `credential.helper`, no commit or tag signing, `protocol.ext.allow=never`, and `safe.bareRepository=explicit`
    (a bare repository planted in a folder is used only when a command names it).
  - `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR` and `GIT_ASKPASS` win over the same keys of a repository.
  - Nothing is read from the run's home that would run by itself: `GIT_CONFIG_GLOBAL=/dev/null`,
    `NPM_CONFIG_USERCONFIG=/dev/null`, `PIP_CONFIG_FILE=/dev/null`, `PYTHONNOUSERSITE=1`. srt runs commands with
    `bash -c` (no login or interactive shell), so no `.bashrc` or `.profile` is read.
  - These hold for every git of the run, also one called by its full path.
- **Rule 2, the git wrapper** (`gitWrapperSource`, written by the server at `<base>/devenv/bin/git`, first on every
  run's `PATH`, read-only in the run; the settings check refuses a run that could write it): on EVERY git call it asks
  the real git for the repository's own settings (`git config --list --show-scope --includes`, local and worktree
  scope: git's own parser, so one-line sections, includes, `.git` links, `gitdir:` files and named bare repositories
  are what git itself reads, with no depth limit), and the settings of its submodules (absorbed ones in the common
  dir's `modules/`, the others in their folders). A setting that names a program refuses the call (exit 128, "git was
  refused: …"): a filter, diff (`textconv`, `command`) or merge driver, `diff.external`, a difftool or mergetool
  `cmd`, `core.sshCommand`, `core.gitProxy`, `core.alternateRefsCommand`, a non-boolean `core.fsmonitor`, a remote's
  `uploadpack` / `receivepack`, `gpg.*`, a credential helper, a `!` alias, `submodule.*.update = !…`, a non-boolean
  `pager.*`, `interactive.diffFilter`, a trailer command, `sendemail.smtpServer`, browser and man commands. A setting
  written by another member's job after the run started is seen at the next call. Limits refuse: more than 200
  submodules or nesting past 8 levels stops the call.
- **Not covered by the wrapper, said plainly:** a command that calls git by its full path (`/usr/bin/git`) skips it;
  the real git must stay readable and runnable in the run for the wrapper to use it, so there is no sandbox-level way
  to force every call through it. Rule 1 still holds for such a call (no hooks, no global config, no implicit bare
  repository), but a filter or diff driver of the repository's config would run. A project file that calls git by
  path is project code (rule 4). git's own sub-processes (a recursing checkout) read submodules' settings without the
  wrapper, which checked them when the call started. A setting written between the wrapper's check and git's read of
  it (milliseconds) is not caught.
- **Rule 3, a project folder's runs have their own home** (`config.ts` projectHome): a person's runs that start in a
  team folder (a project chat) use `devenv/hp/<hash of person and folder>`, never the home of the person's own chats.
  Code of the project folder runs there on purpose (npm, make, python, a venv's `.pth`, written by any member), so
  what it leaves in that home (an npx or pip cache, a config file) never reaches the runs of the person's own chats,
  which see their own folder `users/<id>`. A shared chat's commands have a fresh home each (as before). These homes'
  caches are cleaned after CACHE_IDLE_DAYS idle (`system/devenv-clean.ts`).
- **Rule 4, project code:** `package.json` lifecycle scripts, a project `.npmrc`, Makefiles (and their includes),
  Python files of the project and a venv's `.pth` files run when a command runs `npm`, `make` or `python` there. That
  is running the project's code by intent; the project folder is shared among the people who may write it and the
  change window records who wrote what (G-SRT-11). Rule 3 keeps what it leaves from the person's other homes.
  `.envrc` (no direnv here) and `.vscode` tasks (no editor runs them) are out of scope.
- **Tests:** `tests/unit/dev-env-git-guard.test.ts` (the environment; each bypass of the first version, G5-G11, with
  real git: a one-line section, a `.git` link, a bare repository, `submodule.*.update`, `core.alternateRefsCommand`,
  an alias, a credential helper, an include, a repository twelve folders down, an absorbed submodule, a setting
  written after the start; the project home), `tests/unit/dev-env-command-access.test.ts` and
  `tests/unit/dev-env-srt.test.ts` (the run's PATH, settings and home), `tests/linux/srt-attack.ts` G1-G11 and H1-H2
  on real srt.
- **Version impact:** patch.
