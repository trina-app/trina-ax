# A git hook in a shared folder is never executable in another person's command

- Date: 2026-11-19
- Status: accepted
- Supersedes: none. Adds to [20261118-devenv-git-hooks.md](20261118-devenv-git-hooks.md) (its rule 1 alone did not hold)
- Branch: fix/git-hooks-bypass-shared (QA TC-5348, P1, qa.trina.app 0.5.18-dev fec2dbb; independent review of #46)

- **Ask:** every run gets `core.hooksPath=/dev/null` from its environment (`GIT_CONFIG_COUNT`), and srt write-protects
  the top `.git/hooks` and `.git/config`. But a command line wins over the environment: in a shared project folder
  `git -c core.hooksPath=.git/hooks commit` ran the hook Erin had planted, inside Alice's run, with her access. The same
  for `GIT_CONFIG_COUNT/KEY/VALUE` set by the command, `--config-env`, `-c include.path=…`, a hooks folder in a
  sub-folder, `git -C` into another repository, a bare repository (`--git-dir`, or a push into it: its `pre-receive`),
  and `/usr/bin/git`, which skips the wrapper. A hook written in a repository made in the same command also stayed on
  the disk with its exec bit.

## First choice asked for: a git wrapper no command can go around. Not doable on srt

The coordinator's first layer was the wrapper bound read-only over every git binary in the sandbox, so the real git is
reached only through it. On srt 0.0.81 that cannot be made to hold:

- srt's settings have `denyRead`, `allowRead`, `allowWrite`, `denyWrite` and `allowGitConfig` only
  (`sandbox-config.js` FilesystemConfigSchema). Linux binds each path onto itself, a denied file gets `/dev/null`
  (`linux-sandbox-utils.js`); there is no bind of one file over another path. (The masked-file binds are srt's
  credential masking, which rewrites secrets in text files; not a way to put another program in place.)
- Even with such a bind the wrapper must run the real git, so the real git must be executable in the same sandbox, by
  the same account: whatever path the wrapper execs, the command can exec (its path is in the wrapper's source, which
  the command can read). On Debian 13 `/usr/lib/git-core` has 149 executable entry points (`git-receive-pack`,
  `git-upload-pack`, … are links to `git`); hiding all of them breaks git's own scripted commands, which run `git`
  from that folder.
- The command cannot change its own mounts: srt refuses nested user namespaces (its seccomp helper, or bubblewrap
  `--disable-userns`, `SRT_ALLOW_NESTED_USERNS=0`), so no first line can remount or hide anything after srt.
- A run may also bring its own git (a static build from the network, `pip install dulwich`).

The only design that would make it hold is a git run outside the command's sandbox (the wrapper sends argv, stdio
and cwd to the server, which runs git in a second sandbox of the same person with git visible only there) while git
is hidden from every run. That is a project of its own (stdio and signals over a socket, a second srt start per git
call, ~0.3 s each); not in this change.

So the wrapper stays what it was (rule 2 of 2026-11-18: it refuses a repository's settings that run a program, now also
`hook.<name>.command`), and the guard for hooks is the file's exec bit, which no command line can change for git.

## Rule: the exec bit on the disk

git runs a hook only when the file is executable (Linux: skipped with "hint: … ignored because it's not set as
executable"; macOS: the ACL of the run folders makes `access` say yes, then the exec fails with "cannot exec": no hook
runs either way), whatever the settings name. `server/src/devenv/srt/hook-sweep.ts` (on the server, outside the
sandbox) takes the exec bits of every file git could run as a hook:

- **What is a hook:** an executable file git would open by one of the 28 hook names of githooks(5): the name in any
  ASCII letter case, and on macOS any other name APFS resolves a hook's name to (`pre-puſh` is opened as `pre-push`):
  such a file (every executable non-ASCII name) is checked by looking each hook's name up in its folder, as git does.
  Only executable files are counted, so many empty `update` files cost nothing and fail nothing (review V4).
- **A hook-named link:** its target loses the bit only when the target is a file the person may read (a run: its
  view, without personal folders; a Files move: the mover's own folder rules): another person's folder, a hidden
  sub-folder or project, or a system program is never changed (review V2, N1). A sweep with no person's view (the
  one at server start, the one for a run tracked again after a restart) follows no link (N2).
  A husky-style link to `scripts/lint.sh` takes that script's bit; `sh scripts/lint.sh` still runs it (review V8,
  kept: with no unavoidable wrapper, the link is a way to run the script as a hook).
- **A file with more than one name** (a hard link, possibly to a file outside the team folder on macOS): the hook's
  name gets a copy of its own without the exec bit; the other name keeps its mode (review V3). Node has no `openat`,
  so the copy is made by path: its folder is checked by device, inode and real path before and after, and a change
  stops it (the copy is removed). The macOS `lchmod` fallback checks its folder the same way.
- **How:** Linux: an `O_PATH|O_NOFOLLOW` descriptor and chmod through `/proc/self/fd`, so an exec-only (0111) file is
  changed too (review V1); macOS: the descriptor, else `lchmod`. Each is checked by device and inode first; paths are
  resolved by hand (lstat, readlink; nothing opened). A hook that is still executable after that fails the sweep.
- **Where and when:**
  - before a run starts: the folders it may write, and the folders other people's live runs may write that it may
    read (`runner.ts` liveSweeps: a job or dev server may write a hook there after its last sweep; review V6, R2b).
    The run does not start when they cannot be checked in 30 s or a hook cannot be made safe (fail closed);
  - after a run ends: the folders it may write (not holding up its answer);
  - when the server starts (`reconcile`): after leftover units are stopped, the whole team folder once, in the
    background, for runs that were live during a restart; runs that live on (open `dev_env_runs` rows) are tracked
    again as other people's live runs, and when their row ends their folders get the sweep after the run (N4);
  - when Files moves, copies or restores an entry (`team-files/service.ts` hookSafe): that entry, all of a folder
    (a rename keeps a file's mode: review V6, R2), listed by `find` off the request (N3); a sweep that fails is tried
    once more with a longer limit, then left to the server's next start.
  - `find -P` lists (only executable files and links); when it cannot list a folder, a walk of our own looks the hook
    names up in it and lists it with a read bit given for that moment, through the folder itself, then put back
    (review V9).
- **What runs:** a hook the run writes itself keeps its bit until the run ends, so a person's own hooks may run in her
  own command (`git -c core.hooksPath=…`), as Claude Code would let them. Ordinary executables (`build.sh`,
  `node_modules/.bin` targets, venv scripts) keep their bit. A person's own hooks lose the bit at the start of her
  next command too (review 6b): the sweep cannot tell her file from another person's, and the default
  `core.hooksPath=/dev/null` runs none anyway.

## Not covered, said plainly

- **TC-5366** (repository settings that run a program, through `/usr/bin/git`): a check of every git `config` before
  a run, refusing the run, was looked at and left for its own change. It is not small: the folders a run may *read*
  matter too (`git -C`), `include.path` and `includeIf` must be followed as git does, and a refusal of every command in
  a folder that holds a git-lfs repository (`filter.lfs.*`, common and legitimate) needs a decision of its own.

- **git by its full path and a repository's settings** (review V7/finding 9, there before this change): `/usr/bin/git`
  skips the wrapper, so a filter, diff or merge driver, `core.sshCommand` or `gpg.program` in a repository a teammate
  made in a sub-folder runs in Alice's `/usr/bin/git add`. See the first section: no same-account sandbox can force
  the wrapper. git on PATH (what the AI, npm, make and editors run) is refused.
- A command that runs a teammate's file by itself: `sh .git/hooks/pre-commit`, `chmod +x` it and then git, a
  `-c core.fsmonitor=./x`, `-c alias.x='!./x'` or `-c core.sshCommand=./x` that names the program on the command line.
- A hook written by another person's live job or dev server **during** this command (after its start sweep): the
  next command of the folder sweeps it. Commands of one folder run one at a time (runner.ts withRootLock).
- Between a server restart and the end of its first sweep of the team folder, a hook left by a run that was live at
  the restart, in a folder the next run only reads.
- Linux folders with case-folding (`chattr +F`) are not looked up as on macOS (none on the servers).

## Other files that run by themselves (TC-5348)

- In scope and covered here: git hooks, also the ones a `pre-commit` (Python) or husky set-up installs.
- Project code by intent (rule 4 of 2026-11-18, unchanged): `package.json` scripts and a project `.npmrc` with `npm`,
  `setup.py` / `pyproject.toml` with `pip`, Makefiles with `make`, Python files next to an asked-for `python`.
- Nothing runs them here: `.envrc` (no direnv), `.vscode/tasks.json` and `launch.json` (no editor), `.bashrc` and
  `.profile` of the folder (srt runs `bash -c`, HOME is the run's own).

## Tests

`tests/unit/dev-env-hook-sweep.test.ts` (each bypass with the real git by its full path: the repro, then the sweep;
the review's V1-V9 and N1-N3), `tests/unit/dev-env-command-access.test.ts` (the runner sweeps before and after a run;
a run that lives on across a restart, N4),
`tests/linux/srt-attack.ts` G12-G21, R1-R4, R2b, N1 and N2 on real srt, with the sweep run as the server account
(`tests/linux/sweep-as.ts`).

- **Version impact:** patch.
