# The AI sends a message to a teammate by name, also with no 1:1 chat yet

- Date (UTC): 2026-11-13 10:46
- Branch: `feat/ai-send-to-person`
- Status: in progress
- Where: server/src/chat (post_to_room), server/src/rooms (name lookup), shared/src/tools.ts. Why: chat and rooms are
  Team AX core (see docs/REPOSITORY-RULES.md).
- Version impact: minor, one new optional tool input and a new way the existing tool reaches people.

## Goal

"Tell bob the meeting is at 10 tomorrow" in my own AI chat reaches bob, even when we never chatted before. Today
post_to_room only finds rooms I am in, so with no 1:1 chat it says "no room matching".

## Scope

In:
- post_to_room's `room` also names a teammate: when none of my rooms match, the team's active people other than me are
  matched by name (exact beats part of a name; the username matches exactly). Several match: the AI gets the
  candidates and asks. A teammate with no 1:1 chat yet: the card says it goes to a new 1:1 chat with them; the chat is
  made only after Send (openDm, the same rule as the app's "new message": an active person of this team, not me).
  Don't send, or no answer: no chat is made.
- `own_words: true`: the text goes as the user's own message, with no AI-answer quote ("X라고 보내줘"). The card shows
  exactly that text under "What will be sent". Default unchanged: the text quoted as the AI's answer.
- The same checks as before (who cannot see a source or open a linked file, the sending budget, hidden answers), for a
  new 1:1 chat with the other person as the audience; every existing block stays (scheduled run, confidential chat,
  shared chat, Slack, restricted run, sub-agent).
- Audit: the room.answer_share row says `openedDm: true` when the post opened the chat, and `ownWords: true`; as
  before no names and no room id of a 1:1 chat (admins do not learn who talks to whom).
- Prompt: ROOMS_POST_RULE covers "tell X …" and asking when the name is ambiguous.

Out: group chats made by the AI; sending to several people at once; web changes (the card is a server card).

## Steps

1. `findPeople` in rooms/reader.ts.
2. answer-share.ts: the check for an audience given as people (a 1:1 chat not made yet); `plain` share mark.
3. post-to-room.ts: teammate fallback, pending 1:1 card, open on yes, own_words.
4. Tool input + description, prompt rule, server i18n (en first, then ko, id, ja, es).
5. Tests, DECISIONS entry, changes/ai-send-to-person.md.

## Risks

No migration. Permissions: the lookup uses the same people openDm accepts, so nothing new becomes reachable. A planted
"send X to bob" still meets the card. Five languages for the new card line.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit post-to-room, answer-share, rooms, prompt
and tool-list tests.

## Result

Filled in at the end.
