# One card per site in the person's browser profiles, and the Web Store screenshots

- Date (UTC): 2026-11-28
- Branch: `fix/chrome-one-card-per-site`
- Status: done
- Where: server/src/chat/tools.ts (browserTool, askChromeSite), chrome-extension/store/. Why: QA of #718 on the QA
  server (see docs/decisions/20261128-trina-in-chrome.md).
- Version impact: patch (fewer cards for the same site; no contract change).

## Goal

QA on qa.trina.app (a search on Hacker News in a linked profile) asked three times about two sites. The address card
("Always allow this site") and the Chrome site card kept their answers apart, so one site could ask on both.

## Scope

In:
- "Always allow this site" on the address card for a call in a profile is kept for that profile too.
- "Always allow this site" on the Chrome site card is also the person's own site for the address check. It still opens
  nothing in another profile, because each profile hears only its own list.
- Web Store screenshots (en, ko), 1280x800, from QA with test data.

Out: nothing else.

## Steps

1. Change the two places in tools.ts, and update the unit test.
2. Add the screenshots and a README line.

## Decisions

None new. This follows 20261128-trina-in-chrome ("an Always in one profile never opens anything in another" still
holds).

## Risks

None beyond the site rules above.

## Tests

`tests/unit/chrome-link.test.ts`, `tests/e2e/chrome-extension.test.ts`, `bun run check:prepush`.

## Result

As planned.
