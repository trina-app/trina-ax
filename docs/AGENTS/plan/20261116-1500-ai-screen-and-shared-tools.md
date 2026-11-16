# The AI asks what is shared with the person and what they have open (tools, not text in every turn)

- Date (UTC): 2026-11-16 15:00
- Branch: `feat/ai-screen-and-shared-tools`
- Status: done
- Where: Team AX core (`server/src/chat/`, `server/src/realtime/`, `shared/src/`, `web/src/`). Why: chat, files and
  permissions go into the core first (docs/REPOSITORY-RULES.md).
- Version impact: **minor** (two AI tools, one client frame; no endpoint, no migration of its own).

Part B4 of the AI sharing plan the owner approved on 2026-11-16 (QA tab `Manual AI tests`, MAN-015 and MAN-020).
The owner's direction: no screen context and no lists in every turn; the AI is an agent and calls a tool when it
needs one.

## Goal

1. "Summarise the file Mina shared with me" finds that file, also when a team file has the same name.
2. "Summarise this" / "reply in that thread" works on what the person has open, and asks when two things are close.
3. The shared-file page (`/f/<id>`) has an **Ask Trina** button.

## Scope

In:
- Tool `shared_with_me` (name filter, newest first, capped): `FileShares.sharedWithMe()`, each row re-checked with
  `FileShares.open`. Replaces #1080's "Files shared with you" block in every turn with one prompt line. Read by link
  or path stays.
- A file read through a grant counts as other people's words for the share, post and room-change gates. **Changed
  while building:** #1109 added that as the chat marks `others_words` and `rooms_seen` (migration 410); this branch
  builds on those marks, adds none, and only fixes the card's words after a grant read.
- Tool `looking_at` (no parameters). Web: one `looking` frame per route or side-panel change, ids only, nothing in a
  confidential chat, rate-limited, sent again after a reconnect. Server: in memory beside the hub
  (`server/src/realtime/looking.ts`), per person and window, dropped on close and after a TTL, capped. The turn's
  snapshot is taken when the message is sent.
- What `looking_at` returned never counts as "named by the asker": no Always allow and no explicit-ask skip for it.
- Ask Trina on `web/src/pages/FileLink.tsx`.

Out: folder sharing; the words of refusals and cards (B1, B2); "who can open this" (B3); ids of room files in the
frame.

## Steps

1. Server: `chat/grant-reads.ts` (the card's words after a grant read), `chat/shared-with-me-tool.ts`, `realtime/looking.ts`,
   `chat/looking-at.ts` (tool and the per-turn record), small edits in `tools.ts`, `turn.ts`, `prompt.ts`,
   `share-with-person.ts`, `post-to-room.ts`, `read-rooms.ts`, `shared/src/tools.ts`, `shared/src/api/ws.ts`.
2. Web: `lib/lookingAt.ts` (pure), one reporter in the layout, the button on the link page, i18n in six languages.
3. Tests: unit (server and web), Playwright (button, frame on navigation). Hands-on on a private QA copy.
4. Docs: decision note, changelog fragment, user docs where the pages exist.

## Decisions

See `docs/decisions/20261116-ai-screen-and-shared-tools.md`.

## Result

Built as planned, with these changes:

- The grant-read gate is #1109's (the marks); `grant-reads.ts` only picks the card's sentence (three new texts in six
  languages). Both tools mark the chat as holding other people's words (neither is in `OWN_WORDS_TOOLS`).
- `shared_with_me` is off in scheduled runs, as grant reads are since #1109 (the plan said the person's own schedules).
- "Place in words" of a shared file: how it reaches the person (them, a group, the whole team); a folder in words only
  for a file their own folders show. A file only the grant opens gets no folder (the link page shows none).
- The list's order is the server list's: shared by name first, then through a group or the whole team.
- A thread's view already had "Ask Trina about this" on each message; nothing was added there.
- Hands-on with the real AI on a private copy of the QA team: MAN-020 and MAN-015 pass; an idle window sent only its
  keep-alive pings.
