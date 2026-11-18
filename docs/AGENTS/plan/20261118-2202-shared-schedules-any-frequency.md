# Scheduled tasks and videos in shared chats; schedules at any frequency

- Date (UTC): 2026-11-18 22:02
- Branch: `feat/shared-schedules-any-frequency`
- Status: in progress
- Where: Team AX core, `server/src/chat/`, `server/src/tools/`, `web/src/`. Why: schedules, shared chats and their
  tools are core chat features (see docs/REPOSITORY-RULES.md)
- Version impact: minor, new schedule kinds and tools offered in shared chats

## Goal

The owner: "in a shared chat everything is shared", and "Claude Code is the floor". Today a chat shared with people (or
a shared project chat) has no scheduled tasks and no video tools (the AI says it can't, or gets "unknown tool"), and a
schedule repeats only once, daily, on weekdays, weekly on one day or monthly on day 1–28: no "every hour", no "Mon and
Thu", no "last day of the month", no cron.

## Scope

D. Shared chats
- `schedule_create`, `schedule_list`, `schedule_delete`, `generate_video`, `promo_video`, `save_promo_video` join the
  shared-chat allowlist (`rooms/ai-tools.ts SHARED_TOOLS`).
- A task made in a shared chat remembers that chat (`schedules.chat_id`). Each run is a turn **in that chat**, as the
  task's owner, with the owner's access, engine, budget and queue, and with every shared-chat gate of an ordinary turn:
  a read some people in the chat can't open needs the asker's card, and a run has nobody to answer it, so it is skipped.
  When the owner can no longer continue that chat (removed, deleted, project gone), the run goes to a new chat of their
  own, as any task does.
- The schedule card in a shared chat says the results are posted there, and how many people see it.
- In a shared chat, `schedule_list` and `schedule_delete` see only the tasks that post into that chat (the owner's other
  tasks are their own).
- `promo_video`'s logo and pictures count for the shared read card like its `sources`.
- A chat already shared with people stays changeable after a run posted in it (the "chat made by a scheduled task"
  refusal is for sharing a private chat).
- Guests are unchanged: none of these tools are guest tools.

E. Any frequency
- New repeat kinds: `interval` (every N minutes, from a start), `cron` (5 fields, team time zone, `L` = last day of the
  month); weekly with several weekdays; monthly on day 1–31 or the last day.
- Stored without changing the `repeat` CHECK: a new JSON column `schedules.rule`; the legacy columns hold a one-time
  task in the past, so an older build after a rollback never runs such a task more than once.
- No working-hours or minimum-interval limits. Each run still passes `budgetBlock`, and runs of one task never overlap.
- Settings › Scheduled tasks › Edit offers the new kinds; en.ts first, then all locales.

## Decisions

- `docs/decisions/20261118-shared-schedules-any-frequency.md`

## Risks

- Migration 421 (420 is batch 2's). Additive columns only.
- Security: a run in a shared chat must never skip a gate an ordinary turn has. Tested.

## Tests

`bun run typecheck`, i18n, docs, unit tests for the cron parser and next run, the shared-chat tool list, a run posting
into the shared chat with its read gate, the fallback chat, the list scoped to the chat; UI shots at 1440/390,
light/dark.

## Result

(filled in at the end)
