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
  - A task made in a shared chat keeps that chat (`schedules.chat_id`, migration 426). Each run is a turn in that chat,
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
- **Security review of #1353 (applied before merge).** A run in a shared chat whose branch holds a message someone
  other than the maker wrote (`chat/shared-run.ts steerableRun`, from the run's own message up through its parents)
  could be steered by that person, and nobody watches it. Such a run:
  - gets none of the maker's standing yeses (`alwaysHere` null for every kind): the shared read card is never skipped,
    so a place some people there cannot open is not read (H1);
  - sends nothing to any connected service: not a team "send without asking" connection the task's card allowed, not
    its pinned recipients, not anyone's Always allow ("nobody to ask"; H2);
  - writes files only in the task's save folder (while it has not lapsed) and the maker's own folder; a move or rename
    also counts where its sources are (M1).
  When every user message on the branch is the maker's own, nobody else could have steered it, and it runs like any of
  their runs. Also: a teammate's message sent while a run goes waits in the shared chat's queue (409 `shared_chat_busy`,
  the queued sends of #1280); a private task that runs more often than hourly keeps one chat for its runs, one under
  the other; a person has at most 2 scheduled runs queued or running at once (the next occurrence is retried, Run now
  says why: `schedule_too_many`); whether the maker may still continue the shared chat, the allowed addresses and that
  cap are decided inside the turn's admission transaction (L1); a run deletes no task, and a run in a shared chat is not
  told its save folder, places or pinned recipients (L2); the create and edit cards say that each run posts the task's
  instruction and its result in the shared chat, where N people can see it (L3). No shortest interval (the owner's rule).
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
  - A wall-clock time a clock change skips has no cron run that day (it is not that time anywhere). The other kinds,
    the last-day kind included, keep what the first five kinds always did: they run at the shifted time. So a cron
    "L" task and a last-day task differ only when the last day of a month is a clock-change day and the time falls in
    the skipped hour. An interval counts real minutes from its start. `*/1` is the whole field (as `*`), and a range
    has two values (`1-2-3` is refused).
  - Storage: the `repeat` CHECK of migration 203 is not changed (a table rebuild of `schedules` would touch its foreign
    keys). A timing the old columns cannot hold is kept in `schedules.rule` (JSON, migration 426), and the old columns of
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
- **Version impact:** minor (new schedule kinds and tools offered in shared chats; migration 426, additive).
