# Connections: what each tool can do and where it is offered

One map of every connectable tool. Read it before you change a connection mode or a surface that offers one; **update
it in the same PR**. The cards each connection raises (read, write, shared chat, sign-in) are entries in
[ASKS.md](ASKS.md) "Connectors". Built from the code on `dev` (2026-11-21; the person's browser profiles 2026-11-28; the welcome tools step's rows and the chat's Google card 2026-11-22; Microsoft 365 2026-11-25); file:line points at where the mode lives.

Words: **Team** = one connection the owner or an admin makes once, used by the people the admin picks. **Personal** =
each person signs in with their own account. **Ask everyone to connect their own** (the switch; the tag people see is "Team asks you to connect", earlier "Team pick" / "팀 추천") = the
admin asks for a personal tool; it only sorts the list (`shared/src/api/team-tools.ts:1-25`), nothing is gated.

## The table

| Tool | Team connection | Personal | Ask everyone to connect their own | Offered where |
|---|---|---|---|---|
| Google Drive | Yes, "Shared with the team": an admin shares chosen folders or a whole Drive (`shared/src/api/drive.ts:84-89`, `web/src/components/integrations/DriveShares.tsx`) | Yes (`shared/src/api/drive.ts:74`) | Yes | Welcome tools step: Connect for the team (Drive share dialog, `ToolsStep.tsx` `DriveShareDialog`) and the switch. Admin › Connected apps. Settings › Connectors. My setup card: a team Drive share counts as connected (`myTools.ts:37`). Chat: card, with Connect for the team (the same share dialog) for an owner or admin; a team Drive share the person may use counts as connected, no card (`server/src/chat/connect-service.ts` `google_drive`, `web/src/components/integrations/GoogleTeam.tsx`) |
| Gmail, Calendar, Docs, Sheets | Yes, "Shared Google account": one account for the app (`shared/src/api/google-apps.ts:67,160-165`, `GoogleAppTeam.tsx`) | Yes | Yes (`team-tools.ts:23`) | Welcome tools step: Gmail only, Connect for the team (shared Google account dialog) and the switch; Calendar, Docs and Sheets through Other tools (`ToolsStep.tsx`). Admin › Connected apps. Settings › Connectors. My setup card (shows "team" state, `web/src/lib/myTools.ts:43`). Chat: an owner or admin gets a card, Connect for the team (shared Google account dialog) or their own on its page (`connect-google-app.ts` `googleAppTeamCard`); a member gets a card with only their own Connect, which opens that page (`googleAppOwnCard`; on a phone it says to connect on a computer); the team's shared account they may use counts as connected, no card |
| Notion | Yes, MCP team connection (`shared/src/api/integrations.ts:406`) | Yes | Yes (only Slack is excluded, `team-tools.ts:18`) | Welcome tools step: Connect for the team and the switch (`ToolsStep.tsx` `WELCOME_SERVICES`). Admin › Connected apps. Settings › Connectors. My setup card. Chat card (personal; team only for admins, `connect-service.ts:269`) |
| Slack | Yes, its own page: the team's Slack app, "Add to Slack" (hosted) or own app tokens (owner only) (`shared/src/api/slack.ts:129-138`) | Link-only: each person links their Slack account (`slack.ts:132-136`) | No, excluded (`team-tools.ts:18`) | Not a row of the welcome tools step since 2026-11-22 (owner: its connection is too complicated for the first steps); a Slack connected in Admin still counts as the step done. Admin › Connected apps › Slack. Settings › Connectors: a Slack card for an owner or admin while it is not added, opening Admin's page (`pages/Connectors.tsx` `slackCard`; the step's Other tools leads there), and each person's Slack line (`web/src/components/settings/SlackAccount.tsx`) |
| GitHub | Yes, MCP team connection | Yes, signs in through the server's GitHub App (`shared/src/service-catalog.ts`, `server/src/integrations/github/app.ts`) | Yes (listed service) | Admin › Connected apps. Settings › Connectors. Chat card. Not on the welcome steps |
| Microsoft 365 (Outlook mail and calendar, OneDrive and SharePoint files, Teams chats; this server's own tools over Microsoft Graph at the reserved address `https://microsoft-365.invalid/mcp`, signed in through the server's Microsoft app, `server/src/integrations/microsoft/`, [decision](decisions/20261125-m365-connector.md)) | Yes, MCP team connection: an admin signs in one Microsoft account for the people the rule includes | Yes, each person's own Microsoft work or school account; from the desktop app (Windows, Mac) through its one-time 127.0.0.1 return address, from the web through the team's address | Yes | Admin › Connected apps. Settings › Connectors (Discover). Chat card. Without the server's Microsoft app the card says "Not set up yet" (`web/src/lib/connectors.ts` `serverAppMissing`). Not on the welcome steps |
| Higgsfield (AI images and video; `https://mcp.higgsfield.ai/mcp`, OAuth sign-in at Higgsfield with dynamic client registration or a client metadata document, no API key) | Yes, MCP team connection: one Higgsfield account and its credits for everyone who may use it | Yes, each person's own Higgsfield account and plan | Yes | Welcome tools step: Connect for the team and the switch, after Notion (`ToolsStep.tsx` `WELCOME_SERVICES`). Admin › Connected apps. Settings › Connectors (Discover). Chat card |
| Asana, HubSpot, Box (listed with `teamApp`: sign in only through an app the team makes at the service, `shared/src/service-catalog.ts`) | Yes: a template with the team's own app first (each member signs in with their own account), or one shared account for the team | Only through the team's template: Discover says "Not set up yet" and its page has Ask admin to add it; a connection added by its address stops with `oauth_needs_team_app` | Yes (listed service) | Admin › Connected apps (the service's page: Set up as a template). Settings › Connectors (Discover, not set up until an admin did). Chat: no card, the AI says who sets it up (`connect-service.ts`). `docs/decisions/20261125-own-app-connectors.md` |
| Every other listed service (about 40: Linear, Atlassian, Figma, Canva, Stripe, Supabase, Vercel, Granola …) | Yes, MCP team connection | Yes | Yes | Admin › Connected apps. Settings › Connectors (Discover). Chat card. My setup card shows only Notion by default (`myTools.ts:14`) |
| Any MCP server or API by address | Yes, team connection, or a template each member connects with their own key (`integrations.ts:405,416`) | Yes (admin may turn personal off, `server/src/admin/settings.ts:28`) | No | Admin › Connected apps › Add one by its address. Settings › Connectors › Add custom connector (members see "Ask an admin to add it" for what is not listed). Chat card: the AI fills in the address; one that is not a listed service's official address says it is not in the app's list beside its host and asks to check it against the service's official docs, and can still be connected (`web/src/components/chat/ConnectCard.tsx` `connect-unlisted`, `docs/decisions/20261124-connect-card-unlisted.md`) |
| Apps on the computer (Aside, ego lite, Playwright, Chrome DevTools, any program) | No, always personal (`integrations.ts:394`) | Yes, desktop app only (macOS, Windows, Linux; on Windows a pasted path keeps its backslashes and npm's `.cmd` programs run, while Playwright and Chrome DevTools are not listed there yet: `docs/decisions/20261124-windows-local-apps.md`). A program that is not on the computer is never "Connected": no confirm opens, the connection needs attention with "isn't installed" and, for Aside and ego lite, their download page (`server/src/integrations/connections/local.ts` `local_missing`) | Yes for the listed ones (`team-tools.ts`) | Settings › Connectors (desktop). Not in the welcome steps or on a phone. While the desktop app's "Connect a program" window waits, the page shows a notice (`web/src/lib/localRelay.ts` `watchLocalAsking`) |
| The person's own browser profiles (Chrome, Edge, Brave through the extension `chrome-extension/`; decision 20261128-trina-in-chrome) | No, always the person's own | Yes: each profile links on its own from that profile (the extension's Connect opens the signed-in team page `/connect-chrome`, PKCE code), with the name the person gives it; up to 20; each has its own site list and "Only these sites". The AI picks the profile per call. Works for hosted teams too (the extension talks only to the team address; no native host) | No | Settings › Browser › Your browsers (`web/src/components/settings/ChromeLink.tsx`): rename, sites, Disconnect; in the desktop app also "Use my Chrome". Chat: the site card names the profile (`chrome.site`). Not on a phone |
| AI providers (Claude, ChatGPT, API key, API engine) | Yes (`shared/src/api/credentials.ts:178-185`) | Yes, while the team allows (`credentials.ts:190-197`) | No | Welcome first step (AI connection). Admin › AI providers. Settings › AI providers. Chat "Connect AI" button |
| AI apps using this server (Claude, Claude Code, Codex) | No | Yes, each person (`shared/src/api/remote-mcp.ts:14`) | No | Settings › Trina AX MCP only |
| Room apps | Per project, by its members | n/a | No | Inside a project (`shared/src/api/room-apps.ts`) |

## Hosted or self-host

- **Google sign-in:** hosted teams use the hosting service's Google app, nothing to set up. Since 2026-11-25 a
  self-hosted server with a public address does too: it registers itself at the hosting service (proof of its address,
  `google-drive/broker.ts` `selfInstalledDefault`, `docs/GOOGLE-DRIVE.md`), once the hosting service takes
  self-registrations. Each person connects their own Google with one click, no admin step. Without a public address,
  with `MYCEL_GOOGLE_DRIVE_BROKER_URL=off`, or while the hosting service says no, it needs its own Google Cloud client
  (`google-apps.ts:96-98`, `docs/site/use/google-apps.md`); a client of its own always wins.
- **Sign in with Google (signing in to the team, not a connector):** hosted teams and, since 2026-11-27, self-hosted
  servers with a public address use the hosting service's sign-in broker (`auth/google-login-broker.ts`; it registers the
  server itself with Drive's `register` when the console answers `not_hosted`, independent of Drive). The console serves
  a self-registered server only under its own flag `CP_GOOGLE_SIGNIN_SELF`. A server's own Google client (Drive's)
  always wins. Admin › Sign-in methods holds the switch, an optional Google Workspace domain list (Google's `hd`) and
  "Try it" (`docs/decisions/20261127-google-signin-selfhost.md`).
- **Slack:** "Add to Slack" (the hosting service's app) is hosted-only; self-host pastes its own app's tokens, owner only
  (`slack.ts:35-37`).
- **GitHub:** works where the server holds a GitHub App file; otherwise the card says "Not set up yet".
- **Microsoft 365:** works where the server holds a Microsoft app file (hosted teams: the hosting service writes it with
  `microsoft-app-set`; a self-installed server: its own Entra app); otherwise the card says "Not set up yet". The
  desktop app signs in through 127.0.0.1 on every install type; the web needs the team's address registered in the
  Entra app ([INTEGRATIONS.md](INTEGRATIONS.md) "Microsoft 365").
- **Listed services, templates, AI providers, local apps:** the same everywhere.
- **Desktop app, any browser (2026-11-28):** every wait that opened the system browser (Google Drive and its team
  shares, Gmail/Calendar/Docs/Sheets personal and team, app connections, Slack sign-in and Add to Slack) has
  "Copy link": the same address, to paste into another browser or profile. A result held for the app is redeemed only
  with the app's own proof (`docs/decisions/20261128-held-sign-in-app-key.md`). The web has none (another browser has
  no session there).

## Where the surfaces are

- Welcome tools step (`web/src/components/onboarding/ToolsStep.tsx`): owner, computer only; a phone walks past it
  (`web/src/lib/welcome.ts:87`). Rows: Notion, Higgsfield, Google Drive, Gmail (where the server can connect them);
  everything else, Slack included, is behind Other tools (Settings › Connectors).
- My setup card, "Connect your tools" (`MyToolsRow.tsx`, `myTools.ts`): every member, phone too.
- Admin: `/admin/connectors/<id>` (label "Connected apps"). Personal: `/settings/connectors/<id>` (label "Connectors").
- Mobile apps are a wrapper around the web app (`mobile/README.md`): no connection screen of their own.
- Docs site: `docs/site/use/connect-apps.md`, `google-apps.md`, `mcp.md`, `slack.md`, `api-connections.md`,
  `get-started/team-setup.md`.

## Mismatches found (2026-11-21)

Ranked by how visible they are.

1. **Fixed by #234:** the welcome tools step now offers Connect for the team for Drive and the four Google apps, and the switch for every tool but Slack.
2. **Fixed by #234:** My setup counts a team Drive share as connected (`myTools.ts:37`).
3. **Fixed by #234:** the admin page is "Connected apps" everywhere, in the welcome copy too.
4. **Fixed by #234:** one switch name, "Ask everyone to connect their own", and one tag, "Team asks you to connect".
5. **GitHub docs were out of date (fixed in this PR).** `docs/site/use/mcp.md:20` and `connect-apps.md` say GitHub needs a personal access
   token and an address; the code signs in through the server's GitHub App and lists GitHub in Discover
   (`service-catalog.ts`, `en.ts:3420`).
6. **Fixed in #227 and #234:** `docs/site/get-started/team-setup.md:28` (all languages) now says the Google rows on the step offer both Connect for the team (shared Google account) and the ask-everyone switch.
7. **Fixed by #234:** Notion has the switch now; only Slack is excluded (`team-tools.ts:18`).
8. **Fixed by #253:** a chat's card offers Connect for the team for Google Drive and the four Google apps to an owner or
   admin (the same dialogs as the welcome step and Admin), and a team connection a member may use counts as connected.
9. **Stale comment (fixed in this PR):** `web/src/components/settings/SlackAccount.tsx:1` says "Settings › App connectors"; the label is "Connectors".
