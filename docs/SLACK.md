# Slack connector

People ask the team's AI from Slack: `@trina-ax` in a channel, or a direct message to the app. Each question runs a
normal chat as the person who asked, with their own permissions, engine, budget and usage, and the full answer is also
in that chat in the app. It is off until the team's owner or an admin sets it up; it works on hosted and self-hosted servers alike,
also on an office Mac without a public address (Socket Mode: the server connects out to Slack).

The same one sign-in that links a person's Slack account also lets the AI read Slack as them (only what they can see
there): the thread they ask in, a channel, a search ("Reading Slack" below).

Decisions: [DECISIONS.md](DECISIONS.md) "Slack 커넥터", "Slack through the official Trina AX app", "Admins manage
Slack too" and "Slack: one connect links and allows reading".

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
  URL is registered in the app). With reading (`signin/read/*`, "Reading Slack" below) the hosting service exchanges
  Slack's code and hands this server your user token sealed; an older hosting service without those calls signs you in
  the old way (it checks Slack's answer, keeps no user token and says only who signed in), and reading is
  then not offered. This server checks that it is a person of this workspace, as before. No https address is needed
  here.
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

## Reading Slack

One **Sign in with Slack** links the account and lets the AI read Slack as that person: Slack's OAuth v2 page with user
scopes only (`oauth/v2/authorize?user_scope=…`, the same redirect URL `<address>/api/integrations/slack/oauth/callback`).
The server exchanges the code (`oauth.v2.access` with the client secret; the official app: the hosting service does),
asks Slack whose token it is (`auth.test`: the same person of the workspace) and keeps the person's user token sealed
(their own row in `slack_user_tokens`, the Slack key directory, AAD bound to the person). Nobody sees it: no answer,
log line, prompt or chat.

- **What the AI gets.** Its instructions always say how Slack is reached for this person (Slack not set up, not linked,
  linked without reading, or reading) and that there is no card for Slack; `connect_service` refuses Slack with the
  same sentence. Reading: the tools `slack_read_thread`, `slack_read_channel` (by id or a channel's name) and
  `slack_search`, only what that Slack user can see (a private channel they are not in is "not found"). A question
  from Slack also says where it was asked (workspace, channel name, thread) and carries the thread's messages so far
  (at most 50 messages and 12,000 characters, read with the asker's token; a DM with the app: also without it), so
  "summarize this thread" needs no tool call. Slack messages are framed as other people's words, never instructions.
  Not in shared, confidential or draft chats.
- **Linked before, or by the one-time link** (no token yet): Settings › Connectors › Slack says the AI cannot read
  Slack yet, with **Allow reading Slack**. In Slack, the first question of a thread gets the same button next to
  "working…" (to the asker only); it opens Slack's page directly, needs no sign-in here when it comes back (the
  Slack account that allows it must be the linked one), and then the question is answered again with the thread. The
  answer is never held back for it. The one-time link page goes straight on to Slack's page after **Link**.
- **The team's own app asks for the user scopes only once the owner says it has them.** An app made from an older
  manifest has none, and Slack then shows its own error page ("Invalid permissions requested") with no way back, so
  nobody could link. Until then Sign in with Slack links only (the old sign-in), and Admin › Connected apps › Slack
  shows **Update Slack permissions**: add the User Token Scopes below in *OAuth & Permissions*, reinstall the app, then
  **I updated them** (audited); from then on the one sign-in also lets the AI read. The official app asks for them
  unless Slack or the hosting service said no (then: **Add to Slack** again to approve them). A hosting service without
  `signin/read/*` (404) is remembered for 10 minutes: nothing offers reading meanwhile, and linking calls it once.
- **Only what the server itself learned marks the app as missing the scopes** (`slack.read_scopes` in the audit log): a
  grant with fewer scopes, or the hosting service's `missing_scope`; never an error in a browser's address (anyone can
  type one). If Slack does come back with such an error, linking goes on at the old sign-in in the same click.
- **A token a sign-in gave but that is not kept** (a refused flow, fewer scopes, the old sign-in's) is dropped, and
  revoked at Slack only when it cannot be anyone's working token here (another workspace, or a workspace Slack did not
  name): Slack gives one user token per person and app, the same again each time they allow it, so revoking it could
  end someone's reading. The button in Slack and a sign-in from the app do not cancel each other; the buttons are at
  most 10 an hour.
- **Ends**: Unlink, a disabled or deleted account (revoked as the account is changed), Remove, another workspace saved,
  or Slack refusing the token (the person removed the app's access in Slack): the token is revoked at Slack
  (`auth.revoke`) and deleted.
- **Outside content**: whatever Slack messages the AI was shown (a tool's answer, or the thread in its instructions)
  marks the chat as holding other people's words, as a web page or a connection's answer does: from then on a change at
  a connection (even one always allowed), a memory and the like wait for the person's yes.
- **Long threads**: the thread is read to its end (pages of 200, at most 10) and the first message and the newest are
  kept, the question always last. The official app reads only the first 15 (Slack's limit, below), says so, and still
  puts the question last. After **Allow reading Slack** the official app waits out the rest of Slack's minute before it
  answers again with the thread.
- **Post to channel**: Slack messages from the conversation the answer goes back to need no notice; any other (another
  channel, a DM, a search result) is named in the notice ("Slack #random", "Slack direct messages"; never a person).
- **Slack's limit for the official app.** Slack limits `conversations.history` and `conversations.replies` to 1
  request a minute and 15 messages for commercially distributed apps that are not in the Slack Marketplace (new installs
  since 2025-05-29; internal customer-built apps keep their limits:
  https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps and
  https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity). The official Trina AX app is such an app; a team's
  own app is internal and is not limited. With the official app the server asks for 15 at a time; when Slack says wait,
  the AI is told so in words (try again in a minute, or search) instead of failing quietly, and is told to prefer
  `slack_search` (not named by that change), one conversation at a time.

### The hosting service's part (official app)

The team server has no client secret of the official app, so the hosting service (control plane `src/slack-broker/`)
must add two signed calls (contract: `shared/src/cloud-protocol/slack-broker.ts`, flows 8 and 9; MIT):

1. **The Slack app's config:** the ten User Token Scopes `SLACK_BROKER_USER_SCOPES` (done in the app's settings
   2026-11-13; no bot scope changes, so existing installs keep working). Workspaces that need an admin's approval for new
   scopes approve them with Add to Slack again.
2. **`POST /api/slack-broker/v1/signin/read/start`** `{ v: 1, returnState, codeChallenge }` (strict, like
   `signin/start`) → `{ authorizationUrl, expiresAt }`: `https://slack.com/oauth/v2/authorize` with `client_id`,
   `user_scope` = the ten scopes joined by commas, **no `scope`**, `team` = the owner's installed workspace,
   `redirect_uri` = the one redirect URL `/slack-broker/`, and its own `state` (it tells this flow apart from install
   and sign-in by the state). Slack returns there; the hosting service sends the browser to the owner's address it
   recorded: `SLACK_BROKER_TEAM_SIGNIN_RETURN_PATH?state=<returnState>&handoff=<one-time>`, or `&error=consent_denied`
   (`access_denied`), `&error=missing_scope` (Slack refused the user scopes: `invalid_scope` and the like), else
   `&error=provider_error`. `not_installed` (404 JSON) without an install.
3. **`POST /api/slack-broker/v1/signin/read/redeem`** `{ v: 1, handoff, codeVerifier, sealKey }` → `{ slackUserId,
   slackTeamId, enterpriseId, scopes, token }`: the handoff once, only for that owner, only with the verifier (as
   `signin/redeem`). Exchange the code with `oauth.v2.access` (client id and secret); require `authed_user.token_type ==
   "user"`, an `authed_user.access_token` (xoxp) and `team.id` == the owner's installed workspace (`outsider` 409
   otherwise); call `auth.test` with that token (the same user and workspace). Seal the user token exactly like the bot
   token (fresh X25519, HKDF with `SLACK_BROKER_SEAL_INFO`, AES-256-GCM) but with the additional data
   `slackBrokerUserSealAad(installId, slackTeamId, slackUserId)`. Keep no copy, never call Slack with it again, never
   log it. If anything fails after the exchange, drop it: revoke it (`auth.revoke`) only when it cannot be anyone's
   working token for this owner (another workspace, an organization-wide grant, another app's), because Slack gives one
   user token per person and app, the same again each time they allow it. The same rule for `signin/redeem` (flow 7),
   which today revokes at once. A bot token Slack might return alongside is never handed out. `scopes`:
   `authed_user.scope` split by commas.
4. Rate limits as for `signin/start` (per owner and address). Nothing else changes: the team server revokes a user
   token itself (`auth.revoke` with the token), and an older hosting service (404 on these paths) keeps today's
   sign-in working.

Nothing here is deployed by this repository; the control plane implements and deploys it.

## Scopes (user token)

| Scope | Why |
| --- | --- |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | `conversations.replies`, `conversations.history`: a thread, a conversation's recent messages (public and private channels, DMs, group DMs the person is in) |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | `conversations.info` (a conversation's name and kind), `conversations.list` (a channel by its name) |
| `users:read` | `users.info`: who wrote |
| `search:read` | `search.messages` |

## Scopes (bot token)

| Scope | Why |
| --- | --- |
| `app_mentions:read` | the `app_mention` event: `@trina-ax` in a channel the app is in |
| `im:history` | the `message.im` event: messages in the app's DM |
| `chat:write` | "working…", answers, the link prompt (ephemeral messages included), posting to the thread |
| `users:read` | the asker's Slack name on the link page and in "Asked by"; refusing bots and people of other workspaces |
| `users:read.email` | the Slack account's e-mail: the zero-click link (the same e-mail on both sides) |
| `im:write` | `conversations.open` for the one DM telling a Slack account which account it was linked to by "Sign in with Slack" |
| `channels:read`, `groups:read` | `conversations.info` just before *Post to channel*: a channel shared with another organization since the question (or one Slack says nothing about) gets nothing |

The redirect URL is for "Sign in with Slack": OAuth v2 with the user scopes above (the token is kept, "Reading Slack"),
or, while the Slack app has no user scopes, OpenID Connect (`openid` and `profile`, asked for in its own flow; that
token is never kept, and revoked only when it is of another workspace). The app-level token needs `connections:write` (Socket Mode). The bot reads no
channel history; no files, no slash command.

## Limits

| What | Limit |
| --- | --- |
| Workspaces | one per team server; an organization-wide (Enterprise Grid) install is refused |
| Who can ask | linked people of the installed workspace; people of another workspace in a shared channel (Slack Connect) and bots are not answered; no link while Slack cannot say who is asking |
| One-time link | 10 minutes, used once, the newest one only, 10 per Slack account per hour, one a minute |
| Links | one Slack account per person, one person per Slack account; by "Sign in with Slack", or by the one-time link when the e-mails match |
| Sign in with Slack | 10 minutes, used once, the newest one only, 20 a person per hour; needs the team's https address |
| What the AI gets | the question, where it was asked, and (with reading allowed) the thread so far: at most 50 messages and 12,000 characters; more with `slack_read_thread`; no files |
| Reading (official app) | Slack's limit for non-Marketplace apps: a conversation's history about once a minute, 15 messages at a time |
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
  `slack.unlinked`, `slack.posted`, `slack.read_allowed` (the AI may read Slack as the person), `slack.read_ended` (its
token revoked: unlinked, account disabled, Slack refused it), `slack.read_scopes_recheck`.
- A person's user token (reading): sealed with AAD bound to the person, used only for that person's own turns while
  they are linked to that very Slack account, revoked at Slack on every way out. A read flow from Slack's button needs
  no session here because Slack itself says who allowed it; any other Slack account than the linked one is refused and
  its token revoked.

## Code and tests

`server/src/integrations/slack/` (`read.ts` the AI's Slack tools and its section of the instructions, `api.ts` the Web API, `socket.ts` Socket Mode, `broker.ts` the official app through
the hosting service, `envelope.ts` the shapes, `manifest.ts`, `post-check.ts` what an answer used before it is posted,
`service.ts`, `text.ts`), `server/src/routes/slack.ts`, migrations `server/migrations/335_c_slack.sql`,
`345_c_slack_official.sql` and `348_c_slack_read.sql`, the wire contract with the hosting service `shared/src/cloud-protocol/slack-broker.ts` (MIT),
contract `shared/src/api/slack.ts`, screens `web/src/pages/admin/Slack.tsx` (a page of Admin › Connected apps,
`web/src/pages/admin/Integrations.tsx`), `web/src/pages/SlackLink.tsx`,
`web/src/components/settings/SlackAccount.tsx`. Tests: `tests/unit/c-slack-broker.test.ts` (the sealed-token vector
shared with the control plane, signatures, the long poll) and `tests/unit/c-slack-official.test.ts` (the official app
against the fake broker `tests/lib/fake-slack-broker.ts`), `tests/unit/c-slack-read.test.ts` (reading Slack: the one sign-in, the tools, the thread, Allow reading Slack,
revoking, the post notice), `tests/unit/c-slack.test.ts` with the fake Slack
`tests/lib/fake-slack.ts` (Web API, Socket Mode, response URLs, the OpenID Connect token method; nothing reaches Slack), the permission matrix
(`tests/security/lib/slack-cases.ts`), `web/test/unit/slack-link.test.tsx` and `web/test/unit/slack-screens.test.tsx`.
