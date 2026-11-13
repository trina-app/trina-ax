# "Add an app for the team": simple like Team settings, pick from Discover, app icon

- Date (UTC): 2026-11-13 04:08
- Branch: `fix/add-team-app-dialog`
- Status: in progress
- Where: web/src/components/integrations/IntegrationDialog.tsx (+ Admin › Connectors, Modal title). Why: QA TC-187, TC-189, TC-190
- Version impact: patch — layout and flow of an existing dialog; no new permission, API or data change

## Goal

Admins found the add-app dialog loud and long: large labels, red errors on a fresh form, two lines for "For" and the
sign-in note, a summary next to Advanced, and six groups of bordered radio pills inside it, one repeating "For".
Adding a well-known app meant typing its address. Make it read like Team settings, and let the admin pick the app.

## Scope

In:
- Name and Address as Team settings rows (label + one short line left, the field right); errors only after Save or
  after leaving a field the admin typed in.
- "For: … · Change" and the sign-in note as one quiet line. Change opens "Who can use it" under that line; it is no
  longer repeated inside Advanced.
- Advanced: the word only (no summary, no box). Inside: rows with a select (who connects, type, sign-in method,
  writing/deleting/sending, the key's header) or a switch (own app), each with one short line.
- Admin's Add / "Team connection": first a searchable list of the Discover apps (icon + name), "Custom app (enter an
  address)" last. Picking one fills name, address, type and sign-in, with a Back to the list. "Add one by its address"
  still opens the custom form directly.
- From Discover: the app icon next to "Add Notion" in the title; the address as a small quiet line.
Out: the "Ask a member to connect" dialog, a listed service's page, Google shared connections; any default or
permission change.

## Steps

1. Modal: title accepts a ReactNode (strings keep working).
2. IntegrationDialog: rows, selects, switch, merged line, access under the line, picker step (`choices` prop).
3. Admin Integrations passes the not-yet-connected Discover apps.
4. Strings in five languages; update e2e specs for selects and the picker.

## Plain-words check

New words: "Search apps", "Custom app (enter an address)", short row lines such as "Leave as it is unless the app's
help says API." No MCP/OAuth in the new lines (option names stay as before).

## Risks

e2e specs check radio options by test id: options keep their ids, specs switch to selecting them. Personal
Settings › Connectors uses the same dialog and gets the same layout, without the picker.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, e2e:
integrations, integration-templates, connectors-hub, a11y, request-connector, integration-requests, skill-tool-counts.

## Result

(at the end)
