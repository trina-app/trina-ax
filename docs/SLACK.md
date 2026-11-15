# Slack connector

People ask the team's AI from Slack: `@trina-ax` in a channel, or a direct message to the app. Each question runs a
normal chat as the person who asked, with their own permissions, engine, budget and usage, and the full answer is also
in that chat in the app. It is off until the team's owner or an admin sets it up; it works on hosted and self-hosted servers alike,
also on an office Mac without a public address (Socket Mode: the server connects out to Slack).

The AI also reads Slack, with the app's bot token only: the thread it is asked in, and for a linked person the threads
and channels the app was invited to and that person is in ("Marketplace-safe reading" below). It never reads Slack as
the person and has no Slack search.

**What it reads, in one line** (Slack's page in Admin › Connected apps says it before the app is added, QA TC-2142):
messages in the channels and threads the app is invited to, other apps' alerts there included (the bot scopes
`channels:history` and `groups:history`). Each answer uses only what the person who asked can open, and nothing outside
the invited channels is read.

Decisions: [DECISIONS.md](DECISIONS.md) "Slack 커넥터", "Slack through the official Trina AX app", "Admins manage
Slack too" and "Slack: reading with the bot token only".

There are two ways to have the Slack app. Where the hosting service serves the server, the owner or an admin adds
**the official app** with one button and copies nothing (below). Anywhere else the owner makes **the team's own app**
from our manifest (the four steps).

**Who.** The owner and admins see Slack in Admin › Connected apps, its state and how many people linked, and can add the
official app, Reconnect it, turn Slack off and on, and remove the official app. Only the owner saves, replaces or
removes the team's own app's tokens: the server refuses an admin there (`PUT /api/admin/slack/tokens` is owner-only;
`DELETE /api/admin/slack` with the own app saved answers 403 `owner_only`), and the page shows an admin one line
instead of the four steps and "Replace tokens". No answer ever carries a token, to anyone. Members have no Admin; each
links their own Slack in Settings › Connectors. Every change is in the audit log with who made it.

## The official app ("Add to Slack")

Slack's page in **Admin › Connected apps** (`/admin/connectors/slack`, the owner's and admins': Slack is one row of that list,
not an Admin menu item of its own; the old `/admin/slack` leads there) shows **Add to Slack** when the hosting service
serves this server (a hosted team, or a self-installed server the hosting service registered, the same rule as Google
sign-in through it) and no own app is saved. Press it, choose your workspace in Slack and allow it: you come back to
Admin › Connected apps › Slack, added and on. Nothing to copy; it works on a phone too. Then **invite the app** to the
channels where people may ask it, `/invite @trina-ax`, as with an own app. *Use your own Slack app instead* opens the
four steps.

- **How it works.** The hosting service holds the one public Slack app "Trina AX": its client secret, and its
  app-level token with the one Socket Mode connection. That token is app-wide (it gets every workspace's events), so
  it never comes to a team server. The hosting service passes on only the events of the workspace this server added
  (questions to the app, DMs, its buttons), through a long poll this server makes (`POST
  /api/slack-broker/v1/poll`, signed with the server's relay team key, at most 25 seconds each; no public address
  needed). Each event goes through the same checks as one from an own app's connection (the workspace and the app id
  added here). The workspace's bot token comes to this server only, sealed to a one-time key of that request, and is
  kept sealed like an own app's tokens; answers go to Slack from here directly.
- **Before the token is kept**, Slack itself is asked whose it is (`auth.test`): it must be the bot of the workspace
  the hosting service named, with every scope. So the hosting service cannot give this server another workspace's bot.
  When Slack cannot be reached for that check (a brief outage), the install is not removed: Slack's page says "Added
  to Slack. It turns on by itself once Slack confirms it.", and the server fetches the token again and checks it
  shortly (for up to 30 minutes; after a restart, press Add to Slack again). Only a definite no removes it there.
- **Only a Slack workspace admin or owner can add it.** The hosting service asks Slack who allowed it (`users.info`);
  anyone else gets "A Slack workspace admin has to add it." and the app is taken off the workspace again (unless the
  workspace is already added here).
- **Only the owner or admin who pressed it finishes it** (still the owner or an admin when the browser comes back). Slack sends the browser to the hosting service, which sends it back
  only to this team's address it recorded (`/api/integrations/slack/official/callback`) with a one-time handoff (10
  minutes, time to sign in here first) that only this flow's verifier redeems. A browser signed in as someone else is refused; one with no session
  is asked to sign in first and then goes on. 10 minutes, used once, the newest only.
- **Sign in with Slack** to link your own account works the same way through the hosting service (its one redirect
  URL is registered in the app): it checks Slack's answer, revokes your Slack user token at once and says only who
  signed in; this server checks that it is a person of this workspace, as before. No https address is needed here.
- **Removed in Slack** (the app removed from the workspace, its token revoked, or the hosting service's operator
  removed it): the token is forgotten here and Slack's page says "The app was removed from Slack. Add it to Slack
  again." People's links stay (the same workspace when it is added again). **Remove Slack** beside Add to Slack takes
  it out of Admin › Connected apps instead, with everyone's links. A token Slack refuses at a post means the
  same. A notice about an earlier install (still waiting at the hosting service when the app was added again) changes
  nothing: the server acts only on the notice of the install it holds.
- **Remove** asks the hosting service to take the app off the workspace, then deletes the token and every person's
  link here, as with an own app. If the hosting service cannot be reached it is removed here anyway (its operator can
  remove the install there). If Slack cannot be asked, the hosting service keeps the install as this team's (no other
  team gets the workspace while its token may still work) until it can end it: add it again, or remove the app in
  Slack.
- **The hosting service down or not serving** this server any more: Slack's page says "can't reach the hosting
  service" or "does not serve this server's Slack now"; polls back off (1 s … 60 s) and resume by themselves. Events
  Slack sent meanwhile wait at the hosting service (up to 30 minutes, while the server polled in the last 10).
- **A restore on a new machine** (the sealed token no longer opens): the server asks the hosting service for it again.
- **One workspace, one team.** A workspace already added for another team is refused ("connected to another team"),
  also while that team is suspended or its server disabled. It is free again once that team removes it, the app is
  removed in Slack, that team is deleted (or its server removed), or the hosting service's operator removes it; each of
  these first makes the old bot token useless at Slack, so the next team gets a fresh one. An organization-wide
  (Enterprise Grid) install is refused too.
- **Server settings.** `MYCEL_SLACK_BROKER_URL` (the console origin, e.g. `https://account.trina.app`; it falls back to
  `MYCEL_GOOGLE_DRIVE_BROKER_URL`, which is the same console; `off` turns the official app off). Without it, or until
  the hosting service answers that it serves this server (asked every minute, every 10 minutes once it does), nothing
  changes: the own app's four steps. An own app saved keeps working; to switch, Remove it and add the official app.

## Setting up the team's own app (the owner)

Admin › Connected apps › Slack is a checklist of four steps; each step's title opens its page in Slack.

1. **Create the app in Slack.** Slack opens "Create an app" with our manifest filled in. Choose your workspace and
   create it. It makes an **internal** app of your workspace only, with Socket Mode on, and with the team's https address
   as its redirect URL for "Sign in with Slack" (`<address>/api/integrations/slack/oauth/callback`). Open this page at
   the team's https address (the one people sign in at); without one, a line says Sign in with Slack needs it.
2. **Install it in the workspace.** *Install App › Install to Workspace*, then copy the **Bot User OAuth Token**.
3. **Make the app token and copy the app credentials.** The server connects to Slack directly with the app token
   (Socket Mode, so nothing has to reach the server): *Basic Information › App-Level Tokens › Generate Token and
   Scopes*, scope `connections:write`. On the same page, *App Credentials*: copy the **Client ID** and **Client
   Secret** (people use them, through the server, to link their own account with "Sign in with Slack").
4. **Paste them and turn on** (*Check and turn on*): the two tokens, the Client ID and the Client Secret. The server
   checks the tokens with Slack (`auth.test`, `apps.connections.open`, `bots.info`): the scopes the bot token has and
   that both tokens are of the same app. A refused value is said under its own field, with the Slack page to fix it,
   until the next try.

Then the page is one status line (Connected / Problem, the workspace, the bot) with one button (Turn off / Turn on), and
while it is on: **invite the app** to the channels where people may ask it, `/invite @trina-ax` (Slack does not tell
the app about mentions in a channel it is not in). A problem names the one place to fix it with its link: the app's own
settings page in Slack (Socket Mode, OAuth & Permissions, Install App, Basic Information) or *Replace tokens* here.

Save the tokens from the address people sign in at (the team's public address): the links the app sends in Slack open
there. The status line shows that address only when it is not the one the page is open at. The server needs to reach
`slack.com` and `wss-*.slack.com` on port 443; nothing has to reach the server.

Turn off closes the connection (links stay). *Replace tokens* opens the four steps again; under them, Remove deletes the
tokens and every person's link (delete the app itself in Slack). Saving tokens of another workspace removes every link
of the old one.

## Using it (everyone)

- **Link with "Sign in with Slack"** (Settings › Connectors, its Slack line, or the link page): the button sends your
  browser to Slack; you sign in to Slack (or are signed in already) and come back, linked. From the desktop app Slack
  opens in your system browser and from the phone app in an in-app browser: if that browser is not signed in here, it
  asks you to sign in first and then finishes; at the end it says you can go back to the app, whose Settings line shows
  the link when you return. Signed in there as someone else, it is refused ("다른 계정으로 로그인돼 있어요"). The Slack account
  you signed in to is the one linked: no e-mail is needed, and nobody else's Slack account can be linked to you, nor
  yours to anybody else. Slack's DM then says which account it is linked to, and every "working…" names the account it
  answers as.
- **The zero-click shortcut**: the first time you ask, the app answers only you ("Only visible to you") with *Connect
  account*. The link opens the app (sign in if needed) and shows the Slack account and your account with its e-mail.
  *Link* works when the e-mail Slack has for that Slack account is the e-mail of your account here (compared without
  case or surrounding spaces). When it is not (or there is none, or someone else set yours in the last 7 days), the page
  says why and offers "Sign in with Slack" instead.
- **In a channel** the answer is shown to you only, with *Post to channel*. Pressing it posts the answer to the thread,
  "Asked by <you>", without the steps, the files it read or the link to your chat. Each answer can be posted once, and
  only by the person who asked.
- **An answer that used places not everyone on the team can see** (a group's folder, your own folder, a team connection
  or shared Drive, the in-app browser, your personal connections, a room): pressing *Post to channel*
  first turns it into a notice, to you only, that names those places as you may see them (never what is in them, never
  who cannot see them), with *Post anyway* and *Cancel*. *Post anyway* posts it after the same checks again (your link,
  Slack Connect asked again, once only); *Cancel* puts the answer back, to you only. Slack does not tell the app who in
  a channel is who here, so the test is the whole team: everything the answer used (in this thread's chat so far,
  file names a listing showed included) must be readable by every active member, or the notice comes. Your personal
  memories do not count (they are your own notes, and you see the very text that is posted). A confidential conversation
  (safe operations) is never posted; the answer says why. A DM has no button and no notice.
- **In a channel shared with another organization** (Slack Connect) there is no *Post to channel*; the answer says why.
  Slack is asked again when the button is pressed.
- **In a DM** the answer comes in the thread of your message (a new message, so Slack notifies you; "working…" goes).
- **Follow-ups**: mention the app again in the same thread (or reply in the DM thread); they continue the same chat.
  A new thread is a new chat.
- **Settings › Connectors** has a Slack line while the team uses Slack: the linked account with *Unlink*, or *Sign
  in with Slack to link* (without it: how to get a link in Slack). After the sign-in, the line says how it went. A
  disabled or deleted account is unlinked at once.
- **When an answer cannot start or fails**, Slack says why in plain words (the chat was deleted, a server problem, the
  budget's own sentence), not a code.

## Marketplace-safe reading

The AI reads Slack with the **bot token only** (decided 2026-11-13, so the official app can be listed in the Slack
Marketplace). Slack's Marketplace rules
([guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements),
[review guide](https://docs.slack.dev/slack-marketplace/slack-marketplace-review-guide)): `search:read` is not allowed;
user token scopes only where the app acts as the person ("submissions where user token scopes are being used
unnecessarily" are returned); `*:history` gets an enhanced review for AI apps, and every scope must trace to a feature a
reviewer can test; AI apps do not store Slack data (keep metadata, read in real time). Slack's real-time search
(`assistant.search.context`, [docs](https://docs.slack.dev/apis/web-api/real-time-search-api)) is only for listed or
internal apps: search waits for phase 2, after listing (no code yet).

- **The thread @app is asked in.** The bot was mentioned there, so it is in that channel: the question's turn gets where
  it was asked (workspace, channel name, thread) and the thread's messages so far, read with the bot token
  (`conversations.replies`: at most 50 messages and 12,000 characters, the first message and the newest, the question
  always last), framed as other people's words. A DM with the app: the bot's own `im:history`.
- **The AI's tools** `slack_read_thread` and `slack_read_channel` (turn tool provider `slack`; never in shared,
  confidential or draft chats), for a linked person while the bot has the reading scopes: only a conversation the bot
  is a member of (`conversations.info` `is_member`; a private channel it is not in is "not found") **and** the linked
  Slack user is a member of (`users.conversations` with the bot token and `user=`: public channels the person is in,
  private ones they share with the bot; a "yes" is kept 2 minutes in memory, a "no" is always asked again), plus the
  person's own DM with the app. A channel by name is looked up among the bot's own channels only. Anything else gets one
  plain answer: "@trina-ax must be invited to that channel first (/invite @trina-ax)", or "the user is not in that
  conversation". Group DMs are never read.
- **No user token, no read sign-in.** "Sign in with Slack" is the OpenID Connect sign-in again (`openid profile` in its
  own flow), only to prove which Slack account is linked; its user token is revoked at once. There is no "Allow reading
  Slack" anywhere. The user tokens the earlier design (#674, migration 348) kept are revoked at Slack (`auth.revoke` with
  each token, best effort) and deleted when the server starts (`SlackConnector.retireUserTokens`; a token Slack could
  not be asked about, or one that does not open at that start, stays sealed for the next start); audited `slack.read_ended` with `reason: bot_only_reading`.
- **Apps from before the reading scopes.** Reading needs the bot scopes `channels:history` and `groups:history`. The
  server keeps what Slack last listed for the bot token (`slack_config.bot_scopes`, from `auth.test`'s X-OAuth-Scopes:
  at save, at install, at start and every 10 minutes, and when Slack answers `missing_scope`). Without them the app
  still answers (they are not required to save the own app's tokens or to take an install), the thread is not read (the
  AI says why) and Admin › Connected apps › Slack shows **Update Slack permissions**: the team's own app: add the two Bot
  Token Scopes in *OAuth & Permissions*, reinstall the app, then **I updated them** (Slack is asked again now; audited
  `slack.read_scopes_recheck`); the official app: **Add to Slack** again. Settings › Connectors › Slack says which it is
  for the person ("can read the channels and threads it was invited to, when you're in them too", or "an admin first
  has to update the Slack app's permissions").
- **Slack's limit for the official app.** Slack limits `conversations.history` and `conversations.replies` to 1
  request a minute and 15 messages for commercially distributed apps that are not in the Slack Marketplace (new
  installs since 2025-05-29; internal customer-built apps keep their limits:
  https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps and
  https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity). The official app is such an app until it is listed:
  the server then reads 15 at a time and tells the AI in words when Slack says wait. The operator sets
  `MYCEL_SLACK_OFFICIAL_LISTED=1` once it is listed (default off); a team's own app is internal and is not limited.
- **Outside content and Post to channel**: Slack messages the AI was shown (a tool's answer, or the thread in its
  instructions) mark the chat as holding other people's words, and count in the chat's read scope as a `slack` source
  (only the reader is known to see it), so saving them where more people can see asks first. *Post to channel* needs no
  notice for messages of the conversation the answer goes back to; any other conversation is named in the notice
  ("Slack #random", "Slack direct messages") with **Post anyway** and **Cancel**.

### What is kept

| What | Where | How long |
| --- | --- | --- |
| The thread's text given with a question from Slack | memory (`SlackConnector.asked`, taken by the next turn of that chat) and that turn's instructions (a file the launcher deletes after the turn) | at most 30 minutes in memory; never in the database. A resumed engine session is sent only where it was asked, not the thread (the message it is sent is kept in its session) |
| What `slack_read_thread` / `slack_read_channel` returned | the AI engine's working session of that chat (its folder on this server, like any tool result) | until the chat's session starts over or the chat is deleted |
| The answer, the question, step labels, tool summaries ("slack_read_thread -> 12 messages") | the chat (database) | as the chat |
| Where Slack was read | the chat's read scope (conversation id, kind, channel name) | as the chat |
| Slack people's names, the conversations a person shares with the bot | memory | 10 / 2 minutes |
| The bot's scopes | `slack_config.bot_scopes` | while Slack is set up |

Not kept: no Slack message in the database, no user token, no search index. The answer the AI writes may quote or sum
up Slack messages (that is the answer the person asked for). Proposal (not built): a Slack chat's engine session could
drop tool results older than its last turn; until then the table above is what is kept.

## Scopes (bot token)

Every scope traces to a feature a reviewer can test (Slack Marketplace review). No user token scopes.

| Scope | Why |
| --- | --- |
| `app_mentions:read` | the `app_mention` event: `@trina-ax` in a channel the app is in |
| `im:history` | the `message.im` event: messages in the app's DM |
| `chat:write` | "working…", answers, the link prompt (ephemeral messages included), posting to the thread |
| `users:read` | the asker's Slack name on the link page and in "Asked by"; refusing bots and people of other workspaces |
| `users:read.email` | the Slack account's e-mail: the zero-click link (the same e-mail on both sides) |
| `im:write` | `conversations.open` for the one DM telling a Slack account which account it was linked to by "Sign in with Slack" |
| `channels:read`, `groups:read` | `conversations.info` just before *Post to channel*: a channel shared with another organization since the question (or one Slack says nothing about) gets nothing; whether the bot is in a channel and its name, the channels a person shares with the bot (`users.conversations`), a channel by its name |
| `channels:history` | the public channel thread `@trina-ax` was asked in, given with the question; `slack_read_thread` / `slack_read_channel` in a public channel the app was invited to and the person is in (test: invite the app, ask "summarize this thread" in a thread) |
| `groups:history` | the same in a private channel the app was invited to and the person is in |

The redirect URL is for "Sign in with Slack" (OpenID Connect; docs.slack.dev "Sign in with Slack"), which asks for
`openid` and `profile` in its own flow: they are not in the app's user scopes (Slack does not let them be asked for
together with other scopes, and the manifest's user scopes are asked for at install). The user token that sign-in gives
the server is revoked at once and never kept. The app-level
token needs `connections:write` (Socket Mode). No user token scopes, no `search:read`, no `mpim:history`, no files, no
slash command.

**The official app (A0CGU1CK47M), its settings in Slack:** Bot Token Scopes add `channels:history` and
`groups:history`; User Token Scopes: remove all ten that #674 added (`channels:history`, `groups:history`,
`im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`, `search:read`), so
none is left. The hosting service's `signin/read/*` calls are gone from the contract (`shared/src/cloud-protocol/slack-broker.ts`);
`SLACK_BROKER_BOT_SCOPES` has the two history scopes, and a team server takes an install without them (reading off).

## Limits

| What | Limit |
| --- | --- |
| Workspaces | one per team server; an organization-wide (Enterprise Grid) install is refused |
| Who can ask | linked people of the installed workspace; people of another workspace in a shared channel (Slack Connect) and bots are not answered; no link while Slack cannot say who is asking |
| One-time link | 10 minutes, used once, the newest one only, 10 per Slack account per hour, one a minute |
| Links | one Slack account per person, one person per Slack account; by "Sign in with Slack", or by the one-time link when the e-mails match |
| Sign in with Slack | 10 minutes, used once, the newest one only, 20 a person per hour; needs the team's https address |
| What the AI gets | the question, where it was asked, and the thread so far (bot token, with the reading scopes): at most 50 messages and 12,000 characters; more with `slack_read_thread`; no files |
| What the AI may read | only conversations the app was invited to and the person is in, and the person's DM with the app; no search |
| Reading (official app, not listed) | Slack's limit for non-Marketplace apps: a conversation's history about once a minute, 15 messages at a time |
| Answer in Slack | shortened to about 11,000 characters, with a link to the whole answer in the chat; posted to a thread: about 29,000 |
| Waiting for an answer | 2 hours, then the asker is told (the chat keeps a later answer); a turn that waits for a card (a question of the AI, a confirmation) tells the asker to answer it in the app |
| Ephemeral messages | Slack does not keep them (they are gone after a reload) and delivers them only to people in the channel; the chat in the app keeps the answer |

Slack sends an event again when it is not acknowledged within 3 seconds: the server acknowledges each one at once and
handles an event id, or a message, only once (also after a restart). Slack's rate limits (429) are waited out and the
answer is sent again at the next try. Slack renews the connection every few hours; a lost connection is opened again
after 1, 2, 4 … seconds (at most a minute).

## Security

- The tokens and the client secret are sealed in the browser (`slack.token`), opened only by the server and kept
  AES-256-GCM encrypted with their own key directory `<secrets>/integrations/slack` (owned by the server account,
  0700). No response, log line, audit entry, engine or chat ever gets them; the screen only knows whether they are
  saved. The client id is not a secret.
- "Sign in with Slack": the state and nonce are random and stored hashed, bound to the person who started it, 10
  minutes, used once; only a browser signed in as that person finishes it (another person's session refuses and ends
  it; a browser with no session is sent to sign in, and only to the fixed return page with the state and the code). The server exchanges the code itself (`openid.connect.token` with the
  client secret, over TLS) and checks the id_token's issuer (`https://slack.com`), audience (the client id), time and
  nonce; the Slack user and workspace it names must be of this workspace and a person (`users.info`).
- Who asked comes from Slack's own event (workspace, organization and user ids), never from the message text. Socket
  Mode needs no request signature; every envelope is checked against strict shapes, the workspace and the app id saved
  with the tokens (nothing is handled while the app id is unknown).
- An answer goes out only while the Slack account is still linked to the person it ran as; unlinked or disabled
  meanwhile, it stays in the chat only. Answers go as Slack rich text (bold, italic, lists and links are fields Slack
  does not parse), so they never mention `@here`, `@channel` or a person. A link to a page of the app shows its text
  only; any other link shows its host next to its text ("급여명세서.pdf (evil.example)") unless the text names that host.
  The notification text is plain, with `&`, `<`, `>` written out.
- *Post to channel* checks what the answer used with 대화방에 보내기's check (`chat/answer-share.ts`: the files every
  answer on its branch read, the chat's read scope when it describes the answer, "not all known" otherwise; memories
  do not count there either), against every active account but the asker; a team connection or a shared Drive counts
  whoever may use it. A Slack thread's chat also records the names its listings and globs showed, as a room session
  does. The notice is plain text (no markup, mention or link from a folder's or a connection's name). *Post anyway*
  carries a keyed hash (a secret of this server process) of what the notice said, for that request and asker: without
  it the value is refused; another request's, or one from before something changed (a rule, a member, a restart),
  shows the notice again. `slack.posted` then has `confirmed: true`. A confidential conversation, or an answer that
  read a room with old answers hidden from someone, is never posted.
- The connection is pinged every 30 seconds; one that stops answering (the Mac slept, the network dropped it) is opened
  again.
- A link is bound to the Slack account it was sent to, and binds only when that account's e-mail (Slack's, read by the
  server with `users.info` at confirm time) is the confirming person's e-mail, and no other active account here has the
  same e-mail. So a link sent on to somebody else is refused for them; it cannot link another Slack account, and an
  account already linked elsewhere cannot take it. A refused try is audited (`slack.link_refused`).
- The e-mail here is the person's own setting (Settings › Profile, not verified by the app); Slack's is verified by
  Slack. Someone who sets their e-mail here to another person's Slack e-mail still needs that person's link, which only
  that person's Slack account gets; the same e-mail on two accounts here proves nothing and is refused. An e-mail an
  admin set (Admin › Members: a new member or a change) proves nothing for 7 days, unless the person set it again
  themselves since; the person is told in the app when an admin changes it, and Settings says so. E-mails admins set
  before this connector existed count from that time too (from the audit log).
- Nobody links someone else: there is no owner tool for it. Each person links their own account, by signing in to
  Slack or with the link their own Slack account got.
- Audit log: `slack.tokens`, `slack.enabled`, `slack.disabled`, `slack.removed` (the official app: `via: official`
  and whether Slack removed it), `slack.installed` ("Add to Slack"; `restored: true` for a token fetched again),
  `slack.removed_in_slack` (with the reason), `slack.linked` (`via: slack_signin` for a sign-in), `slack.link_refused`,
  `slack.unlinked`, `slack.posted`, `slack.read_scopes_recheck` ("I updated them", with whether the bot reads now),
  `slack.read_ended` (a user token of the earlier design revoked and deleted). Older rows may show `slack.read_allowed`
  and `slack.read_scopes` (#674).
- Reading uses the bot token only; a person's AI reads a conversation only when the bot and that person's linked Slack
  account are both in it (checked with Slack at each read, a "yes" kept 2 minutes: someone removed from a channel may
  still have it read for them for up to 2 minutes). No user token is asked for or kept.

## Code and tests

`server/src/integrations/slack/` (`read.ts` the AI's Slack tools, the thread given with a question and its section of
the instructions, `api.ts` the Web API, `socket.ts` Socket Mode, `broker.ts` the official app through
the hosting service, `envelope.ts` the shapes, `manifest.ts`, `post-check.ts` what an answer used before it is posted,
`service.ts`, `text.ts`), `server/src/routes/slack.ts`, migrations `server/migrations/335_c_slack.sql`,
`345_c_slack_official.sql`, `348_c_slack_read.sql` (the earlier user tokens) and `350_c_slack_bot_reading.sql`
(`bot_scopes`), the wire contract with the hosting service `shared/src/cloud-protocol/slack-broker.ts` (MIT),
contract `shared/src/api/slack.ts`, screens `web/src/pages/admin/Slack.tsx` (a page of Admin › Connected apps,
`web/src/pages/admin/Integrations.tsx`), `web/src/pages/SlackLink.tsx`,
`web/src/components/settings/SlackAccount.tsx`. Tests: `tests/unit/c-slack-broker.test.ts` (the sealed-token vector
shared with the control plane, signatures, the long poll) and `tests/unit/c-slack-official.test.ts` (the official app
against the fake broker `tests/lib/fake-slack-broker.ts`), `tests/unit/c-slack-read.test.ts` (Marketplace-safe reading:
no user scopes, the bot's scopes and "Update Slack permissions", the tools' shared-membership rule, the thread given
with a question and what a resumed session keeps, the earlier user tokens revoked, the post notice),
`tests/unit/c-slack.test.ts` with the fake Slack
`tests/lib/fake-slack.ts` (Web API, Socket Mode, response URLs, the OpenID Connect token method; nothing reaches Slack), the permission matrix
(`tests/security/lib/slack-cases.ts`), `web/test/unit/slack-link.test.tsx` and `web/test/unit/slack-screens.test.tsx`.
