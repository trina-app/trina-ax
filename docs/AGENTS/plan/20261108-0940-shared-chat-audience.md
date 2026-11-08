# Shared project chats follow the rooms' audience rules

- Date (UTC): 2026-11-08 09:40
- Branch: `fix/shared-chat-audience`
- Status: done
- Where: trina-ax `server/src/chat` (shared.ts, turn.ts, tools.ts, room-project-chats.ts, share-chat.ts, a new
  shared-answers.ts), `server/src/rooms/ai.ts`, `server/src/tools/artifact.ts`, `server/src/system/export.ts`,
  `shared/src/api/entities.ts`, `web/src/components/chat/Messages.tsx`. Why: chat, permissions and skills are Team AX
  core (docs/REPOSITORY-RULES.md).
- Version impact: minor (an optional API field, an add-only migration, a stricter rule for later readers).

## Goal

A design audit of dev found two gaps in shared project chats (docs/DECISIONS.md "Shared project chats").

1. Who sees a shared chat is whoever can read its project folder now, so people who gain access later see the whole
   transcript, also answers built on places the read card confirmed only for the people there then (Mina reads
   `groups/finance/` for five people; twenty join later and see it). The owner decided: the same rule as team rooms
   ("지난 대화", rooms/history.ts). An answer stays visible to its runner, to the people who saw the chat when it read
   what it used, and to anyone who can read those places themselves; everyone else sees one line in its place, with
   the rooms' wording ("볼 수 없는 자료를 참고한 답이라 가려졌어요").
2. Rooms list a group's skills only when everyone in the room is in that group (the owner and admins read every group
   folder, but the skills are the members'); a shared chat only checks folder access, in its skill list and in the
   skill read card.

## Scope

In:
- Migration 273 `shared_answer_reads`: per answer of a shared chat, what it read (the read gate's sources, with the
  people who saw the chat at that read) and the answers above it its runner did not see (not in its context).
- Recorded by the read gate (every call, "/name", attachments, sub-agents), the turn's instructions files, at
  `createTurn` (an empty record in the same transaction), at turn start (the answers left out of its context), by
  "프로젝트 사람들과 공유" (every earlier answer: the share's audience, the chat's sources, not known when the check
  could not tell) and once at start for older answers (the people who see the chat then; not known for anyone else).
- One visibility pass (`chat/shared-answers.ts`): runner, covered, or reads every source; an answer built on one
  hidden from the viewer is hidden too unless it was not in its context. No record: hidden (fails closed).
- Applied in: the messages API (`Message.withheld`, an empty shell), the sources list, artifacts (list, get, and the
  tool's update/inheritance), chat search, the room tools' search and transcript (and the room's read scope), the
  engine transcript of a later reader (`labelledTranscript` / `sharedTranscriptText`), export.
- One helper `everyoneMayUse` (chat/skills.ts) for rooms and shared chats, with the group test; the shared chat's skill
  read card asks when someone who sees the chat is not in the skill's group.
- Web: one faint line for a withheld answer, five languages through the rooms' key.

Out: unsharing; a card when a reader joins; titles (no `set_title` in shared chats; a chat shared later keeps its
title); a per-project source type for rooms.

## Steps

1. Migration 273 and `chat/shared-answers.ts` (records, the pass).
2. turn.ts: record reads, left-out, instruction files; transcript filter; group-aware audience helper and skill card.
3. Routes, artifacts, export, room tools, share-chat, start backfill.
4. API field, web line, docs (DECISIONS, CHANGELOG, API docs).
5. Tests: unit (later joiner, covered viewer, reader, engine context, room tools, group skills), security, web unit,
   full web e2e and two screenshots.

## Risks

- Migration number: 266, 267 and 270 are taken by open PRs; check again before the PR.
- Over-hiding: an answer built on a hidden one is hidden from that viewer; kept exact by recording what each runner
  did not see.
- Room answers: a transcript with an answer some member cannot see keeps the room answer private (its sources join
  the read scope; a not-known one marks it outside).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` with `tests/unit/docs-site.test.ts`,
every unit test of the touched areas (`b-shared-chats`, `b-share-existing-chat`, `b-rooms-*`, `b-chat-rooms`,
`i18n-languages`, artifacts, export), `tests/security/shared-project-chats.test.ts`,
`tests/security/room-reads-shared-chats.test.ts`, `bun run test:web`, `bun run build:web`, the full web e2e.

## Result

Built as planned (docs/DECISIONS.md "People who see a shared chat later"), with what the independent security review
added: an artifact version is hidden with any earlier hidden version of its key (an update on another branch carried
its text); a room answer built on shared chat answers carries the places they read (later room members are judged by
them), and the room search counts a word only through what everyone in the room sees; searches run one full-text query
per request. Differs from the plan: a read nobody had to confirm is recorded too (everyone then is its group), so a later
reader who may not read the place gets the line; rolling back to a build with 265 but not 273 shows every answer again
while it runs (written down, no reader-level bump). PR: fix/shared-chat-audience to dev.
