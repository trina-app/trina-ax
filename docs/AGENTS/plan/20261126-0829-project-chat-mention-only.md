# Project chats: no unread or notice for others' messages, only a mention

- Date (UTC): 2026-11-26 08:29
- Branch: `fix/project-chat-mention-only`
- Status: in progress
- Where: server/src/chat (message notices), server/src/routes/chats.ts, web chat menus. Why: the owner (2026-11-26)
  does not want a notice or unread mark when a teammate starts or continues an AI chat in a shared project.
- Version impact: minor (a changed notice rule and a data migration)

## Goal

In a team project's shared AI chat, someone else's message gives me nothing: no unread number, no mark on the row or
the Projects rail, no push, desktop notice, sound or Activity row. Only an @mention of me notifies (threads under AI
answers, as today). Chats shared with people, team rooms, DMs and their threads are unchanged.

## Scope

In: `chat/message-notices.ts` makes notices only for chats shared with people (not project chats); the chat row,
the `?unread=1` list, the push badge and the realtime fan-out read unread numbers only for those chats, so old
project rows never show; a migration marks old unread project-chat notices read and cancels their waiting pushes;
"Mute this chat" no longer shows in project chats (nothing to mute). Decision file superseding the 11-22 rule.
Out: thread rules (already mention-only for ringing), project chat rooms.

## Steps

1. Plan (this file).
2. Server gate + migration 457.
3. Web: hide Mute for project chats.
4. Tests: update tests/unit/b-project-chat-message-notices.test.ts; people chats and rooms unchanged.
5. Decision, changes note, checks, PR.

## Decisions

docs/decisions/20261126-project-chat-mention-only.md, superseding
docs/decisions/20261122-project-chat-notices-threads-mention-only.md (project chats part).

## Risks

Migration number (457; 455/456 taken by open PRs). Stale unread rows: gated in reads and cleared by the migration.

## Tests

tests/unit/b-project-chat-message-notices.test.ts, b-shared-chat-message-notices.test.ts, web menu test.
