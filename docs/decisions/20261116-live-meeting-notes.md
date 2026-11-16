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
  20 s, else 503 `busy` and the app sends it again), never `dictationTurn`, without the temperature fallback (as video
  pieces). Meetings measure their own speed in memory: whisper's time (not the wait for the turn) summed over the sound
  summed, for the pieces of the last 10 minutes, from 3 pieces on; the first piece after a quiet spell (the model
  loading) is not counted. Above 0.45 s per second `GET /api/meetings/status` says `too_slow` and pieces are refused;
  the measure forgets old pieces, so a busy spell does not turn meetings off for good. A missing model makes the status
  start the first-use download and report its progress (`getting_ready`); after a failed download it waits 5
  minutes before another try (`getting_ready`, `failed`).
- **What the app does with a refusal:** it sends a piece again after `Retry-After` only for the reasons in
  `MEETING_RETRY_REASONS` (`in_flight` 429, `busy` / `not_ready` 503), never by status code: free hours used up and
  OpenRouter's own limits are 429 / 503 too and are final. Anything else (409 `off` / `no_key` / `too_slow`, 403
  `confidential`, …) ends the meeting with its sentence. While a failed first-use download waits, the status says
  `getting_ready` with `failed`, not `off`.
- **No changing words.** Each re-reading of an open piece would be another paid request; lines land at each pause.
- **Language:** none by default (whisper guesses per piece); a fixed one turns English lines into Korean in mixed
  meetings.
- **Limits:** members only (the guest allow-list), two pieces under way per person (429), one piece at most 15.5 s,
  with the app's exact WAV header (RIFF size, byte rate, block align checked: the OpenRouter path forwards it as it is).
- **Capture on a Mac (slice 2):** a Swift helper (`desktop/native/meeting-audio`, universal, macOS 14.2+, built by the
  `dist:mac*` scripts with `swiftc`, no Xcode project) next to the app's program in `Contents/MacOS`, signed with the
  app. It taps only the sound of running call apps (Zoom, Teams, Webex, Slack, FaceTime, Discord, Skype and the browsers
  a Meet or Teams tab plays in) with a Core Audio process tap, reads the microphone with AVAudioEngine, and writes 16 kHz
  mono frames to stdout; nothing to disk. Electron's own loopback was not used: Chromium's display capture brings the
  Screen Recording question. The main process starts it per meeting and stops only its own PID. Info.plist gets
  `NSAudioCaptureUsageDescription` in six languages, and the microphone text names meeting notes. The Mac App Store
  build ships no helper (`extraFiles: []`).
- **Sending pieces (slice 2):** at most two at once, in order; a refusal is sent again only for the reasons in
  `MEETING_RETRY_REASONS` (a network failure counts as `busy`); any other refusal stops the meeting once with the
  server's sentence; at most 40 pieces wait (the oldest is dropped beyond).
- **The bridge (slice 3):** `DesktopBridge.meeting` (`MEETING_BRIDGE_VERSION` 1) only where the helper exists (a Mac,
  macOS 14.4+, not the store build). `start()` makes the main process show its own dialog every time, Cancel the
  default; nothing listens without that click. The meeting belongs to the main process (a reload keeps it); another team
  is not opened while it runs. While listening, a menu bar item drawn by the app ("● 12:03", with Stop) shows it: a page
  cannot hide it. "Can't hear the call": a call app runs and the microphone hears speech for 20 s while the call's
  sound stays silent.
- **The page (slice 4):** one button on My files and one card on every page while a meeting runs: the red dot and
  time, Stop, the consent line with "Copy a message for the call's chat", and the words as they come. The note is
  Markdown in My files › Meetings (`MEETINGS_DIR`), written every 2 minutes and at Stop (the same file, replaced).
  Left out on purpose: a meetings list, a summary, speaker names, a language picker, a floating window, settings.
- **Tests:** `tests/unit/c-meeting-piece.test.ts`, `tests/unit/e-desktop-meeting-chunker.test.ts`, `tests/unit/e-desktop-meeting-session.test.ts`,
  `tests/unit/mac-permission-languages.test.ts`, `tests/unit/e-desktop-meeting-control.test.ts`,
  `web/test/unit/meetingNotes.test.ts`.
- **Version impact:** minor (two new calls; the desktop side follows in the same plan).
