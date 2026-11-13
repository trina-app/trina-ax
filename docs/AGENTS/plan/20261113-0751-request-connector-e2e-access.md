# e2e: request-connector follows the add-app dialog's "For · Change" line

- Date (UTC): 2026-11-13 07:51
- Branch: `fix/request-connector-e2e-access`
- Status: in progress
- Where: web/test/e2e. Why: the spec still opens Advanced to reach "Who can use it", which #687 moved under the "For · Change" line
- Version impact: none — a test change only

## Goal

request-connector.spec.ts "member asks for Notion, takes it back, asks again…" times out on dev waiting for
`integration-access-everyone` inside Advanced. Since #687 (QA TC-187) the chooser opens from the "For: … · Change" line.

## Scope

In: that spec, using the `adv()` helper (it opens the chooser through Change). A grep of web/test, tests and desktop/e2e for
the other test ids #687 removed or moved (radio options, the Advanced summary, the access chooser inside Advanced)
found no other use outside the specs #687 already updated (drive-team-share's chooser is the Drive dialog's own).
Out: app code (the test shows no bug: the saved access is the whole team either way).

## Plain-words check

No visible words change.

## Tests

`bun run typecheck`; e2e request-connector plus the 9 dialog specs (integrations, integration-templates, connectors-hub,
a11y, request-connector, integration-requests, skill-tool-counts, welcome-tools, drive-team-share).

## Result

(at the end)
