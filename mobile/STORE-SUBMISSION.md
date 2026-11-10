# Store submission checklist (Trina AX phone app)

What the owner provides or decides before each store step. Engineering steps and the reasons are in
[README.md](README.md) and docs/DECISIONS.md "모바일 앱 출시와 네이티브 푸시".

## Decided / already there

- Bundle id / Android package: `app.trina.ax` (editions/trina/branding/mobile.json). The iOS platform is added to the
  existing App Store Connect record of the Mac App Store app, team `YWW96288YY`, version 1.0.0, then 1.0.1 and 1.0.2;
  the next store version is 1.0.3 (`app.config.ts`).
- From 1.0.1 the iPhone app has a notification service extension, `app.trina.ax.NotificationService` (who and where in a
  room push, docs/DECISIONS.md "아이폰 알림의 이름"). Its App ID and profiles are made by automatic signing at the first
  archive (`-allowProvisioningUpdates` with the Admin API key); nothing to register by hand. It needs no App Group and no
  extra capability: the app and the extension share the keychain group `YWW96288YY.app.trina.ax.notifications`, which
  every profile of the team allows. `scripts/ios-release.sh` stops if the extension, its profile or either target's
  keychain groups are not what they must be.
- Push Notifications capability on the App ID `app.trina.ax`; an APNs auth key (.p8, production, topic `app.trina.ax`).
- An App Store Connect API key (Admin) on the build Mac, outside the repository.
- No Expo account and no EAS project: iOS is built and uploaded from the Mac with `scripts/ios-release.sh`.
- App Review demo team: `https://qa-test.trina.app` (fictional data).

## Links that open the app (first run, phase 2)

- **iPhone**: from 1.0.3 the app declares `applinks:*.trina.app` (Associated Domains). The App ID `app.trina.ax` has
  the **Associated Domains** capability (on since 2026-11-10; without it the archive fails to sign), and automatic
  signing at the archive puts it in the profiles. Each team server serves `apple-app-site-association`
  (`server/src/routes/app-links.ts`); for the wildcard entry serve the same file on `trina.app` itself too (developers
  report Apple's CDN asks the domain after `*.`; Apple's page does not say which), from the website.
- **Android**: the intent filter for `https://*.trina.app` `/invite/…` and `/join` has `autoVerify`; Android checks a
  wildcard host at its root, `https://trina.app/.well-known/assetlinks.json`, with the SHA-256 of the certificate that
  signs the installed app. Team servers already serve the upload key's fingerprint (`shared/src/app-links.ts`, the APK at
  updates.trina.app). When Play signs the app, add the Play app signing certificate's SHA-256 (Play Console › App
  integrity) to the same list, and serve it on `trina.app` too; until then Play installs get the app in Android's chooser
  instead of opening it directly.
- Both: the `trina-ax` scheme (already registered) opens screen ④ for "앱에서 열기".

## TestFlight (internal testers)

1. A build number higher than the last upload (`BUILD_NUMBER`).
2. `cd mobile && ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=<outside the repo>/AuthKey_….p8 BUILD_NUMBER=<n> scripts/ios-release.sh --upload`
3. Internal testers need no Beta App Review; external testers do (it uses the same App Review information as below).

## Push in TestFlight / App Store builds

- Run the push gateway (push-gateway/README.md): `bun push-gateway/src/bun.ts` behind TLS at `push.trina.app`, with
  `APNS_PRIVATE_KEY`, `APNS_KEY_ID` (and later `FCM_SERVICE_ACCOUNT`) in its environment. A Cloudflare Worker cannot
  reach APNs (HTTP/2 only).
- Team servers need the release with migrations 243 and 245 (`/api/push/devices`) and `push.gatewayUrl: "https://push.trina.app"`
  in server.json (or `MYCEL_PUSH_GATEWAY`): phone push is off until then. Owners see it in Settings › Notifications.
- Who and where on the iPhone (1.0.1) needs the gateway release that marks room pushes mutable (`push-gateway/src/apns.ts`)
  and team servers with migration 263 (`/api/push/devices/:id/label`). With either missing the phone shows the generic
  line, as before. Check on TestFlight: a DM and a mention show "name" and "name · #room" (a thread "› 스레드"), never the
  text; signing out clears them; a team on an older release still gets the generic line.

## App Store review (owner)

- **Privacy policy URL** (public page) and **support URL**; both go into App Store Connect.
- **App Privacy questionnaire**: device id (the push token) for app functionality; contact info, user content and
  identifiers handled by the team server through the WebView, linked to the person, not used for tracking. The app
  itself has no analytics or ads SDK.
- **Reviewer account** on `https://qa-test.trina.app` (a member, not the owner) with a demo folder and a few files;
  keep the server up during the whole review. App Review Information: the team address to type on the first screen,
  username, password.
- **Review notes** (draft): "Trina AX is the client of a team's own workspace server; accounts are created by the team
  admin. Enter https://qa-test.trina.app on the first screen. Native features: push notifications (asked after sign-in;
  a conversation message says who wrote it and where, never the message itself), the iOS share sheet for downloaded files, the native photo/camera picker for attachments, voice
  input, an offline / cannot-reach screen with retry. Account deletion: Settings › Profile › Delete account (계정 삭제) opens
  "Request account deletion"; the team owner is notified in the app and removes the account; the personal files are archived for the owner."
- **Screenshots**: 6.9-inch iPhone (1320 × 2868 or 1290 × 2796), at least the first screen, a chat, files and
  notifications, with the fictional data. No iPad (iPhone only in v1).
- Age rating, content rights and export compliance (answered by `ITSAppUsesNonExemptEncryption=false`).

## Google Play

- The Play developer account exists. Create the app `app.trina.ax` in Play Console and turn on Play App Signing.
- An upload keystore kept outside the repository (and backed up); its SHA-256 is printed by the build.
- Build: `cd mobile && ANDROID_HOME=<sdk> ANDROID_KEYSTORE_PATH=… ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=…
  ANDROID_KEY_PASSWORD=… BUILD_NUMBER=<n> scripts/android-release.sh` → `mobile/build/android-<n>/Trina-AX-<version>-<n>.aab` (the version in `app.config.ts`).
  Upload the first `.aab` by hand (internal testing); the Play API refuses the first upload of a new app.
- Push on Android needs a Firebase project for `app.trina.ax`: `google-services.json` for the build
  (`MYCEL_MOBILE_GOOGLE_SERVICES`) and the service-account JSON for the gateway (`FCM_SERVICE_ACCOUNT`). Without them
  the app works without push.
- Data safety form (camera and microphone for chat attachments and voice input, the push token, what the team server
  holds), the privacy policy link, content rating, target audience, and the reviewer account on
  `https://qa-test.trina.app`. A personal account created after 2023-11-13 needs a closed test with 12 testers for
  14 days before production; an organization account does not, according to third-party reports.
