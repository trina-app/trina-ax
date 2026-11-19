# A git hook in a shared folder is never executable in another person's command

- Date: 2026-11-19
- Status: accepted
- Supersedes: none. Adds to [20261118-devenv-git-hooks.md](20261118-devenv-git-hooks.md) (its rule 1 alone did not hold)
- Branch: fix/git-hooks-bypass-shared (QA TC-5348, P1, qa.trina.app 0.5.18-dev fec2dbb)

- **Ask:** every run gets `core.hooksPath=/dev/null` from its environment (`GIT_CONFIG_COUNT`), and srt write-protects
  the top `.git/hooks` and `.git/config`. But a command line wins over the environment: in a shared project folder
  `git -c core.hooksPath=.git/hooks commit` ran the hook Erin had planted, inside Alice's run, with her access. The same
  for `GIT_CONFIG_COUNT/KEY/VALUE` set by the command, `--config-env`, `-c include.path=…`, a hooks folder in a
  sub-folder, `git -C` into another repository, a bare repository (`--git-dir`, or a push into it: its `pre-receive`),
  and `/usr/bin/git`, which skips the wrapper. A hook written in a repository made in the same command also stayed on
  the disk with its exec bit.
- **Rule: the guard is the exec bit on the disk, not git's settings.** git runs a hook only when the file is
  executable (Linux: it skips it with "hint: … ignored because it's not set as executable"; macOS: the ACL of the run
  folders makes `access` say yes, and the exec then fails with "cannot exec": no hook runs either way), whatever the
  settings name. So the server (`server/src/devenv/srt/hook-sweep.ts`, outside the sandbox) takes the exec bits of every
  file that git could run as a hook in every folder a run may write (the team folders of its view, a shared chat's work
  folder; not the run's own home and temp folder):
  - a file with a hook's name (the 28 names of githooks(5), any letter case: macOS folders ignore it) at any depth, in
    any folder, since `core.hooksPath` may name any folder; `.sample` files and other names keep their mode;
  - a link with a hook's name: its target, when that is in one of those folders (git follows the link); a link out of
    them (a system program) is left alone;
  - **before the run starts**: what earlier runs of anyone left there. The run does not start when the folders cannot
    be checked whole (more than 20 000 hook files, over 30 s, a folder that cannot be opened): fail closed;
  - **after the run ends**: what the run wrote, so a later run of another person, and a reader of that folder from
    another project, finds no executable hook. It does not hold up the command's answer.
  - Each file is opened without following a link (`O_NOFOLLOW`, `O_NONBLOCK`: a FIFO does not hang) and its real path
    and device and inode are checked to be inside the swept folders before `fchmod`, so a folder swapped for a link
    meanwhile never makes the server change a file outside them. `find -P` lists; when it cannot read a folder, a walk
    of our own opens it (a folder git can search but not list could hide a hook from `find` only).
- **What runs:** a hook the run writes itself keeps its bit until the run ends, so a person's own hooks may run in her
  own command (`git -c core.hooksPath=…`), as Claude Code would let them. An ordinary executable file (`build.sh`,
  `node_modules/.bin` targets, a venv's scripts) keeps its exec bit: running project code on purpose stays possible
  (rule 4 of the decision of 2026-11-18).
- **Other options, and why not:**
  - a git wrapper alone: `/usr/bin/git`, `git-core/git` and a copy of git skip it, and the command line wins over it;
  - a `noexec` mount of the shared project for runs of other people, or a Landlock execute rule: srt 0.0.81 has no
    `noexec` and blocks nested user namespaces (`--disable-userns`), so the command cannot be given one, and both
    would stop every executable of the folder (`node_modules/.bin`, `.venv/bin`, `./build.sh`): npm, Python venvs and
    build scripts of a shared project would no longer run;
  - masking each hooks folder empty in the run: `core.hooksPath` may name any folder, and a mask holds only what
    exists as the run starts;
  - a seccomp rule cannot see file names.
- **Not covered, said plainly:**
  - a command that runs a teammate's file by itself: `sh .git/hooks/pre-commit`, `chmod +x` it and then git, a
    `-c core.fsmonitor=./x`, `-c alias.x='!./x'` or `-c core.sshCommand=./x` that names the program on the command
    line. That is asking for the file to run, like `./build.sh`.
  - a hook written by another person's job or dev server that runs at the same moment as this command, in a folder
    the command then names as its hooks folder. Commands of one folder run one at a time (runner.ts withRootLock),
    jobs and dev servers do not. The window ends when that job ends (its sweep).
  - config hooks of a newer git (`hook.<name>.command`) run a command, not a file: a repository's setting is refused by
    the wrapper (rule 2 of the decision of 2026-11-18, now with `hook.command`); one on the command line is the
    command's own, as above.
  - a file with a hook's name that is not a hook (a script called `update`) loses its exec bit in a shared folder;
    `sh update` still runs it.
- **Other files that run by themselves, looked at (TC-5348):**
  - in scope and covered here: git hooks, also the ones a `pre-commit` (Python) or husky set-up installs: they are
    hook-named files in a hooks folder; `.pre-commit-config.yaml` itself runs only through such a hook or an asked-for
    `pre-commit run`.
  - project code by intent (rule 4 of 2026-11-18, unchanged): `package.json` scripts and a project `.npmrc` with
    `npm`, `setup.py` / `pyproject.toml` with `pip`, Makefiles with `make`, Python files next to an asked-for `python`.
    The command names the tool on the folder; Claude Code runs them the same way.
  - nothing runs them here: `.envrc` (no direnv), `.vscode/tasks.json` and `launch.json` (no editor), `.bashrc` and
    `.profile` of the folder (srt runs `bash -c`, no login or interactive shell, and HOME is the run's own).
- **Tests:** `tests/unit/dev-env-hook-sweep.test.ts` (each bypass with the real git by its full path: first the
  repro, the hook runs; then after the sweep it does not; every hook name, letter case, links in and out, a FIFO, an
  unlistable folder, the limits, a person's own hook in her command), `tests/unit/dev-env-command-access.test.ts` (the
  runner sweeps before a run and after it), `tests/linux/srt-attack.ts` G12-G21 on real srt (G1 and G16a: the hooks
  erin's command wrote have no exec bit once it ended; G21: her ordinary script and alice's own hook still run).
- **Version impact:** patch.
