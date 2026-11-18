# Apps on your own computer as connectors

- Date: 2026-11-18
- Status: accepted (not scheduled)
- Supersedes: none
- Branch: docs/local-app-connectors (the owner approved the approach on 2026-11-18)

- **Ask:** the owner wants tools that run on a person's own computer, such as Aside (a browser driven through a CLI or
  MCP) and other local browser tools, to be usable as Trina connectors. They asked for one general way for all such
  tools, not a plugin per tool.
- **Status:** the approach is approved. Building waits until the PC runner (branch `feat/pc-runner`) is merged, because
  this work runs over the same channel.

## What exists today (checked in code on 2026-11-18, `origin/dev`)

- **Connectors reach a service over the internet only.** A connection is one of two kinds, `mcp` or `http`
  (`shared/src/api/integrations.ts` `IntegrationKind`). The MCP client speaks Streamable HTTP
  (`server/src/integrations/connections/mcp.ts`), and every request goes through `net.ts`: https only, public addresses
  only, never the office network or this server. There is no way to start a program as a connector.
- **Local programs are already left out on purpose** in one place: when Claude Code or Codex shares its skills with the
  team, only remote MCP servers over https are sent; "Local (stdio, "command") MCP servers cannot be shared: leave them
  out" (`server/src/connectors/remote-mcp/share.ts`).
- **Personal and team connections.** Every connection has a scope, `personal` or `team`
  (`server/src/integrations/connections/store.ts`). A personal one is used only by its owner, and only while the team
  switch "Members can add their own connections" is on (`mayUse`, `offByTeam`). Team ones are made through
  `API.createTeamIntegration` (`server/src/routes/integrations.ts`) and admin templates (`templates.ts`).
- **Asking before changes.** Reads run at once. Anything else follows the connection's write rule `deny`, `ask` (the
  default) or `allow`, on a card the server shows (`tools.ts`). The rule is one choice per connection. Every call is kept
  as a short summary in the audit, never its content ([INTEGRATIONS.md](../INTEGRATIONS.md), "Audit").
- **Hiding secrets.** What a service sends back goes through `hide.ts` before the AI, the chat or the logs see it, and
  the turn's own text goes through `redact.ts`.
- **The PC runner (not merged).** On `feat/pc-runner` (commit 8fc149029, step 1, macOS): the AI and its model token stay
  on the team server; file and command tools go over the WebSocket of the window that sent the turn to that person's
  desktop app, which asks the person in its own view and runs them in a macOS jail. Its channel (`CallRelay`) is the
  same base as the in-app browser's relay (`server/src/realtime/browser-relay.ts`). It is off unless the server sets
  `MYCEL_PC_RUNNER=1` and an admin turns it on.

## The approach

1. **Add a connection.** "Add connection" gets a new kind: **An app on your computer**. The person either picks from a
   short list of known tools, or pastes a command line in the same shape as an MCP config entry: the command, its
   arguments, and the names of the settings (environment variables) it needs, without their values.
2. **Running it.** The Trina desktop app starts the tool on that person's computer: a local MCP server over stdio, or a
   plain CLI wrapped as a few tools. The desktop app passes the tools' list and each call to the server's AI over the
   PC runner's channel. The AI stays on the server; the program runs on the person's computer.
3. **One way for all tools.** Any local MCP server or CLI works this way, so there is no plugin per tool. A plugin is
   only for something that needs its own screen inside Trina.

## Rules

- **Personal only.** These connections can never be team connections or templates, because the program uses that
  person's own browser and its sign-ins. The code that must refuse it: `API.createTeamIntegration` and the template
  create and update paths (a local kind is refused there), `store.ts mayUse` (a local connection is used only by its
  owner, in that owner's own turn), and the skills share in `remote-mcp/share.ts` (still leaves local entries out).
  A shared chat or a room does not make it usable by anyone else.
- **Only while the computer is there.** It works only while that person's desktop app is open and signed in to the team.
  When it is not, the AI says so in plain words: "Your computer is offline, so I can't use <name> right now."
  Scheduled runs, sub-agents and confidential chats never get these tools, as with the PC runner.
- **Ask first, every action.** "Ask first" is the default for every action, reads included, because what a browser
  reads (a page, a signed-in account) reaches the server. This uses the per-action "Allowed / Ask first / Off" choice
  from [Bring in Composio's approach](20261118-composio-plan.md) (gap b). Every call is in the log, as for other
  connections.
- **An admin switch.** One team setting turns "Apps on your computer" off for the whole team. Off means the kind is
  not offered, and existing ones are not used in chats (like `offByTeam` today).
- **Security.**
  - Before the first run, the desktop app shows the exact command, in its own view (not the team page), and the person
    confirms it on that computer. The server or the AI alone can never add or change the command; a changed command
    asks again.
  - No secrets in the command. Setting values are typed on the computer and stay there; the server only knows their
    names.
  - The program runs as the signed-in user, never as root or with admin rights.
  - A stop control on the connection's page and in the desktop app ends the program at once.
  - What the tools send back to the AI goes through the existing hide and redact (`hide.ts`, `redact.ts`), and counts as
    outside content seen by this person only, as the PC runner's results do.
- **Self-hosted Linux or Docker servers (later).** An optional later step may allow a browser MCP that runs on the
  server itself, inside the sandbox, for teams without desktop apps. Not part of this plan.

## What the person sees

1. Settings › Connectors › Add connection › **An app on your computer**.
2. Pick "Aside" (or another known tool), or paste a command line. Trina asks for any setting the tool needs.
3. The desktop app opens a window: "Trina wants to run this on your computer: `<the exact command>`". Run / Cancel.
4. The connection shows "On this computer · running", with its actions, each set to "Ask first".
5. In a chat, the AI asks to use it; a card shows what it wants to do; the person says yes. The steps under the answer
   show "<name> · <action>".
6. With the desktop app closed: "Your computer is offline, so I can't use <name> right now."

## Steps

1. **After the PC runner merges:** the new kind, stored as a personal connection that holds the command shape only;
   the desktop app runs a local MCP server over stdio and bridges it; the confirm-on-this-computer window; the stop
   control; the offline message; the admin switch. macOS first.
2. **Per-action rules:** "Allowed / Ask first / Off" per action (from the Composio note), used here first.
3. **Known tools list and CLI wrapping:** a short list (Aside and a few browser tools) with their command shapes, and a
   way to wrap a plain CLI as tools.
4. **Later:** Windows; a server-side browser MCP for self-hosted Linux or Docker.

## Open questions

- **Windows.** The PC runner's step 1 is macOS only, with a macOS jail. Windows needs its own way to start and limit the
  program.
- **Tools that need their own browser profile.** Some tools open a fresh browser or want a profile of their own; others
  drive the person's everyday browser. Which do we allow, and how do we explain the difference in plain words?
- **Keeping the known tools list up to date.** Who checks a tool's command shape and its origin, and how does a new
  version reach desktop apps without a Trina release?

- **Version impact:** none (a note only).
