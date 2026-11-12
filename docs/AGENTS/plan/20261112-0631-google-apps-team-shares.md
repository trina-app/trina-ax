# Share an admin's Gmail, Calendar, Docs or Sheets with the team, like Drive shares

- Date (UTC): 2026-11-12 06:31
- Branch: `plan/google-apps-team-shares` (this plan only; the code comes in its own branch after the owner approves it)
- Status: draft
- Where: `server/src/integrations/google-apps/`, `shared/src/api/google-apps.ts`, `web/` (Admin › Connectors). Why: the
  connectors are the core's (see docs/REPOSITORY-RULES.md).
- Version impact: minor. A new admin feature, new API endpoints and a migration.

## Goal

The owner wants every connector to be shareable with the team from its admin page, not only Google Drive. Today:

- **Google Drive**: an admin connects a Google account and shares it with people or groups (`drive_team_shares`,
  `google-drive/shares.ts`, `share-admin.ts`): chosen folders only, read only, a rule of who may use it, checked again
  on every call, and the share stops when its admin leaves.
- **Team MCP connections** already have a team scope and an audience (`integrations.scope = 'team'`, `access`).
- **Gmail, Google Calendar, Google Docs, Google Sheets** have **no** shared connection on the server: a connection is a
  personal row of `integrations` with `google_app` set, usable only by its owner (`connections/store.ts`: `row.scope ===
  'personal' && row.owner_user_id === userId`). Sharing one needs new server work, planned here.

What changes for people: an admin can connect a company account (for example `sales@company`) to Gmail or Calendar and
let chosen people or groups use it in their chats, as with a shared Drive. Members keep their own connections.

## Scope

In:
- A **team share** of one Google app: an admin's sign-in for that app, a name ("Sales mailbox"), who may use it (the
  same `IntegrationAccess` picker as team connections and Drive shares), and for each app what the share may do (see
  Security). Several shares per app.
- Server: a share row per app (new table, or `integrations` rows with `scope = 'team'` and `google_app` set; see Steps),
  its sign-in (the app's existing flow with `purpose: 'share'`, like Drive's), tools offered to the people its rule
  covers, named by source (`team:<name>`) next to their own (`mine`), as Drive's tools do.
- Admin › Connectors › Gmail (and each app): in Team settings a "Share with the team" row with the shares listed under
  it, the same as Google Drive's (DriveShares.tsx), and the same dialog steps (sign in, confirm the account, name, who).
- A member's page and chat: a shared one shows as "Shared by your team" with its name; nothing to connect.

Out: sharing a member's own connection (only admins share, as with Drive); a personal share between two members; Slack.

## Security

- **Gmail sends as the shared account.** A message sent through a share is from that account, not from the member
  asking. So: a share is **read only by default** (search, read, read attachments). Draft and send are an extra choice
  per share ("Members may draft and send from it"), off by default, and every send goes through the confirm card (no
  Always allow for a shared send), with "Sent from <account> by <person>" in the card and the audit.
- **Calendar, Docs, Sheets.** Changes are made as the shared account. Same rule: read only by default; changes an extra
  choice per share; the confirm card every time.
- **Who sees what.** The rule decides who may use it; each call checks the rule again (as Drive does), so a removed
  person loses it at once. Results stay in the asking person's chat. In a team chat room the private answer rule applies
  as for personal apps (only the asker sees the result until they share it).
- **Audit.** Every tool call on a share is logged with the share, the person and the action (search/read/draft/send/
  change), never the content or an address beyond the share's name. Share created, rule changed, re-signed in, stopped.
- **Owner leaves.** As Drive: when the admin whose account it is leaves, is disabled or is no longer an admin, the share
  stops, its tokens are deleted (revocation attempted) and the other admins get a notice to sign in again.
- **Tokens.** Sealed per share (`drive-share:<id>`-style context, e.g. `google-app-share:<app>:<id>`), never returned,
  logged or audited; a share's tokens are not the admin's own connection's (a separate sign-in).
- **Scheduled runs** use a share only when the task's card named it, like personal connections.

## Steps

1. Decide the storage with the owner: (a) a new table `google_app_shares` modelled on `drive_team_shares`, or (b)
   `integrations` rows with `scope = 'team'`, `google_app` set and `access`. (a) keeps Drive and the apps alike and the
   personal path untouched; (b) reuses the connections store, tools gate and audit. Recommendation: (b), with the
   share-only fields (allowed actions, owner admin) in its config.
2. Migration (check the highest number in `server/migrations/` on dev first; 701 on 2026-11-12).
3. Server: share sign-in (`purpose: 'share'`), admin API (list, create, change rule/allowed actions, stop), tools
   offered by rule with the source name, the write gate for shares (confirm every time), owner checks, audit.
4. Web: Admin › Connectors › <app> Team settings "Share with the team" (reuse DriveShares.tsx's dialog and rows), member
   page "Shared by your team".
5. Tests: unit (rule checked per call, read-only default, send needs the extra choice and the card, owner leaves, no
   token in answers/log/audit), e2e (admin shares Gmail read only; a member in the rule searches it, one outside does
   not see it), docs/GOOGLE-APPS.md and docs/DECISIONS.md.

## Risks

Sending mail as a company account is the main risk (see Security). A migration. The five app languages. The Google
app's review: the broker's scopes are the same, but a shared mailbox is a new use to mention in the hosting service's
Google review if needed.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the Google apps unit tests and the security cases,
and the e2e specs for google-apps and admin connectors.

## Result

Filled in at the end.
