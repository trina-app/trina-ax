# <app> in Chrome: the Chrome Web Store item id, and the privacy policy the store names

- Date (UTC): 2026-11-28 11:23
- Branch: `feat/chrome-store-id`
- Status: done
- Where: `shared/src/chrome-native.ts`, `chrome-extension/store/privacy-practices.md`. Why: follow-up of #727 (app-led
  linking) after the extension was submitted to the Chrome Web Store (unlisted, pending review).
- Version impact: **patch**: the desktop app now names the store item in its native host manifest and links its store
  page; no new feature.

## Goal

The store gave the item its id `pfalalpmbomdafcmobbjlgekhdfjepmc`. With it the packaged desktop app writes the host
manifest (`allowed_origins` = that id only), recognises the installed extension, and "Install" opens the item's own
store page instead of the store search. The store's privacy practices text names https://trina.app/privacy (what the
console has; its section "Trina AX in Chrome (browser extension)") and says the team's AI model provider processes
requests to produce answers.

## Steps

1. `CHROME_EXTENSION_IDS.chromeStore` (the one place; decision 20261128-chrome-app-led-linking).
2. privacy-practices.md: policy URL and the model provider line.
3. Test: the packaged app's ids are the store id only (`tests/unit/e-desktop-chrome-profiles.test.ts`).

## Decisions

none (decision 20261128-chrome-app-led-linking said the ids are filled in once the stores give them).

## Risks

A packaged app now writes `~/Library/Application Support/<browser>/NativeMessagingHosts/com.mycel.chrome_host.json` at
start (macOS, non-store builds). Edge Add-ons id still empty.

## Tests

`bun run typecheck`, `tests/unit/e-desktop-chrome-*.test.ts`, `tests/unit/chrome-link.test.ts`.

## Result

As planned.
