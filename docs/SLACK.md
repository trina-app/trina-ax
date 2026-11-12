# Slack connector

People ask the team's AI from Slack: `@trina-ax` in a channel, or a direct message to the app. Each question runs a
normal chat as the person who asked, with their own permissions, engine, budget and usage, and the full answer is also
in that chat in the app. It is off until the team's owner sets it up; it works on hosted and self-hosted servers alike,
also on an office Mac without a public address (Socket Mode: the server connects out to Slack).

Decisions: [DECISIONS.md](DECISIONS.md) "Slack 커넥터" and "Slack through the official Trina AX app".

There are two ways to have the Slack app. Where the hosting service serves the server, the owner adds **the official
app** with one button and copies nothing (below). Anywhere else the owner makes **the team's own app** from our
manifest (the four steps).

## The official app ("Add to Slack")

Slack's page in **Admin › Connected apps** (`/admin/connectors/slack`, the owner's only: Slack is one row of that list,
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
- **Only the owner who pressed it finishes it.** Slack sends the browser to the hosting service, which sends it back
  only to this team's address it recorded (`/api/integrations/slack/official/callback`) with a one-time handoff (10
  minutes, time to sign in here first) that only this flow's verifier redeems. A browser signed in as someone else is refused; one with no session
  is asked to sign in first and then goes on. 10 minutes, used once, the newest only.
- **Sign in with Slack** to link your own account works the same way through the hosting service (its one redirect
  URL is registered in the app): it checks Slack's answer, revokes your Slack user token at once and says only who
  signed in; this server checks that it is a person of this workspace, as before. No https address is needed here.
- **Removed in Slack** (the app removed from the workspace, its token revoked, or the hosting service's operator
  removed it): the token is forgotten here and Slack's page says "The app was removed from Slack. Add it to Slack
  again." People's links stay (the same workspace when it is added again). A token Slack refuses at a post means the
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

The redirect URL is for "Sign in with Slack" (OpenID Connect; docs.slack.dev "Sign in with Slack"), which asks for
`openid` and `profile` in its own flow: they are not in the app's user scopes (Slack does not let them be asked for
together with other scopes, and the manifest's user scopes are asked for at install). The user token that sign-in gives
the server is revoked at once and never kept. The app-level
token needs `connections:write` (Socket Mode). No channel history, no files, no slash command.

## Limits

| What | Limit |
| --- | --- |
| Workspaces | one per team server; an organization-wide (Enterprise Grid) install is refused |
| Who can ask | linked people of the installed workspace; people of another workspace in a shared channel (Slack Connect) and bots are not answered; no link while Slack cannot say who is asking |
| One-time link | 10 minutes, used once, the newest one only, 10 per Slack account per hour, one a minute |
| Links | one Slack account per person, one person per Slack account; by "Sign in with Slack", or by the one-time link when the e-mails match |
| Sign in with Slack | 10 minutes, used once, the newest one only, 20 a person per hour; needs the team's https address |
| What the AI gets | the question's text only: no earlier messages of the thread, no files |
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
  `slack.unlinked`, `slack.posted`.

## Code and tests

`server/src/integrations/slack/` (`api.ts` the Web API, `socket.ts` Socket Mode, `broker.ts` the official app through
the hosting service, `envelope.ts` the shapes, `manifest.ts`, `post-check.ts` what an answer used before it is posted,
`service.ts`, `text.ts`), `server/src/routes/slack.ts`, migrations `server/migrations/335_c_slack.sql` and
`345_c_slack_official.sql`, the wire contract with the hosting service `shared/src/cloud-protocol/slack-broker.ts` (MIT),
contract `shared/src/api/slack.ts`, screens `web/src/pages/admin/Slack.tsx` (a page of Admin › Connected apps,
`web/src/pages/admin/Integrations.tsx`), `web/src/pages/SlackLink.tsx`,
`web/src/components/settings/SlackAccount.tsx`. Tests: `tests/unit/c-slack-broker.test.ts` (the sealed-token vector
shared with the control plane, signatures, the long poll) and `tests/unit/c-slack-official.test.ts` (the official app
against the fake broker `tests/lib/fake-slack-broker.ts`), `tests/unit/c-slack.test.ts` with the fake Slack
`tests/lib/fake-slack.ts` (Web API, Socket Mode, response URLs, the OpenID Connect token method; nothing reaches Slack), the permission matrix
(`tests/security/lib/slack-cases.ts`), `web/test/unit/slack-link.test.tsx` and `web/test/unit/slack-screens.test.tsx`.
