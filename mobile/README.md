# Trina AX mobile

An independent Expo SDK 58 wrapper around a team's HTTPS web app. The neutral app asks for a team URL or invitation URL; only the origin is saved in SecureStore. Login, invitations, password changes, attachments and file selection use the existing web UI and its session cookie. The Trina edition (`MYCEL_MOBILE_EDITION=trina`) is the store app `app.trina.ax`; what the owner provides for the stores is in [STORE-SUBMISSION.md](STORE-SUBMISSION.md).

## Development

Install from this directory with `npm ci --ignore-scripts --no-audit --no-fund`. This package has its own `package-lock.json` and `node_modules`; do not add its React Native dependencies to the root workspace. Use Node `^22.18.0 || ^24.3.0 || >=26.0.0`, within React Native 0.88's supported range. Expo's dynamic config imports a TypeScript helper and requires Node's default type stripping; do not disable it. Node 22.22.0 is verified. Node 25 is outside the supported range.

Run `npm run typecheck` and `npm start` from this directory. The repository's sanitized test runner can execute the pure bridge tests without starting Expo, contacting a team, or using a provider:

```sh
python3 .validation/run.py mobile-bridge --fixture-id mobile-bridge --timeout 60 bun test tests/unit/mobile-bridge.test.ts tests/unit/mobile-security.test.ts tests/unit/mobile-push.test.ts web/test/unit/mobile.test.ts
```

From the repository root, `bun test tests/unit/mobile-*.test.ts web/test/unit/mobile.test.ts` runs the same tests; `tests/unit/push-native.test.ts` covers the server side of push and `tests/unit/push-gateway*.test.ts` the gateway.

### iOS build without Expo's services

No Expo account or EAS project is used. `MYCEL_MOBILE_EDITION=trina npx expo prebuild --platform ios` writes `ios/` (ignored). `scripts/ios-release.sh` does the store build on a Mac with Xcode: prebuild, `xcodebuild archive` with automatic signing and an App Store Connect API key, export for App Store Connect, and with `--upload` `altool --validate-app` and `--upload-app`:

```sh
ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> ASC_KEY_PATH=<outside the repo>/AuthKey_<key id>.p8 BUILD_NUMBER=<n> scripts/ios-release.sh --upload
```

The key stays where it is; the script only passes its path. `BUILD_NUMBER` must grow with every upload. `eas.json` is optional and unused. A simulator build: with `MYCEL_MOBILE_EDITION=trina` exported (Expo's "Generate app.config" build phase reads it again inside xcodebuild, and the app reads that config at runtime), prebuild, then `xcodebuild -workspace ios/TrinaAX.xcworkspace -scheme TrinaAX -configuration Release -sdk iphonesimulator -derivedDataPath build/sim CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build`. Keep it signed (ad hoc): an unsigned build cannot use the keychain, so SecureStore fails to save the team address.

Exact versions are locked in `package.json`/`package-lock.json`. The selected SDK 58 modules match the installed Expo package's `bundledNativeModules.json` compatibility ranges. SDK documentation may recommend a newer patch; this package does not claim to track latest versions automatically.

## Native/web contract

`window.mycelMobile` is installed only in the top document after a trusted page load. Protocol `1` requires both `file-share-v1` and `external-oauth-v1`, an app version, platform, random 256-bit document nonce, and generation. `push-token-v1` is optional: an app or page without it keeps working with push off. Unsupported/legacy bridge objects do not grant native capabilities. Web login sends `client: mobile` only when this contract is present.

Every message and acknowledgement carries protocol version, transfer/request ID, nonce and generation. The native receiver additionally checks the WebView event's source URL against the chosen HTTPS origin. Page navigation, team changes and logout fence old work immediately. The web adapter captures its session epoch before its first asynchronous wait, so an old operation cannot resume under the next session.

File export uses `file-begin` (name, MIME, declared size, SHA-256), sequential `file-chunk` (`seq`, base64), then `file-end` (`seq`). The web side waits for each acknowledgement. The receiver serializes every native write and verifies actual bytes and SHA-256 before opening the OS share sheet. A transfer is limited to 50 MiB, a chunk to 3 MiB, one active transfer, four reserved queue entries, 200 transfer IDs per document/session, and 60 seconds idle time. Oversized downloads are stopped while streaming even if Content-Length is absent or wrong. Partial/error/expired/finished transfers are removed from app cache. Startup removes leftover app transfer cache.

The cache uses `await File.write(...)`: SDK 58's [FileSystem API](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) returns a promise. A native write must finish before hashing/sharing. SecureStore's plugin keeps its default [Android backup exclusion](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

WebView navigation permits the selected HTTPS origin. Other HTTPS pages open externally; custom schemes, credentials in URLs, file/data/about top documents and external child frames are refused. Same-origin blob previews are allowed only when identified as child frames. `originWhitelist=['*']` deliberately sends all navigation to this policy: WebView's own default rejection path would otherwise call `Linking.openURL` for an arbitrary unmatched scheme.

## Push notifications

After sign-in (never at first launch) the web page (`web/src/lib/mobile-push.ts`) sends `push-token`; the app shows the OS permission prompt if the person has not answered yet and replies with `push: { platform, token, environment }` (APNs hex token or FCM token from `getDevicePushTokenAsync`; `sandbox` for development-signed iOS builds, otherwise `production`), or `push_denied` / `push_unavailable`. The reply passes the same origin, nonce and generation checks as file transfers and is dropped after logout or navigation. The page registers the token with its own team (`POST /api/push/devices`, bound to the session; logout removes it with the session). It does not register again by itself after the person turned push off; Settings › Notifications turns it on again. The page then sends `push-registered` with the team's device id and a removal key; on a team switch (also from the cannot-reach screen) the app removes the device from the old team with that key (`POST /api/push/devices/:id/remove`), retrying at later starts if that server is unreachable (`src/device.ts`). The team server sends through a push gateway (`push-gateway/`), never to Apple or Google itself, and only when its operator set one (`push.gatewayUrl` / `MYCEL_PUSH_GATEWAY`); notifications carry generic text only.

Tapping a notification opens its `path` on the current team only if it is an id path (`/rooms/<id>`; no scheme, host, `//`, `..`, query or fragment), its `tag` is the device registered with this team, and it arrived after this team was chosen. Changing team clears delivered notifications. In the foreground a notification goes to the list without a banner. Android push needs the owner's `google-services.json` (`MYCEL_MOBILE_GOOGLE_SERVICES=<path>` at build time); without it Android logs one line and push stays off.

## Native screens and permissions

Setup, offline ("인터넷에 연결되어 있지 않아요") and cannot-reach-team screens use Korean when the phone's first language is Korean and English otherwise (`src/strings.ts`); both have Try again and Change team address. The web app keeps its own locales. iOS has camera, microphone and photo library usage strings in both languages (attachments and voice input in chat); the WebView grants camera/microphone only to the team's own host. Android still blocks camera and microphone (not shipping on Android yet).

## Google Drive connection

The web integration calls `openExternal(url, {purpose: 'google-oauth'})`. The only accepted OAuth destination is `https://accounts.google.com/o/oauth2/v2/auth` without credentials, another port, or fragment. Native opens that HTTPS URL in the system browser with `Linking.openURL`; generic external pages use `WebBrowser.openBrowserAsync`.

The external browser must be signed into the **same Trina AX user** for the server's OAuth callback. WebView and external-browser cookies are not assumed to be shared. After Google consent, the user manually returns to the app; the original app session polls its flow, displays the account and explicitly completes the connection. No code, refresh token or app-return token crosses this bridge. Native app foreground dispatches a focus event to refresh polling. This design does not require an app OAuth callback scheme. [Expo WebBrowser's cookie behavior](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/) is why an embedded browser modal is not treated as an authenticated cookie-sharing session.

## Editions and validation boundary

`app.config.ts` accepts only the fields `name`, `accent`, `userAgent`, `scheme`, `bundleId`, `background` and `appleTeamId`, validated by `src/product.ts`, from `editions/<name>/branding/mobile.json` when `MYCEL_MOBILE_EDITION=<name>` is set (otherwise `config.extra.teamAxEdition`), plus the fixed files `icon.png`, `adaptive-icon.png` and `splash-icon.png` in `editions/<name>/branding/mobile/`. Team server URLs, permissions, credentials and executable hooks are not edition settings. Without an edition the source keeps neutral Team AX defaults and the development bundle identifier `app.teamax.mobile.dev`; the default accent is the Trina orange (`#e8521a`, with the button label in warm black, `accentInk()`). The Trina edition is `app.trina.ax`, iPhone only, version 1.0.0 with the build number from `MYCEL_MOBILE_BUILD_NUMBER`. No distribution certificate, API key, store account, medical branding or deployment credential is in the repository.

The focused tests cover serialization, forged/outdated messages, generation reset, cancellation, sequence/size/hash failures, timeout cleanup, navigation policy, streamed download bounds and browser fallback. The browser mock covers mobile login classification, file-input upload and CSV bridge bytes. These are not actual iOS/Android device tests.

Before distribution, verify on both platforms: a real push from the gateway (permission after sign-in, generic text, tap opens the path, logout stops it), the offline screen, camera/microphone in chat, initial/invite login, cookie persistence and session revocation, uploads through the native picker, at least two download chunks with exact hash, share-sheet cancellation, back/keyboard/safe areas, team changes, external Google consent/cancel/same-user browser login/manual app return, and Android child-frame blob previews. Build/signing/store setup remains separate. Logout cancels pending transfers but cannot retract an already opened OS share sheet or copies the user has shared to another app.
