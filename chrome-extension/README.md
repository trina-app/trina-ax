# <app> in Chrome

A browser extension that lets the team's AI use the person's own Chrome (also Edge and Brave) when they ask it to:
the sites they are already signed in to, in tabs they can watch. It works for every install type (hosted teams, the
office Mac, a self-hosted server), because the extension connects out to the team's own address. Design:
[docs/decisions/20261128-trina-in-chrome.md](../docs/decisions/20261128-trina-in-chrome.md).

The name, icons and words come from the branding at build time (`PRODUCT` in `shared/src/product.ts`,
`editions/trina/branding/chrome/`). The store listing text for the Trina edition is in [store/](store/).

## Build

```sh
bun chrome-extension/build.ts          # chrome-extension/dist/ (load this folder unpacked)
bun chrome-extension/build.ts --zip    # also chrome-extension/release/<artifactBase>-chrome-<version>.zip
bunx tsc -p chrome-extension/tsconfig.json --noEmit
bun test tests/unit/chrome-ext-*.test.ts
```

The version is `EXTENSION_VERSION` in `build.ts` (semver, plain numbers: the Web Store needs them). Bump it for each
upload.

## Install for QA (unpacked)

1. Build (above).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. **Load unpacked** and pick the folder `chrome-extension/dist`.
5. Pin the extension (puzzle icon › pin) so its icon and badge stay visible.

Use a test profile and test data only (QA team on qa.trina.app). Never a customer's team.

## How it works

- **Connect (pairing, PKCE).** Open the team in a tab and click the extension's icon. The popup offers "Connect to
  <that address>" (or another address) and a name for this browser profile ("Work mail"); each profile is its own
  link. Chrome asks to allow that one address (optional host access). The extension makes a secret verifier and opens
  `<team>/connect-chrome?challenge=<sha256(verifier)>`. The signed-in team page shows the team and the account and
  asks Connect / Cancel; Connect moves that tab to `/connect-chrome/done#code=…`. The extension reads the code from
  that tab's address, closes the tab and spends it with the verifier (`POST /api/chrome/redeem`). The link token is kept
  only in `chrome.storage.local`. A copied address or code is useless without the verifier.
- **Connection.** One WebSocket to `<team>/api/chrome/ws`; the token goes in the first frame. A ping every 20 s keeps
  the worker awake; an alarm reconnects within a minute after Chrome put it to sleep. Close code 4401 (the link was
  revoked in Settings) forgets the token.
- **Tasks.** Every call names its run (a chat or a scheduled run). Each run gets its own background window (never
  focused) with one tab group "<app> · <task>"; it sees and drives only that group's tabs. At most 4 runs have a
  window at once; a run's window closes after 10 minutes without a call. Closing a task's window stops that task.
- **Sites.** The server sends with each call the sites this profile may use. A call on any other site does nothing and
  answers `site_needed`; the server asks the person in the chat and sends the call again. Hard blocks no server value
  lifts: the team's own addresses, this computer, account-security and password pages, extension stores, non-web
  pages, and office-network addresses without the office card (also a public name served from a private address).
  Rules: `src/sites.ts` (unit-tested).
- **Guards.** Requests from a driven tab to the team's addresses fail (CDP Fetch). After the AI runs a script in a
  page, that page's requests to sites nobody allowed fail until it navigates. Password and payment-card fields are
  refused. The extension runs a fixed list of DevTools Protocol methods (`src/cdp-methods.ts`, checked by a test):
  never cookies or site storage.
- **Stop.** The popup lists the tasks working now, each with Stop. Closing Chrome's "started debugging this browser"
  bar stops all of them. The chat's Stop cancels the call from the server.

Files: `worker.ts` (entry), `link.ts` (connection), `pairing.ts`, `calls.ts` (dedupe, deadline, stop), `runs.ts`
(windows and groups per task), `tabs.ts` (debugger, events), `tools.ts` (the tools, ported from the desktop pane),
`guard.ts`, `sites.ts`, `popup.*`, `messages.ts` (six languages).

## Publishing to the Chrome Web Store (not done)

Needs a Chrome Web Store developer account (one-time USD 5 fee): the owner's decision and account.

1. Register at https://chrome.google.com/webstore/devconsole with the team's Google account; pay the fee; verify the
   contact e-mail.
2. `bun chrome-extension/build.ts --zip`; upload `release/<artifactBase>-chrome-<version>.zip` as a new item.
3. Store listing: paste from [store/listing-en.md](store/listing-en.md) (and add the Korean listing from
   [store/listing-ko.md](store/listing-ko.md)); upload `store/store-icon-128.png`, `store/promo-small-440x280.png`
   and at least one 1280x800 screenshot (from QA).
4. Privacy practices tab: paste from [store/privacy-practices.md](store/privacy-practices.md); link the privacy policy
   (https://ax.trina.app/privacy or the site's current policy page).
5. Distribution: public or unlisted (unlisted until the first customers try it), all regions.
6. Submit for review. The `debugger` permission gets an in-depth review; expect several days.
7. After approval put the store link into Settings › Browser (web) in place of the unpacked-install docs link.
   Edge Add-ons (https://partner.microsoft.com/dashboard/microsoftedge) takes the same zip.
