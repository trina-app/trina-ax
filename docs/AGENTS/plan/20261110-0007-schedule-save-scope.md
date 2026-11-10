# Scheduled tasks: save and send with the person's yes given once, on the schedule card

- Date (UTC): 2026-11-10 00:07
- Branch: `feat/schedule-save-scope`
- Status: done
- Where: trina-ax core (`server/src/chat`, `server/src/tools/schedules.ts`, `server/src/integrations/connections`,
  `web/src/pages/Scheduled.tsx`, `web/src/components/settings/ScheduleEditDialog.tsx`). Why: permissions, chat and
  connections are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A scheduled task can now be allowed to save into one team folder and to send to the person's
  own connections at pinned places; a new migration (additive).

## Goal

A scheduled run has nobody to answer a card, so today every card is "no answer" (chat/turn.ts waitForPerson). A run
cannot save a summary of the person's notes into `shared/주간보고` (the wider-audience card), changes nothing after it
read a room (the room card), and never sends to a personal connection (connections/tools.ts gate). The person can now
say yes once, on the schedule card they already answer when the task is made, edited or checked again:

- "새 파일 저장: shared/주간보고 (지금 30명이 볼 수 있어요). 넣어도 되는 내용: 내 폴더, #영업팀 대화"
- "보낼 수 있는 곳: 내 Notion · '일일 메모' 페이지"

No new buttons: the same create / create without sends / don't create answers.

## Scope

In (1a and 1b of the owner's plan, one PR):

- Migration `282_b_schedule_save_scope.sql` (281 is taken by #275): `schedules.save_folder`, `save_folder_id`,
  `save_rule`, `save_readers`, `save_sources`, `personal_sends`, `save_lapsed_at`, `save_lapse_reason`.
- `schedule_create` gains `save_to`, `reads` and `send_to`; `connections` also takes the person's own connections, which
  need `send_to` (the pinned recipients, Q2 a). Everything is checked before the card.
- The card lines on create, edit and "다시 확인"; the edit and review answers are bound to the folder (its id and its
  rule fingerprint), the readers, the sources and the pins.
- At run time (chat/schedule-cover.ts), only in a confirmed task's run:
  - new files in that folder and its sub-folders without folder rules of their own, and edits of files this run made
    there; at most 20 covered new files per run; audit `schedule.save_cover` once per run;
  - only when every source the run read that fewer people see than the folder is on the card; after a room read, only
    when every room the run read is on the card; else the run is told why and saves in the person's own folder;
  - never an existing file of someone else, a move, copy, rename or delete, skills, instruction files, hidden or plugin
    folders, save_url or video; checked again right before each write; absent targets are reserved per call;
  - a connection write after a room read skips the room card only when every room the run read is on the card; a
    personal connection sends only when the card listed it and every recipient value of the call is pinned there (a
    call whose recipients cannot be found is refused).
- Lapses (Q1 a): a change of the folder rules on the way to the folder, the folder moved, renamed or deleted, or the
  person's write access gone sets `save_lapsed_at`; group members joining or leaving do not. Then runs save in the own
  folder and say why, the Scheduled list says "저장 폴더를 다시 확인해 주세요" with [다시 확인], one inbox notice.
- Scheduled list: "저장: shared/주간보고" under the task. Edit dialog: "저장 폴더" and the sources, each removable with ×.
  Five languages.
- The run's instructions (chat/schedules.ts scheduledRunBlock) say what this task may do instead of one blanket line.
- Docs: CHANGELOG, DECISIONS, INTEGRATIONS, PERMISSIONS, docs/site/use/scheduled-tasks.md, the API reference.

Out:

- New files in the person's own folder after a room read: #275 (`feat/fewer-cards-after-room-read`) does that for every
  own chat, scheduled runs included. This branch adds nothing there.
- Adding sources in the edit dialog (only removing); the AI adds them when it makes or the person remakes the task.
- Team connections' pins (Q2 is about personal connections; team "allow" connections stay as they are).

## Steps

1. This plan (first commit).
2. Migration 282, the row type, the scope helpers (chat/schedule-scope.ts: validate, fingerprint, lapse check, labels).
3. schedule_create, the card lines, edit and review binding, "다시 확인" for a lapse.
4. The runtime cover (chat/schedule-cover.ts) and its hooks in turn.ts (confirmRoomChange, confirmWidening,
   recheckRoomCover), tools.ts (release of reservations, the connection-send hint) and connections/tools.ts gate().
5. Lapse at Schedules.start and at each use; the inbox notice.
6. Shared API, the Scheduled list line, the edit dialog, five locales.
7. Tests: tests/unit/schedule-save-scope.test.ts (the security list below), the existing schedule, room and connection
   suites; b-chat-rooms.test.ts asserts the refusal text of a scheduled run after a room read.
8. Docs, checks, screenshots, PR to dev.

## Risks

- Security: an unattended run follows planted text in a room or a web page. Bounds: one folder, new files only, only
  listed sources, rooms checked, pins for personal sends, 20 files, recheck before each write, audit. Residual: a planted
  message can still make the run put a useless new file in the approved folder (people can see and delete it).
- `recipientFields` finds recipients by argument name; a tool with an unusual name could hide one. Pinning also checks
  every value that is a whole e-mail address or web address, and a call with no recipient value at all is refused.
- Migration: highest on dev is 280, #275 has 281: this is 282. Additive (reader 1).
- Merges: #273 (fix/ai-refusals-clear) rewrites refusal texts, gate() and scheduledRunBlock; #275 rewrites
  confirmRoomChange. The new code sits in its own modules with small hooks; dev is merged once #273 lands and its
  `refusal()` is used for the new texts.
- Five languages for the card lines, the list line, the dialog and the inbox notice.

## Tests

`bun run build:native`, `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api`; the
schedule, chat, room and integrations suites and the security permission matrix; the whole tests/unit suite compared
with dev; the web unit tests in Docker; the scheduled-tasks e2e specs.

## Result

Built as planned in one PR: https://github.com/trina-app/trina-ax/pull/284 (migration 282).

- Server: `chat/schedule-scope.ts` (the card's facts, lapses), `chat/schedule-cover.ts` (the run's covers), hooks in
  `chat/turn.ts`, `chat/tools.ts`, `chat/room-tools.ts`, `tools/schedules.ts`, `chat/schedule-edit.ts`,
  `chat/schedule-review.ts` (mode `recheck` for a lapse), `integrations/connections/tools.ts` (`sendsTo`, `pinTargets`,
  the pinned gate), `notifications/service.ts` (one notice per lapse). #273's `refusal()` for the new texts.
- Web: the list line, the task page's lines, **수정**'s save folder and places, the recheck from the list, the inbox
  notice and the audit words, five languages; the mock server and an e2e spec.
- Differs from the plan after an independent review (two rounds): after a room read only pinned own connections skip
  the room card (an "allow" team connection keeps it, it has no pins); every value of a pinned send that may say where
  it goes must be pinned, not only recipient-named ones (numbers, `false`, unknown names), more than 50 or deeper than 8
  is refused; a listed folder keeps its rule fingerprint and a change lapses the permission.
- Third review (before merge): what a pinned send says is checked for addresses, host names and random-looking parts;
  the cap counts the file layer's creates (conflict copies); an own-folder file an AI wrote after the yes is not "my
  folder"; new files in the own folder go on in a run after a room read (until #275 lands); the cover is checked again
  right before a produced file is placed.
- Known low risks left: two identical calls at the same time share one claim; look-alike letters in pins are not
  marked; an "allow" team connection's content is not checked for addresses (a follow-up).
