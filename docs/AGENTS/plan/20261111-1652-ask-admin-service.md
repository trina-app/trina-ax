# A member asks an admin to add a service (QA TC-286)

- Date (UTC): 2026-11-11 16:52
- Branch: `feat/ask-admin-service`
- Status: done (PR open)
- Where: trina-ax core (`server/src/integrations/service-requests.ts`, `server/src/notifications/service.ts`, the Google
  app and Google Drive setup; `shared/src/api/service-requests.ts`, `notifications.ts`; `web/src/pages/Connectors.tsx`,
  `web/src/pages/Activity.tsx`, `web/src/components/settings/Notifications.tsx`; i18n; mock server; tests). Why: the
  connections and the inbox are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new API, two new inbox events and one additive migration (343).

## Goal

A member who opens an app the team has not set up sees only "Your admin hasn't set up Gmail yet." and a Connect button
that does nothing. Like an app request in Slack, the member taps **Ask admin to add it** and the owner and admins get
one notice in Activity that opens the app's setup. When an admin sets it up, each member who asked gets a quiet notice
that it is ready.

## Scope

In:
- The apps the team sets up once for everyone: Google Drive, Gmail, Google Calendar, Google Docs and Google Sheets,
  while they are **not set up** (Google Drive with no Google app; a Google app card with none). Only these five ids can
  be requested; the server refuses any other name, and refuses an app the member can already connect, one an admin
  turned off for members, one this computer cannot run, and owners and admins (they set it up themselves).
- Member: on that app's page (`/connectors/<id>`, also the phone at 390 px), **Ask admin to add it** takes the place of
  the "not set up" line and the Connect button that cannot work. After the tap: "Request sent"; when the page is opened
  again, or a second tap from another window: "Already asked". Its card in the list says "Asked" instead of "Not set
  up yet". Never a second request while one is open; the state comes from the server, so it survives reloads.
- Owner and admins: one notice per app in Activity: "Alice asked to add Gmail", "Alice and 2 others asked to add
  Gmail", newest asker first. Its row opens the app's setup page in Admin › Connected apps (a small "Set up Gmail"
  button on the row). A new ask makes it unread again and moves it up; it is never a second row.
- When the app becomes something the member can connect (set up, or the members' switch turned on after that), the
  open requests close, the admins' notice is marked read and says "Added", and each asker gets one notice "Gmail is
  ready. You can connect it now." that opens its page. Inbox only, never an OS push (quiet).
- Members never see who the admins are: the member side says "your admin" and the answers carry no admin name.
- Rate limit: at most 10 requests per member a day (one open request per app already keeps it at five at a time).
- Requests close by themselves after 30 days (the inbox's retention), when the asker leaves the team or becomes an
  admin.

Out (for later, or a product question):
- Listed MCP services (Notion, Linear, …) and "Not listed?": a member already adds those with their own account, and
  "Not listed?" names no app in the catalog, so the line stays as it is. When the team turned personal connections off,
  members see no listed services at all; asking for a team connection there is a bigger change.
- An app an admin turned off for members ("Turned off"): that was the admin's choice, so there is no ask button.
- No way to take a request back; it closes on its own.

## Data

Migration `343_c_service_requests.sql` (342 is taken by open PR #430; additive, reader 1):
- `service_requests`: id, user_id (the member), service, created_at, closed_at, closed_reason (`added`, `expired`,
  `left`). At most one open row per member and app (partial unique index).
- `service_request_notices`: inbox rows like the other notice tables (notification_inbox has a fixed event CHECK list).
  `service.request` to each owner and admin, source = the app id (one row per admin and app, armed again by a new
  ask); `service.ready` to the asker, source = the request id. Metadata only: names are read when the inbox is shown.

## API

- `GET /api/integrations/service-requests` (user): my open requests, `[{ service, askedAt }]`.
- `POST /api/integrations/service-requests` `{ service }` (user): `{ service, state: 'sent' | 'already', askedAt }`.
  400 `unknown_service`, 403 for owners and admins, 409 `can_connect` / `not_requestable`, 429 `rate_limited`.
- Inbox: events `service.request` and `service.ready`; `serviceRequest: { service, name, others, open }` for an
  admin's (names only while the viewer is an owner or admin), `{ service }` for the asker's.
- Closing: right after an admin sets up Drive or a Google app, or turns a members' switch on; and every 30 seconds with
  the inbox's check (a server operator's setup, the hosting service's Google sign-in coming up).

## UI and what gets removed

- Removed for members on a not-set-up app: the disabled Connect button and the "Your admin hasn't set up … yet." /
  "Your admin needs to turn this on" line on its page. Admins see the page as before.
- Activity: two new notice rows. Nothing else changes for admins.

## Risks

Migration number (343; check dev again before merging). Inbox union and retention cover the new table. Five languages.
Phone at 390 px. No admin name in a member's answers or notices; no free text from members reaches admins.

## Tests

- Server unit (`tests/unit/c-service-requests.test.ts`): catalog check, members only, can-connect refused, one open
  request, rate limit, the combined notice and its names, no admin names for the member, closing on setup (Drive and a
  Google app) with the asker's notice, expiry, the asker leaving.
- Web unit: the notice texts and links; the ask button states.
- e2e `integrations.spec.ts`: member asks (sent, already after reload, card "Asked"); admin sees the notice, opens the
  setup, sets it up; the member gets "ready".
- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` + `docs-site.test.ts`, the c-*,
  notifications and security-coverage unit files, `bun run test:web`, `bun run build:web`.

## Result

Built as planned in PR #446. Changes after the plan, from the independent review:
- A setup that is not the admins' to make (a hosted team's, an operator's file) cannot be asked for (409
  `not_requestable`): nobody could answer it here.
- The hosting service's Google review ("only its test users") does not close requests as ready.
- The 30-second check also keeps the admins' notices with whoever is an owner or admin now.
- An open page offers Connect as soon as the app is ready (the "ready" notice brings it), without a reload.
- Wording: es "Pedir que lo añadan" / "Solicitado", ko "요청 보냄", ja "管理者に追加を依頼".

Not done: the admins' notice still says "Set up Gmail" when the app is set up but turned off for members (the page it
opens has the members' switch).
