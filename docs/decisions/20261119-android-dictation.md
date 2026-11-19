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
- **Where it is allowed:** an on-device recognizer everywhere the mic shows, confidential chats included: the sound
  never leaves the phone. The default recognizer only *prefers* offline and may send the sound to its maker (Google on
  most phones) when it has no model, so it counts as an outside service: used only for a team whose voice input may
  already go outside (OpenRouter, `voiceInputOutside`), and never in a confidential chat: the check reply says
  `dictationOnDevice: false`, the page's readiness is `shared`. The module never swaps in the default recognizer for
  one the page was told is on the phone. Everywhere else the team
  server transcribes, as before. The team's "voice input off" still hides the mic.
- **Fallback:** see the table in the PR and below; an app without `dictation-v1` (1.0.9 and older, the iPhone), no
  recognizer, a language the phone lacks, a refused start or a recognizer that stops: the team server (the words
  already written stay).

| case | what transcribes |
|---|---|
| Android 1.0.9 or older, the iPhone, a browser | the team server (no `dictation-v1`) |
| on-device recognizer with the language (Android 13+ checked; Android 12 tried at the start) | the phone, everywhere incl. confidential chats |
| Android 13+, language supported but not installed | first tap: the server; the phone fetches the model meanwhile |
| only the default recognizer, team voice may go outside, not confidential | the phone's default recognizer (prefer offline) |
| only the default recognizer, team voice stays on the team server, or a confidential chat | the team server |
| no recognizer, the recognizer refuses the language or does not start in 4 s | the team server (for the rest of the page) |
| the recognizer stops during a recording | the words so far stay, the note says it stopped; later recordings: the server |
| the microphone refused | the page's usual "microphone blocked" note with Open Settings |

- **Measured on the Note10** (Galaxy Note10 SM-N971N, Android 12, Google Speech Services as the default recognizer):
  MEASUREMENTS
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
