# Connectors offer a service's conversation app: "Add to a conversation"

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/connector-card-room-apps (the owner, QA TC-3515)

- **Ask:** people who want "connect Sentry" open Settings › Connectors, find Sentry's AI connector and never find the
  conversation app, which was only in a conversation's ⋯ ("Add an app"). Add exactly one more way in.
- **Rule:** a listed connector whose service also has a conversation app gets one text action under its row, in Your
  connectors and in Discover: **Add to a conversation** (ko **대화방에 앱 추가**). The pairs are one map,
  `ROOM_APP_FOR_CATALOG` in shared/src/api/room-apps.ts (Sentry, Notion, Stripe, Atlassian → Jira); no list is copied.
  It opens a picker (the app's Modal and ListRow) of the conversations where the person may add apps, newest first,
  hidden and closed 1:1s left out. The rule is the server's `mayManageApps`, sent on every room as the optional
  `Room.canManageApps` (team rooms and Everyone: owners and admins; 1:1 and group chats: anyone in them; never a
  guest); the web's `mayManageApps` reads it and falls back to its old copy for an older server. Picking one opens the
  conversation at `?apps=add:<service>`: the Add an app dialog on that service's guide, the picker under it (Back). An
  older build opens the dialog's first screen. Nothing is added until Copy, as before. With no such conversation the
  action shows one line under the row ("Start one with New conversation in Conversations"), no dialog. Guests get no
  action.
- **Words:** the conversation menu's "Add an app" (Slack's terms, docs/DECISIONS.md "Apps posting in rooms"), so the
  action says "app" too: **Add to a conversation** (ko **대화방에 앱 추가**), the picker **Choose a conversation** (ko
  **앱을 추가할 대화방 고르기**). An earlier draft said "Get updates in a conversation"; the owner asked for the same word as
  the menu (2026-11-16).
- **Left out:** a composer "+" item, a sidebar "Apps" entry, admin buttons (the owner said no). Services that are not AI
  connectors here (GitHub, Google Forms, Typeform, ...) have no connector row to carry it. A member is not told which
  team rooms an admin could add the app to.
- Tests: unit `b-room-apps-perms.test.ts` "the rooms list says where each person may add apps" (each flag checked
  against the apps route, guest, demotion); e2e `connector-room-apps.spec.ts` (member vs admin lists, Sentry and Jira
  guides, nothing added, the empty line; 1440 and 390).
- Version impact: **minor** (a new entry and an optional field on the rooms list).
