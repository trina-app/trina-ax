# A listed service's page looks like the Google connector pages

- Date (UTC): 2026-11-13 04:08
- Branch: `fix/connector-detail-like-app`
- Status: done
- Where: `web/` (the Connectors pages in Settings and Admin). Why: the web app's own screens (see
  docs/REPOSITORY-RULES.md).
- Version impact: minor. A visible UI change, and one additive optional API field (`Integration.lastErrorReason`); no
  setting, permission or data change.

## Goal

QA TC-197 (tracking TC-747): a listed service's page (Higgsfield, Notion, Atlassian, Figma…) and a team or own
connection's page still use the old boxed layout: a big header card, a nested card with the logo and name again, chips,
the same error twice, the raw address, "Key saved · Last tried", "Used by / Added by", Check again with edit and delete
icons, "100 of 185 tools" as a link. PR #567 made the Google pages simple (`AppDetail.tsx`) and left this one out.
Now every connector page has the same layout.

## Scope

In:
- One page for a connection (`ConnectionPage.tsx`), built on `AppDetail`: `Connectors › Higgsfield` / logo, name, one
  line, on the right the one status or action (Connected ✓, Sign in, Error) and ⋯ / sign-in under way / one short error
  line with what to do next / About / one line on what the AI may do / Tools as chips / details (Made by, Sign-in,
  Privacy and Terms, Help, Last used; the address only for a connection added by its address).
- ⋯ holds what the row's buttons did: Check again, Sign in again, Edit, Ask every time (the person's own Always allow),
  Delete. Same rules as before (managers only; no Edit and no sign-in in the phone app).
- Tools: chips (a tool that changes things keeps its pen marker; a tool turned off is shown muted, "Off"). Under them one
  muted line when the service offers more tools than the AI can use ("The service offers 185 tools; the AI can use the
  first 100."), and for whoever manages it "Turn tools on or off", which opens the switch list (moved from the row).
- A listed service before it is connected: the same layout; its listed tools as chips (first 12, "Show all" in place,
  the link to the service's tool page), Privacy, Terms and Help in the details.
- Admin: a team connection's page has "Team settings" under the details like the Google admin pages: "Who can use it"
  (Used by, Added by, "Not in your chats"); "Nobody can use it yet" stays as a warning line under the header. Who and
  the permission level are changed in Edit, as before. The listed service's admin page opens the team connection's page
  once the team has one.
- `AppDetail` gets small additions only: a tool can be `off`, a note under the tools, extra details rows, a text for
  the "what the AI may do" line, and rows without a value are left out.

Removed: `ConnectorDetail` (the boxed card and its own back button), `IntegrationRow` on these pages (the nested card,
its badges and the expand toggle), the second copy of the error, "Key saved · Last tried" as one line (now Sign-in and
Last used in the details), the raw address on a listed service's page.

Out: the add-connection dialog, the Ask a member dialog, Google's pages (other PRs). No permission changes.

## Plain words

"Made by", "Sign-in", "Privacy", "Terms", "Help", "Last used", "Turn tools on or off", "Who can use it". No "MCP" on a
listed service's page. The error line says what happened and what to do next ("Try Check again in ⋯, or Edit it.",
"Ask an admin to look at it.").

## Steps

1. Plan (this file).
2. `AppDetail.tsx` additions; `ConnectionPage.tsx` (connection page, listed page, tools dialog).
3. Callers: `pages/Connectors.tsx` (listed, own and team connection pages), `pages/admin/Integrations.tsx` (listed and
   team pages); remove `ConnectorDetail` and the unused `IntegrationRow` parts; i18n in five languages.
4. Unit and e2e tests updated; screenshots 1440/390 light (connected, with an error, not connected; a Google page).

## Risks

- Many e2e specs used the row's test ids (integration-toggle, -refresh, -edit, -delete). The menu items keep the old ids
  where they can; specs that opened the row are updated.
- Phone: the details and chips wrap at 390; ⋯ items are the same as the row's buttons.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, and the e2e
specs that use these pages (integrations, connectors-hub, integration-templates, integration-requests,
request-connector, skill-tool-counts, a11y, phone-*).

## Result

- `web/src/components/integrations/ConnectionPage.tsx`: `ConnectionPage` (a connection) and `ListedServicePage` (a
  listed service before it is connected), both on `AppDetail`, and the tools dialog with the switches.
- `AppDetail.tsx` additions only: `AppTool.off`, `toolsNote`, `more` (extra details rows, `Detail` and `ExtLink`
  exported), `abilities`; rows without a value are left out. Google's pages look the same as before.
- `ConnectorsView.tsx`: `ConnectorDetail` removed. `IntegrationRow.tsx`: the row component removed; the actions hook,
  `SignInPanel` (no side margins now) and `AudienceChip` stay.
- Callers: `pages/Connectors.tsx` (listed, own and team connection pages; `MineRows` removed) and
  `pages/admin/Integrations.tsx` (listed and team pages, Team settings › Who can use it).
- Differs from the plan: more than 12 tools show the first 12 chips with "Show all N" (Higgsfield has 186); the About
  texts lost their "asks first" sentence (the line under them says it); the "Official" mark is gone (the line says
  "By <service>"); "Nobody can use it yet" shows once, in Who can use it.
- DECISIONS entry "A listed service's and a connection's page look like the Google connectors' pages".
- Review fixes: one error line from the reason code (`lastErrorReason`, additive) in the page's own words with one next
  step per reader (managers here, an admin in Settings → Admin › Connected apps, members → ask an admin); the server's
  words alone for an unknown code; "Its tools show here once it works." for a connection in error; "Checking…" while
  Check again runs; "Reading is free" reworded.
