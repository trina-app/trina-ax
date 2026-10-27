# Team AX mobile

An independent Expo SDK 58 wrapper around a team's HTTPS web app. The neutral app asks for a team URL or invitation URL; only the origin is saved in SecureStore. Login, invitations, password changes, attachments and file selection use the existing web UI and its session cookie.

## Development

Install from this directory with `npm ci --ignore-scripts --no-audit --no-fund`. This package has its own `package-lock.json` and `node_modules`; do not add its React Native dependencies to the root workspace. Use a Node version supported by React Native 0.88: `^22.13.0 || ^24.3.0 || >=26.0.0`. Node 25 is outside that range.

Run `npm run typecheck` and `npm start` from this directory. The repository's sanitized test runner can execute the pure bridge tests without starting Expo, contacting a team, or using a provider:

```sh
python3 .validation/run.py mobile-bridge --fixture-id mobile-bridge --timeout 60 bun test tests/unit/mobile-bridge.test.ts tests/unit/mobile-security.test.ts web/test/unit/mobile.test.ts
```

Exact versions are locked in `package.json`/`package-lock.json`. The selected SDK 58 modules match the installed Expo package's `bundledNativeModules.json` compatibility ranges. SDK documentation may recommend a newer patch; this package does not claim to track latest versions automatically.

## Native/web contract

`window.mycelMobile` is installed only in the top document after a trusted page load. Protocol `1` requires both `file-share-v1` and `external-oauth-v1`, an app version, platform, random 256-bit document nonce, and generation. Unsupported/legacy bridge objects do not grant native capabilities. Web login sends `client: mobile` only when this contract is present.

Every message and acknowledgement carries protocol version, transfer/request ID, nonce and generation. The native receiver additionally checks the WebView event's source URL against the chosen HTTPS origin. Page navigation, team changes and logout fence old work immediately. The web adapter captures its session epoch before its first asynchronous wait, so an old operation cannot resume under the next session.

File export uses `file-begin` (name, MIME, declared size, SHA-256), sequential `file-chunk` (`seq`, base64), then `file-end` (`seq`). The web side waits for each acknowledgement. The receiver serializes every native write and verifies actual bytes and SHA-256 before opening the OS share sheet. A transfer is limited to 50 MiB, a chunk to 3 MiB, one active transfer, four reserved queue entries, 200 transfer IDs per document/session, and 60 seconds idle time. Oversized downloads are stopped while streaming even if Content-Length is absent or wrong. Partial/error/expired/finished transfers are removed from app cache. Startup removes leftover app transfer cache.

The cache uses `await File.write(...)`: SDK 58's [FileSystem API](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) returns a promise. A native write must finish before hashing/sharing. SecureStore's plugin keeps its default [Android backup exclusion](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

WebView navigation permits the selected HTTPS origin. Other HTTPS pages open externally; custom schemes, credentials in URLs, file/data/about top documents and external child frames are refused. Same-origin blob previews are allowed only when identified as child frames. `originWhitelist=['*']` deliberately sends all navigation to this policy: WebView's own default rejection path would otherwise call `Linking.openURL` for an arbitrary unmatched scheme.

## Google Drive connection

The web integration calls `openExternal(url, {purpose: 'google-oauth'})`. The only accepted OAuth destination is `https://accounts.google.com/o/oauth2/v2/auth` without credentials, another port, or fragment. Native opens that HTTPS URL in the system browser with `Linking.openURL`; generic external pages use `WebBrowser.openBrowserAsync`.

The external browser must be signed into the **same Team AX user** for the server's OAuth callback. WebView and external-browser cookies are not assumed to be shared. After Google consent, the user manually returns to the app; the original app session polls its flow, displays the account and explicitly completes the connection. No code, refresh token or app-return token crosses this bridge. Native app foreground dispatches a focus event to refresh polling. This design does not require an app OAuth callback scheme. [Expo WebBrowser's cookie behavior](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/) is why an embedded browser modal is not treated as an authenticated cookie-sharing session.

## Editions and validation boundary

`app.config.ts` accepts only `config.extra.teamAxEdition` fields `name`, `accent`, `userAgent`, `scheme`, and `bundleId`, validated by `src/product.ts`. Editions may supply these presentation/identifier values in their own app configuration. Team server URLs, permissions, credentials and executable hooks are not edition settings. Defaults use Team AX and a development bundle identifier. No EAS project, distribution certificate, store account, medical branding or deployment credential is included.

The focused tests cover serialization, forged/outdated messages, generation reset, cancellation, sequence/size/hash failures, timeout cleanup, navigation policy, streamed download bounds and browser fallback. The browser mock covers mobile login classification, file-input upload and CSV bridge bytes. These are not actual iOS/Android device tests.

Before distribution, verify on both platforms: trusted HTTPS/TLS failures, initial/invite login, cookie persistence and session revocation, uploads through the native picker, at least two download chunks with exact hash, share-sheet cancellation, back/keyboard/safe areas, team changes, external Google consent/cancel/same-user browser login/manual app return, and Android child-frame blob previews. Build/signing/store setup remains separate. Logout cancels pending transfers but cannot retract an already opened OS share sheet or copies the user has shared to another app. Native setup/error text currently uses English; the web app keeps its existing locale support.
