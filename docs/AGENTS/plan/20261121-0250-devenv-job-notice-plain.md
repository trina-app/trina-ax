# A finished background job tells the person the result in plain words

- Date (UTC): 2026-11-21 02:50
- Branch: `fix/devenv-job-notice-plain`
- Status: in progress
- Where: server/src/devenv/jobs.ts, server/src/notifications/service.ts, shared/src/api/notifications.ts, web Activity.
  Why: the Activity notice of a dev environment job is the only place a non-developer sees it (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A notice reads differently and shows less; no API or data is added that clients must handle.

## Goal

Today a finished background job (for example the render of a video the person asked Trina for) shows in Activity as
"개발 환경 작업이 끝났어요: render (종료 코드 0)" with the raw end of the log under it (progress lines, JSON). The
people who use Trina are not developers: this is noise. They get one plain notice about the result instead: "‘<chat>’에서
부탁한 작업을 트리나가 마쳤어요." or, when it failed, "…끝내지 못했어요. 채팅에서 확인해 보세요.", and the notice opens the chat.

## Scope

In:
- The live toast (realtime `notice` dev_env_job) and the Activity row: plain words in the 6 languages, the chat's title
  when the person can still open the chat, no command or job name, no exit code, no reason text in English, no log.
- The inbox API no longer sends the log tail or the English end note to the web (`devEnv.job.tail` / `note` become
  optional and are left out); it sends the chat's title.
- Activity: the log block under the row goes; the row opens the chat as other chat notices do.

Out:
- The log itself: it stays in the job's row, for the AI of that chat (runResultsForAI) and the chat's step details.
- Admins: no new admin notice (they don't need other people's job logs). The project page's run list is unchanged.
- "Seen": the AI does not post into the chat when a job ends (it hears the result on its next box_shell call), so the
  chat has nothing new to see and the notice stays for every job. Push stays off for this event, as before.

## Steps

1. Server: plain texts in jobs.ts for the toast (done / failed, with and without a chat title).
2. Server: devEnvRunOut sends `chatTitle`, drops tail and note.
3. Shared: InboxNotification.devEnv.job tail/note optional, chatTitle added.
4. Web: devEnvText uses the new keys (6 languages); Activity row without the log; ActivityPanel opens it at its link.
5. Unit test: the notice (toast and inbox) has no log line, no exit code, no job name, and links to the chat.

## Decisions

none (follows target users are non-developers; the job and its log are unchanged).

## Risks

Older web clients read `job.tail` with `?.`: an absent tail shows no block. No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/dev-env-srt.test.ts, tests/unit/dev-env.test.ts, the
notifications unit tests, tests/security/project-trash-state.test.ts.

## Result

