# Services that sign in only through an app the team makes are listed, and set up once as a template

- Date: 2026-11-25
- Status: accepted
- Supersedes: none
- Branch: feat/own-app-connectors (QA connector sign-in check 2026-11-24, task #2)

- **Ask:** one common way to connect services that let only approved apps sign in (HubSpot, Asana, Box, Zoom, Granola),
  instead of one-off paths like GitHub's.
- **Checked first (2026-11-25):** Granola registers clients itself (201 for a team's https callback) and its docs name
  any MCP client: it is an ordinary listed service. Asana, HubSpot and Box register none and take no metadata document,
  but each lets a team make its own app, with no business review for use inside the team (Asana "MCP app" with
  distribution "Any workspace"; HubSpot MCP Connectors, public beta; Box Admin Console › Box MCP server credentials).
  Zoom needs a paid plan and a Marketplace app and is left out for now.
- **Rule:** a listed service may carry `teamApp` (its guide, and a scope when the service needs one). It is in Discover,
  but nobody connects it until an admin set it up with the team's own app, as a template by default, so each member signs
  in with their own account through it. Members ask an admin from its page; the chat's card is not offered; a
  connection added by its address stops at once with words that say an admin sets it up. The app is the existing "Sign
  in with my own app" (sealed secret, never shown to members); only the way to it is new.
- **Why:** these services refuse every app they have not approved, so a Connect button could only fail. The team's own
  app works today for one team, needs no vendor review, and keeps each person's own permissions at the service. A
  Trina-wide app approved by each vendor would remove the setup step but needs each vendor's partner review, and
  self-hosted teams would still need this path.
- **Left out:** Zoom, Slack (its own integration), Docusign, PagerDuty, Clerk: one entry each when wanted. Whether a
  HubSpot connector or an unpublished app at another vendor works for users of a second account was not checked; one
  team uses one account.
- **Tests:** `tests/unit/c-integrations-approved-apps.test.ts` (recorded metadata of the four services; no lookup or
  registration without the app; a template member signs in at Asana with its app and scope `default`),
  `tests/unit/connect-service.test.ts` (no card), `web/test/unit/connectors.test.ts`.
- **Version impact:** minor (four services added, a new way to set three of them up; nothing existing changes).
