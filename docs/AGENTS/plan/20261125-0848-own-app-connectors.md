# Services that sign in only through an approved app: one common way (HubSpot, Asana, Box, Zoom, Granola)

- Date (UTC): 2026-11-25 08:48
- Branch: `feat/own-app-connectors`
- Status: draft
- Where: `shared/src/service-catalog.ts`, `web/src/lib/connectors.ts`, `web/src/components/integrations/`,
  `server/src/integrations/connections/`, `server/src/chat/connect-service.ts`, `docs/`. Why: connectors are the
  integrations area (docs/REPOSITORY-RULES.md, docs/WORKPLAN.md).
- Version impact: minor. Five new services in Discover and a new way to set them up; nothing existing changes.

## Goal

Some services refuse apps they have not approved: no dynamic client registration, and no Client ID Metadata Document
(docs/INTEGRATIONS.md "Sign-in"). Today Trina leaves them out of Discover (`web/src/lib/connectors.ts`: "Slack, Asana,
HubSpot, Box, Zoom …") and a person who adds one by address ends on `oauth_approved_apps_only`.

The pieces to connect them already exist but nobody can find them: "Sign in with my own app" (`oauthClient` on a
connection or a template, docs/INTEGRATIONS.md "Your own app (client ID)") takes an app the team made in the service's
console. What is missing is the common path around it:

- An admin opens HubSpot in Discover, sees "Needs your team's own HubSpot app", follows 4 short steps with the redirect
  address to copy, pastes the client ID and secret, and saves it as a template. Each member then signs in with their
  own HubSpot account.
- A member who opens it before an admin set it up gets **Ask admin to add it** (the existing service request), never a
  Connect button that cannot work.
- The AI's connect card for one of these services says the same thing instead of failing at sign-in.

One catalog flag drives all of it, so adding the next service (Slack, Docusign, PagerDuty, Clerk …) is one entry, a
logo and a guide.

## Scope

In:
- Part A (#2, build): the catalog flag, the Discover entries for HubSpot, Asana, Box, Zoom and Granola, the admin setup
  screen, the member and chat-card paths, docs and tests.
- Part B (test only, no code unless a bug turns up): the 13 connectors on the QA sheet "Connectors sign-in
  2026-11-24" assigned to raka (C-14 … C-26), with Intercom (C-17) and Square (C-21) from the desktop app.
- Part C: a live sign-in of each of the five services on qa.trina.app through its own app, recorded in the sheet.

Out:
- Figma (refuses all unapproved apps, including a team's own; waits on Figma's access request).
- Composio or any third-party connector source (docs/decisions/20261118-composio-plan.md, not scheduled).
- A Trina-wide app approved by each vendor (the vendor's partner review: weeks, a business owner's decision). This plan
  is what works until then and what self-hosted teams will use anyway.
- Slack, Docusign, PagerDuty, Clerk: same path, later, one entry each.

## Steps

1. **Check each service first (day 1, before code).** For HubSpot, Asana, Box, Zoom and Granola, read the vendor's MCP
   docs and probe the address (unauthenticated `initialize`, `/.well-known/oauth-protected-resource`,
   `/.well-known/oauth-authorization-server`). Record for each: the official MCP address, whether it takes a
   team-made app (client ID + secret) at all, where the app is made (console URL, free plan or paid), the scopes to
   ask for, and whether sign-in and token addresses are found or must be given. A service that takes no team-made app
   (only the vendor's own partners) is dropped from this PR and noted in the plan's Result. Nothing in this plan
   assumes the answers.
2. **Catalog flag** in `shared/src/service-catalog.ts`: `ownApp: { console: string; scope?: string; authorizationUrl?:
   string; tokenUrl?: string }` on the five entries, with a comment citing the page checked in step 1. `CATALOG_AUTH`
   stays `oauth`. `connect-service.ts` keeps trusting only the catalog's address.
3. **Discover** (`web/src/lib/connectors.ts`, logos in `web/public/icons/connectors`, sources in
   `docs/THIRD-PARTY-NOTICES.md`): the five appear with a "Needs your team's app" line. Remove them from the
   "left out" comment.
4. **Admin setup** (Admin › Connected apps, the service's page): for an `ownApp` service, the add dialog opens on
   template + "Sign in with my own app" with the catalog's scope and addresses filled in, the redirect address with
   its copy button (`https://<team>/api/integrations/oauth/callback`, every address people sign in from), and a short
   numbered guide per service (message keys in all five app languages). Reuses `AppSection` in
   `IntegrationDialog.tsx`; no new storage (`oauth_client` and its sealed secret exist, migration 338), so no migration.
5. **Member path**: an `ownApp` service with no template or team connection for the member shows **Ask admin to add
   it** (`POST /api/integrations/service-requests`, already allowed for listed services since TC-133) and no Connect.
   A member who adds the address by hand gets the same words instead of `oauth_approved_apps_only`: new reason
   `oauth_needs_team_app` in `server/src/integrations/connections/text.ts` ("HubSpot connects through your team's own
   app. Ask an admin to set it up."), and it is not counted as a failed sign-in try.
6. **AI connect card**: for an `ownApp` service not set up, the card says the same and offers the request, not a sign-in.
7. **Docs**: docs/INTEGRATIONS.md (a "Services that need the team's own app" section, the Discover paragraph),
   docs/CONNECTIONS.md (the template mode for these services), docs/site/use pages in the five languages,
   `changes/own-app-connectors.md`, and a decision file `docs/decisions/20261125-own-app-connectors.md`.
8. **Part B**: run C-14 … C-26 on qa.trina.app (Connect, sign in, ask the AI to read one thing, record Result + note +
   chat link + date in the sheet). Intercom and Square from the desktop app (127.0.0.1 return). PayPal and Stripe may
   need a business account: Blocked with the vendor's reason, as with Brex and Razorpay.
9. **Part C**: after the batch merge reaches qa.trina.app, make a test app in each service's console (test accounts
   only), set it up as a template, sign in as a member, have the AI read one thing. Add five rows to the sheet.

## Decisions

New: `docs/decisions/20261125-own-app-connectors.md`: services that refuse unapproved apps are listed in Discover and
connect through a team-made app as a template, driven by one catalog flag, until (and alongside) any vendor-approved
Trina app. Builds on docs/INTEGRATIONS.md "Your own app (client ID)" and on the chat connect card trusting the app's
list (docs/DECISIONS.md "The chat's connect card trusts the app's list").

## Risks

- **Vendor facts unknown until step 1.** A service may need a paid plan or a partner review to make an app; it is then
  dropped, not faked.
- **Secrets**: the client secret path is the existing sealed one; no new place stores it. Prefilled addresses come only
  from the catalog, never from the service's answer, so a service cannot move where the secret goes (`pinFound` stays).
- **Redirect address per server**: qa.trina.app, the office Mac's Tailscale address and a customer's address each need
  their own entry in the vendor app; the guide says so.
- **No migration** expected (highest on dev is 702). If step 4 needs one, take the next free number on dev at that time.
- Five app languages for every new string (`bun run check:i18n`). Phone: members only see Ask admin, no setup screen.
- Merges to dev through one batch branch with the other reviewed PRs (owner's rule), not on its own.

## Tests

- `bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`.
- Unit: `tests/unit/c-integrations-own-app.test.ts` (template with prefilled addresses from the catalog),
  `tests/unit/c-integrations-approved-apps.test.ts` (`oauth_needs_team_app` for an `ownApp` address, not counted as a
  try), `web/test/unit/connectors.test.ts` (new logos pass the SVG allowlist), `web/test/unit/integrations.test.ts`
  (dialog prefill, member sees Ask admin), the connect-card test for an unset `ownApp` service.
- Full `tests/unit` and `tests/security` before the batch PR; web e2e for Discover and the admin dialog.
- Live: Part B and Part C rows in the QA sheet.

## Result

(to fill in)
