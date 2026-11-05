# Store submission checklist (Trina AX phone app)

What the owner provides or decides before each store step. Engineering steps and the reasons are in
[README.md](README.md) and docs/DECISIONS.md "모바일 앱 출시와 네이티브 푸시".

## Decided / already there

- Bundle id / Android package: `app.trina.ax` (editions/trina/branding/mobile.json). The iOS platform is added to the
  existing App Store Connect record of the Mac App Store app, team `YWW96288YY`, version 1.0.0.
- Push Notifications capability on the App ID `app.trina.ax`; an APNs auth key (.p8, production, topic `app.trina.ax`).
- An App Store Connect API key (Admin) on the build Mac, outside the repository.
- No Expo account and no EAS project: iOS is built and uploaded from the Mac with `scripts/ios-release.sh`.
- App Review demo team: `https://qa-test.trina.app` (fictional data).

## TestFlight (internal testers)

1. A build number higher than the last upload (`BUILD_NUMBER`).
2. `cd mobile && ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=<outside the repo>/AuthKey_….p8 BUILD_NUMBER=<n> scripts/ios-release.sh --upload`
3. Internal testers need no Beta App Review; external testers do (it uses the same App Review information as below).

## Push in TestFlight / App Store builds

- Run the push gateway (push-gateway/README.md): `bun push-gateway/src/bun.ts` behind TLS at `push.trina.app`, with
  `APNS_PRIVATE_KEY`, `APNS_KEY_ID` (and later `FCM_SERVICE_ACCOUNT`) in its environment. A Cloudflare Worker cannot
  reach APNs (HTTP/2 only).
- Team servers need the release with migration 240 (`/api/push/devices`) and `push.gatewayUrl: "https://push.trina.app"`
  in server.json (or `MYCEL_PUSH_GATEWAY`): phone push is off until then. Owners see it in Settings › Notifications.

## App Store review (owner)

- **Privacy policy URL** (public page) and **support URL**; both go into App Store Connect.
- **App Privacy questionnaire**: device id (the push token) for app functionality; contact info, user content and
  identifiers handled by the team server through the WebView, linked to the person, not used for tracking. The app
  itself has no analytics or ads SDK.
- **Reviewer account** on `https://qa-test.trina.app` (a member, not the owner) with a demo folder and a few files;
  keep the server up during the whole review. App Review Information: the team address to type on the first screen,
  username, password.
- **Review notes** (draft): "Trina AX is the client of a team's own workspace server; accounts are created by the team
  admin. Enter https://qa-test.trina.app on the first screen. Native features: push notifications (asked after sign-in,
  generic text only), the iOS share sheet for downloaded files, the native photo/camera picker for attachments, voice
  input, an offline / cannot-reach screen with retry. Account deletion: Settings › Profile › Delete account (계정 삭제) opens
  "Request account deletion"; the team owner is notified in the app and removes the account; the personal files are archived for the owner."
- **Screenshots**: 6.9-inch iPhone (1320 × 2868 or 1290 × 2796), at least the first screen, a chat, files and
  notifications, with the fictional data. No iPad (iPhone only in v1).
- Age rating, content rights and export compliance (answered by `ITSAppUsesNonExemptEncryption=false`).

## Google Play (not set up yet)

- A Play Console organization account (D-U-N-S; USD 25). A personal account created after 2023-11-13 needs a closed
  test with 12 testers for 14 days before production.
- A Firebase project for `app.trina.ax`: `google-services.json` for the build (`MYCEL_MOBILE_GOOGLE_SERVICES`) and the
  service-account JSON for the gateway (`FCM_SERVICE_ACCOUNT`).
- An upload keystore (kept outside the repository), the Data safety form, the privacy policy link, and the first `.aab`
  uploaded by hand in Play Console. Camera and microphone are still blocked in the Android build; test them there before
  allowing them.
