# Voice input cuts its later pieces at 7 s and a 0.6 s pause, and drops one-letter loops

- Date: 2026-11-19
- Status: accepted
- Supersedes: the later-piece numbers of [20261117-voice-live-text.md](20261117-voice-live-text.md) for voice input
  (they were the cutter's 15 s and 1 s pause); the cutter's own defaults stay
- Branch: fix/voice-input-latency (the owner, 2026-11-19, the chat microphone on the Mac desktop app: "오래 동안 말을
  안해야만 이전게 적혀", "뒤에 소음이 있어도 괜찮나?")

Plan: [docs/AGENTS/plan/20261119-0215-voice-input-latency.md](../AGENTS/plan/20261119-0215-voice-input-latency.md).

- **Ask:** the words should show while the person talks, or a second or two after a short pause, quiet or with
  ordinary background noise, without losing much accuracy.
- **Measured (before):** the real cutter and session with voice input's options, fed in real time to a local server
  (`POST /api/transcribe/piece`, whisper.cpp small), 150 s of talk-like speech per run (LibriSpeech en, Zeroth ko,
  sentences joined with meeting-like pauses), speech at -26 dBFS, real noise (DEMAND café, ESC-50 vacuum as a fan,
  FMA instrumental music). A word waited 4.5-6.1 s on average for its piece to close (at a 1 s pause, or at 15 s), the
  server's part was 1.0-1.6 s, the queue 0: a word showed 5.7-7.2 s after it was said (p90 8.9-11.3 s, max 12.1 s).
  The first words already came in about 3.2-3.5 s (the short first piece, 20261117 voice-first-words). Under noise the
  pause is often not found (the loudness floor is capped at 0.02): at 5 dB 57% of pieces ran to the cap.
- **Rule:** voice input (`web/src/lib/liveDictation.ts`) asks the cutter for later pieces of at most 7 s
  (`LATER_PIECE_MS`), cut at the quietest 100 ms of their last 1.5 s (`LATER_SEARCH_MS`), and closed by a 0.6 s pause
  (`PAUSE_MS`), through new `ChunkerOptions` `maxMs`, `searchMs`, `pauseMs` in `shared/src/speech-pieces.ts`. A first
  piece without `firstMaxMs` follows `maxMs`. The no-speech filter (`server/src/jobs/no-speech.ts` `letterLoop`)
  drops a line that is one letter five or more times ("ლლლლლ", a Sinhala letter 120 times), whatever the sound and
  however sure whisper was; Hangul jamo are kept ("ㅋㅋㅋㅋㅋ" is dictated).
- **Measured (after), same runs:** word → screen 3.7-4.2 s mean (was 5.7-7.2), p90 4.9-5.2 s (was 8.9-11.3), max 9.3 s.
  Offline over 2 languages × 6 noises × 3 SNRs, the cut wait alone: 3.2-3.5 s mean, p90 5.7-6.1 s (was 6.0-7.3 and
  11.4-13.1). Errors over 10 mixes (en WER / ko CER, whisper small, the server's own local path): 19.6% average (was
  18.6%): quiet en 13.8 (16.0), ko 12.4 (11.3); café 10 dB en 18.6 (17.3), ko 15.4 (14.6); fan 5 dB en 19.6 (20.5),
  ko 33.7 (24.6); music 10 dB en 21.5 (18.9); keyboard 10 dB ko 16.1 (17.9); office 20 dB en 14.1 (14.4); café 5 dB ko
  30.4 (30.6). Noise alone (5 noises × 2 levels, 60 s each): 4 pieces wrote text before (one-letter loops), none after.
- **Tried and dropped:** 6 s pieces (cut wait 2.8-3.1 s, but 21.7% errors); 8 s with a 0.7 s pause (3.6-4.1 s, 21.1%);
  raising the floor's cap to 0.06 (37-70% of speech lost at 5-10 dB: speech no longer counts as clear).
- **Why:** the wait was the cut, not the server. Shorter pieces cost the same on OpenRouter (billed by the second) and
  stay well inside the server's limits (two at once, 40 pieces and 120 s of sound a minute, at most 15.5 s a piece):
  about 10 a minute of talk.
- **Left out:** on-device transcription (the plan: the Mac's SpeechTranscriber first, ~1 s live words, then iPhone and
  Android, each more than 2 days); live words for teams whose own server runs whisper.cpp (they still get the whole
  recording after Stop); the cutter's defaults.
- **Tests:** `tests/unit/speech-pieces.test.ts`, `web/test/unit/liveDictation.test.ts`, `tests/unit/no-speech.test.ts`.
- **Version impact:** patch.
