# The Mac app transcribes voice input on the Mac itself, and keeps its words as they are

- Date: 2026-11-19
- Status: accepted
- Supersedes: none (adds a path in front of [20261119-voice-input-latency.md](20261119-voice-input-latency.md) and
  [20261117-voice-live-text.md](20261117-voice-live-text.md), which stay the team server's way)
- Branch: feat/mac-dictation (the owner, 2026-11-19, on the chat microphone and Yogurt, github.com/FrigadeHQ/yogurt:
  "걔네랑 똑같이 가면 되잖어")

Plan: [docs/AGENTS/plan/20261119-0300-mac-dictation.md](../AGENTS/plan/20261119-0300-mac-dictation.md).

- **Ask:** in the Mac desktop app the words show in the box while the person talks, as in Yogurt, on the Mac itself.
- **Rule:** inside the desktop app on an Apple silicon Mac with macOS 26, voice input for the app language goes to
  Apple's SpeechTranscriber (SpeechAnalyzer, `.volatileResults` + `.fastResults`) in a small helper of the app
  (`desktop/native/dictation`, signed and notarized with the app). The page records as before and hands the 16 kHz
  samples to the app (bridge `dictation`); the box shows the final words, then the newest guess, which the next text
  replaces. After Stop the Mac makes every word final and that is the text: no second pass. The first tap for a
  language fetches Apple's model (AssetInventory) and that one recording goes to the team server, the bar saying how
  far the model is. The team server transcribes on Intel, before macOS 26, on Windows, in browsers and the phone apps,
  for a language the Mac lacks (Indonesian), while the model is missing or failed to download, and after the helper
  failed (until the app restarts; the words already written stay).
- **Where it is allowed:** everywhere the mic shows, confidential chats and Safe operations 1A included, with voice
  input through OpenRouter too: the sound never leaves the Mac, which is stricter than every speech setting (off, this
  server, OpenRouter) and uses none of the plan's speech hours. No team setting asks for the server's handling (the
  speech settings say where sound may go, not that the server must hear it), so there is nothing to follow the other
  way. The team's "voice input off" still hides the mic: an admin's off means off.
- **Permissions:** SpeechTranscriber asks no Speech Recognition question (checked on macOS 26.6: it ran with that
  permission "not determined"), and the helper never opens the microphone, so the app's one microphone question stays
  the only one and no Info.plist text is added. A microphone macOS refused now says so in the Mac's words (System
  Settings › Privacy & Security › Microphone) with Open Settings, in the calm blocked-mic notice of PR #1367; it said
  "your browser settings" before.
- **Language:** the app language, with the Mac's own region when its languages name one (en-GB), else a usual region
  (en-US, ko-KR, ja-JP, zh-CN, es-ES). SpeechTranscriber has no automatic language, so there is none.
- **Measured** (2026-11-19, this Mac: M1 Max, macOS 26.6.2; real read speech, not TTS: 60 Zeroth Korean test clips
  from 10 speakers, 9.5 min, and 73 LibriSpeech clips, 8.0 min; the helper fed in real time, 100 ms every 100 ms):
  - Delay: first words 1.26 s after the speech starts in Korean (median 1.10, p90 2.22), 0.88 s in English (median
    0.66, p90 1.37); the guess then keeps up with the speech (0.0-0.1 s behind); after Stop every word is final in
    0.37 s in Korean (p90 1.41, max 2.56) and 0.20 s in English (p90 0.36). The team server's way (PR #1377): first
    words in about 3.2-3.5 s, then each word 3.7-4.2 s after it was said, plus the answer after Stop. Through the real
    app and its bridge with the real helper: every word final 40 ms (ko) and 125 ms (en) after Stop.
  - Errors (Korean CER without spaces and punctuation, English WER, pooled): the Mac 6.1% / 3.7%; whisper
    large-v3-turbo q5_0 (Yogurt's second pass, and OpenRouter's model for the team server) 6.7% / 5.0%; whisper small
    (the server's own local path) 10.8% / 8.3%. The Mac writes numbers as digits where Zeroth spells them out, which
    counts against it: on the clips where no output has a digit (40 ko, 68 en) the Mac 2.7% / 3.4%, turbo 2.7% / 5.2%,
    small 6.8% / 8.2%. Whole clips, not the server's 7 s pieces, which cost whisper about a point more.
- **Why no whisper pass as Yogurt does:** it would not be more accurate (turbo is no better in Korean and worse in
  English here), it would add a 574 MB download per person and about 0.5 s after Stop per 10 s of speech, and the text
  would change after the person saw it.
- **Left out:** the iPhone and Android apps (the plan's follow-up section); the Mac App Store build (its sandbox; it has
  no helper and uses the server); Windows (no on-device speech API of this quality); a setting to choose the Mac or the
  server.
- **Tests:** `tests/unit/e-desktop-dictation.test.ts` (the app's side with `tests/fixtures/dictation/fake-dictation.ts`),
  `web/test/unit/macDictation.test.ts` (the page's state machine, readiness, the Mac's blocked-mic words),
  `desktop/e2e/dictation.spec.ts` (the bridge in the real app with the fake helper), `web/test/e2e/mac-dictation.spec.ts`
  (the composer with a stand-in bridge: live words, a confidential chat, first use, Esc, a helper that stops, a blocked
  microphone). The bench is outside the repo (scripts and numbers in the PR).
- **Version impact:** minor (a new helper in the Mac app and a bridge part; no server change).
