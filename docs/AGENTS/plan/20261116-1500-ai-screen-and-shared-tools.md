# The AI asks what is shared with the person and what they have open (tools, not text in every turn)

- Date (UTC): 2026-11-16 15:00
- Branch: `feat/ai-screen-and-shared-tools`
- Status: in progress
- Where: Team AX core (`server/src/chat/`, `server/src/realtime/`, `shared/src/`, `web/src/`). Why: chat, files and
  permissions go into the core first (docs/REPOSITORY-RULES.md).
- Version impact: **minor** (two AI tools, one client frame; no endpoint, no migration).

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
- A file read through a grant counts as other people's words for the share, post and room-change gates.
- Tool `looking_at` (no parameters). Web: one `looking` frame per route or side-panel change, ids only, nothing in a
  confidential chat, rate-limited, sent again after a reconnect. Server: in memory beside the hub
  (`server/src/realtime/looking.ts`), per person and window, dropped on close and after a TTL, capped. The turn's
  snapshot is taken when the message is sent.
- What `looking_at` returned never counts as "named by the asker": no Always allow and no explicit-ask skip for it.
- Ask Trina on `web/src/pages/FileLink.tsx`.

Out: folder sharing; the words of refusals and cards (B1, B2); "who can open this" (B3); ids of room files in the
frame.

## Steps

1. Server: `chat/grant-reads.ts` (the gate), `chat/shared-with-me-tool.ts`, `realtime/looking.ts`,
   `chat/looking-at.ts` (tool and the per-turn record), small edits in `tools.ts`, `turn.ts`, `prompt.ts`,
   `share-with-person.ts`, `post-to-room.ts`, `read-rooms.ts`, `shared/src/tools.ts`, `shared/src/api/ws.ts`.
2. Web: `lib/lookingAt.ts` (pure), one reporter in the layout, the button on the link page, i18n in six languages.
3. Tests: unit (server and web), Playwright (button, frame on navigation). Hands-on on a private QA copy.
4. Docs: decision note, changelog fragment, user docs where the pages exist.

## Decisions

See `docs/decisions/20261116-ai-screen-and-shared-tools.md`.

## Result

(filled in at the end)
