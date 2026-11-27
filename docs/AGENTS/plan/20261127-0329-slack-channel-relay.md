# Slack channel relay: one Slack channel and one Trina conversation, both ways

- Date (UTC): 2026-11-27 03:29
- Branch: `feat/slack-channel-relay` (this plan: `plan/slack-channel-relay`)
- Status: draft (research and plan only; the open decisions at the end are for the owner)
- Where: trina-ax `server/src/integrations/slack/`, `server/src/rooms/apps/`, `shared/src/api/room-apps.ts`, the web room
  apps dialog; the hosting service's Slack broker (trina-cloud `src/slack-broker/`) and its contract
  `shared/src/cloud-protocol/slack-broker.ts` (MIT). Why: the relay is a room app that uses the Slack connector the team
  already set up (docs/REPOSITORY-RULES.md).
- Version impact: **minor**. A new feature, off until someone connects a channel. It needs an add-only migration, optional
  API fields and one new broker operation.

## Goal

Teams like ours cannot leave Slack, because their clients talk to them there. The owner: "이걸 릴레이 해주는 앱을 하나
만들까", "UX가 편해야해". Connect **one Slack channel** (often a client's, a Slack Connect channel) to **one Trina
conversation**. What people write in Slack shows up in the conversation as it happens. What people write in the
conversation goes back to the Slack channel under their own name. The team works in Trina, with its files and the AI
beside the conversation, and the client stays in Slack and notices no change.

It works like a Slack shared channel, but the other side is a Trina conversation.

## What Slack allows (research 2026-11-27, Slack's own docs)

Each line is marked **verified**, with its source, or **unknown**.

### 1. Scopes, events, reinstall

| Need | Scope / event | Have it today? |
| --- | --- | --- |
| Messages in a linked public / private channel | events `message.channels` (scope `channels:history`), `message.groups` (`groups:history`) | Scopes yes (reading, since 2026-11-13); events no |
| Bot removed from the channel | events `channel_left` (`channels:read`), `group_left` (`groups:read`) | Scopes yes; events no |
| Channel deleted, renamed, shared with another organization | `channel_deleted`, `channel_rename`, `channel_shared` / `channel_unshared` (`channels:read` / `groups:read`); `channel_id_changed` (no scope) | Scopes yes; events no |
| Post as "Mina (Trina)" with Mina's picture | **`chat:write.customize`** (needs `chat:write`); `chat.postMessage` `username` + `icon_url` | **No: a new scope** |
| Edit / delete our own posts | `chat.update`, `chat.delete` (`chat:write`) | Yes |
| Reactions, files (later) | `reactions:read` / `files:read` | No (not in v1) |

- **Verified:** a new scope reaches an existing install only after that workspace re-runs OAuth. Updating the app
  "does not modify OAuth tokens that have already been issued to workspaces", and an event that needs a scope the
  workspace has not granted "won't fire until that team reinstalls"
  (https://docs.slack.dev/app-management/distribution#when-to-reinstall,
  https://docs.slack.dev/authentication/installing-with-oauth: scopes are additive).
- **Verified:** changes to event subscriptions "immediately take effect", and an added event whose scope the install
  already has starts delivering at once; only an event that needs a new scope waits for each install to grant it
  (https://docs.slack.dev/apis/events-api/, https://docs.slack.dev/app-management/distribution: reinstall for "event
  subscriptions (if those events require additional scopes)"). So `message.channels` / `message.groups` start for every
  install that already has the reading scopes. QA still sees it once on the test workspace.
- **Verified:** for an app made from a manifest (a team's own app), adding scopes "only take[s] effect for existing
  installs after workspaces reinstall your app"
  (https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests). `apps.manifest.update` answers
  `permissions_updated` (https://docs.slack.dev/reference/methods/apps.manifest.update). Our own-app teams paste their
  tokens and give us no configuration token, so they add the scope and events by hand.
- **Verified:** a Slack Marketplace-listed app's live version is locked. A scope change is resubmitted, which takes
  "6 weeks for published apps resubmitting changes", and scopes are approved only for features that exist
  (https://docs.slack.dev/slack-marketplace/slack-marketplace-review-guide). Our app is not listed yet
  (`MYCEL_SLACK_OFFICIAL_LISTED` is off), so adding the scope before the listing goes in costs nothing extra.
- **Verified:** `username`/`icon_url` "should only [be used] in response to an inciting user action"
  (https://docs.slack.dev/reference/methods/chat.postMessage). A person writing in the conversation is that action. The
  Marketplace says "DON'T impersonate a user" and "DO clearly attribute app actions to a user"
  (https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/), so the name always
  carries "(Trina)". **Unknown:** whether Slack still shows the "APP" badge next to a custom name. We expect it to; QA
  checks.
- **Verified:** limits. Events are capped at 30,000 per workspace per app per hour, and past that Slack sends
  `app_rate_limited`. `chat.postMessage` allows 1 message a second per channel, with short bursts
  (https://docs.slack.dev/apis/web-api/rate-limits). Without the Marketplace, `conversations.history` and
  `conversations.replies` are limited to 1 call a minute and 15 messages. That limits catch-up, not events
  (https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps).
- **Verified:** not every `message` subtype is delivered by the Events API, and an edit does not carry the original
  text (https://docs.slack.dev/reference/events/message). **Verified:** `message_changed` is an Events API subtype under
  the `channels:history` / `groups:history` scopes, with the new `message` and its `edited` field, no previous text
  (https://docs.slack.dev/reference/events/message/message_changed). `message_deleted` is expected the same way; QA
  checks.
- **Verified:** delivery is best effort. Slack retries an unacknowledged event 3 times (at once, after 1 minute, after 5
  minutes) and then drops it, unless the app turns on Delayed Events (https://docs.slack.dev/apis/events-api/). So a
  broker outage of more than about 6 minutes loses events at Slack; the broker's 30-minute queue only covers a team
  server that is down while the broker is up.

**Verdict 1.** The official app needs **one new scope**, `chat:write.customize`, plus new event subscriptions on the
app. Every workspace that already added the app has to press **Add to Slack** once more, only for the "Mina (Trina)"
name. Without that press, receiving still works (the history scopes are already granted). Replies then go
out as the app, with the person's name as the first words, so nothing breaks while a team has not re-added it. Our
broker builds the authorize URL from `SLACK_BROKER_BOT_SCOPES` and refuses a grant that lacks any of them
(`broker.ts` `missing_scope`); the team server refuses one that lacks any of `BASE_BOT_SCOPES` (`service.ts`). So the new
scope is **requested** at every Add to Slack (it joins the authorize URL's list) but **required by neither** check: a new
constant `SLACK_BROKER_RELAY_BOT_SCOPES`, appended to the authorize list and left out of both checks, in the contract
and the CP repo's vendored copy. A team's own app gets an updated manifest. Existing own apps add one scope and the
events of step 3 by hand and reinstall, using the "Update Slack permissions" flow that already exists (SLACK.md), which
gets a relay line.

### 2. Slack Connect (a channel shared with another company)

- **Verified:** an app works in a Slack Connect channel and receives the external people's messages: "Your app will
  receive messages and events from users on external teams". Only the installing side has to add it. Slash commands and
  shortcuts need the other side's own install, and we use neither (https://docs.slack.dev/apis/slack-connect/).
- **Verified:** "No duplicated event triggering between shared channels". When both companies installed the app there
  can be several bot copies, the event's `authorizations` names one install, and `apps.event.authorizations.list` gives
  them all (same page). **Verified:** "The `team_id` property on the event's outer payload will mirror the first
  element in the `authorized_users` array" (same page), so the outer `team_id` is whichever install Slack picked, not
  necessarily ours. The broker routes by that `team_id` (`router.ts` `installOfWorkspace`) and refuses an event whose
  `authorizations[].team_id` differs (`mismatch`). With two Trina teams in one channel, one team never gets the
  channel's events. The broker must route a linked channel's event by **channel**, to every install that linked it and
  whose own bot the broker has verified is in that channel (step 4: a channel id a server names is never trusted alone).
  It gets a broker test with two installs.
- **Verified:** `users.info` works for people of the other company, without their locale, and `users:read.email` is
  needed for an e-mail, which we do not need (same page). Their names and pictures come from `users.info` (or the
  event's `user_profile`).
- **Partly verified:** `chat.postMessage` "cannot [be used] with a `username` set to a foreign user" (same page).
  "Mina (Trina)" is not a foreign user's name. **Unknown:** whether `username`/`icon_url` work as usual in a Slack
  Connect channel. QA checks on the test workspace before release. If they do not, the reply goes out as the app with
  the name first, the same as without the scope.
- **Verified (help center):** "Only people from the organization that added an app can remove it from a channel", and
  "people in the channel can see messages from bots and apps". An app of the other company shows that company's icon
  (https://slack.com/help/articles/115004151203). Adding apps is part of the "Permission to post, invite, and more"
  level of a Slack Connect channel (https://slack.com/help/articles/1500012572621).
- **Unknown:** whether the other company's admin can block a third-party app in a shared channel, or hide its
  messages from their people. No help article found. The plan treats it as possible: if our posts are refused, the
  room says so (state "Slack refused the post").

**Verdict 2.** It works in Slack Connect by the docs, and only our side installs. Three things are checked live before
release: the custom name there, two Trina teams in one channel, and edit/delete events.

### 3. Privacy and Slack's terms

- **Verified, Slack API Terms** (https://slack.com/terms-of-service/api, effective 2025-10-10):
  - You "must obtain explicit authorization from the organization installing your Application" to use, process and
    store API Data.
  - Keep use and retention to what is needed, and "maintain a user agreement and privacy policy".
  - An app offered to other organizations may not "use API Data to train a large language model", may not "bulk export
    Slack message and file data except where expressly allowed", and may not "use data collected from one organization
    to directly benefit a different organization".
  - The relay keeps one linked channel's messages, for that team only. Linking a channel is an explicit act by that
    team's admin, after a sentence that says what is kept, and it is audited.
- **Verified, Marketplace guidelines:**
  - A privacy policy must say "how long data is kept" and how people get or delete their data.
  - The zero-copy rule ("don't store any Slack data") is for apps using Slack's Agent/Assistant UI. Ours does not, so
    the line in docs/SLACK.md "AI apps do not store Slack data" should be corrected when this is built.
  - **Risks for the listing:** apps that "export or backup message data" or "replicate Slack client functionality, or
    are third-party Slack clients" are named as unsuitable, and "an app should not expose messages/files to anyone who
    would not have access to them in Slack".
  - A two-way relay of one channel is close to that line. Owner decision 1.
- **Verified, commercial distribution:** the API Terms say an app may not be commercially distributed unless Slack
  authorizes it (a Marketplace listing or a partner agreement). That already applies to the official app today and is
  not new with the relay, but the relay raises the stakes of the listing.
- **Verified, API Terms, "Restrictions"** (same page; this is the binding text, not only a Marketplace guideline):
  an app may not "undermine[] the Services' access controls, such as by exposing private channel data to a user
  without access", nor "access our APIs in order to replicate or compete with the Services". The first decides who may
  see a relayed private or Slack Connect channel (decision 3). The second is the real risk of the whole feature: a
  two-way relay into Trina's own team chat can be read as replicating Slack. It goes to the owner with decision 1.

**Verdict 3.** Slack does not forbid it outright, as long as the installing team authorizes it, we keep only the linked
channel, we do not train on it, nobody in Trina reads a private channel they cannot read in Slack, and the privacy
policy says how long it is kept. The "replicate or compete" line stays a judgment call for the owner. Two changes
follow. First, the people-who-can-see rule below (decision 3). Second, one new bullet in the privacy policy (trina-ax-website `src/legal/privacy.en.md`,
the list under "This policy does not cover the content inside a customer's Trina AX server"). Today the policy says
nothing about the Slack broker at all, though it already relays mentions and DMs:

> If your team adds our Slack app, Slack sends to our Slack service the messages your team's server needs: questions
> and direct messages to the app, and the messages of any Slack channel your team linked to a Trina AX conversation,
> with the sender's Slack name and picture. We pass each one only to your team's server and delete it once that server
> has taken it (at most 30 minutes). Your server keeps a linked channel's messages as messages of that conversation,
> like the rest of your content: a message deleted in Slack is deleted there too, and your team can remove them. A
> Slack app your team makes itself connects straight to your server; we see none of it.

It goes into the other five languages with it, through the website's own PR.

## Recommended UX (lean)

- **Where:** the conversation's menu › **Add an app** › **Slack** (the room apps list we already have). One row:
  "Slack 채널 연결". Nothing in Admin in v1 (cut: the read-only "Linked channels: n" line; the audit log has the links).
- **Who:** the people who manage the conversation's apps today (in a team conversation or a project, its owners and
  admins who are in it). They also need their own Slack account linked and must be in that channel themselves, which is
  checked with `users.conversations`, as reading does. So nobody pipes in a channel they cannot see. v1: team
  conversations and projects only (no 1:1, group chat or everyone room).
- **Who sees (Slack's API Terms, decision 3):** every person in the conversation must be able to read the channel in
  Slack: for a private or Slack Connect channel, linked and in the channel; for a public channel of our own workspace,
  linked (any workspace member can open it). Guests count like everyone else (not linked, so a conversation with a
  guest cannot be linked). This is usually true for our target, a team that already talks to the client in that
  channel. Checked at Connect, when someone joins the conversation, and when Slack says someone left the channel.
- **Connecting** is one dialog:
  0. Not linked to Slack yet: the dialog's only content is **Sign in with Slack** (the existing flow), and it comes
     back to this dialog. No trip to Settings.
  1. Pick a channel from the channels you and @trina-ax are both in. Under the list: "Channel not here? Invite the app
     in Slack: /invite @trina-ax".
  2. Read one sentence: "Everyone in this conversation will see this channel's messages from now on, and what you write
     here goes to Slack under your name". A Slack Connect channel adds "(shared with <company>)".
  3. Press **Connect**. If someone in the conversation cannot read the channel in Slack, Connect stays off and one line
     names them: "Raka isn't in #client-acme in Slack. Add them there, or ask them to link Slack." (names only, from
     people the connecting person already sees in the conversation).
  Nothing else to set. One channel per conversation, one conversation per channel.
- **In the room** a Slack message shows the sender's Slack name and picture with a small Slack mark, never as a team
  member. Slack threads are Trina threads. A Slack @mention of a linked person is a Trina mention (they are notified).
  A file shows as its name with "Open in Slack". Edits and deletes follow. The room header shows a small "#client-acme ·
  Slack" chip, which opens the status.
- **In Slack** a Trina message is "Mina (Trina)" (with the new scope; the app's icon in v1, Mina's picture later). Without the scope, or when
  Slack refuses the custom name, it goes out as the app with "Mina:" first. Replies in a Trina thread go to the Slack
  thread, and edits and deletes follow. Linking to Slack is **not** needed to reply. A person who is not linked writes
  as usual, and nothing changes for them.
- **The composer** of a linked conversation says, in its placeholder, "Message #client-acme (also sent to Slack)", and
  the thread composer says "Reply (also sent to Slack)". That way nobody is surprised a client reads a thread reply.
- **What goes to Slack:** a person's own text (with its thread, edits and deletes). Not in v1, each marked on that
  message only with a small "Not sent to Slack": a message that carries an AI answer (대화방에 보내기,
  `shareAnswerToRoom`, and the AI's `post_to_room`: the existing Post to channel decision keeps answers out of Slack
  Connect), a message's attached files (the text goes, "1 file not sent to Slack"), event lines and other apps' cards.
  To send an answer, the person copies what they want into their own message.
- **Threads from before the link:** a Slack reply whose parent was never relayed comes in as a normal message with
  "Reply in a Slack thread · Open in Slack"; a Trina reply to a message that was never sent to Slack goes to the channel
  as a normal message, quoting the first line of its parent.
- **The AI:** there is no @트리나 in rooms (side chat only). The ✦ side chat reads the relayed messages like any room
  message, as outside words (APP_DATA_NOTE names Slack). A `@trina-ax` mention in a linked channel is relayed like
  any message and is also answered in Slack as today (two separate things; the relay drops nothing for it).

## States (what people see)

| State | In the conversation | In the dialog / Admin |
| --- | --- | --- |
| Slack not added to the team | "Add an app › Slack" says "Ask an admin to add Slack first" (an admin gets the link to Admin › Connected apps › Slack) | — |
| Connecting | Dialog: the channel list loads; Connect waits for Slack (`conversations.info`) | — |
| Connecting person not linked to Slack | — | Dialog shows only **Sign in with Slack**, then returns to the dialog |
| Someone in the conversation can't read the channel in Slack | — | Connect off, one line naming them (see Connecting) |
| Connected | Event line "Mina connected #client-acme (Slack)"; header chip | — |
| Someone joins the conversation who can't read the channel (or leaves it in Slack) | Line "Slack messages paused: Raka can't read #client-acme in Slack"; chip grey; Trina → Slack still works | Chip status names what fixes it; **Disconnect** |
| New scope missing (official app added before this) | Works; Slack shows the app's name with "Mina:" first | Admins see "Add to Slack again to post with each person's name" |
| Bot removed from the channel (`channel_left`/`group_left`) | Line "Slack: the app was removed from #client-acme. Messages stop. Invite it again with /invite @trina-ax"; sending works in Trina only | Status line says the same, with **Disconnect** |
| Channel archived / deleted | Line "#client-acme was archived in Slack"; the link ends | — |
| Channel becomes shared with another company (`channel_shared`) | Line "#client-acme is now shared with <company>"; the relay goes on (decision 3) | — |
| Slack token revoked / app removed from the workspace | Line "Slack was disconnected for the team. Messages stop." (existing lifecycle) | Existing "Add to Slack again" |
| Team server or broker unreachable, or the own app's socket down | Nothing while it lasts (no grey "delayed" chip: cut). Afterwards the server catches up once per linked channel (`conversations.history` from the last relayed `ts`, 15 messages, Slack's limit). More than that: one line "Some Slack messages may be missing. Open in Slack" | Existing "can't reach the hosting service" |
| A post refused by Slack (other company's policy, not in channel) | The Trina message gets a small "Not sent to Slack" with **Retry**; rate limits (429) retry by themselves and show nothing. `not_in_channel`, `channel_not_found`, `is_archived` end or pause the link (the rows above), whatever event did or did not arrive | — |
| Slack's 30,000 events an hour (`app_rate_limited`) | The "may be missing" line, once | — |
| Disconnect (by a manager) | Line "Mina disconnected #client-acme"; history stays in the conversation | — |

## Loop prevention

A message that came **from** Slack is never sent **to** Slack, so the relay cannot echo by design. Events carrying our
own install's `bot_id` or bot user are dropped. Today both the broker (`router.ts` `ignoredByTeam`) and the server
(`service.ts` `onEnvelope`) drop **every** message with a `subtype` or any `bot_id`; for a linked channel's
`message` events that rule changes to: drop our own bot only; keep `message_changed`, `message_deleted`, `file_share`,
`thread_broadcast`; relay other apps' and bots' messages (another company's alerts, another Trina team's posts) as
outside messages. Mentions and DMs keep the old rule. Each relayed message stores its `(channel, ts)` pair, so a repeat or a
retry is posted once. Each sent message stores the `ts` Slack gave back, so its own echo event is matched and dropped.
With two Trina teams in one channel, each sees the other's "Mina (Trina)" posts as an outside app's messages. Those came
from Slack and are not sent back, so there is no loop.

## Scope

In (v1):
- Two-way relay of text, threads, edits and deletes, for one channel ↔ one team conversation or project.
- Slack mentions of linked people become Trina mentions.
- File names with "Open in Slack".
- The states above.
- The broker forwards only linked channels' message events.
- Own app manifest and the "Update Slack permissions" line.

Cut from v1 (review 2026-11-27, to ship sooner and keep the UI lean):
- Each person's picture in Slack (step 6's public avatar address, a new unauthenticated endpoint). v1 posts
  "Mina (Trina)" with the app's icon.
- The Admin "Linked channels: n" line, and the grey "Slack is delayed" chip state.
- Relaying AI answers and files out (marked per message instead of a room-level notice).

Out (later):
- Reactions (`reactions:read`).
- Files both ways (`files:read`, `files:write`).
- Back-filling history from before the link (limited to 15 messages a minute until listed).
- Relaying AI answers, behind the existing "Post to channel" check.
- 1:1 and group chats.
- Several channels into one conversation.
- Slack Connect admin controls.
- Read receipts, typing indicators and Slack's emoji in names.

## Steps

1. **Contract** (`shared/src/api/room-apps.ts`, `shared/src/api/rooms.ts`, `shared/src/api/slack.ts`):
   - A preset `slack` on kind `other`, so older clients see an Other app (as with Email).
   - A relayed message is an app message with an optional `slackAuthor { name, avatarUrl, external, permalink }`.
   - A Trina message gets an optional `slackSent: 'ok' | 'failed' | 'not_relayed'`.
   - The link's state on the app.
2. **Migration** (the next free number on `dev` at build time; today's highest is 703):
   - `slack_relay_links (room_id unique, app_id, channel_id unique, channel_name, ext_shared, state, created_by, …)`.
   - `slack_relay_messages (room_message_id, channel_id, ts, thread_ts, direction)` with unique `(channel_id, ts)`.
3. **Manifest and scopes** (`manifest.ts`, the broker contract):
   - `chat:write.customize` is in `SLACK_BROKER_RELAY_BOT_SCOPES`: added to the authorize URL's scope list, required
     neither by the broker's redeem check nor by the team server's `BASE_BOT_SCOPES` check (Verdict 1).
   - Bot events add `message.channels`, `message.groups`, `channel_left`, `group_left`, `channel_deleted`,
     `channel_archive`, `channel_rename`, `channel_shared`, `channel_unshared`, `channel_id_changed`.
   - Private channels' own lifecycle events (`group_archive`, `group_rename`, …) are documented for RTM only, so events
     are a hint, never the only source: a post's `not_in_channel` / `channel_not_found` / `is_archived` and a
     `conversations.info` per linked channel at start and every 6 hours decide the link's state (one rule for every
     channel kind).
   - The official app's settings get the same list in Slack (done by the operator, written in docs/SLACK.md).
4. **Broker** (trina-cloud):
   - A new signed operation, `relay/channels { channels }`, through which a team server tells the broker its linked
     channel ids (up to 50, sent again at every change and at start).
   - **The broker never trusts a channel id alone.** For each id it calls `conversations.info` with **that install's
     own bot token** and keeps the id only while that bot `is_member`; `channel_left` / `group_left` for that bot, or a
     failed recheck, removes it. Without this, any registered server could name another company's channel and receive
     its messages. Refused ids come back in the answer (`not_member`).
   - `routeEnvelope` queues a `message` event of a linked channel (subtypes `message_changed`, `message_deleted`,
     `file_share`, `thread_broadcast` included) and the channel lifecycle events. It drops every other channel's
     messages without keeping them (data minimization).
   - A linked channel's `message` event is routed by its **channel**, to each install whose verified list has it, not
     by the outer `team_id` (which mirrors whichever install Slack picked) and without the `authorizations` `mismatch`
     rule; mentions, DMs, buttons and lifecycle keep today's routing.
   - `ignoredByTeam` keeps the linked channel's edit, delete, file and broadcast subtypes and other bots' messages
     (Loop prevention); it still drops this install's own bot.
   - The queue (`QUEUE_MAX` 500 per owner, shared with mentions) drops the oldest when full: the poll answer says how
     many were dropped since the last poll, so the server shows the "may be missing" line instead of guessing.
   - Each relayed message to a sleeping hosted server wakes it (`requestWake`), as a mention does today: expected, noted
     in docs/slack-broker.md.
   - Test: two installs, one Slack Connect channel; a server naming a channel its bot is not in gets nothing.
5. **Server relay** (`server/src/integrations/slack/relay.ts`, new):
   - Inbound: check the envelope strictly (`envelope.ts`), resolve the name and picture (`users.info`, kept in memory
     10 minutes), turn Slack mrkdwn into plain text with mentions resolved, then post through the room apps path
     (`rooms/apps/service.ts`), without the 500-a-day app cap, under its own cap of 5,000 a day per link.
   - Inbound visibility: before storing, the "who sees" rule (Recommended UX) must hold for the conversation now;
     otherwise the message is not stored and the link shows "paused" (a Slack message is never kept for a room where
     someone cannot read it in Slack).
   - Outbound: on a person's own room message (not one that carries an AI answer, not an event line), send
     `chat.postMessage` with `username` "<name> (<PRODUCT.displayName>)" and `thread_ts`, as rich text that never
     mentions `@channel`; a Trina mention of a linked person becomes `<@U…>`. Also edits and deletes. The queue sends 1
     a second per channel and honours 429.
   - Catch-up after a gap (server restart, broker or socket outage, `dropped` > 0): one `conversations.history` per
     linked channel from the last relayed `ts` (15 messages, 1 a minute until listed), then the "may be missing" line if
     Slack says `has_more`.
6. **(Later, cut from v1) Picture URL for Slack:** a signed, unguessable public URL on the team's address for a
   person's avatar (no sign-in), valid while the person is active. v1 sends no `icon_url` (the app's icon).
7. **Web:**
   - The Slack row in Add an app, with the one-dialog connect.
   - The header chip and status.
   - `slackAuthor` rendering with the Slack mark.
   - The composer placeholder, "Not sent to Slack" with Retry, and the event lines.
   - All five languages (en.ts first).
8. **Docs:**
   - docs/SLACK.md: a "Channel relay" section, the scope table, "What is kept" with the relayed messages, and a
     correction of the zero-copy line.
   - docs/CONNECTIONS.md: the Slack and Room apps rows.
   - docs/ASKS.md: the connect sentence.
   - A decision file `docs/decisions/<date>-slack-channel-relay.md`, `changes/slack-channel-relay.md`, the docs site
     page `use/slack.md`.
9. **Privacy policy:** the bullet above, in the website repo's own PR in six languages, merged before the release that
   ships the relay.

## Decisions

New: `docs/decisions/<YYYYMMDD>-slack-channel-relay.md` (the rules above, plus the owner's answers below). It changes
docs/DECISIONS.md "Slack: reading with the bot token only" (the bot now keeps a linked channel's messages, which that
decision did not) and docs/SLACK.md "What is kept".

Open, for the owner (one recommendation each):

1. **One app or a separate relay app?**
   - *Recommendation: one app (the existing Trina AX app).* One "Add to Slack", one bot to invite.
   - Risk: Slack's Marketplace review may count a two-way relay as "replicating Slack client functionality", and the
     API Terms forbid using the APIs "to replicate or compete with the Services" (that clause binds a second app too,
     so a split does not remove it). If review objects, we split the relay into a second app then, or keep the relay to
     own apps only. The code keeps the relay apart (`relay.ts`, its own scopes and events), so the split costs little.
2. **Who may connect:** *recommendation: the conversation's app managers (owners and admins in team conversations and
   projects), who must also be linked to Slack and be in the channel.* Alternative: any room member, which is easier but
   lets anyone pipe a client channel to everyone in the room.
3. **Who may see:** Slack's API Terms forbid "exposing private channel data to a user without access" (Section 3), so
   the earlier lean option (everyone in the conversation, after one sentence) is not offered for private or Slack
   Connect channels.
   - *Recommendation:* every person in the conversation can read the channel in Slack: linked and in the channel for a
     private or Slack Connect channel, linked for a public channel of our workspace. Checked at Connect and whenever the
     conversation or the channel changes; when it stops holding, Slack messages pause with one line naming who. For the
     target team, which already talks to the client in that channel, this is usually true at once.
   - Alternative (only for public channels of our own workspace): everyone in the conversation, after the connect
     sentence. Not offered for private or shared channels.
4. **When the link ends** (disconnect, channel archived, app removed): *recommendation: keep the relayed history in the
   conversation*, as a Slack shared channel keeps its history; messages deleted in Slack are still deleted. Alternative:
   delete them.
5. **Existing official installs:** *recommendation: do not ask teams to re-add.* Relaying works at once. Admins see one
   quiet line, "Add to Slack again to post with each person's name". Replies go out as the app with the name
   first until then.

## Risks

- **Migrations:** one add-only migration. Check the highest number on `dev` at build time (703 today).
- **Volume:**
  - `message.channels` fires for every channel the bot is in, not only linked ones. The broker filters by linked
    channel, and the server drops anything else before storing it.
  - One busy channel can reach Slack's 30,000 events an hour per workspace, so `app_rate_limited` gets a status line.
- **Security:**
  - Slack text is outside data. It is shown as plain text and is never Markdown with live links (the room apps card
    rule).
  - The connect check uses the connecting person's own Slack membership.
  - A token never leaves the server.
  - The public avatar URL is signed and reveals nothing else.
  - Audit `slack.relay_linked`, `slack.relay_unlinked`, `slack.relay_ended` (reason).
- **Two Trina teams in one Slack Connect channel:** broker routing (step 4). This needs a test with two installs.
- **Unknowns to check live on the Slack test workspace before release:**
  - Delete events through `message.channels` (edits are documented).
  - The custom name and "APP" badge, also in a Slack Connect channel.
  - Events start without a reinstall when the scope is already granted (documented; seen once).
  - Which lifecycle events arrive for a private channel (archive, rename) with the Events API.
- **Clients:** older desktop and phone builds show a relayed message as a "Slack" app message without the sender's
  name. Acceptable until they update; the body could start with the name as a fallback (decide during build).
- **The five app languages**, phone width and dark mode for the dialog, the chip and the message.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`.
- Unit:
  - `tests/unit/c-slack-relay.test.ts` against `tests/lib/fake-slack.ts`, extended with `message.channels`, edits,
    deletes, `channel_left`, `channel_shared` and the `username`/`icon_url` post:
    - Loop prevention.
    - Each relayed message posted once after retries.
    - Threads both ways.
    - Mentions.
    - The states table.
    - The connect check (not in the channel, not linked, guests in the room) and the pause when someone joins who
      cannot read the channel.
    - Catch-up after a gap and the "may be missing" line (broker `dropped`, `has_more`).
    - What is not relayed out: a message carrying an AI answer, attachments, event lines.
  - `tests/unit/c-slack-broker.test.ts` for `relay/channels`.
  - The broker's router tests in trina-cloud (unlinked channel dropped, two installs, a channel the install's bot is
    not in refused at `relay/channels`, edits and other bots kept for linked channels only).
- The permission matrix: `tests/security/lib/slack-cases.ts` and the room apps cases.
- Web: `web/test/unit/room-apps-slack.test.tsx`, plus the full web e2e for the UI.
- QA on qa.trina.app with the Slack test workspace (test data only): every state in the table, at 1440 and 390, both
  themes, all five languages.

## Review (2026-11-27, independent)

Changed in this plan after review: the broker verifies each linked channel with that install's own bot and routes by
channel (blocker: a server could name any channel); who may see follows the API Terms' private-channel clause
(blocker, decision 3); the scope is requested but required by no check; linked channels keep edits, deletes and other
bots at both filters; the outage row matches what Slack and the broker really do (retries, 500 queue, catch-up);
what is not relayed out is marked per message; pre-link threads; inline Sign in with Slack; private-channel lifecycle
from post errors and `conversations.info`; cuts (avatar URL, Admin line, delayed chip); Slack claims re-checked.

## Result

Filled in at the end.
