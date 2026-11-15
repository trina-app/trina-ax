# Guests are not asked to connect; Activity log keeps each change; one admin menu item marked; hosted Slack line

- Date (UTC): 2026-11-15 08:34
- Branch: `fix/guest-request-audit-menu`
- Status: in progress
- Where: server/src/integrations/connections, web/src (admin pages, lib/activity). Why: QA findings on the connectors
  audit (see docs/REPOSITORY-RULES.md).
- Version impact: patch: bug fixes, no new feature, no API shape change.

## Goal

QA sheet TC-2948, TC-2953; tracking TC-3035, TC-3033.

1. An admin can ask a guest to connect a service (Admin › Connected apps › Ask a member to connect, and the API returns
   201). The guest gets a notice they can never open. Guests must not be listed, and the server must refuse with a
   plain line. Requests already sent to guests end (withdrawn) when the admin's list is read.
2. The Activity log folds two quick edits of one connection into one row ("· 2 times") with only the latest detail, so
   the first edit can't be seen. Admin rows whose details differ are no longer folded.
3. Opening Admin from an Inbox notice can show two admin menu items highlighted: the current page and the item under
   the pointer, which look the same. The item under the pointer gets a lighter colour than the current page.
4. Official Slack app (hosted): "unreachable" asks the admin to check the server's internet connection, which a hosted
   admin can't do. In official mode it says Trina keeps trying and to contact support if it lasts.

## Scope

In: the four fixes above, all 6 languages, unit + web + e2e tests.
Out: other guest checks on connectors (TC-2949 passed; TC-2950 Slack needs a real workspace).

## Steps

1. requests.ts: member query adds `guest = 0`; a guest gets a plain refusal; listTeam ends pending requests to guests.
2. RequestDialog.tsx: the picker leaves out guests (role 'guest').
3. lib/activity.ts: sameEvent compares the detail of admin rows.
4. AdminLayout.tsx: hover colour of a menu item that is not the current page differs from the current page's.
5. Slack.tsx (after PR #950): official mode's unreachable line.

## Risks

No migration. Narrows access only. Words in 6 languages. Phone and desktop admin menu (phone uses its own list).

## Plain-words check

New lines: "Guests can't be asked to connect a service." and the Slack line "Trina will keep trying. If this lasts,
contact support." No internal words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit c-integrations*, web unit tests, e2e
integration-requests, activity-log, admin menu, slack-in-connectors.

## Result

(filled in at the end)
