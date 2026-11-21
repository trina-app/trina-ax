# The Android app writes voice input with the phone's own speech recognizer

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (the Android follow-up of [20261119-mac-dictation.md](20261119-mac-dictation.md); the team server's
  way, [20261119-voice-input-latency.md](20261119-voice-input-latency.md), stays the fallback)
- Branch: feat/android-dictation (the owner, 2026-11-19, on the chat microphone and Yogurt: words while talking)

Plan: [docs/AGENTS/plan/20261119-0300-mac-dictation.md](../AGENTS/plan/20261119-0300-mac-dictation.md), "Follow-up:
iPhone and Android".

- **Ask:** in the Android app the words show in the message box while the person talks, as on the Mac.
- **Rule:** Android app 1.0.10 offers `dictation-v1`, the iPhone's capability
  ([20261119-iphone-dictation.md](20261119-iphone-dictation.md), the same app version), with additions an iPhone page ignores. Only a page that says
  `appMic: true` in its `dictation-check` gets Android's recognizer; any other page (one that knows only the iPhone's
  way) is told unsupported and records for the team server as before, so it never runs a recognizer that is not on the
  phone and never opens the microphone twice. The app's module (`mobile/modules/dictation`) runs the system
  `SpeechRecognizer` with partial results for the app language (the phone's own region when its languages name one).
  It uses `createOnDeviceSpeechRecognizer` where the phone has an on-device recognizer (Android 12+; Android 13+ also
  says which languages are installed and can fetch a missing one), else the phone's default recognizer with
  `EXTRA_PREFER_OFFLINE`. Android ends an utterance at a pause; the module starts listening again at once until Stop.
  The page uses it through the same bridge as the iPhone and the Mac (`web/src/lib/mobile.ts` phoneDictation,
  `lib/macDictation.ts`), so the box shows the final words, then the newest guess, Stop waits for the last words, Esc
  puts the box back.
- **The app holds the microphone:** Android 12 cannot hand a recognizer the page's sound (`EXTRA_AUDIO_SOURCE` is
  Android 13+), so while the phone writes the words the page records nothing: the `dictation-check` reply says
  `dictationMic: 'app'`, and the page sends no `dictation-push`. The bar's time and wave run as always, the wave from
  the recognizer's `level` events. The app asks for RECORD_AUDIO itself (the same permission the page's own recording
  asks for).
- **Where it is allowed (on-device only, decided 2026-11-19 after the first version):** only the phone's on-device
  recognizer (`createOnDeviceSpeechRecognizer`), everywhere the mic shows, confidential chats included: the sound never
  leaves the phone. The phone's default recognizer is never used, whatever the team's speech setting: it only
  *prefers* offline and may send the sound to its maker (Google on most phones). A phone without an on-device recognizer
  for the language answers `unsupported` (and the page also treats `dictationOnDevice: false` as unsupported), and the
  team server transcribes, as before. The first version (#42) let the default recognizer run for teams whose voice may
  go outside; that path is gone. The team's "voice input off" still hides the mic.
- **Fallback:** see the table in the PR and below; an app without `dictation-v1` (1.0.9 and older, the iPhone), no
  recognizer, a language the phone lacks, a refused start or a recognizer that stops: the team server (the words
  already written stay).

| case | what transcribes |
|---|---|
| Android 1.0.9 or older, the iPhone, a browser | the team server (no `dictation-v1`) |
| on-device recognizer with the language (Android 13+ checked; Android 12 tried at the start) | the phone, everywhere incl. confidential chats |
| Android 13+, language supported but not installed | first tap: the server; the phone fetches the model meanwhile |
| no on-device recognizer, or none for the language (only the default recognizer: the Note10) | the team server, any team setting, any chat |
| the on-device recognizer refuses the language within 0.5 s of starting (Android 12 cannot check first) | the team server, silently (no "stopped" note), and for that language until the app restarts |
| no start in 4 s | the team server (for the rest of the page) |
| the recognizer stops during a recording | the words so far stay, the note says it stopped; later recordings: the server |
| the microphone refused | the page's usual "microphone blocked" note with Open Settings |

- **Measured on the Note10** (Galaxy Note10 SM-N971N, Android 12, 2026-11-19; side-by-side test build
  `app.trina.ax.dictationtest`, the Play 1.0.9 install untouched):
  - **No on-device recognizer:** `SpeechRecognizer.isOnDeviceRecognitionAvailable` is false (Samsung's Android 12 has no
    on-device recognition service), so under the on-device rule the Note10 uses the team server for every language.
  - The default recognizer is Google Speech Services (`com.google.android.tts`), whose recognizer is in fact Google's
    offline one (SODA). It has the en-US pack but **no Korean pack**: Korean is refused within ~10 ms of starting
    (`LANGUAGE_PACK_ERROR`, error 13), which is why a refusal right after the start is now a silent fallback.
  - English through it (offline, macOS `say` sentences from the Mac speaker; 5 runs): first words 0.81-0.96 s after the
    speech started, then 0.1-0.3 s behind the sound; every word final 0.12-0.21 s after Stop. One clip came through
    whole, others stopped being heard after ~2 s at lower speaker volume: the set-up (speaker distance) limited it.
  - Korean, **cloud** (a test-only build pointed at the Google app's online recognizer; never shipped; 13 of the 20
    Zeroth clips before the run was stopped): 5 clips came back, with first words 1.50-1.89 s after the speech started,
    every word final ~0.11 s after Stop, and 15.6% CER on those 5 (2 clips under 5%). 8 clips gave no words at all
    through the speaker set-up, so the pooled CER (68%) says more about the set-up than the recognizer.
  - Not measured: an on-device Korean recognizer (the Note10 has none), and live numbers without playing sound aloud
    (playback through the speaker was stopped at the owner's request).
- **Left out:** the iPhone (its own follow-up), Android 13+'s segmented sessions (`EXTRA_SEGMENTED_SESSION`, no gap
  between utterances; the Note10 is Android 12), handing the recognizer the page's sound (Android 13+), a setting to
  choose the phone or the server.
- **Tests:** `tests/unit/mobile-dictation-android.test.ts` (the check answer's additions, an iPhone answer unchanged,
  level events and their bounds), `web/test/unit/androidDictation.test.ts` (ownMic, levels to the wave, no sound sent,
  shared readiness), `web/test/e2e/android-dictation.spec.ts` (the composer with a stand-in app: live words with no page
  microphone, a confidential chat on and off the phone, a "this server" team, Esc); the shared parts are the iPhone's
  tests. The module itself was run on the Note10 (above).
- **Version impact:** Android app 1.0.10 (Google Play; not published by this change); the web page side ships with the
  server and does nothing without the capability.
