# Slack connector

People ask the team's AI from Slack: `@trina-ax` in a channel, or a direct message to the app. Each question runs a
normal chat as the person who asked, with their own permissions, engine, budget and usage, and the full answer is also
in that chat in the app. It is off until the team's owner sets it up; it works on hosted and self-hosted servers alike,
also on an office Mac without a public address (Socket Mode: the server connects out to Slack).

Decisions: [DECISIONS.md](DECISIONS.md) "Slack 커넥터".

## Setting it up (the owner)

1. **Admin › Slack › Create the app in Slack.** Slack opens "Create an app" with our manifest filled in (or "Show the
   manifest", then in Slack: *Create New App › From a manifest*). Choose your workspace. It makes an **internal** app of
   your workspace only, with Socket Mode on.
2. **Install it.** In Slack, *Install App › Install to Workspace*. Copy the **Bot User OAuth Token** (`xoxb-…`,
   *OAuth & Permissions*).
3. **Make the app-level token.** *Basic Information › App-Level Tokens › Generate Token and Scopes*, scope
   `connections:write`. Copy it (`xapp-…`).
4. **Paste both** in Admin › Slack and press *Check and save*. The server checks them with Slack (`auth.test`,
   `apps.connections.open`) and the scopes the bot token has; a wrong token says why. Then **Turn on**.
5. **Invite the app** to the channels where people may ask it: `/invite @trina-ax`. Without this Slack does not tell
   the app about mentions there.

Save the tokens from the address people sign in at (the team's public address): the links the app sends in Slack open
there. Admin › Slack shows it ("links open at …"). The server needs to reach `slack.com` and `wss-*.slack.com` on port
443; nothing has to reach the server.

Turn off closes the connection (links stay). Remove deletes the tokens and every person's link; delete the app itself in
Slack. Saving tokens of another workspace removes every link of the old one.

## Using it (everyone)

- **The first time**, the app answers only you ("Only visible to you") with *Connect account*. The link opens the app
  (sign in if needed), shows the Slack account and your account side by side, and links them when you press *Link*. Only
  link a Slack account that is yours: whoever uses it can then ask with your permissions. Then ask again.
- **In a channel** the answer is shown to you only, with *Post to channel*. Pressing it posts the answer to the thread,
  "Asked by <you>", without the steps, the files it read or the link to your chat. Each answer can be posted once, and
  only by the person who asked.
- **In a DM** the answer comes in the thread of your message.
- **Follow-ups**: mention the app again in the same thread (or reply in the DM thread); they continue the same chat.
  A new thread is a new chat.
- **Unlink** in Settings › App connectors › Slack. A disabled or deleted account is unlinked at once.

## Scopes (bot token)

| Scope | Why |
| --- | --- |
| `app_mentions:read` | the `app_mention` event: `@trina-ax` in a channel the app is in |
| `im:history` | the `message.im` event: messages in the app's DM |
| `chat:write` | "working…", answers, the link prompt (ephemeral messages included), posting to the thread |
| `users:read` | the asker's Slack name on the link page and in "Asked by"; refusing bots and people of other workspaces |

The app-level token needs `connections:write` (Socket Mode). No user token, no channel history, no files, no slash
command.

## Limits

| What | Limit |
| --- | --- |
| Workspaces | one per team server; an organization-wide (Enterprise Grid) install is refused |
| Who can ask | linked people of the installed workspace; people of another workspace in a shared channel (Slack Connect) and bots are not answered |
| One-time link | 10 minutes, used once, the newest one only, 10 per Slack account per hour, one a minute |
| Links | one Slack account per person, one person per Slack account |
| What the AI gets | the question's text only: no earlier messages of the thread, no files |
| Answer in Slack | shortened to about 11,000 characters, with a link to the whole answer in the chat; posted to a thread: about 29,000 |
| Waiting for an answer | 2 hours; a turn that waits for a card (a question of the AI, a confirmation) tells the asker to answer it in the app |
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
  Mode needs no request signature; every envelope is checked against strict shapes, the workspace and the app id.
- A link is bound to the Slack account it was sent to. It cannot link another Slack account, and an account already
  linked elsewhere cannot take it. The page names both accounts, so a person who was sent somebody else's link can see
  that the Slack account is not theirs.
- Audit log: `slack.tokens`, `slack.enabled`, `slack.disabled`, `slack.removed`, `slack.linked`, `slack.unlinked`,
  `slack.posted`.

## Code and tests

`server/src/integrations/slack/` (`api.ts` the Web API, `socket.ts` Socket Mode, `envelope.ts` the shapes,
`manifest.ts`, `service.ts`, `text.ts`), `server/src/routes/slack.ts`, migration `server/migrations/335_c_slack.sql`,
contract `shared/src/api/slack.ts`, screens `web/src/pages/admin/Slack.tsx`, `web/src/pages/SlackLink.tsx`,
`web/src/components/settings/SlackAccount.tsx`. Tests: `tests/unit/c-slack.test.ts` with the fake Slack
`tests/lib/fake-slack.ts` (Web API, Socket Mode, response URLs; nothing reaches Slack), the permission matrix
(`tests/security/lib/slack-cases.ts`) and `web/test/unit/slack-link.test.tsx`.
