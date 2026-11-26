# Every notice is in one 활동; 대화 has no 멘션·스레드 row

- Date: 2026-11-26
- Status: accepted
- Supersedes: [Phones: search and 멘션·스레드 on the 대화 tab; each unread counted once](../DECISIONS.md#phones-search-and-멘션스레드-on-the-대화-tab-each-unread-counted-once-featphone-chats-search-activity-2026-11-12-qa-tc-256),
  the 활동 and 대화 parts of [활동, 파일 and 대화 as lists beside the rail](../DECISIONS.md#활동-파일-and-대화-as-lists-beside-the-rail-featnav-rail-rest-2026-11-13-navigation-redesign-p3),
  and the `?in=chats` part of [Activity: the DMs tab is back](../DECISIONS.md#activity-the-dms-tab-is-back-featactivity-dms-tab-back-2026-11-13-the-owner)
- Branch: feat/one-activity (the owner, 2026-11-26)

- **Ask:** the owner asked whether having both 활동 and the 대화 row "멘션·스레드" is right, and whether Slack does
  that. Slack has one Activity with filters. Its Threads view is a separate list of conversations in Home.
- **Rule:**
  - **One list.** 활동 lists every notice: mentions, replies in threads I follow, and the app's own notices.
    - On a computer, the panel beside the rail has the chips 전체 · DM · 멘션 · 스레드 · 트리나 · 요청. 요청 shows for
      the owner and admins, and for a member while an ask of theirs is listed.
    - On a phone it is 나 › 활동, with its tabs 전체 · DM · 멘션 · 스레드.
    - DM, 멘션 and 스레드 use the shared tab rule (`activityTabHas`).
    - "Mark all as read" shows under 전체, DM, 멘션 and 스레드, and reads that tab on the server. It also reads each
      listed room or thread to its newest message. It does not show under 트리나 or 요청, which only the client sorts.
  - **No second copy.** The 대화 panel and the phone's 대화 list have no 멘션·스레드 row, and the scoped page
    `/activity?in=chats` is gone.
    - `/activity?in=chats[&tab=X]` goes to `/activity[?tab=X]`, so nothing 404s.
    - On a computer, `?tab=` picks the panel's chip.
    - A `?in=chats` kept in this browser tab's rail memory or phone tab stack is dropped when it is read.
  - **Counts.**
    - 활동 on the rail, the phone's 나 tab and its 활동 row show every unread notice (`unreadCount`).
    - 대화 shows how many conversations count, and nothing else. There is no dot for notices.
    - So a mention, or a reply in a followed thread, counts on its room and on 활동, as in Slack. A plain message, in a
      DM too, is never a notice: it counts on 대화 alone.
  - **Opening a conversation row** from the computer's 활동 opens its room or thread on the right with 활동 still lit.
    The row stays selected after the room drops its `?m=`.
- **Why:** one notice showed in two lists, under two names, with two counts. Slack keeps one Activity. The "each unread
  counted once" rule (QA TC-256) needed the second list, and with one Activity the notice has one home.
- **Left out:**
  - **A "스레드" list in 대화** (the threads I'm in, as conversations, Slack's Threads view). It needs a new server
    list of followed threads; Activity's 스레드 chip covers their new replies. It comes back as its own plan if asked.
  - **Every DM message as a notice, as in Slack.** That is a server change (`server/src/rooms/inbox.ts` `LISTED_SQL`)
    and would flood 활동's count. The DM chip keeps the rows the server lists today: a direct or group chat's mentions
    and followed-thread replies. Its empty state says plain DMs are in 대화.
  - **A sixth phone tab** for 활동. It stays in 나, two taps away, as the removed row was.
  - The server's `only=rooms|notices` stays for older windows. The new list does not use it.
- **Tests:**
  - Unit: `web/test/unit/activity-panel-one.test.tsx` (new), `rail-panels-p3.test.ts`, `rail.test.ts`,
    `screens.test.ts`, `rail-badges.test.tsx`, `room-counts.test.tsx`, `activity-mark-all.test.tsx`,
    `chat-thread-activity.test.tsx`.
  - e2e: `activity-panel.spec.ts`, `rail.spec.ts`, `chats-panel.spec.ts`, `phone-chats-tab.cases.ts`,
    `activity-mark-all-read.spec.ts` (390 and 1440, light and dark shots with SHOTS=1), `activity-tabs.spec.ts`,
    `inbox-rooms.spec.ts`, `optimistic-rooms.spec.ts`, `lists-cache.spec.ts`.
- **Version impact:** minor. It is a visible navigation and count change, with no API change and no migration.
