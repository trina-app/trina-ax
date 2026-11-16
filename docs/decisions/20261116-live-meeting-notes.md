# Meeting notes: the desktop app captures, the team server turns pieces of sound into text

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/live-meeting-notes (the owner, 2026-11-16: live meeting transcription after Yogurt's idea; the hosted
  OpenRouter path live too)

Plan: [docs/AGENTS/plan/20261116-1903-live-meeting-notes.md](../AGENTS/plan/20261116-1903-live-meeting-notes.md).

- **Ask:** while someone is in a Zoom, Meet or Teams call, or an in-person meeting, the Trina desktop app writes down
  what is said as people talk, in the person's own folder, without a bot in the call.
- **Rule: where the sound turns into text.** The desktop app captures the microphone and the call's sound and cuts
  each track at pauses (at most 15 s a piece). Each piece goes to the team server (`POST /api/meetings/piece`), which
  uses the team's voice input setting: OpenRouter (the hosting key or the team's own) or whisper.cpp on the server (an
  Office Mac with #1090's whisper-cli). Not on each computer for now (no 264–488 MB download per person, one desktop
  change for every kind of team); that stays possible behind the same piece interface.
- **Nothing is kept.** The piece is a 16 kHz mono 16-bit WAV with the app's fixed 44-byte header, checked, used and
  deleted. The text is the person's note file; the sound is never saved.
- **OpenRouter:** the WAV as it is (no ffmpeg per piece), through `sendToOpenRouter` (zero data retention requested,
  the second try, the hosting key's free-hours meter: meetings share the plan's free hours of transcription with voice
  input and video reads). Safe operations 1A (sound never leaves the server) refuses it (403 `confidential`).
- **On the server:** whisper.cpp in a video piece's kind of turn (`pieceTurn`: voice input first, a piece waits at most
  20 s, else 503 and the app sends it again), never `dictationTurn`. Meetings measure their own speed in memory (wall
  time per second of sound, model loading included, after 3 pieces); above 0.45 s per second `GET /api/meetings/status`
  says `too_slow` and new pieces are refused. A missing model makes the status start the first-use download and report
  its progress (`getting_ready`).
- **No changing words.** Each re-reading of an open piece would be another paid request; lines land at each pause.
- **Language:** none by default (whisper guesses per piece); a fixed one turns English lines into Korean in mixed
  meetings.
- **Limits:** members only (the guest allow-list), two pieces under way per person (429), one piece at most 15.5 s.
- **Tests:** `tests/unit/c-meeting-piece.test.ts`, `tests/unit/e-desktop-meeting-chunker.test.ts`.
- **Version impact:** minor (two new calls; the desktop side follows in the same plan).
