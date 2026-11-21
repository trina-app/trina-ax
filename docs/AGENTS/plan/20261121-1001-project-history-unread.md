# Project page Trina history shows the sidebar's unread mention count

- Date (UTC): 2026-11-21 10:01
- Branch: `fix/project-history-unread`
- Status: done
- Where: web/. Why: a display fix in the web app's project page and chat page (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no new setting or API

## Goal

In the Projects sidebar a project chat with unread mentions of me shows a round count ("1") on the chat and on the
project. The project page's Trina history showed the same chat with no count. It should show the same count, and
opening the chat should clear it in both places.

## Scope

In: the project page's chat rows show the sidebar's count (same pill, same store: store/chatMentions.ts) before the
time, title bold while unread; opening the chat reads those mention notices, so the count goes from both lists.
Out: the Trina panel's own history list (no mention counts there today); a server-side count.

## Steps

1. Keep each chat's notice ids with its mention count (ChatMention.ids).
2. Export the sidebar's MentionPill; ProjectChatRow takes `mention` and shows it, `unread` bolds the title.
3. The chat page reads the chat's mention notices on open (readChatMentions): gone from the counts at once, then the
   server; the Inbox count and the lists read again.
4. Unit test (web/test/unit/project-history-unread.test.tsx), e2e with screenshots at 1440 and 390, light and dark,
   en and ko (web/test/e2e/project-history-unread.spec.ts).

## Decisions

none (follows docs/decisions/20261120-project-chat-accordion.md; opening a mentioned chat now also reads its mention
notices, not only reading the thread)

## Risks

No migration, no API change. A mention notice is now marked read when its chat is opened, also without opening the
thread; the notice stays in the Inbox as read.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, web unit tests, the new e2e spec and
web/test/e2e/project-chat-accordion.spec.ts.

## Result

Built as planned. QA TC-6480, TC-6481, TC-6482.
