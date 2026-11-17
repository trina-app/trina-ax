# Voice input on OpenRouter teams sends pieces while recording; whisper.cpp servers keep the whole recording

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/voice-live-text (the owner, 2026-11-17)

Plan: docs/AGENTS/plan/20261117-0143-voice-live-text.md.

- **Ask:** hosted teams use OpenRouter, so the wait is not server CPU: it is the one request sent after the whole
  recording. Send pieces while recording so the first words show within a few seconds. Stop is the end: transcribe
  what was recorded and finish, with no "Try again" and no new states.
- **Rule:** when `Me.team.voiceInputOutside` is true, the web app records 16 kHz samples (no recording file), cuts
  them at pauses with the meeting notes' cutter (`shared/src/speech-pieces.ts`, Yogurt rules; the first piece by 5 s,
  the rest by 15 s) and sends each to `POST /api/transcribe/piece` as it closes, at most two at once. Words go to the
  end of the box in recording order (`MeetingSession.onOrdered`). Stop sends the last piece and waits for the rest;
  Esc puts the box back as it was before the recording; a final refusal ends the recording with its sentence and keeps
  the words already in. The server path is the meeting piece runner with `use: 'voice'`: the chat checks of
  `POST /api/transcribe`, the free-hours meter by the piece's seconds, two pieces at once and 40 pieces / 120 s of
  sound a minute per person (429 `too_fast`, sent again after Retry-After), the piece on disk and deleted after.
- **Why:** reuses the meeting pieces (#1149, #1155) instead of a second chunker and endpoint; one request per pause
  costs the same seconds on the meter as one request per recording.
- **Left out:** office Macs and servers that run whisper.cpp keep the whole-file job (one whisper at a time, the
  first-use model download with its progress). The server's piece path already runs whisper, so live text there is a
  client switch after small q8_0 and Silero VAD are checked on x86 (STT plan step 1). No language hint per recording.
- **Tests:** `tests/unit/c-voice-piece.test.ts`, `tests/unit/speech-pieces.test.ts`, `web/test/unit/liveDictation.test.ts`,
  `web/test/unit/voice.test.ts` (live), `web/test/e2e/voice.spec.ts` (live in a chat, Esc, a room).
- **Version impact:** minor.
