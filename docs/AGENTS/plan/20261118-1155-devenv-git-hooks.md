# A member's git hook or git config program never runs in another member's run

- Date (UTC): 2026-11-18
- Branch: `fix/devenv-git-hooks`
- Status: done
- Where: trina-ax server/src/devenv/srt (Team AX core). Why: the dev environment's run settings are core code.
- Version impact: patch, P0 security fix (QA TC-4939)

## Goal

srt write-protects `.git/hooks` and `.git/config` only when `.git` exists as a run starts. In a project folder with no
repository, member Erin's run could `git init` and plant `.git/hooks/pre-commit`; Alice's later `git commit` in her
own run ran it, with her access and her persistent home. Stop that, and everything else a shared writable folder or
the run's home could make run by itself.

## Scope

In: every run's environment switches off repository hooks and the programs git takes from config where an
environment can (core.hooksPath=/dev/null, fsmonitor, credential helpers, pager, editor, askpass, signing, ext
transport), reads no global git, npm or pip config and no Python user site from the home; before every run, a
repository in or above the run's folder whose config names a program by its own name (filter / diff / merge driver,
include, sshCommand, gitProxy, upload-pack, gpg, "!" alias) stops the run with the reason. Docker suite G1-G4.
Out (documented): package.json scripts, a project .npmrc, Makefiles, Python files: running them is running the
project's code.

## Steps

1. srt/git-guard.ts (gitEnv, dangerousGitConfig, gitConfigProblems); config.ts runEnv; runner.ts settingsFor.
2. Tool text; decision; changes; tests (unit, harness, Docker).

## Decisions

docs/decisions/20261118-devenv-git-hooks.md

## Risks

A repository with a filter or diff driver of its own (git-lfs installed per repository) stops runs in that folder
until the lines are removed. Fail closed.

## Tests

`bun run check:prepush`; tests/unit/dev-env-git-guard.test.ts, dev-env-command-access.test.ts, dev-env-srt.test.ts;
the Docker suite (`bun run tests/linux/srt-run.ts`, colima).

## Result

Built as planned, then changed after the security review of the first version: the one-time scan of repository
configs before a run (bypassed by one-line sections, .git links, bare repositories, unlisted keys, its depth limits
and settings written after the start) is replaced by a git wrapper first on the run's PATH that asks the real git on
every call; safe.bareRepository=explicit joins the environment; a project folder's runs get a home of their own.
