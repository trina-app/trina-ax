# Shared chats' commands: srt's proxy sockets fit a unix socket path again

- Date (UTC): 2026-11-18
- Branch: `fix/devenv-shared-socket-path`
- Status: done
- Where: trina-ax server/src/devenv/srt (Team AX core). Why: the dev environment's run layout is core code.
- Version impact: patch, every command of a shared chat failed on a real server

## Goal

On qa.trina.app (Linux, real srt) every box_shell call of a shared chat ended with exit 1 and "Error: Failed to create
bridge sockets after 5 attempts" (QA TC-4848). srt 0.0.81 makes its two bridge sockets in TMPDIR, and the per-command
home of a shared chat (/var/lib/mycel/devenv/chat-home/<chat uuid>/<run>/tmp) made them 124 bytes long; a unix socket
path has at most 107 (socat: "unix socket address 124 characters long, max length is 108"). The Docker suite passed
because its chat ids were short.

## Scope

In: a short TMPDIR per shared command (`devenv/rt/<run>`, srt/config.ts runTmp), removed when it ends and swept by the
clean-up; a settings check that refuses a run whose socket paths are too long (Linux); a unit test with a production
base and production ids; the Docker suite with uuid-length chat ids.
Out: HOME and logs stay where they are (no sockets there).

## Steps

1. config.ts runTmp, SUN_PATH_MAX, srtSocketPaths; runEnv, srtSettings, settingsProblems.
2. runner.ts prepare / dropSharedRun; system/devenv-clean.ts.
3. Tests: tests/unit/dev-env-socket-path.test.ts, the shared-chat tests, tests/linux/srt-attack.ts.

## Decisions

none (a fix of docs/decisions/20261118-devenv-shared-chats.md "nothing personal": TMPDIR is still per command).

## Risks

TMPDIR moves for shared commands only; private runs keep <home>/tmp.

## Tests

`bun run check:prepush`, the dev-env unit tests under Bun 1.3.12. The Docker suite cannot run on this Mac (Docker Desktop
refuses bwrap's loopback setup); CI or colima runs it.

## Result

Built as planned.
