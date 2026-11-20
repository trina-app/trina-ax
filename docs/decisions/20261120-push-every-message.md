# A phone push for every message, and an icon number that counts messages

- Date: 2026-11-20
- Status: accepted
- Supersedes: "one notice per unread run" in "대화방 v1" (Notices: a DM message or an @mention) and the later sections that
  repeat it ("대화방 알림 설정", "알림함의 대화 알림"); "each once" for rooms in "Session markers" (One count n) and in
  "휴대폰 앱 아이콘의 숫자" (Which number). Neither was an owner decision.
- Branch: fix/push-every-message (the owner, QA TC-5585, TC-5586)

- **Ask:** the owner, on a real iPhone (app 1.0.9, team server 0.5.21): when one person sends five messages in a row,
  only the first one notifies; messages 2 to 5 give no notification. And after five messages the app icon shows 1, not
  5. Expected: Slack and KakaoTalk, where every new message from someone else alerts (grouped under the conversation
  is fine) and the icon counts unread messages.
- **Cause (push):** `Notifications.roomNotice` made no second notice of a kind and place while one was still unread
  ("one per unread run"), so a burst was one notice and one push. Reproduced on a private copy of the QA team with a mock
  gateway: five DMs, one `/v1/send`. Not the gateway (its dedupe and `apns-collapse-id` are per notice, its limits 20
  a minute and 200 a day per device) and not the iPhone app (the notification extension always hands the notification
  on; it sets the room as its thread).
- **Cause (icon):** the one count n added each room that wants me once, whatever its unread number.
- **Rule: every message that alerts the person is a notice of its own and a push of its own.** The level, mute, quiet
  hours, "only when away" and the reading rules are unchanged: a message the person's level does not alert for makes
  nothing, reading the room reads all of its notices (and cancels pushes still waiting), and the phone push waits or
  is cancelled while the person is at the computer as before. The iPhone groups them under the room (the extension's
  `threadIdentifier`); each has its own id, so its own `apns-collapse-id`. The Inbox already makes one row of a place's
  unread notices (rooms/inbox.ts `roomRows`), so it shows the same rows. Quiet notices (made inside quiet hours, never
  pushed) stay one per unread run.
- **Rule: n counts unread messages.** A room that wants me (`roomWantsMe`, unchanged) adds its row's number
  (`roomCounts(..).number`), at least 1 (a mention only inside a thread). AI chats still count once each. n is the tab
  title, the Mac Dock, an installed web app's icon and the phone app's icon (the server's push badge), so all of them
  now go up with each message, and the icon still never shows a number with nothing marked in the list.
- **Left as is:** the gateway's per-device limits (20 a minute, 200 a day): a very busy person can now reach them; a
  push over the limit is answered 429 and retried by the server. Raising them is a gateway deploy.
- **Tests:** tests/unit/b-push-every-message.test.ts (five DMs, five notices and five pushes with their own ids, the
  badge going up; reading cancels the rest; quiet hours stay one notice), the updated run tests in b-rooms, b-rooms-
  threads, b-rooms-inbox, push-label, and tests/unit/push-badge.test.ts, web/test/unit/room-counts.test.tsx.
- **Version impact:** patch. Needs the team server only (no gateway deploy, no phone app release).
