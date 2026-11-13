# Activity: "Mark all as read" for the tab you are on (QA TC-457)

넣을 곳: Team AX core (`web/src/pages/Activity.tsx`, `server/src/notifications/service.ts`, `shared/src/api/notifications.ts`),
이유: Activity and the notices are core.

Activity (tabs All · DMs · Mentions · Threads) clears notices one click at a time. Add one quiet button that marks every
unread notice of the open tab as read.

## Plan
- **One call, by tab, on the server**: `POST /api/notifications/read` with `{ tab: 'all'|'dms'|'mentions'|'threads',
  only?: 'rooms' }` → `{ read: n }`. It covers notices not loaded yet. The tab rule moves from the page (`inFilter`) to
  shared (`activityTabHas`), so the page and the server use the same rule.
  - All: every unread notice of my own (not suppressed, inside the 30 days) and every unread conversation row.
    `only: 'rooms'` (the phone's 멘션·스레드 page, CHATS_FILTERS): the conversation rows only.
  - DMs / Mentions / Threads: only the conversation rows that the tab shows.
  - Only mine; nothing is deleted; a second call marks nothing (idempotent).
- **A conversation row reads like opening it**: opening a row reads its notices and the room (or thread) up to its
  newest message. Here my read place moves to the row's newest message (`markRead`, or `markThreadRead` for a thread),
  as a notification's "Mark as read" does (`InboxNotification.room.seq`). So the room's unread count, the sidebar, the
  tab dots and the app icon number (attention count) follow; other devices follow through the existing `room.read`,
  `room.thread` and `notifications.changed` events.
- **UI**: a small text button "Mark all as read" in the tools row (after Unreads, at the end of the row), only while the
  open tab has something unread (loaded rows, or for All the unread count). Disabled while the call runs. Shown read at
  once, then read again. Phone 390: fits the row with Unreads and the gear. The conversations page (CHATS_FILTERS) gets
  it too (`only: 'rooms'`).
- 5 languages, English first; Korean short 해요체.
- Tests: server (only that tab's notices, only mine, idempotent, rooms read), web unit (button shown/hidden, the call,
  rows and dots read), e2e on the Activity tabs spec (button at 1440 and 390). Screenshots 1440 + 390, light and dark.
- `changes/activity-mark-all-read.md`.
