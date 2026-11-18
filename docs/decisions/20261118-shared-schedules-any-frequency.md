# Scheduled tasks and videos in shared chats; schedules at any frequency

- Date: 2026-11-18
- Status: accepted
- Supersedes: in part the archive's "Shared project chats" (its allowlist kept schedules and video out) and the 2026-10
  schedules (five repeat kinds). Adds to "Chats shared with people and groups" (a chat a run posted in stays
  changeable)
- Branch: feat/shared-schedules-any-frequency (the owner, 2026-11-19 "Claude Code is the floor"; QA TC-5008)

- **Ask (D):** in a chat shared with people, or a shared project chat, scheduled tasks and the video tools answered
  "unknown tool" and the AI sent the person to a chat only they see. The owner: in a shared chat everything is shared, so
  allow them.
- **Rule (D):**
  - `schedule_create`, `schedule_list`, `schedule_delete`, `generate_video`, `promo_video` and `save_promo_video` join
    the shared-chat allowlist (`rooms/ai-tools.ts SHARED_TOOLS`). Each card (the schedule card, the video credits card)
    is the asker's, as everywhere.
  - A task made in a shared chat keeps that chat (`schedules.chat_id`, migration 424). Each run is a turn in that chat,
    as the task's maker, with their access, engine, AI budget and queue, under the chat's newest answer. The turn is an
    ordinary shared-chat turn, so every gate of that chat applies. A read of a place some people in the chat cannot open
    needs the maker's yes on the read card, and nobody answers a card in a run, so it is skipped and the answer says so
    without naming the place. When the maker chose "Always allow" for that card, their standing yes counts in their run
    as in their own turns (`alwaysHere`: only the run's own person's choice, never offered in a run). Connections follow the shared-chat rules (no team connection while a guest is there, the
    maker's own connections only behind a card). Posting, sharing and memories stay off in a run.
  - While its maker cannot continue that chat (`chatFor 'continue'`: taken out of it, the chat deleted, the project
    gone or not seen, safe operations on), the run is a new chat of their own, as for any task. Their own chat holds
    only what they may read, so nothing reaches anyone else.
  - The schedule card in a shared chat says the runs post there and how many people see the chat now. The task page
    says where it posts (`Schedule.postsIn`, while the maker may open the chat); its run history links runs there.
  - In a shared chat, `schedule_list` and `schedule_delete` see only the tasks made in that chat. The maker's other
    tasks (their titles and instructions) are their own and are not read into a chat others see.
  - The addresses the schedule card allowed are allowed in that chat (`chat_seen_urls`), as in a run's own chat. They
    are exact addresses the instruction shows to everyone in the chat, so opening them carries nothing new out.
  - `promo_video`'s logo and the pictures of its beats count for the shared read card like its `sources`
    (`namedPaths`). A video is saved like any file the AI makes there (the maker's folder unless a place is named; the
    wider-audience card for a wider place).
  - A chat already shared with people stays changeable after a run posted in it: its runs had the chat's gates, like any
    turn there. A private chat a run made or ran in is still never shared (`chatShareScheduled`).
  - Guests: unchanged. None of these tools are guest tools (`chat/guest-tools.ts`).
- **Ask (E):** a task repeated only once, daily, on weekdays, weekly on one day or monthly on day 1–28: no "every hour",
  no "Mon and Thu", no "last day of the month". Claude Code's scheduled jobs take any 5-field cron expression.
- **Rule (E)** (`server/src/chat/schedule-timing.ts`):
  - New kinds: `interval` (every N minutes, 1 minute to a year, counted from a start day and time), `cron` (five fields
    in the team's time zone: steps, ranges, lists, month and day names, 7 = Sunday, `L` = the last day of the month,
    `@hourly` and the other macros; day of the month and day of the week both set means either, as in cron), weekly on
    several days, monthly on day 29–31 (a month without that day has no run) or the last day.
  - No working-hours or shortest-interval limit, as Claude Code. Each run still passes the team's AI budget
    (`budgetBlock`), runs of one task never overlap (a run that is still going makes the next occurrence wait), and a
    full queue retries the occurrence later, as before.
  - A wall-clock time a clock change skips has no cron run that day (it is not that time anywhere). An interval counts
    real minutes from its start.
  - Storage: the `repeat` CHECK of migration 203 is not changed (a table rebuild of `schedules` would touch its foreign
    keys). A timing the old columns cannot hold is kept in `schedules.rule` (JSON, migration 424), and the old columns of
    that row hold a one-time task on 2000-01-01. An older build after a rollback runs such a task at most once more (its
    next time as stored) and then stops; it never runs it more often than asked.
  - Settings › Scheduled tasks › Edit offers the new kinds: weekday chips, day 1–31 and "Last day of the month",
    "Every few minutes or hours" (a number and minutes, hours or days, with the start time), "Custom (cron)" with the five
    parts explained. The AI's `schedule_create` takes `weekdays`, `day: 1–31 | "last"`, `every_minutes` and `cron`.
- **Left out:** the 20 tasks per person (a separate limit); the unattended run's own budget for new web addresses.
- **Tests:** `tests/unit/schedule-timing.test.ts` (each kind's next runs, cron fields and errors, daylight saving, the
  stored form an older build reads, an hourly task staying on after a run, the edit card binding the new timing),
  `tests/unit/b-shared-chat-schedules.test.ts` (offered there, the card's line, a run in the chat as its maker with a
  place another person cannot open skipped, the run history link, list and delete kept to the chat, the fallback chat,
  another person's own task, a people chat kept changeable), `web/test/unit/schedule-any-frequency.test.tsx`.
- **Version impact:** minor (new schedule kinds and tools offered in shared chats; migration 424, additive).
