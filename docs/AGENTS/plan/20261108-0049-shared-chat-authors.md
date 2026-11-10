# Shared project chats: every question shows who sent it, with a picture and a name

- Date (UTC): 2026-11-08 00:49
- Branch: `feat/shared-chat-authors`
- Status: done
- Where: trina-ax core (`web/src/components/chat/Messages.tsx`, `web/src/pages/Chat.tsx`). Why: shared project chats
  are core chat (see docs/REPOSITORY-RULES.md); the people directory and the `Avatar` already exist there.
- Version impact: minor. A visible UI change in shared chats; no API, server or data change.

## Goal

In a shared project chat (docs/DECISIONS.md "Shared project chats") several people continue one AI chat, and each
question is its sender's turn. Today only someone else's question has a small name line above it, with no picture, and
my own questions show nothing, so a screenshot passed around does not say who asked. The owner wants each question to
show the sender's profile picture and name.

## Scope

In:
- In a shared chat, every question (mine included) has one quiet row above it, on the right like the bubble: the
  person's picture (about 20 px) and their name in muted small text. No box, no chip. It replaces the name-only line.
- My own questions show my name, not "나".
- The picture comes from the people directory (`useAvatarOf`, as rooms do). The directory is read when a shared chat
  shows (`usePeopleList`: every signed-in role may read `GET /api/people`). Without a photo, or while the directory is
  not loaded or failed, the letter tile; for my own questions my own photo version from `/api/me` fills the gap.
- Accessibility: the picture is decorative (`alt=""`, `aria-hidden`), the name is real text read once before the
  question.
- A long name truncates on one line. The name is shown as it is (no "님" added, so "○○님" never becomes "님님").
- A question with no author (`author: null`, which the server sends only when the message has no author id): a neutral
  placeholder, an empty tile and "알 수 없는 사용자" (`rooms.goneUser`, the rooms' word for the same thing). In a
  shared chat a question without a row would read as a continuation of the previous person's, or as mine.
- Chats of one person stay exactly as they are: no picture, no name.

Out: avatars on answers, the queue line or the project page's chat rows; any API change (the directory already has the
photo version, so `Message.author` stays `{id, name}`).

## Steps

1. `Messages.tsx`: `UserMessage` takes `showAuthor` (a shared chat) in place of the `author` name and renders a
   `MessageAuthor` row from `m.author`; `data-testid="message-author"` stays on the name.
2. `Chat.tsx`: pass `showAuthor={!!shared}`.
3. Web unit test (row in a shared chat for mine and others, letter tile, photo `<img>`, unknown author, a "님" name, no
   row in a private chat); extend `web/test/e2e/shared-project-chats.spec.ts` (picture and name on mine and Bob's,
   a photo as `<img>` and the letter without one, a private chat shows neither).
4. ui-polish and impeccable review at 1440 and 390, light and dark, ko and an en spot check, owner and member.
5. CHANGELOG (unreleased) and docs/DECISIONS.md "Shared project chats" (it listed avatars as not added).

## Risks

No migration, no permission change: `GET /api/people` and the photo route are `auth: 'user'`, so a plain member gets
them. The directory request is made once per window (shared store, deduplicated); a failure leaves the letter tiles.
Phone width: the row must truncate inside the 85% column and add no horizontal scroll.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the full web
e2e (`--project=chromium`).

## Result

Built as planned: `MessageAuthor` in `Messages.tsx` (name, then a 20 px `Avatar` at the bubble's edge, `-mb-1` so 4 px
above the bubble), `UserMessage` takes `showAuthor`, `Chat.tsx` passes it for a shared chat. Differences from the plan,
from the ui-polish and impeccable review: the name is the directory's current one (`useNameOf`, as rooms do), and the
picture sits flush with the bubble's edge (no inset). Left as they are, with the reason in docs/DECISIONS.md "Who
asked": the letter tile's faint fill (the same tile as the sidebar's account row and rooms) and a picture sized in px.
No new strings (the unknown author reuses `rooms.goneUser`). Tests: `web/test/unit/shared-chat-authors.test.tsx` (new)
and a new test in `web/test/e2e/shared-project-chats.spec.ts`, whose "my own message carries no name" check now expects
my name. PR: https://github.com/trina-app/trina-ax/pull/181
