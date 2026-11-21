# Connections: what each tool can do and where it is offered

One map of every connectable tool. Read it before you change a connection mode or a surface that offers one; **update
it in the same PR**. Built from the code on `dev` (2026-11-21); file:line points at where the mode lives.

Words: **Team** = one connection the owner or an admin makes once, used by the people the admin picks. **Personal** =
each person signs in with their own account. **Team pick** = the admin recommends a personal tool; it only sorts the
list (`shared/src/api/team-tools.ts:13`), nothing is gated.

## The table

| Tool | Team connection | Personal | Team pick | Offered where |
|---|---|---|---|---|
| Google Drive | Yes, "Shared with the team": an admin shares chosen folders or a whole Drive (`shared/src/api/drive.ts:84-89`, `web/src/components/integrations/DriveShares.tsx`) | Yes (`oauth.ts:132`) | Yes | Welcome tools step: Team pick only. Admin › Connected apps. Settings › Connectors. My setup card: personal only. Chat: card (`server/src/chat/connect-service.ts:245`) |
| Gmail, Calendar, Docs, Sheets | Yes, "Shared Google account": one account for the app (`shared/src/api/google-apps.ts:67,160-165`, `GoogleAppTeam.tsx`) | Yes | Yes (`team-tools.ts:19`) | Welcome tools step: Gmail Team pick only; Calendar, Docs, Sheets not offered. Admin › Connected apps. Settings › Connectors. My setup card (shows "team" state, `web/src/lib/myTools.ts:43`). Chat: no card, tells the person which page (`server/src/chat/connect-google-app.ts`) |
| Notion | Yes, MCP team connection (`shared/src/api/integrations.ts:406`) | Yes | No, excluded (`team-tools.ts:15`) | Welcome tools step: Connect for the team (`ToolsStep.tsx:36`). Admin › Connected apps. Settings › Connectors. My setup card. Chat card (personal; team only for admins, `connect-service.ts:269`) |
| Slack | Yes, its own page: the team's Slack app, "Add to Slack" (hosted) or own app tokens (owner only) (`shared/src/api/slack.ts:129,138`) | Link-only: each person links their Slack account (`slack.ts:132-136`) | No, excluded | Welcome tools step: Connect for the team. Admin › Connected apps › Slack. Settings › Connectors › Slack line (`SlackAccount.tsx`) |
| GitHub | Yes, MCP team connection | Yes, signs in through the server's GitHub App (`shared/src/service-catalog.ts`, `server/src/integrations/github/app.ts`) | Yes (listed service) | Admin › Connected apps. Settings › Connectors. Chat card. Not on the welcome steps |
| Higgsfield and every other listed service (about 40: Linear, Atlassian, Figma, Canva, Stripe, Supabase, Vercel …) | Yes, MCP team connection | Yes | Yes | Admin › Connected apps. Settings › Connectors (Discover). Chat card. My setup card shows only Notion by default (`myTools.ts:14`) |
| Any MCP server or API by address | Yes, team connection, or a template each member connects with their own key (`integrations.ts:405,416`) | Yes (admin may turn personal off, `server/src/admin/settings.ts:28`) | No | Admin › Connected apps › Add one by its address. Settings › Connectors › Add custom connector (members see "Ask an admin to add it" for what is not listed) |
| Apps on the computer (Aside, ego lite, any program) | No, always personal (`integrations.ts:394`) | Yes, desktop app only | Yes for Aside and ego lite (`team-tools.ts:17`) | Settings › Connectors (desktop). Not in the welcome steps or on a phone |
| AI providers (Claude, ChatGPT, API key, API engine) | Yes (`shared/src/api/credentials.ts:178-185`) | Yes, while the team allows (`credentials.ts:190-197`) | No | Welcome first step (AI connection). Admin › AI providers. Settings › AI providers. Chat "Connect AI" button |
| AI apps using this server (Claude, Claude Code, Codex) | No | Yes, each person (`shared/src/api/remote-mcp.ts:14`) | No | Settings › Trina AX MCP only |
| Room apps | Per project, by its members | n/a | No | Inside a project (`shared/src/api/room-apps.ts`) |

## Hosted or self-host

- **Google sign-in:** hosted teams use the hosting service's Google app, nothing to set up; a self-hosted server needs
  its own Google Cloud client (`google-apps.ts:96-98`, `docs/site/use/google-apps.md`).
- **Slack:** "Add to Slack" (the hosting service's app) is hosted-only; self-host pastes its own app's tokens, owner only
  (`slack.ts:35-37`).
- **GitHub:** works where the server holds a GitHub App file; otherwise the card says "Not set up yet".
- **Listed services, templates, AI providers, local apps:** the same everywhere.

## Where the surfaces are

- Welcome tools step (`web/src/components/onboarding/ToolsStep.tsx`): owner, computer only; a phone walks past it
  (`web/src/lib/welcome.ts:87`).
- My setup card, "Connect your tools" (`MyToolsRow.tsx`, `myTools.ts`): every member, phone too.
- Admin: `/admin/connectors/<id>` (label "Connected apps"). Personal: `/settings/connectors/<id>` (label "Connectors").
- Mobile apps are a wrapper around the web app (`mobile/README.md`): no connection screen of their own.
- Docs site: `docs/site/use/connect-apps.md`, `google-apps.md`, `mcp.md`, `slack.md`, `api-connections.md`,
  `get-started/team-setup.md`.

## Mismatches found (2026-11-21; not fixed here)

Ranked by how visible they are.

1. **Welcome tools step hides the shared Google account.** Google Drive and Gmail get only a Team pick
   (`ToolsStep.tsx:38`); the "Shared Google account" and "Shared with the team" modes exist
   (`GoogleAppTeam.tsx`, `DriveShares.tsx`) but the step has no way to make them. Calendar, Docs and Sheets are not
   offered at all. Notion and Slack get Connect for the team only, never a Team pick.
2. **My setup card ignores a Drive team share.** `MyToolsRow.tsx:46` reads only the person's own Drive status, so a
   member with a Drive shared with them still sees [Connect]; Google apps show "team" correctly (`MyToolsRow.tsx:47`).
3. **Name of the admin page.** The label is "Connected apps" (`web/src/i18n/en.ts:3600`), but the welcome step's own
   code comments and `docs/decisions/20261120-team-vs-personal-onboarding.md` say "Admin › Connectors", and
   `en.ts:5533` says "Admin › Connectors". Settings' label is "Connectors". The same word names two places.
4. **Team pick has three names.** The tag is "Team pick" (`en.ts:5755`), the switch on a tool's page is "Recommend to
   the team" (`en.ts:5757`), the welcome switch is "Team pick" (`en.ts:5537`), the Korean is "팀 추천".
5. **GitHub docs are out of date.** `docs/site/use/mcp.md:20` and `connect-apps.md` say GitHub needs a personal access
   token and an address; the code signs in through the server's GitHub App and lists GitHub in Discover
   (`service-catalog.ts`, `en.ts:3420`).
6. **Docs site pages disagree with the step.** `docs/site/get-started/team-setup.md:28` says "Connect for the team"
   covers Notion or Slack and Team pick covers Drive and Gmail, but never says a team Google account exists there or
   that Calendar, Docs and Sheets cannot be picked on that step. `google-apps.md` says the team account is under
   "Admin › Connected apps", which matches the label.
7. **Team pick for Notion and Slack is excluded in code** (`team-tools.ts:15`) while Notion is also connected
   personally by default in My setup (`myTools.ts:14`): a member connects Notion alone even when the team connected it
   (shown as "team", no button, correct), but an admin cannot recommend it for people who want their own.
8. **Chat cards cover team scope only for MCP services**; Google apps and Drive never get a team option from a chat
   (`connect-google-app.ts`, `connect-service.ts:134,161`).
9. **Stale comment:** `SlackAccount.tsx:1` says "Settings › App connectors"; the label is "Connectors".
