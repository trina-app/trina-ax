# The Android app declares MODIFY_AUDIO_SETTINGS, "blocked" means refused, and Android says it shows no message preview yet

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/android-voice-touch-push (phone QA of the Android app 1.0.8 on qa.trina.app, QA TC-4740, TC-4741, TC-4692)

- **Ask (TC-4740):** in the Android app the person allowed the microphone, and the message box still said "Microphone
  access is blocked… Open Settings". logcat: "Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO".
- **Rule:** `mobile/app.config.ts` declares `android.permission.MODIFY_AUDIO_SETTINGS` beside CAMERA and RECORD_AUDIO.
  It is a normal permission (granted at install, no prompt). Chromium's WebView opens no audio input without it, so
  getUserMedia failed with the microphone allowed. react-native-webview 14 already asks for RECORD_AUDIO when the page
  asks, and grants AUDIO_CAPTURE once Android said yes, so nothing else changes on the native side.
- **Rule (web):** the box says "blocked" only for a refusal (lib/recorder.ts `recorderErrorOf`, lib/appWording.ts
  `micErrorKey`):
  - NotAllowedError in a browser that would still ask (Permissions API "prompt": the question was closed): "tap the
    mic again and choose Allow", with no Settings button;
  - NotAllowedError otherwise, and every refusal inside the phone app (there the phone asks, never the page):
    "blocked" with where to allow it, and the phone app's Open Settings;
  - NotFoundError and the like in a browser: "no microphone found"; anything else (NotReadableError, AbortError):
    "couldn't start, another app may be using it";
  - inside the phone app, missing or failed: "couldn't start; if it keeps happening, update the app". 1.0.8 gets
    this until people install the next build.
- **TC-4741 (message box buttons 35–37 dp):** these are the drawn sizes that Android's view tree reports. Each button
  already takes taps from a 44 px box (index.css `touch-hit`; the mic keeps 4 px before send, so the two boxes do not
  overlap). An e2e at 390 px with touch (phone-targets.spec.ts) now checks a room's 📎, mic and send, and the AI chat's
  ＋, mic and send, in light and dark. The visual sizes stay as they are. Growing the drawn buttons to 48 dp would make
  the mic and send boxes overlap.
- **Ask (TC-4692):** "Show message preview" has no effect on Android, which always shows "You have a new message".
- **Rule:** inside the Android app the toggle's description says that notifications show the first line on the
  computer and the iPhone, and that Android phones don't show it yet (lib/appWording.ts `messagePreviewDescKey`).
- **Why not the iPhone's way now:** the iPhone app's notification service extension asks the team server for the
  title and first line with a per-device label key (DECISIONS.md "아이폰 알림의 이름"). No text goes through Apple,
  Google or push.trina.app. On Android the gateway sends an FCM *notification* message (push-gateway/src/fcm.ts).
  Android draws it itself while the app is in the background, without running any app code, so the app gets no chance
  to ask first. Doing the same on Android needs:
  - data-only messages from the gateway. The 1.0.8 app and older would not draw those, so it needs versioning;
  - a native FirebaseMessagingService that takes over from expo-notifications' service and builds the notification
    itself;
  - the label key kept where that service can read it;
  - a time limit with the generic line as the fallback;
  - then a push.trina.app deploy and a store release, testable only on a phone with a signed FCM build.
  That is too big and too risky for this fix. It stays open as its own piece of work.
- **Release:** the permission reaches people only through a new Android build (the version after 1.0.8, Google Play and
  the APK on the update feed). The web wording and the Settings description arrive with the next server release, with
  no app update.
