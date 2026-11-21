# Android room notifications name who and where, never the message text

- Date: 2026-11-21
- Status: accepted
- Supersedes: none
- Branch: feat/android-push-who-where (PR #21, QA TC-366 / tracking TC-204; written 2026-11-15, moved here from the archive when the branch was revived on 2026-11-21)

- **A room push (`room.*`) and a chat shared by name (`chat.shared`) on Android now show who and where**, as on the
  iPhone since 1.0.1 ("아이폰 알림의 이름"): title "민준 · #마케팅 › 스레드" (a DM "민준", a shared chat the sharer's
  name). **The same words as the iPhone (revised 2026-11-21 when the branch was revived: "match the iPhone behaviour exactly"):** the text
  is the label answer's `body` when there is one (the message's first line while the person's message preview is on,
  else the generic line; for a shared chat the fixed "shared a chat" line), made plain to at most 200 characters as the
  extension does, and `roomId` groups the room's notifications (the iPhone's `threadIdentifier`). The 11-15 version
  took only `title` and always showed the gateway's line; that differed from the iPhone with preview on, the default.
  The words come from the team server over https; Google and the gateway see only the generic words. Quiet hours, the person's
  settings, the room's level and "read/left/deleted" are the server's checks, unchanged: the label answer is `{}` for
  every one of them, and a push that the server holds back is not sent at all.
- **Why the gateway changes for Android.** An FCM message with a `notification` block is shown by Android itself while
  the app is in the background or closed; no app code runs, so nothing can ask the team. The app needs a data-only
  message. The contract gets one optional key, `label: true` (Android only; shared/src/cloud-protocol/push-gateway.ts
  "Label"). With it, for a room code or `chat.shared`, the gateway sends no `notification` block and puts the generic
  `title`, `message`, `channelId: 'default'` and `tag` (the notice id, so expo-notifications' own path replaces a resend
  of the same notice) into `data` next to `{ notificationId, code, path?, device? }`. Every
  other message, and every message without the key, is exactly as before.
- **Who gets `label`.** The team server sends it only to an Android device row with a label key hash (`label_hash`,
  migration 263, now also kept for Android). Only an Android app that offers `push-label-v1` sends a hash, so the
  installed Android builds up to 1.0.10 and every Android build before this change never get a data-only push and keep the gateway's line.
- **Compatibility.** An older gateway refuses the key (400 `invalid_body`, its schema is strict): the team server sends
  the same push again without it and sends no `label` to that gateway for an hour (the `badge` rule,
  `NO_BADGE_RETRY_MS`). An older team server never sends the key: it accepts `labelHash` from an Android page but does
  not keep it, so the new app gets the gateway's line there. A new app on an
  older team server or gateway therefore shows the generic line; nothing breaks in any order of deploys.
- **How the app builds it (expo-notifications 58).** Not a headless JS task: React Native would have to start in the
  background within FCM's few seconds, and expo-notifications shows no data-only message in the foreground. Instead the
  app's own module `mobile/modules/push-label` declares `LabelMessagingService`, a subclass of expo-notifications'
  `ExpoFirebaseMessagingService` whose delegate overrides `createNotificationRequest`: for a data-only room push it asks
  the team (`POST /api/push/devices/:id/label`, the iPhone's request: the stored origin only, https, no redirects, no
  cache, `x-mycel-csrf`, at most 4 s, an answer of at most 4 KiB, the title made plain) and hands expo-notifications the
  team's title and the generic line. FCM runs the service even when the app is closed (not after a force stop, as for
  every Android app). The notification still goes through expo-notifications: channel `default`, quiet in the
  foreground (`quietForeground`), id = the notice id (a resend replaces it, as the old `tag` did), and a tap reaches the
  app with the push's own data (the FCM trigger is kept). Any failure, or no label item, shows the gateway's title and
  line. `plugins/push-label.js` removes expo-notifications' service from the app's manifest and stops the prebuild when
  expo-notifications changes what the service overrides.
- **The key on Android.** The label item (`src/labels.ts`, the same JSON as the iPhone's keychain item) is stored by the
  module, encrypted with an AES-GCM key in the Android Keystore that never leaves the phone. Android's Auto Backup may
  copy the encrypted file, but a restored copy cannot be read on another phone or after a reinstall: the same promise
  as the iPhone's `THIS_DEVICE_ONLY`. Before the phone's first unlock FCM holds the push (the service is not direct-boot aware), so it is shown, named,
  after the unlock. It is
  deleted on a team change, a sign-out and at a launch that finds it stale, as on the iPhone.
- Tests: `tests/unit/push-gateway.test.ts` (the contract key, the data-only shape, other codes and older apps
  unchanged), `tests/unit/push-label-gateway.test.ts` (the team server's key and the older-gateway fallback),
  `tests/unit/push-label.test.ts` (an Android device with a key: `label` on the push, the same answer),
  `tests/unit/mobile-labels.test.ts` (the hash on Android), `tests/unit/mobile-push-label-android.test.ts` (the plugin,
  the manifest, the Kotlin's rules). No CI job builds Android. On 2026-11-21 a local `expo prebuild` and `./gradlew :push-label:compileDebugKotlin
  :app:processDebugMainManifest` compiled the module and merged the manifest (our service is the only FCM entry besides
  Firebase's own base service; expo-notifications' is removed). It found that expo-notifications is linked as a prebuilt
  AAR, not a Gradle project, so `project(':expo-notifications')` failed; build.gradle now takes the AAR then. At the PR, `Label.kt`, `LabelStore.kt` and
  `LabelMessagingService.kt` were compiled with kotlinc against stubs of the expo-notifications and Firebase
  signatures they use, and the pure helpers (plain, teamOrigin, named, title) were run on the JVM;
  `PushLabelModule.kt`, the manifest merge and `assembleDebug` were not (they need NDK 27.1).
- Version impact: **minor** (a new optional gateway key, a new phone behaviour; no migration).
- **Lock screen (open for the owner, 2026-11-21).** What a locked phone shows follows the phone's own setting, on both
  phones: the iPhone's Show Previews (default "When Unlocked": the lock screen hides title and text) and Android's lock
  screen notifications ("show all content", the default on stock Android and MIUI, shows them; "hide sensitive content"
  shows "Contents hidden"). So with the defaults, an Android lock screen now shows who and where (and the first line
  with preview on), where the iPhone's shows "Notification". Matching the iPhone's default would need a public version
  of the notification with the generic words, which expo-notifications' builder has no field for (a custom presentation
  delegate); not built in this change.
- **Review fixes (2026-11-21):** the body and room group above; a team that did not answer makes the next minute's
  pushes skip the ask (FCM hands this app's messages over one at a time, 4 s each); spaces collapse as Swift's
  `isWhitespace` does (`\p{Z}` too); a default vibration on Android 7; no empty `Cookie` header; `tag` in the data;
  the settings line "Android phones don't show it yet" only for an Android app without `push-label-v1`.
