# Dev environment in shared chats: follow-ups from the real-server QA

- Date (UTC): 2026-11-18
- Branch: `fix/devenv-shared-followups`
- Status: done
- Where: trina-ax server/src/devenv/srt and web/src/store (Team AX core). Why: the dev environment and the send queue are core code.
- Version impact: patch, three fixes found on qa.trina.app (QA TC-4928, TC-4929, TC-4930)

## Goal

1. TC-4928: `env` in a run shows srt's proxy login (http_proxy user:token, CLOUDSDK_PROXY_PASSWORD, GIT_SSH_COMMAND);
   an AI could paste it into a shared chat.
2. TC-4929: in a people-shared chat a limited folder only one member may open shows as an empty folder in `ls`, which
   names it to everyone.
3. TC-4930: after a declined answer was tried again, the finished answer kept "The answer didn't finish".

## Scope

In: (1) hide srt's proxy login in what a command shows (tool answer, job tails); confirm it is per run and ends with
it. (2) In a shared chat's run, a read-only folder holding a denied folder is given entry by entry (srt/mounts.ts).
(3) The send queue's pause for a stopped or failed answer turns into "not sent yet" once that answer is no longer the
newest. Docker suite S14, S15.
Out: names of restricted sub-folders of a WRITABLE folder (a shared project chat's project folder) still show empty.

## Steps

1. srt/proxy-login.ts, tool.ts, jobs.ts.
2. srt/mounts.ts, runner.ts settingsFor; tests/linux/srt-attack.ts S14, S15.
3. web/src/store/sendQueue.ts pump.
4. Decision file, changes file, tests.

## Decisions

docs/decisions/20261118-devenv-shared-followups.md

## Risks

The mounts of a shared chat's read-only folders change (entries instead of the folder): a file added to such a folder
while a command runs is not in that command.

## Tests

`bun run check:prepush`; tests/unit/dev-env-shared-followups.test.ts, dev-env-shared-chat.test.ts, web
send-queue.test.ts; the Docker suite needs CI or colima (Docker Desktop on this Mac refuses bwrap's loopback).

## Result

Built as planned.
