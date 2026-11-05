# Slack connector

People ask the team's AI from Slack: `@trina-ax` in a channel, or a direct message to the app. Each question runs a
normal chat as the person who asked, with their own permissions, engine, budget and usage, and the full answer is also
in that chat in the app. It is off until the team's owner sets it up; it works on hosted and self-hosted servers alike,
also on an office Mac without a public address (Socket Mode: the server connects out to Slack).

Decisions: [DECISIONS.md](DECISIONS.md) "Slack 커넥터".

## Setting it up (the owner)

Admin › Slack is a checklist of four steps; each step's title opens its page in Slack.

1. **Create the app in Slack.** Slack opens "Create an app" with our manifest filled in. Choose your workspace and
   create it. It makes an **internal** app of your workspace only, with Socket Mode on.
2. **Install it in the workspace.** *Install App › Install to Workspace*, then copy the **Bot User OAuth Token**.
3. **Make the app token.** The server connects to Slack directly with it (Socket Mode, so nothing has to reach the
   server): *Basic Information › App-Level Tokens › Generate Token and Scopes*, scope `connections:write`. Copy it.
4. **Paste both tokens and turn on** (*Check and turn on*). The server checks them with Slack (`auth.test`,
   `apps.connections.open`, `bots.info`): the scopes the bot token has and that both tokens are of the same app. A
   refused token is said under its own field, with the Slack page to fix it, until the next try.

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

- **The first time**, the app answers only you ("Only visible to you") with *Connect account*. The link opens the app
  (sign in if needed) and shows two lines: the Slack account, and your account with its e-mail. *Link* works only when the e-mail Slack
  has for that Slack account is the e-mail of your account here (compared without case or surrounding spaces): that is
  the proof the Slack account is yours. Slack then says which account it is linked to, and every "working…" names the
  account it answers as. Then ask again.
- **E-mails that differ** (or none on either side, or your e-mail was set by someone else in the last 7 days): the page
  says why and what to ask ("…달라서 바로 연결할 수 없어요. 팀장에게 관리자 › Slack › 사람 연결에서 나에게 연결을
  제안해 달라고 하세요") and links nothing. The owner then
  *proposes* the link in Admin › Slack › People (the workspace's people: no bots, no deactivated people, no one of another
  workspace; tap the person, choose the member, check both names and e-mails; tapping a person with a waiting proposal
  withdraws it). **Nothing is linked yet.** The proposal
  stands in for the e-mail check only; it needs both halves, in either order, within its 7 days: the member accepts it in
  Settings › App connectors (they get a notice), and the member opens the one-time link that Slack account gets in Slack
  (ask the app once; the Slack account gets a DM saying so) and presses *Link*. So the owner cannot take a colleague's
  Slack account for their own account, nor link a Slack account the member does not hold. The owner can withdraw a
  waiting proposal. Once linked, the Slack person gets one DM saying which account it is and how to undo it.
- **In a channel** the answer is shown to you only, with *Post to channel*. Pressing it posts the answer to the thread,
  "Asked by <you>", without the steps, the files it read or the link to your chat. Each answer can be posted once, and
  only by the person who asked.
- **In a channel shared with another organization** (Slack Connect) there is no *Post to channel*; the answer says why.
  Slack is asked again when the button is pressed.
- **In a DM** the answer comes in the thread of your message (a new message, so Slack notifies you; "working…" goes).
- **Follow-ups**: mention the app again in the same thread (or reply in the DM thread); they continue the same chat.
  A new thread is a new chat.
- **Settings › App connectors** has a Slack line while the team uses Slack: the linked account with *Unlink*, how to
  get a link, or the owner's proposal (*Link* / *Decline*; once accepted, the one next step: ask the app in Slack and
  open the link it sends). A disabled or deleted account is unlinked at once.
- **When an answer cannot start or fails**, Slack says why in plain words (the chat was deleted, a server problem, the
  budget's own sentence), not a code.

## Scopes (bot token)

| Scope | Why |
| --- | --- |
| `app_mentions:read` | the `app_mention` event: `@trina-ax` in a channel the app is in |
| `im:history` | the `message.im` event: messages in the app's DM |
| `chat:write` | "working…", answers, the link prompt (ephemeral messages included), posting to the thread |
| `users:read` | the asker's Slack name on the link page and in "Asked by"; refusing bots and people of other workspaces; the People list (`users.list`) |
| `users:read.email` | the Slack account's e-mail: the proof a self-made link needs, and what the owner checks before linking someone |
| `im:write` | `conversations.open` for the DMs about a proposal: one when it is made (naming no account), one when it is linked |
| `channels:read`, `groups:read` | `conversations.info` just before *Post to channel*: a channel shared with another organization since the question (or one Slack says nothing about) gets nothing |

The app-level token needs `connections:write` (Socket Mode). No user token, no channel history, no files, no slash
command.

## Limits

| What | Limit |
| --- | --- |
| Workspaces | one per team server; an organization-wide (Enterprise Grid) install is refused |
| Who can ask | linked people of the installed workspace; people of another workspace in a shared channel (Slack Connect) and bots are not answered; no link while Slack cannot say who is asking |
| One-time link | 10 minutes, used once, the newest one only, 10 per Slack account per hour, one a minute |
| Links | one Slack account per person, one person per Slack account; self-made only with the same e-mail on both sides |
| People list (owner) | the first 2,000 people of the workspace, read again after a minute |
| What the AI gets | the question's text only: no earlier messages of the thread, no files |
| Answer in Slack | shortened to about 11,000 characters, with a link to the whole answer in the chat; posted to a thread: about 29,000 |
| Waiting for an answer | 2 hours, then the asker is told (the chat keeps a later answer); a turn that waits for a card (a question of the AI, a confirmation) tells the asker to answer it in the app |
| Ephemeral messages | Slack does not keep them (they are gone after a reload) and delivers them only to people in the channel; the chat in the app keeps the answer |

Slack sends an event again when it is not acknowledged within 3 seconds: the server acknowledges each one at once and
handles an event id, or a message, only once (also after a restart). Slack's rate limits (429) are waited out and the
answer is sent again at the next try. Slack renews the connection every few hours; a lost connection is opened again
after 1, 2, 4 … seconds (at most a minute).

## Security

- The tokens are sealed in the browser (`slack.token`), opened only by the server and kept AES-256-GCM encrypted with
  their own key directory `<secrets>/integrations/slack` (owned by the server account, 0700). No response, log line,
  audit entry, engine or chat ever gets them; the screen only knows whether they are saved.
- Who asked comes from Slack's own event (workspace, organization and user ids), never from the message text. Socket
  Mode needs no request signature; every envelope is checked against strict shapes, the workspace and the app id saved
  with the tokens (nothing is handled while the app id is unknown).
- An answer goes out only while the Slack account is still linked to the person it ran as; unlinked or disabled
  meanwhile, it stays in the chat only. Answers are written in Slack's markup with `&`, `<`, `>` written out, so they
  never mention `@here`, `@channel` or a person, and a link whose text looks like an address shows the real address.
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
- The owner never asks as someone else: a proposal links nothing until that member accepts it with their own session
  (the owner and other people get 404 for it).
- Audit log: `slack.tokens`, `slack.enabled`, `slack.disabled`, `slack.removed`, `slack.linked`, `slack.link_refused`,
  `slack.proposed`, `slack.proposal_accepted`, `slack.proposal_confirmed` (the Slack half), `slack.proposal_cancelled`,
  `slack.proposal_declined`, `slack.unlinked`, `slack.posted`.

## Code and tests

`server/src/integrations/slack/` (`api.ts` the Web API, `socket.ts` Socket Mode, `envelope.ts` the shapes,
`manifest.ts`, `service.ts`, `text.ts`), `server/src/routes/slack.ts`, migration `server/migrations/335_c_slack.sql`,
contract `shared/src/api/slack.ts`, screens `web/src/pages/admin/Slack.tsx`, `web/src/pages/SlackLink.tsx`,
`web/src/components/settings/SlackAccount.tsx`. Tests: `tests/unit/c-slack.test.ts` with the fake Slack
`tests/lib/fake-slack.ts` (Web API, Socket Mode, response URLs; nothing reaches Slack), the permission matrix
(`tests/security/lib/slack-cases.ts`), `web/test/unit/slack-link.test.tsx` and `web/test/unit/slack-screens.test.tsx`.
