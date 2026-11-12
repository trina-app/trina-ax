# Connector page: tool descriptions, link names and focus for keyboard, touch and screen readers

- Date (UTC): 2026-11-12 05:03
- Branch: `fix/connector-detail-a11y`
- Status: done
- Where: `web/` (the connector page, `AppDetail.tsx`, and the ⋯ menu, `AppConnectorCard.tsx`). Why: both are the web
  app's own screens (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Accessibility fixes on one page; no API, setting or data change.

## Goal

The simpler connector page (#567) left three gaps for people who do not use a mouse:

1. A tool chip's description shows only on hover. Keyboard, touch and screen-reader users never get it.
2. The privacy and terms links read as "Google" and "Terms": a screen reader does not say what they open.
3. Closing a Google app's Settings, opened from ⋯, leaves focus on the page's body instead of ⋯.

## Scope

In:
- Each tool chip with a description or a "changes" marker takes keyboard focus (`tabIndex=0`), so the shared
  Tooltip shows on focus, and holds the description as screen-reader text. It looks the same.
- The links get accessible names: "Google privacy policy" and "Google terms of service" (new keys, five languages).
- ⋯ (`CardMenu`) puts focus back on its own button before it runs the chosen item, so a dialog opened from it (Settings,
  a confirm) returns focus there when it closes.

Out: the touch tooltip itself (the shared Tooltip never shows on touch; a screen reader reads the chip's text).

## Plain words

New words a person hears: "Google privacy policy", "Google terms of service". No internal names.

## Steps

1. Plan (this file).
2. `AppDetail.tsx` chips and links; i18n keys in all five languages.
3. `CardMenu` focus; unit tests; e2e check in google-apps.

## Risks

No migration. `CardMenu` is shared (Drive, Drive shares, Plugins, Projects): focusing its button before an item runs
only changes where focus goes back to.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests, and the google-apps, drive and
phone-connectors e2e specs.

## Result

- Tool chips: `tabIndex=0` when there is a tooltip (a description or the "changes" marker), the description as
  `sr-only` text inside the chip. Looks the same.
- Links: `aria-label` from the new keys `gapps.privacyName` / `gapps.termsName` ("{by} privacy policy", "{by} terms of
  service") in all five languages.
- `CardMenu` focuses its ⋯ button before running an item, so the Settings dialog (and confirms) return focus to ⋯.
  New unit test `web/test/unit/connector-detail-a11y.test.tsx`; its focus test fails without the fix.
