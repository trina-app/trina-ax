# Team rooms and the everyone room show their whole history to later members

- Date (UTC): 2026-11-07 08:11
- Branch: `feat/room-history-for-later-members`
- Status: done
- Where: trina-ax `server/src/rooms`, `server/src/chat` (read-scope, answer-share, runtime), `shared/src/api/rooms.ts`,
  `web/src/components/rooms`. Why: rooms, permissions and the AI's share rule are core (see docs/REPOSITORY-RULES.md).
- Version impact: minor (a member who joins a team room or the everyone room later sees its earlier history; new
  optional fields; one additive migration).

## Goal

The owner: team rooms and the everyone room work like Slack channels. Someone who joins a group (or the team) later
sees the whole earlier conversation: people's messages, threads, reactions, room files and quotes. Their read
position starts at the newest message, so nothing old is unread and nothing old notifies. Group chats and 1:1s stay as
they are (from the join on), like Slack's group DMs.

Not in Slack, and required: the AI's room answers, and answers people shared from their own AI chat, went into the
room only because everyone there at the time could open what they used. A later member who cannot open something an
old answer used sees one quiet line in its place ("볼 수 없는 파일을 참고한 답이라 가려졌어요"), never its text,
sources or file links. An answer whose scope was not recorded is hidden from later members.

## Scope

In: a new per-member "sees from" position for team rooms and the everyone room; a per-member snapshot of the old
answers they may not see, taken when they join; the same check in every place that reads room messages (timeline,
threads, quotes, the rooms list, search, the Inbox, room files, AI sources, the room AI's context and share decision,
room_thread, the personal AI chat's room tools, the MCP room tools); the shared answer's scope kept with it; the
placeholder line in the app; migration for existing later members.

Out: group chats and 1:1s (unchanged); bringing hidden answers back when someone's access widens later (they get it
by re-joining).

## Steps

1. Design and an independent product + security review (in the PR).
2. Migration 263 (additive): `room_members.history_from_seq`, `room_messages.answer_scope`, `room_hidden_answers`.
3. `rooms/history.ts`: work out a member's hidden answers at join; `Rooms.sync`, `list`, `syncFor`, `mine` run it.
4. `rooms/store.ts`: `SEE_SQL`, `canSee(db, …)`, the listing form and stubs in `messagesOut`; every caller.
5. Room AI `decide`, `readers`, `count`; `read-scope.ts` viewers; answer-share stores its scope; inbox; runtime history.
6. Web: the placeholder line, the new private reason, five languages; screenshots 1440/390, light/dark.
7. Tests, a second independent review of the code, docs (DECISIONS, CHANGELOG).

## Risks

- Migration number: 263 (262 is the highest on dev). Additive; the reader level stays 6: an older build still shows
  later members the room from their join on.
- Security: any reader that skips the per-member check would show a hidden answer. The check is in `SEE_SQL` /
  `canSee` (whose signature changes, so the compiler lists every caller) and again in `messagesOut`.
- The AI share rule: an answer that read an old answer some member cannot see stays private.
- Performance: one primary-key probe per row in visibility queries; the join computation is per member, once.
- Five languages for the new line and the new private reason; phone and desktop.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test ./tests/unit/b-room*.test.ts` and the AI,
chat-rooms, MCP and answer-share tests, `bun test ./tests/security`, the web build, the web unit suite (Docker, like
CI) and the rooms e2e specs.

## Result

Built as planned, with the independent design review's changes (docs/DECISIONS.md "지난 대화"): answers in threads
that started before the join are judged whatever their own seq; a message an AI app sent after reading keeps what it
had read (`room_messages.source_scope`, also used for shared answers); deleted answers are walked; hidden answers only
become fewer after access changes (`history_recheck`), so an invite account that gets its groups later sees what they
open; an answer private because it used a hidden answer cannot be posted; `has_hidden` skips the check for members with
nothing hidden. Migration 263, additive, reader level 6. Known limits are in DECISIONS (rollback and forward again;
names in a room session's instructions). PR: see the pull request of this branch.
