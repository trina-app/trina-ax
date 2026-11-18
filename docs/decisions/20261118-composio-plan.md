# Bring in Composio's approach to connected apps

- Date: 2026-11-18
- Status: proposed (not scheduled)
- Supersedes: none
- Branch: docs/composio-plan (the owner)

- **Ask:** the owner wants Trina to take on the approach of [Composio](https://composio.dev): many apps, safe access,
  and control over what the AI may do in each one. This note records the direction. Nothing here is built or scheduled.

## What Composio does

From its homepage, read on 2026-11-18:

- "Give your AI secure access to 1,700+ apps in minutes."
- It works inside the AI people already use (ChatGPT, Claude, Cursor, Claude Code …) through MCP. It "isn't another
  chatbot".
- People sign in on each app's own page. Credentials are stored encrypted, and the AI never sees the sign-in token.
- For each connection you can limit which actions are allowed, require approval for some of them, and revoke the
  connection in one click. Every action is logged.
- There is a no-code path for end users and an SDK and platform for developers.
- The Hobby plan is free with 100,000 tool calls a month. It runs in their cloud, in your own cloud network (VPC) or
  self-hosted.

## What Trina already has

Details are in [INTEGRATIONS.md](../INTEGRATIONS.md) and [GOOGLE-APPS.md](../GOOGLE-APPS.md).

- **Connect any app that speaks MCP**, by its address, with the app's own sign-in page (OAuth) or a key. Apps that only
  accept apps they approved, or only an app on the computer (Canva, Intercom, Square), have their own sign-in paths. An
  HTTP API with a key works through one tool that can only call that API's address.
- **A small list to pick from:** Settings › Connectors › Discover lists 39 services, plus built-in Gmail, Calendar,
  Docs, Sheets and Google Drive. Anything else is added by its address.
- **Personal and team connections.** A person connects their own account. An admin can connect one for the team and
  choose who may use it (everyone, groups, people), or register a template that each member connects with their own
  account. Gmail, Calendar, Docs and Sheets can each have one shared team account.
- **Asking before changes.** Reading runs at once; anything that sends or changes something follows the connection's
  rule: refuse, ask on a card that shows everything that will be sent, or (team connections only, an admin's choice)
  send without asking. A person can pick "Always allow" on a card, and that is final for them.
- **Single tools on and off.** Whoever manages a connection can switch off any of its tools; the AI never sees a tool
  that is off.
- **Tokens stay away from the AI.** Keys and tokens are stored encrypted in their own key folder, are never put in the
  AI's input, and are hidden from anything an app sends back before the AI, the chat or the logs see it.
- **Disconnect** deletes the stored tokens and asks the app to revoke them.
- **Records.** The admin audit log records connections added, changed and removed, sign-ins and tool switches. Each
  tool call is kept as a short summary (which tool, the result, whether the person confirmed), never its content, and the
  steps under an answer show "connection · tool".
- **Trina AX MCP** lets Claude (Code, Desktop, claude.ai) and other AI apps use the team's files, skills and the
  person's conversations, with the person's own permissions.

## Gaps to bring in

a. **Many more apps.** Trina lists 39; Composio covers about 1,700, including apps that do not offer MCP or need an
   approved app (Slack, GitHub, HubSpot …).
   *How in Trina:* either keep adding apps ourselves (each needs its sign-in checked), or offer a provider like
   Composio as one more source of connectors, shown in the same Discover list, with the same cards and rules.

b. **Limits and approval per action, not only per connection.** Today "ask" or "allow" is one choice for the whole
   connection, and reading never asks.
   *How in Trina:* on a connection's page, next to each tool's on/off switch, a choice of "Allowed", "Ask first" or
   "Off", for reading tools too. The person (or the admin, for a team connection) sets it once.

c. **One-click revoke that is easy to find.** Disconnect exists, one click away on each connection's page. What is
   missing is a fast way to stop everything at once.
   *How in Trina:* Disconnect on every row of Your connectors, a "Stop using this" for a member on a team connection
   (to be checked against what the page offers today), and one "Pause all connections" switch for an admin when
   something looks wrong.

d. **An action log people can see.** Today the details of tool calls are only a summary for admins, and a person has no
   page of what the AI did in their apps.
   *How in Trina:* a "Recent actions" list on each connection's page: when, which chat, which action, allowed or
   confirmed or refused. Admins see the same for team connections. Still no content or secrets in it.

e. **Trina's connections from the AI people already use.** Trina AX MCP gives other AI apps the team's files and
   conversations, not the connected apps.
   *How in Trina:* add the person's connected apps (and the team connections they may use) to Trina AX MCP, with the
   same rules: tools that are off stay hidden, "Ask first" actions wait for the person to confirm in Trina, every call
   is in the log.

f. **The AI never holds the tokens, wherever it runs.** This is already true inside Trina.
   *How in Trina:* keep it true for (e): an outside AI app calls Trina, and Trina makes the call to the app with the
   stored token. If a provider like Composio supplies connectors, its tokens stay with it and Trina never passes them on.

## Open questions

- **Cost per tool call.** Composio's free plan has 100,000 calls a month; above that it is paid. Who pays when a team
  goes over: the team, or Trina, and how does that show up in the team's usage and limits?
- **Customer data through a third party.** With Composio as the source, every call and its answer goes through
  Composio, and the sign-in tokens are stored there. Self-hosted teams and office installs chose Trina to keep data in
  their own place, so this must be a choice an admin turns on, off by default, or Composio's self-hosted version would
  be needed.
- **Terms.** Whether Composio's terms allow Trina to resell or bundle its connectors for our customers, and what the
  self-hosted licence costs.

- **Status:** proposed, not scheduled. Next step when it is picked up: a short plan with the owner on which gaps come
  first (b, c and d need no third party).
- **Version impact:** none (a note only).
