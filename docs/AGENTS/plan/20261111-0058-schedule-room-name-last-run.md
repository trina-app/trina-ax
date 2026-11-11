# Scheduled tasks: room names instead of room ids, and one clear "Last run" block

- Date (UTC): 2026-11-11 00:58
- Branch: `fix/schedule-room-name-last-run`
- Status: in progress
- Where: trina-ax core (`web/src/pages/Scheduled.tsx`, `web/src/lib/scheduleText.ts`, a new pure helper for room names
  in a text, the chat bubble's text, `server/src/routes/memories.ts` and `server/src/chat/schedules.ts` for the last
  run's state, `shared/src/api/schedules.ts`). Why: scheduled tasks, chat and rooms are core (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch, two optional response fields on `Schedule` and corrected words; no data change

## Goal

A teammate found two things on dev (e2d645ff):

1. A scheduled task that the AI made from a chat shows its instruction with a raw room id ("… room_id 01a1ba5f-…") on
   the task page and in each run's question. People should read the room's name.
2. The task page's "Last run" block says "Last run" three times ("Last run / Last run / Last run succeeded"), and it
   does not change after "Run now" until the page is reloaded.

## Scope

In:
- Room names where the instruction is shown (the task page, the list card's preview, the run's question bubble): a room
  id written as `room_id <id>`, `room_id=<id>`, `room:<id>`, `[#room room_id=<id>]` or a `#[name](room:<id>)` token
  reads as `#<room name>` (a 1:1 chat: the other person's name), from the rooms the viewer is in now (the app's own room
  list, which the server fills with the viewer's rooms only).
- Access rule: the name only for a viewer who is in that room. Anyone else reads "a conversation you're not in", never
  the name, also when a token carries one. A bare id that is none of the viewer's rooms stays as it is (it may not be a
  room). Until the room list is loaded the text stays as stored (no claim either way).
- The stored instruction stays as it is: a run reads the room by its id (`room_read`), so the id must stay in the text.
- The "Last run" block: one heading, then one line with the state and when ("Succeeded · 2 minutes ago", "Running"),
  the reason when it did not succeed, the link to the run's chat. The server says when the last result came
  (`lastOutcomeAt`) and whether a run is queued or running now (`running`), so a "Run now" run is shown as that run, not
  as the scheduled run before it.
- Refresh: after "Run now" the page reads the list again, and it reads it again when the run's chat changes
  (`chat.updated`, a run starting or ending) or when the connection was reset. No new boxes.
- ko, en, id, ja, es.

Out:
- The schedule card (create, edit, check again) keeps showing the instruction exactly as it runs, ids included: it is
  the confirmation of what runs, and a room name is set by its members (any member of a group chat), so it must not
  change how the instruction reads at the moment of the yes. The card already names the rooms of `reads` by name.
- The edit dialog's text box keeps the stored text (the id must survive an edit).
- Token chips in ordinary chat messages keep their own title (the person picked them); only the forms with a bare id
  are new there.
- Item 3 of the report (the confirmation card in a weekly run's chat step): investigated only, a proposal in the PR.

## Steps

1. Plan (this file).
2. Server: `Schedules.lastResult` (outcome and its time) and `running` in `scheduleOut`; the shared `Schedule` type.
3. Web: the pure helper `lib/roomNames.ts`, a `WithRoomNames` component, used by the task page, the list card and
   `UserText` (bubbles); the block's words (`scheduleText.ts runStateLabel`), the refresh in `useScheduleList`; mock
   server (`running`, `lastOutcomeAt`, a run that ends a moment later).
4. Tests: unit tests of the helper (the access rule: a viewer outside the room never gets the name, token or not), a
   web unit test of the block, server unit test of `running` / `lastOutcomeAt`, an e2e of Run now refreshing the block.
5. DECISIONS (the display rule and why the stored text keeps the id), `changes/schedule-room-name-last-run.md`.

## Risks

- Access: names come only from the viewer's own room list; the helper never prints a token's title for a room the
  viewer is not in. Runs and their chats are never shared (`share-chat.ts scheduled_run`), so the viewer is the owner,
  who may have left the room since.
- Other sessions: no edits to `projects.ts`, `chat/shared.ts`, `chat/read-rooms.ts`, the members dialog, ⌘K search
  (`SearchDialog.tsx`) or `tools/url-gate.ts`.
- Older servers omit the new fields: the block falls back to `lastRunAt`.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/schedules.test.ts`,
`tests/unit/schedule-edit.test.ts`, `bun run test:web` (helper and block), e2e `schedules.spec.ts` and
`scheduled-page.spec.ts`.

## Result

Filled in at the end.
